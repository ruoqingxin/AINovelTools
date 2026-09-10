use crate::{ApiError, ProjectState};
use sha2::{Digest, Sha256};

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
pub(crate) fn list_planning_sections(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::PlanningSection>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_planning_sections().map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn save_planning_section(
    state: tauri::State<'_, ProjectState>,
    section: novel_infrastructure::PlanningSection,
) -> Result<novel_infrastructure::PlanningSection, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_planning_section(section)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_planning_embeddings(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::PlanningEmbedding>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_planning_embeddings().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) async fn generate_planning_embedding(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    section_id: String,
) -> Result<novel_infrastructure::PlanningEmbedding, ApiError> {
    let section = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .list_planning_sections()
            .map_err(ApiError::from)?
            .into_iter()
            .find(|item| item.id == section_id)
            .ok_or_else(|| ApiError {
                code: "NOT_FOUND",
                message: "作品设定节点不存在".into(),
            })?
    };
    if section.content.trim().is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "请先填写正式设定，再生成向量".into(),
        });
    }
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model profile mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    if profile.capability != novel_infrastructure::ModelCapability::Embedding {
        return Err(ApiError {
            code: "INVALID_PROVIDER_CAPABILITY",
            message: "所选模型不是 Embedding 模型".into(),
        });
    }
    let secret_ref = profile.secret_ref.as_deref().ok_or_else(|| ApiError {
        code: "MISSING_SECRET",
        message: "请先配置 Embedding 模型密钥".into(),
    })?;
    let secret = novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
    let vector = state
        .embedding_gateway
        .embed(&profile, &secret, &section.content)
        .await
        .map_err(ApiError::from)?;
    let content_hash = format!("sha256:{:x}", Sha256::digest(section.content.as_bytes()));
    let embedding = novel_infrastructure::PlanningEmbedding {
        section_id,
        profile_id,
        model_id: profile.model_id,
        dimensions: i64::try_from(vector.len()).unwrap_or(i64::MAX),
        content_hash,
        vector,
        updated_at: String::new(),
    };
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .generate_planning_embedding(embedding)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn clear_planning_embedding(
    state: tauri::State<'_, ProjectState>,
    section_id: String,
) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .clear_planning_embedding(&section_id)
        .map_err(ApiError::from)
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
