use super::*;

mod invalidation;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorKnowledgeAnchor {
    pub id: Uuid,
    pub chapter_id: Option<Uuid>,
    pub revision_id: Option<Uuid>,
    pub block_id: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorKnowledgeLink {
    pub key: String,
    pub revision: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorKnowledgeContext {
    pub project_id: Uuid,
    pub version: i64,
    pub status: String,
    pub anchors: Vec<CoauthorKnowledgeAnchor>,
    pub has_more_anchors: bool,
    #[serde(default)]
    pub total_anchors: usize,
    pub facts: Vec<CoauthorKnowledgeLink>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorKnowledgeAnchorsPage {
    pub knowledge_key: String,
    pub knowledge_revision: String,
    pub anchors: Vec<CoauthorKnowledgeAnchor>,
    pub offset: usize,
    pub total_anchors: usize,
    pub next_offset: usize,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorKnowledgeEvidence {
    pub knowledge_key: String,
    pub knowledge_revision: String,
    pub anchor_id: Uuid,
    pub chapter_id: Uuid,
    pub revision_id: Uuid,
    pub block_id: String,
    pub start: u32,
    pub end: u32,
    pub content: String,
    pub offset: usize,
    pub total_chars: usize,
    pub next_offset: usize,
    pub is_current_revision: bool,
}

const KNOWLEDGE_WARNING: &str = "事实与关系记录，不是正文原句；故事时间、角色知情和叙事真假仍须核对。证据元数据未替代原文范围校验。";

impl Database {
    pub(crate) fn migrate_coauthor_knowledge_anchor_pages(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "INSERT OR IGNORE INTO coauthor_source_queue SELECT 'FACT',knowledge_id FROM fact_current_versions;
             INSERT OR IGNORE INTO coauthor_source_queue SELECT 'RELATION',id FROM relations;
             INSERT INTO schema_migrations(version,name) VALUES(61,'coauthor_knowledge_anchor_pages');",
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn migrate_coauthor_knowledge(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS coauthor_relations_from ON relations(from_knowledge_id,id,relation_version);
             CREATE INDEX IF NOT EXISTS coauthor_relations_to ON relations(to_knowledge_id,id,relation_version);
             CREATE TRIGGER IF NOT EXISTS coauthor_dirty_fact_insert AFTER INSERT ON facts BEGIN
                INSERT OR IGNORE INTO coauthor_source_queue VALUES('FACT',NEW.knowledge_id);
             END;
             CREATE TRIGGER IF NOT EXISTS coauthor_dirty_relation_insert AFTER INSERT ON relations BEGIN
                INSERT OR IGNORE INTO coauthor_source_queue VALUES('RELATION',NEW.id);
             END;",
        )?;
        for (event, record) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS coauthor_dirty_fact_pointer_{event}
                 AFTER {event} ON fact_current_versions BEGIN
                    INSERT OR IGNORE INTO coauthor_source_queue VALUES('FACT',{record}.knowledge_id);
                    INSERT OR IGNORE INTO coauthor_source_queue
                        SELECT 'RELATION',id FROM relations WHERE from_knowledge_id={record}.knowledge_id;
                    INSERT OR IGNORE INTO coauthor_source_queue
                        SELECT 'RELATION',id FROM relations WHERE to_knowledge_id={record}.knowledge_id;
                 END;"
            ))?;
        }
        tx.execute_batch(
            "INSERT OR IGNORE INTO coauthor_source_queue SELECT 'FACT',knowledge_id FROM fact_current_versions;
             INSERT OR IGNORE INTO coauthor_source_queue SELECT 'RELATION',id FROM relations;
             INSERT INTO schema_migrations(version,name) VALUES(58,'coauthor_knowledge_retrieval');",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn knowledge_anchors(
        &self,
        project: Uuid,
        ids: &[Uuid],
    ) -> Result<(Vec<CoauthorKnowledgeAnchor>, String), CoauthorError> {
        // Hash all metadata, but never load chapter bodies for a directory/search.
        let mut stmt = self.connection.prepare(
                "SELECT j.value,a.chapter_id,a.source_revision_id,a.block_id,
                    CASE WHEN a.lifecycle_status='ARCHIVED' OR n.archived<>0 THEN 'ARCHIVED'
                         WHEN a.lifecycle_status<>'ACTIVE' THEN 'NEEDS_REVIEW'
                         WHEN m.id IS NULL OR a.source_hash<>m.content_hash OR a.start_offset>=a.end_offset
                           OR (a.source_version<>m.id AND a.source_version<>'manuscript:' || m.id)
                           OR m.chapter_id<>a.chapter_id OR n.id IS NULL THEN 'INVALID'
                         WHEN m.id<>(SELECT latest.id FROM manuscript_revisions latest
                            WHERE latest.chapter_id=m.chapter_id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
                            THEN 'STALE'
                         ELSE 'CURRENT_REVISION' END,
                    a.start_offset,a.end_offset,a.source_version,a.source_hash,a.lifecycle_status,
                    m.content_hash,m.chapter_id,n.archived,
                    (SELECT latest.id FROM manuscript_revisions latest WHERE latest.chapter_id=a.chapter_id
                        ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
                 FROM json_each(?1) j LEFT JOIN evidence_anchors a ON a.id=j.value AND a.project_id=?2
                 LEFT JOIN manuscript_revisions m ON m.id=a.source_revision_id
                 LEFT JOIN plan_nodes n ON n.id=a.chapter_id
                 ORDER BY CAST(j.key AS INTEGER)",
        )?;
        let rows = stmt.query_map(rusqlite::params![encode(&ids)?,project.to_string()], |row| {
            let present = row.get::<_, Option<String>>(1)?.is_some();
            let anchor = CoauthorKnowledgeAnchor {
                id: super::super::manuscript_source_store::row_uuid(row, 0)?,
                chapter_id: if present { Some(super::super::manuscript_source_store::row_uuid(row, 1)?) } else { None },
                revision_id: if present { Some(super::super::manuscript_source_store::row_uuid(row, 2)?) } else { None },
                block_id: row.get(3)?,
                status: if present { row.get(4)? } else { "MISSING".into() },
            };
            let metadata = serde_json::json!([
                anchor, row.get::<_,Option<i64>>(5)?, row.get::<_,Option<i64>>(6)?,
                row.get::<_,Option<String>>(7)?, row.get::<_,Option<String>>(8)?,
                row.get::<_,Option<String>>(9)?, row.get::<_,Option<String>>(10)?,
                row.get::<_,Option<String>>(11)?, row.get::<_,Option<bool>>(12)?,
                row.get::<_,Option<String>>(13)?,
            ]);
            Ok((anchor, metadata.to_string()))
        })?;
        let mut anchors = Vec::with_capacity(ids.len());
        let mut fingerprint = Sha256::new();
        for row in rows {
            let (anchor, metadata) = row?;
            fingerprint.update(metadata.as_bytes());
            fingerprint.update(b"\n");
            anchors.push(anchor);
        }
        Ok((anchors, format!("{:x}", fingerprint.finalize())))
    }

    fn coauthor_knowledge_anchor_ids(
        &self, project: Uuid, key: &str,
    ) -> Result<Vec<Uuid>, CoauthorError> {
        let (kind, id) = key.split_once(':').ok_or(CoauthorError::NotFound)?;
        let sql = match kind {
            "FACT" => "SELECT f.evidence_anchor_ids_json FROM facts f JOIN fact_current_versions c
                ON c.knowledge_id=f.knowledge_id AND c.knowledge_version=f.knowledge_version
                WHERE f.knowledge_id=?1 AND f.project_id=?2 AND f.lifecycle_status='ACTIVE'",
            "RELATION" => "SELECT r.evidence_anchor_ids_json FROM relations r WHERE r.id=?1
                AND r.project_id=?2 AND r.lifecycle_status='ACTIVE'
                AND r.relation_version=(SELECT MAX(v.relation_version) FROM relations v WHERE v.id=r.id)",
            _ => return Err(CoauthorError::Invalid("不是可读取的事实或关系来源。".into())),
        };
        let json = self.connection.query_row(sql, rusqlite::params![id,project.to_string()],
            |row| row.get(0)).optional()?.ok_or(CoauthorError::NotFound)?;
        decode(json)
    }

    pub(super) fn coauthor_knowledge_source(
        &self,
        key: &str,
    ) -> Result<Option<CoauthorSource>, CoauthorError> {
        let (kind, id) = key.split_once(':').ok_or(CoauthorError::NotFound)?;
        let mut facts = Vec::new();
        let mut facts_current = true;
        let (project, version, title, text, anchor_json, native): (
            String,
            i64,
            String,
            String,
            String,
            String,
        ) = match kind {
            "FACT" => {
                let record = self
                    .connection
                    .query_row(
                        "SELECT f.project_id,f.knowledge_version,f.subject,f.predicate,f.object,
                        f.evidence_anchor_ids_json,f.source_revision_id
                     FROM facts f JOIN fact_current_versions c
                        ON c.knowledge_id=f.knowledge_id AND c.knowledge_version=f.knowledge_version
                     WHERE f.knowledge_id=?1 AND f.lifecycle_status='ACTIVE'",
                        [id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((project, version, subject, predicate, object, anchors, source)) = record
                else {
                    return Ok(None);
                };
                let title = format!("{subject} · {predicate} · {object}");
                (
                    project,
                    version,
                    title.clone(),
                    format!("已审核事实：{title}\n原始正文修订：{source}"),
                    anchors,
                    source,
                )
            }
            "RELATION" => {
                let record = self.connection.query_row(
                    "SELECT r.project_id,r.relation_version,r.relation_type,r.from_knowledge_id,
                        r.to_knowledge_id,r.evidence_anchor_ids_json FROM relations r WHERE r.id=?1
                        AND r.relation_version=(SELECT MAX(v.relation_version) FROM relations v WHERE v.id=r.id)
                        AND r.lifecycle_status='ACTIVE'",
                    [id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,
                        row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)),
                ).optional()?;
                let Some((project, version, title, from, to, anchors)) = record else {
                    return Ok(None);
                };
                let mut descriptions = Vec::new();
                for fact_id in [from, to] {
                    let fact_key = format!("FACT:{fact_id}");
                    if let Some(fact) = self.coauthor_knowledge_source(&fact_key)?
                        && fact
                            .knowledge_context
                            .as_ref()
                            .is_some_and(|context| context.project_id.to_string() == project)
                    {
                        facts_current &= fact
                            .knowledge_context
                            .as_ref()
                            .is_some_and(|context| context.status == "CURRENT");
                        descriptions.push(fact.content.clone());
                        facts.push(CoauthorKnowledgeLink {
                            key: fact.key,
                            revision: fact.revision,
                            title: fact.title,
                        });
                    } else {
                        facts_current = false;
                        descriptions.push(format!(
                            "关联事实 {fact_id} 已归档、缺失或不属于本项目，须重新核对。"
                        ));
                    }
                }
                (
                    project,
                    version,
                    title.clone(),
                    format!("关系记录：{title}\n{}", descriptions.join("\n")),
                    anchors,
                    String::new(),
                )
            }
            _ => {
                return Err(CoauthorError::Invalid(
                    "不是可读取的事实或关系来源。".into(),
                ));
            }
        };
        let project_id = project.parse().map_err(|_| CoauthorError::NotFound)?;
        let ids: Vec<Uuid> = decode(anchor_json)?;
        let (anchors, fingerprint) = self.knowledge_anchors(project_id, &ids)?;
        let current = !ids.is_empty()
            && anchors.iter().all(|anchor| {
                anchor.status == "CURRENT_REVISION"
                    && (kind != "FACT"
                        || anchor.revision_id.map(|id| id.to_string()).as_deref() == Some(&native))
            });
        // Related fact content includes its own evidence status, and is part of the revision.
        let current = current && facts_current;
        let provenance = CoauthorKnowledgeContext {
            project_id,
            version,
            status: if current { "CURRENT" } else { "NEEDS_REVIEW" }.into(),
            anchors: anchors.into_iter().take(16).collect(),
            has_more_anchors: ids.len() > 16,
            total_anchors: ids.len(),
            facts,
        };
        let content = format!(
            "{text}\n依据状态：{}\n{KNOWLEDGE_WARNING}",
            if current {
                "原修订仍在用，原文范围尚须精读验证"
            } else {
                "待核对，不能直接作为当前有效结论"
            }
        );
        let revision = format!(
            "{version}:{:x}",
            Sha256::digest(format!("{key}\n{content}\n{}\n{fingerprint}", encode(&provenance)?))
        );
        Ok(Some(CoauthorSource {
            key: key.into(),
            kind: kind.into(),
            title,
            revision,
            total_chars: content.chars().count(),
            content,
            session_id: None,
            offset: 0,
            decision_context: None,
            knowledge_context: Some(provenance),
        }))
    }
}

impl ProjectManager {
    pub fn coauthor_knowledge_anchors(
        &self, scope: &CoauthorScope, key: &str, revision: &str, offset: usize,
    ) -> Result<CoauthorKnowledgeAnchorsPage, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        // Keep version validation and the returned page in the same read snapshot.
        let _snapshot = db.connection.unchecked_transaction()?;
        self.read_coauthor_source(scope, key, revision, 0, 1)?;
        let ids = db.coauthor_knowledge_anchor_ids(scope.project_id, key)?;
        if offset > ids.len() {
            return Err(CoauthorError::Invalid("证据目录位置超出范围。".into()));
        }
        let end = offset.saturating_add(16).min(ids.len());
        let (anchors, _) = db.knowledge_anchors(scope.project_id, &ids[offset..end])?;
        Ok(CoauthorKnowledgeAnchorsPage {
            knowledge_key: key.into(), knowledge_revision: revision.into(),
            anchors, offset, total_anchors: ids.len(), next_offset: end,
        })
    }

    pub fn coauthor_related_knowledge(
        &self,
        scope: &CoauthorScope,
        key: &str,
        revision: &str,
        offset: u32,
    ) -> Result<CoauthorSearchPage, CoauthorError> {
        let fact = self.read_coauthor_source(scope, key, revision, 0, 1)?;
        if fact.kind != "FACT" {
            return Err(CoauthorError::Invalid(
                "直接关联查询需要准确的事实身份与修订。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let id = key.strip_prefix("FACT:").ok_or(CoauthorError::NotFound)?;
        let mut stmt=db.connection.prepare(
            "SELECT r.id FROM relations r WHERE r.project_id=?1
             AND (r.from_knowledge_id=?2 OR r.to_knowledge_id=?2)
             AND r.relation_version=(SELECT MAX(v.relation_version) FROM relations v WHERE v.id=r.id)
             AND r.lifecycle_status='ACTIVE' ORDER BY r.id LIMIT 13 OFFSET ?3")?;
        let ids = stmt
            .query_map(
                rusqlite::params![scope.project_id.to_string(), id, offset],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > 12;
        let mut hits = Vec::new();
        for id in ids.into_iter().take(12) {
            if let Some(mut source) = db.coauthor_knowledge_source(&format!("RELATION:{id}"))? {
                source.content = source.content.chars().take(600).collect();
                hits.push(source);
            }
        }
        Ok(CoauthorSearchPage { hits,has_more,pending_index_updates:db.coauthor_pending_updates()?,
            coverage:"只列出此事实的直接关系，不是语义检索或全书影响扫描；关系和关联事实的证据状态须分别核对。".into() })
    }

    pub fn read_coauthor_knowledge_evidence(
        &self,
        scope: &CoauthorScope,
        key: &str,
        revision: &str,
        anchor_id: Uuid,
        offset: usize,
        limit: usize,
    ) -> Result<CoauthorKnowledgeEvidence, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot = db.connection.unchecked_transaction()?;
        self.read_coauthor_source(scope, key, revision, 0, 1)?;
        if !db.coauthor_knowledge_anchor_ids(scope.project_id, key)?.contains(&anchor_id) {
            return Err(CoauthorError::Invalid(
                "该证据不属于此版本的事实或关系记录。".into(),
            ));
        }
        let evidence = self
            .get_manuscript_source(ManuscriptSourceRequest {
                project_id: Some(scope.project_id),
                evidence_anchor_id: Some(anchor_id),
                ..Default::default()
            })
            .map_err(|error| {
                CoauthorError::Invalid(format!("正文证据校验失败，未替换为其他原文：{error}"))
            })?;
        let quote = evidence.quote.ok_or(CoauthorError::NotFound)?;
        let total_chars = quote.chars().count();
        if offset > total_chars {
            return Err(CoauthorError::Invalid("证据读取位置超出原文。".into()));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let (start, end) = db.connection.query_row(
            "SELECT start_offset,end_offset FROM evidence_anchors WHERE id=?1",
            [anchor_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let content: String = quote
            .chars()
            .skip(offset)
            .take(limit.clamp(1, 12000))
            .collect();
        Ok(CoauthorKnowledgeEvidence {
            knowledge_key: key.into(),
            knowledge_revision: revision.into(),
            anchor_id,
            chapter_id: evidence.revision.chapter_id,
            revision_id: evidence.revision.id,
            block_id: evidence.block_id.ok_or(CoauthorError::NotFound)?,
            start,
            end,
            next_offset: offset + content.chars().count(),
            content,
            offset,
            total_chars,
            is_current_revision: evidence.is_current_revision && !evidence.chapter_archived,
        })
    }
}

#[cfg(test)]
mod tests;
