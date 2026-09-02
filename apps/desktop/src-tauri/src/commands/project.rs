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
    let manifest = manager.open(root).map_err(ApiError::from)?;
    let marker = novel_infrastructure::CrashMarker {
        process_type: "desktop".into(),
        session_id: uuid::Uuid::new_v4(),
        occurred_at: chrono_like_now(),
        last_trace_id: None,
        active_project: Some(manifest.project_id),
        active_task: None,
        build_version: env!("CARGO_PKG_VERSION").into(),
        crash_phase: "RUNNING".into(),
    };
    manager
        .write_crash_marker(&marker)
        .map_err(ApiError::from)?;
    Ok(manifest)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn close_project(
    state: tauri::State<'_, ProjectState>,
) -> Option<novel_infrastructure::ProjectManifest> {
    let mut manager = state.manager.lock().ok()?;
    let _ = manager.clear_crash_marker();
    manager.close()
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or_else(|_| "0".into(), |d| d.as_secs().to_string())
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

#[tauri::command]
pub(crate) fn list_recent_projects(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::RecentProject>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.recent_projects().map_err(ApiError::from)
}
