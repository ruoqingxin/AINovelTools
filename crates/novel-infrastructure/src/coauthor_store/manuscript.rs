use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorManuscriptEdit {
    pub block_id: String,
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorTextRun {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub marks: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorManuscriptBlock {
    pub block_id: String,
    pub offset: usize,
    pub total_chars: usize,
    pub text: String,
    pub runs: Vec<CoauthorTextRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorManuscriptPage {
    pub key: String,
    pub revision: String,
    pub blocks: Vec<CoauthorManuscriptBlock>,
    pub next_offset: Option<usize>,
}

fn invalid_anchor() -> CoauthorError {
    CoauthorError::Invalid(
        "正文修改无法唯一定位，或跨越格式边界；请重新读取并拆分为同一文字片段内的修改。".into(),
    )
}

fn manuscript_error(error: ManuscriptError) -> CoauthorError {
    match error {
        ManuscriptError::Database(error) => CoauthorError::Database(error),
        ManuscriptError::Conflict { .. } | ManuscriptError::DraftConflict { .. } => {
            CoauthorError::Conflict
        }
        ManuscriptError::MissingChapter(_) => CoauthorError::NotFound,
        _ => CoauthorError::Invalid("正文结构无法处理，正式内容未改动。".into()),
    }
}

fn text_blocks<'a>(node: &'a Value, blocks: &mut Vec<&'a Value>) {
    if matches!(
        node["type"].as_str(),
        Some("paragraph" | "heading" | "codeBlock")
    ) {
        blocks.push(node);
    } else if let Some(children) = node["content"].as_array() {
        for child in children {
            text_blocks(child, blocks);
        }
    }
}

fn runs(block: &Value) -> Result<Vec<CoauthorTextRun>, CoauthorError> {
    let mut offset = 0;
    let mut result = Vec::new();
    if let Some(children) = block["content"].as_array() {
        for child in children {
            let text = match child["type"].as_str() {
                Some("text") => child["text"].as_str().ok_or_else(invalid_anchor)?,
                Some("hardBreak") => "\n",
                _ => return Err(invalid_anchor()),
            };
            let end = offset + text.chars().count();
            if child["type"] == "text" {
                result.push(CoauthorTextRun {
                    start: offset,
                    end,
                    text: text.into(),
                    marks: child["marks"].as_array().cloned().unwrap_or_default(),
                });
            }
            offset = end;
        }
    }
    Ok(result)
}

fn block_text(block: &Value) -> String {
    block["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|node| {
            if node["type"] == "hardBreak" {
                "\n"
            } else {
                node["text"].as_str().unwrap_or("")
            }
        })
        .collect()
}

// Offsets always address Unicode scalar values in the immutable original, never UTF-16.
fn apply_edits(json: &str, edits: &[CoauthorManuscriptEdit]) -> Result<String, CoauthorError> {
    if edits.is_empty() || edits.len() > 80 {
        return Err(CoauthorError::Invalid(
            "每项正文局部修改须包含 1 至 80 处准确修改。".into(),
        ));
    }
    let mut doc: Value = decode(json.into())?;
    let mut blocks = Vec::new();
    text_blocks(&doc, &mut blocks);
    let mut ordered = edits.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|edit| (&edit.block_id, edit.start));
    for pair in ordered.windows(2) {
        if pair[0].block_id == pair[1].block_id && pair[0].end > pair[1].start {
            return Err(CoauthorError::Invalid(
                "正文修改范围重叠，请基于同一原文重新准备。".into(),
            ));
        }
    }
    for edit in &ordered {
        let matches = blocks
            .iter()
            .filter(|block| block["attrs"]["blockId"].as_str() == Some(&edit.block_id))
            .collect::<Vec<_>>();
        if matches.len() != 1
            || edit.start >= edit.end
            || edit.before == edit.after
            || edit.after.contains(['\n', '\r'])
            || edit.after.chars().count() > 12_000
        {
            return Err(invalid_anchor());
        }
        let span = runs(matches[0])?
            .into_iter()
            .find(|run| run.start <= edit.start && run.end >= edit.end)
            .ok_or_else(invalid_anchor)?;
        let before = span
            .text
            .chars()
            .skip(edit.start - span.start)
            .take(edit.end - edit.start)
            .collect::<String>();
        if before != edit.before {
            return Err(invalid_anchor());
        }
    }
    drop(blocks);
    fn edit_block(node: &mut Value, edit: &CoauthorManuscriptEdit) -> Result<(), CoauthorError> {
        if node["attrs"]["blockId"].as_str() == Some(&edit.block_id)
            && matches!(
                node["type"].as_str(),
                Some("paragraph" | "heading" | "codeBlock")
            )
        {
            let children = node
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .ok_or_else(invalid_anchor)?;
            let mut offset = 0;
            for index in 0..children.len() {
                let text = if children[index]["type"] == "hardBreak" {
                    "\n"
                } else {
                    children[index]["text"].as_str().unwrap_or("")
                };
                let end = offset + text.chars().count();
                if children[index]["type"] == "text" && offset <= edit.start && end >= edit.end {
                    let text = format!(
                        "{}{}{}",
                        text.chars().take(edit.start - offset).collect::<String>(),
                        edit.after,
                        text.chars().skip(edit.end - offset).collect::<String>()
                    );
                    if text.is_empty() {
                        children.remove(index);
                    } else {
                        children[index]["text"] = Value::String(text);
                    }
                    return Ok(());
                }
                offset = end;
            }
            return Err(invalid_anchor());
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for child in children {
                edit_block(child, edit)?;
            }
        }
        Ok(())
    }
    // Descending edits keep all ranges relative to the original revision.
    for edit in ordered.into_iter().rev() {
        edit_block(&mut doc, edit)?;
    }
    encode(&doc)
}

