use crate::state::{AiStreamChunk, AiTaskStarted, ModelConnectionResponse};
use crate::{ApiError, ProjectState};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::Emitter;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractedEntity {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
}

#[tauri::command]
pub(crate) async fn extract_entities_from_text(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    entity_type: novel_infrastructure::EntityType,
    entity_name: String,
    brief_summary: String,
    applicability_scope: String,
    source_text: String,
) -> Result<Vec<ExtractedEntity>, ApiError> {
    let profile = {
        let store = state.model_profiles.lock().map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        return Err(ApiError { code: "INVALID_INPUT", message: "请选择聊天模型配置".to_owned() });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let secret = profile.secret_ref.as_deref().ok_or(novel_infrastructure::AiError::MissingSecret).map_err(ApiError::from)?;
    let secret = novel_infrastructure::SecretStore::get(secret).map_err(ApiError::from)?;
    if entity_name.trim().is_empty() || brief_summary.trim().is_empty() || applicability_scope.trim().is_empty() || source_text.trim().is_empty() {
        return Err(ApiError { code: "INVALID_INPUT", message: "类型、名称、简要概述、适用范围和文件内容都不能为空".to_owned() });
    }
    let topic = format!("{entity_type:?}");
    let mut context = novel_application::ContextPackage::connection_test();
    context.system_prompt = "你是小说知识整理助手。只根据用户提供的文件提炼信息，不得补写文件外事实。".to_owned();
    context.user_prompt = format!("请围绕以下四项定义，从文件中提炼与主题相关的事实和结构化信息。主题类型：{topic}；主题名称：{entity_name}；简要概述：{brief_summary}；适用范围：{applicability_scope}。只提炼文件中有依据的内容，不要扩写。输出严格 JSON 数组，每项包含 name、description、aliases(字符串数组)、tags(字符串数组)，不要 Markdown，不要解释。\n\n文件内容：\n{source_text}");
    context.estimated_input_tokens = (source_text.len() as u32 / 4).min(profile.context_window.saturating_sub(profile.max_output_tokens));
    let output = state.gateway.generate(&profile, Some(&secret), &context, false, true, Arc::new(AtomicBool::new(false)), |_| {}).await.map_err(ApiError::from)?;
    let cleaned = output.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let json = cleaned.find('[').and_then(|start| cleaned.rfind(']').map(|end| &cleaned[start..=end])).unwrap_or(cleaned);
    serde_json::from_str(json).map_err(|_| ApiError { code: "INVALID_RESPONSE", message: "AI 返回的提炼结果不是有效 JSON，请重试".to_owned() })
}

fn sync_model_profile(
    manager: &mut novel_infrastructure::ProjectManager,
    profile: &novel_infrastructure::ModelProfile,
) -> Result<(), ApiError> {
    manager
        .upsert_model_profile(novel_infrastructure::ModelProfileInput {
            id: Some(profile.id),
            name: profile.name.clone(),
            provider: profile.provider,
            capability: profile.capability,
            base_url: profile.base_url.clone(),
            model_id: profile.model_id.clone(),
            context_window: profile.context_window,
            max_output_tokens: profile.max_output_tokens,
            privacy_level: profile.privacy_level,
            timeout_seconds: profile.timeout_seconds,
            retry_limit: profile.retry_limit,
        })
        .map_err(ApiError::from)?;
    manager
        .set_model_profile_secret_ref(profile.id, profile.secret_ref.as_deref())
        .map_err(ApiError::from)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn assemble_context_with_project_knowledge(
    state: tauri::State<'_, ProjectState>,
    input: novel_application::AssembleContextInput,
    object_ids: Option<Vec<uuid::Uuid>>,
) -> Result<novel_application::ContextPackage, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .assemble_context_with_project_knowledge_and_objects(
            &input,
            object_ids.as_deref().unwrap_or_default(),
        )
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn list_model_profiles(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::ModelProfile>, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.list().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_model_profile(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ModelProfileInput,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.upsert(input).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    secret: String,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = novel_infrastructure::SecretStore::secret_ref(profile_id);
    novel_infrastructure::SecretStore::set(&secret_ref, &secret).map_err(ApiError::from)?;
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    match store.set_secret_ref(profile_id, Some(&secret_ref)) {
        Ok(profile) => Ok(profile),
        Err(error) => {
            let _ = novel_infrastructure::SecretStore::delete(&secret_ref);
            Err(ApiError::from(error))
        }
    }
}

#[tauri::command]
pub(crate) fn delete_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?.secret_ref
    };
    if let Some(secret_ref) = secret_ref {
        novel_infrastructure::SecretStore::delete(&secret_ref).map_err(ApiError::from)?;
    }
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store
        .set_secret_ref(profile_id, None)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) async fn test_model_profile(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<ModelConnectionResponse, ApiError> {
    let (mut profile, secret) = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        let profile = store.get(profile_id).map_err(ApiError::from)?;
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
                    true,
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
pub(crate) fn list_ai_proposals(
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
pub(crate) fn decide_ai_proposal(
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
pub(crate) fn cancel_ai_task(
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
#[allow(clippy::too_many_lines)]
pub(crate) async fn generate_ai_proposal(
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
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    let target_revision_id = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let revision = manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?;
        revision.map(|value| value.id)
    };
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let context_input = novel_application::AssembleContextInput {
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
    };
    let context = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .assemble_context_with_project_knowledge(&context_input)
            .map_err(|error| ApiError {
                code: "INVALID_INPUT",
                message: error.to_string(),
            })?
    };
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
        sync_model_profile(&mut manager, &profile)?;
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
            false,
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
