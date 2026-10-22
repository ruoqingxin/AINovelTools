use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorRunSummary {
    pub id: Uuid,
    pub session_id: Uuid,
    pub user_message_id: Uuid,
    pub status: String,
    pub document_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorRunsPage {
    pub runs: Vec<CoauthorRunSummary>,
    pub has_more: bool,
}

impl ProjectManager {
    pub fn coauthor_document(
        &self,
        scope: &CoauthorScope,
    ) -> Result<CoauthorDocument, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .coauthor_document(scope.session_id)
    }

    pub fn coauthor_run(
        &self,
        scope: &CoauthorScope,
        id: Uuid,
    ) -> Result<CoauthorRun, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .coauthor_run(scope.session_id, id)
    }

    pub fn coauthor_running_ids(&self, scope: &CoauthorScope) -> Result<Vec<Uuid>, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let mut stmt = db
            .connection
            .prepare("SELECT id FROM coauthor_runs WHERE session_id=?1 AND status='RUNNING'")?;
        stmt.query_map([scope.session_id.to_string()], |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| row?.parse().map_err(|_| CoauthorError::NotFound))
        .collect()
    }

    pub fn list_coauthor_runs(
        &self,
        scope: &CoauthorScope,
        before_run_id: Option<Uuid>,
    ) -> Result<CoauthorRunsPage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let before = before_run_id
            .map(|id| {
                db.connection
                    .query_row(
                        "SELECT rowid FROM coauthor_runs WHERE session_id=?1 AND id=?2",
                        rusqlite::params![scope.session_id.to_string(), id.to_string()],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .ok_or(CoauthorError::NotFound)
            })
            .transpose()?;
        let sql = if before.is_some() {
            "SELECT id,user_message_id,status,document_version FROM coauthor_runs
             WHERE session_id=?1 AND rowid<?2 ORDER BY rowid DESC LIMIT 21"
        } else {
            "SELECT id,user_message_id,status,document_version FROM coauthor_runs
             WHERE session_id=?1 AND ?2 IS NULL ORDER BY rowid DESC LIMIT 21"
        };
        let mut stmt = db.connection.prepare(sql)?;
        let mut runs = stmt
            .query_map(
                rusqlite::params![scope.session_id.to_string(), before],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                },
            )?
            .map(|row| {
                let (id, message, status, document_version) = row?;
                Ok(CoauthorRunSummary {
                    id: id.parse().map_err(|_| CoauthorError::NotFound)?,
                    session_id: scope.session_id,
                    user_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
                    status,
                    document_version,
                })
            })
            .collect::<Result<Vec<_>, CoauthorError>>()?;
        let has_more = runs.len() > 20;
        runs.truncate(20);
        Ok(CoauthorRunsPage { runs, has_more })
    }
}

impl Database {
    fn coauthor_run(&self, session: Uuid, id: Uuid) -> Result<CoauthorRun, CoauthorError> {
        let (message, status, document_version, output, audit): (String, String, i64, String, String) =
            self.connection.query_row(
                "SELECT user_message_id,status,document_version,output,audit FROM coauthor_runs WHERE session_id=?1 AND id=?2",
                rusqlite::params![session.to_string(), id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ).optional()?.ok_or(CoauthorError::NotFound)?;
        Ok(CoauthorRun {
            id,
            session_id: session,
            user_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
            status,
            document_version,
            output,
            audit: decode(audit)?,
        })
    }
}

#[cfg(test)]
mod tests;
