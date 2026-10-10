use super::review::generate_consistency_review_proposal;
use super::{
    AiStreamChunk, AiTaskAttempt, AiTaskStarted, ApiError, Arc, AtomicBool, Emitter, ProjectState,
    assemble_task_context, context_option, current_consistency_review_context_version,
    effective_max_output_tokens, effective_task_input_budget, generate_with_task_fallback,
    incomplete_generation_failure, load_ai_task_preference, normalized_document_json,
    persist_ai_run_request, sync_model_profile, task_generation_options,
};

pub(super) struct ProposalGenerationInput {
    pub profile_id: uuid::Uuid,
    pub chapter_id: uuid::Uuid,
    pub action: novel_infrastructure::AiAction,
    pub review_purpose: Option<novel_infrastructure::ReviewPurpose>,
    pub chapter_title: String,
    pub chapter_plan: String,
    pub volume_plan: String,
    pub document_json: String,
    pub selection: Option<String>,
    pub instruction: Option<String>,
    pub stream: bool,
    pub temperature: Option<f64>,
    pub max_output_tokens: Option<u32>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_ai_proposal(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    action: novel_infrastructure::AiAction,
    review_purpose: Option<novel_infrastructure::ReviewPurpose>,
    chapter_title: String,
    chapter_plan: String,
    volume_plan: String,
    document_json: String,
    selection: Option<String>,
    instruction: Option<String>,
    stream: bool,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let input = ProposalGenerationInput {
        profile_id,
        chapter_id,
        action,
        review_purpose,
        chapter_title,
        chapter_plan,
        volume_plan,
        document_json,
        selection,
        instruction,
        stream,
        temperature,
        max_output_tokens,
    };
    if action == novel_infrastructure::AiAction::ConsistencyCheck {
        generate_consistency_review_proposal(app, &state, input).await
    } else {
        generate_writing_proposal(app, &state, input).await
    }
}

#[allow(clippy::too_many_lines)]
async fn generate_writing_proposal(
    app: tauri::AppHandle,
    state: &ProjectState,
    input: ProposalGenerationInput,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let ProposalGenerationInput {
        profile_id,
        chapter_id,
        action,
        chapter_title,
        chapter_plan,
        volume_plan,
        document_json,
        selection,
        instruction,
        stream,
        temperature,
        max_output_tokens,
        ..
    } = input;
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
        manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?
            .map(|value| value.id)
    };
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let task_kind = novel_infrastructure::AiTaskKind::Writing;
    let task_preference = load_ai_task_preference(state, task_kind)?;
    let include_project_knowledge = context_option(
        task_preference.prompt.context.include_project_knowledge,
        task_kind.default_include_project_knowledge(),
    );
    let include_current_draft = context_option(
        task_preference.prompt.context.include_current_draft,
        task_kind.default_include_current_draft(),
    );
    let include_chapter_plan = context_option(
        task_preference.prompt.context.include_chapter_plan,
        task_kind.default_include_chapter_plan(),
    );
    let generation_options =
        task_generation_options(Some(task_kind), temperature, max_output_tokens)?;
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let effective_document_json =
        if !include_current_draft && action == novel_infrastructure::AiAction::Draft {
            r#"{"type":"doc","content":[]}"#.to_owned()
        } else {
            normalized_document_json(document_json.clone())
        };
    let context_input = novel_application::AssembleContextInput {
        chapter_id,
        target_revision_id,
        action,
        chapter_title: chapter_title.clone(),
        chapter_plan: if include_chapter_plan {
            chapter_plan.clone()
        } else {
            String::new()
        },
        volume_plan: if include_chapter_plan {
            volume_plan.clone()
        } else {
            String::new()
        },
        document_json: effective_document_json,
        selection,
        instruction: instruction.clone(),
        input_token_budget,
    };
    let mut context = assemble_task_context(
        state,
        &context_input,
        include_project_knowledge,
        &task_preference,
    )?;
    context.estimated_input_tokens =
        u32::try_from(context.system_prompt.chars().count() + context.user_prompt.chars().count())
            .unwrap_or(u32::MAX)
            .min(input_token_budget);
    if matches!(
        action,
        novel_infrastructure::AiAction::Draft | novel_infrastructure::AiAction::Continue
    ) {
        let current_review_context_version = current_consistency_review_context_version(
            state,
            novel_infrastructure::ReviewPurpose::Admission,
            chapter_id,
            target_revision_id,
            chapter_title,
            chapter_plan,
            volume_plan,
            document_json,
            instruction,
        )?;
        let admission = {
            let manager = state
                .manager
                .lock()
                .map_err(|_| ApiError::internal("project mutex poisoned"))?;
            if manager
                .get_audit_flow_settings()
                .map_err(ApiError::from)?
                .admission
            {
                let policy = manager
                    .get_writing_review_policy()
                    .map_err(ApiError::from)?;
                manager
                    .chapter_writing_admission(
                        chapter_id,
                        current_review_context_version.as_deref(),
                        policy,
                    )
                    .map_err(ApiError::from)?
            } else {
                novel_infrastructure::WritingAdmission {
                    allowed: true,
                    blocker_count: 0,
                    reason: None,
                    review_freshness: novel_infrastructure::ConsistencyReviewFreshness::Missing,
                }
            }
        };
        if !admission.allowed {
            return Err(ApiError {
                code: "WRITING_BLOCKED",
                message: admission
                    .reason
                    .unwrap_or_else(|| "最近一次一致性审核未通过，暂时不能生成正文。".to_owned()),
            });
        }
    }
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
            .create_ai_task(profile_id, &context, None)
            .map_err(ApiError::from)?
    };
    if let Err(error) = persist_ai_run_request(
        state,
        task_id,
        &profile,
        &context,
        stream,
        false,
        generation_options,
    ) {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_task(task_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        return Err(error);
    }
    let _ = app.emit("ai-task-started", AiTaskStarted { task_id });
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .insert(task_id, Arc::clone(&cancelled));
    let result = generate_with_task_fallback(
        state,
        &task_preference,
        &profile,
        secret.as_deref(),
        &context,
        generation_options,
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
        Ok(outcome) => {
            if outcome.output.trim().is_empty() {
                let (error, message) = if outcome.completion.is_complete() {
                    (
                        novel_infrastructure::AiError::InvalidResponse,
                        "模型返回了空内容，没有生成可用的审核报告或候选正文。".to_owned(),
                    )
                } else {
                    incomplete_generation_failure(
                        outcome.completion,
                        outcome.output.chars().count(),
                        outcome.finish_reason.as_deref(),
                    )
                };
                let _ = manager.fail_ai_task(task_id, &error);
                return Err(ApiError {
                    code: error.code(),
                    message,
                });
            }
            if let Some(fallback) = outcome.fallback_profile.as_ref() {
                let reason = outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN");
                sync_model_profile(&mut manager, fallback)?;
                let _ = manager.record_ai_task_fallback(task_id, fallback.id, reason);
                let (endpoint, request_body) = state.gateway.request_preview_with_options(
                    fallback,
                    &context,
                    stream,
                    false,
                    generation_options,
                );
                if let Ok(request_body) = serde_json::to_string_pretty(&request_body) {
                    let _ = manager.record_ai_run_request(task_id, &endpoint, &request_body);
                }
                let _ = app.emit(
                    "ai-task-attempt",
                    AiTaskAttempt {
                        task_id,
                        attempt: 2,
                        profile_name: fallback.name.clone(),
                        fallback_reason: Some(reason.to_owned()),
                    },
                );
            }
            manager
                .complete_ai_task(task_id, &context, outcome.output, outcome.usage.as_ref())
                .map_err(ApiError::from)
        }
        Err(error) => {
            let _ = manager.fail_ai_task(task_id, &error);
            Err(ApiError::from(error))
        }
    }
}
