use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn create_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
    name: String,
) -> Result<novel_infrastructure::ProjectManifest, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.create(root, name).map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn open_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
) -> Result<novel_infrastructure::ProjectManifest, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.open(root).map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn close_project(
    state: tauri::State<'_, ProjectState>,
) -> Option<novel_infrastructure::ProjectManifest> {
    state.manager.lock().ok()?.close()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn current_project(
    state: tauri::State<'_, ProjectState>,
) -> Result<Option<novel_infrastructure::ProjectManifest>, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    Ok(manager.current().cloned())
}
