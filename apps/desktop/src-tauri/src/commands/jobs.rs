use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn list_jobs(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::Job>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_jobs()
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn enqueue_job(
    state: tauri::State<'_, ProjectState>,
    job_type: novel_infrastructure::JobType,
    payload: String,
) -> Result<novel_infrastructure::Job, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .enqueue_job(job_type, payload)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn cancel_job(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
) -> Result<novel_infrastructure::Job, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .request_job_cancel(id)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn retry_job(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
) -> Result<novel_infrastructure::Job, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .retry_job(id)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn claim_next_job(
    state: tauri::State<'_, ProjectState>,
) -> Result<Option<novel_infrastructure::Job>, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .claim_next_job()
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn run_next_job(
    state: tauri::State<'_, ProjectState>,
) -> Result<Option<novel_infrastructure::Job>, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .run_next_job()
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn health_scan(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::HealthScanReport, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .health_scan()
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn startup_recovery_report(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::StartupRecoveryReport, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.startup_recovery_report().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_diagnostic_package(
    state: tauri::State<'_, ProjectState>,
) -> Result<String, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_diagnostic_package()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(ApiError::from)
}
