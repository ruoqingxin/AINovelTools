use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExtractionItemKind {
    Entity,
    Fact,
    Relation,
    Event,
    Foreshadowing,
}

impl ExtractionItemKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Entity => "ENTITY",
            Self::Fact => "FACT",
            Self::Relation => "RELATION",
            Self::Event => "EVENT",
            Self::Foreshadowing => "FORESHADOWING",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "ENTITY" => Self::Entity,
            "RELATION" => Self::Relation,
            "EVENT" => Self::Event,
            "FORESHADOWING" => Self::Foreshadowing,
            _ => Self::Fact,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExtractionItemStatus {
    PendingReview,
    Accepted,
    Deferred,
    Rejected,
}

impl ExtractionItemStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PendingReview => "PENDING_REVIEW",
            Self::Accepted => "ACCEPTED",
            Self::Deferred => "DEFERRED",
            Self::Rejected => "REJECTED",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "ACCEPTED" => Self::Accepted,
            "DEFERRED" => Self::Deferred,
            "REJECTED" => Self::Rejected,
            _ => Self::PendingReview,
        }
    }

    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::PendingReview,
                Self::Accepted | Self::Deferred | Self::Rejected
            ) | (Self::Deferred, Self::Accepted | Self::Rejected)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChapterExtractionProposalStatus {
    PendingReview,
    PartiallyAccepted,
    Deferred,
    Accepted,
    Rejected,
}

