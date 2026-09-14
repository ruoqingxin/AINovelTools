use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscussionScopeKind {
    Project,
    Volume,
    Chapter,
    Scene,
    Selection,
}

impl DiscussionScopeKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Project => "PROJECT",
            Self::Volume => "VOLUME",
            Self::Chapter => "CHAPTER",
            Self::Scene => "SCENE",
            Self::Selection => "SELECTION",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "VOLUME" => Self::Volume,
            "CHAPTER" => Self::Chapter,
            "SCENE" => Self::Scene,
            "SELECTION" => Self::Selection,
            _ => Self::Project,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscussionMessageRole {
    User,
    Assistant,
}

impl DiscussionMessageRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "USER",
            Self::Assistant => "ASSISTANT",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "ASSISTANT" => Self::Assistant,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscussionCandidateKind {
    Note,
    Planning,
    Setting,
    Foreshadowing,
}

impl DiscussionCandidateKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Note => "NOTE",
            Self::Planning => "PLANNING",
            Self::Setting => "SETTING",
            Self::Foreshadowing => "FORESHADOWING",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "PLANNING" => Self::Planning,
            "SETTING" => Self::Setting,
            "FORESHADOWING" => Self::Foreshadowing,
            _ => Self::Note,
        }
    }

    #[must_use]
    pub const fn can_promote_to_planning(self) -> bool {
        matches!(self, Self::Planning | Self::Setting)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscussionCandidateStatus {
    Pending,
    Promoted,
    Dismissed,
}

impl DiscussionCandidateStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Promoted => "PROMOTED",
            Self::Dismissed => "DISMISSED",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "PROMOTED" => Self::Promoted,
            "DISMISSED" => Self::Dismissed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionSession {
    pub id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub scope_kind: DiscussionScopeKind,
    pub scope_id: Option<Uuid>,
    pub scope_text: Option<String>,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionMessage {
    pub id: Uuid,
    pub session_id: Uuid,
    pub role: DiscussionMessageRole,
    pub content: String,
    pub profile_id: Option<Uuid>,
    pub context_version: Option<String>,
    pub context_summary: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionCandidate {
    pub id: Uuid,
    pub session_id: Uuid,
    pub message_id: Uuid,
    pub kind: DiscussionCandidateKind,
    pub content: String,
    pub target_section_id: Option<String>,
    pub status: DiscussionCandidateStatus,
    pub promoted_object_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Error)]
pub enum DiscussionStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("discussion session does not exist: {0}")]
    MissingSession(Uuid),
    #[error("discussion message does not exist: {0}")]
    MissingMessage(Uuid),
    #[error("discussion candidate does not exist: {0}")]
    MissingCandidate(Uuid),
    #[error("discussion candidate status conflict")]
    Conflict,
    #[error("discussion candidate cannot be promoted to planning")]
    InvalidPromotion,
    #[error("discussion scope is invalid")]
    InvalidScope,
    #[error("discussion database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("discussion database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl Database {
    pub(super) fn create_discussion_session(
        &self,
        session: &DiscussionSession,
    ) -> Result<(), DatabaseError> {
        self.connection.execute(
            "INSERT INTO discussion_sessions
             (id, project_id, title, scope_kind, scope_id, scope_text, summary)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                session.id.to_string(),
                session.project_id.to_string(),
                session.title,
                session.scope_kind.as_str(),
                session.scope_id.map(|id| id.to_string()),
                session.scope_text,
                session.summary,
            ],
        )?;
        Ok(())
    }

    pub(super) fn list_discussion_sessions(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<DiscussionSession>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, title, scope_kind, scope_id, scope_text, summary, created_at, updated_at
             FROM discussion_sessions WHERE project_id = ?1
             ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = statement.query_map([project_id.to_string()], map_discussion_session)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn get_discussion_session(
        &self,
        id: Uuid,
    ) -> Result<Option<DiscussionSession>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT id, project_id, title, scope_kind, scope_id, scope_text, summary, created_at, updated_at
                 FROM discussion_sessions WHERE id = ?1",
                [id.to_string()],
                map_discussion_session,
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    pub(super) fn append_discussion_message(
        &mut self,
        message: &DiscussionMessage,
    ) -> Result<(), DatabaseError> {
        let tx = self.connection.transaction()?;
        insert_discussion_message(&tx, message)?;
        tx.execute(
            "UPDATE discussion_sessions
             SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?1",
            [message.session_id.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn append_discussion_exchange(
        &mut self,
        user_message: &DiscussionMessage,
        assistant_message: &DiscussionMessage,
    ) -> Result<(), DatabaseError> {
        if user_message.session_id != assistant_message.session_id {
            return Err(DatabaseError::Sqlite(rusqlite::Error::InvalidQuery));
        }
        let tx = self.connection.transaction()?;
        insert_discussion_message(&tx, user_message)?;
        insert_discussion_message(&tx, assistant_message)?;
        tx.execute(
            "UPDATE discussion_sessions
             SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?1",
            [user_message.session_id.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn list_discussion_messages(
        &self,
        session_id: Uuid,
        limit: u32,
    ) -> Result<Vec<DiscussionMessage>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, session_id, role, content, profile_id, context_version,
                    context_summary, created_at
             FROM (
                 SELECT id, session_id, role, content, profile_id, context_version,
                        context_summary, created_at, rowid
                 FROM discussion_messages
                 WHERE session_id = ?1
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?2
             )
             ORDER BY created_at, rowid",
        )?;
        let rows = statement.query_map(
            rusqlite::params![session_id.to_string(), limit],
            map_discussion_message,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn create_discussion_candidate(
        &self,
        candidate: &DiscussionCandidate,
    ) -> Result<(), DatabaseError> {
        let message_session: Option<String> = self
            .connection
            .query_row(
                "SELECT session_id FROM discussion_messages WHERE id = ?1",
                [candidate.message_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if message_session != Some(candidate.session_id.to_string()) {
            return Err(DatabaseError::Sqlite(
                rusqlite::Error::QueryReturnedNoRows,
            ));
        }
        self.connection.execute(
            "INSERT INTO discussion_candidates
             (id, session_id, message_id, kind, content, target_section_id, status, promoted_object_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                candidate.id.to_string(),
                candidate.session_id.to_string(),
                candidate.message_id.to_string(),
                candidate.kind.as_str(),
                candidate.content,
                candidate.target_section_id,
                candidate.status.as_str(),
                candidate.promoted_object_id,
            ],
        )?;
        Ok(())
    }

    pub(super) fn list_discussion_candidates(
        &self,
        session_id: Uuid,
    ) -> Result<Vec<DiscussionCandidate>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, session_id, message_id, kind, content, target_section_id,
                    status, promoted_object_id, created_at, updated_at
             FROM discussion_candidates WHERE session_id = ?1
             ORDER BY created_at DESC, id",
        )?;
        let rows = statement.query_map([session_id.to_string()], map_discussion_candidate)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn get_discussion_candidate(
        &self,
        id: Uuid,
    ) -> Result<Option<DiscussionCandidate>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT id, session_id, message_id, kind, content, target_section_id,
                        status, promoted_object_id, created_at, updated_at
                 FROM discussion_candidates WHERE id = ?1",
                [id.to_string()],
                map_discussion_candidate,
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    pub(super) fn decide_discussion_candidate(
        &mut self,
        id: Uuid,
        expected_status: DiscussionCandidateStatus,
        next_status: DiscussionCandidateStatus,
    ) -> Result<DiscussionCandidate, DiscussionStoreError> {
        if expected_status != DiscussionCandidateStatus::Pending
            || next_status != DiscussionCandidateStatus::Dismissed
        {
            return Err(DiscussionStoreError::Conflict);
        }
        let changed = self.connection.execute(
            "UPDATE discussion_candidates
             SET status = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?2 AND status = ?3",
            rusqlite::params![
                next_status.as_str(),
                id.to_string(),
                expected_status.as_str()
            ],
        )?;
        if changed == 0 {
            return Err(DiscussionStoreError::Conflict);
        }
        self.get_discussion_candidate(id)?
            .ok_or(DiscussionStoreError::MissingCandidate(id))
    }

    pub(super) fn promote_discussion_candidate_to_planning(
        &mut self,
        id: Uuid,
        expected_status: DiscussionCandidateStatus,
        section_id: &str,
    ) -> Result<DiscussionCandidate, DiscussionStoreError> {
        let tx = self.connection.transaction()?;
        let candidate = tx
            .query_row(
                "SELECT id, session_id, message_id, kind, content, target_section_id,
                        status, promoted_object_id, created_at, updated_at
                 FROM discussion_candidates WHERE id = ?1 AND status = ?2",
                rusqlite::params![id.to_string(), expected_status.as_str()],
                map_discussion_candidate,
            )
            .optional()?
            .ok_or(DiscussionStoreError::Conflict)?;
        if !candidate.kind.can_promote_to_planning() || section_id.trim().is_empty() {
            return Err(DiscussionStoreError::InvalidPromotion);
        }
        tx.execute(
            "INSERT INTO planning_sections
             (id, content, pending_content, story_state, rationale, consequence, references_json, updated_at)
             VALUES (?1, '', ?2, 'AI_SUGGESTED', '', '', '[]', (strftime('%Y-%m-%dT%H:%M:%fZ','now')))
             ON CONFLICT(id) DO UPDATE SET
                 pending_content = CASE
                     WHEN trim(planning_sections.pending_content) = '' THEN excluded.pending_content
                     ELSE planning_sections.pending_content || char(10) || char(10) || excluded.pending_content
                 END,
                 story_state = CASE
                     WHEN trim(planning_sections.content) <> '' THEN planning_sections.story_state
                     ELSE 'AI_SUGGESTED'
                 END,
                 updated_at = excluded.updated_at",
            rusqlite::params![section_id, candidate.content],
        )?;
        tx.execute(
            "UPDATE discussion_candidates
             SET status = 'PROMOTED', target_section_id = ?1, promoted_object_id = ?1,
                 updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?2",
            rusqlite::params![section_id, id.to_string()],
        )?;
        let promoted = tx.query_row(
            "SELECT id, session_id, message_id, kind, content, target_section_id,
                    status, promoted_object_id, created_at, updated_at
             FROM discussion_candidates WHERE id = ?1",
            [id.to_string()],
            map_discussion_candidate,
        )?;
        tx.commit()?;
        Ok(promoted)
    }
}

impl ProjectManager {
    pub fn create_discussion_session(
        &mut self,
        title: String,
        scope_kind: DiscussionScopeKind,
        scope_id: Option<Uuid>,
        scope_text: Option<String>,
    ) -> Result<DiscussionSession, DiscussionStoreError> {
        let project_id = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?
            .manifest
            .project_id;
        if scope_kind != DiscussionScopeKind::Project && scope_id.is_none() {
            return Err(DiscussionStoreError::InvalidScope);
        }
        if scope_kind == DiscussionScopeKind::Selection
            && scope_text.as_deref().is_none_or(|value| value.trim().is_empty())
        {
            return Err(DiscussionStoreError::InvalidScope);
        }
        let session = DiscussionSession {
            id: Uuid::new_v4(),
            project_id,
            title: title.trim().to_owned(),
            scope_kind,
            scope_id,
            scope_text: if scope_kind == DiscussionScopeKind::Selection {
                scope_text.map(|value| value.trim().to_owned())
            } else {
                None
            },
            summary: String::new(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        let session_ref = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        session_ref
            .database
            .create_discussion_session(&session)?;
        Ok(session)
    }

    pub fn list_discussion_sessions(
        &self,
    ) -> Result<Vec<DiscussionSession>, DiscussionStoreError> {
        let session = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        Ok(session
            .database
            .list_discussion_sessions(session.manifest.project_id)?)
    }

    pub fn get_discussion_session(
        &self,
        id: Uuid,
    ) -> Result<DiscussionSession, DiscussionStoreError> {
        let session = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        session
            .database
            .get_discussion_session(id)?
            .ok_or(DiscussionStoreError::MissingSession(id))
    }

    pub fn append_discussion_message(
        &mut self,
        session_id: Uuid,
        role: DiscussionMessageRole,
        content: String,
        profile_id: Option<Uuid>,
        context_version: Option<String>,
        context_summary: Option<String>,
    ) -> Result<DiscussionMessage, DiscussionStoreError> {
        let message = DiscussionMessage {
            id: Uuid::new_v4(),
            session_id,
            role,
            content,
            profile_id,
            context_version,
            context_summary,
            created_at: now_timestamp(),
        };
        let session = self.current.as_mut().ok_or(DiscussionStoreError::NoProject)?;
        session
            .database
            .append_discussion_message(&message)
            .map_err(|error| match error {
                DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
                    DiscussionStoreError::MissingSession(session_id)
                }
                other => DiscussionStoreError::Database(other),
            })?;
        Ok(message)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn append_discussion_exchange(
        &mut self,
        session_id: Uuid,
        user_content: String,
        assistant_content: String,
        profile_id: Option<Uuid>,
        context_version: Option<String>,
        user_context_summary: Option<String>,
        assistant_context_summary: Option<String>,
    ) -> Result<(DiscussionMessage, DiscussionMessage), DiscussionStoreError> {
        let user_message = DiscussionMessage {
            id: Uuid::new_v4(),
            session_id,
            role: DiscussionMessageRole::User,
            content: user_content,
            profile_id: None,
            context_version: context_version.clone(),
            context_summary: user_context_summary,
            created_at: now_timestamp(),
        };
        let assistant_message = DiscussionMessage {
            id: Uuid::new_v4(),
            session_id,
            role: DiscussionMessageRole::Assistant,
            content: assistant_content,
            profile_id,
            context_version,
            context_summary: assistant_context_summary,
            created_at: now_timestamp(),
        };
        let session = self.current.as_mut().ok_or(DiscussionStoreError::NoProject)?;
        session
            .database
            .append_discussion_exchange(&user_message, &assistant_message)
            .map_err(|error| match error {
                DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
                    DiscussionStoreError::MissingSession(session_id)
                }
                other => DiscussionStoreError::Database(other),
            })?;
        Ok((user_message, assistant_message))
    }

    pub fn list_discussion_messages(
        &self,
        session_id: Uuid,
        limit: u32,
    ) -> Result<Vec<DiscussionMessage>, DiscussionStoreError> {
        let session = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        session
            .database
            .get_discussion_session(session_id)?
            .ok_or(DiscussionStoreError::MissingSession(session_id))?;
        Ok(session
            .database
            .list_discussion_messages(session_id, limit)?)
    }

    pub fn create_discussion_candidate(
        &mut self,
        session_id: Uuid,
        message_id: Uuid,
        kind: DiscussionCandidateKind,
        content: String,
        target_section_id: Option<String>,
    ) -> Result<DiscussionCandidate, DiscussionStoreError> {
        let candidate = DiscussionCandidate {
            id: Uuid::new_v4(),
            session_id,
            message_id,
            kind,
            content: content.trim().to_owned(),
            target_section_id,
            status: DiscussionCandidateStatus::Pending,
            promoted_object_id: None,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        if candidate.content.is_empty() {
            return Err(DiscussionStoreError::InvalidPromotion);
        }
        let session = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        session
            .database
            .create_discussion_candidate(&candidate)
            .map_err(|error| match error {
                DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
                    DiscussionStoreError::MissingMessage(message_id)
                }
                other => DiscussionStoreError::Database(other),
            })?;
        Ok(candidate)
    }

    pub fn list_discussion_candidates(
        &self,
        session_id: Uuid,
    ) -> Result<Vec<DiscussionCandidate>, DiscussionStoreError> {
        let session = self.current.as_ref().ok_or(DiscussionStoreError::NoProject)?;
        Ok(session.database.list_discussion_candidates(session_id)?)
    }

    pub fn dismiss_discussion_candidate(
        &mut self,
        id: Uuid,
        expected_status: DiscussionCandidateStatus,
    ) -> Result<DiscussionCandidate, DiscussionStoreError> {
        let session = self.current.as_mut().ok_or(DiscussionStoreError::NoProject)?;
        session.database.decide_discussion_candidate(
            id,
            expected_status,
            DiscussionCandidateStatus::Dismissed,
        )
    }

    pub fn promote_discussion_candidate_to_planning(
        &mut self,
        id: Uuid,
        expected_status: DiscussionCandidateStatus,
    ) -> Result<DiscussionCandidate, DiscussionStoreError> {
        let candidate = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?
            .database
            .get_discussion_candidate(id)?
            .ok_or(DiscussionStoreError::MissingCandidate(id))?;
        let section_id = candidate
            .target_section_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DiscussionStoreError::InvalidPromotion)?;
        let session = self.current.as_mut().ok_or(DiscussionStoreError::NoProject)?;
        session.database.promote_discussion_candidate_to_planning(
            id,
            expected_status,
            section_id,
        )
    }
}

fn insert_discussion_message(
    tx: &rusqlite::Transaction<'_>,
    message: &DiscussionMessage,
) -> rusqlite::Result<()> {
    let exists: i64 = tx.query_row(
        "SELECT count(*) FROM discussion_sessions WHERE id = ?1",
        [message.session_id.to_string()],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.execute(
        "INSERT INTO discussion_messages
         (id, session_id, role, content, profile_id, context_version, context_summary)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            message.id.to_string(),
            message.session_id.to_string(),
            message.role.as_str(),
            message.content,
            message.profile_id.map(|id| id.to_string()),
            message.context_version,
            message.context_summary,
        ],
    )?;
    Ok(())
}

fn map_discussion_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiscussionSession> {
    Ok(DiscussionSession {
        id: parse_uuid(0, &row.get::<_, String>(0)?)?,
        project_id: parse_uuid(1, &row.get::<_, String>(1)?)?,
        title: row.get(2)?,
        scope_kind: DiscussionScopeKind::parse(&row.get::<_, String>(3)?),
        scope_id: row
            .get::<_, Option<String>>(4)?
            .as_deref()
            .map(|value| parse_uuid(4, value))
            .transpose()?,
        scope_text: row.get(5)?,
        summary: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn map_discussion_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiscussionMessage> {
    Ok(DiscussionMessage {
        id: parse_uuid(0, &row.get::<_, String>(0)?)?,
        session_id: parse_uuid(1, &row.get::<_, String>(1)?)?,
        role: DiscussionMessageRole::parse(&row.get::<_, String>(2)?),
        content: row.get(3)?,
        profile_id: row
            .get::<_, Option<String>>(4)?
            .as_deref()
            .map(|value| parse_uuid(4, value))
            .transpose()?,
        context_version: row.get(5)?,
        context_summary: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn map_discussion_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiscussionCandidate> {
    Ok(DiscussionCandidate {
        id: parse_uuid(0, &row.get::<_, String>(0)?)?,
        session_id: parse_uuid(1, &row.get::<_, String>(1)?)?,
        message_id: parse_uuid(2, &row.get::<_, String>(2)?)?,
        kind: DiscussionCandidateKind::parse(&row.get::<_, String>(3)?),
        content: row.get(4)?,
        target_section_id: row.get(5)?,
        status: DiscussionCandidateStatus::parse(&row.get::<_, String>(6)?),
        promoted_object_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn parse_uuid(column: usize, value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discussion_messages_are_immutable_and_candidates_promote_only_to_pending_planning() {
        let root = std::env::temp_dir().join(format!("ainovel-discussion-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager
            .create(&root, "Discussion test")
            .expect("create project");
        let session = manager
            .create_discussion_session(
                "主线方案讨论".into(),
                DiscussionScopeKind::Project,
                None,
                None,
            )
            .expect("create session");
        let selection = manager
            .create_discussion_session(
                "选区讨论".into(),
                DiscussionScopeKind::Selection,
                Some(Uuid::new_v4()),
                Some("城门在午夜后没有影子。".into()),
            )
            .expect("create selection session");
        assert_eq!(
            selection.scope_text.as_deref(),
            Some("城门在午夜后没有影子。")
        );
        let user_message = manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::User,
                "比较提前揭露真相的利弊。".into(),
                None,
                None,
                None,
            )
            .expect("append user message");
        let assistant_message = manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::Assistant,
                "建议把真相提前到第二卷末，但先保留一项证据。".into(),
                None,
                Some("context-v1".into()),
                Some("全书讨论".into()),
            )
            .expect("append assistant message");
        assert_eq!(
            manager
                .list_discussion_messages(session.id, 10)
                .expect("list messages")
                .len(),
            2
        );
        let (exchange_user, exchange_assistant) = manager
            .append_discussion_exchange(
                session.id,
                "再比较一次影响。".into(),
                "可以保留当前方案，先观察后续章节。".into(),
                None,
                Some("context-v2".into()),
                Some("全书讨论".into()),
                Some("全书讨论 · 已载入最近讨论".into()),
            )
            .expect("append exchange");
        assert_eq!(exchange_user.role, DiscussionMessageRole::User);
        assert_eq!(exchange_assistant.role, DiscussionMessageRole::Assistant);
        assert_eq!(
            manager
                .list_discussion_messages(session.id, 10)
                .expect("list exchange messages")
                .len(),
            4
        );
        let session_ref = manager.current.as_ref().expect("session");
        assert!(
            session_ref
                .database
                .connection
                .execute(
                    "UPDATE discussion_messages SET content = 'tampered' WHERE id = ?1",
                    [user_message.id.to_string()],
                )
                .is_err()
        );

        let note = manager
            .create_discussion_candidate(
                session.id,
                assistant_message.id,
                DiscussionCandidateKind::Note,
                "先保留这个讨论结论。".into(),
                None,
            )
            .expect("create note");
        assert!(matches!(
            manager.promote_discussion_candidate_to_planning(
                note.id,
                DiscussionCandidateStatus::Pending,
            ),
            Err(DiscussionStoreError::InvalidPromotion)
        ));

        let candidate = manager
            .create_discussion_candidate(
                session.id,
                assistant_message.id,
                DiscussionCandidateKind::Planning,
                "第二卷末揭露真相，但保留一页未解释的证据。".into(),
                Some("seed-hook".into()),
            )
            .expect("create planning candidate");
        let promoted = manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .expect("promote candidate");
        assert_eq!(promoted.status, DiscussionCandidateStatus::Promoted);
        assert_eq!(promoted.target_section_id.as_deref(), Some("seed-hook"));
        let planning = manager
            .list_planning_sections()
            .expect("planning sections")
            .into_iter()
            .find(|section| section.id == "seed-hook")
            .expect("promoted planning section");
        assert_eq!(planning.story_state, PlanningStoryState::AiSuggested);
        assert!(
            planning
                .pending_content
                .contains("第二卷末揭露真相")
        );
        assert!(planning.content.trim().is_empty());

        let dismissed = manager
            .create_discussion_candidate(
                session.id,
                assistant_message.id,
                DiscussionCandidateKind::Foreshadowing,
                "第二封信可能是误导。".into(),
                None,
            )
            .expect("create foreshadowing candidate");
        let dismissed = manager
            .dismiss_discussion_candidate(dismissed.id, DiscussionCandidateStatus::Pending)
            .expect("dismiss candidate");
        assert_eq!(dismissed.status, DiscussionCandidateStatus::Dismissed);
        assert!(matches!(
            manager.dismiss_discussion_candidate(
                dismissed.id,
                DiscussionCandidateStatus::Pending,
            ),
            Err(DiscussionStoreError::Conflict)
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn r5_1_minimum_cocreation_loop_stays_candidate_first() {
        let root = std::env::temp_dir().join(format!("ainovel-r5-1-loop-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager
            .create(&root, "R5.1 minimum loop")
            .expect("create project");
        manager
            .save_planning_section(super::PlanningSection {
                id: "seed-premise".into(),
                content: "一名失忆的信使必须在七天内送出一封会改变王国命运的信。".into(),
                pending_content: String::new(),
                story_state: super::PlanningStoryState::Confirmed,
                rationale: String::new(),
                consequence: String::new(),
                references: Vec::new(),
                updated_at: String::new(),
            })
            .expect("save one-sentence premise");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("create chapter");
        let revision = manager
            .save_manuscript(
                chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"paragraph-1"},"content":[{"type":"text","text":"沈砚在雾城醒来，发现怀中多了一封没有署名的信。"}]}]}"#.into(),
                "MANUAL_SAVE".into(),
            )
            .expect("save manuscript");
        let anchor = super::EvidenceAnchor {
            id: Uuid::new_v4(),
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            source_revision_id: revision.id,
            block_id: "paragraph-1".into(),
            start_offset: 0,
            end_offset: 2,
            source_version: revision.id.to_string(),
            source_hash: revision.content_hash.clone(),
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        let proposal_id = Uuid::new_v4();
        let item_id = Uuid::new_v4();
        manager
            .create_chapter_extraction(
                super::ChapterExtractionProposal {
                    id: proposal_id,
                    project_id: manifest.project_id,
                    chapter_id: chapter.id,
                    source_revision_id: revision.id,
                    ai_run_id: None,
                    status: super::ChapterExtractionProposalStatus::PendingReview,
                    items: vec![super::ChapterExtractionItem {
                        id: item_id,
                        proposal_id,
                        kind: super::ExtractionItemKind::Entity,
                        payload: serde_json::json!({
                            "entityType": "CHARACTER",
                            "name": "沈砚",
                            "description": "在雾城醒来的失忆信使"
                        }),
                        evidence_anchor_id: anchor.id,
                        status: super::ExtractionItemStatus::PendingReview,
                        final_object_id: None,
                        created_at: String::new(),
                        updated_at: String::new(),
                    }],
                    created_at: String::new(),
                    updated_at: String::new(),
                },
                vec![anchor.clone()],
            )
            .expect("extract character candidate");
        let entity = manager
            .upsert_entity(super::EntityInput {
                id: None,
                entity_type: super::EntityType::Character,
                name: "沈砚".into(),
                aliases: Vec::new(),
                description: "在雾城醒来的失忆信使".into(),
                fixed_attributes_json: "{}".into(),
                tags: Vec::new(),
                base_revision_id: None,
                source_version: Some(anchor.source_version.clone()),
                expected_version: None,
            })
            .expect("author adopts character");
        let entity_id = entity.id.to_string();
        let adopted = manager
            .decide_extraction_item(
                item_id,
                super::ExtractionItemStatus::PendingReview,
                super::ExtractionItemStatus::Accepted,
                Some(entity_id.clone()),
            )
            .expect("mark candidate accepted");
        assert_eq!(adopted.final_object_id.as_deref(), Some(entity_id.as_str()));

        let session = manager
            .create_discussion_session(
                "第一章真相讨论".into(),
                DiscussionScopeKind::Selection,
                Some(chapter.id),
                Some("沈砚在雾城醒来，发现怀中多了一封没有署名的信。".into()),
            )
            .expect("create selection discussion");
        let assistant_message = manager
            .append_discussion_message(
                session.id,
                DiscussionMessageRole::Assistant,
                "建议把信的署名线索留到第一卷末，避免过早解释记忆缺失。".into(),
                None,
                Some("context-loop-1".into()),
                Some("第一章选区".into()),
            )
            .expect("save discussion reply");
        let candidate = manager
            .create_discussion_candidate(
                session.id,
                assistant_message.id,
                DiscussionCandidateKind::Planning,
                "第一卷末再揭示信的署名线索。".into(),
                Some("seed-hook".into()),
            )
            .expect("save discussion candidate");
        let promoted = manager
            .promote_discussion_candidate_to_planning(
                candidate.id,
                DiscussionCandidateStatus::Pending,
            )
            .expect("promote discussion candidate");
        assert_eq!(promoted.status, DiscussionCandidateStatus::Promoted);
        let hook = manager
            .list_planning_sections()
            .expect("planning sections")
            .into_iter()
            .find(|section| section.id == "seed-hook")
            .expect("pending hook");
        assert_eq!(hook.story_state, super::PlanningStoryState::AiSuggested);
        assert!(hook.pending_content.contains("第一卷末"));
        assert!(hook.content.is_empty());

        let _ = std::fs::remove_dir_all(root);
    }
}
