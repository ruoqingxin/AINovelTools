use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchEntry {
    pub session_id: Uuid,
    pub title: String,
    pub relationship: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchesPage {
    pub branches: Vec<CoauthorBranchEntry>,
    pub has_more: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchComparison {
    pub branch: CoauthorBranchEntry,
    pub base_document: CoauthorDocument,
    pub current_document: CoauthorDocument,
    pub source_document: CoauthorDocument,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorBranchMergeInput {
    pub source_session_id: Uuid,
    pub expected_version: i64,
    pub source_version: i64,
    pub source_start: usize,
    pub source_end: usize,
    pub target_start: usize,
    pub target_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchMerge {
    pub id: Uuid,
    pub status: String,
    pub branch: CoauthorBranchEntry,
    pub before: CoauthorDocument,
    pub source: CoauthorDocument,
    pub after: CoauthorDocument,
    pub source_start: usize,
    pub source_end: usize,
    pub target_start: usize,
    pub target_end: usize,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchMergeSummary {
    pub id: Uuid,
    pub status: String,
    pub source_title: String,
    pub before_version: i64,
    pub source_version: i64,
    pub after_version: i64,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorBranchMergesPage {
    pub merges: Vec<CoauthorBranchMergeSummary>,
    pub has_more: bool,
}

impl Database {
    pub(crate) fn migrate_coauthor_branch_merges(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_branch_merges (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                source_session_id TEXT NOT NULL REFERENCES discussion_sessions(id),
                payload TEXT NOT NULL CHECK(json_valid(payload))
             );
             CREATE INDEX coauthor_branch_merges_session ON coauthor_branch_merges(session_id);
             INSERT INTO schema_migrations(version,name) VALUES(63,'coauthor_branch_merges');",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn branch_pair(&self, session: Uuid, other: Uuid) -> Result<(Uuid, i64, String), CoauthorError> {
        self.connection.query_row(
            "SELECT parent_session_id,parent_document_version,
                CASE WHEN session_id=?1 THEN 'PARENT' ELSE 'CHILD' END
             FROM coauthor_branches
             WHERE (session_id=?1 AND parent_session_id=?2)
                OR (session_id=?2 AND parent_session_id=?1)",
            rusqlite::params![session.to_string(),other.to_string()],
            |row| Ok((super::super::manuscript_source_store::row_uuid(row,0)?,row.get(1)?,row.get(2)?)),
        ).optional()?.ok_or(CoauthorError::NotFound)
    }

    fn branch_merge(&self, session: Uuid, id: Uuid) -> Result<CoauthorBranchMerge, CoauthorError> {
        decode(self.connection.query_row(
            "SELECT payload FROM coauthor_branch_merges WHERE session_id=?1 AND id=?2",
            rusqlite::params![session.to_string(),id.to_string()], |row| row.get(0),
        ).optional()?.ok_or(CoauthorError::NotFound)?)
    }
}

impl ProjectManager {
    pub fn list_coauthor_branches(
        &self, scope: &CoauthorScope, offset: u32,
    ) -> Result<CoauthorBranchesPage, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot = db.connection.unchecked_transaction()?;
        self.validate_coauthor_scope(scope)?;
        let mut stmt = db.connection.prepare(
            "SELECT s.id,s.title,CASE WHEN b.session_id=?1 THEN 'PARENT' ELSE 'CHILD' END
             FROM coauthor_branches b JOIN discussion_sessions s ON
                s.id=CASE WHEN b.session_id=?1 THEN b.parent_session_id ELSE b.session_id END
             WHERE (b.session_id=?1 OR b.parent_session_id=?1) AND s.project_id=?2
             ORDER BY s.rowid DESC LIMIT 21 OFFSET ?3",
        )?;
        let mut branches = stmt.query_map(
            rusqlite::params![scope.session_id.to_string(),scope.project_id.to_string(),offset],
            |row| Ok(CoauthorBranchEntry {
                session_id: super::super::manuscript_source_store::row_uuid(row,0)?,
                title: row.get(1)?, relationship: row.get(2)?,
            }),
        )?.collect::<Result<Vec<_>,_>>()?;
        let has_more = branches.len()>20;
        branches.truncate(20);
        Ok(CoauthorBranchesPage { branches,has_more })
    }

    fn load_coauthor_branch_comparison(
        &self, scope: &CoauthorScope, source_session_id: Uuid,
    ) -> Result<CoauthorBranchComparison, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let source_scope = CoauthorScope { session_id:source_session_id,..scope.clone() };
        self.validate_coauthor_scope(&source_scope)?;
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let (parent,version,relationship) = db.branch_pair(scope.session_id,source_session_id)?;
        let base_document = if version==0 {
            CoauthorDocument::empty(parent)
        } else {
            decode(db.connection.query_row(
                "SELECT payload FROM coauthor_document_revisions WHERE session_id=?1 AND version=?2",
                rusqlite::params![parent.to_string(),version], |row|row.get(0),
            ).optional()?.ok_or(CoauthorError::NotFound)?)?
        };
        Ok(CoauthorBranchComparison {
            branch: CoauthorBranchEntry {
                session_id:source_session_id,title:self.get_discussion_session(source_session_id)?.title,relationship,
            },
            base_document,
            current_document:db.coauthor_document(scope.session_id)?,
            source_document:db.coauthor_document(source_session_id)?,
        })
    }

    pub fn compare_coauthor_branch(
        &self, scope: &CoauthorScope, source_session_id: Uuid,
    ) -> Result<CoauthorBranchComparison, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot = db.connection.unchecked_transaction()?;
        self.load_coauthor_branch_comparison(scope,source_session_id)
    }

    pub fn prepare_coauthor_branch_merge(
        &mut self, scope: &CoauthorScope, input: CoauthorBranchMergeInput,
    ) -> Result<CoauthorBranchMerge, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = rusqlite::Transaction::new_unchecked(&db.connection,rusqlite::TransactionBehavior::Immediate)?;
        let comparison = self.load_coauthor_branch_comparison(scope,input.source_session_id)?;
        let before = comparison.current_document;
        let source = comparison.source_document;
        if before.version!=input.expected_version || source.version!=input.source_version
            || !self.coauthor_running_ids(scope)?.is_empty()
            || !self.coauthor_running_ids(&CoauthorScope { session_id:source.session_id,..scope.clone() })?.is_empty()
        {
            return Err(CoauthorError::Conflict);
        }
        if before.kind!=source.kind || input.source_start>=input.source_end
            || input.source_end>source.content.chars().count() || input.target_start>input.target_end
            || input.target_end>before.content.chars().count()
        {
            return Err(CoauthorError::Invalid("仅合并同类工作稿的准确非空来源范围；目标范围须位于当前稿内。".into()));
        }
        let content = before.content.chars().take(input.target_start)
            .chain(source.content.chars().skip(input.source_start).take(input.source_end-input.source_start))
            .chain(before.content.chars().skip(input.target_end)).collect::<String>();
        if content.chars().count()>500_000 || content==before.content {
            return Err(CoauthorError::Invalid("合并后工作稿过长或没有实际变化；原稿未改动。".into()));
        }
        let after = CoauthorDocument {
            content,version:before.version.checked_add(1).ok_or(CoauthorError::Conflict)?,..before.clone()
        };
        let merge = CoauthorBranchMerge {
            id:Uuid::new_v4(),status:"PENDING".into(),branch:comparison.branch,before,source,after,
            source_start:input.source_start,source_end:input.source_end,target_start:input.target_start,target_end:input.target_end,
        };
        tx.execute(
            "INSERT INTO coauthor_branch_merges VALUES(?1,?2,?3,?4)",
            rusqlite::params![merge.id.to_string(),scope.session_id.to_string(),merge.source.session_id.to_string(),encode(&merge)?],
        )?;
        tx.commit()?;
        Ok(merge)
    }

    pub fn get_coauthor_branch_merge(
        &self, scope: &CoauthorScope, id: Uuid,
    ) -> Result<CoauthorBranchMerge, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database.branch_merge(scope.session_id,id)
    }

    pub fn list_coauthor_branch_merges(
        &self, scope: &CoauthorScope, offset: u32,
    ) -> Result<CoauthorBranchMergesPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let mut stmt = db.connection.prepare(
            "SELECT id,json_extract(payload,'$.status'),json_extract(payload,'$.branch.title'),
                json_extract(payload,'$.before.version'),json_extract(payload,'$.source.version'),
                json_extract(payload,'$.after.version')
             FROM coauthor_branch_merges WHERE session_id=?1 ORDER BY rowid DESC LIMIT 11 OFFSET ?2",
        )?;
        let mut merges = stmt.query_map(rusqlite::params![scope.session_id.to_string(),offset],|row| {
            Ok(CoauthorBranchMergeSummary {
                id:super::super::manuscript_source_store::row_uuid(row,0)?,
                status:row.get(1)?,source_title:row.get(2)?,before_version:row.get(3)?,
                source_version:row.get(4)?,after_version:row.get(5)?,
            })
        })?.collect::<Result<Vec<_>,_>>()?;
        let has_more = merges.len()>10;
        merges.truncate(10);
        Ok(CoauthorBranchMergesPage { merges,has_more })
    }

    pub fn apply_coauthor_branch_merge(
        &mut self, scope: &CoauthorScope, id: Uuid,
    ) -> Result<CoauthorBranchMerge, CoauthorError> {
        let db = &self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let tx = rusqlite::Transaction::new_unchecked(&db.connection,rusqlite::TransactionBehavior::Immediate)?;
        self.validate_coauthor_scope(scope)?;
        let mut merge = db.branch_merge(scope.session_id,id)?;
        if merge.status=="APPLIED" { return Ok(merge); }
        let comparison = self.load_coauthor_branch_comparison(scope,merge.source.session_id)?;
        if comparison.current_document!=merge.before || comparison.source_document!=merge.source
            || !self.coauthor_running_ids(scope)?.is_empty()
            || !self.coauthor_running_ids(&CoauthorScope { session_id:merge.source.session_id,..scope.clone() })?.is_empty()
        {
            return Err(CoauthorError::Conflict);
        }
        let payload = encode(&merge.after)?;
        tx.execute(
            "INSERT INTO coauthor_documents VALUES(?1,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,payload=excluded.payload",
            rusqlite::params![scope.session_id.to_string(),merge.after.version,payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_document_revisions VALUES(?1,?2,?3)",
            rusqlite::params![scope.session_id.to_string(),merge.after.version,payload],
        )?;
        merge.status = "APPLIED".into();
        tx.execute("UPDATE coauthor_branch_merges SET payload=?2 WHERE id=?1",
            rusqlite::params![id.to_string(),encode(&merge)?])?;
        tx.commit()?;
        Ok(merge)
    }
}

#[cfg(test)]
mod tests;
