use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorUndoRecord {
    pub item_id: String,
    pub before: Option<Value>,
    pub after_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorReversalItem {
    pub item_id: String,
    pub title: String,
    pub source_key: String,
    pub action: String,
    pub before: CoauthorSource,
    pub after: Option<CoauthorSource>,
    pub before_document_json: Option<String>,
    pub after_document_json: Option<String>,
    pub result_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorReversal {
    pub id: Uuid,
    pub change_set_id: Uuid,
    pub version: i64,
    pub status: String,
    pub base_document: CoauthorDocument,
    pub items: Vec<CoauthorReversalItem>,
    pub blockers: Vec<String>,
    pub impact_count: u32,
    pub linked_draft: bool,
}

impl ProjectManager {
    pub fn prepare_coauthor_reversal(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
        expected_document_version: i64,
    ) -> Result<CoauthorReversal, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let changes = db.load_coauthor_changeset(scope, id)?;
        let existing = db.coauthor_reversal(scope, id)?;
        if let Some(receipt) = existing
            .as_ref()
            .filter(|receipt| receipt.status == "COMMITTED")
        {
            return Ok(receipt.clone());
        }
        if changes.version != expected_version
            || db.coauthor_document(scope.session_id)?.version != expected_document_version
        {
            return Err(CoauthorError::Conflict);
        }
        let mut preview = db.build_coauthor_reversal(scope, &changes)?;
        preview.id = existing
            .as_ref()
            .map_or_else(Uuid::new_v4, |value| value.id);
        preview.version = existing.map_or(1, |value| value.version + 1);
        tx.execute(
            "INSERT INTO coauthor_reversals(id,change_set_id,session_id,version,status,payload)
            VALUES (?1,?2,?3,?4,'PENDING',?5) ON CONFLICT(change_set_id) DO UPDATE SET
            version=excluded.version,payload=excluded.payload",
            rusqlite::params![
                preview.id.to_string(),
                id.to_string(),
                scope.session_id.to_string(),
                preview.version,
                encode(&preview)?
            ],
        )?;
        tx.commit()?;
        Ok(preview)
    }

    pub fn get_coauthor_reversal(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<Option<CoauthorReversal>, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .coauthor_reversal(scope, id)
    }

    pub fn commit_coauthor_reversal(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
    ) -> Result<CoauthorReversal, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let mut preview = db
            .coauthor_reversal(scope, id)?
            .ok_or(CoauthorError::NotFound)?;
        if preview.status == "COMMITTED" && preview.version - 1 == expected_version {
            return Ok(preview);
        }
        if preview.status != "PENDING" || preview.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        let changes = db.load_coauthor_changeset(scope, id)?;
        let mut actual = db.build_coauthor_reversal(scope, &changes)?;
        actual.id = preview.id;
        actual.version = preview.version;
        if actual != preview {
            return Err(CoauthorError::Conflict);
        }
        if !preview.blockers.is_empty() || preview.items.len() != changes.published.len() {
            return Err(CoauthorError::Invalid(
                "撤销仍有未处理的编辑冲突或后续依赖，正式内容未改动。".into(),
            ));
        }
        // Reverse the complete adopted subset. No dependency is left adopted
        // while its prerequisite is removed.
        for published in changes.published.iter().rev() {
            let undo = changes
                .undo
                .iter()
                .find(|undo| undo.item_id == published.item_id)
                .ok_or(CoauthorError::NotFound)?;
            db.reverse_coauthor_target(
                &tx,
                scope,
                published,
                undo,
                &format!("coauthor-reversal:{}", preview.id),
            )?;
        }
        if preview.linked_draft {
            let mut restored = CoauthorDocument {
                version: preview.base_document.version + 1,
                ..changes.base_document.clone()
            };
            if let Some(key) = &restored.target_key {
                restored.target_revision = Some(
                    db.coauthor_source(key)?
                        .ok_or(CoauthorError::NotFound)?
                        .revision,
                );
            }
            let payload = encode(&restored)?;
            tx.execute(
                "UPDATE coauthor_documents SET version=?2,payload=?3 WHERE session_id=?1",
                rusqlite::params![scope.session_id.to_string(), restored.version, payload],
            )?;
            tx.execute(
                "INSERT INTO coauthor_document_revisions VALUES (?1,?2,?3)",
                rusqlite::params![scope.session_id.to_string(), restored.version, payload],
            )?;
        }
        for item in &mut preview.items {
            item.result_revision = db
                .coauthor_source(&item.source_key)?
                .map(|source| source.revision);
        }
        preview.status = "COMMITTED".into();
        preview.version += 1;
        tx.execute("UPDATE coauthor_reversals SET version=?2,status='COMMITTED',payload=?3 WHERE change_set_id=?1",
            rusqlite::params![id.to_string(),preview.version,encode(&preview)?])?;
        tx.commit()?;
        Ok(preview)
    }
}

