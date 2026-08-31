use crate::state::{AiStreamChunk, AiTaskStarted, ModelConnectionResponse};
use crate::{ApiError, ProjectState};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::Emitter;

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
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_model_profiles().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_model_profile(
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
pub(crate) fn save_model_secret(
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
pub(crate) fn delete_model_secret(
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
pub(crate) async fn test_model_profile(
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
