use super::*;
use std::collections::BTreeSet;
mod decisions;
pub use decisions::*;
mod consumers;
pub use consumers::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorChangeItemInput {
    pub id: String,
    pub kind: CoauthorDocumentKind,
    pub title: String,
    pub content: String,
    pub target_key: Option<String>,
    pub target_revision: Option<String>,
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub manuscript_edits: Vec<CoauthorManuscriptEdit>,
    #[serde(default)]
    pub outline_edits: Vec<CoauthorOutlineEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorImpactInput {
    pub item_ids: Vec<String>,
    pub key: String,
    pub revision: String,
    pub quote: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorChangeRequest {
    pub expected_document_version: i64,
    pub title: String,
    pub draft_depends_on: Vec<String>,
    pub items: Vec<CoauthorChangeItemInput>,
    pub impacts: Vec<CoauthorImpactInput>,
    pub coverage: String,
    #[serde(default = "include_draft_default")]
    pub include_draft: bool,
    pub decision_dependencies: Vec<CoauthorDecisionDependencyInput>,
}

fn include_draft_default() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangeItem {
    pub id: String,
    pub document: CoauthorDocument,
    pub before: Option<CoauthorSource>,
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub manuscript_edits: Vec<CoauthorManuscriptEdit>,
    #[serde(default)]
    pub manuscript_draft_version: Option<i64>,
    #[serde(default)]
    pub manuscript_before_json: Option<String>,
    #[serde(default)]
    pub manuscript_after_json: Option<String>,
    #[serde(default)]
    pub outline_edits: Vec<CoauthorOutlineEdit>,
    #[serde(default)]
    pub outline_before: Option<VersionedPlanningSection>,
    #[serde(default)]
    pub outline_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorPublishedItem {
    pub item_id: String,
    pub source_key: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorSourceDependency {
    pub key: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangeSet {
    pub id: Uuid,
    pub version: i64,
    pub title: String,
    pub status: String,
    pub base_document: CoauthorDocument,
    pub items: Vec<CoauthorChangeItem>,
    pub impacts: Vec<CoauthorImpactInput>,
    pub coverage: String,
    pub selected_ids: Vec<String>,
    pub published: Vec<CoauthorPublishedItem>,
    pub run_id: Option<Uuid>,
    #[serde(default)]
    pub undo: Vec<CoauthorUndoRecord>,
    #[serde(default)]
    pub reversed_by: Option<Uuid>,
    #[serde(default)]
    pub read_dependencies: Vec<CoauthorSourceDependency>,
    #[serde(default)]
    pub decision_dependencies: Option<Vec<CoauthorDecisionDependency>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangeSummary {
    pub id: Uuid,
    pub version: i64,
    pub title: String,
    pub status: String,
    pub item_count: u32,
    pub reversed_by: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorImpact {
    pub id: Uuid,
    pub change_set_id: Uuid,
    pub version: i64,
    pub title: String,
    pub evidence: CoauthorImpactInput,
    pub status: String,
    pub resolution: String,
    pub source_changed: bool,
    #[serde(default)]
    pub origin_reversed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangesPage {
    pub change_sets: Vec<CoauthorChangeSummary>,
    pub impacts: Vec<CoauthorImpact>,
    pub has_more_changes: bool,
    pub has_more_impacts: bool,
}

fn valid_label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max
}

fn validate_dependencies(items: &[CoauthorChangeItem]) -> Result<(), CoauthorError> {
    let names: BTreeSet<_> = items.iter().map(|item| item.id.as_str()).collect();
    if names.len() != items.len()
        || items.iter().any(|item| {
            !valid_label(&item.id, 80)
                || item.depends_on.len() > items.len()
                || item
                    .depends_on
                    .iter()
                    .any(|id| !names.contains(id.as_str()) || id == &item.id)
        })
    {
        return Err(CoauthorError::Invalid(
            "变更标识重复或依赖目标无效。".into(),
        ));
    }
    let mut ready = BTreeSet::new();
    for _ in 0..items.len() {
        for item in items {
            if item.depends_on.iter().all(|id| ready.contains(id.as_str())) {
                ready.insert(item.id.as_str());
            }
        }
    }
    if ready.len() != items.len() {
        return Err(CoauthorError::Invalid(
            "关联变更存在循环依赖，请重新整理。".into(),
        ));
    }
    Ok(())
}

impl ProjectManager {
    pub fn prepare_coauthor_changeset(
        &mut self,
        scope: &CoauthorScope,
        request: CoauthorChangeRequest,
        run_id: Option<Uuid>,
    ) -> Result<CoauthorChangeSet, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if let Some(id) = run_id
            && !self.coauthor_run_active(scope, id)?
        {
            return Err(CoauthorError::Conflict);
        }
        if !valid_label(&request.title, 200)
            || !valid_label(&request.coverage, 2000)
            || request.items.len() + usize::from(request.include_draft) > 8
            || (!request.include_draft && (request.items.is_empty() || !request.draft_depends_on.is_empty()))
            || request.impacts.len() > 40
        {
            return Err(CoauthorError::Invalid(
                "变更集范围无效，最多关联八份稿件和四十项已知影响。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let base_document = db.coauthor_document(scope.session_id)?;
        if base_document.version != request.expected_document_version {
            return Err(CoauthorError::Conflict);
        }
        let mut items = Vec::new();
        if request.include_draft {
            items.push(CoauthorChangeItem {
                id: "draft".into(),
                before: db.validate_coauthor_publication(&base_document)?,
                document: base_document.clone(),
                depends_on: request.draft_depends_on,
                manuscript_edits: vec![], manuscript_draft_version: None,
                manuscript_before_json: None, manuscript_after_json: None,
                outline_edits: vec![], outline_before: None, outline_fingerprint: None,
            });
        }
        for item in request.items {
            if item.id == "draft" {
                return Err(CoauthorError::Invalid("draft 为当前工作稿的保留标识。".into()));
            }
            let document = CoauthorDocument {
                session_id: scope.session_id,
                version: base_document.version,
                kind: item.kind,
                title: item.title,
                content: item.content,
                target_key: item.target_key,
                target_revision: item.target_revision,
                narrative_position: base_document.narrative_position.clone(),
            };
            let mut change = CoauthorChangeItem {
                id: item.id,
                before: None,
                document,
                depends_on: item.depends_on,
                manuscript_edits: item.manuscript_edits, manuscript_draft_version: None,
                manuscript_before_json: None, manuscript_after_json: None,
                outline_edits: item.outline_edits, outline_before: None, outline_fingerprint: None,
            };
            if !change.outline_edits.is_empty() {
                if !change.document.content.is_empty() {
                    return Err(CoauthorError::Invalid("大纲局部修改的 content 必须为空，由准确原文范围生成预览。".into()));
                }
                db.prepare_outline_item(&mut change)?;
            } else if change.manuscript_edits.is_empty() {
                change.before = db.validate_coauthor_publication(&change.document)?;
            } else {
                if !change.document.content.is_empty() {
                    return Err(CoauthorError::Invalid("正文局部修改的 content 必须为空，由准确原文与修改范围生成预览。".into()));
                }
                db.prepare_manuscript_item(&mut change)?;
            }
            items.push(change);
        }
        validate_dependencies(&items)?;
        let decision_dependencies = db.prepare_coauthor_decision_dependencies(
            scope, &items, &request.decision_dependencies,
        )?;
        let targets: Vec<_> = items
            .iter()
            .filter_map(|item| item.document.target_key.as_ref())
            .collect();
        if targets.iter().collect::<BTreeSet<_>>().len() != targets.len() {
            return Err(CoauthorError::Invalid(
                "同一正式对象不能在一组中被多次修改。".into(),
            ));
        }
        if items
            .iter()
            .map(|item| {
                item.document.content.chars().count()
                    + item.before.as_ref().map_or(0, |source| source.total_chars)
                    + item.manuscript_before_json.as_ref().map_or(0, |json| json.chars().count())
                    + item.manuscript_after_json.as_ref().map_or(0, |json| json.chars().count())
                    + item.outline_before.as_ref().map_or(0, |before| before.section.pending_content.chars().count()
                        + before.section.rationale.chars().count() + before.section.consequence.chars().count()
                        + before.section.references.iter().map(String::len).sum::<usize>())
            })
            .sum::<usize>()
            + decision_dependencies.iter().map(|entry| entry.decision.content.chars().count()).sum::<usize>()
            > 1_000_000
        {
            return Err(CoauthorError::Invalid(
                "变更集过大，请按可独立采用的范围分组。".into(),
            ));
        }
        for impact in &request.impacts {
            db.validate_coauthor_impact(impact, &items)?;
        }
        let read_dependencies = run_id.map(|id| db.coauthor_read_dependencies(id)).transpose()?.unwrap_or_default();
        db.validate_coauthor_dependencies(&read_dependencies)?;
        let changes = CoauthorChangeSet {
            id: Uuid::new_v4(),
            version: 1,
            title: request.title,
            status: "PENDING".into(),
            base_document,
            items,
            impacts: request.impacts,
            coverage: request.coverage,
            selected_ids: vec![],
            published: vec![],
            run_id,
            undo: vec![], reversed_by: None,
            read_dependencies, decision_dependencies: Some(decision_dependencies),
        };
        tx.execute(
            "INSERT INTO coauthor_changesets(id,session_id,version,title,status,item_count,payload)
             VALUES (?1,?2,1,?3,'PENDING',?4,?5)",
            rusqlite::params![
                changes.id.to_string(),
                scope.session_id.to_string(),
                changes.title,
                u32::try_from(changes.items.len()).unwrap_or(u32::MAX),
                encode(&changes)?
            ],
        )?;
        db.index_coauthor_decision_consumers(&changes)?;
        tx.commit()?;
        Ok(changes)
    }

    pub fn coauthor_changeset(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<CoauthorChangeSet, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let _snapshot = db.connection.unchecked_transaction()?;
        db.load_coauthor_changeset(scope, id)
    }

    pub fn discard_coauthor_changeset(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
    ) -> Result<CoauthorChangeSet, CoauthorError> {
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
        let mut changes = db.load_coauthor_changeset(scope, id)?;
        if changes.status == "DISCARDED" && changes.version - 1 == expected_version {
            return Ok(changes);
        }
        if changes.status != "PENDING" || changes.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        changes.status = "DISCARDED".into();
        changes.version += 1;
        tx.execute(
            "UPDATE coauthor_changesets SET status='DISCARDED',version=?2,payload=?3 WHERE id=?1",
            rusqlite::params![changes.id.to_string(), changes.version, encode(&changes)?],
        )?;
        tx.commit()?;
        Ok(changes)
    }

    pub fn coauthor_changes(
        &self,
        scope: &CoauthorScope,
        changes_offset: u32,
        impacts_offset: u32,
    ) -> Result<CoauthorChangesPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let mut stmt = db.connection.prepare(
            "SELECT c.id,c.version,c.title,c.status,c.item_count,
                (SELECT r.id FROM coauthor_reversals r WHERE r.change_set_id=c.id AND r.status='COMMITTED')
             FROM coauthor_changesets c WHERE c.session_id=?1 ORDER BY c.rowid DESC LIMIT 21 OFFSET ?2",
        )?;
        let mut change_sets = stmt
            .query_map(
                rusqlite::params![scope.session_id.to_string(), changes_offset],
                |row| {
                    Ok(CoauthorChangeSummary {
                        id: row
                            .get::<_, String>(0)?
                            .parse()
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        version: row.get(1)?,
                        title: row.get(2)?,
                        status: row.get(3)?,
                        item_count: row.get(4)?,
                        reversed_by: row.get::<_, Option<String>>(5)?.map(|id| id.parse()
                            .map_err(|_| rusqlite::Error::InvalidQuery)).transpose()?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more_changes = change_sets.len() > 20;
        change_sets.truncate(20);
        let mut stmt = db.connection.prepare(
            "SELECT payload FROM coauthor_impacts WHERE session_id=?1 ORDER BY rowid DESC LIMIT 21 OFFSET ?2",
        )?;
        let mut impacts = stmt
            .query_map(
                rusqlite::params![scope.session_id.to_string(), impacts_offset],
                |row| row.get::<_, String>(0),
            )?
            .map(|row| decode::<CoauthorImpact>(row?))
            .collect::<Result<Vec<_>, _>>()?;
        let has_more_impacts = impacts.len() > 20;
        impacts.truncate(20);
        for impact in &mut impacts {
            impact.origin_reversed = db.coauthor_reversed_by(impact.change_set_id)?.is_some();
            impact.source_changed = db
                .coauthor_source(&impact.evidence.key)?
                .is_none_or(|source| source.revision != impact.evidence.revision);
        }
        Ok(CoauthorChangesPage {
            change_sets,
            impacts,
            has_more_changes,
            has_more_impacts,
        })
    }

    pub fn commit_coauthor_changeset(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
        selected_ids: Vec<String>,
    ) -> Result<CoauthorChangeSet, CoauthorError> {
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
        let mut changes = db.load_coauthor_changeset(scope, id)?;
        if changes.reversed_by.is_some() {
            return Err(CoauthorError::Invalid("此采用已撤销，历史回执不能重新执行。".into()));
        }
        let selected: BTreeSet<_> = selected_ids.into_iter().collect();
        if selected.is_empty()
            || selected
                .iter()
                .any(|id| !changes.items.iter().any(|item| &item.id == id))
        {
            return Err(CoauthorError::Invalid("请选择实际存在的变更。".into()));
        }
        if changes.status == "COMMITTED" {
            if changes.version - 1 == expected_version
                && selected == changes.selected_ids.iter().cloned().collect()
            {
                return Ok(changes);
            }
            return Err(CoauthorError::Conflict);
        }
        if changes.status != "PENDING"
            || changes.version != expected_version
            || db.coauthor_document(scope.session_id)? != changes.base_document
        {
            return Err(CoauthorError::Conflict);
        }
        if let Some(run_id) = changes.run_id {
            let running: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM coauthor_runs WHERE id=?1 AND status='RUNNING')",
                [run_id.to_string()],
                |row| row.get(0),
            )?;
            if running {
                return Err(CoauthorError::Invalid(
                    "生成尚未结束，请先停止或等待完成再核对采用。".into(),
                ));
            }
        }
        for item in changes
            .items
            .iter()
            .filter(|item| selected.contains(&item.id))
        {
            if item
                .depends_on
                .iter()
                .any(|dependency| !selected.contains(dependency))
            {
                return Err(CoauthorError::Invalid(format!(
                    "「{}」依赖未勾选的变更，请同时采用依赖项或重新准备独立方案。",
                    item.document.title,
                )));
            }
            if !item.outline_edits.is_empty() { db.validate_outline_item(item)?; }
            else if item.manuscript_edits.is_empty() { db.validate_coauthor_publication(&item.document)?; }
            else { db.validate_manuscript_item(item)?; }
        }
        db.validate_coauthor_dependencies(&changes.read_dependencies)?;
        db.validate_coauthor_decision_dependencies(scope, &changes, &selected)?;
        // Evidence is checked before any targets change. Every todo is committed
        // alongside the exact subset that introduced its dependency.
        let impacts = changes
            .impacts
            .iter()
            .filter(|impact| impact.item_ids.iter().any(|item| selected.contains(item)))
            .collect::<Vec<_>>();
        for impact in &impacts {
            db.validate_coauthor_impact(impact, &changes.items)?;
        }
        for item in changes
            .items
            .iter()
            .filter(|item| selected.contains(&item.id))
        {
            let before = if let Some(key) = &item.document.target_key {
                Some(db.coauthor_native_snapshot(key)?)
            } else { None };
            let reason = format!("coauthor-change:{}:{}", changes.id, item.id);
            let key = if !item.outline_edits.is_empty() { db.publish_outline_item(&tx, item)? }
            else if item.manuscript_edits.is_empty() { db.publish_coauthor_item(
                &tx,
                scope,
                &item.document,
                &reason,
            )? } else { db.publish_manuscript_item(&tx, scope, item, &reason)? };
            let source = db.coauthor_source(&key)?.ok_or(CoauthorError::NotFound)?;
            changes.published.push(CoauthorPublishedItem {
                item_id: item.id.clone(),
                source_key: key.clone(),
                revision: source.revision,
            });
            changes.undo.push(CoauthorUndoRecord {
                item_id: item.id.clone(), before,
                after_fingerprint: db.coauthor_native_fingerprint(&key)?,
            });
            if item.id == "draft" {
                db.link_published_coauthor_document(&tx, scope, &item.document, &key)?;
            }
        }
        for evidence in impacts {
            let source = db
                .coauthor_source(&evidence.key)?
                .ok_or(CoauthorError::NotFound)?;
            let impact = CoauthorImpact {
                id: Uuid::new_v4(),
                change_set_id: changes.id,
                version: 1,
                title: source.title,
                evidence: evidence.clone(),
                status: "PENDING".into(),
                resolution: String::new(),
                source_changed: false,
                origin_reversed: false,
            };
            let payload = encode(&impact)?;
            tx.execute(
                "INSERT INTO coauthor_impacts(id,session_id,version,payload) VALUES (?1,?2,1,?3)",
                rusqlite::params![impact.id.to_string(), scope.session_id.to_string(), payload],
            )?;
            tx.execute(
                "INSERT INTO coauthor_impact_revisions VALUES (?1,1,?2)",
                rusqlite::params![impact.id.to_string(), payload],
            )?;
        }
        changes.status = "COMMITTED".into();
        changes.version += 1;
        changes.selected_ids = selected.into_iter().collect();
        tx.execute(
            "UPDATE coauthor_changesets SET status='COMMITTED',version=?2,payload=?3 WHERE id=?1",
            rusqlite::params![changes.id.to_string(), changes.version, encode(&changes)?],
        )?;
        db.index_coauthor_decision_consumers(&changes)?;
        tx.commit()?;
        Ok(changes)
    }

    pub fn update_coauthor_impact(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
        status: &str,
        resolution: &str,
    ) -> Result<CoauthorImpact, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if ![
            "PENDING",
            "RESOLVED",
            "NOT_APPLICABLE",
            "ACCEPTED_DIFFERENCE",
        ]
        .contains(&status)
            || !valid_label(resolution, 2000)
        {
            return Err(CoauthorError::Invalid(
                "请选择待办状态并填写处理依据。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let payload = tx
            .query_row(
                "SELECT payload FROM coauthor_impacts WHERE id=?1 AND session_id=?2",
                rusqlite::params![id.to_string(), scope.session_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(CoauthorError::NotFound)?;
        let mut impact: CoauthorImpact = decode(payload)?;
        if impact.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        impact.version += 1;
        impact.status = status.into();
        impact.resolution = resolution.into();
        impact.source_changed = false;
        let payload = encode(&impact)?;
        tx.execute(
            "UPDATE coauthor_impacts SET version=?2,payload=?3 WHERE id=?1",
            rusqlite::params![id.to_string(), impact.version, payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_impact_revisions VALUES (?1,?2,?3)",
            rusqlite::params![id.to_string(), impact.version, payload],
        )?;
        tx.commit()?;
        impact.source_changed = db
            .coauthor_source(&impact.evidence.key)?
            .is_none_or(|source| source.revision != impact.evidence.revision);
        impact.origin_reversed = db.coauthor_reversed_by(impact.change_set_id)?.is_some();
        Ok(impact)
    }
}

impl Database {
    pub(super) fn coauthor_draft_has_pending_dependencies(
        &self,
        document: &CoauthorDocument,
    ) -> Result<bool, CoauthorError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_changesets c, json_each(c.payload,'$.items') item
             WHERE c.session_id=?1 AND c.status='PENDING'
             AND json_extract(c.payload,'$.baseDocument.version')=?2
             AND json_extract(item.value,'$.id')='draft'
             AND (json_array_length(item.value,'$.dependsOn')>0
                OR json_type(c.payload,'$.decisionDependencies') IS NULL
                OR json_type(c.payload,'$.decisionDependencies')='null'
                OR EXISTS(SELECT 1 FROM json_each(c.payload,'$.decisionDependencies') dependency,
                    json_each(dependency.value,'$.itemIds') target WHERE target.value='draft')))",
            rusqlite::params![document.session_id.to_string(), document.version],
            |row| row.get(0),
        )?)
    }

    pub(super) fn load_coauthor_changeset(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<CoauthorChangeSet, CoauthorError> {
        let payload = self
            .connection
            .query_row(
                "SELECT payload FROM coauthor_changesets WHERE id=?1 AND session_id=?2",
                rusqlite::params![id.to_string(), scope.session_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(CoauthorError::NotFound)?;
        let mut changes: CoauthorChangeSet = decode(payload)?;
        changes.reversed_by = self.coauthor_reversed_by(id)?;
        self.refresh_coauthor_decision_dependencies(scope, &mut changes)?;
        Ok(changes)
    }

    fn validate_coauthor_impact(
        &self,
        impact: &CoauthorImpactInput,
        items: &[CoauthorChangeItem],
    ) -> Result<(), CoauthorError> {
        if impact.item_ids.is_empty()
            || impact.item_ids.len() > items.len()
            || impact
                .item_ids
                .iter()
                .any(|id| !items.iter().any(|item| &item.id == id))
            || !valid_label(&impact.quote, 2000)
            || !valid_label(&impact.reason, 2000)
            || items
                .iter()
                .any(|item| item.document.target_key.as_ref() == Some(&impact.key))
        {
            return Err(CoauthorError::Invalid(
                "影响待办缺少明确变更、原文证据或复查原因。".into(),
            ));
        }
        let source = self
            .coauthor_source(&impact.key)?
            .ok_or(CoauthorError::NotFound)?;
        if !matches!(source.kind.as_str(), "ENTITY" | "PLAN" | "MANUSCRIPT") {
            return Err(CoauthorError::Invalid(
                "影响待办只能指向正式设定、大纲或正文。".into(),
            ));
        }
        if source.revision != impact.revision {
            return Err(CoauthorError::Conflict);
        }
        if !source.content.contains(&impact.quote) {
            return Err(CoauthorError::Invalid(
                "影响原文无法定位，不能创建没有依据的待办。".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn migrate_coauthor_changes(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_changesets (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                version INTEGER NOT NULL CHECK(version>0), title TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('PENDING','COMMITTED','DISCARDED')),
                item_count INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
            );
            CREATE INDEX coauthor_changesets_session ON coauthor_changesets(session_id);
            CREATE TABLE coauthor_impacts (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                version INTEGER NOT NULL CHECK(version>0), payload TEXT NOT NULL CHECK(json_valid(payload))
            );
            CREATE INDEX coauthor_impacts_session ON coauthor_impacts(session_id);
            CREATE TABLE coauthor_impact_revisions (
                impact_id TEXT NOT NULL REFERENCES coauthor_impacts(id), version INTEGER NOT NULL,
                payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(impact_id,version)
            );
            INSERT INTO schema_migrations(version,name) VALUES (53,'coauthor_changesets');",
        )?;
        tx.commit()?;
        Ok(())
    }
}
