use crate::state::{AiStreamChunk, AiTaskAttempt, AiTaskStarted, ModelConnectionResponse};
use crate::{ApiError, ProjectState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractedEntity {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAiJobInput {
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) mode: String,
    pub(crate) section_id: String,
    pub(crate) section_title: String,
    pub(crate) section_prompt: String,
    pub(crate) existing_context: String,
    pub(crate) reference_content: String,
    pub(crate) user_guidance: String,
    pub(crate) allow_rewrite: bool,
    #[serde(default)]
    pub(crate) temperature: Option<f64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u32>,
    #[serde(default)]
    pub(crate) task_key: Option<novel_infrastructure::AiTaskKind>,
    pub(crate) source_name: Option<Vec<String>>,
    pub(crate) system_prompt_snapshot: Option<String>,
    pub(crate) user_prompt_snapshot: Option<String>,
    pub(crate) final_request_endpoint: Option<String>,
    pub(crate) final_request_body: Option<String>,
    pub(crate) final_request_estimated_input_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractEntitiesInput {
    profile_id: uuid::Uuid,
    entity_type: novel_infrastructure::EntityType,
    entity_name: String,
    brief_summary: String,
    applicability_scope: String,
    source_text: String,
    user_guidance: Option<String>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractChapterCandidatesInput {
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    source_revision_id: Option<uuid::Uuid>,
    user_guidance: Option<String>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterExtractionAiItem {
    kind: String,
    block_id: String,
    quote: String,
    entity_type: Option<novel_infrastructure::EntityType>,
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    subject: Option<String>,
    predicate: Option<String>,
    object: Option<String>,
    relation_type: Option<String>,
    title: Option<String>,
    occurred_at: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewClaimExtractionResponse {
    #[serde(default)]
    claims: Vec<ExtractedReviewClaim>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedReviewClaim {
    #[serde(rename = "type")]
    claim_type: String,
    subject: String,
    predicate: String,
    object: String,
    quote: String,
    block_id: String,
    #[serde(default = "default_claim_importance")]
    importance: u8,
    #[serde(default)]
    confidence: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewResponse {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    findings: Vec<SemanticReviewFinding>,
    #[serde(default)]
    omitted: Vec<SemanticReviewOmitted>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewFinding {
    claim_id: String,
    status: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    problem: String,
    #[serde(default)]
    evidence_ids: Vec<String>,
    #[serde(default)]
    suggestion: String,
    #[serde(default)]
    confidence: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewOmitted {
    #[serde(default)]
    label: String,
    #[serde(default)]
    reason: String,
}

fn default_claim_importance() -> u8 {
    3
}

const PLANNING_CONTEXT_RESERVE_TOKENS: u32 = 2_048;
const EXTRACTION_PROMPT_VERSION: &str = "r5.1-chapter-extraction-v2";

pub(crate) fn task_generation_options(
    task_key: Option<novel_infrastructure::AiTaskKind>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> Result<novel_infrastructure::GenerationOptions, ApiError> {
    let temperature =
        temperature.or_else(|| task_key.map(novel_infrastructure::AiTaskKind::default_temperature));
    let max_output_tokens = max_output_tokens
        .or_else(|| task_key.map(novel_infrastructure::AiTaskKind::default_max_output_tokens));
    if temperature.is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value)) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "温度必须介于 0 到 2 之间".to_owned(),
        });
    }
    if max_output_tokens == Some(0) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "最大输出 tokens 必须大于 0".to_owned(),
        });
    }
    Ok(novel_infrastructure::GenerationOptions {
        temperature,
        max_output_tokens,
    })
}

pub(crate) fn load_ai_task_preference(
    state: &ProjectState,
    task: novel_infrastructure::AiTaskKind,
) -> Result<novel_infrastructure::AiTaskPreference, ApiError> {
    let mut preference = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        let preferences = store.get_ai_task_preferences().map_err(ApiError::from)?;
        preferences.get(task).clone()
    };
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    if let Some(project_preference) = manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)?
        .get(task)
    {
        preference = project_preference.clone();
    }
    Ok(preference)
}

pub(crate) fn effective_task_input_budget(
    profile: &novel_infrastructure::ModelProfile,
    max_output_tokens: u32,
    preference: &novel_infrastructure::AiTaskPreference,
) -> u32 {
    // Keep every provider request inside a predictable envelope. Provider
    // tokenizers, system messages and protocol wrappers consume space that
    // cannot be inferred from the user prompt alone.
    const SAFETY_MARGIN_TOKENS: u32 = 1_024;
    const MAX_SAFE_INPUT_TOKENS: u32 = 32_768;
    let model_budget = profile
        .context_window
        .saturating_sub(max_output_tokens)
        .saturating_sub(SAFETY_MARGIN_TOKENS);
    preference
        .prompt
        .context
        .input_token_budget
        .map_or(model_budget, |budget| model_budget.min(budget))
        .min(MAX_SAFE_INPUT_TOKENS)
        .max(256)
}

fn context_option(value: Option<bool>, default: bool) -> bool {
    value.unwrap_or(default)
}

