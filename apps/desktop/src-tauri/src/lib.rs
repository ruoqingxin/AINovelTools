use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapStatus {
    app_version: &'static str,
    layers: [&'static str; 3],
}

#[tauri::command]
fn bootstrap_status() -> BootstrapStatus {
    BootstrapStatus {
        app_version: env!("CARGO_PKG_VERSION"),
        layers: novel_infrastructure::linked_layers(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the desktop application runtime.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or the application event loop fails.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bootstrap_status])
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
