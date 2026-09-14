use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterExtractionItem {
    pub id: Uuid,
    pub proposal_id: Uuid,
    pub kind: ExtractionItemKind,
    pub payload: serde_json::Value,
    pub evidence_anchor_id: Uuid,
    pub status: ExtractionItemStatus,
    pub final_object_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Error)]
pub enum ExtractionStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("extraction candidate does not exist: {0}")]
    MissingItem(Uuid),
    #[error("extraction candidate status conflict")]
    Conflict,
    #[error("extraction candidate has no supported payload")]
    InvalidPayload,
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
            .query_map(rusqlite::params![project_id.to_string(), chapter_id.to_string()], |row| {
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
            })?
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
                    final_object_id, created_at, updated_at
             FROM chapter_extraction_items WHERE proposal_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([proposal_id.to_string()], map_extraction_item)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub(super) fn get_extraction_item(
        &self,
        id: Uuid,
    ) -> Result<Option<ChapterExtractionItem>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT id, proposal_id, kind, payload_json, evidence_anchor_id, status,
                        final_object_id, created_at, updated_at
                 FROM chapter_extraction_items WHERE id = ?1",
                [id.to_string()],
                map_extraction_item,
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    pub(super) fn update_extraction_item_payload(
        &self,
        id: Uuid,
        payload_json: String,
        expected_status: ExtractionItemStatus,
    ) -> Result<ChapterExtractionItem, DatabaseError> {
        let changed = self.connection.execute(
            "UPDATE chapter_extraction_items
             SET payload_json = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?2 AND status = ?3",
            rusqlite::params![payload_json, id.to_string(), expected_status.as_str()],
        )?;
        if changed == 0 {
            return Err(DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        self.get_extraction_item(id)?.ok_or_else(|| {
            DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows)
        })
    }

    pub(super) fn decide_extraction_item(
        &mut self,
        id: Uuid,
        expected_status: ExtractionItemStatus,
        next_status: ExtractionItemStatus,
        final_object_id: Option<String>,
    ) -> Result<ChapterExtractionItem, DatabaseError> {
        let tx = self.connection.transaction()?;
        let changed = tx.execute(
            "UPDATE chapter_extraction_items
             SET status = ?1, final_object_id = COALESCE(?2, final_object_id),
                 updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?3 AND status = ?4",
            rusqlite::params![
                next_status.as_str(),
                final_object_id,
                id.to_string(),
                expected_status.as_str()
            ],
        )?;
        if changed == 0 {
            return Err(DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        }
        let proposal_id: String = tx.query_row(
            "SELECT proposal_id FROM chapter_extraction_items WHERE id = ?1",
            [id.to_string()],
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
        let item = tx.query_row(
            "SELECT id, proposal_id, kind, payload_json, evidence_anchor_id, status,
                    final_object_id, created_at, updated_at
             FROM chapter_extraction_items WHERE id = ?1",
            [id.to_string()],
            map_extraction_item,
        )?;
        tx.commit()?;
        Ok(item)
    }
}

impl ProjectManager {
    pub fn create_chapter_extraction(
        &mut self,
        proposal: ChapterExtractionProposal,
        anchors: Vec<EvidenceAnchor>,
    ) -> Result<ChapterExtractionProposal, ExtractionStoreError> {
        let session = self.current.as_mut().ok_or(ExtractionStoreError::NoProject)?;
        if proposal.project_id != session.manifest.project_id
            || proposal.items.iter().any(|item| item.proposal_id != proposal.id)
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
        let session = self.current.as_ref().ok_or(ExtractionStoreError::NoProject)?;
        Ok(session
            .database
            .list_chapter_extractions(session.manifest.project_id, chapter_id)?)
    }

    pub fn get_extraction_item(
        &self,
        id: Uuid,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        let session = self.current.as_ref().ok_or(ExtractionStoreError::NoProject)?;
        session
            .database
            .get_extraction_item(id)?
            .ok_or(ExtractionStoreError::MissingItem(id))
    }

    pub fn update_extraction_item_payload(
        &mut self,
        id: Uuid,
        payload: serde_json::Value,
        expected_status: ExtractionItemStatus,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        let payload_json = serde_json::to_string(&payload).map_err(|error| {
            ExtractionStoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
        })?;
        let session = self.current.as_mut().ok_or(ExtractionStoreError::NoProject)?;
        Ok(session
            .database
            .update_extraction_item_payload(id, payload_json, expected_status)?)
    }

    pub fn decide_extraction_item(
        &mut self,
        id: Uuid,
        expected_status: ExtractionItemStatus,
        next_status: ExtractionItemStatus,
        final_object_id: Option<String>,
    ) -> Result<ChapterExtractionItem, ExtractionStoreError> {
        if !expected_status.can_transition_to(next_status) {
            return Err(ExtractionStoreError::Conflict);
        }
        let session = self.current.as_mut().ok_or(ExtractionStoreError::NoProject)?;
        session
            .database
            .decide_extraction_item(id, expected_status, next_status, final_object_id)
            .map_err(|error| match error {
                DatabaseError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
                    ExtractionStoreError::Conflict
                }
                other => ExtractionStoreError::Database(other),
            })
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
    fn extraction_candidates_keep_evidence_and_enforce_review_transitions() {
        let root = std::env::temp_dir().join(format!("ainovel-extraction-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager
            .create(&root, "Extraction test")
            .expect("create project");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".into())
            .expect("create chapter");
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
        assert_eq!(listed[0].items[0].status, ExtractionItemStatus::PendingReview);

        let updated = manager
            .update_extraction_item_payload(
                item_id,
                serde_json::json!({
                    "entityType": "CHARACTER",
                    "name": "沈砚（雾城）",
                    "description": "第一次进入雾城"
                }),
                ExtractionItemStatus::PendingReview,
            )
            .expect("update extraction payload");
        assert_eq!(updated.payload["name"], "沈砚（雾城）");

        let deferred = manager
            .decide_extraction_item(
                item_id,
                ExtractionItemStatus::PendingReview,
                ExtractionItemStatus::Deferred,
                None,
            )
            .expect("defer extraction item");
        assert_eq!(deferred.status, ExtractionItemStatus::Deferred);
        assert_eq!(
            manager.list_chapter_extractions(chapter.id).expect("list")[0].status,
            ChapterExtractionProposalStatus::Deferred
        );

        let accepted = manager
            .decide_extraction_item(
                item_id,
                ExtractionItemStatus::Deferred,
                ExtractionItemStatus::Accepted,
                Some("entity-1".into()),
            )
            .expect("accept extraction item");
        assert_eq!(accepted.status, ExtractionItemStatus::Accepted);
        assert_eq!(accepted.final_object_id.as_deref(), Some("entity-1"));
        assert_eq!(
            manager.list_chapter_extractions(chapter.id).expect("list")[0].status,
            ChapterExtractionProposalStatus::Accepted
        );
        assert!(matches!(
            manager.decide_extraction_item(
                item_id,
                ExtractionItemStatus::PendingReview,
                ExtractionItemStatus::Rejected,
                None,
            ),
            Err(ExtractionStoreError::Conflict)
        ));

        let _ = std::fs::remove_dir_all(root);
    }
}
