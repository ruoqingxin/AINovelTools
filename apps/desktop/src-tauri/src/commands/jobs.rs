use crate::{ApiError, ProjectState};
use std::sync::atomic::Ordering;

#[tauri::command]
pub(crate) fn list_jobs(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::Job>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    let mut jobs = manager
        .list_jobs()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    for job in &mut jobs {
        if matches!(
            job.job_type,
            novel_infrastructure::JobType::AiPlanningGenerate
                | novel_infrastructure::JobType::AiPlanningExtract
        ) && let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&job.payload)
        {
            if let Some(content) = payload.get_mut("referenceContent") {
                let length = content.as_str().map_or(0, |value| value.chars().count());
                *content = serde_json::Value::String(format!("[任务输入已省略，共 {length} 字符]"));
            }
            for key in [
                "systemPromptSnapshot",
                "userPromptSnapshot",
                "finalRequestBody",
            ] {
                if let Some(prompt) = payload.get_mut(key) {
                    let length = prompt.as_str().map_or(0, |value| value.chars().count());
                    *prompt =
                        serde_json::Value::String(format!("[提示词快照已省略，共 {length} 字符]"));
                }
            }
            job.payload = payload.to_string();
        }
    }
    Ok(jobs)
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
pub(crate) fn list_job_events(
    state: tauri::State<'_, ProjectState>,
    job_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::JobEvent>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_job_events(job_id)
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn cancel_job(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
) -> Result<novel_infrastructure::Job, ApiError> {
    if let Some(cancelled) = state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .get(&id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    let job = manager
        .request_job_cancel(id)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let (job_stage, message) = if job.status == novel_infrastructure::JobStatus::Cancelled {
        ("CANCELLED", "排队中的任务已取消")
    } else {
        ("CANCEL_REQUESTED", "已发送取消请求，等待当前模型请求结束")
    };
    let _ = manager.append_job_event(id, job_stage, message, job.progress);
    Ok(job)
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
    let job = manager
        .retry_job(id)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let _ = manager.append_job_event(id, "RETRY", "失败任务已重新进入队列", 0);
    Ok(job)
}

#[tauri::command]
pub(crate) fn acknowledge_failed_jobs(
    state: tauri::State<'_, ProjectState>,
) -> Result<u32, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .acknowledge_failed_jobs()
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
