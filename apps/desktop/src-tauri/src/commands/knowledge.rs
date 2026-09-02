use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn create_relation(
    state: tauri::State<'_, ProjectState>,
    relation: novel_infrastructure::Relation,
) -> Result<novel_infrastructure::Relation, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.create_relation(relation).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_event(
    state: tauri::State<'_, ProjectState>,
    event: novel_infrastructure::Event,
) -> Result<novel_infrastructure::Event, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.create_event(event).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_belief(
    state: tauri::State<'_, ProjectState>,
    belief: novel_infrastructure::Belief,
) -> Result<novel_infrastructure::Belief, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.create_belief(belief).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_foreshadowing(
    state: tauri::State<'_, ProjectState>,
    foreshadowing: novel_infrastructure::Foreshadowing,
) -> Result<novel_infrastructure::Foreshadowing, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_foreshadowing(foreshadowing)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_evidence_anchor(
    state: tauri::State<'_, ProjectState>,
    anchor: novel_infrastructure::EvidenceAnchor,
) -> Result<novel_infrastructure::EvidenceAnchor, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_evidence_anchor(anchor)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_knowledge_candidate(
    state: tauri::State<'_, ProjectState>,
    candidate: novel_infrastructure::KnowledgeCandidate,
) -> Result<novel_infrastructure::KnowledgeCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_knowledge_candidate(candidate)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_knowledge_candidates(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::KnowledgeCandidate>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_knowledge_candidates(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn review_knowledge_candidate(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::CandidateStatus,
    decision: novel_infrastructure::ReviewDecision,
    reviewer: String,
) -> Result<novel_infrastructure::KnowledgeCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .review_knowledge_candidate(id, expected_status, decision, reviewer)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn detect_candidate_conflicts(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::KnowledgeConflict>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .detect_candidate_conflicts(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn finalize_knowledge_candidates(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    candidate_ids: Vec<uuid::Uuid>,
    actor: String,
) -> Result<novel_infrastructure::ChangeSet, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .finalize_knowledge_candidates(chapter_id, candidate_ids, actor)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn rebuild_world_state(
    state: tauri::State<'_, ProjectState>,
    actor: String,
) -> Result<novel_infrastructure::WorldState, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.rebuild_world_state(actor).map_err(ApiError::from)
}
