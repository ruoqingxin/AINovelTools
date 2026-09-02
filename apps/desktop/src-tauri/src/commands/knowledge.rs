use crate::{ApiError, ProjectState};

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
