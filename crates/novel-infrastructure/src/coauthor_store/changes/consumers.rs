use super::*;

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionConsumer {
    pub change_set_id: Uuid,
    pub change_set_version: i64,
    pub change_set_title: String,
    pub item_id: String,
    pub item_title: String,
    pub kind: CoauthorDocumentKind,
    pub decision_version: i64,
    pub state: String,
    pub needs_review: bool,
    pub published_key: Option<String>,
    pub published_revision: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecisionConsumersPage {
    pub decision: CoauthorDecision,
    pub entries: Vec<CoauthorDecisionConsumer>,
    pub unknown_change_sets: u32,
    pub offset: u32,
    pub has_more: bool,
}

impl Database {
    pub(crate) fn migrate_coauthor_decision_consumers(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE coauthor_changeset_dependency_coverage (
                change_set_id TEXT PRIMARY KEY REFERENCES coauthor_changesets(id),
                known INTEGER NOT NULL CHECK(known IN (0,1))
             );
             CREATE TABLE coauthor_decision_consumers (
                change_set_id TEXT NOT NULL REFERENCES coauthor_changesets(id),
                decision_id TEXT NOT NULL REFERENCES coauthor_decisions(id),
                decision_version INTEGER NOT NULL CHECK(decision_version>0),
                item_id TEXT NOT NULL, item_title TEXT NOT NULL, item_kind TEXT NOT NULL,
                published_key TEXT, published_revision TEXT,
                PRIMARY KEY(change_set_id,decision_id,item_id),
                CHECK((published_key IS NULL)=(published_revision IS NULL))
             );
             CREATE INDEX coauthor_decision_consumers_lookup
                ON coauthor_decision_consumers(decision_id,decision_version,change_set_id,item_id);",
        )?;
        let mut stmt = tx.prepare("SELECT payload FROM coauthor_changesets ORDER BY rowid")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let payload: String = row.get(0)?;
            let changes: CoauthorChangeSet = serde_json::from_str(&payload).map_err(|error|
                rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,Box::new(error)))?;
            self.index_coauthor_decision_consumers(&changes)?;
        }
        drop(rows);
        drop(stmt);
        tx.execute("INSERT INTO schema_migrations(version,name) VALUES(65,'coauthor_decision_consumers')",[])?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn index_coauthor_decision_consumers(&self, changes: &CoauthorChangeSet) -> Result<(), rusqlite::Error> {
        self.connection.execute(
            "INSERT INTO coauthor_changeset_dependency_coverage VALUES(?1,?2)
             ON CONFLICT(change_set_id) DO UPDATE SET known=excluded.known",
            rusqlite::params![changes.id.to_string(),changes.decision_dependencies.is_some()],
        )?;
        self.connection.execute("DELETE FROM coauthor_decision_consumers WHERE change_set_id=?1",[changes.id.to_string()])?;
        for dependency in changes.decision_dependencies.iter().flatten() {
            let local: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM coauthor_decisions d JOIN coauthor_changesets c ON c.session_id=d.session_id
                 WHERE d.id=?1 AND c.id=?2)",
                rusqlite::params![dependency.decision.id.to_string(),changes.id.to_string()],|row|row.get(0),
            )?;
            if !local { return Err(rusqlite::Error::InvalidQuery); }
            for id in &dependency.item_ids {
                let item=changes.items.iter().find(|item|&item.id==id).ok_or(rusqlite::Error::InvalidQuery)?;
                let published=changes.published.iter().find(|entry|&entry.item_id==id);
                self.connection.execute(
                    "INSERT INTO coauthor_decision_consumers VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    rusqlite::params![changes.id.to_string(),dependency.decision.id.to_string(),dependency.decision.version,
                        id,item.document.title,match item.document.kind {
                            CoauthorDocumentKind::Unclassified=>return Err(rusqlite::Error::InvalidQuery),
                            CoauthorDocumentKind::Setting=>"SETTING",CoauthorDocumentKind::Outline=>"OUTLINE",CoauthorDocumentKind::Manuscript=>"MANUSCRIPT",
                        },published.map(|entry|&entry.source_key),published.map(|entry|&entry.revision)],
                )?;
            }
        }
        Ok(())
    }
}

