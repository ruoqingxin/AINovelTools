use super::*;

#[derive(Debug, Error)]
pub enum KnowledgeStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("knowledge contract failed: {0}")]
    Contract(#[from] KnowledgeContractError),
    #[error("knowledge expansion contract failed: {0}")]
    Expansion(#[from] KnowledgeExpansionError),
    #[error("knowledge candidate does not exist: {0}")]
    MissingCandidate(Uuid),
    #[error("knowledge evidence anchor does not exist: {0}")]
    MissingAnchor(Uuid),
    #[error("source revision does not exist: {0}")]
    MissingSourceRevision(Uuid),
    #[error("knowledge candidate version conflict")]
    Conflict,
    #[error("high-risk knowledge conflict blocks finalization")]
    HighRiskConflict,
    #[error("knowledge candidate list is empty")]
    EmptyCandidates,
    #[error("knowledge database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("knowledge database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl ProjectManager {
    pub fn list_evidence_anchors(&self) -> Result<Vec<EvidenceAnchor>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session
            .database
            .list_evidence_anchors(session.manifest.project_id)
    }

    pub fn list_current_facts(&self) -> Result<Vec<Fact>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session
            .database
            .list_current_facts(session.manifest.project_id)
    }

    pub fn list_relations(&self) -> Result<Vec<Relation>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session.database.list_relations(session.manifest.project_id)
    }

    pub fn list_events(&self) -> Result<Vec<Event>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session.database.list_events(session.manifest.project_id)
    }

    pub fn list_beliefs(&self) -> Result<Vec<Belief>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session.database.list_beliefs(session.manifest.project_id)
    }

    pub fn list_foreshadowings(&self) -> Result<Vec<Foreshadowing>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session
            .database
            .list_foreshadowings(session.manifest.project_id)
    }

    pub fn create_relation(&mut self, relation: Relation) -> Result<Relation, KnowledgeStoreError> {
        relation.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if relation.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session.database.insert_relation(&relation, None)?;
        Ok(relation)
    }

    pub fn update_relation(
        &mut self,
        relation: Relation,
        expected_version: u32,
    ) -> Result<Relation, KnowledgeStoreError> {
        relation.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if relation.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session
            .database
            .insert_relation(&relation, Some(expected_version))?;
        Ok(relation)
    }

    pub fn create_event(&mut self, event: Event) -> Result<Event, KnowledgeStoreError> {
        event.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if event.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session.database.insert_event(&event, None)?;
        Ok(event)
    }

    pub fn update_event(
        &mut self,
        event: Event,
        expected_version: u32,
    ) -> Result<Event, KnowledgeStoreError> {
        event.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if event.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session
            .database
            .insert_event(&event, Some(expected_version))?;
        Ok(event)
    }

    pub fn create_belief(&mut self, belief: Belief) -> Result<Belief, KnowledgeStoreError> {
        belief.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if belief.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session.database.insert_belief(&belief, None)?;
        Ok(belief)
    }

    pub fn update_belief(
        &mut self,
        belief: Belief,
        expected_version: u32,
    ) -> Result<Belief, KnowledgeStoreError> {
        belief.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if belief.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session
            .database
            .insert_belief(&belief, Some(expected_version))?;
        Ok(belief)
    }

    pub fn create_foreshadowing(
        &mut self,
        foreshadowing: Foreshadowing,
    ) -> Result<Foreshadowing, KnowledgeStoreError> {
        foreshadowing.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if foreshadowing.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session
            .database
            .insert_foreshadowing(&foreshadowing, None)?;
        Ok(foreshadowing)
    }

    pub fn update_foreshadowing(
        &mut self,
        foreshadowing: Foreshadowing,
        expected_version: u32,
    ) -> Result<Foreshadowing, KnowledgeStoreError> {
        foreshadowing.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if foreshadowing.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Conflict);
        }
        session
            .database
            .insert_foreshadowing(&foreshadowing, Some(expected_version))?;
        Ok(foreshadowing)
    }

    pub fn create_evidence_anchor(
        &mut self,
        anchor: EvidenceAnchor,
    ) -> Result<EvidenceAnchor, KnowledgeStoreError> {
        anchor.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session.database.insert_evidence_anchor(&anchor)?;
        Ok(anchor)
    }

    pub fn create_knowledge_candidate(
        &mut self,
        candidate: KnowledgeCandidate,
    ) -> Result<KnowledgeCandidate, KnowledgeStoreError> {
        candidate.validate()?;
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        if candidate.project_id != session.manifest.project_id {
            return Err(KnowledgeStoreError::Contract(
                KnowledgeContractError::InvalidCandidateReview,
            ));
        }
        session.database.insert_knowledge_candidate(&candidate)?;
        Ok(candidate)
    }

    pub fn list_knowledge_candidates(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<KnowledgeCandidate>, KnowledgeStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session
            .database
            .list_knowledge_candidates(session.manifest.project_id, chapter_id)
    }

    pub fn detect_candidate_conflicts(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<KnowledgeConflict>, KnowledgeStoreError> {
        let candidates = self.list_knowledge_candidates(chapter_id)?;
        let mut conflicts = Vec::new();
        for (index, left) in candidates.iter().enumerate() {
            for right in candidates.iter().skip(index + 1) {
                if left.fact.subject != right.fact.subject
                    || left.fact.predicate != right.fact.predicate
                {
                    continue;
                }
                if left.fact.object == right.fact.object {
                    conflicts.push(KnowledgeConflict {
                        kind: KnowledgeConflictKind::DuplicateFact,
                        candidate_ids: vec![left.id, right.id],
                        subject: left.fact.subject.clone(),
                        predicate: left.fact.predicate.clone(),
                        objects: vec![left.fact.object.clone()],
                        high_risk: false,
                    });
                } else {
                    conflicts.push(KnowledgeConflict {
                        kind: KnowledgeConflictKind::ContradictoryObject,
                        candidate_ids: vec![left.id, right.id],
                        subject: left.fact.subject.clone(),
                        predicate: left.fact.predicate.clone(),
                        objects: vec![left.fact.object.clone(), right.fact.object.clone()],
                        high_risk: true,
                    });
                }
            }
        }
        Ok(conflicts)
    }

    pub fn finalize_knowledge_candidates(
        &mut self,
        chapter_id: Uuid,
        candidate_ids: Vec<Uuid>,
        actor: String,
    ) -> Result<ChangeSet, KnowledgeStoreError> {
        if candidate_ids.is_empty() {
            return Err(KnowledgeStoreError::EmptyCandidates);
        }
        if actor.trim().is_empty() {
            return Err(KnowledgeStoreError::Contract(
                KnowledgeContractError::EmptyActor,
            ));
        }
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        let project_id = session.manifest.project_id;
        let candidates = session
            .database
            .list_knowledge_candidates(project_id, chapter_id)?;
        let selected = candidates
            .into_iter()
            .filter(|candidate| candidate_ids.contains(&candidate.id))
            .collect::<Vec<_>>();
        if selected.len() != candidate_ids.len()
            || selected.iter().any(|candidate| {
                candidate.candidate_status != CandidateStatus::Approved
                    || candidate.chapter_id != chapter_id
            })
        {
            return Err(KnowledgeStoreError::Conflict);
        }
        let conflicts = detect_conflicts(&selected);
        if conflicts.iter().any(|conflict| conflict.high_risk) {
            return Err(KnowledgeStoreError::HighRiskConflict);
        }
        session
            .database
            .finalize_candidates(project_id, chapter_id, selected, actor)
    }

    pub fn rebuild_world_state(
        &mut self,
        actor: String,
    ) -> Result<WorldState, KnowledgeStoreError> {
        if actor.trim().is_empty() {
            return Err(KnowledgeStoreError::Contract(
                KnowledgeContractError::EmptyActor,
            ));
        }
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session
            .database
            .rebuild_world_state(session.manifest.project_id, actor)
    }

    pub fn review_knowledge_candidate(
        &mut self,
        id: Uuid,
        expected_status: CandidateStatus,
        decision: ReviewDecision,
        reviewer: String,
    ) -> Result<KnowledgeCandidate, KnowledgeStoreError> {
        if reviewer.trim().is_empty() {
            return Err(KnowledgeStoreError::Contract(
                KnowledgeContractError::EmptyActor,
            ));
        }
        let session = self
            .current
            .as_mut()
            .ok_or(KnowledgeStoreError::NoProject)?;
        session.database.review_knowledge_candidate(
            session.manifest.project_id,
            id,
            expected_status,
            decision,
            reviewer,
        )
    }
}

