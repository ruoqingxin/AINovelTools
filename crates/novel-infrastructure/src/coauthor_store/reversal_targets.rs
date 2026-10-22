use super::*;
use serde_json::json;

fn rows(db: &Database, sql: &str, id: &str) -> Result<Value, CoauthorError> {
    let mut stmt = db.connection.prepare(sql)?;
    let names = stmt
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let values = stmt
        .query_map([id], |row| {
            let mut object = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(value) => json!(value),
                    rusqlite::types::ValueRef::Real(value) => json!(value),
                    rusqlite::types::ValueRef::Text(value) => {
                        Value::String(String::from_utf8_lossy(value).into())
                    }
                    rusqlite::types::ValueRef::Blob(_) => {
                        return Err(rusqlite::Error::InvalidQuery);
                    }
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(values))
}

pub(super) fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, CoauthorError> {
    value[name]
        .as_str()
        .ok_or_else(|| CoauthorError::Invalid("采用回执缺少完整恢复数据，不能自动撤销。".into()))
}

impl Database {
    pub(super) fn coauthor_native_snapshot(&self, key: &str) -> Result<Value, CoauthorError> {
        let source = self.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
        let (kind, id) = key.split_once(':').ok_or(CoauthorError::NotFound)?;
        match kind {
            "ENTITY" => Ok(json!({
                "entity": rows(self, "SELECT * FROM entities WHERE id=?1", id)?[0],
                "revision": rows(self, "SELECT r.* FROM entity_revisions r JOIN entities e ON e.current_revision_id=r.id WHERE e.id=?1", id)?[0],
                "rules": rows(self, "SELECT a.* FROM author_settings a JOIN entities e ON e.current_revision_id=a.entity_revision_id WHERE e.id=?1 ORDER BY a.id", id)?,
                "references": rows(self, "SELECT r.chapter_id,r.entity_id,s.version FROM chapter_entity_references r
                    JOIN chapter_entity_reference_sets s ON s.chapter_id=r.chapter_id WHERE r.entity_id=?1 ORDER BY r.chapter_id", id)?,
                "relations": rows(self, "SELECT id,relation_version,lifecycle_status FROM relations
                    WHERE from_knowledge_id=?1 OR to_knowledge_id=?1 ORDER BY id,relation_version", id)?,
                "facts": rows(self, "SELECT knowledge_id,knowledge_version,lifecycle_status FROM facts
                    WHERE subject=?1 OR object=?1 ORDER BY knowledge_id,knowledge_version", id)?,
                "source": source,
            })),
            "PLAN" | "MANUSCRIPT" => {
                let node_id = if kind == "PLAN" {
                    id.strip_prefix("plan-node:")
                        .ok_or(CoauthorError::NotFound)?
                } else {
                    id
                };
                Ok(json!({
                    "node": rows(self, "SELECT * FROM plan_nodes WHERE id=?1", node_id)?[0],
                    "section": rows(self, "SELECT * FROM planning_sections WHERE id='plan-node:' || ?1", node_id)?,
                    "chapter": rows(self, "SELECT * FROM chapters WHERE id=?1", node_id)?,
                    "manuscript": rows(self, "SELECT * FROM manuscript_revisions WHERE chapter_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1", node_id)?,
                    "draft": rows(self, "SELECT * FROM manuscript_drafts WHERE chapter_id=?1", node_id)?,
                    "children": rows(self, "SELECT * FROM plan_nodes WHERE parent_id=?1 ORDER BY id", node_id)?,
                    "references": rows(self, "SELECT r.*,s.version FROM chapter_entity_references r
                        JOIN chapter_entity_reference_sets s ON s.chapter_id=r.chapter_id WHERE r.chapter_id=?1 ORDER BY entity_id", node_id)?,
                    "evidence": rows(self, "SELECT * FROM evidence_anchors WHERE chapter_id=?1 ORDER BY id", node_id)?,
                    "facts": rows(self, "SELECT knowledge_id,knowledge_version,lifecycle_status FROM facts
                        WHERE source_revision_id IN (SELECT id FROM manuscript_revisions WHERE chapter_id=?1)
                        ORDER BY knowledge_id,knowledge_version", node_id)?,
                    "knowledgeChanges": rows(self, "SELECT id,status FROM change_sets WHERE chapter_id=?1 ORDER BY id", node_id)?,
                    "discussions": rows(self, "SELECT id,scope_kind,scope_id FROM discussion_sessions WHERE scope_id=?1 ORDER BY id", node_id)?,
                    "foreshadowing": rows(self, "SELECT id,foreshadowing_version,status FROM foreshadowings WHERE target_chapter_id=?1 ORDER BY id,foreshadowing_version", node_id)?,
                    "source": source,
                }))
            }
            _ => Err(CoauthorError::Invalid("此类资料不支持撤销。".into())),
        }
    }

    pub(super) fn coauthor_native_fingerprint(&self, key: &str) -> Result<String, CoauthorError> {
        Ok(format!(
            "{:x}",
            Sha256::digest(encode(&self.coauthor_native_snapshot(key)?)?)
        ))
    }

    pub(super) fn reverse_coauthor_target(
        &self,
        tx: &rusqlite::Transaction<'_>,
        scope: &CoauthorScope,
        published: &CoauthorPublishedItem,
        undo: &CoauthorUndoRecord,
        reason: &str,
    ) -> Result<(), CoauthorError> {
        let (kind, id) = published
            .source_key
            .split_once(':')
            .ok_or(CoauthorError::NotFound)?;
        match (kind, &undo.before) {
            ("ENTITY", None) => {
                tx.execute(
                    "UPDATE entities SET lifecycle_status='ARCHIVED',version=version+1,
                    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                    [id],
                )?;
                tx.execute(
                    "DELETE FROM search_index WHERE object_type='ENTITY' AND object_id=?1",
                    [id],
                )?;
            }
            ("ENTITY", Some(before)) => {
                let old = &before["revision"];
                let new_id = Uuid::new_v4().to_string();
                tx.execute("INSERT INTO entity_revisions(id,entity_id,revision,name,aliases_json,description,
                    fixed_attributes_json,tags_json,base_revision_id,source_version)
                    SELECT ?2,e.id,r.revision+1,?3,?4,?5,?6,?7,r.id,?8 FROM entities e
                    JOIN entity_revisions r ON r.id=e.current_revision_id WHERE e.id=?1",
                    rusqlite::params![id,new_id,field(old,"name")?,field(old,"aliases_json")?,field(old,"description")?,
                        field(old,"fixed_attributes_json")?,field(old,"tags_json")?,reason])?;
                for rule in before["rules"].as_array().ok_or(CoauthorError::NotFound)? {
                    tx.execute("INSERT INTO author_settings(id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
                        VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        rusqlite::params![Uuid::new_v4().to_string(),scope.project_id.to_string(),id,new_id,
                            field(rule,"content")?,field(rule,"visibility")?,field(rule,"source_proposal_id")?])?;
                }
                tx.execute(
                    "UPDATE entities SET current_revision_id=?2,version=version+1,
                    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                    rusqlite::params![id, new_id],
                )?;
                tx.execute(
                    "DELETE FROM search_index WHERE object_type='ENTITY' AND object_id=?1",
                    [id],
                )?;
                tx.execute(
                    "INSERT INTO search_index SELECT 'ENTITY',e.id,e.project_id,r.source_version,
                    r.name || char(10) || r.description || char(10) || r.tags_json FROM entities e
                    JOIN entity_revisions r ON r.id=e.current_revision_id WHERE e.id=?1",
                    [id],
                )?;
            }
            ("MANUSCRIPT", Some(before)) => {
                let chapter = Uuid::parse_str(id).map_err(|_| CoauthorError::NotFound)?;
                let current = self
                    .current_manuscript(chapter)?
                    .ok_or(CoauthorError::NotFound)?;
                let json = field(&before["manuscript"][0], "document_json")?;
                let revision = crate::chapter_draft_store::insert_revision(
                    tx,
                    chapter,
                    Some(current.id),
                    json,
                    reason.into(),
                )
                .map_err(|error| CoauthorError::Invalid(error.to_string()))?;
                tx.execute(
                    "INSERT INTO search_index VALUES ('MANUSCRIPT',?1,?2,?3,?4)",
                    rusqlite::params![
                        revision.id.to_string(),
                        scope.project_id.to_string(),
                        format!("manuscript:{}", revision.id),
                        revision.document_json
                    ],
                )?;
                Self::invalidate_reversed_summaries(tx, id)?;
            }
            ("PLAN" | "MANUSCRIPT", None) => {
                let node_id = if kind == "PLAN" {
                    id.strip_prefix("plan-node:")
                        .ok_or(CoauthorError::NotFound)?
                } else {
                    id
                };
                tx.execute(
                    "UPDATE plan_nodes SET archived=1,revision=revision+1 WHERE id=?1",
                    [node_id],
                )?;
                for table in ["plan_node_revisions", "plan_revisions"] {
                    tx.execute(
                        &format!(
                            "INSERT INTO {table}(id,node_id,revision,title,archived)
                        SELECT ?2,id,revision,title,archived FROM plan_nodes WHERE id=?1"
                        ),
                        rusqlite::params![node_id, Uuid::new_v4().to_string()],
                    )?;
                }
                tx.execute("DELETE FROM search_index WHERE (object_type='PLAN' AND object_id=?1)
                    OR (object_type='MANUSCRIPT' AND object_id IN (SELECT id FROM manuscript_revisions WHERE chapter_id=?1))", [node_id])?;
                Self::invalidate_reversed_summaries(tx, node_id)?;
            }
            _ => {
                return Err(CoauthorError::Invalid(
                    "此采用缺少可恢复的结构化快照，不能自动撤销。".into(),
                ));
            }
        }
        Ok(())
    }

    fn invalidate_reversed_summaries(
        tx: &rusqlite::Transaction<'_>,
        id: &str,
    ) -> Result<(), CoauthorError> {
        tx.execute("UPDATE summary_materials SET lifecycle_status='STALE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE lifecycle_status='ACTIVE' AND (source_id=?1 OR generation_mode='EXTRACTIVE_AUTO_PROJECT')", [id])?;
        Ok(())
    }
}