impl ProjectManager {
    pub fn read_coauthor_manuscript(
        &self,
        scope: &CoauthorScope,
        key: &str,
        revision: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CoauthorManuscriptPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let (source, manuscript) = db.coauthor_manuscript(key, revision)?;
        let doc: Value = decode(manuscript.document_json)?;
        let mut nodes = Vec::new();
        text_blocks(&doc, &mut nodes);
        let mut position = 0;
        let mut end = offset.saturating_add(limit.clamp(1, 12_000));
        let mut blocks = Vec::new();
        for node in nodes {
            let text = block_text(node);
            let size = text.chars().count();
            if position < end && position + size > offset {
                if blocks.len() == 24 {
                    end = position;
                    position += size + 1;
                    continue;
                }
                let start = offset.saturating_sub(position);
                let mut stop = size.min(end - position);
                let mut clipped = runs(node)?
                    .into_iter()
                    .filter_map(|run| {
                        let a = run.start.max(start);
                        let b = run.end.min(stop);
                        (a < b).then(|| CoauthorTextRun {
                            start: a,
                            end: b,
                            text: run.text.chars().skip(a - run.start).take(b - a).collect(),
                            marks: run.marks,
                        })
                    })
                    .take(65)
                    .collect::<Vec<_>>();
                if clipped.len() > 64 {
                    clipped.pop();
                    stop = clipped.last().ok_or_else(invalid_anchor)?.end;
                    end = position + stop;
                }
                blocks.push(CoauthorManuscriptBlock {
                    block_id: node["attrs"]["blockId"]
                        .as_str()
                        .ok_or_else(invalid_anchor)?
                        .into(),
                    offset: start,
                    total_chars: size,
                    text: text.chars().skip(start).take(stop - start).collect(),
                    runs: clipped,
                });
            }
            position += size + 1;
        }
        if offset > position {
            return Err(invalid_anchor());
        }
        Ok(CoauthorManuscriptPage {
            key: source.key,
            revision: source.revision,
            blocks,
            next_offset: (end < position).then_some(end),
        })
    }
}

impl Database {
    fn coauthor_manuscript(
        &self,
        key: &str,
        revision: &str,
    ) -> Result<(CoauthorSource, ManuscriptRevision), CoauthorError> {
        let source = self.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
        if source.kind != "MANUSCRIPT" || source.revision != revision {
            return Err(CoauthorError::Conflict);
        }
        let id = key
            .strip_prefix("MANUSCRIPT:")
            .and_then(|id| id.parse().ok())
            .ok_or(CoauthorError::NotFound)?;
        let manuscript = self
            .current_manuscript(id)?
            .ok_or(CoauthorError::NotFound)?;
        if !source.revision.starts_with(&format!("{}:", manuscript.id)) {
            return Err(CoauthorError::Conflict);
        }
        if format!("{:x}", Sha256::digest(manuscript.document_json.as_bytes()))
            != manuscript.content_hash
        {
            return Err(invalid_anchor());
        }
        Ok((source, manuscript))
    }

