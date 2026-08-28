use crate::{ApiError, ProjectState};

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn current_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Option<novel_infrastructure::ManuscriptRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .current_manuscript(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    document_json: String,
    creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_manuscript(chapter_id, document_json, creation_reason)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_manuscript_checked(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    base_revision_id: Option<uuid::Uuid>,
    document_json: String,
    creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_manuscript_checked(chapter_id, base_revision_id, document_json, creation_reason)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn merge_manuscript(
    state: tauri::State<'_, ProjectState>,
    base: String,
    current: String,
    draft: String,
) -> Result<novel_infrastructure::MergeResult, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .merge_manuscript(&base, &current, &draft)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_recovery_log(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    document_json: String,
) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_recovery_log(chapter_id, document_json)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_manuscript_revisions(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::ManuscriptRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_manuscript_revisions(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_recovery_logs(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_recovery_logs(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_all_recovery_logs(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_all_recovery_logs().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn clear_recovery_logs(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .clear_recovery_logs(chapter_id)
        .map_err(ApiError::from)
}
