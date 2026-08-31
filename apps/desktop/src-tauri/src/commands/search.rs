use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn rebuild_search_index(state: tauri::State<'_, ProjectState>) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.rebuild_search_index().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn search_project(
    state: tauri::State<'_, ProjectState>,
    query: String,
    object_type: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<Vec<novel_infrastructure::SearchResult>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .search_project(query, object_type, limit, offset)
        .map_err(ApiError::from)
}
