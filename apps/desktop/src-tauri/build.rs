fn main() {
    if std::env::var_os("CARGO_FEATURE_IPC_CONTRACT").is_some() {
        ipc_build::generate();
    }
    tauri_build::build();
}

#[path = "ipc_build.rs"]
mod ipc_build;
