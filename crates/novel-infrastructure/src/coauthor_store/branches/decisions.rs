use super::*;

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorBranchDecisionInput {
    pub source_session_id: Uuid,
    pub source_decision_id: Uuid,
    pub source_version: i64,
    pub target_decision_id: Option<Uuid>,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchDecisionAdoption {
    pub id: Uuid,
    pub status: String,
    pub branch: CoauthorBranchEntry,
    pub source: CoauthorDecisionMemory,
    pub before: Option<CoauthorDecisionMemory>,
    pub after: CoauthorDecisionMemory,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchDecisionSummary {
    pub id: Uuid,
    pub status: String,
    pub source_title: String,
    pub topic: String,
    pub decision_status: String,
    pub source_version: i64,
    pub after_version: i64,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchDecisionAdoptionsPage {
    pub adoptions: Vec<CoauthorBranchDecisionSummary>,
    pub has_more: bool,
}

impl Database {
    pub(crate) fn migrate_coauthor_branch_decisions(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_branch_decision_adoptions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                source_session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                payload TEXT NOT NULL CHECK(json_valid(payload))
             );
             CREATE INDEX coauthor_branch_decision_adoptions_session
                ON coauthor_branch_decision_adoptions(session_id);
             INSERT INTO schema_migrations(version,name) VALUES(64,'coauthor_branch_decisions');",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn branch_decision_adoption(
        &self, session: Uuid, id: Uuid,
    ) -> Result<CoauthorBranchDecisionAdoption, CoauthorError> {
        decode(self.connection.query_row(
            "SELECT payload FROM coauthor_branch_decision_adoptions WHERE session_id=?1 AND id=?2",
            rusqlite::params![session.to_string(),id.to_string()], |row| row.get(0),
        ).optional()?.ok_or(CoauthorError::NotFound)?)
    }

    fn check_branch_decision_aliases(
        &self, session: Uuid, before: Option<&CoauthorDecisionMemory>, after: &CoauthorDecisionMemory,
    ) -> Result<(), CoauthorError> {
        // Updating an existing decision keeps its aliases, including legacy ambiguity.
        if before.is_some() { return Ok(()); }
        for alias in &after.aliases {
            let key = super::super::decisions::topic_key(alias);
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key=?2)",
                rusqlite::params![session.to_string(),key], |row|row.get(0),
            )?;
            if exists {
                return Err(CoauthorError::Invalid("来源主题或别名已关联当前决定；请明确选择要更新的决定，不另建同名记录。".into()));
            }
        }
        Ok(())
    }
}