impl Database {
    fn list_evidence_anchors(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<EvidenceAnchor>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, chapter_id, source_revision_id, block_id, start_offset,
                    end_offset, source_version, source_hash, lifecycle_status, created_by,
                    created_at, updated_at
             FROM evidence_anchors WHERE project_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([project_id.to_string()], map_evidence_anchor)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn list_current_facts(&self, project_id: Uuid) -> Result<Vec<Fact>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT f.knowledge_id, f.project_id, f.knowledge_version, f.subject, f.predicate,
                    f.object, f.source_revision_id, f.evidence_anchor_ids_json,
                    f.lifecycle_status, f.created_by, f.created_at, f.updated_at
             FROM facts f JOIN fact_current_versions current
               ON current.knowledge_id = f.knowledge_id
              AND current.knowledge_version = f.knowledge_version
             WHERE f.project_id = ?1 ORDER BY f.created_at DESC",
        )?;
        let rows = statement.query_map([project_id.to_string()], map_fact)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn list_relations(&self, project_id: Uuid) -> Result<Vec<Relation>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare("SELECT id, project_id, relation_version, from_knowledge_id, to_knowledge_id, relation_type, evidence_anchor_ids_json, lifecycle_status, created_by, created_at, updated_at FROM relations value WHERE project_id = ?1 AND relation_version = (SELECT MAX(current.relation_version) FROM relations current WHERE current.id = value.id AND current.project_id = value.project_id) ORDER BY created_at DESC")?;
        let rows = statement.query_map([project_id.to_string()], map_relation)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn list_events(&self, project_id: Uuid) -> Result<Vec<Event>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare("SELECT id, project_id, event_version, name, occurred_at, participant_fact_ids_json, evidence_anchor_ids_json, lifecycle_status, created_by, created_at, updated_at FROM events value WHERE project_id = ?1 AND event_version = (SELECT MAX(current.event_version) FROM events current WHERE current.id = value.id AND current.project_id = value.project_id) ORDER BY created_at DESC")?;
        let rows = statement.query_map([project_id.to_string()], map_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn list_beliefs(&self, project_id: Uuid) -> Result<Vec<Belief>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare("SELECT id, project_id, belief_version, holder_knowledge_id, proposition, evidence_anchor_ids_json, lifecycle_status, created_by, created_at, updated_at FROM beliefs value WHERE project_id = ?1 AND belief_version = (SELECT MAX(current.belief_version) FROM beliefs current WHERE current.id = value.id AND current.project_id = value.project_id) ORDER BY created_at DESC")?;
        let rows = statement.query_map([project_id.to_string()], map_belief)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn list_foreshadowings(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<Foreshadowing>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare("SELECT id, project_id, foreshadowing_version, title, target_chapter_id, status, evidence_anchor_ids_json, lifecycle_status, created_by, created_at, updated_at FROM foreshadowings value WHERE project_id = ?1 AND foreshadowing_version = (SELECT MAX(current.foreshadowing_version) FROM foreshadowings current WHERE current.id = value.id AND current.project_id = value.project_id) ORDER BY created_at DESC")?;
        let rows = statement.query_map([project_id.to_string()], map_foreshadowing)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn ensure_anchors(
        tx: &rusqlite::Transaction<'_>,
        project_id: Uuid,
        ids: &[Uuid],
    ) -> Result<String, KnowledgeStoreError> {
        let json = serde_json::to_string(ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        for id in ids {
            let found: Option<String> = tx
                .query_row(
                    "SELECT id FROM evidence_anchors WHERE id = ?1 AND project_id = ?2 AND lifecycle_status = 'ACTIVE'",
                    rusqlite::params![id.to_string(), project_id.to_string()],
                    |row| row.get(0),
                )
                .optional()?;
            if found.is_none() {
                return Err(KnowledgeStoreError::MissingAnchor(*id));
            }
        }
        Ok(json)
    }

    fn insert_relation(
        &mut self,
        value: &Relation,
        expected_version: Option<u32>,
    ) -> Result<(), KnowledgeStoreError> {
        let tx = self.connection.transaction()?;
        ensure_next_version(
            &tx,
            "relations",
            "relation_version",
            value.id,
            value.project_id,
            value.relation_version,
            expected_version,
        )?;
        let anchors = Self::ensure_anchors(&tx, value.project_id, &value.evidence_anchor_ids)?;
        tx.execute(
            "INSERT INTO relations (id, project_id, relation_version, from_knowledge_id, to_knowledge_id, relation_type, evidence_anchor_ids_json, lifecycle_status, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![value.id.to_string(), value.project_id.to_string(), value.relation_version, value.from_knowledge_id.to_string(), value.to_knowledge_id.to_string(), value.relation_type, anchors, knowledge_lifecycle_str(value.lifecycle_status), value.created_by],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_event(
        &mut self,
        value: &Event,
        expected_version: Option<u32>,
    ) -> Result<(), KnowledgeStoreError> {
        let tx = self.connection.transaction()?;
        ensure_next_version(
            &tx,
            "events",
            "event_version",
            value.id,
            value.project_id,
            value.event_version,
            expected_version,
        )?;
        let anchors = Self::ensure_anchors(&tx, value.project_id, &value.evidence_anchor_ids)?;
        let participants = serde_json::to_string(&value.participant_fact_ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        tx.execute(
            "INSERT INTO events (id, project_id, event_version, name, occurred_at, participant_fact_ids_json, evidence_anchor_ids_json, lifecycle_status, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![value.id.to_string(), value.project_id.to_string(), value.event_version, value.name, value.occurred_at, participants, anchors, knowledge_lifecycle_str(value.lifecycle_status), value.created_by],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_belief(
        &mut self,
        value: &Belief,
        expected_version: Option<u32>,
    ) -> Result<(), KnowledgeStoreError> {
        let tx = self.connection.transaction()?;
        ensure_next_version(
            &tx,
            "beliefs",
            "belief_version",
            value.id,
            value.project_id,
            value.belief_version,
            expected_version,
        )?;
        let anchors = Self::ensure_anchors(&tx, value.project_id, &value.evidence_anchor_ids)?;
        tx.execute(
            "INSERT INTO beliefs (id, project_id, belief_version, holder_knowledge_id, proposition, evidence_anchor_ids_json, lifecycle_status, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![value.id.to_string(), value.project_id.to_string(), value.belief_version, value.holder_knowledge_id.to_string(), value.proposition, anchors, knowledge_lifecycle_str(value.lifecycle_status), value.created_by],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_foreshadowing(
        &mut self,
        value: &Foreshadowing,
        expected_version: Option<u32>,
    ) -> Result<(), KnowledgeStoreError> {
        let tx = self.connection.transaction()?;
        ensure_next_version(
            &tx,
            "foreshadowings",
            "foreshadowing_version",
            value.id,
            value.project_id,
            value.foreshadowing_version,
            expected_version,
        )?;
        let anchors = Self::ensure_anchors(&tx, value.project_id, &value.evidence_anchor_ids)?;
        tx.execute(
            "INSERT INTO foreshadowings (id, project_id, foreshadowing_version, title, target_chapter_id, status, evidence_anchor_ids_json, lifecycle_status, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![value.id.to_string(), value.project_id.to_string(), value.foreshadowing_version, value.title, value.target_chapter_id.map(|id| id.to_string()), value.status, anchors, knowledge_lifecycle_str(value.lifecycle_status), value.created_by],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_evidence_anchor(
        &mut self,
        anchor: &EvidenceAnchor,
    ) -> Result<(), KnowledgeStoreError> {
        let tx = self.connection.transaction()?;
        let source_exists: Option<String> = tx
            .query_row(
                "SELECT id FROM manuscript_revisions WHERE id = ?1 AND chapter_id = ?2",
                rusqlite::params![
                    anchor.source_revision_id.to_string(),
                    anchor.chapter_id.to_string()
                ],
                |row| row.get(0),
            )
            .optional()?;
        if source_exists.is_none() {
            return Err(KnowledgeStoreError::MissingSourceRevision(
                anchor.source_revision_id,
            ));
        }
        tx.execute(
            "INSERT INTO evidence_anchors
             (id, project_id, chapter_id, source_revision_id, block_id, start_offset, end_offset,
              source_version, source_hash, lifecycle_status, created_by)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                anchor.id.to_string(),
                anchor.project_id.to_string(),
                anchor.chapter_id.to_string(),
                anchor.source_revision_id.to_string(),
                anchor.block_id,
                i64::from(anchor.start_offset),
                i64::from(anchor.end_offset),
                anchor.source_version,
                anchor.source_hash,
                knowledge_lifecycle_str(anchor.lifecycle_status),
                anchor.created_by,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn insert_knowledge_candidate(
        &mut self,
        candidate: &KnowledgeCandidate,
    ) -> Result<(), KnowledgeStoreError> {
        let evidence_json = serde_json::to_string(&candidate.fact.evidence_anchor_ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let tx = self.connection.transaction()?;
        let source_exists: Option<String> = tx
            .query_row(
                "SELECT id FROM manuscript_revisions WHERE id = ?1 AND chapter_id = ?2",
                rusqlite::params![
                    candidate.fact.source_revision_id.to_string(),
                    candidate.chapter_id.to_string()
                ],
                |row| row.get(0),
            )
            .optional()?;
        if source_exists.is_none() {
            return Err(KnowledgeStoreError::MissingSourceRevision(
                candidate.fact.source_revision_id,
            ));
        }
        for anchor_id in &candidate.fact.evidence_anchor_ids {
            let valid: Option<String> = tx
                .query_row(
                    "SELECT id FROM evidence_anchors
                     WHERE id = ?1 AND project_id = ?2 AND chapter_id = ?3
                       AND lifecycle_status = 'ACTIVE'",
                    rusqlite::params![
                        anchor_id.to_string(),
                        candidate.project_id.to_string(),
                        candidate.chapter_id.to_string()
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            if valid.is_none() {
                return Err(KnowledgeStoreError::MissingAnchor(*anchor_id));
            }
        }
        tx.execute(
            "INSERT INTO knowledge_candidates
             (id, project_id, chapter_id, proposal_id, knowledge_id, knowledge_version,
              subject, predicate, object, source_revision_id, evidence_anchor_ids_json,
              lifecycle_status, created_by, candidate_status, review_decision, reviewer, reviewed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            rusqlite::params![
                candidate.id.to_string(),
                candidate.project_id.to_string(),
                candidate.chapter_id.to_string(),
                candidate.proposal_id.map(|id| id.to_string()),
                candidate.fact.knowledge_id.to_string(),
                i64::from(candidate.fact.knowledge_version),
                candidate.fact.subject,
                candidate.fact.predicate,
                candidate.fact.object,
                candidate.fact.source_revision_id.to_string(),
                evidence_json,
                knowledge_lifecycle_str(candidate.fact.lifecycle_status),
                candidate.fact.created_by,
                candidate_status_str(candidate.candidate_status),
                candidate.review_decision.map(review_decision_str),
                candidate.reviewer,
                candidate.reviewed_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn list_knowledge_candidates(
        &self,
        project_id: Uuid,
        chapter_id: Uuid,
    ) -> Result<Vec<KnowledgeCandidate>, KnowledgeStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, chapter_id, proposal_id, knowledge_id, knowledge_version,
                    subject, predicate, object, source_revision_id, evidence_anchor_ids_json,
                    lifecycle_status, created_by, candidate_status, review_decision,
                    reviewer, reviewed_at, created_at, updated_at
             FROM knowledge_candidates
             WHERE project_id = ?1 AND chapter_id = ?2
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = statement.query_map(
            rusqlite::params![project_id.to_string(), chapter_id.to_string()],
            map_candidate,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(KnowledgeStoreError::from)
    }

    fn review_knowledge_candidate(
        &mut self,
        project_id: Uuid,
        id: Uuid,
        expected_status: CandidateStatus,
        decision: ReviewDecision,
        reviewer: String,
    ) -> Result<KnowledgeCandidate, KnowledgeStoreError> {
        let next_status = match decision {
            ReviewDecision::Approve => CandidateStatus::Approved,
            ReviewDecision::Reject => CandidateStatus::Rejected,
            ReviewDecision::NeedsReview => CandidateStatus::NeedsReview,
        };
        if !expected_status.can_transition_to(next_status) {
            return Err(KnowledgeStoreError::Contract(
                KnowledgeContractError::InvalidCandidateReview,
            ));
        }
        let tx = self.connection.transaction()?;
        let changed = tx.execute(
            "UPDATE knowledge_candidates
             SET candidate_status = ?1, review_decision = ?2, reviewer = ?3,
                 reviewed_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                 updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             WHERE id = ?4 AND project_id = ?5 AND candidate_status = ?6",
            rusqlite::params![
                candidate_status_str(next_status),
                review_decision_str(decision),
                reviewer,
                id.to_string(),
                project_id.to_string(),
                candidate_status_str(expected_status)
            ],
        )?;
        if changed == 0 {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM knowledge_candidates WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![id.to_string(), project_id.to_string()],
                    |row| row.get(0),
                )
                .optional()?;
            return if exists.is_some() {
                Err(KnowledgeStoreError::Conflict)
            } else {
                Err(KnowledgeStoreError::MissingCandidate(id))
            };
        }
        let candidate = tx.query_row(
            "SELECT id, project_id, chapter_id, proposal_id, knowledge_id, knowledge_version,
                    subject, predicate, object, source_revision_id, evidence_anchor_ids_json,
                    lifecycle_status, created_by, candidate_status, review_decision,
                    reviewer, reviewed_at, created_at, updated_at
             FROM knowledge_candidates WHERE id = ?1",
            [id.to_string()],
            map_candidate,
        )?;
        tx.commit()?;
        Ok(candidate)
    }

    fn finalize_candidates(
        &mut self,
        project_id: Uuid,
        chapter_id: Uuid,
        candidates: Vec<KnowledgeCandidate>,
        actor: String,
    ) -> Result<ChangeSet, KnowledgeStoreError> {
        let source_revision_id = candidates[0].fact.source_revision_id;
        let change_set_id = Uuid::new_v4();
        let candidate_ids = candidates
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>();
        let candidate_ids_json = serde_json::to_string(&candidate_ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO change_sets
             (id, project_id, chapter_id, source_revision_id, status, candidate_ids_json, created_by)
             VALUES (?1,?2,?3,?4,'FINALIZED',?5,?6)",
            rusqlite::params![
                change_set_id.to_string(),
                project_id.to_string(),
                chapter_id.to_string(),
                source_revision_id.to_string(),
                candidate_ids_json,
                actor
            ],
        )?;
        for candidate in &candidates {
            let evidence_json = serde_json::to_string(&candidate.fact.evidence_anchor_ids)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let next_version: i64 = tx.query_row(
                "SELECT COALESCE(MAX(knowledge_version), 0) + 1
                     FROM facts WHERE knowledge_id = ?1",
                [candidate.fact.knowledge_id.to_string()],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO facts
                 (knowledge_id, project_id, knowledge_version, subject, predicate, object,
                  source_revision_id, evidence_anchor_ids_json, lifecycle_status, created_by)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ACTIVE',?9)",
                rusqlite::params![
                    candidate.fact.knowledge_id.to_string(),
                    project_id.to_string(),
                    next_version,
                    candidate.fact.subject,
                    candidate.fact.predicate,
                    candidate.fact.object,
                    candidate.fact.source_revision_id.to_string(),
                    evidence_json,
                    actor
                ],
            )?;
            tx.execute(
                "INSERT INTO fact_current_versions (knowledge_id, knowledge_version)
                 VALUES (?1,?2)
                 ON CONFLICT(knowledge_id) DO UPDATE SET knowledge_version = excluded.knowledge_version",
                rusqlite::params![candidate.fact.knowledge_id.to_string(), next_version],
            )?;
            tx.execute(
                "INSERT INTO change_set_items (id, change_set_id, candidate_id, decision)
                 VALUES (?1,?2,?3,'APPROVE')",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    change_set_id.to_string(),
                    candidate.id.to_string()
                ],
            )?;
            tx.execute(
                "UPDATE knowledge_candidates
                 SET candidate_status = 'FINALIZED', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 WHERE id = ?1 AND project_id = ?2 AND candidate_status = 'APPROVED'",
                rusqlite::params![candidate.id.to_string(), project_id.to_string()],
            )?;
        }
        tx.execute(
            "INSERT INTO knowledge_audit_records
             (id, project_id, change_set_id, action, actor, details_json)
             VALUES (?1,?2,?3,'FINALIZE',?4,?5)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                project_id.to_string(),
                change_set_id.to_string(),
                actor,
                serde_json::json!({"candidateCount": candidates.len()}).to_string()
            ],
        )?;
        tx.execute(
            "INSERT INTO knowledge_outbox_events
             (id, project_id, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES (?1,?2,'CHANGE_SET',?3,'KNOWLEDGE_FINALIZED',?4)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                project_id.to_string(),
                change_set_id.to_string(),
                serde_json::json!({"changeSetId": change_set_id, "candidateIds": candidate_ids})
                    .to_string()
            ],
        )?;
        tx.commit()?;
        Ok(ChangeSet {
            id: change_set_id,
            project_id,
            chapter_id,
            source_revision_id,
            status: ChangeSetStatus::Finalized,
            candidate_ids,
            created_by: actor,
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        })
    }

    fn rebuild_world_state(
        &mut self,
        project_id: Uuid,
        actor: String,
    ) -> Result<WorldState, KnowledgeStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT f.knowledge_id, f.knowledge_version, f.subject, f.predicate, f.object
             FROM facts f
             JOIN fact_current_versions current
               ON current.knowledge_id = f.knowledge_id
              AND current.knowledge_version = f.knowledge_version
             WHERE f.project_id = ?1
             ORDER BY f.subject, f.predicate, f.object",
        )?;
        let rows = statement.query_map([project_id.to_string()], |row| {
            let knowledge_id = Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(WorldStateEntry {
                fact_knowledge_id: knowledge_id,
                fact_version: row.get(1)?,
                subject: row.get(2)?,
                predicate: row.get(3)?,
                object: row.get(4)?,
            })
        })?;
        let entries = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let fact_refs = entries
            .iter()
            .map(|entry| (entry.fact_knowledge_id, entry.fact_version))
            .collect::<Vec<_>>();
        let refs_json = serde_json::to_string(&fact_refs)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let entries_json = serde_json::to_string(&entries)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let version_id = Uuid::new_v4();
        let state_id = Uuid::new_v4();
        let tx = self.connection.transaction()?;
        let next_version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_versions WHERE project_id = ?1",
            [project_id.to_string()],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO knowledge_versions (id, project_id, version, fact_refs_json, created_by)
             VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                version_id.to_string(),
                project_id.to_string(),
                next_version,
                refs_json,
                actor
            ],
        )?;
        tx.execute(
            "INSERT INTO world_states (id, project_id, knowledge_version_id, entries_json)
             VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                state_id.to_string(),
                project_id.to_string(),
                version_id.to_string(),
                entries_json
            ],
        )?;
        tx.commit()?;
        Ok(WorldState {
            id: state_id,
            project_id,
            knowledge_version_id: version_id,
            entries,
            created_at: now_timestamp(),
        })
    }
}

fn knowledge_lifecycle_str(value: KnowledgeLifecycleStatus) -> &'static str {
    match value {
        KnowledgeLifecycleStatus::Active => "ACTIVE",
        KnowledgeLifecycleStatus::NeedsReview => "NEEDS_REVIEW",
        KnowledgeLifecycleStatus::Archived => "ARCHIVED",
    }
}

fn candidate_status_str(value: CandidateStatus) -> &'static str {
    match value {
        CandidateStatus::Pending => "PENDING",
        CandidateStatus::NeedsReview => "NEEDS_REVIEW",
        CandidateStatus::Approved => "APPROVED",
        CandidateStatus::Rejected => "REJECTED",
        CandidateStatus::Finalized => "FINALIZED",
    }
}

fn review_decision_str(value: ReviewDecision) -> &'static str {
    match value {
        ReviewDecision::Approve => "APPROVE",
        ReviewDecision::Reject => "REJECT",
        ReviewDecision::NeedsReview => "NEEDS_REVIEW",
    }
}

fn map_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeCandidate> {
    let parse_uuid = |index: usize| -> rusqlite::Result<Uuid> {
        Uuid::parse_str(&row.get::<_, String>(index)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    };
    let project_id = parse_uuid(1)?;
    let chapter_id = parse_uuid(2)?;
    let knowledge_id = parse_uuid(4)?;
    let source_revision_id = parse_uuid(9)?;
    let evidence_anchor_ids: Vec<Uuid> =
        serde_json::from_str(&row.get::<_, String>(10)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(KnowledgeCandidate {
        id: parse_uuid(0)?,
        project_id,
        chapter_id,
        proposal_id: row
            .get::<_, Option<String>>(3)?
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
        candidate_status: match row.get::<_, String>(13)?.as_str() {
            "NEEDS_REVIEW" => CandidateStatus::NeedsReview,
            "APPROVED" => CandidateStatus::Approved,
            "REJECTED" => CandidateStatus::Rejected,
            "FINALIZED" => CandidateStatus::Finalized,
            _ => CandidateStatus::Pending,
        },
        review_decision: match row.get::<_, Option<String>>(14)?.as_deref() {
            Some("APPROVE") => Some(ReviewDecision::Approve),
            Some("REJECT") => Some(ReviewDecision::Reject),
            Some("NEEDS_REVIEW") => Some(ReviewDecision::NeedsReview),
            _ => None,
        },
        reviewer: row.get(15)?,
        reviewed_at: row.get(16)?,
        fact: Fact {
            knowledge_id,
            project_id,
            knowledge_version: row.get(5)?,
            subject: row.get(6)?,
            predicate: row.get(7)?,
            object: row.get(8)?,
            source_revision_id,
            evidence_anchor_ids,
            lifecycle_status: match row.get::<_, String>(11)?.as_str() {
                "ACTIVE" => KnowledgeLifecycleStatus::Active,
                "ARCHIVED" => KnowledgeLifecycleStatus::Archived,
                _ => KnowledgeLifecycleStatus::NeedsReview,
            },
            created_by: row.get(12)?,
            created_at: row.get(17)?,
            updated_at: row.get(18)?,
        },
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn detect_conflicts(candidates: &[KnowledgeCandidate]) -> Vec<KnowledgeConflict> {
    let mut conflicts = Vec::new();
    for (index, left) in candidates.iter().enumerate() {
        for right in candidates.iter().skip(index + 1) {
            if left.fact.subject != right.fact.subject
                || left.fact.predicate != right.fact.predicate
            {
                continue;
            }
            if left.fact.object == right.fact.object {
                conflicts.push(KnowledgeConflict {
                    kind: KnowledgeConflictKind::DuplicateFact,
                    candidate_ids: vec![left.id, right.id],
                    subject: left.fact.subject.clone(),
                    predicate: left.fact.predicate.clone(),
                    objects: vec![left.fact.object.clone()],
                    high_risk: false,
                });
            } else {
                conflicts.push(KnowledgeConflict {
                    kind: KnowledgeConflictKind::ContradictoryObject,
                    candidate_ids: vec![left.id, right.id],
                    subject: left.fact.subject.clone(),
                    predicate: left.fact.predicate.clone(),
                    objects: vec![left.fact.object.clone(), right.fact.object.clone()],
                    high_risk: true,
                });
            }
        }
    }
    conflicts
}

fn ensure_next_version(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    version_column: &str,
    id: Uuid,
    project_id: Uuid,
    next_version: u32,
    expected_version: Option<u32>,
) -> Result<(), KnowledgeStoreError> {
    let sql =
        format!("SELECT MAX({version_column}) FROM {table} WHERE id = ?1 AND project_id = ?2");
    let current: Option<u32> = tx.query_row(
        &sql,
        rusqlite::params![id.to_string(), project_id.to_string()],
        |row| row.get(0),
    )?;
    let valid = match expected_version {
        Some(expected) => {
            current == Some(expected) && expected.checked_add(1) == Some(next_version)
        }
        None => current.is_none() && next_version == 1,
    };
    if valid {
        Ok(())
    } else {
        Err(KnowledgeStoreError::Conflict)
    }
}

fn parse_uuid_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&row.get::<_, String>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_uuid_vec(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Vec<Uuid>> {
    serde_json::from_str(&row.get::<_, String>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_lifecycle(value: &str) -> KnowledgeLifecycleStatus {
    match value {
        "ACTIVE" => KnowledgeLifecycleStatus::Active,
        "ARCHIVED" => KnowledgeLifecycleStatus::Archived,
        _ => KnowledgeLifecycleStatus::NeedsReview,
    }
}

fn map_evidence_anchor(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvidenceAnchor> {
    Ok(EvidenceAnchor {
        id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        chapter_id: parse_uuid_column(row, 2)?,
        source_revision_id: parse_uuid_column(row, 3)?,
        block_id: row.get(4)?,
        start_offset: row.get(5)?,
        end_offset: row.get(6)?,
        source_version: row.get(7)?,
        source_hash: row.get(8)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(9)?),
        created_by: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<Fact> {
    Ok(Fact {
        knowledge_id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        knowledge_version: row.get(2)?,
        subject: row.get(3)?,
        predicate: row.get(4)?,
        object: row.get(5)?,
        source_revision_id: parse_uuid_column(row, 6)?,
        evidence_anchor_ids: parse_uuid_vec(row, 7)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(8)?),
        created_by: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_relation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Relation> {
    Ok(Relation {
        id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        relation_version: row.get(2)?,
        from_knowledge_id: parse_uuid_column(row, 3)?,
        to_knowledge_id: parse_uuid_column(row, 4)?,
        relation_type: row.get(5)?,
        evidence_anchor_ids: parse_uuid_vec(row, 6)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(7)?),
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        event_version: row.get(2)?,
        name: row.get(3)?,
        occurred_at: row.get(4)?,
        participant_fact_ids: parse_uuid_vec(row, 5)?,
        evidence_anchor_ids: parse_uuid_vec(row, 6)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(7)?),
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_belief(row: &rusqlite::Row<'_>) -> rusqlite::Result<Belief> {
    Ok(Belief {
        id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        belief_version: row.get(2)?,
        holder_knowledge_id: parse_uuid_column(row, 3)?,
        proposition: row.get(4)?,
        evidence_anchor_ids: parse_uuid_vec(row, 5)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(6)?),
        created_by: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn map_foreshadowing(row: &rusqlite::Row<'_>) -> rusqlite::Result<Foreshadowing> {
    Ok(Foreshadowing {
        id: parse_uuid_column(row, 0)?,
        project_id: parse_uuid_column(row, 1)?,
        foreshadowing_version: row.get(2)?,
        title: row.get(3)?,
        target_chapter_id: row
            .get::<_, Option<String>>(4)?
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
        status: row.get(5)?,
        evidence_anchor_ids: parse_uuid_vec(row, 6)?,
        lifecycle_status: parse_lifecycle(&row.get::<_, String>(7)?),
        created_by: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_lists_and_reviews_candidate_with_source_validation() {
        let root = std::env::temp_dir().join(format!("ainovel-r5-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager.create(&root, "R5 test").expect("create project");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".into())
            .expect("create chapter");
        let revision = manager
            .save_manuscript(
                chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"甲认识乙"}]}]}"#.into(),
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
            end_offset: 3,
            source_version: revision.id.to_string(),
            source_hash: revision.content_hash.clone(),
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        manager
            .create_evidence_anchor(anchor.clone())
            .expect("create anchor");
        let candidate = KnowledgeCandidate {
            id: Uuid::new_v4(),
            project_id: manifest.project_id,
            chapter_id: chapter.id,
            proposal_id: None,
            candidate_status: CandidateStatus::Pending,
            review_decision: None,
            reviewer: None,
            reviewed_at: None,
            fact: Fact {
                knowledge_id: Uuid::new_v4(),
                project_id: manifest.project_id,
                knowledge_version: 1,
                subject: "甲".into(),
                predicate: "认识".into(),
                object: "乙".into(),
                source_revision_id: revision.id,
                evidence_anchor_ids: vec![anchor.id],
                lifecycle_status: KnowledgeLifecycleStatus::NeedsReview,
                created_by: "tester".into(),
                created_at: now_timestamp(),
                updated_at: now_timestamp(),
            },
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        manager
            .create_knowledge_candidate(candidate.clone())
            .expect("create candidate");
        let mut contradictory = candidate.clone();
        contradictory.id = Uuid::new_v4();
        contradictory.fact.knowledge_id = Uuid::new_v4();
        contradictory.fact.object = "丙".into();
        manager
            .create_knowledge_candidate(contradictory)
            .expect("create contradictory candidate");
        let listed = manager
            .list_knowledge_candidates(chapter.id)
            .expect("list candidates");
        assert_eq!(listed.len(), 2);
        let conflicts = manager
            .detect_candidate_conflicts(chapter.id)
            .expect("detect conflicts");
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].high_risk);
        let reviewed = manager
            .review_knowledge_candidate(
                candidate.id,
                CandidateStatus::Pending,
                ReviewDecision::Approve,
                "reviewer".into(),
            )
            .expect("review candidate");
        assert_eq!(reviewed.candidate_status, CandidateStatus::Approved);
        let change_set = manager
            .finalize_knowledge_candidates(chapter.id, vec![candidate.id], "finalizer".into())
            .expect("finalize candidate");
        assert_eq!(change_set.status, ChangeSetStatus::Finalized);
        let world_state = manager
            .rebuild_world_state("projector".into())
            .expect("rebuild world state");
        assert_eq!(world_state.entries.len(), 1);
        assert_eq!(world_state.entries[0].object, "乙");
        assert!(matches!(
            manager.review_knowledge_candidate(
                candidate.id,
                CandidateStatus::Pending,
                ReviewDecision::Reject,
                "other".into()
            ),
            Err(KnowledgeStoreError::Conflict)
        ));
        let relation_id = Uuid::new_v4();
        let relation = Relation {
            id: relation_id,
            project_id: manifest.project_id,
            relation_version: 1,
            from_knowledge_id: candidate.fact.knowledge_id,
            to_knowledge_id: candidate.fact.knowledge_id,
            relation_type: "同盟".into(),
            evidence_anchor_ids: vec![anchor.id],
            lifecycle_status: KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        };
        manager
            .create_relation(relation.clone())
            .expect("create relation");
        let mut revised_relation = relation.clone();
        revised_relation.relation_version = 2;
        revised_relation.relation_type = "师徒".into();
        manager
            .update_relation(revised_relation.clone(), 1)
            .expect("append relation version");
        let current_relations = manager.list_relations().expect("list current relations");
        assert_eq!(current_relations.len(), 1);
        assert_eq!(current_relations[0].relation_version, 2);
        assert_eq!(current_relations[0].relation_type, "师徒");
        assert!(matches!(
            manager.update_relation(revised_relation, 1),
            Err(KnowledgeStoreError::Conflict)
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
