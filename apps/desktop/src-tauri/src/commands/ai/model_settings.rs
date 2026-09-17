use super::*;

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
pub(crate) fn get_ai_task_preferences(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::AiTaskPreferences, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.get_ai_task_preferences().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_ai_task_preferences(
    state: tauri::State<'_, ProjectState>,
    preferences: novel_infrastructure::AiTaskPreferences,
) -> Result<novel_infrastructure::AiTaskPreferences, ApiError> {
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store
        .save_ai_task_preferences(&preferences)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_ai_budget_settings(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::AiBudgetSettings, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.get_ai_budget_settings().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_writing_review_policy(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::WritingReviewPolicy, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.get_writing_review_policy().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_writing_review_policy(
    state: tauri::State<'_, ProjectState>,
    policy: novel_infrastructure::WritingReviewPolicy,
) -> Result<novel_infrastructure::WritingReviewPolicy, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_writing_review_policy(policy)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_audit_flow_settings(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::AuditFlowSettings, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.get_audit_flow_settings().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_audit_flow_settings(
    state: tauri::State<'_, ProjectState>,
    settings: novel_infrastructure::AuditFlowSettings,
) -> Result<novel_infrastructure::AuditFlowSettings, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .save_audit_flow_settings(settings)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_ai_budget_settings(
    state: tauri::State<'_, ProjectState>,
    settings: novel_infrastructure::AiBudgetSettings,
) -> Result<novel_infrastructure::AiBudgetSettings, ApiError> {
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store
        .save_ai_budget_settings(&settings)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_project_ai_task_overrides(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_project_ai_task_override(
    state: tauri::State<'_, ProjectState>,
    task: novel_infrastructure::AiTaskKind,
    preference: novel_infrastructure::AiTaskPreference,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let profiles = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.list().map_err(ApiError::from)?
    };
    let required_profile_ids = [preference.profile_id, preference.fallback_profile_id];
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    for profile_id in required_profile_ids.into_iter().flatten() {
        let profile = profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                ApiError::from(novel_infrastructure::AiError::MissingProfile(profile_id))
            })?;
        if profile.capability != novel_infrastructure::ModelCapability::Chat {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "项目覆盖只能使用聊天模型".to_owned(),
            });
        }
        sync_model_profile(&mut manager, profile)?;
    }
    manager
        .save_project_ai_task_override(task, &preference)
        .map_err(ApiError::from)?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_project_ai_task_overrides(
    state: tauri::State<'_, ProjectState>,
    preferences: novel_infrastructure::AiTaskPreferences,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let profiles = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.list().map_err(ApiError::from)?
    };
    let required_profile_ids = [
        preferences.work_design.profile_id,
        preferences.work_design.fallback_profile_id,
        preferences.outline.profile_id,
        preferences.outline.fallback_profile_id,
        preferences.volume_planning.profile_id,
        preferences.volume_planning.fallback_profile_id,
        preferences.chapter_split.profile_id,
        preferences.chapter_split.fallback_profile_id,
        preferences.writing.profile_id,
        preferences.writing.fallback_profile_id,
        preferences.knowledge_extraction.profile_id,
        preferences.knowledge_extraction.fallback_profile_id,
    ];
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    for profile_id in required_profile_ids.into_iter().flatten() {
        let profile = profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                ApiError::from(novel_infrastructure::AiError::MissingProfile(profile_id))
            })?;
        if profile.capability != novel_infrastructure::ModelCapability::Chat {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "项目覆盖只能使用聊天模型".to_owned(),
            });
        }
        sync_model_profile(&mut manager, profile)?;
    }
    manager
        .save_project_ai_task_overrides(&preferences)
        .map_err(ApiError::from)?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn remove_project_ai_task_override(
    state: tauri::State<'_, ProjectState>,
    task: novel_infrastructure::AiTaskKind,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .remove_project_ai_task_override(task)
        .map_err(ApiError::from)?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
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
            let connection_test_token_cap =
                if profile.provider == novel_infrastructure::ModelProvider::DeepSeek {
                    512
                } else {
                    16
                };
            profile.max_output_tokens = profile.max_output_tokens.min(connection_test_token_cap);
            let context = novel_application::ContextPackage::connection_test();
            state
                .gateway
                .generate(
                    &profile,
                    Some(&secret),
                    &context,
                    false,
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
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_ai_proposals(
    state: tauri::State<'_, ProjectState>,
    review_purpose: Option<novel_infrastructure::ReviewPurpose>,
    chapter_id: uuid::Uuid,
    chapter_title: String,
    chapter_plan: String,
    volume_plan: String,
    document_json: String,
    instruction: Option<String>,
) -> Result<Vec<novel_infrastructure::AiProposalReview>, ApiError> {
    let (mut reviews, target_revision_id) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let reviews = manager
            .list_ai_proposal_reviews(chapter_id, review_purpose)
            .map_err(ApiError::from)?;
        let target_revision_id = manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?
            .map(|revision| revision.id);
        (reviews, target_revision_id)
    };
    let needs_freshness = reviews.iter().any(|review| {
        review.proposal.action == novel_infrastructure::AiAction::ConsistencyCheck
            && review.proposal.status == novel_infrastructure::AiProposalStatus::Pending
    });
    if needs_freshness {
        let freshness_purpose =
            review_purpose.unwrap_or(novel_infrastructure::ReviewPurpose::Admission);
        let current_context_version = current_consistency_review_context_version(
            &state,
            freshness_purpose,
            chapter_id,
            target_revision_id,
            chapter_title,
            chapter_plan,
            volume_plan,
            document_json,
            instruction,
        )
        .ok()
        .flatten();
        novel_infrastructure::ProjectManager::mark_consistency_review_freshness(
            &mut reviews,
            current_context_version.as_deref(),
        );
    }
    Ok(reviews)
}

#[tauri::command]
pub(crate) fn get_consistency_review_trace(
    state: tauri::State<'_, ProjectState>,
    proposal_id: uuid::Uuid,
) -> Result<novel_infrastructure::ReviewTrace, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .get_consistency_review_trace(proposal_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn rate_ai_proposal(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    rating: novel_infrastructure::AiProposalFeedbackRating,
    note: Option<String>,
) -> Result<novel_infrastructure::AiProposalFeedback, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .rate_ai_proposal(id, rating, note)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_ai_runs(
    state: tauri::State<'_, ProjectState>,
    limit: Option<u32>,
) -> Result<Vec<novel_infrastructure::AiRun>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_ai_runs(limit).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_ai_run_request(
    state: tauri::State<'_, ProjectState>,
    run_id: uuid::Uuid,
) -> Result<novel_infrastructure::AiRunRequest, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.get_ai_run_request(run_id).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_ai_usage_summary(
    state: tauri::State<'_, ProjectState>,
    days: Option<u32>,
) -> Result<novel_infrastructure::AiUsageSummary, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .get_ai_usage_summary(days.unwrap_or(30))
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_ai_quality_summary(
    state: tauri::State<'_, ProjectState>,
    limit: Option<u32>,
    days: Option<u32>,
) -> Result<novel_infrastructure::AiQualitySummary, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .get_ai_quality_summary(limit.unwrap_or(20), Some(days.unwrap_or(90)))
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