impl ProjectManager {
    pub fn coauthor_decision_consumers(
        &self, scope: &CoauthorScope, decision_id: Uuid, needs_review_only: bool, offset: u32,
    ) -> Result<CoauthorDecisionConsumersPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db=&self.current.as_ref().ok_or(CoauthorError::WrongProject)?.database;
        let _snapshot=db.connection.unchecked_transaction()?;
        let decision=db.decision(scope.session_id,decision_id)?;
        let mut stmt=db.connection.prepare(
            "SELECT c.id,c.version,c.title,x.item_id,x.item_title,x.item_kind,x.decision_version,
                CASE WHEN c.status='DISCARDED' THEN 'DISCARDED'
                     WHEN c.status='PENDING' THEN 'PENDING'
                     WHEN x.published_key IS NULL THEN 'NOT_ADOPTED'
                     WHEN r.id IS NOT NULL THEN 'REVERSED' ELSE 'ADOPTED' END,
                x.published_key,x.published_revision
             FROM coauthor_decision_consumers x JOIN coauthor_changesets c ON c.id=x.change_set_id
             LEFT JOIN coauthor_reversals r ON r.change_set_id=c.id AND r.status='COMMITTED'
             WHERE c.session_id=?1 AND x.decision_id=?2
               AND (?3=0 OR (x.decision_version<>?4 AND r.id IS NULL
                    AND (c.status='PENDING' OR (c.status='COMMITTED' AND x.published_key IS NOT NULL))))
             ORDER BY c.rowid DESC,x.item_id LIMIT 17 OFFSET ?5",
        )?;
        let mut entries=stmt.query_map(
            rusqlite::params![scope.session_id.to_string(),decision_id.to_string(),needs_review_only,decision.version,offset],
            |row| {
                let version: i64=row.get(6)?;
                let state: String=row.get(7)?;
                Ok(CoauthorDecisionConsumer {
                    change_set_id:row.get::<_,String>(0)?.parse().map_err(|_|rusqlite::Error::InvalidQuery)?,
                    change_set_version:row.get(1)?,change_set_title:row.get(2)?,item_id:row.get(3)?,item_title:row.get(4)?,
                    kind:match row.get::<_,String>(5)?.as_str() {
                        "SETTING"=>CoauthorDocumentKind::Setting,"OUTLINE"=>CoauthorDocumentKind::Outline,
                        "MANUSCRIPT"=>CoauthorDocumentKind::Manuscript,_=>return Err(rusqlite::Error::InvalidQuery),
                    },
                    decision_version:version,needs_review:version!=decision.version && ["PENDING","ADOPTED"].contains(&state.as_str()),
                    state,published_key:row.get(8)?,published_revision:row.get(9)?,
                })
            },
        )?.collect::<Result<Vec<_>,_>>()?;
        let has_more=entries.len()>16;
        entries.truncate(16);
        let unknown_change_sets=db.connection.query_row(
            "SELECT COUNT(*) FROM coauthor_changesets c
             LEFT JOIN coauthor_changeset_dependency_coverage coverage ON coverage.change_set_id=c.id
             WHERE c.session_id=?1 AND c.status IN ('PENDING','COMMITTED') AND COALESCE(coverage.known,0)=0
               AND NOT EXISTS(SELECT 1 FROM coauthor_reversals r WHERE r.change_set_id=c.id AND r.status='COMMITTED')",
            [scope.session_id.to_string()],|row|row.get(0),
        )?;
        Ok(CoauthorDecisionConsumersPage {decision,entries,unknown_change_sets,offset,has_more})
    }
}

#[cfg(test)]
mod tests;
