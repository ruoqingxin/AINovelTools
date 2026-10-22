use super::*;
use serde_json::Value;

mod publication;
mod changes;
pub use changes::*;
mod manuscript;
pub use manuscript::*;
mod outline;
pub use outline::*;
mod reversal;
pub use reversal::*;
mod reversal_targets;
mod schema;
mod sources;
pub use sources::{CoauthorSearchPage, CoauthorSource};
#[cfg(test)]
mod tests;
#[cfg(test)]
mod changes_tests;

#[derive(Debug, Error)]
pub enum CoauthorError {
    #[error("当前项目与共创目标不一致。")]
    WrongProject,
    #[error("共创目标不存在或已归档。")]
    NotFound,
    #[error("稿件、决定或运行状态已经变化，结果已保留，请重新核对。")]
    Conflict,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Database(#[from] DatabaseError),
    #[error(transparent)]
    Discussion(#[from] DiscussionStoreError),
}

#[derive(
    Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema,
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoauthorDocumentKind {
    #[default]
    Setting,
    Outline,
    Manuscript,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorScope {
    pub project_id: Uuid,
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorDocument {
    pub session_id: Uuid,
    pub version: i64,
    pub kind: CoauthorDocumentKind,
    pub title: String,
    pub content: String,
    pub target_key: Option<String>,
    pub target_revision: Option<String>,
    pub narrative_position: String,
}

impl CoauthorDocument {
    fn empty(session_id: Uuid) -> Self {
        Self {
            session_id,
            version: 0,
            kind: CoauthorDocumentKind::Setting,
            title: "未命名设定".into(),
            content: String::new(),
            target_key: None,
            target_revision: None,
            narrative_position: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorDecision {
    pub id: Uuid,
    pub topic: String,
    pub content: String,
    pub status: String,
    pub source_message_id: Uuid,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorRun {
    pub id: Uuid,
    pub session_id: Uuid,
    pub user_message_id: Uuid,
    pub status: String,
    pub document_version: i64,
    pub output: String,
    pub audit: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorState {
    pub document: CoauthorDocument,
    pub decisions: Vec<CoauthorDecision>,
    pub runs: Vec<CoauthorRun>,
}

pub(crate) fn decode<T: serde::de::DeserializeOwned>(json: String) -> Result<T, CoauthorError> {
    serde_json::from_str(&json)
        .map_err(|_| CoauthorError::Invalid("共创记录格式无效，原记录未改动。".into()))
}

pub(crate) fn encode<T: Serialize>(value: &T) -> Result<String, CoauthorError> {
    serde_json::to_string(value).map_err(|_| CoauthorError::Invalid("共创内容无法序列化。".into()))
}

impl ProjectManager {
    pub fn validate_coauthor_scope(&self, scope: &CoauthorScope) -> Result<(), CoauthorError> {
        let project = self.current.as_ref().ok_or(CoauthorError::WrongProject)?;
        if project.manifest.project_id != scope.project_id {
            return Err(CoauthorError::WrongProject);
        }
        if self.get_discussion_session(scope.session_id)?.project_id != scope.project_id {
            return Err(CoauthorError::WrongProject);
        }
        Ok(())
    }

    pub fn coauthor_state(&self, scope: &CoauthorScope) -> Result<CoauthorState, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let document = db.coauthor_document(scope.session_id)?;
        let mut statement = db.connection.prepare(
            "SELECT id, topic, content, status, source_message_id, version FROM coauthor_decisions
             WHERE session_id=?1 ORDER BY rowid",
        )?;
        let decisions = statement
            .query_map([scope.session_id.to_string()], |row| {
                Ok(CoauthorDecision {
                    id: row
                        .get::<_, String>(0)?
                        .parse()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    topic: row.get(1)?,
                    content: row.get(2)?,
                    status: row.get(3)?,
                    source_message_id: row
                        .get::<_, String>(4)?
                        .parse()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    version: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = db.connection.prepare(
            "SELECT id, user_message_id, status, document_version, output, audit
             FROM coauthor_runs WHERE session_id=?1 ORDER BY rowid DESC LIMIT 20",
        )?;
        let runs = statement
            .query_map([scope.session_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .map(|row| {
                let (id, message, status, version, output, audit) = row?;
                Ok(CoauthorRun {
                    id: id.parse().map_err(|_| CoauthorError::NotFound)?,
                    session_id: scope.session_id,
                    user_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
                    status,
                    document_version: version,
                    output,
                    audit: decode(audit)?,
                })
            })
            .collect::<Result<Vec<_>, CoauthorError>>()?;
        Ok(CoauthorState {
            document,
            decisions,
            runs,
        })
    }

    pub fn save_coauthor_document(
        &mut self,
        scope: &CoauthorScope,
        document: CoauthorDocument,
    ) -> Result<CoauthorDocument, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if document.session_id != scope.session_id
            || document.title.trim().is_empty()
            || document.title.chars().count() > 200
            || document.content.chars().count() > 500_000
            || document.narrative_position.chars().count() > 4_000
        {
            return Err(CoauthorError::Invalid(
                "稿件目标或长度无效，内容未被截断。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let current = db.coauthor_document(scope.session_id)?;
        if current
            == (CoauthorDocument {
                version: current.version,
                ..document.clone()
            })
        {
            return Ok(current);
        }
        if current.version != document.version {
            return Err(CoauthorError::Conflict);
        }
        if document.target_key != current.target_key
            || document.target_revision != current.target_revision
        {
            if let Some(key) = &document.target_key {
                let source = db.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
                if Some(&source.revision) != document.target_revision.as_ref()
                    || !matches!(
                        (document.kind, source.kind.as_str()),
                        (CoauthorDocumentKind::Setting, "ENTITY")
                            | (CoauthorDocumentKind::Outline, "PLAN")
                            | (CoauthorDocumentKind::Manuscript, "MANUSCRIPT")
                    )
                {
                    return Err(CoauthorError::Conflict);
                }
            } else if document.target_revision.is_some() {
                return Err(CoauthorError::Invalid(
                    "未关联资料不能携带来源修订。".into(),
                ));
            }
        }
        let saved = CoauthorDocument {
            version: current.version + 1,
            ..document
        };
        let payload = encode(&saved)?;
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO coauthor_documents VALUES (?1,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,payload=excluded.payload",
            rusqlite::params![scope.session_id.to_string(), saved.version, payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_document_revisions VALUES (?1,?2,?3)",
            rusqlite::params![scope.session_id.to_string(), saved.version, payload],
        )?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn coauthor_document_history(
        &self,
        scope: &CoauthorScope,
        before_version: Option<i64>,
    ) -> Result<Vec<CoauthorDocument>, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let mut stmt = db.connection.prepare(
            "SELECT payload FROM coauthor_document_revisions
             WHERE session_id=?1 AND (?2 IS NULL OR version<?2) ORDER BY version DESC LIMIT 50",
        )?;
        stmt.query_map(
            rusqlite::params![scope.session_id.to_string(), before_version],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| decode(row?))
        .collect()
    }

    pub fn checkpoint_coauthor_run(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        output: &str,
        audit: &[Value],
    ) -> Result<(), CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        self.current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database
            .connection
            .execute(
                "UPDATE coauthor_runs SET output=?2,audit=?3 WHERE id=?1",
                rusqlite::params![run_id.to_string(), output, encode(&audit)?],
            )?;
        Ok(())
    }

    pub fn apply_coauthor_proposal(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        expected_version: i64,
    ) -> Result<CoauthorDocument, CoauthorError> {
        let state = self.coauthor_state(scope)?;
        let run = state
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .ok_or(CoauthorError::NotFound)?;
        if run.status != "COMPLETED" || state.runs.first().map(|run| run.id) != Some(run_id) {
            return Err(CoauthorError::Conflict);
        }
        let proposed = run
            .audit
            .iter()
            .rev()
            .find(|item| item["kind"] == "draft_proposal")
            .and_then(|item| item.get("document"))
            .ok_or(CoauthorError::NotFound)?;
        let mut document: CoauthorDocument = serde_json::from_value(proposed.clone())
            .map_err(|_| CoauthorError::Invalid("稿件建议格式无效。".into()))?;
        if document.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        document.session_id = scope.session_id;
        self.save_coauthor_document(scope, document)
    }

    pub fn fork_coauthor_session(
        &mut self,
        scope: &CoauthorScope,
        title: String,
    ) -> Result<DiscussionSession, CoauthorError> {
        let state = self.coauthor_state(scope)?;
        let original = self.get_discussion_session(scope.session_id)?;
        if title.trim().is_empty() || title.chars().count() > 200 {
            return Err(CoauthorError::Invalid("分支名称须为 1 至 200 字。".into()));
        }
        let id = Uuid::new_v4();
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO discussion_sessions(id,project_id,title,scope_kind,scope_id,scope_text)
            VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                id.to_string(),
                scope.project_id.to_string(),
                title,
                original.scope_kind.as_str(),
                original.scope_id.map(|id| id.to_string()),
                original.scope_text
            ],
        )?;
        tx.execute(
            "INSERT INTO coauthor_branches VALUES (?1,?2,?3)",
            rusqlite::params![
                id.to_string(),
                scope.session_id.to_string(),
                state.document.version
            ],
        )?;
        let document = CoauthorDocument {
            session_id: id,
            version: 1,
            ..state.document
        };
        let payload = encode(&document)?;
        tx.execute(
            "INSERT INTO coauthor_documents VALUES (?1,1,?2)",
            rusqlite::params![id.to_string(), payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_document_revisions VALUES (?1,1,?2)",
            rusqlite::params![id.to_string(), payload],
        )?;
        let mut stmt = tx.prepare(
            "SELECT id,role,content,profile_id,context_version,context_summary,created_at
            FROM discussion_messages WHERE session_id=?1 ORDER BY created_at,rowid",
        )?;
        let messages = stmt
            .query_map([scope.session_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut inherited = std::collections::HashMap::new();
        for (source, role, content, profile, _, summary, created_at) in messages {
            let message = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO discussion_messages(id,session_id,role,content,profile_id,context_version,context_summary,created_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",rusqlite::params![message,id.to_string(),role,content,
                    profile,format!("fork:{}:{source}",scope.session_id),summary,created_at])?;
            inherited.insert(source, message);
        }
        for decision in state.decisions {
            let message = inherited
                .get(&decision.source_message_id.to_string())
                .ok_or(CoauthorError::NotFound)?;
            let copied = CoauthorDecision {
                id: Uuid::new_v4(),
                version: 1,
                source_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
                ..decision
            };
            tx.execute(
                "INSERT INTO coauthor_decisions VALUES (?1,?2,?3,?4,?5,?6,?7)",
                rusqlite::params![
                    copied.id.to_string(),
                    id.to_string(),
                    copied.topic,
                    copied.content,
                    copied.status,
                    copied.source_message_id.to_string(),
                    copied.version
                ],
            )?;
            tx.execute(
                "INSERT INTO coauthor_decision_revisions VALUES (?1,1,?2)",
                rusqlite::params![copied.id.to_string(), encode(&copied)?],
            )?;
        }
        tx.commit()?;
        self.get_discussion_session(id).map_err(Into::into)
    }

    pub fn start_coauthor_run(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        message: &str,
        expected_version: i64,
    ) -> Result<CoauthorRun, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if message.trim().is_empty() || message.chars().count() > DISCUSSION_MESSAGE_MAX_CHARS {
            return Err(CoauthorError::Invalid(
                "讨论内容为空或超过 20000 字，原文未被截断。".into(),
            ));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let existing: Option<(String, String)> = db
            .connection
            .query_row(
                "SELECT session_id,user_message_id FROM coauthor_runs WHERE id=?1",
                [id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let cancelled: bool = db.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_cancellations WHERE run_id=?1)",
            [id.to_string()],
            |row| row.get(0),
        )?;
        if existing.is_some() || cancelled {
            return Err(CoauthorError::Conflict);
        }
        if db.coauthor_document(scope.session_id)?.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        let user_message_id = Uuid::new_v4();
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "UPDATE coauthor_runs SET status='SUPERSEDED' WHERE session_id=?1 AND status='RUNNING'",
            [scope.session_id.to_string()],
        )?;
        tx.execute(
            "INSERT INTO discussion_messages(id,session_id,role,content) VALUES (?1,?2,'USER',?3)",
            rusqlite::params![
                user_message_id.to_string(),
                scope.session_id.to_string(),
                message
            ],
        )?;
        tx.execute(
            "INSERT INTO coauthor_runs(id,session_id,user_message_id,status,document_version)
             VALUES (?1,?2,?3,'RUNNING',?4)",
            rusqlite::params![
                id.to_string(),
                scope.session_id.to_string(),
                user_message_id.to_string(),
                expected_version
            ],
        )?;
        tx.execute("UPDATE discussion_sessions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            [scope.session_id.to_string()])?;
        tx.commit()?;
        Ok(CoauthorRun {
            id,
            session_id: scope.session_id,
            user_message_id,
            status: "RUNNING".into(),
            document_version: expected_version,
            output: String::new(),
            audit: vec![],
        })
    }

    pub fn coauthor_run_active(
        &self,
        scope: &CoauthorScope,
        run_id: Uuid,
    ) -> Result<bool, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        Ok(db.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM coauthor_runs WHERE id=?1 AND session_id=?2 AND status='RUNNING')",
            rusqlite::params![run_id.to_string(),scope.session_id.to_string()], |row| row.get(0),
        )?)
    }

    pub fn finish_coauthor_run(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        status: &str,
        output: &str,
        audit: &[Value],
    ) -> Result<(), CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        if !["COMPLETED", "CANCELLED", "FAILED", "LIMIT_REACHED"].contains(&status) {
            return Err(CoauthorError::Invalid("无效的运行状态。".into()));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT status FROM coauthor_runs WHERE id=?1 AND session_id=?2",
                rusqlite::params![run_id.to_string(), scope.session_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let previous = previous.ok_or(CoauthorError::NotFound)?;
        if ["COMPLETED", "FAILED", "LIMIT_REACHED"].contains(&previous.as_str()) {
            return Ok(());
        }
        let effective = if previous == "SUPERSEDED" || previous == "CANCELLED" {
            previous.as_str()
        } else {
            status
        };
        tx.execute(
            "UPDATE coauthor_runs SET status=?2,output=?3,audit=?4 WHERE id=?1",
            rusqlite::params![run_id.to_string(), effective, output, encode(&audit)?],
        )?;
        if !output.trim().is_empty() && !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM discussion_messages WHERE session_id=?1 AND context_version=?2)",
            rusqlite::params![scope.session_id.to_string(),format!("coauthor:{run_id}")],|row|row.get::<_,bool>(0))? {
            tx.execute(
                "INSERT INTO discussion_messages(id,session_id,role,content,context_version,context_summary)
                 VALUES (?1,?2,'ASSISTANT',?3,?4,?5)",
                rusqlite::params![Uuid::new_v4().to_string(),scope.session_id.to_string(),output,
                    format!("coauthor:{run_id}"), format!("共创运行：{effective}；来源与操作记录见运行详情。")],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn cancel_coauthor_run(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
    ) -> Result<(), CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO coauthor_cancellations(run_id,session_id) VALUES (?1,?2)
            ON CONFLICT(run_id) DO NOTHING",
            rusqlite::params![run_id.to_string(), scope.session_id.to_string()],
        )?;
        tx.execute(
            "UPDATE coauthor_runs SET status='CANCELLED' WHERE id=?1 AND session_id=?2 AND status IN ('RUNNING','COMPLETED')",
            rusqlite::params![run_id.to_string(),scope.session_id.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_coauthor_decision(
        &mut self,
        scope: &CoauthorScope,
        run_id: Uuid,
        topic: &str,
        content: &str,
        status: &str,
    ) -> Result<CoauthorDecision, CoauthorError> {
        if !self.coauthor_run_active(scope, run_id)? {
            return Err(CoauthorError::Conflict);
        }
        if topic.trim().is_empty()
            || topic.chars().count() > 200
            || content.chars().count() > 5_000
            || !["CHOSEN", "REJECTED", "OPEN", "WITHDRAWN"].contains(&status)
        {
            return Err(CoauthorError::Invalid("决定格式或范围无效。".into()));
        }
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let message: String = db.connection.query_row(
            "SELECT user_message_id FROM coauthor_runs WHERE id=?1",
            [run_id.to_string()],
            |row| row.get(0),
        )?;
        let old: Option<(String,i64)> = db.connection.query_row(
            "SELECT id,version FROM coauthor_decisions WHERE session_id=?1 AND topic=?2 ORDER BY rowid DESC LIMIT 1",
            rusqlite::params![scope.session_id.to_string(),topic], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        let (id, version) =
            old.map_or_else(|| (Uuid::new_v4().to_string(), 1), |(id, v)| (id, v + 1));
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO coauthor_decisions(id,session_id,topic,content,status,source_message_id,version)
             VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET
             content=excluded.content,status=excluded.status,source_message_id=excluded.source_message_id,version=excluded.version",
            rusqlite::params![id,scope.session_id.to_string(),topic,content,status,message,version],
        )?;
        let decision = CoauthorDecision {
            id: id.parse().map_err(|_| CoauthorError::NotFound)?,
            topic: topic.into(),
            content: content.into(),
            status: status.into(),
            source_message_id: message.parse().map_err(|_| CoauthorError::NotFound)?,
            version,
        };
        tx.execute(
            "INSERT INTO coauthor_decision_revisions VALUES (?1,?2,?3)",
            rusqlite::params![id, version, encode(&decision)?],
        )?;
        tx.commit()?;
        Ok(decision)
    }

    pub fn correct_coauthor_decision(
        &mut self,
        scope: &CoauthorScope,
        id: Uuid,
        expected_version: i64,
        content: &str,
        status: &str,
    ) -> Result<CoauthorDecision, CoauthorError> {
        let state = self.coauthor_state(scope)?;
        let previous = state
            .decisions
            .into_iter()
            .find(|decision| decision.id == id)
            .ok_or(CoauthorError::NotFound)?;
        if previous.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        if content.trim().is_empty()
            || content.chars().count() > 5000
            || !["CHOSEN", "REJECTED", "OPEN", "WITHDRAWN"].contains(&status)
        {
            return Err(CoauthorError::Invalid("决定内容或状态无效。".into()));
        }
        let message = Uuid::new_v4();
        let updated = CoauthorDecision {
            version: previous.version + 1,
            content: content.into(),
            status: status.into(),
            source_message_id: message,
            ..previous
        };
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = db.connection.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO discussion_messages(id,session_id,role,content) VALUES (?1,?2,'USER',?3)",
            rusqlite::params![
                message.to_string(),
                scope.session_id.to_string(),
                format!(
                    "作者纠正讨论决定「{}」：{} [{}]",
                    updated.topic, content, status
                )
            ],
        )?;
        tx.execute(
            "UPDATE coauthor_decisions SET version=?2,content=?3,status=?4,source_message_id=?5
            WHERE id=?1",
            rusqlite::params![
                id.to_string(),
                updated.version,
                content,
                status,
                message.to_string()
            ],
        )?;
        tx.execute(
            "INSERT INTO coauthor_decision_revisions VALUES (?1,?2,?3)",
            rusqlite::params![id.to_string(), updated.version, encode(&updated)?],
        )?;
        tx.commit()?;
        Ok(updated)
    }
}

impl Database {
    fn coauthor_document(&self, session: Uuid) -> Result<CoauthorDocument, CoauthorError> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM coauthor_documents WHERE session_id=?1",
                [session.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        payload.map_or_else(|| Ok(CoauthorDocument::empty(session)), decode)
    }
}

/// Quote matching is exact and unique. Ambiguous or stale edits remain suggestions.
pub fn coauthor_replace(content: &str, before: &str, after: &str) -> Result<String, CoauthorError> {
    if before.is_empty() || content.match_indices(before).count() != 1 {
        return Err(CoauthorError::Invalid(
            "修改原文未能唯一定位，请重新读取稿件后缩小范围。".into(),
        ));
    }
    Ok(content.replacen(before, after, 1))
}