impl ChapterExtractionProposalStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PendingReview => "PENDING_REVIEW",
            Self::PartiallyAccepted => "PARTIALLY_ACCEPTED",
            Self::Deferred => "DEFERRED",
            Self::Accepted => "ACCEPTED",
            Self::Rejected => "REJECTED",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "PARTIALLY_ACCEPTED" => Self::PartiallyAccepted,
            "DEFERRED" => Self::Deferred,
            "ACCEPTED" => Self::Accepted,
            "REJECTED" => Self::Rejected,
            _ => Self::PendingReview,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterExtractionItem {
    pub id: Uuid,
    pub proposal_id: Uuid,
    pub kind: ExtractionItemKind,
    pub payload: serde_json::Value,
    pub evidence_anchor_id: Uuid,
    pub status: ExtractionItemStatus,
    pub version: i64,
    pub final_object_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChapterExtractionProposal {
    pub id: Uuid,
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub source_revision_id: Uuid,
    pub ai_run_id: Option<Uuid>,
    pub status: ChapterExtractionProposalStatus,
    pub items: Vec<ChapterExtractionItem>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionItemTarget {
    pub id: Uuid,
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub expected_status: ExtractionItemStatus,
    pub expected_version: i64,
}

impl ExtractionItemTarget {
    fn validate_edit(&self) -> Result<(), ExtractionStoreError> {
        if self.expected_version <= 0
            || !matches!(
                self.expected_status,
                ExtractionItemStatus::PendingReview | ExtractionItemStatus::Deferred
            )
        {
            return Err(ExtractionStoreError::Conflict);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum ExtractionAdoption {
    Entity(EntityInput),
    Fact(KnowledgeCandidate),
    Relation(Relation),
    Event(Event),
    Foreshadowing(Foreshadowing),
}

impl ExtractionAdoption {
    #[must_use]
    pub const fn kind(&self) -> ExtractionItemKind {
        match self {
            Self::Entity(_) => ExtractionItemKind::Entity,
            Self::Fact(_) => ExtractionItemKind::Fact,
            Self::Relation(_) => ExtractionItemKind::Relation,
            Self::Event(_) => ExtractionItemKind::Event,
            Self::Foreshadowing(_) => ExtractionItemKind::Foreshadowing,
        }
    }

    fn project_id(&self) -> Option<Uuid> {
        match self {
            Self::Entity(_) => None,
            Self::Fact(value) => Some(value.project_id),
            Self::Relation(value) => Some(value.project_id),
            Self::Event(value) => Some(value.project_id),
            Self::Foreshadowing(value) => Some(value.project_id),
        }
    }

    fn validate(&self) -> Result<(), ExtractionStoreError> {
        match self {
            Self::Entity(value) => value
                .validate()
                .map_err(|error| ExtractionStoreError::Entity(EntityStoreError::Contract(error))),
            Self::Fact(value) => value.validate().map_err(|error| {
                ExtractionStoreError::Knowledge(KnowledgeStoreError::Contract(error))
            }),
            Self::Relation(value) => value.validate().map_err(|error| {
                ExtractionStoreError::Knowledge(KnowledgeStoreError::Expansion(error))
            }),
            Self::Event(value) => value.validate().map_err(|error| {
                ExtractionStoreError::Knowledge(KnowledgeStoreError::Expansion(error))
            }),
            Self::Foreshadowing(value) => value.validate().map_err(|error| {
                ExtractionStoreError::Knowledge(KnowledgeStoreError::Expansion(error))
            }),
        }
    }
}

#[derive(Debug, Error)]
pub enum ExtractionStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("extraction candidate does not exist: {0}")]
    MissingItem(Uuid),
    #[error("extraction candidate version, status or scope conflict")]
    Conflict,
    #[error("extraction candidate has no supported payload")]
    InvalidPayload,
    #[error(transparent)]
    Entity(#[from] EntityStoreError),
    #[error(transparent)]
    Knowledge(#[from] KnowledgeStoreError),
    #[error("extraction database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("extraction database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl Database {
    pub(super) fn create_chapter_extraction(
        &mut self,
        proposal: &ChapterExtractionProposal,
        anchors: &[EvidenceAnchor],
    ) -> Result<(), DatabaseError> {
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO chapter_extraction_proposals
             (id, project_id, chapter_id, source_revision_id, ai_run_id, status)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                proposal.id.to_string(),
                proposal.project_id.to_string(),
                proposal.chapter_id.to_string(),
                proposal.source_revision_id.to_string(),
                proposal.ai_run_id.map(|id| id.to_string()),
                proposal.status.as_str(),
            ],
        )?;
        for anchor in anchors {
            tx.execute(
                "INSERT INTO evidence_anchors
                 (id, project_id, chapter_id, source_revision_id, block_id, start_offset, end_offset,
                  source_version, source_hash, lifecycle_status, created_by)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10)",
                rusqlite::params![
                    anchor.id.to_string(),
                    anchor.project_id.to_string(),
                    anchor.chapter_id.to_string(),
                    anchor.source_revision_id.to_string(),
                    anchor.block_id,
                    anchor.start_offset,
                    anchor.end_offset,
                    anchor.source_version,
                    anchor.source_hash,
                    anchor.created_by,
                ],
            )?;
        }
        for item in &proposal.items {
            let payload_json = serde_json::to_string(&item.payload).map_err(|error| {
                DatabaseError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
            })?;
            tx.execute(
                "INSERT INTO chapter_extraction_items
                 (id, proposal_id, kind, payload_json, evidence_anchor_id, status)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    item.id.to_string(),
                    item.proposal_id.to_string(),
                    item.kind.as_str(),
                    payload_json,
                    item.evidence_anchor_id.to_string(),
                    item.status.as_str(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn list_chapter_extractions(
        &self,
        project_id: Uuid,
        chapter_id: Uuid,
    ) -> Result<Vec<ChapterExtractionProposal>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, chapter_id, source_revision_id, ai_run_id, status, created_at, updated_at
             FROM chapter_extraction_proposals
             WHERE project_id = ?1 AND chapter_id = ?2
             ORDER BY updated_at DESC, id",
        )?;
        let proposals = statement
            .query_map(
                rusqlite::params![project_id.to_string(), chapter_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut result = Vec::with_capacity(proposals.len());
        for (id, project, chapter, revision, run, status, created_at, updated_at) in proposals {
            let proposal_id = parse_uuid(0, &id)?;
            result.push(ChapterExtractionProposal {
                id: proposal_id,
                project_id: parse_uuid(1, &project)?,
                chapter_id: parse_uuid(2, &chapter)?,
                source_revision_id: parse_uuid(3, &revision)?,
                ai_run_id: run
                    .as_deref()
                    .map(|value| parse_uuid(4, value))
                    .transpose()?,
                status: ChapterExtractionProposalStatus::parse(&status),
                items: self.list_chapter_extraction_items(proposal_id)?,
                created_at,
                updated_at,
            });
        }
        Ok(result)
    }

    fn list_chapter_extraction_items(
        &self,
        proposal_id: Uuid,
    ) -> Result<Vec<ChapterExtractionItem>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, proposal_id, kind, payload_json, evidence_anchor_id, status,
                    final_object_id, created_at, updated_at, version
             FROM chapter_extraction_items WHERE proposal_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([proposal_id.to_string()], map_extraction_item)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn get_extraction_item(
        &self,
        target: ExtractionItemTarget,
    ) -> Result<Option<ChapterExtractionItem>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT i.id, i.proposal_id, i.kind, i.payload_json, i.evidence_anchor_id, i.status,
                        i.final_object_id, i.created_at, i.updated_at, i.version
                 FROM chapter_extraction_items i
                 JOIN chapter_extraction_proposals p ON p.id = i.proposal_id
                 WHERE i.id = ?1 AND p.project_id = ?2 AND p.chapter_id = ?3",
                rusqlite::params![target.id.to_string(), target.project_id.to_string(), target.chapter_id.to_string()],
                map_extraction_item,
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    pub(super) fn update_extraction_item_payload(
        &mut self,
        target: ExtractionItemTarget,
        payload_json: String,
    ) -> Result<ChapterExtractionItem, DatabaseError> {
        let tx = self.connection.transaction()?;
        let changed = tx.execute(
            "UPDATE chapter_extraction_items
             SET payload_json = ?1, version = version + 1,
                 updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?2 AND status = ?3 AND version = ?4
               AND proposal_id IN (SELECT id FROM chapter_extraction_proposals
                                  WHERE project_id = ?5 AND chapter_id = ?6)",
            rusqlite::params![
                payload_json,
                target.id.to_string(),
                target.expected_status.as_str(),
                target.expected_version,
                target.project_id.to_string(),
                target.chapter_id.to_string()
            ],
        )?;
        if changed == 0 {
            return Err(DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        let item = tx.query_row(
            "SELECT id, proposal_id, kind, payload_json, evidence_anchor_id, status,
                    final_object_id, created_at, updated_at, version
             FROM chapter_extraction_items WHERE id = ?1",
            [target.id.to_string()],
            map_extraction_item,
        )?;
        tx.commit()?;
        Ok(item)
    }

    pub(super) fn decide_extraction_item(
        &mut self,
        target: ExtractionItemTarget,
        next_status: ExtractionItemStatus,
    ) -> Result<ChapterExtractionItem, DatabaseError> {
        let tx = self.connection.transaction()?;
        let item = update_extraction_item_status_in_tx(&tx, target, next_status, None)?;
        tx.commit()?;
        Ok(item)
    }

    pub(super) fn adopt_extraction_item(
        &mut self,
        target: ExtractionItemTarget,
        adoption: ExtractionAdoption,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        let tx = self.connection.transaction()?;
        let item = tx
            .query_row(
                "SELECT i.id, i.proposal_id, i.kind, i.payload_json, i.evidence_anchor_id,
                        i.status, i.final_object_id, i.created_at, i.updated_at, i.version
                 FROM chapter_extraction_items i
                 JOIN chapter_extraction_proposals p ON p.id = i.proposal_id
                 WHERE i.id = ?1 AND p.project_id = ?2 AND p.chapter_id = ?3",
                rusqlite::params![
                    target.id.to_string(),
                    target.project_id.to_string(),
                    target.chapter_id.to_string()
                ],
                map_extraction_item,
            )
            .optional()?;
        let Some(item) = item else {
            return Err(ExtractionStoreError::Conflict);
        };
        if item.status != target.expected_status || item.version != target.expected_version {
            return Err(ExtractionStoreError::Conflict);
        }
        if item.kind != adoption.kind() {
            return Err(ExtractionStoreError::InvalidPayload);
        }
        let final_object_id = match adoption {
            ExtractionAdoption::Entity(value) => {
                let entity_id = Self::upsert_entity_in_tx(&tx, target.project_id, value)?;
                Self::rebuild_search_index_in_tx(&tx, target.project_id)?;
                entity_id.to_string()
            }
            ExtractionAdoption::Fact(value) => {
                let object_id = value.id;
                Self::insert_knowledge_candidate_in_tx(&tx, &value)?;
                object_id.to_string()
            }
            ExtractionAdoption::Relation(value) => {
                let object_id = value.id;
                Self::insert_relation_in_tx(&tx, &value, None)?;
                object_id.to_string()
            }
            ExtractionAdoption::Event(value) => {
                let object_id = value.id;
                Self::insert_event_in_tx(&tx, &value, None)?;
                object_id.to_string()
            }
            ExtractionAdoption::Foreshadowing(value) => {
                let object_id = value.id;
                Self::insert_foreshadowing_in_tx(&tx, &value, None)?;
                object_id.to_string()
            }
        };
        let item = update_extraction_item_status_in_tx(
            &tx,
            target,
            ExtractionItemStatus::Accepted,
            Some(final_object_id),
        )?;
        tx.commit()?;
        Ok(item)
    }
}

fn update_extraction_item_status_in_tx(
    tx: &rusqlite::Transaction<'_>,
    target: ExtractionItemTarget,
    next_status: ExtractionItemStatus,
    final_object_id: Option<String>,
) -> Result<ChapterExtractionItem, rusqlite::Error> {
    let changed = tx.execute(
        "UPDATE chapter_extraction_items
         SET status = ?1, final_object_id = COALESCE(?2, final_object_id),
             version = version + 1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE id = ?3 AND status = ?4 AND version = ?5
           AND proposal_id IN (SELECT id FROM chapter_extraction_proposals
                              WHERE project_id = ?6 AND chapter_id = ?7)",
        rusqlite::params![
            next_status.as_str(),
            final_object_id,
            target.id.to_string(),
            target.expected_status.as_str(),
            target.expected_version,
            target.project_id.to_string(),
            target.chapter_id.to_string(),
        ],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let proposal_id: String = tx.query_row(
        "SELECT proposal_id FROM chapter_extraction_items WHERE id = ?1",
        [target.id.to_string()],
        |row| row.get(0),
    )?;
    let counts: (i64, i64, i64, i64) = tx.query_row(
        "SELECT
            COALESCE(SUM(status = 'PENDING_REVIEW'), 0),
            COALESCE(SUM(status = 'ACCEPTED'), 0),
            COALESCE(SUM(status = 'DEFERRED'), 0),
            COALESCE(SUM(status = 'REJECTED'), 0)
         FROM chapter_extraction_items WHERE proposal_id = ?1",
        [proposal_id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let proposal_status = if counts.0 > 0 {
        if counts.1 > 0 {
            ChapterExtractionProposalStatus::PartiallyAccepted
        } else {
            ChapterExtractionProposalStatus::PendingReview
        }
    } else if counts.1 > 0 && counts.2 == 0 && counts.3 == 0 {
        ChapterExtractionProposalStatus::Accepted
    } else if counts.2 > 0 && counts.1 == 0 && counts.3 == 0 {
        ChapterExtractionProposalStatus::Deferred
    } else if counts.3 > 0 && counts.1 == 0 && counts.2 == 0 {
        ChapterExtractionProposalStatus::Rejected
    } else {
        ChapterExtractionProposalStatus::PartiallyAccepted
    };
    tx.execute(
        "UPDATE chapter_extraction_proposals
         SET status = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE id = ?2",
        rusqlite::params![proposal_status.as_str(), proposal_id],
    )?;
    tx.query_row(
        "SELECT id, proposal_id, kind, payload_json, evidence_anchor_id, status,
                final_object_id, created_at, updated_at, version
         FROM chapter_extraction_items WHERE id = ?1",
        [target.id.to_string()],
        map_extraction_item,
    )
}

impl ProjectManager {
    pub fn create_chapter_extraction(
        &mut self,
        proposal: ChapterExtractionProposal,
        anchors: Vec<EvidenceAnchor>,
    ) -> Result<ChapterExtractionProposal, ExtractionStoreError> {
        let session = self
            .current
            .as_mut()
            .ok_or(ExtractionStoreError::NoProject)?;
        if proposal.project_id != session.manifest.project_id
            || proposal.items.iter().any(|item| {
                item.proposal_id != proposal.id || item.version != 1 || !item.payload.is_object()
            })
        {
            return Err(ExtractionStoreError::Conflict);
        }
        session
            .database
            .create_chapter_extraction(&proposal, &anchors)?;
        Ok(proposal)
    }

    pub fn list_chapter_extractions(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<ChapterExtractionProposal>, ExtractionStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(ExtractionStoreError::NoProject)?;
        Ok(session
            .database
            .list_chapter_extractions(session.manifest.project_id, chapter_id)?)
    }

    pub fn get_extraction_item(
        &self,
        target: ExtractionItemTarget,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(ExtractionStoreError::NoProject)?;
        if target.project_id != session.manifest.project_id {
            return Err(ExtractionStoreError::Conflict);
        }
        let item = session
            .database
            .get_extraction_item(target)?
            .ok_or(ExtractionStoreError::Conflict)?;
        if item.status != target.expected_status || item.version != target.expected_version {
            return Err(ExtractionStoreError::Conflict);
        }
        Ok(item)
    }

    pub fn update_extraction_item_payload(
        &mut self,
        target: ExtractionItemTarget,
        payload: serde_json::Value,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        target.validate_edit()?;
        if !payload.is_object() {
            return Err(ExtractionStoreError::InvalidPayload);
        }
        let payload_json = serde_json::to_string(&payload).map_err(|error| {
            ExtractionStoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
        })?;
        let session = self
            .current
            .as_mut()
            .ok_or(ExtractionStoreError::NoProject)?;
        if target.project_id != session.manifest.project_id {
            return Err(ExtractionStoreError::Conflict);
        }
        session
            .database
            .update_extraction_item_payload(target, payload_json)
            .map_err(extraction_write_error)
    }

    pub fn decide_extraction_item(
        &mut self,
        target: ExtractionItemTarget,
        next_status: ExtractionItemStatus,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        target.validate_edit()?;
        if !matches!(
            next_status,
            ExtractionItemStatus::Deferred | ExtractionItemStatus::Rejected
        ) || !target.expected_status.can_transition_to(next_status)
        {
            return Err(ExtractionStoreError::Conflict);
        }
        let session = self
            .current
            .as_mut()
            .ok_or(ExtractionStoreError::NoProject)?;
        if target.project_id != session.manifest.project_id {
            return Err(ExtractionStoreError::Conflict);
        }
        session
            .database
            .decide_extraction_item(target, next_status)
            .map_err(extraction_write_error)
    }

    pub fn adopt_extraction_item(
        &mut self,
        target: ExtractionItemTarget,
        adoption: ExtractionAdoption,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        target.validate_edit()?;
        if !target
            .expected_status
            .can_transition_to(ExtractionItemStatus::Accepted)
        {
            return Err(ExtractionStoreError::Conflict);
        }
        adoption.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(ExtractionStoreError::NoProject)?;
        if target.project_id != session.manifest.project_id
            || adoption
                .project_id()
                .is_some_and(|project_id| project_id != session.manifest.project_id)
        {
            return Err(ExtractionStoreError::Conflict);
        }
        session.database.adopt_extraction_item(target, adoption)
    }
}

fn map_extraction_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChapterExtractionItem> {
    let payload_json: String = row.get(3)?;
    let payload = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(ChapterExtractionItem {
        id: parse_uuid(0, &row.get::<_, String>(0)?)?,
        proposal_id: parse_uuid(1, &row.get::<_, String>(1)?)?,
        kind: ExtractionItemKind::parse(&row.get::<_, String>(2)?),
        payload,
        evidence_anchor_id: parse_uuid(4, &row.get::<_, String>(4)?)?,
        status: ExtractionItemStatus::parse(&row.get::<_, String>(5)?),
        final_object_id: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        version: row.get(9)?,
    })
}

fn extraction_write_error(error: DatabaseError) -> ExtractionStoreError {
    match error {
        DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
            ExtractionStoreError::Conflict
        }
        other => ExtractionStoreError::Database(other),
    }
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

    fn entity_input(name: &str) -> EntityInput {
        EntityInput {
            id: None,
            entity_type: EntityType::Character,
            name: name.into(),
            aliases: Vec::new(),
            description: "description".into(),
            fixed_attributes_json: "{}".into(),
            tags: Vec::new(),
            base_revision_id: None,
            source_version: None,
            expected_version: None,
        }
    }

    struct Fixture {
        manager: ProjectManager,
        root: PathBuf,
        target: ExtractionItemTarget,
        anchor: EvidenceAnchor,
    }

    impl Fixture {
        fn new(kind: ExtractionItemKind) -> Self {
            let root = std::env::temp_dir().join(format!("extraction-cas-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let manifest = manager.create(&root, "CAS").unwrap();
            let chapter = manager
                .create_plan_node(None, PlanNodeKind::Chapter, "chapter".into())
                .unwrap();
            let revision = manager.save_manuscript(chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"block"},"content":[{"type":"text","text":"character enters city"}]}]}"#.into(), "test".into()).unwrap();
            let anchor = EvidenceAnchor {
                id: Uuid::new_v4(),
                project_id: manifest.project_id,
                chapter_id: chapter.id,
                source_revision_id: revision.id,
                block_id: "block".into(),
                start_offset: 0,
                end_offset: 9,
                source_version: format!("manuscript:{}", revision.id),
                source_hash: revision.content_hash,
                lifecycle_status: KnowledgeLifecycleStatus::Active,
                created_by: "test".into(),
                created_at: String::new(),
                updated_at: String::new(),
            };
            let proposal_id = Uuid::new_v4();
            let target = ExtractionItemTarget {
                id: Uuid::new_v4(),
                project_id: manifest.project_id,
                chapter_id: chapter.id,
                expected_status: ExtractionItemStatus::PendingReview,
                expected_version: 1,
            };
            manager
                .create_chapter_extraction(
                    ChapterExtractionProposal {
                        id: proposal_id,
                        project_id: manifest.project_id,
                        chapter_id: chapter.id,
                        source_revision_id: revision.id,
                        ai_run_id: None,
                        status: ChapterExtractionProposalStatus::PendingReview,
                        items: vec![ChapterExtractionItem {
                            id: target.id,
                            proposal_id,
                            kind,
                            payload: serde_json::json!({"name":"A"}),
                            evidence_anchor_id: anchor.id,
                            status: target.expected_status,
                            version: 1,
                            final_object_id: None,
                            created_at: String::new(),
                            updated_at: String::new(),
                        }],
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                    vec![anchor.clone()],
                )
                .unwrap();
            Self {
                manager,
                root,
                target,
                anchor,
            }
        }

        fn snapshot(&self) -> ChapterExtractionProposal {
            self.manager
                .list_chapter_extractions(self.target.chapter_id)
                .unwrap()
                .remove(0)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn serialized_mutation_target_requires_scope_status_and_version() {
        let target = serde_json::json!({
            "id": Uuid::new_v4(), "projectId": Uuid::new_v4(), "chapterId": Uuid::new_v4(),
            "expectedStatus": "PENDING_REVIEW", "expectedVersion": 1,
        });
        let decoded: ExtractionItemTarget = serde_json::from_value(target.clone()).unwrap();
        assert_eq!(decoded.expected_version, 1);
        for field in [
            "id",
            "projectId",
            "chapterId",
            "expectedStatus",
            "expectedVersion",
        ] {
            let mut missing = target.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<ExtractionItemTarget>(missing).is_err());
        }
    }

    #[test]
    fn stale_same_status_writes_decisions_and_adoption_cannot_overwrite_or_create_objects() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let saved = f
            .manager
            .update_extraction_item_payload(f.target, serde_json::json!({"name":"B"}))
            .unwrap();
        assert_eq!(saved.version, 2);
        let snapshot = f.snapshot();
        assert!(matches!(
            f.manager.get_extraction_item(f.target),
            Err(ExtractionStoreError::Conflict)
        ));
        assert!(matches!(
            f.manager
                .update_extraction_item_payload(f.target, serde_json::json!({"name":"C"})),
            Err(ExtractionStoreError::Conflict)
        ));
        for decision in [
            ExtractionItemStatus::Deferred,
            ExtractionItemStatus::Rejected,
        ] {
            assert!(matches!(
                f.manager.decide_extraction_item(f.target, decision),
                Err(ExtractionStoreError::Conflict)
            ));
        }
        assert!(matches!(
            f.manager
                .adopt_extraction_item(f.target, ExtractionAdoption::Entity(entity_input("A"))),
            Err(ExtractionStoreError::Conflict)
        ));
        assert_eq!(f.snapshot(), snapshot);
        assert!(f.manager.list_entities(false).unwrap().is_empty());
    }

    #[test]
    fn payload_reversion_does_not_restore_an_old_version() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        f.manager
            .update_extraction_item_payload(f.target, serde_json::json!({"name":"B"}))
            .unwrap();
        let saved = f
            .manager
            .update_extraction_item_payload(
                ExtractionItemTarget {
                    expected_version: 2,
                    ..f.target
                },
                serde_json::json!({"name":"A"}),
            )
            .unwrap();
        assert_eq!(saved.version, 3);
        assert!(matches!(
            f.manager
                .update_extraction_item_payload(f.target, saved.payload.clone()),
            Err(ExtractionStoreError::Conflict)
        ));
        assert!(matches!(
            f.manager
                .adopt_extraction_item(f.target, ExtractionAdoption::Entity(entity_input("A"))),
            Err(ExtractionStoreError::Conflict)
        ));
        assert_eq!(f.snapshot().items[0], saved);
    }

    #[test]
    fn mutations_check_scope_payload_and_accepted_decisions_cannot_bypass_adoption() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let snapshot = f.snapshot();
        for target in [
            ExtractionItemTarget {
                project_id: Uuid::new_v4(),
                ..f.target
            },
            ExtractionItemTarget {
                chapter_id: Uuid::new_v4(),
                ..f.target
            },
            ExtractionItemTarget {
                id: Uuid::new_v4(),
                ..f.target
            },
            ExtractionItemTarget {
                expected_version: 0,
                ..f.target
            },
        ] {
            assert!(matches!(
                f.manager.get_extraction_item(target),
                Err(ExtractionStoreError::Conflict)
            ));
            assert!(matches!(
                f.manager
                    .update_extraction_item_payload(target, serde_json::json!({})),
                Err(ExtractionStoreError::Conflict)
            ));
            assert!(matches!(
                f.manager
                    .decide_extraction_item(target, ExtractionItemStatus::Rejected),
                Err(ExtractionStoreError::Conflict)
            ));
            assert!(matches!(
                f.manager
                    .adopt_extraction_item(target, ExtractionAdoption::Entity(entity_input("A"))),
                Err(ExtractionStoreError::Conflict)
            ));
        }
        for value in [
            serde_json::Value::Null,
            serde_json::json!([]),
            serde_json::json!("text"),
        ] {
            assert!(matches!(
                f.manager.update_extraction_item_payload(f.target, value),
                Err(ExtractionStoreError::InvalidPayload)
            ));
        }
        assert!(matches!(
            f.manager
                .decide_extraction_item(f.target, ExtractionItemStatus::Accepted),
            Err(ExtractionStoreError::Conflict)
        ));
        assert_eq!(f.snapshot(), snapshot);
        assert!(f.manager.list_entities(false).unwrap().is_empty());
    }

    #[test]
    fn deferred_edits_increment_versions_and_terminal_items_cannot_be_mutated() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let deferred = f
            .manager
            .decide_extraction_item(f.target, ExtractionItemStatus::Deferred)
            .unwrap();
        assert_eq!(deferred.version, 2);
        assert_eq!(
            f.snapshot().status,
            ChapterExtractionProposalStatus::Deferred
        );
        let target = ExtractionItemTarget {
            expected_status: deferred.status,
            expected_version: deferred.version,
            ..f.target
        };
        let saved = f
            .manager
            .update_extraction_item_payload(target, serde_json::json!({"name":"B"}))
            .unwrap();
        assert_eq!(saved.version, 3);
        let rejected = f
            .manager
            .decide_extraction_item(
                ExtractionItemTarget {
                    expected_version: 3,
                    ..target
                },
                ExtractionItemStatus::Rejected,
            )
            .unwrap();
        assert_eq!(rejected.version, 4);
        let terminal = ExtractionItemTarget {
            expected_status: rejected.status,
            expected_version: rejected.version,
            ..target
        };
        assert!(matches!(
            f.manager
                .update_extraction_item_payload(terminal, serde_json::json!({})),
            Err(ExtractionStoreError::Conflict)
        ));
        assert!(matches!(
            f.manager
                .decide_extraction_item(terminal, ExtractionItemStatus::Deferred),
            Err(ExtractionStoreError::Conflict)
        ));
        assert!(matches!(
            f.manager
                .adopt_extraction_item(terminal, ExtractionAdoption::Entity(entity_input("B"))),
            Err(ExtractionStoreError::Conflict)
        ));
        assert_eq!(f.snapshot().items[0], rejected);
    }

    #[test]
    fn adoption_and_decision_failures_roll_back_objects_status_version_and_search() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let snapshot = f.snapshot();
        f.manager.current.as_ref().unwrap().database.connection.execute_batch(
            "CREATE TRIGGER fail_extraction_aggregate BEFORE UPDATE ON chapter_extraction_proposals
             BEGIN SELECT RAISE(ABORT,'test aggregate failure'); END;").unwrap();
        assert!(
            f.manager
                .decide_extraction_item(f.target, ExtractionItemStatus::Rejected)
                .is_err()
        );
        assert!(
            f.manager
                .adopt_extraction_item(f.target, ExtractionAdoption::Entity(entity_input("A")))
                .is_err()
        );
        assert_eq!(f.snapshot(), snapshot);
        assert!(f.manager.list_entities(false).unwrap().is_empty());
        let connection = &f.manager.current.as_ref().unwrap().database.connection;
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM search_index WHERE object_type='ENTITY'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        connection
            .execute_batch("DROP TRIGGER fail_extraction_aggregate")
            .unwrap();
        let adopted = f
            .manager
            .adopt_extraction_item(f.target, ExtractionAdoption::Entity(entity_input("A")))
            .unwrap();
        assert_eq!(adopted.version, 2);
        assert_eq!(f.manager.list_entities(false).unwrap().len(), 1);
        let terminal = ExtractionItemTarget {
            expected_status: adopted.status,
            expected_version: adopted.version,
            ..f.target
        };
        assert!(matches!(
            f.manager
                .update_extraction_item_payload(terminal, serde_json::json!({})),
            Err(ExtractionStoreError::Conflict)
        ));
        assert!(matches!(
            f.manager
                .adopt_extraction_item(terminal, ExtractionAdoption::Entity(entity_input("A"))),
            Err(ExtractionStoreError::Conflict)
        ));
    }

    #[test]
    fn failed_payload_update_keeps_the_original_version_and_payload() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let snapshot = f.snapshot();
        f.manager
            .current
            .as_ref()
            .unwrap()
            .database
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_extraction_payload BEFORE UPDATE ON chapter_extraction_items
             BEGIN SELECT RAISE(ABORT,'test payload failure'); END;",
            )
            .unwrap();
        assert!(
            f.manager
                .update_extraction_item_payload(f.target, serde_json::json!({"name":"B"}))
                .is_err()
        );
        assert_eq!(f.snapshot(), snapshot);
    }

    #[test]
    fn separate_connections_and_reopen_keep_cas_versions_and_evidence() {
        let mut f = Fixture::new(ExtractionItemKind::Entity);
        let mut other = ProjectManager::new();
        other.open(&f.root).unwrap();
        f.manager
            .update_extraction_item_payload(f.target, serde_json::json!({"name":"B"}))
            .unwrap();
        assert!(matches!(
            other.update_extraction_item_payload(f.target, serde_json::json!({"name":"C"})),
            Err(ExtractionStoreError::Conflict)
        ));
        let saved = other
            .update_extraction_item_payload(
                ExtractionItemTarget {
                    expected_version: 2,
                    ..f.target
                },
                serde_json::json!({"name":"C"}),
            )
            .unwrap();
        other.close();
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.snapshot().items[0], saved);
        let anchor = f.manager.list_evidence_anchors().unwrap().remove(0);
        assert_eq!(anchor.id, f.anchor.id);
        assert_eq!(anchor.source_hash, f.anchor.source_hash);
    }

    #[test]
    fn adopted_fact_remains_a_pending_candidate_not_a_final_fact() {
        let mut f = Fixture::new(ExtractionItemKind::Fact);
        let candidate_id = Uuid::new_v4();
        let adopted = f
            .manager
            .adopt_extraction_item(
                f.target,
                ExtractionAdoption::Fact(KnowledgeCandidate {
                    id: candidate_id,
                    project_id: f.target.project_id,
                    chapter_id: f.target.chapter_id,
                    proposal_id: None,
                    candidate_status: CandidateStatus::Pending,
                    review_decision: None,
                    reviewer: None,
                    reviewed_at: None,
                    fact: Fact {
                        knowledge_id: Uuid::new_v4(),
                        project_id: f.target.project_id,
                        knowledge_version: 1,
                        subject: "character".into(),
                        predicate: "enters".into(),
                        object: "city".into(),
                        source_revision_id: f.anchor.source_revision_id,
                        evidence_anchor_ids: vec![f.anchor.id],
                        lifecycle_status: KnowledgeLifecycleStatus::NeedsReview,
                        created_by: "test".into(),
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                    created_at: String::new(),
                    updated_at: String::new(),
                }),
            )
            .unwrap();
        assert_eq!(adopted.version, 2);
        assert_eq!(adopted.final_object_id, Some(candidate_id.to_string()));
        let candidates = f
            .manager
            .list_knowledge_candidates(f.target.chapter_id)
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].candidate_status, CandidateStatus::Pending);
        assert!(f.manager.list_current_facts().unwrap().is_empty());
    }

    #[test]
    fn extraction_candidates_keep_evidence_and_enforce_review_transitions() {
        let root = std::env::temp_dir().join(format!("ainovel-extraction-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager
            .create(&root, "Extraction test")
            .expect("create project");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".into())
            .expect("create chapter");
        let target = |id, expected_status, expected_version| ExtractionItemTarget {
            id,
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            expected_status,
            expected_version,
        };
        let revision = manager
            .save_manuscript(
                chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"paragraph-1"},"content":[{"type":"text","text":"沈砚第一次进入雾城。"}]}]}"#.into(),
                "TEST".into(),
            )
            .expect("save revision");
        let anchor = EvidenceAnchor {
            id: Uuid::new_v4(),
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            source_revision_id: revision.id,
            block_id: "paragraph-1".into(),
            start_offset: 0,
            end_offset: 9,
            source_version: revision.id.to_string(),
            source_hash: revision.content_hash.clone(),
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        let proposal_id = Uuid::new_v4();
        let item_id = Uuid::new_v4();
        let proposal = ChapterExtractionProposal {
            id: proposal_id,
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            source_revision_id: revision.id,
            ai_run_id: None,
            status: ChapterExtractionProposalStatus::PendingReview,
            items: vec![ChapterExtractionItem {
                id: item_id,
                proposal_id,
                kind: ExtractionItemKind::Entity,
                payload: serde_json::json!({
                    "entityType": "CHARACTER",
                    "name": "沈砚",
                    "description": "第一次进入雾城"
                }),
                evidence_anchor_id: anchor.id,
                status: ExtractionItemStatus::PendingReview,
                version: 1,
                final_object_id: None,
                created_at: String::new(),
                updated_at: String::new(),
            }],
            created_at: String::new(),
            updated_at: String::new(),
        };
        manager
            .create_chapter_extraction(proposal, vec![anchor.clone()])
            .expect("create extraction proposal");

        let listed = manager
            .list_chapter_extractions(chapter.id)
            .expect("list extraction proposals");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source_revision_id, revision.id);
        assert_eq!(listed[0].items[0].evidence_anchor_id, anchor.id);
        assert_eq!(
            listed[0].items[0].status,
            ExtractionItemStatus::PendingReview
        );

        let updated = manager
            .update_extraction_item_payload(
                target(item_id, ExtractionItemStatus::PendingReview, 1),
                serde_json::json!({
                    "entityType": "CHARACTER",
                    "name": "沈砚（雾城）",
                    "description": "第一次进入雾城"
                }),
            )
            .expect("update extraction payload");
        assert_eq!(updated.payload["name"], "沈砚（雾城）");

        let deferred = manager
            .decide_extraction_item(
                target(item_id, ExtractionItemStatus::PendingReview, 2),
                ExtractionItemStatus::Deferred,
            )
            .expect("defer extraction item");
        assert_eq!(deferred.status, ExtractionItemStatus::Deferred);
        assert_eq!(
            manager.list_chapter_extractions(chapter.id).expect("list")[0].status,
            ChapterExtractionProposalStatus::Deferred
        );

        let accepted = manager
            .adopt_extraction_item(
                target(item_id, ExtractionItemStatus::Deferred, 3),
                ExtractionAdoption::Entity(entity_input("沈砚（雾城）")),
            )
            .expect("accept extraction item");
        assert_eq!(accepted.status, ExtractionItemStatus::Accepted);
        assert!(accepted.final_object_id.is_some());
        assert_eq!(accepted.version, 4);
        assert_eq!(
            manager.list_chapter_extractions(chapter.id).expect("list")[0].status,
            ChapterExtractionProposalStatus::Accepted
        );
        assert!(matches!(
            manager.decide_extraction_item(
                target(item_id, ExtractionItemStatus::PendingReview, 1),
                ExtractionItemStatus::Rejected,
            ),
            Err(ExtractionStoreError::Conflict)
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn adopts_relations_and_events_atomically() {
        let root =
            std::env::temp_dir().join(format!("ainovel-extraction-adopt-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager
            .create(&root, "Extraction adoption test")
            .expect("create project");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".into())
            .expect("create chapter");
        let target = |id| ExtractionItemTarget {
            id,
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            expected_status: ExtractionItemStatus::PendingReview,
            expected_version: 1,
        };
        let revision = manager
            .save_manuscript(
                chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"paragraph-1"},"content":[{"type":"text","text":"沈砚与顾临结盟，当夜进入雾城。"}]}]}"#.into(),
                "TEST".into(),
            )
            .expect("save revision");
        let anchor = EvidenceAnchor {
            id: Uuid::new_v4(),
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            source_revision_id: revision.id,
            block_id: "paragraph-1".into(),
            start_offset: 0,
            end_offset: 10,
            source_version: revision.id.to_string(),
            source_hash: revision.content_hash.clone(),
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        manager
            .create_evidence_anchor(anchor.clone())
            .expect("create evidence anchor");
        let candidate_ids = [Uuid::new_v4(), Uuid::new_v4()];
        let fact_ids = [Uuid::new_v4(), Uuid::new_v4()];
        for index in 0..2 {
            manager
                .create_knowledge_candidate(KnowledgeCandidate {
                    id: candidate_ids[index],
                    project_id: manifest.project_id,
                    chapter_id: chapter.id,
                    proposal_id: None,
                    candidate_status: CandidateStatus::Pending,
                    review_decision: None,
                    reviewer: None,
                    reviewed_at: None,
                    fact: Fact {
                        knowledge_id: fact_ids[index],
                        project_id: manifest.project_id,
                        knowledge_version: 1,
                        subject: if index == 0 { "沈砚" } else { "顾临" }.to_owned(),
                        predicate: if index == 0 { "所属" } else { "所在" }.to_owned(),
                        object: if index == 0 { "衡山" } else { "雾城" }.to_owned(),
                        source_revision_id: revision.id,
                        evidence_anchor_ids: vec![anchor.id],
                        lifecycle_status: KnowledgeLifecycleStatus::NeedsReview,
                        created_by: "tester".into(),
                        created_at: now_timestamp(),
                        updated_at: now_timestamp(),
                    },
                    created_at: now_timestamp(),
                    updated_at: now_timestamp(),
                })
                .expect("create fact candidate");
            manager
                .review_knowledge_candidate(
                    candidate_ids[index],
                    CandidateStatus::Pending,
                    ReviewDecision::Approve,
                    "reviewer".into(),
                )
                .expect("approve fact candidate");
        }
        manager
            .finalize_knowledge_candidates(chapter.id, candidate_ids.to_vec(), "finalizer".into())
            .expect("finalize facts");

        let proposal_id = Uuid::new_v4();
        let relation_item_id = Uuid::new_v4();
        let event_item_id = Uuid::new_v4();
        let rejected_relation_item_id = Uuid::new_v4();
        manager
            .create_chapter_extraction(
                ChapterExtractionProposal {
                    id: proposal_id,
                    project_id: manifest.project_id,
                    chapter_id: chapter.id,
                    source_revision_id: revision.id,
                    ai_run_id: None,
                    status: ChapterExtractionProposalStatus::PendingReview,
                    items: vec![
                        ChapterExtractionItem {
                            id: relation_item_id,
                            proposal_id,
                            kind: ExtractionItemKind::Relation,
                            payload: serde_json::json!({
                                "fromKnowledgeId": fact_ids[0].to_string(),
                                "toKnowledgeId": fact_ids[1].to_string(),
                                "fromHint": "沈砚",
                                "toHint": "顾临",
                                "relationType": "盟友"
                            }),
                            evidence_anchor_id: anchor.id,
                            status: ExtractionItemStatus::PendingReview,
                            version: 1,
                            final_object_id: None,
                            created_at: String::new(),
                            updated_at: String::new(),
                        },
                        ChapterExtractionItem {
                            id: event_item_id,
                            proposal_id,
                            kind: ExtractionItemKind::Event,
                            payload: serde_json::json!({
                                "name": "进入雾城",
                                "occurredAt": "当夜",
                                "participantFactIds": [fact_ids[0].to_string(), fact_ids[1].to_string()]
                            }),
                            evidence_anchor_id: anchor.id,
                            status: ExtractionItemStatus::PendingReview,
                            version: 1,
                            final_object_id: None,
                            created_at: String::new(),
                            updated_at: String::new(),
                        },
                        ChapterExtractionItem {
                            id: rejected_relation_item_id,
                            proposal_id,
                            kind: ExtractionItemKind::Relation,
                            payload: serde_json::json!({
                                "fromKnowledgeId": fact_ids[0].to_string(),
                                "toKnowledgeId": Uuid::new_v4().to_string(),
                                "relationType": "无效关系"
                            }),
                            evidence_anchor_id: anchor.id,
                            status: ExtractionItemStatus::PendingReview,
                            version: 1,
                            final_object_id: None,
                            created_at: String::new(),
                            updated_at: String::new(),
                        },
                    ],
                    created_at: String::new(),
                    updated_at: String::new(),
                },
                Vec::new(),
            )
            .expect("create extraction proposal");

        let relation_id = Uuid::new_v4();
        let relation = Relation {
            id: relation_id,
            project_id: manifest.project_id,
            relation_version: 1,
            from_knowledge_id: fact_ids[0],
            to_knowledge_id: fact_ids[1],
            relation_type: "盟友".into(),
            evidence_anchor_ids: vec![
                manager
                    .get_extraction_item(target(relation_item_id))
                    .expect("get relation item")
                    .evidence_anchor_id,
            ],
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "ai-extraction".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        let adopted_relation = manager
            .adopt_extraction_item(
                target(relation_item_id),
                ExtractionAdoption::Relation(relation),
            )
            .expect("adopt relation");
        assert_eq!(adopted_relation.status, ExtractionItemStatus::Accepted);
        assert_eq!(
            adopted_relation.final_object_id.as_deref(),
            Some(relation_id.to_string().as_str())
        );

        let event_id = Uuid::new_v4();
        let event_anchor_id = manager
            .get_extraction_item(target(event_item_id))
            .expect("get event item")
            .evidence_anchor_id;
        let adopted_event = manager
            .adopt_extraction_item(
                target(event_item_id),
                ExtractionAdoption::Event(Event {
                    id: event_id,
                    project_id: manifest.project_id,
                    event_version: 1,
                    name: "进入雾城".into(),
                    occurred_at: "当夜".into(),
                    participant_fact_ids: fact_ids.to_vec(),
                    evidence_anchor_ids: vec![event_anchor_id],
                    lifecycle_status: KnowledgeLifecycleStatus::Active,
                    created_by: "ai-extraction".into(),
                    created_at: now_timestamp(),
                    updated_at: now_timestamp(),
                }),
            )
            .expect("adopt event");
        assert_eq!(adopted_event.status, ExtractionItemStatus::Accepted);
        assert_eq!(manager.list_relations().expect("list relations").len(), 1);
        assert_eq!(manager.list_events().expect("list events").len(), 1);
        assert_eq!(
            manager
                .list_chapter_extractions(chapter.id)
                .expect("list proposals")[0]
                .status,
            ChapterExtractionProposalStatus::PartiallyAccepted
        );

        let failed_relation = Relation {
            id: Uuid::new_v4(),
            project_id: manifest.project_id,
            relation_version: 1,
            from_knowledge_id: fact_ids[0],
            to_knowledge_id: Uuid::new_v4(),
            relation_type: "无效关系".into(),
            evidence_anchor_ids: vec![
                manager
                    .get_extraction_item(target(rejected_relation_item_id))
                    .expect("get rejected item")
                    .evidence_anchor_id,
            ],
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "ai-extraction".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        assert!(matches!(
            manager.adopt_extraction_item(
                target(rejected_relation_item_id),
                ExtractionAdoption::Relation(failed_relation),
            ),
            Err(ExtractionStoreError::Knowledge(
                KnowledgeStoreError::MissingFact(_)
            ))
        ));
        assert_eq!(
            manager
                .get_extraction_item(target(rejected_relation_item_id))
                .expect("get pending item")
                .status,
            ExtractionItemStatus::PendingReview
        );
        assert_eq!(manager.list_relations().expect("list relations").len(), 1);

        let _ = std::fs::remove_dir_all(root);
    }
}
