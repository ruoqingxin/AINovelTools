#![allow(clippy::needless_pass_by_value)]

use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError { code: &'static str, message: String }

impl ApiError {
    fn internal(message: impl Into<String>) -> Self { Self { code: "INTERNAL_ERROR", message: message.into() } }
}

impl From<novel_infrastructure::ProjectError> for ApiError {
    fn from(error: novel_infrastructure::ProjectError) -> Self {
        let code = match error { novel_infrastructure::ProjectError::InvalidPath(_) => "INVALID_INPUT", novel_infrastructure::ProjectError::AlreadyExists(_) => "PROJECT_ALREADY_EXISTS", novel_infrastructure::ProjectError::NotInitialized(_) => "PROJECT_NOT_INITIALIZED", novel_infrastructure::ProjectError::Io(_) => "FILE_SYSTEM_ERROR", novel_infrastructure::ProjectError::Manifest(_) => "INVALID_MANIFEST", novel_infrastructure::ProjectError::Database(_) => "DATABASE_ERROR" };
        Self { code, message: error.to_string() }
    }
}

impl From<novel_infrastructure::PlanError> for ApiError {
    fn from(error: novel_infrastructure::PlanError) -> Self {
        let code = match error { novel_infrastructure::PlanError::NoProject => "NO_PROJECT_OPEN", novel_infrastructure::PlanError::EmptyTitle | novel_infrastructure::PlanError::InvalidParentKind | novel_infrastructure::PlanError::Cycle => "INVALID_INPUT", novel_infrastructure::PlanError::MissingParent(_) | novel_infrastructure::PlanError::MissingNode(_) => "NOT_FOUND", novel_infrastructure::PlanError::Conflict { .. } => "VERSION_CONFLICT", novel_infrastructure::PlanError::Database(_) => "DATABASE_ERROR" };
        Self { code, message: error.to_string() }
    }
}

impl From<novel_infrastructure::ManuscriptError> for ApiError {
    fn from(error: novel_infrastructure::ManuscriptError) -> Self {
        let code = match error { novel_infrastructure::ManuscriptError::NoProject => "NO_PROJECT_OPEN", novel_infrastructure::ManuscriptError::MissingChapter(_) => "NOT_FOUND", novel_infrastructure::ManuscriptError::EmptyDocument | novel_infrastructure::ManuscriptError::InvalidDocument(_) => "INVALID_DOCUMENT", novel_infrastructure::ManuscriptError::Conflict { .. } => "VERSION_CONFLICT", novel_infrastructure::ManuscriptError::Database(_) => "DATABASE_ERROR" };
        Self { code, message: error.to_string() }
    }
}

struct ProjectState {
    manager: Mutex<novel_infrastructure::ProjectManager>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapStatus {
    app_version: &'static str,
    layers: [&'static str; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseHealthResponse {
    status: &'static str,
    sqlite_version: String,
    schema_version: i64,
    journal_mode: String,
    foreign_keys_enabled: bool,
}

#[tauri::command]
fn bootstrap_status() -> BootstrapStatus {
    BootstrapStatus {
        app_version: env!("CARGO_PKG_VERSION"),
        layers: novel_infrastructure::linked_layers(),
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn health_query(state: tauri::State<'_, ProjectState>) -> Result<DatabaseHealthResponse, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "database mutex poisoned".to_owned())?;
    let health = match manager.health() {
        Ok(health) => health,
        Err(novel_infrastructure::ProjectError::NotInitialized(_)) => {
            return Ok(DatabaseHealthResponse { status: "NO_PROJECT_OPEN", sqlite_version: String::new(), schema_version: 0, journal_mode: String::new(), foreign_keys_enabled: false });
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(DatabaseHealthResponse {
        status: "PROJECT_HEALTHY",
        sqlite_version: health.sqlite_version,
        schema_version: health.schema_version,
        journal_mode: health.journal_mode,
        foreign_keys_enabled: health.foreign_keys_enabled,
    })
}

#[tauri::command]
fn feature_catalog() -> &'static [novel_infrastructure::FeatureDescriptor] {
    novel_infrastructure::FEATURE_CATALOG
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
    name: String,
) -> Result<novel_infrastructure::ProjectManifest, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create(root, name)
        .map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn open_project(
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
fn close_project(
    state: tauri::State<'_, ProjectState>,
) -> Option<novel_infrastructure::ProjectManifest> {
    state.manager.lock().ok()?.close()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn current_project(
    state: tauri::State<'_, ProjectState>,
) -> Result<Option<novel_infrastructure::ProjectManifest>, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    Ok(manager.current().cloned())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_plan_nodes(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::PlanNode>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_plan_nodes().map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_plan_node(
    state: tauri::State<'_, ProjectState>,
    parent_id: Option<uuid::Uuid>,
    kind: novel_infrastructure::PlanNodeKind,
    title: String,
) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_plan_node(parent_id, kind, title)
        .map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_plan_node(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    title: String,
    archived: bool,
) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .update_plan_node(id, title, archived)
        .map_err(ApiError::from)
}

#[tauri::command]
fn update_plan_node_checked(
    state: tauri::State<'_, ProjectState>, id: uuid::Uuid, title: String, archived: bool, expected_version: i64,
) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.update_plan_node_checked(id, title, archived, expected_version).map_err(ApiError::from)
}

#[tauri::command]
fn move_plan_node(state: tauri::State<'_, ProjectState>, id: uuid::Uuid, parent_id: Option<uuid::Uuid>, expected_version: i64) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.move_plan_node(id, parent_id, expected_version).map_err(ApiError::from)
}

#[tauri::command]
fn current_manuscript(
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
fn save_manuscript(
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
fn save_manuscript_checked(
    state: tauri::State<'_, ProjectState>, chapter_id: uuid::Uuid, base_revision_id: Option<uuid::Uuid>, document_json: String, creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, ApiError> {
    let mut manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.save_manuscript_checked(chapter_id, base_revision_id, document_json, creation_reason).map_err(ApiError::from)
}

#[tauri::command]
fn merge_manuscript(state: tauri::State<'_, ProjectState>, base: String, current: String, draft: String) -> Result<novel_infrastructure::MergeResult, ApiError> {
    let manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.merge_manuscript(&base, &current, &draft).map_err(ApiError::from)
}

#[tauri::command]
fn save_recovery_log(
    state: tauri::State<'_, ProjectState>, chapter_id: uuid::Uuid, document_json: String,
) -> Result<(), ApiError> {
    let mut manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.save_recovery_log(chapter_id, document_json).map_err(ApiError::from)
}

#[tauri::command]
fn list_manuscript_revisions(
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
fn list_recovery_logs(
    state: tauri::State<'_, ProjectState>, chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_recovery_logs(chapter_id).map_err(ApiError::from)
}

#[tauri::command]
fn list_all_recovery_logs(state: tauri::State<'_, ProjectState>) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_all_recovery_logs().map_err(ApiError::from)
}

#[tauri::command]
fn clear_recovery_logs(state: tauri::State<'_, ProjectState>, chapter_id: uuid::Uuid) -> Result<(), ApiError> {
    let mut manager = state.manager.lock().map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.clear_recovery_logs(chapter_id).map_err(ApiError::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the desktop application runtime.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or the application event loop fails.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState {
            manager: Mutex::new(novel_infrastructure::ProjectManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            feature_catalog,
            health_query,
            create_project,
            open_project,
            close_project,
            current_project,
            list_plan_nodes,
            create_plan_node,
            update_plan_node,
            update_plan_node_checked,
            move_plan_node,
            current_manuscript,
            list_manuscript_revisions,
            list_recovery_logs,
            list_all_recovery_logs,
            clear_recovery_logs,
            save_manuscript,
            save_manuscript_checked,
            merge_manuscript,
            save_recovery_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_reports_all_linked_layers() {
        let status = super::bootstrap_status();
        assert_eq!(status.layers, ["domain", "application", "infrastructure"]);
    }
}