pub(crate) fn resolve_task_profile(
    state: &ProjectState,
    preference: &novel_infrastructure::AiTaskPreference,
) -> Result<Option<novel_infrastructure::ModelProfile>, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    let profiles = store
        .list()
        .map_err(ApiError::from)?
        .into_iter()
        .filter(|profile| profile.capability == novel_infrastructure::ModelCapability::Chat)
        .collect::<Vec<_>>();
    Ok(preference
        .profile_id
        .and_then(|profile_id| {
            profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .cloned()
        })
        .or_else(|| profiles.iter().find(|profile| profile.has_secret).cloned())
        .or_else(|| profiles.into_iter().next()))
}

fn normalized_document_json(document_json: String) -> String {
    if document_json.trim().is_empty() {
        r#"{"type":"doc","content":[]}"#.to_owned()
    } else {
        document_json
    }
}

fn assemble_task_context(
    state: &ProjectState,
    input: &novel_application::AssembleContextInput,
    include_project_knowledge: bool,
    preference: &novel_infrastructure::AiTaskPreference,
) -> Result<novel_application::ContextPackage, ApiError> {
    let mut context = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let result = if include_project_knowledge {
            manager.assemble_context_with_project_knowledge(input)
        } else {
            novel_application::ContextAssembler::assemble(input)
        };
        result.map_err(|error| ApiError {
            code: "INVALID_INPUT",
            message: error.to_string(),
        })?
    };
    let current_draft = novel_application::document_text(&input.document_json).unwrap_or_default();
    let project_knowledge = context.user_prompt.clone();
    novel_infrastructure::apply_task_prompt_preferences(
        &mut context,
        preference,
        &[
            ("chapterTitle", input.chapter_title.as_str()),
            ("chapterPlan", input.chapter_plan.as_str()),
            ("volumePlan", input.volume_plan.as_str()),
            (
                "userInstruction",
                input.instruction.as_deref().unwrap_or(""),
            ),
            ("selection", input.selection.as_deref().unwrap_or("")),
            ("currentDraft", current_draft.as_str()),
            ("projectKnowledge", project_knowledge.as_str()),
        ],
    );
    Ok(context)
}

#[allow(clippy::too_many_arguments)]
fn current_consistency_review_context_version(
    state: &ProjectState,
    review_purpose: novel_infrastructure::ReviewPurpose,
    chapter_id: uuid::Uuid,
    target_revision_id: Option<uuid::Uuid>,
    chapter_title: String,
    chapter_plan: String,
    volume_plan: String,
    document_json: String,
    instruction: Option<String>,
) -> Result<Option<String>, ApiError> {
    let preference =
        load_ai_task_preference(state, novel_infrastructure::AiTaskKind::ConsistencyReview)?;
    let Some(profile) = resolve_task_profile(state, &preference)? else {
        return Ok(None);
    };
    let Ok(generation_options) = task_generation_options(
        Some(novel_infrastructure::AiTaskKind::ConsistencyReview),
        preference.temperature,
        preference.max_output_tokens,
    ) else {
        return Ok(None);
    };
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget = effective_task_input_budget(&profile, max_output_tokens, &preference);
    let include_project_knowledge = context_option(
        preference.prompt.context.include_project_knowledge,
        novel_infrastructure::AiTaskKind::ConsistencyReview.default_include_project_knowledge(),
    );
    let reviewing_manuscript = review_purpose == novel_infrastructure::ReviewPurpose::Manuscript;
    let input = novel_application::AssembleContextInput {
        chapter_id,
        target_revision_id,
        action: novel_infrastructure::AiAction::ConsistencyCheck,
        chapter_title,
        chapter_plan,
        volume_plan: if reviewing_manuscript {
            String::new()
        } else {
            volume_plan
        },
        document_json: if reviewing_manuscript {
            normalized_document_json(document_json)
        } else {
            r#"{"type":"doc","content":[]}"#.to_owned()
        },
        selection: None,
        instruction,
        input_token_budget,
    };
    let Ok(context) = assemble_task_context(state, &input, include_project_knowledge, &preference)
    else {
        return Ok(None);
    };
    Ok(Some(
        context.with_review_purpose(review_purpose).context_version,
    ))
}

pub(crate) struct AiGenerationOutcome {
    pub(crate) output: String,
    pub(crate) completion: novel_infrastructure::GenerationCompletion,
    pub(crate) finish_reason: Option<String>,
    pub(crate) usage: Option<novel_infrastructure::GenerationUsage>,
    pub(crate) fallback_profile: Option<novel_infrastructure::ModelProfile>,
    pub(crate) fallback_reason: Option<String>,
}

