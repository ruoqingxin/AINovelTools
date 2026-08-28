#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::Emitter;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    code: &'static str,
    message: String,
}

impl ApiError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: message.into(),
        }
    }
}

impl From<novel_infrastructure::ProjectError> for ApiError {
    fn from(error: novel_infrastructure::ProjectError) -> Self {
        let code = match error {
            novel_infrastructure::ProjectError::InvalidPath(_) => "INVALID_INPUT",
            novel_infrastructure::ProjectError::AlreadyExists(_) => "PROJECT_ALREADY_EXISTS",
            novel_infrastructure::ProjectError::NotInitialized(_) => "PROJECT_NOT_INITIALIZED",
            novel_infrastructure::ProjectError::Io(_) => "FILE_SYSTEM_ERROR",
            novel_infrastructure::ProjectError::Manifest(_) => "INVALID_MANIFEST",
            novel_infrastructure::ProjectError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::PlanError> for ApiError {
    fn from(error: novel_infrastructure::PlanError) -> Self {
        let code = match error {
            novel_infrastructure::PlanError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::PlanError::EmptyTitle
            | novel_infrastructure::PlanError::InvalidParentKind
            | novel_infrastructure::PlanError::Cycle => "INVALID_INPUT",
            novel_infrastructure::PlanError::MissingParent(_)
            | novel_infrastructure::PlanError::MissingNode(_) => "NOT_FOUND",
            novel_infrastructure::PlanError::Conflict { .. } => "VERSION_CONFLICT",
            novel_infrastructure::PlanError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::ManuscriptError> for ApiError {
    fn from(error: novel_infrastructure::ManuscriptError) -> Self {
        let code = match error {
            novel_infrastructure::ManuscriptError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::ManuscriptError::MissingChapter(_) => "NOT_FOUND",
            novel_infrastructure::ManuscriptError::EmptyDocument
            | novel_infrastructure::ManuscriptError::InvalidDocument(_) => "INVALID_DOCUMENT",
            novel_infrastructure::ManuscriptError::Conflict { .. } => "VERSION_CONFLICT",
            novel_infrastructure::ManuscriptError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::EntityStoreError> for ApiError {
    fn from(error: novel_infrastructure::EntityStoreError) -> Self {
        let code = match error {
            novel_infrastructure::EntityStoreError::NoProject => "NO_PROJECT_OPEN",
            novel_infrastructure::EntityStoreError::MissingEntity(_)
            | novel_infrastructure::EntityStoreError::MissingRevision(_) => "NOT_FOUND",
            novel_infrastructure::EntityStoreError::Contract(
                novel_infrastructure::EntityError::Conflict { .. },
            ) => "VERSION_CONFLICT",
            novel_infrastructure::EntityStoreError::Contract(_) => "INVALID_INPUT",
            novel_infrastructure::EntityStoreError::Sqlite(_)
            | novel_infrastructure::EntityStoreError::Database(_) => "DATABASE_ERROR",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<novel_infrastructure::AiError> for ApiError {
    fn from(error: novel_infrastructure::AiError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

struct ProjectState {
    manager: Mutex<novel_infrastructure::ProjectManager>,
    gateway: novel_infrastructure::ModelGateway,
    embedding_gateway: novel_infrastructure::EmbeddingGateway,
    ai_cancellations: Mutex<HashMap<uuid::Uuid, Arc<AtomicBool>>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiStreamChunk {
    task_id: uuid::Uuid,
    chunk: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiTaskStarted {
    task_id: uuid::Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConnectionResponse {
    capability: novel_infrastructure::ModelCapability,
    provider: novel_infrastructure::ModelProvider,
    model_id: String,
    detail: String,
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
    status: &'static str,
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
fn feature_catalog() -> &'static [novel_infrastructure::FeatureDescriptor] {
    novel_infrastructure::FEATURE_CATALOG
}

#[tauri::command]
fn list_entities(
    state: tauri::State<'_, ProjectState>,
    include_archived: bool,
) -> Result<Vec<novel_infrastructure::Entity>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_entities(include_archived)
        .map_err(ApiError::from)
}

#[tauri::command]
fn upsert_entity(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::EntityInput,
) -> Result<novel_infrastructure::Entity, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.upsert_entity(input).map_err(ApiError::from)
}

#[tauri::command]
fn list_entity_revisions(
    state: tauri::State<'_, ProjectState>,
    entity_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::EntityRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_entity_revisions(entity_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn set_entity_archived(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    archived: bool,
    expected_version: i64,
) -> Result<novel_infrastructure::Entity, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .set_entity_archived(id, archived, expected_version)
        .map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
    name: String,
) -> Result<novel_infrastructure::ProjectManifest, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.create(root, name).map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn open_project(
    state: tauri::State<'_, ProjectState>,
    root: String,
) -> Result<novel_infrastructure::ProjectManifest, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.open(root).map_err(ApiError::from)
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
) -> Result<Vec<novel_infrastructure::PlanNode>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_plan_nodes().map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_plan_node(
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
fn update_plan_node(
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
fn update_plan_node_checked(
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
fn move_plan_node(
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

#[tauri::command]
fn current_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Option<novel_infrastructure::ManuscriptRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .current_manuscript(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn save_manuscript(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    document_json: String,
    creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_manuscript(chapter_id, document_json, creation_reason)
        .map_err(ApiError::from)
}

#[tauri::command]
fn save_manuscript_checked(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    base_revision_id: Option<uuid::Uuid>,
    document_json: String,
    creation_reason: String,
) -> Result<novel_infrastructure::ManuscriptRevision, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_manuscript_checked(chapter_id, base_revision_id, document_json, creation_reason)
        .map_err(ApiError::from)
}

#[tauri::command]
fn merge_manuscript(
    state: tauri::State<'_, ProjectState>,
    base: String,
    current: String,
    draft: String,
) -> Result<novel_infrastructure::MergeResult, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .merge_manuscript(&base, &current, &draft)
        .map_err(ApiError::from)
}

#[tauri::command]
fn save_recovery_log(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
    document_json: String,
) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_recovery_log(chapter_id, document_json)
        .map_err(ApiError::from)
}

#[tauri::command]
fn list_manuscript_revisions(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::ManuscriptRevision>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_manuscript_revisions(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn list_recovery_logs(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_recovery_logs(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn list_all_recovery_logs(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::RecoveryLog>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_all_recovery_logs().map_err(ApiError::from)
}

#[tauri::command]
fn clear_recovery_logs(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<(), ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .clear_recovery_logs(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn list_model_profiles(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::ModelProfile>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_model_profiles().map_err(ApiError::from)
}

#[tauri::command]
fn upsert_model_profile(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ModelProfileInput,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.upsert_model_profile(input).map_err(ApiError::from)
}

#[tauri::command]
fn save_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    secret: String,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = novel_infrastructure::SecretStore::secret_ref(profile_id);
    novel_infrastructure::SecretStore::set(&secret_ref, &secret).map_err(ApiError::from)?;
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    match manager.set_model_profile_secret_ref(profile_id, Some(&secret_ref)) {
        Ok(profile) => Ok(profile),
        Err(error) => {
            let _ = novel_infrastructure::SecretStore::delete(&secret_ref);
            Err(ApiError::from(error))
        }
    }
}

#[tauri::command]
fn delete_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .get_model_profile(profile_id)
            .map_err(ApiError::from)?
            .secret_ref
    };
    if let Some(secret_ref) = secret_ref {
        novel_infrastructure::SecretStore::delete(&secret_ref).map_err(ApiError::from)?;
    }
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .set_model_profile_secret_ref(profile_id, None)
        .map_err(ApiError::from)
}

#[tauri::command]
async fn test_model_profile(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<ModelConnectionResponse, ApiError> {
    let (mut profile, secret) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let profile = manager
            .get_model_profile(profile_id)
            .map_err(ApiError::from)?;
        let secret_ref = profile
            .secret_ref
            .as_deref()
            .ok_or(novel_infrastructure::AiError::MissingSecret)
            .map_err(ApiError::from)?;
        let secret = novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
        (profile, secret)
    };
    let detail = match profile.capability {
        novel_infrastructure::ModelCapability::Chat => {
            profile.max_output_tokens = profile.max_output_tokens.min(16);
            let context = novel_application::ContextPackage::connection_test();
            state
                .gateway
                .generate(
                    &profile,
                    Some(&secret),
                    &context,
                    false,
                    Arc::new(AtomicBool::new(false)),
                    |_| {},
                )
                .await
                .map_err(ApiError::from)?;
            "聊天请求成功".to_owned()
        }
        novel_infrastructure::ModelCapability::Embedding => {
            let vector = state
                .embedding_gateway
                .embed(&profile, &secret, "连接测试")
                .await
                .map_err(ApiError::from)?;
            format!("Embedding 请求成功，返回 {} 维向量", vector.len())
        }
    };
    Ok(ModelConnectionResponse {
        capability: profile.capability,
        provider: profile.provider,
        model_id: profile.model_id,
        detail,
    })
}

#[tauri::command]
fn list_ai_proposals(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::AiProposal>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_ai_proposals(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
fn decide_ai_proposal(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    status: novel_infrastructure::AiProposalStatus,
    accepted_text: Option<String>,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .decide_ai_proposal(id, status, accepted_text)
        .map_err(ApiError::from)
}

#[tauri::command]
fn cancel_ai_task(
    state: tauri::State<'_, ProjectState>,
    task_id: uuid::Uuid,
) -> Result<(), ApiError> {
    let cancellations = state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?;
    let flag = cancellations.get(&task_id).ok_or_else(|| ApiError {
        code: "NOT_FOUND",
        message: "AI task is not running".to_owned(),
    })?;
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn generate_ai_proposal(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    action: novel_infrastructure::AiAction,
    chapter_title: String,
    chapter_plan: String,
    document_json: String,
    selection: Option<String>,
    instruction: Option<String>,
    stream: bool,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let (profile, target_revision_id) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let profile = manager
            .get_model_profile(profile_id)
            .map_err(ApiError::from)?;
        let revision = manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?;
        (profile, revision.map(|value| value.id))
    };
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let context =
        novel_application::ContextAssembler::assemble(&novel_application::AssembleContextInput {
            chapter_id,
            target_revision_id,
            action,
            chapter_title,
            chapter_plan,
            document_json,
            selection,
            instruction,
            input_token_budget: profile
                .context_window
                .saturating_sub(profile.max_output_tokens)
                .max(256),
        })
        .map_err(|error| ApiError {
            code: "INVALID_INPUT",
            message: error.to_string(),
        })?;
    let secret = match profile.secret_ref.as_deref() {
        Some(secret_ref) => {
            Some(novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?)
        }
        None => {
            return Err(ApiError::from(novel_infrastructure::AiError::MissingSecret));
        }
    };
    let task_id = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .create_ai_task(profile_id, &context)
            .map_err(ApiError::from)?
    };
    let _ = app.emit("ai-task-started", AiTaskStarted { task_id });
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .insert(task_id, Arc::clone(&cancelled));
    let result = state
        .gateway
        .generate(
            &profile,
            secret.as_deref(),
            &context,
            stream,
            Arc::clone(&cancelled),
            |chunk| {
                let _ = app.emit(
                    "ai-task-chunk",
                    AiStreamChunk {
                        task_id,
                        chunk: chunk.to_owned(),
                    },
                );
            },
        )
        .await;
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .remove(&task_id);
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    match result {
        Ok(output) => manager
            .complete_ai_task(task_id, &context, output)
            .map_err(ApiError::from),
        Err(error) => {
            let _ = manager.fail_ai_task(task_id, &error);
            Err(ApiError::from(error))
        }
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
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState {
            manager: Mutex::new(novel_infrastructure::ProjectManager::new()),
            gateway: novel_infrastructure::ModelGateway::default(),
            embedding_gateway: novel_infrastructure::EmbeddingGateway::default(),
            ai_cancellations: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_status,
            feature_catalog,
            health_query,
            list_entities,
            upsert_entity,
            list_entity_revisions,
            set_entity_archived,
            create_project,
            open_project,
            close_project,
            current_project,
            list_plan_nodes,
            create_plan_node,
            update_plan_node,
            update_plan_node_checked,
            move_plan_node,
            current_manuscript,
            list_manuscript_revisions,
            list_recovery_logs,
            list_all_recovery_logs,
            clear_recovery_logs,
            save_manuscript,
            save_manuscript_checked,
            merge_manuscript,
            save_recovery_log,
            list_model_profiles,
            upsert_model_profile,
            save_model_secret,
            delete_model_secret,
            test_model_profile,
            list_ai_proposals,
            decide_ai_proposal,
            generate_ai_proposal,
            cancel_ai_task
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