impl Database {
    pub(super) fn coauthor_read_dependencies(
        &self,
        run: Uuid,
    ) -> Result<Vec<CoauthorSourceDependency>, CoauthorError> {
        let audit: String = self.connection.query_row(
            "SELECT audit FROM coauthor_runs WHERE id=?1",
            [run.to_string()],
            |row| row.get(0),
        )?;
        let audit: Vec<Value> = decode(audit)?;
        let mut dependencies = std::collections::BTreeMap::new();
        for step in audit {
            if step["kind"]=="tool" && step["name"]=="read_knowledge_evidence"
                && let (Some(key),Some(revision))=(step["result"]["knowledgeKey"].as_str(),step["result"]["knowledgeRevision"].as_str())
            {
                dependencies.insert(key.to_owned(),revision.to_owned());
            }
            if step["kind"] == "tool"
                && matches!(
                    step["name"].as_str(),
                    Some("read_source" | "read_manuscript_blocks" | "read_outline_content" | "read_check_source")
                )
                && let (Some(key), Some(revision)) = (
                    step["result"]["key"].as_str(),
                    step["result"]["revision"].as_str(),
                )
            {
                dependencies.insert(key.to_owned(), revision.to_owned());
            }
        }
        Ok(dependencies
            .into_iter()
            .map(|(key, revision)| CoauthorSourceDependency { key, revision })
            .collect())
    }

