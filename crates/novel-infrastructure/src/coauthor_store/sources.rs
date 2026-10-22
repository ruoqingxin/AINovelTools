use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSource {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub revision: String,
    pub content: String,
    pub session_id: Option<Uuid>,
    pub offset: usize,
    pub total_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSearchPage {
    pub hits: Vec<CoauthorSource>,
    pub has_more: bool,
    pub pending_index_updates: usize,
    pub coverage: String,
}

/// Tokenize Chinese bigrams before FTS indexing; two-character names remain
/// indexed without scanning every source for LIKE matches.
pub(crate) fn coauthor_terms(text: &str) -> BTreeSet<String> {
    let mut terms = BTreeSet::new();
    for word in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
    {
        let lower = word.to_lowercase();
        if lower.is_ascii() {
            if lower.len() > 1 {
                terms.insert(lower);
            }
        } else {
            let chars: Vec<_> = lower.chars().collect();
            for pair in chars.windows(2) {
                let term = pair.iter().collect::<String>();
                if ![
                    "一个", "这个", "那个", "可以", "怎么", "什么", "我们", "讨论", "一下", "继续",
                    "设定",
                ]
                .contains(&term.as_str())
                {
                    terms.insert(term);
                }
            }
        }
    }
    terms
}

impl ProjectManager {
    pub fn search_coauthor_sources(
        &mut self,
        scope: &CoauthorScope,
        query: &str,
        history: bool,
        offset: u32,
    ) -> Result<CoauthorSearchPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if query.chars().count() > 2_000 {
            return Err(CoauthorError::Invalid("检索词过长，请分主题查询。".into()));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        db.sync_coauthor_sources()?;
        let terms = coauthor_terms(query);
        if terms.is_empty() {
            return Ok(CoauthorSearchPage {
                hits: vec![],
                has_more: false,
                pending_index_updates: db.coauthor_pending_updates()?,
                coverage: "未形成有效查询，不能据此判断项目中不存在相关内容。".into(),
            });
        }
        let mut expanded = terms;
        for group in [
            ["境界", "修炼", "等级", "突破", "修行"],
            ["寿元", "寿命", "代价", "消耗", "限制"],
        ] {
            if group.iter().any(|term| query.contains(term)) {
                expanded.extend(group.into_iter().map(str::to_owned));
            }
        }
        let expression = expanded
            .iter()
            .take(96)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut stmt = db.connection.prepare(
            "SELECT s.source_key FROM coauthor_fts f JOIN coauthor_sources s ON s.source_key=f.source_key
             WHERE coauthor_fts MATCH ?1
             AND ((?2=1 AND s.kind='MESSAGE' AND s.session_id=?3) OR (?2=0 AND s.kind<>'MESSAGE'))
             ORDER BY rank, s.source_key LIMIT 13 OFFSET ?4",
        )?;
        let keys = stmt
            .query_map(
                rusqlite::params![expression, history, scope.session_id.to_string(), offset],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = keys.len() > 12;
        let relevance = novel_application::DiscussionRelevance::new(query);
        let mut hits = Vec::new();
        for key in keys.into_iter().take(12) {
            if let Some(mut source) = db.coauthor_source(&key)? {
                source.content = relevance.excerpt(&source.content, 600);
                hits.push(source);
            }
        }
        Ok(CoauthorSearchPage {
            hits,
            has_more,
            pending_index_updates: db.coauthor_pending_updates()?,
            coverage:
                "相关性检索页，不代表检查过全书；可改写查询或分页继续。摘要与历史建议不是正式事实。"
                    .into(),
        })
    }

    pub fn read_coauthor_source(
        &self,
        scope: &CoauthorScope,
        key: &str,
        revision: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CoauthorSource, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let mut source = db.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
        if source.revision != revision {
            return Err(CoauthorError::Conflict);
        }
        if source.session_id.is_some_and(|id| id != scope.session_id) {
            return Err(CoauthorError::NotFound);
        }
        if offset > source.total_chars {
            return Err(CoauthorError::Invalid("来源读取位置超出原文。".into()));
        }
        source.content = source
            .content
            .chars()
            .skip(offset)
            .take(limit.clamp(1, 12_000))
            .collect();
        source.offset = offset;
        Ok(source)
    }
}

impl Database {
    fn coauthor_pending_updates(&self) -> Result<usize, CoauthorError> {
        let count =
            self.connection
                .query_row("SELECT COUNT(*) FROM coauthor_source_queue", [], |row| {
                    row.get::<_, i64>(0)
                })?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    fn sync_coauthor_sources(&self) -> Result<(), CoauthorError> {
        let mut stmt = self.connection.prepare(
            "SELECT kind,source_id FROM coauthor_source_queue ORDER BY rowid LIMIT 1000",
        )?;
        let dirty = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let tx = self.connection.unchecked_transaction()?;
        for (kind, id) in dirty {
            let key = format!("{kind}:{id}");
            let source = self.coauthor_source(&key)?;
            tx.execute("DELETE FROM coauthor_fts WHERE source_key=?1", [&key])?;
            tx.execute("DELETE FROM coauthor_sources WHERE source_key=?1", [&key])?;
            if let Some(source) = source {
                let terms = coauthor_terms(&format!("{}\n{}", source.title, source.content))
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(" ");
                tx.execute(
                    "INSERT INTO coauthor_sources VALUES (?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![
                        key,
                        source.kind,
                        source.title,
                        source.revision,
                        source.content,
                        source.session_id.map(|id| id.to_string())
                    ],
                )?;
                tx.execute(
                    "INSERT INTO coauthor_fts(source_key,terms) VALUES (?1,?2)",
                    rusqlite::params![key, terms],
                )?;
            }
            tx.execute(
                "DELETE FROM coauthor_source_queue WHERE kind=?1 AND source_id=?2",
                rusqlite::params![kind, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn coauthor_source(
        &self,
        key: &str,
    ) -> Result<Option<CoauthorSource>, CoauthorError> {
        let (kind, id) = key
            .split_once(':')
            .ok_or_else(|| CoauthorError::Invalid("来源身份无效。".into()))?;
        let record: Option<(String,String,Option<String>,String)> = match kind {
            "ENTITY" => self.connection.query_row(
                "SELECT r.name, r.description || char(10) || '别名：' || r.aliases_json ||
                 char(10) || '结构属性：' || r.fixed_attributes_json || char(10) ||
                 COALESCE((SELECT group_concat(a.content || ' [' || a.visibility || ']', char(10))
                   FROM author_settings a WHERE a.entity_id=e.id AND a.entity_revision_id=e.current_revision_id),''),
                 NULL, e.current_revision_id || ':' || e.version FROM entities e JOIN entity_revisions r ON r.id=e.current_revision_id
                 WHERE e.id=?1 AND e.lifecycle_status='ACTIVE'",
                [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?,
            "PLAN" => self.connection.query_row(
                "SELECT COALESCE(n.title,p.id),
                 '规划状态：' || p.story_state || char(10) || '当前记录：' || p.content ||
                 char(10) || '尚未确认的候选：' || p.pending_content ||
                 char(10) || '备注：' || p.rationale || char(10) || p.consequence, NULL,
                 CAST(p.version AS TEXT) || ':' || COALESCE(CAST(n.revision AS TEXT),'none')
                 FROM planning_sections p LEFT JOIN plan_nodes n ON p.id='plan-node:' || n.id
                 WHERE p.id=?1 AND p.story_state<>'RETIRED' AND (n.id IS NULL OR n.archived=0)",
                [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?,
            "MANUSCRIPT" => {
                let record: Option<(String,String,String)> = self.connection.query_row(
                    "SELECT n.title,m.document_json,m.id FROM plan_nodes n JOIN manuscript_revisions m ON m.chapter_id=n.id
                     WHERE n.id=?1 AND n.archived=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
                    [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                ).optional()?;
                record.map(|(title,json,revision)| novel_application::document_text(&json)
                    .map(|text|(title,text,None,revision)).map_err(|_|CoauthorError::Invalid("正文结构无法读取。".into()))).transpose()?
            },
            "CARD" => self.connection.query_row(
                "SELECT title,'参考写作资料（不自动成为本书事实）：' || content,NULL,updated_at FROM writing_cards WHERE id=?1 AND enabled=1",
                [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?,
            "SUMMARY" => self.connection.query_row(
                "SELECT '参考摘要','导航摘要，不能替代正文证据：' || content,NULL,updated_at
                 FROM summary_materials s WHERE id=?1 AND lifecycle_status='ACTIVE'
                 AND (source_version IS NULL OR source_version NOT LIKE 'manuscript:%' OR EXISTS(
                   SELECT 1 FROM manuscript_revisions m WHERE m.id=substr(s.source_version,12)
                   AND m.id=(SELECT latest.id FROM manuscript_revisions latest
                       WHERE latest.chapter_id=m.chapter_id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)))",
                [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?,
            "MESSAGE" => self.connection.query_row(
                "SELECT s.title,'历史发言 [' || m.role || ']（不等于有效决定或正式事实）：' || m.content,m.session_id,m.id
                 FROM discussion_messages m JOIN discussion_sessions s ON s.id=m.session_id WHERE m.id=?1",
                [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?,
            _ => return Err(CoauthorError::Invalid("不支持的来源类型。".into())),
        };
        Ok(record.map(|(title, content, session, native_revision)| {
            let revision = format!(
                "{native_revision}:{:x}",
                Sha256::digest(format!("{key}\n{title}\n{content}"))
            );
            let total_chars = content.chars().count();
            CoauthorSource {
                key: key.into(),
                kind: kind.into(),
                title,
                revision,
                content,
                session_id: session.and_then(|id| id.parse().ok()),
                offset: 0,
                total_chars,
            }
        }))
    }
}