fn should_try_fallback(error: &novel_infrastructure::AiError) -> bool {
    matches!(
        error,
        novel_infrastructure::AiError::RateLimited
            | novel_infrastructure::AiError::Timeout
            | novel_infrastructure::AiError::ProviderUnavailable
            | novel_infrastructure::AiError::Network
            | novel_infrastructure::AiError::InvalidResponse
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_with_task_fallback<F>(
    state: &ProjectState,
    preference: &novel_infrastructure::AiTaskPreference,
    primary: &novel_infrastructure::ModelProfile,
    primary_secret: Option<&str>,
    context: &novel_application::ContextPackage,
    options: novel_infrastructure::GenerationOptions,
    stream: bool,
    disable_thinking: bool,
    cancelled: Arc<AtomicBool>,
    mut on_chunk: F,
) -> Result<AiGenerationOutcome, novel_infrastructure::AiError>
where
    F: FnMut(&str) + Send,
{
    match state
        .gateway
        .generate_with_options_detailed(
            primary,
            primary_secret,
            context,
            options,
            stream,
            disable_thinking,
            Arc::clone(&cancelled),
            &mut on_chunk,
        )
        .await
    {
        Ok(generation) => Ok(AiGenerationOutcome {
            output: generation.output,
            completion: generation.completion,
            finish_reason: generation.finish_reason,
            usage: generation.usage,
            fallback_profile: None,
            fallback_reason: None,
        }),
        Err(error) if !should_try_fallback(&error) => Err(error),
        Err(primary_error) => {
            let Some(fallback_id) = preference
                .fallback_profile_id
                .filter(|profile_id| *profile_id != primary.id)
            else {
                return Err(primary_error);
            };
            let fallback = {
                let store = state
                    .model_profiles
                    .lock()
                    .map_err(|_| novel_infrastructure::AiError::ProviderUnavailable)?;
                let Ok(fallback) = store.get(fallback_id) else {
                    return Err(primary_error);
                };
                fallback
            };
            if fallback.capability != novel_infrastructure::ModelCapability::Chat
                || fallback.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly
            {
                return Err(primary_error);
            }
            let fallback_secret = fallback
                .secret_ref
                .as_deref()
                .ok_or(novel_infrastructure::AiError::MissingSecret)
                .and_then(novel_infrastructure::SecretStore::get)?;
            let fallback_reason = primary_error.code().to_owned();
            let generation = state
                .gateway
                .generate_with_options_detailed(
                    &fallback,
                    Some(&fallback_secret),
                    context,
                    options,
                    stream,
                    disable_thinking,
                    cancelled,
                    on_chunk,
                )
                .await?;
            Ok(AiGenerationOutcome {
                output: generation.output,
                completion: generation.completion,
                finish_reason: generation.finish_reason,
                usage: generation.usage,
                fallback_profile: Some(fallback),
                fallback_reason: Some(fallback_reason),
            })
        }
    }
}

fn truncate_text_to_char_budget(value: &str, char_budget: usize, marker: &str) -> String {
    if value.chars().count() <= char_budget {
        return value.to_owned();
    }
    let marker_cost = marker.chars().count();
    let content_budget = char_budget.saturating_sub(marker_cost).max(1);
    let mut truncated = value.chars().take(content_budget).collect::<String>();
    truncated.push_str(marker);
    truncated
}

#[cfg(test)]
mod task_generation_options_tests {
    #[test]
    fn applies_recommended_defaults_without_overriding_explicit_values() {
        let recommended = super::task_generation_options(
            Some(novel_infrastructure::AiTaskKind::Writing),
            None,
            None,
        )
        .expect("recommended options");
        assert_eq!(recommended.temperature, Some(0.9));
        assert_eq!(recommended.max_output_tokens, Some(8_192));

        let explicit = super::task_generation_options(
            Some(novel_infrastructure::AiTaskKind::Writing),
            Some(0.4),
            Some(2_048),
        )
        .expect("explicit options");
        assert_eq!(explicit.temperature, Some(0.4));
        assert_eq!(explicit.max_output_tokens, Some(2_048));
    }

    #[test]
    fn truncates_text_with_a_visible_budget_marker() {
        let truncated = super::truncate_text_to_char_budget("一二三四五六七八九十", 8, "[截断]");
        assert_eq!(truncated, "一二三四[截断]");
    }

    #[test]
    fn detects_obviously_incomplete_planning_endings() {
        assert!(super::planning_output_looks_truncated("以同一章内可"));
        assert!(super::planning_output_looks_truncated("叙事视角包括："));
        assert!(!super::planning_output_looks_truncated(
            "第一卷以主角觉醒结束。"
        ));
        assert!(!super::planning_output_looks_truncated(
            "每卷保留一个核心冲突"
        ));
    }

    #[test]
    fn explains_reasoning_only_output_length_failures() {
        let (error, message) = super::incomplete_generation_failure(
            novel_infrastructure::GenerationCompletion::LengthLimit,
            0,
            Some("length"),
        );
        assert_eq!(
            error.code(),
            novel_infrastructure::AiError::OutputLengthLimit.code()
        );
        assert!(message.contains("输出预算不足"));
        assert!(message.contains("思考内容也会占用同一份输出预算"));
        assert!(message.contains("模型没有返回任何可用正文"));
        assert!(message.contains("提高该任务的最大输出"));
        assert!(!message.contains("关闭思考模式"));
        assert!(message.contains("finish_reason: length"));
    }
}

mod extraction;
mod model_settings;
mod planning;
mod review;

pub(crate) use extraction::*;
pub(crate) use model_settings::*;
pub(crate) use planning::*;
pub(crate) use review::*;
