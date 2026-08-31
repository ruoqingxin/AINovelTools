use crate::{ApiError, ProjectState};

#[tauri::command]
pub(crate) fn list_summary_materials(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::SummaryMaterial>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_summary_materials().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_summary_material(
    state: tauri::State<'_, ProjectState>,
    material: novel_infrastructure::SummaryMaterial,
) -> Result<novel_infrastructure::SummaryMaterial, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .upsert_summary_material(material)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_writing_cards(
    state: tauri::State<'_, ProjectState>,
    card_type: Option<String>,
) -> Result<Vec<novel_infrastructure::WritingCard>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_writing_cards(card_type)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_writing_card(
    state: tauri::State<'_, ProjectState>,
    card: novel_infrastructure::WritingCard,
) -> Result<novel_infrastructure::WritingCard, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.upsert_writing_card(card).map_err(ApiError::from)
}
