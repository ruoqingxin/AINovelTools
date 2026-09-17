use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use keyring::Entry;
use novel_application::ContextPackage;
use novel_domain::{
    AiAction, AiContractError, AiProposal, AiProposalStatus, AiTaskStatus, ModelCapability,
    ModelProfile, ModelProfileInput, ModelProvider, PrivacyLevel, ReviewPurpose,
    WritingReviewPolicy,
};
use reqwest::StatusCode;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{DatabaseError, ProjectManager};

const SECRET_SERVICE: &str = "AINovelTools";
const AI_TASK_PREFERENCES_KEY: &str = "ai_task_model_preferences";
const AI_BUDGET_SETTINGS_KEY: &str = "ai_budget_settings";

fn snapshot_run_prices(
    provider: &str,
    model_id: &str,
    input_price: u64,
    output_price: u64,
    currency: String,
) -> (u64, u64, u64, String) {
    if provider != "DEEP_SEEK" || !matches!(model_id, "deepseek-flash" | "deepseek-v4-flash") {
        return (0, input_price, output_price, currency);
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_add(8 * 60 * 60);
    let day = seconds / 86_400;
    let hour = (seconds % 86_400) / 3_600;
    let weekday = (day + 4) % 7;
    let peak = (1..=5).contains(&weekday) && ((9..12).contains(&hour) || (14..18).contains(&hour));
    if peak {
        (40_000, 2_000_000, 8_000_000, "CNY".to_owned())
    } else {
        (20_000, 1_000_000, 4_000_000, "CNY".to_owned())
    }
}

fn actual_run_cost_micros(
    usage: &GenerationUsage,
    cache_hit_price: u64,
    cache_miss_price: u64,
    output_price: u64,
) -> Option<u64> {
    let cache_hit_tokens = usage.input_cache_hit_tokens?;
    let cache_miss_tokens = usage.input_cache_miss_tokens?;
    if cache_hit_price == 0 && cache_hit_tokens > 0 {
        return None;
    }
    let cost = u128::from(cache_hit_tokens) * u128::from(cache_hit_price)
        + u128::from(cache_miss_tokens) * u128::from(cache_miss_price)
        + u128::from(usage.output_tokens) * u128::from(output_price);
    u64::try_from(cost / 1_000_000).ok()
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("no project is open")]
    NoProject,
    #[error(transparent)]
    Contract(#[from] AiContractError),
    #[error("model profile does not exist: {0}")]
    MissingProfile(Uuid),
    #[error("AI proposal does not exist: {0}")]
    MissingProposal(Uuid),
    #[error("AI run does not exist: {0}")]
    MissingRun(Uuid),
    #[error("OS secret store operation failed")]
    SecretStore,
    #[error("model profile requires an API key")]
    MissingSecret,
    #[error("local-only privacy policy blocks this remote model endpoint")]
    PrivacyPolicy,
    #[error("AI provider authentication failed")]
    Authentication,
    #[error("AI provider rate limit exceeded")]
    RateLimited,
    #[error("AI provider request timed out")]
    Timeout,
    #[error("AI task was cancelled")]
    Cancelled,
    #[error("AI provider returned an invalid response")]
    InvalidResponse,
    #[error("AI provider stopped at the output length limit")]
    OutputLengthLimit,
    #[error("AI provider filtered the generated content")]
    ContentFiltered,
    #[error("AI provider stream ended before completion")]
    StreamInterrupted,
    #[error("AI provider returned content with an incomplete ending")]
    OutputIncomplete,
    #[error("AI provider is unavailable")]
    ProviderUnavailable,
    #[error("AI provider network request failed")]
    Network,
    #[error("AI context metadata serialization failed")]
    ContextSerialization,
    #[error("AI database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl AiError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NoProject => "NO_PROJECT_OPEN",
            Self::Contract(_) => "INVALID_INPUT",
            Self::MissingProfile(_) | Self::MissingProposal(_) | Self::MissingRun(_) => "NOT_FOUND",
            Self::SecretStore => "SECRET_STORE_ERROR",
            Self::MissingSecret => "MODEL_SECRET_MISSING",
            Self::PrivacyPolicy => "PRIVACY_POLICY_BLOCKED",
            Self::Authentication => "PROVIDER_AUTHENTICATION",
            Self::RateLimited => "PROVIDER_RATE_LIMITED",
            Self::Timeout => "PROVIDER_TIMEOUT",
            Self::Cancelled => "TASK_CANCELLED",
            Self::InvalidResponse => "PROVIDER_INVALID_RESPONSE",
            Self::OutputLengthLimit => "AI_OUTPUT_LENGTH_LIMIT",
            Self::ContentFiltered => "AI_CONTENT_FILTERED",
            Self::StreamInterrupted => "AI_STREAM_INTERRUPTED",
            Self::OutputIncomplete => "AI_OUTPUT_INCOMPLETE",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
            Self::Network => "PROVIDER_NETWORK",
            Self::ContextSerialization => "CONTEXT_SERIALIZATION",
            Self::Database(_) => "DATABASE_ERROR",
        }
    }
}

