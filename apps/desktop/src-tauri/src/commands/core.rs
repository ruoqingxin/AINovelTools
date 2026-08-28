use crate::ProjectState;
use crate::state::{BootstrapStatus, DatabaseHealthResponse};

#[tauri::command]
pub(crate) fn bootstrap_status() -> BootstrapStatus {
    BootstrapStatus {
        app_version: env!("CARGO_PKG_VERSION"),
        layers: novel_infrastructure::linked_layers(),
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn health_query(
    state: tauri::State<'_, ProjectState>,
) -> Result<DatabaseHealthResponse, String> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| "database mutex poisoned".to_owned())?;
    let health = match manager.health() {
        Ok(health) => health,
        Err(novel_infrastructure::ProjectError::NotInitialized(_)) => {
            return Ok(DatabaseHealthResponse {
                status: "NO_PROJECT_OPEN",
                sqlite_version: String::new(),
                schema_version: 0,
                journal_mode: String::new(),
                foreign_keys_enabled: false,
            });
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
pub(crate) fn feature_catalog() -> &'static [novel_infrastructure::FeatureDescriptor] {
    novel_infrastructure::FEATURE_CATALOG
}
