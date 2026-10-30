use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn get_entity_groups(
    state: tauri::State<'_, ProjectState>,
    project_id: uuid::Uuid,
) -> Result<novel_infrastructure::EntityGroupState, ApiError> {
    state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?
        .get_entity_groups(project_id).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn update_entity_groups(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::UpdateEntityGroupsInput,
) -> Result<novel_infrastructure::EntityGroupState, ApiError> {
    state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?
        .update_entity_groups(input).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn preview_entity_import(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ReviewEntityImportInput,
) -> Result<Vec<novel_infrastructure::EntityImportPreview>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .preview_entity_import(input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn apply_entity_import(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ReviewEntityImportInput,
) -> Result<novel_infrastructure::EntityImportReceipt, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .apply_entity_import(input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn move_entities(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::MoveEntitiesInput,
) -> Result<Vec<novel_infrastructure::Entity>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .move_entities(input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn preview_entity_deletion(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::DeleteEntitiesInput,
) -> Result<Vec<novel_infrastructure::EntityDeletionPreview>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .preview_entity_deletion(&input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn delete_entities(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::DeleteEntitiesInput,
) -> Result<(), ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .delete_entities(input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_entity_cards(
    state: tauri::State<'_, ProjectState>,
    include_archived: bool,
) -> Result<Vec<novel_infrastructure::EntityCard>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_entity_cards(include_archived)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_chapter_entity_references(
    state: tauri::State<'_, ProjectState>,
    project_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
) -> Result<novel_infrastructure::ChapterEntityReferences, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .get_chapter_entity_references(project_id, chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_chapter_entity_references(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ChapterEntitySave,
) -> Result<novel_infrastructure::ChapterEntityReferences, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .save_chapter_entity_references(input)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_entity_chapters(
    state: tauri::State<'_, ProjectState>,
    project_id: uuid::Uuid,
    entity_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::EntityChapter>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_entity_chapters(project_id, entity_id)
        .map_err(ApiError::from)
}

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
pub(crate) fn import_entities(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ImportEntitiesInput,
) -> Result<Vec<novel_infrastructure::Entity>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .import_entities(input)
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