pub struct SecretStore;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiTaskKind {
    WorkDesign,
    Outline,
    VolumePlanning,
    ChapterSplit,
    ChapterPlan,
    ConsistencyReview,
    Writing,
    KnowledgeExtraction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiRunSource {
    Writing,
    Planning,
    KnowledgeExtraction,
}

impl AiRunSource {
    #[must_use]
    pub const fn storage_key(self) -> &'static str {
        match self {
            Self::Writing => "WRITING",
            Self::Planning => "PLANNING",
            Self::KnowledgeExtraction => "KNOWLEDGE_EXTRACTION",
        }
    }
}

impl AiTaskKind {
    #[must_use]
    pub const fn storage_key(self) -> &'static str {
        match self {
            Self::WorkDesign => "workDesign",
            Self::Outline => "outline",
            Self::VolumePlanning => "volumePlanning",
            Self::ChapterSplit => "chapterSplit",
            Self::ChapterPlan => "chapterPlan",
            Self::ConsistencyReview => "consistencyReview",
            Self::Writing => "writing",
            Self::KnowledgeExtraction => "knowledgeExtraction",
        }
    }

    #[must_use]
    pub const fn default_temperature(self) -> f64 {
        match self {
            Self::WorkDesign => 0.45,
            Self::Outline => 0.6,
            Self::VolumePlanning => 0.55,
            Self::ChapterSplit => 0.3,
            Self::ChapterPlan => 0.35,
            Self::ConsistencyReview => 0.2,
            Self::Writing => 0.9,
            Self::KnowledgeExtraction => 0.1,
        }
    }

    #[must_use]
    pub const fn default_max_output_tokens(self) -> u32 {
        match self {
            Self::WorkDesign
            | Self::ChapterSplit
            | Self::ChapterPlan
            | Self::KnowledgeExtraction => 4_096,
            Self::Outline | Self::VolumePlanning => 6_144,
            Self::ConsistencyReview | Self::Writing => 8_192,
        }
    }

    #[must_use]
    pub const fn default_input_token_budget(self) -> u32 {
        match self {
            Self::WorkDesign | Self::ChapterSplit | Self::ChapterPlan => 24_576,
            Self::Outline
            | Self::VolumePlanning
            | Self::ConsistencyReview
            | Self::KnowledgeExtraction => 32_768,
            Self::Writing => 49_152,
        }
    }

    #[must_use]
    pub const fn default_include_project_context(self) -> bool {
        matches!(
            self,
            Self::WorkDesign
                | Self::Outline
                | Self::VolumePlanning
                | Self::ChapterSplit
                | Self::ChapterPlan
                | Self::ConsistencyReview
        )
    }

    #[must_use]
    pub const fn default_include_reference_content(self) -> bool {
        matches!(self, Self::WorkDesign | Self::KnowledgeExtraction)
    }

    #[must_use]
    pub const fn default_include_project_knowledge(self) -> bool {
        !matches!(self, Self::KnowledgeExtraction)
    }

    #[must_use]
    pub const fn default_include_current_draft(self) -> bool {
        matches!(self, Self::Writing | Self::ConsistencyReview)
    }

    #[must_use]
    pub const fn default_include_chapter_plan(self) -> bool {
        matches!(self, Self::Writing | Self::ConsistencyReview)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AiTaskPreference {
    pub profile_id: Option<Uuid>,
    pub fallback_profile_id: Option<Uuid>,
    pub temperature: Option<f64>,
    pub max_output_tokens: Option<u32>,
    pub prompt: AiTaskPromptPreference,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AiTaskPromptPreference {
    pub system_prompt: Option<String>,
    pub instruction_template: Option<String>,
    pub context: AiTaskContextPreference,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AiTaskContextPreference {
    pub include_project_context: Option<bool>,
    pub include_reference_content: Option<bool>,
    pub include_project_knowledge: Option<bool>,
    pub include_current_draft: Option<bool>,
    pub include_chapter_plan: Option<bool>,
    pub input_token_budget: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRun {
    pub id: Uuid,
    pub task_key: String,
    pub source: String,
    pub action: String,
    pub status: String,
    pub chapter_id: Option<String>,
    pub review_purpose: ReviewPurpose,
    pub chapter_title: String,
    pub profile_name: String,
    pub attempt_count: u32,
    pub retry_reason: Option<String>,
    pub error_code: Option<String>,
    pub estimated_input_tokens: u32,
    pub estimated_output_tokens: u32,
    pub estimated_cost_micros: Option<u64>,
    pub price_currency: String,
    pub prompt_version: String,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiRunRequest {
    pub endpoint: Option<String>,
    pub request_body: Option<String>,
}

pub struct AiRunStart<'a> {
    pub task: AiTaskKind,
    pub source: AiRunSource,
    pub job_id: Option<Uuid>,
    pub chapter_id: Option<Uuid>,
    pub display_title: &'a str,
    pub profile_id: Uuid,
    pub prompt_version: &'a str,
    pub estimated_input_tokens: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    pub days: u32,
    pub total: Vec<AiUsageCurrencySummary>,
    pub daily: Vec<AiUsageDailySummary>,
    pub by_task: Vec<AiUsageTaskSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageCurrencySummary {
    pub currency: String,
    pub run_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_micros: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageDailySummary {
    pub date: String,
    #[serde(flatten)]
    pub usage: AiUsageCurrencySummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageTaskSummary {
    pub task_key: String,
    #[serde(flatten)]
    pub usage: AiUsageCurrencySummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiQualitySummary {
    pub total_proposals: u32,
    pub total_rated: u32,
    pub total_helpful: u32,
    pub total_with_issues: u32,
    pub groups: Vec<AiQualityGroup>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiQualityGroup {
    pub task_key: String,
    pub action: String,
    pub prompt_version: String,
    pub profile_name: String,
    pub proposal_count: u32,
    pub accepted_count: u32,
    pub rated_count: u32,
    pub helpful_count: u32,
    pub not_helpful_count: u32,
    pub valid_count: u32,
    pub warning_count: u32,
    pub needs_input_count: u32,
    pub invalid_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiBudgetSettings {
    pub currency: String,
    pub daily_limit_micros: Option<u64>,
    pub project_limit_micros: Option<u64>,
}

impl Default for AiBudgetSettings {
    fn default() -> Self {
        Self {
            currency: "USD".into(),
            daily_limit_micros: None,
            project_limit_micros: None,
        }
    }
}

impl AiBudgetSettings {
    fn validate(&self) -> Result<(), AiError> {
        let currency = self.currency.trim();
        if currency.is_empty()
            || currency.chars().count() > 8
            || self.daily_limit_micros == Some(0)
            || self.project_limit_micros == Some(0)
        {
            return Err(AiContractError::InvalidGenerationOptions.into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiProposalFeedbackRating {
    Helpful,
    NotHelpful,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposalFeedback {
    pub proposal_id: Uuid,
    pub rating: AiProposalFeedbackRating,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiOutputValidation {
    pub status: String,
    pub messages: Vec<String>,
    pub character_count: usize,
    pub paragraph_count: usize,
    pub estimated_output_tokens: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiConsistencyVerdict {
    Pass,
    Review,
    Blocked,
    NeedsInput,
    Unparsed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiConsistencySeverity {
    Blocker,
    Major,
    Minor,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConsistencyFinding {
    pub severity: AiConsistencySeverity,
    pub problem: String,
    pub evidence: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiConsistencyReport {
    pub verdict: AiConsistencyVerdict,
    pub summary: String,
    pub findings: Vec<AiConsistencyFinding>,
    pub parse_warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConsistencyReviewFreshness {
    Missing,
    Fresh,
    Stale,
    Unverified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposalReview {
    pub proposal: AiProposal,
    pub validation: AiOutputValidation,
    pub feedback: Option<AiProposalFeedback>,
    pub consistency: Option<AiConsistencyReport>,
    pub consistency_freshness: Option<ConsistencyReviewFreshness>,
    pub has_review_trace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritingAdmission {
    pub allowed: bool,
    pub blocker_count: usize,
    pub reason: Option<String>,
    pub review_freshness: ConsistencyReviewFreshness,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiTaskPreferenceData {
    profile_id: Option<Uuid>,
    fallback_profile_id: Option<Uuid>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
    prompt: AiTaskPromptPreferenceData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiTaskPromptPreferenceData {
    system_prompt: Option<String>,
    instruction_template: Option<String>,
    context: AiTaskContextPreferenceData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AiTaskContextPreferenceData {
    include_project_context: Option<bool>,
    include_reference_content: Option<bool>,
    include_project_knowledge: Option<bool>,
    include_current_draft: Option<bool>,
    include_chapter_plan: Option<bool>,
    input_token_budget: Option<u32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AiTaskPreferenceValue {
    ProfileId(Uuid),
    Detailed(AiTaskPreferenceData),
    Empty,
}

impl Serialize for AiTaskPreference {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        AiTaskPreferenceData {
            profile_id: self.profile_id,
            fallback_profile_id: self.fallback_profile_id,
            temperature: self.temperature,
            max_output_tokens: self.max_output_tokens,
            prompt: AiTaskPromptPreferenceData {
                system_prompt: self.prompt.system_prompt.clone(),
                instruction_template: self.prompt.instruction_template.clone(),
                context: AiTaskContextPreferenceData {
                    include_project_context: self.prompt.context.include_project_context,
                    include_reference_content: self.prompt.context.include_reference_content,
                    include_project_knowledge: self.prompt.context.include_project_knowledge,
                    include_current_draft: self.prompt.context.include_current_draft,
                    include_chapter_plan: self.prompt.context.include_chapter_plan,
                    input_token_budget: self.prompt.context.input_token_budget,
                },
            },
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AiTaskPreference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match AiTaskPreferenceValue::deserialize(deserializer)? {
            AiTaskPreferenceValue::ProfileId(profile_id) => Self {
                profile_id: Some(profile_id),
                ..Self::default()
            },
            AiTaskPreferenceValue::Detailed(data) => Self {
                profile_id: data.profile_id,
                fallback_profile_id: data.fallback_profile_id,
                temperature: data.temperature,
                max_output_tokens: data.max_output_tokens,
                prompt: AiTaskPromptPreference {
                    system_prompt: data.prompt.system_prompt,
                    instruction_template: data.prompt.instruction_template,
                    context: AiTaskContextPreference {
                        include_project_context: data.prompt.context.include_project_context,
                        include_reference_content: data.prompt.context.include_reference_content,
                        include_project_knowledge: data.prompt.context.include_project_knowledge,
                        include_current_draft: data.prompt.context.include_current_draft,
                        include_chapter_plan: data.prompt.context.include_chapter_plan,
                        input_token_budget: data.prompt.context.input_token_budget,
                    },
                },
            },
            AiTaskPreferenceValue::Empty => Self::default(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiTaskPreferences {
    pub work_design: AiTaskPreference,
    pub outline: AiTaskPreference,
    pub volume_planning: AiTaskPreference,
    pub chapter_split: AiTaskPreference,
    pub chapter_plan: AiTaskPreference,
    pub consistency_review: AiTaskPreference,
    pub writing: AiTaskPreference,
    pub knowledge_extraction: AiTaskPreference,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAiTaskOverrides {
    pub available: bool,
    pub work_design: Option<AiTaskPreference>,
    pub outline: Option<AiTaskPreference>,
    pub volume_planning: Option<AiTaskPreference>,
    pub chapter_split: Option<AiTaskPreference>,
    pub chapter_plan: Option<AiTaskPreference>,
    pub consistency_review: Option<AiTaskPreference>,
    pub writing: Option<AiTaskPreference>,
    pub knowledge_extraction: Option<AiTaskPreference>,
}

impl ProjectAiTaskOverrides {
    #[must_use]
    pub fn get(&self, task: AiTaskKind) -> Option<&AiTaskPreference> {
        match task {
            AiTaskKind::WorkDesign => self.work_design.as_ref(),
            AiTaskKind::Outline => self.outline.as_ref(),
            AiTaskKind::VolumePlanning => self.volume_planning.as_ref(),
            AiTaskKind::ChapterSplit => self.chapter_split.as_ref(),
            AiTaskKind::ChapterPlan => self.chapter_plan.as_ref(),
            AiTaskKind::ConsistencyReview => self.consistency_review.as_ref(),
            AiTaskKind::Writing => self.writing.as_ref(),
            AiTaskKind::KnowledgeExtraction => self.knowledge_extraction.as_ref(),
        }
    }
}

impl AiTaskPreferences {
    #[must_use]
    pub fn get(&self, task: AiTaskKind) -> &AiTaskPreference {
        match task {
            AiTaskKind::WorkDesign => &self.work_design,
            AiTaskKind::Outline => &self.outline,
            AiTaskKind::VolumePlanning => &self.volume_planning,
            AiTaskKind::ChapterSplit => &self.chapter_split,
            AiTaskKind::ChapterPlan => &self.chapter_plan,
            AiTaskKind::ConsistencyReview => &self.consistency_review,
            AiTaskKind::Writing => &self.writing,
            AiTaskKind::KnowledgeExtraction => &self.knowledge_extraction,
        }
    }

    fn entries(&self) -> [&AiTaskPreference; 8] {
        [
            &self.work_design,
            &self.outline,
            &self.volume_planning,
            &self.chapter_split,
            &self.chapter_plan,
            &self.consistency_review,
            &self.writing,
            &self.knowledge_extraction,
        ]
    }

    fn set_recommended_defaults(&mut self) {
        self.work_design
            .set_recommended_defaults(AiTaskKind::WorkDesign);
        self.outline.set_recommended_defaults(AiTaskKind::Outline);
        self.volume_planning
            .set_recommended_defaults(AiTaskKind::VolumePlanning);
        self.chapter_split
            .set_recommended_defaults(AiTaskKind::ChapterSplit);
        self.chapter_plan
            .set_recommended_defaults(AiTaskKind::ChapterPlan);
        self.consistency_review
            .set_recommended_defaults(AiTaskKind::ConsistencyReview);
        self.writing.set_recommended_defaults(AiTaskKind::Writing);
        self.knowledge_extraction
            .set_recommended_defaults(AiTaskKind::KnowledgeExtraction);
    }
}

impl AiTaskPreference {
    fn recommended(task: AiTaskKind) -> Self {
        Self {
            profile_id: None,
            fallback_profile_id: None,
            temperature: Some(task.default_temperature()),
            max_output_tokens: Some(task.default_max_output_tokens()),
            prompt: AiTaskPromptPreference::recommended(task),
        }
    }

    fn set_recommended_defaults(&mut self, task: AiTaskKind) {
        self.temperature.get_or_insert(task.default_temperature());
        self.max_output_tokens
            .get_or_insert(task.default_max_output_tokens());
        self.prompt.set_recommended_defaults(task);
    }
}

impl AiTaskPromptPreference {
    fn recommended(task: AiTaskKind) -> Self {
        Self {
            system_prompt: None,
            instruction_template: None,
            context: AiTaskContextPreference::recommended(task),
        }
    }

    fn set_recommended_defaults(&mut self, task: AiTaskKind) {
        self.context.set_recommended_defaults(task);
    }
}

impl AiTaskContextPreference {
    fn recommended(task: AiTaskKind) -> Self {
        Self {
            include_project_context: Some(task.default_include_project_context()),
            include_reference_content: Some(task.default_include_reference_content()),
            include_project_knowledge: Some(task.default_include_project_knowledge()),
            include_current_draft: Some(task.default_include_current_draft()),
            include_chapter_plan: Some(task.default_include_chapter_plan()),
            input_token_budget: Some(task.default_input_token_budget()),
        }
    }

    fn set_recommended_defaults(&mut self, task: AiTaskKind) {
        self.include_project_context
            .get_or_insert(task.default_include_project_context());
        self.include_reference_content
            .get_or_insert(task.default_include_reference_content());
        self.include_project_knowledge
            .get_or_insert(task.default_include_project_knowledge());
        self.include_current_draft
            .get_or_insert(task.default_include_current_draft());
        self.include_chapter_plan
            .get_or_insert(task.default_include_chapter_plan());
        self.input_token_budget
            .get_or_insert(task.default_input_token_budget());
    }
}

#[must_use]
pub fn render_prompt_template(template: &str, variables: &[(&str, &str)]) -> String {
    variables
        .iter()
        .fold(template.to_owned(), |rendered, (name, value)| {
            rendered.replace(&format!("{{{{{name}}}}}"), value)
        })
}

pub fn apply_task_prompt_preferences(
    context: &mut ContextPackage,
    preference: &AiTaskPreference,
    variables: &[(&str, &str)],
) {
    let mut changed = false;
    if let Some(system_prompt) = preference
        .prompt
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        system_prompt.clone_into(&mut context.system_prompt);
        changed = true;
    }
    if let Some(instruction_template) = preference
        .prompt
        .instruction_template
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let rendered = render_prompt_template(instruction_template, variables);
        context.user_prompt.push_str("\n\n[P0 自定义任务模板]\n");
        context.user_prompt.push_str(&rendered);
        changed = true;
    }
    if changed {
        let digest = format!(
            "{:x}",
            Sha256::digest(
                format!("{}\n{}", context.system_prompt, context.user_prompt).as_bytes()
            )
        );
        let suffix = &digest[..8];
        context.prompt_version = format!("{}+task-{suffix}", context.prompt_version);
        context.context_version = format!("{}+task-{suffix}", context.context_version);
    }
}

impl Default for AiTaskPreferences {
    fn default() -> Self {
        Self {
            work_design: AiTaskPreference::recommended(AiTaskKind::WorkDesign),
            outline: AiTaskPreference::recommended(AiTaskKind::Outline),
            volume_planning: AiTaskPreference::recommended(AiTaskKind::VolumePlanning),
            chapter_split: AiTaskPreference::recommended(AiTaskKind::ChapterSplit),
            chapter_plan: AiTaskPreference::recommended(AiTaskKind::ChapterPlan),
            consistency_review: AiTaskPreference::recommended(AiTaskKind::ConsistencyReview),
            writing: AiTaskPreference::recommended(AiTaskKind::Writing),
            knowledge_extraction: AiTaskPreference::recommended(AiTaskKind::KnowledgeExtraction),
        }
    }
}

mod gateway;
mod parsing;
mod profile_store;
mod project_store;
mod secret_store;

pub use gateway::*;
use parsing::*;
pub use profile_store::*;