    pub(super) fn validate_coauthor_dependencies(
        &self,
        dependencies: &[CoauthorSourceDependency],
    ) -> Result<(), CoauthorError> {
        for dependency in dependencies {
            if self
                .coauthor_source(&dependency.key)?
                .is_none_or(|source| source.revision != dependency.revision
                    || source.knowledge_context.as_ref().is_some_and(|context|context.status!="CURRENT"))
            {
                return Err(CoauthorError::Invalid(
                    "准备方案时读取的来源已经变化或撤销，请重新查证后再准备采用。".into(),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn coauthor_reversed_by(&self, id: Uuid) -> Result<Option<Uuid>, CoauthorError> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM coauthor_reversals WHERE change_set_id=?1 AND status='COMMITTED'",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|id| id.parse().map_err(|_| CoauthorError::NotFound))
            .transpose()
    }

    fn coauthor_reversal(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<Option<CoauthorReversal>, CoauthorError> {
        self.connection
            .query_row(
                "SELECT payload FROM coauthor_reversals WHERE change_set_id=?1 AND session_id=?2",
                rusqlite::params![id.to_string(), scope.session_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(decode)
            .transpose()
    }

    fn build_coauthor_reversal(
        &self,
        scope: &CoauthorScope,
        changes: &CoauthorChangeSet,
    ) -> Result<CoauthorReversal, CoauthorError> {
        if changes.status != "COMMITTED"
            || changes.reversed_by.is_some()
            || changes.published.is_empty()
        {
            return Err(CoauthorError::Invalid(
                "只能撤销尚未撤销的正式采用。".into(),
            ));
        }
        let base_document = self.coauthor_document(scope.session_id)?;
        let mut blockers = Vec::new();
        let mut items = Vec::new();
        let linked_draft = changes.selected_ids.iter().any(|id| id == "draft");
        if linked_draft {
            let linked: Option<String> = self.connection.query_row(
                "SELECT payload FROM coauthor_document_revisions WHERE session_id=?1 AND version=?2",
                rusqlite::params![scope.session_id.to_string(),changes.base_document.version+1], |row| row.get(0)).optional()?;
            if linked.map(decode::<CoauthorDocument>).transpose()?.as_ref() != Some(&base_document)
            {
                blockers.push("工作稿在采用后已有新编辑或新关联，不能恢复旧工作稿。".into());
            }
        }
        for published in &changes.published {
            let Some(undo) = changes
                .undo
                .iter()
                .find(|undo| undo.item_id == published.item_id)
            else {
                blockers.push(format!(
                    "{}：旧回执缺少结构校验快照，不能自动撤销。",
                    published.source_key
                ));
                continue;
            };
            let Some(source) = self.coauthor_source(&published.source_key)? else {
                blockers.push(format!("{}：来源已归档或不可用。", published.source_key));
                continue;
            };
            if source.revision != published.revision
                || self.coauthor_native_fingerprint(&source.key)? != undo.after_fingerprint
            {
                blockers.push(format!(
                    "「{}」采用后已有编辑、结构变化或新增引用。",
                    source.title
                ));
            }
            if source.kind == "MANUSCRIPT" {
                let chapter = source
                    .key
                    .strip_prefix("MANUSCRIPT:")
                    .and_then(|id| id.parse().ok())
                    .ok_or(CoauthorError::NotFound)?;
                if self
                    .current_manuscript_draft(chapter)
                    .map_err(|_| CoauthorError::Conflict)?
                    .document_json
                    .is_some()
                {
                    blockers.push(format!("「{}」有未提交的正文编辑稿。", source.title));
                }
            }
            // Working copies outside the linked draft are explicit consumers.
            let consumers: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM coauthor_documents WHERE json_extract(payload,'$.targetKey')=?1
                    AND NOT (session_id=?2 AND ?3=1)",
                rusqlite::params![source.key,scope.session_id.to_string(),linked_draft], |row| row.get(0))?;
            if consumers > 0 {
                blockers.push(format!("「{}」仍被其他工作稿关联。", source.title));
            }
            if self.coauthor_later_consumer(changes.id, &source.key, &published.revision)? {
                blockers.push(format!(
                    "「{}」有其他未撤销的采用使用过其来源，需要先处理后续采用。",
                    source.title
                ));
            }
            let after = undo
                .before
                .as_ref()
                .map(|before| {
                    serde_json::from_value::<CoauthorSource>(before["source"].clone())
                        .map_err(|_| CoauthorError::Invalid("恢复快照不完整。".into()))
                })
                .transpose()?;
            let native = self.coauthor_native_snapshot(&source.key)?;
            items.push(CoauthorReversalItem {
                item_id: published.item_id.clone(),
                title: source.title.clone(),
                source_key: source.key.clone(),
                action: if after.is_some() {
                    "RESTORE"
                } else {
                    "ARCHIVE"
                }
                .into(),
                before: source,
                after,
                before_document_json: native["manuscript"][0]["document_json"]
                    .as_str()
                    .map(str::to_owned),
                after_document_json: undo
                    .before
                    .as_ref()
                    .and_then(|before| before["manuscript"][0]["document_json"].as_str())
                    .map(str::to_owned),
                result_revision: None,
            });
        }
        let running: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_runs WHERE session_id=?1 AND status='RUNNING')",
            [scope.session_id.to_string()],
            |row| row.get(0),
        )?;
        if running {
            blockers.push("当前讨论仍在生成，请先停止或等待完成。".into());
        }
        let impact_count = self.connection.query_row(
            "SELECT COUNT(*) FROM coauthor_impacts WHERE json_extract(payload,'$.changeSetId')=?1",
            [changes.id.to_string()],
            |row| row.get(0),
        )?;
        Ok(CoauthorReversal {
            id: Uuid::nil(),
            change_set_id: changes.id,
            version: 1,
            status: "PENDING".into(),
            base_document,
            items,
            blockers,
            impact_count,
            linked_draft,
        })
    }

    fn coauthor_later_consumer(
        &self,
        id: Uuid,
        key: &str,
        revision: &str,
    ) -> Result<bool, CoauthorError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_changesets c WHERE c.status='COMMITTED' AND c.id<>?1
             AND NOT EXISTS(SELECT 1 FROM coauthor_reversals r WHERE r.change_set_id=c.id AND r.status='COMMITTED')
             AND (
                EXISTS(SELECT 1 FROM json_each(c.payload,'$.items') i
                    WHERE json_extract(i.value,'$.document.targetKey')=?2
                        AND json_extract(i.value,'$.document.targetRevision')=?3
                        AND EXISTS(SELECT 1 FROM json_each(c.payload,'$.selectedIds') s WHERE s.value=json_extract(i.value,'$.id')))
                OR EXISTS(SELECT 1 FROM coauthor_impacts i WHERE json_extract(i.payload,'$.changeSetId')=c.id
                    AND json_extract(i.payload,'$.evidence.key')=?2 AND json_extract(i.payload,'$.evidence.revision')=?3)
                OR EXISTS(SELECT 1 FROM json_each(c.payload,'$.readDependencies') i WHERE json_extract(i.value,'$.key')=?2
                    AND json_extract(i.value,'$.revision')=?3)
                OR EXISTS(SELECT 1 FROM coauthor_runs run, json_each(run.audit) a
                    WHERE run.id=json_extract(c.payload,'$.runId') AND json_extract(a.value,'$.kind')='tool'
                    AND json_extract(a.value,'$.name') IN ('read_source','read_manuscript_blocks','read_outline_content','read_check_source')
                    AND json_extract(a.value,'$.result.key')=?2 AND json_extract(a.value,'$.result.revision')=?3)
             ))", rusqlite::params![id.to_string(),key,revision], |row| row.get(0))?)
    }

    pub(crate) fn migrate_coauthor_reversals(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch("CREATE TABLE coauthor_reversals (
            id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL UNIQUE REFERENCES coauthor_changesets(id),
            session_id TEXT NOT NULL REFERENCES discussion_sessions(id), version INTEGER NOT NULL CHECK(version>0),
            status TEXT NOT NULL CHECK(status IN ('PENDING','COMMITTED')), payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX coauthor_reversals_session ON coauthor_reversals(session_id);
        INSERT INTO schema_migrations(version,name) VALUES (54,'coauthor_reversals');")?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
