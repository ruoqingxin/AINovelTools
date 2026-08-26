use std::sync::Mutex;

use serde::Serialize;

struct DatabaseState {
    database: Mutex<novel_infrastructure::Database>,
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
fn health_query(state: tauri::State<'_, DatabaseState>) -> Result<DatabaseHealthResponse, String> {
    let database = state
        .database
        .lock()
        .map_err(|_| "database mutex poisoned".to_owned())?;
    let health = database.health().map_err(|error| error.to_string())?;
    Ok(DatabaseHealthResponse {
        sqlite_version: health.sqlite_version,
        schema_version: health.schema_version,
        journal_mode: health.journal_mode,
        foreign_keys_enabled: health.foreign_keys_enabled,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the desktop application runtime.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or the application event loop fails.
pub fn run() {
    let database = novel_infrastructure::Database::in_memory()
        .expect("in-memory SQLite database should initialize");
    tauri::Builder::default()
        .manage(DatabaseState {
            database: Mutex::new(database),
        })
        .invoke_handler(tauri::generate_handler![bootstrap_status, health_query])
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
