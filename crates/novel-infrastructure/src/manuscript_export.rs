use super::*;
use std::collections::{HashMap, HashSet};
use std::io::Write;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManuscriptExportFormat {
    Txt,
    Markdown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum ManuscriptExportScope {
    Book {},
    Chapter {
        #[serde(rename = "chapterId")]
        chapter_id: Uuid,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManuscriptExportInput {
    pub expected_project_id: Uuid,
    pub scope: ManuscriptExportScope,
    pub format: ManuscriptExportFormat,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptExportChapter {
    pub chapter_id: Uuid,
    pub revision_id: Uuid,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptExportSkippedChapter {
    pub chapter_id: Uuid,
    pub title: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptExportReceipt {
    pub project_id: Uuid,
    pub scope: ManuscriptExportScope,
    pub format: ManuscriptExportFormat,
    pub path: PathBuf,
    pub chapters: Vec<ManuscriptExportChapter>,
    pub skipped_chapters: Vec<ManuscriptExportSkippedChapter>,
    pub draft_chapter_count: usize,
}

#[derive(Debug, Error)]
pub enum ManuscriptExportError {
    #[error("没有打开的工程")]
    NoProject,
    #[error("当前工程已变化，请重新打开导出面板")]
    WrongProject,
    #[error("导出目标不是有效的活动章节")]
    InvalidTarget,
    #[error("章节结构存在缺失、循环或错误归属，未导出正文")]
    InvalidStructure,
    #[error("所选范围没有已保存正文，未生成导出文件")]
    NoSavedManuscript,
    #[error("章节「{0}」的正文版本、哈希或格式无效，未导出正文")]
    InvalidDocument(String),
    #[error("exports 目录必须位于当前工程内")]
    InvalidDirectory,
    #[error("正文导出读取失败：{0}")]
    Database(#[from] DatabaseError),
    #[error("正文导出写入失败：{0}")]
    Io(#[from] std::io::Error),
}

impl From<rusqlite::Error> for ManuscriptExportError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(DatabaseError::from(error))
    }
}

struct OrderedChapter<'a> {
    node: &'a PlanNode,
    volume: Option<&'a PlanNode>,
    order: Vec<(i64, Uuid)>,
}

fn ordered_chapters(
    nodes: &[PlanNode],
    scope: ManuscriptExportScope,
) -> Result<Vec<OrderedChapter<'_>>, ManuscriptExportError> {
    let by_id = nodes
        .iter()
        .map(|node| (node.id, node))
        .collect::<HashMap<_, _>>();
    let mut chapters = Vec::new();
    for node in nodes
        .iter()
        .filter(|node| node.kind == PlanNodeKind::Chapter && !node.archived)
    {
        if matches!(scope, ManuscriptExportScope::Chapter { chapter_id } if chapter_id != node.id) {
            continue;
        }
        let mut ancestor = node;
        let mut seen = HashSet::new();
        let mut order = Vec::new();
        let mut volume = None;
        let mut archived = false;
        loop {
            if !seen.insert(ancestor.id) {
                return Err(ManuscriptExportError::InvalidStructure);
            }
            archived |= ancestor.archived;
            order.push((ancestor.sort_order, ancestor.id));
            let Some(parent_id) = ancestor.parent_id else {
                break;
            };
            let parent = by_id
                .get(&parent_id)
                .ok_or(ManuscriptExportError::InvalidStructure)?;
            if !matches!(
                (ancestor.kind, parent.kind),
                (PlanNodeKind::Chapter, PlanNodeKind::Volume)
                    | (PlanNodeKind::Volume, PlanNodeKind::VolumeManager)
            ) {
                return Err(ManuscriptExportError::InvalidStructure);
            }
            if parent.kind == PlanNodeKind::Volume {
                volume = Some(*parent);
            }
            ancestor = parent;
        }
        if !archived {
            order.reverse();
            chapters.push(OrderedChapter {
                node,
                volume,
                order,
            });
        }
    }
    if matches!(scope, ManuscriptExportScope::Chapter { .. }) && chapters.is_empty() {
        return Err(ManuscriptExportError::InvalidTarget);
    }
    chapters.sort_by(|left, right| left.order.cmp(&right.order));
    Ok(chapters)
}

#[cfg(test)]
#[path = "manuscript_export_tests.rs"]
mod tests;

#[derive(Deserialize)]
struct TextNode {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    #[serde(default)]
    content: Vec<Self>,
}

// Export prose, not editor metadata or inline formatting. Reject unknown nodes
// instead of silently dropping content that a future editor adds.
fn plain_node(node: &TextNode) -> Result<String, ()> {
    match node.kind.as_str() {
        "text" if node.content.is_empty() => node.text.clone().ok_or(()),
        "hardBreak" if node.content.is_empty() && node.text.is_none() => Ok("\n".into()),
        "horizontalRule" if node.content.is_empty() && node.text.is_none() => Ok("\n---\n".into()),
        "paragraph" | "heading" | "blockquote" | "bulletList" | "orderedList" | "listItem"
        | "codeBlock"
            if node.text.is_none() =>
        {
            let mut text = node
                .content
                .iter()
                .map(plain_node)
                .collect::<Result<Vec<_>, _>>()?
                .concat();
            if matches!(node.kind.as_str(), "paragraph" | "heading" | "codeBlock") {
                text.push_str("\n\n");
            }
            Ok(text)
        }
        _ => Err(()),
    }
}

fn prose(revision: &ManuscriptRevision) -> Result<String, ()> {
    if revision.document_schema_version != 1
        || format!("{:x}", Sha256::digest(revision.document_json.as_bytes()))
            != revision.content_hash
    {
        return Err(());
    }
    let node: TextNode = serde_json::from_str(&revision.document_json).map_err(|_| ())?;
    if node.kind != "doc" || node.text.is_some() {
        return Err(());
    }
    let text = node
        .content
        .iter()
        .map(plain_node)
        .collect::<Result<Vec<_>, _>>()?
        .concat();
    Ok(text.trim_end_matches('\n').to_owned())
}

fn markdown_literal(text: &str) -> String {
    let mut result = String::new();
    for character in text.chars() {
        if "\\`*_{}[]()#+-.!|><&".contains(character) {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

fn heading(text: &str, level: usize, format: ManuscriptExportFormat) -> String {
    let title = text.replace(['\r', '\n'], " ");
    match format {
        ManuscriptExportFormat::Txt => title,
        ManuscriptExportFormat::Markdown => {
            format!("{} {}", "#".repeat(level), markdown_literal(&title))
        }
    }
}

fn publish(
    root: &Path,
    content: &str,
    format: ManuscriptExportFormat,
) -> Result<PathBuf, ManuscriptExportError> {
    let root = root.canonicalize()?;
    let exports = root.join("exports");
    std::fs::create_dir_all(&exports)?;
    if exports.canonicalize()? != exports {
        return Err(ManuscriptExportError::InvalidDirectory);
    }
    let name = format!("manuscript-{}", Uuid::new_v4());
    let staging = exports.join(format!(".{name}.partial"));
    let destination = exports.join(name);
    std::fs::create_dir(&staging)?;
    let extension = match format {
        ManuscriptExportFormat::Txt => "txt",
        ManuscriptExportFormat::Markdown => "md",
    };
    let file_name = format!("manuscript.{extension}");
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staging.join(&file_name))?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Publish the complete directory on the same filesystem. Incomplete
        // exports stay visibly partial after a process interruption.
        if destination.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(&staging, &destination)?;
        Ok(destination.join(file_name))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result.map_err(ManuscriptExportError::from)
}

impl ProjectManager {
    pub fn export_manuscript(
        &self,
        input: ManuscriptExportInput,
    ) -> Result<ManuscriptExportReceipt, ManuscriptExportError> {
        let session = self
            .current
            .as_ref()
            .ok_or(ManuscriptExportError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(ManuscriptExportError::WrongProject);
        }
        // All reads use this connection's snapshot, including other-window saves.
        let transaction = session.database.connection.unchecked_transaction()?;
        let nodes = session.database.list_plan_nodes()?;
        let ordered = ordered_chapters(&nodes, input.scope)?;
        let mut chapters = Vec::new();
        let mut skipped_chapters = Vec::new();
        let mut draft_chapter_count = 0;
        let mut output = vec![heading(&session.manifest.name, 1, input.format)];
        let mut last_volume = None;
        for chapter in ordered {
            let has_draft: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM manuscript_drafts WHERE chapter_id=?1 AND document_json IS NOT NULL)",
                [chapter.node.id.to_string()], |row| row.get(0),
            )?;
            draft_chapter_count += usize::from(has_draft);
            let Some(revision) = session.database.current_manuscript(chapter.node.id)? else {
                skipped_chapters.push(ManuscriptExportSkippedChapter {
                    chapter_id: chapter.node.id,
                    title: chapter.node.title.clone(),
                });
                continue;
            };
            let text = prose(&revision)
                .map_err(|()| ManuscriptExportError::InvalidDocument(chapter.node.title.clone()))?;
            if let Some(volume) = chapter.volume {
                if last_volume != Some(volume.id) {
                    output.push(heading(&volume.title, 2, input.format));
                }
            }
            last_volume = chapter.volume.map(|volume| volume.id);
            output.push(heading(&chapter.node.title, 3, input.format));
            output.push(match input.format {
                ManuscriptExportFormat::Txt => text,
                ManuscriptExportFormat::Markdown => markdown_literal(&text)
                    .lines()
                    .map(|line| {
                        if line.is_empty() {
                            String::new()
                        } else {
                            format!("{line}  ")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            });
            chapters.push(ManuscriptExportChapter {
                chapter_id: chapter.node.id,
                revision_id: revision.id,
                title: chapter.node.title.clone(),
            });
        }
        transaction.commit()?;
        if chapters.is_empty() {
            return Err(ManuscriptExportError::NoSavedManuscript);
        }
        let path = publish(&session.root, &(output.join("\n\n") + "\n"), input.format)?;
        Ok(ManuscriptExportReceipt {
            project_id: session.manifest.project_id,
            scope: input.scope,
            format: input.format,
            path,
            chapters,
            skipped_chapters,
            draft_chapter_count,
        })
    }
}