impl ProjectManager {
    fn validate_coauthor_decision_branch(
        &self, scope: &CoauthorScope, source: Uuid,
    ) -> Result<CoauthorBranchEntry, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.validate_coauthor_scope(&CoauthorScope { session_id:source,..scope.clone() })?;
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let (_,_,relationship) = db.branch_pair(scope.session_id,source)?;
        Ok(CoauthorBranchEntry {
            session_id:source, relationship, title:self.get_discussion_session(source)?.title,
        })
    }

    fn require_idle_decision_branches(
        &self, scope: &CoauthorScope, source: Uuid,
    ) -> Result<(), CoauthorError> {
        if !self.coauthor_running_ids(scope)?.is_empty()
            || !self.coauthor_running_ids(&CoauthorScope { session_id:source,..scope.clone() })?.is_empty()
        { return Err(CoauthorError::Conflict); }
        Ok(())
    }

    pub fn list_coauthor_branch_decisions(
        &self, scope: &CoauthorScope, source_session_id: Uuid, query: &str, offset: u32,
    ) -> Result<CoauthorDecisionsPage, CoauthorError> {
        self.validate_coauthor_decision_branch(scope,source_session_id)?;
        self.search_coauthor_decisions(&CoauthorScope { session_id:source_session_id,..scope.clone() },query,offset)
    }

    pub fn prepare_coauthor_branch_decision(
        &mut self, scope: &CoauthorScope, input: CoauthorBranchDecisionInput,
    ) -> Result<CoauthorBranchDecisionAdoption, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = rusqlite::Transaction::new_unchecked(&db.connection,rusqlite::TransactionBehavior::Immediate)?;
        let branch = self.validate_coauthor_decision_branch(scope,input.source_session_id)?;
        self.require_idle_decision_branches(scope,input.source_session_id)?;
        let source = db.decision_memory(input.source_session_id,input.source_decision_id)?;
        let before = input.target_decision_id.map(|id|db.decision_memory(scope.session_id,id)).transpose()?;
        if source.decision.version!=input.source_version
            || before.as_ref().map_or(0,|m|m.decision.version)!=input.expected_version
        { return Err(CoauthorError::Conflict); }
        if before.as_ref().is_some_and(|m|m.decision.content==source.decision.content && m.decision.status==source.decision.status) {
            return Err(CoauthorError::Invalid("两条决定的内容和状态一致，无需重复采用。".into()));
        }
        let after = CoauthorDecisionMemory {
            decision: CoauthorDecision {
                id:before.as_ref().map_or_else(Uuid::new_v4,|m|m.decision.id),
                topic:before.as_ref().map_or_else(||source.decision.topic.clone(),|m|m.decision.topic.clone()),
                content:source.decision.content.clone(), status:source.decision.status.clone(),
                source_message_id:Uuid::new_v4(),
                version:input.expected_version.checked_add(1).ok_or(CoauthorError::Conflict)?,
            },
            aliases:before.as_ref().unwrap_or(&source).aliases.clone(),
            quote:Some(source.decision.content.clone()),
        };
        db.check_branch_decision_aliases(scope.session_id,before.as_ref(),&after)?;
        let adoption = CoauthorBranchDecisionAdoption {
            id:Uuid::new_v4(),status:"PENDING".into(),branch,source,before,after,
        };
        tx.execute(
            "INSERT INTO coauthor_branch_decision_adoptions VALUES(?1,?2,?3,?4)",
            rusqlite::params![adoption.id.to_string(),scope.session_id.to_string(),input.source_session_id.to_string(),encode(&adoption)?],
        )?;
        tx.commit()?;
        Ok(adoption)
    }

    pub fn get_coauthor_branch_decision(
        &self, scope: &CoauthorScope, id: Uuid,
    ) -> Result<CoauthorBranchDecisionAdoption, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database.branch_decision_adoption(scope.session_id,id)
    }

    pub fn list_coauthor_branch_decision_adoptions(
        &self, scope: &CoauthorScope, offset: u32,
    ) -> Result<CoauthorBranchDecisionAdoptionsPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let mut stmt = db.connection.prepare(
            "SELECT id,json_extract(payload,'$.status'),json_extract(payload,'$.branch.title'),
                json_extract(payload,'$.after.decision.topic'),json_extract(payload,'$.after.decision.status'),
                json_extract(payload,'$.source.decision.version'),json_extract(payload,'$.after.decision.version')
             FROM coauthor_branch_decision_adoptions WHERE session_id=?1 ORDER BY rowid DESC LIMIT 11 OFFSET ?2",
        )?;
        let mut adoptions = stmt.query_map(rusqlite::params![scope.session_id.to_string(),offset],|row| {
            Ok(CoauthorBranchDecisionSummary {
                id:super::super::super::manuscript_source_store::row_uuid(row,0)?,
                status:row.get(1)?,source_title:row.get(2)?,topic:row.get(3)?,decision_status:row.get(4)?,
                source_version:row.get(5)?,after_version:row.get(6)?,
            })
        })?.collect::<Result<Vec<_>,_>>()?;
        let has_more = adoptions.len()>10;
        adoptions.truncate(10);
        Ok(CoauthorBranchDecisionAdoptionsPage { adoptions,has_more })
    }

    pub fn apply_coauthor_branch_decision(
        &mut self, scope: &CoauthorScope, id: Uuid,
    ) -> Result<CoauthorBranchDecisionAdoption, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = rusqlite::Transaction::new_unchecked(&db.connection,rusqlite::TransactionBehavior::Immediate)?;
        self.validate_coauthor_scope(scope)?;
        let mut adoption = db.branch_decision_adoption(scope.session_id,id)?;
        if adoption.status=="APPLIED" { return Ok(adoption); }
        self.validate_coauthor_decision_branch(scope,adoption.branch.session_id)?;
        self.require_idle_decision_branches(scope,adoption.branch.session_id)?;
        if db.decision_memory(adoption.branch.session_id,adoption.source.decision.id)?!=adoption.source {
            return Err(CoauthorError::Conflict);
        }
        if let Some(before) = &adoption.before
            && db.decision_memory(scope.session_id,before.decision.id)?!=*before
        { return Err(CoauthorError::Conflict); }
        db.check_branch_decision_aliases(scope.session_id,adoption.before.as_ref(),&adoption.after)?;
        let decision = &adoption.after.decision;
        tx.execute(
            "INSERT INTO discussion_messages(id,session_id,role,content) VALUES(?1,?2,'USER',?3)",
            rusqlite::params![decision.source_message_id.to_string(),scope.session_id.to_string(),
                format!("作者确认采用分支「{}」决定「{}」v{}，{}当前决定「{}」：{} [{}]；未修改正式资料或工作稿。",
                    adoption.branch.title,adoption.source.decision.topic,adoption.source.decision.version,
                    if adoption.before.is_some() {"更新"} else {"新建"},decision.topic,decision.content,decision.status)],
        )?;
        db.write_decision(scope.session_id,decision,&decision.content,&adoption.after.aliases)?;
        adoption.status="APPLIED".into();
        tx.execute("UPDATE coauthor_branch_decision_adoptions SET payload=?2 WHERE id=?1",
            rusqlite::params![id.to_string(),encode(&adoption)?])?;
        tx.commit()?;
        Ok(adoption)
    }
}

#[cfg(test)]
mod tests;
