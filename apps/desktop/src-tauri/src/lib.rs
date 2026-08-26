use std::sync::Mutex;

use serde::Serialize;

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
    let health = manager.health().map_err(|error| error.to_string())?;
    Ok(DatabaseHealthResponse {
        sqlite_version: health.sqlite_version,
        schema_version: health.schema_version,
        journal_mode: health.journal_mode,
        foreign_keys_enabled: health.foreign_keys_enabled,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
    name: String,
) -> Result<novel_infrastructure::ProjectManifest, String> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .create(root, name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn open_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
) -> Result<novel_infrastructure::ProjectManifest, String> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager.open(root).map_err(|error| error.to_string())
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
) -> Result<Vec<novel_infrastructure::PlanNode>, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager.list_plan_nodes().map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_plan_node(
    state: tauri::State<'_, ProjectState>,
    parent_id: Option<uuid::Uuid>,
    kind: novel_infrastructure::PlanNodeKind,
    title: String,
) -> Result<novel_infrastructure::PlanNode, String> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .create_plan_node(parent_id, kind, title)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_plan_node(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    title: String,
    archived: bool,
) -> Result<novel_infrastructure::PlanNode, String> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .update_plan_node(id, title, archived)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn current_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Option<novel_infrastructure::ManuscriptRevision>, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .current_manuscript(chapter_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    document_json: String,
    creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, String> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .save_manuscript(chapter_id, document_json, creation_reason)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_manuscript_revisions(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::ManuscriptRevision>, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "project mutex poisoned".to_owned())?;
    manager
        .list_manuscript_revisions(chapter_id)
        .map_err(|error| error.to_string())
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
            health_query,
            create_project,
            open_project,
            close_project,
            current_project,
            list_plan_nodes,
            create_plan_node,
            update_plan_node,
            current_manuscript,
            list_manuscript_revisions,
            save_manuscript
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
