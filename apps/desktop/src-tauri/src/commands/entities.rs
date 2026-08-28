use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn list_entities(
    state: tauri::State<'_, ProjectState>,
    include_archived: bool,
) -> Result<Vec<novel_infrastructure::Entity>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_entities(include_archived)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_entity(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::EntityInput,
) -> Result<novel_infrastructure::Entity, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.upsert_entity(input).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_entity_revisions(
    state: tauri::State<'_, ProjectState>,
    entity_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::EntityRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_entity_revisions(entity_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn set_entity_archived(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    archived: bool,
    expected_version: i64,
) -> Result<novel_infrastructure::Entity, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .set_entity_archived(id, archived, expected_version)
        .map_err(ApiError::from)
}
