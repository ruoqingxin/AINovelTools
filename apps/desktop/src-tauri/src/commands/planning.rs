use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn list_plan_nodes(
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
pub(crate) fn create_plan_node(
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
pub(crate) fn update_plan_node(
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
pub(crate) fn update_plan_node_checked(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    title: String,
    archived: bool,
    expected_version: i64,
) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .update_plan_node_checked(id, title, archived, expected_version)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn move_plan_node(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    parent_id: Option<uuid::Uuid>,
    expected_version: i64,
) -> Result<novel_infrastructure::PlanNode, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .move_plan_node(id, parent_id, expected_version)
        .map_err(ApiError::from)
}