    pub(super) fn prepare_manuscript_item(
        &self,
        item: &mut CoauthorChangeItem,
    ) -> Result<(), CoauthorError> {
        let key = item
            .document
            .target_key
            .as_deref()
            .ok_or_else(invalid_anchor)?;
        let revision = item
            .document
            .target_revision
            .as_deref()
            .ok_or_else(invalid_anchor)?;
        if item.document.kind != CoauthorDocumentKind::Manuscript {
            return Err(invalid_anchor());
        }
        let (source, manuscript) = self.coauthor_manuscript(key, revision)?;
        if item.document.title != source.title {
            return Err(CoauthorError::Invalid(
                "正文局部修改不同时更改章节标题。".into(),
            ));
        }
        let draft = self
            .current_manuscript_draft(manuscript.chapter_id)
            .map_err(manuscript_error)?;
        if draft.document_json.is_some() {
            return Err(CoauthorError::Invalid(
                "正文编辑器有未提交稿件，请先处理该稿件再准备或采用局部修改。".into(),
            ));
        }
        let after = apply_edits(&manuscript.document_json, &item.manuscript_edits)?;
        item.document.content =
            novel_application::document_text(&after).map_err(|_| invalid_anchor())?;
        item.before = Some(source);
        item.manuscript_draft_version = Some(draft.version);
        item.manuscript_before_json = Some(manuscript.document_json);
        item.manuscript_after_json = Some(after);
        Ok(())
    }

    pub(super) fn validate_manuscript_item(
        &self,
        item: &CoauthorChangeItem,
    ) -> Result<String, CoauthorError> {
        let mut actual = item.clone();
        self.prepare_manuscript_item(&mut actual)?;
        if actual.manuscript_draft_version != item.manuscript_draft_version
            || actual.document.content != item.document.content
            || actual.manuscript_before_json != item.manuscript_before_json
            || actual.manuscript_after_json != item.manuscript_after_json
        {
            return Err(CoauthorError::Conflict);
        }
        let (_, manuscript) = self.coauthor_manuscript(
            item.document
                .target_key
                .as_deref()
                .ok_or_else(invalid_anchor)?,
            item.document
                .target_revision
                .as_deref()
                .ok_or_else(invalid_anchor)?,
        )?;
        apply_edits(&manuscript.document_json, &item.manuscript_edits)
    }

    pub(super) fn publish_manuscript_item(
        &self,
        tx: &rusqlite::Transaction<'_>,
        scope: &CoauthorScope,
        item: &CoauthorChangeItem,
        reason: &str,
    ) -> Result<String, CoauthorError> {
        let after = self.validate_manuscript_item(item)?;
        let key = item
            .document
            .target_key
            .as_deref()
            .ok_or_else(invalid_anchor)?;
        let (_, manuscript) = self.coauthor_manuscript(
            key,
            item.document
                .target_revision
                .as_deref()
                .ok_or_else(invalid_anchor)?,
        )?;
        let revision = crate::chapter_draft_store::insert_revision(
            tx,
            manuscript.chapter_id,
            Some(manuscript.id),
            &after,
            reason.into(),
        )
        .map_err(manuscript_error)?;
        tx.execute(
            "INSERT INTO search_index VALUES ('MANUSCRIPT',?1,?2,?3,?4)",
            rusqlite::params![
                revision.id.to_string(),
                scope.project_id.to_string(),
                format!("manuscript:{}", revision.id),
                revision.document_json
            ],
        )?;
        tx.execute("UPDATE summary_materials SET lifecycle_status='STALE', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE lifecycle_status='ACTIVE' AND (source_id=?1 OR generation_mode='EXTRACTIVE_AUTO_PROJECT')",
            [manuscript.chapter_id.to_string()])?;
        Ok(key.into())
    }
}

#[cfg(test)]
mod tests;
