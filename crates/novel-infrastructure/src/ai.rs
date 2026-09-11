use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use futures_util::StreamExt;
use keyring::Entry;
use novel_application::ContextPackage;
use novel_domain::{
    AiAction, AiContractError, AiProposal, AiProposalStatus, AiTaskStatus, ModelCapability,
    ModelProfile, ModelProfileInput, ModelProvider, PrivacyLevel,
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
            Self::MissingProfile(_) | Self::MissingProposal(_) => "NOT_FOUND",
            Self::SecretStore => "SECRET_STORE_ERROR",
            Self::MissingSecret => "MODEL_SECRET_MISSING",
            Self::PrivacyPolicy => "PRIVACY_POLICY_BLOCKED",
            Self::Authentication => "PROVIDER_AUTHENTICATION",
            Self::RateLimited => "PROVIDER_RATE_LIMITED",
            Self::Timeout => "PROVIDER_TIMEOUT",
            Self::Cancelled => "TASK_CANCELLED",
            Self::InvalidResponse => "PROVIDER_INVALID_RESPONSE",
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
            | Self::ConsistencyReview
            | Self::KnowledgeExtraction => 4_096,
            Self::Outline | Self::VolumePlanning => 6_144,
            Self::Writing => 8_192,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposalReview {
    pub proposal: AiProposal,
    pub validation: AiOutputValidation,
    pub feedback: Option<AiProposalFeedback>,
    pub consistency: Option<AiConsistencyReport>,
    pub consistency_freshness: Option<ConsistencyReviewFreshness>,
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

impl SecretStore {
    #[must_use]
    pub fn secret_ref(profile_id: Uuid) -> String {
        format!("model-profile:{profile_id}")
    }

    pub fn set(secret_ref: &str, secret: &str) -> Result<(), AiError> {
        if secret.trim().is_empty() {
            return Err(AiError::MissingSecret);
        }
        let result = Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)
            .and_then(|entry| entry.set_password(secret).map_err(|_| AiError::SecretStore));
        match result {
            Ok(()) => {
                let _ = dpapi_fallback::delete(secret_ref);
                Ok(())
            }
            Err(_) => dpapi_fallback::set(secret_ref, secret),
        }
    }

    pub fn get(secret_ref: &str) -> Result<String, AiError> {
        let result = Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)
            .and_then(|entry| entry.get_password().map_err(|_| AiError::SecretStore));
        result.or_else(|_| dpapi_fallback::get(secret_ref))
    }

    pub fn delete(secret_ref: &str) -> Result<(), AiError> {
        if let Ok(entry) = Entry::new(SECRET_SERVICE, secret_ref) {
            let _ = entry.delete_credential();
        }
        dpapi_fallback::delete(secret_ref)
    }
}

#[cfg(windows)]
mod dpapi_fallback {
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use super::{AiError, Digest, Sha256};

    const PROTECT_SCRIPT: &str = "$inputText = [Console]::In.ReadToEnd(); $bytes = [Text.Encoding]::UTF8.GetBytes($inputText); $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))";
    const UNPROTECT_SCRIPT: &str = "$encoded = [Console]::In.ReadToEnd(); $protected = [Convert]::FromBase64String($encoded); $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";

    pub(super) fn set(secret_ref: &str, secret: &str) -> Result<(), AiError> {
        let encrypted = run(PROTECT_SCRIPT, secret)?;
        let path = secret_path(secret_ref)?;
        std::fs::write(path, encrypted.trim()).map_err(|_| AiError::SecretStore)
    }

    pub(super) fn get(secret_ref: &str) -> Result<String, AiError> {
        let encrypted =
            std::fs::read_to_string(secret_path(secret_ref)?).map_err(|_| AiError::SecretStore)?;
        run(UNPROTECT_SCRIPT, &encrypted)
    }

    pub(super) fn delete(secret_ref: &str) -> Result<(), AiError> {
        let path = secret_path(secret_ref)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AiError::SecretStore),
        }
    }

    fn secret_path(secret_ref: &str) -> Result<PathBuf, AiError> {
        let root = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("AINovelTools")
            .join("secrets");
        std::fs::create_dir_all(&root).map_err(|_| AiError::SecretStore)?;
        let digest = Sha256::digest(secret_ref.as_bytes());
        Ok(root.join(format!("{digest:x}.dpapi")))
    }

    fn run(script: &str, input: &str) -> Result<String, AiError> {
        run_with_shell("pwsh.exe", script, input)
            .or_else(|_| run_with_shell("powershell.exe", script, input))
    }

    fn run_with_shell(shell: &str, script: &str, input: &str) -> Result<String, AiError> {
        let mut child = Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| AiError::SecretStore)?;
        child
            .stdin
            .as_mut()
            .ok_or(AiError::SecretStore)?
            .write_all(input.as_bytes())
            .map_err(|_| AiError::SecretStore)?;
        let output = child.wait_with_output().map_err(|_| AiError::SecretStore)?;
        if !output.status.success() {
            return Err(AiError::SecretStore);
        }
        String::from_utf8(output.stdout).map_err(|_| AiError::SecretStore)
    }
}

#[cfg(not(windows))]
mod dpapi_fallback {
    use super::AiError;

    pub(super) fn set(_: &str, _: &str) -> Result<(), AiError> {
        Err(AiError::SecretStore)
    }

    pub(super) fn get(_: &str) -> Result<String, AiError> {
        Err(AiError::SecretStore)
    }

    pub(super) fn delete(_: &str) -> Result<(), AiError> {
        Ok(())
    }
}

pub struct ModelGateway {
    client: reqwest::Client,
}

impl Default for ModelGateway {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GenerationOptions {
    pub temperature: Option<f64>,
    pub max_output_tokens: Option<u32>,
}

impl ModelGateway {
    #[must_use]
    pub fn request_preview(
        &self,
        profile: &ModelProfile,
        context: &ContextPackage,
        stream: bool,
        disable_thinking: bool,
    ) -> (String, serde_json::Value) {
        self.request_preview_with_options(
            profile,
            context,
            stream,
            disable_thinking,
            GenerationOptions::default(),
        )
    }

    #[must_use]
    pub fn request_preview_with_options(
        &self,
        profile: &ModelProfile,
        context: &ContextPackage,
        stream: bool,
        disable_thinking: bool,
        options: GenerationOptions,
    ) -> (String, serde_json::Value) {
        let endpoint = format!(
            "{}/chat/completions",
            profile.base_url.trim_end_matches('/')
        );
        let mut body = serde_json::json!({
            "model": profile.model_id,
            "messages": [
                {"role": "system", "content": context.system_prompt},
                {"role": "user", "content": context.user_prompt}
            ],
            "stream": stream
        });
        let token_field = if profile.provider == ModelProvider::OpenAi {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        let max_output_tokens = options
            .max_output_tokens
            .unwrap_or(profile.max_output_tokens)
            .clamp(1, profile.max_output_tokens.max(1));
        body[token_field] = serde_json::json!(max_output_tokens);
        if let Some(temperature) = options.temperature {
            body["temperature"] = serde_json::json!(temperature.clamp(0.0, 2.0));
        }
        if profile.provider == ModelProvider::DeepSeek {
            body["thinking"] = serde_json::json!({
                "type": if disable_thinking { "disabled" } else { "enabled" }
            });
        }
        (endpoint, body)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate<F>(
        &self,
        profile: &ModelProfile,
        secret: Option<&str>,
        context: &ContextPackage,
        stream: bool,
        disable_thinking: bool,
        cancelled: Arc<AtomicBool>,
        on_chunk: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
    {
        self.generate_with_options(
            profile,
            secret,
            context,
            GenerationOptions::default(),
            stream,
            disable_thinking,
            cancelled,
            on_chunk,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate_with_options<F>(
        &self,
        profile: &ModelProfile,
        secret: Option<&str>,
        context: &ContextPackage,
        options: GenerationOptions,
        stream: bool,
        disable_thinking: bool,
        cancelled: Arc<AtomicBool>,
        mut on_chunk: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
    {
        if profile.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
        let (endpoint, body) =
            self.request_preview_with_options(profile, context, stream, disable_thinking, options);
        let attempts = usize::from(profile.retry_limit) + 1;
        for attempt in 0..attempts {
            if cancelled.load(Ordering::Relaxed) {
                return Err(AiError::Cancelled);
            }
            let mut request = self
                .client
                .post(&endpoint)
                .timeout(Duration::from_secs(u64::from(profile.timeout_seconds)))
                .json(&body);
            if let Some(secret) = secret.filter(|value| !value.is_empty()) {
                request = request.bearer_auth(secret);
            }
            match request.send().await {
                Ok(response) => {
                    if !response.status().is_success() {
                        let error = map_status(response.status());
                        if attempt + 1 < attempts
                            && matches!(error, AiError::RateLimited | AiError::ProviderUnavailable)
                        {
                            tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1)))
                                .await;
                            continue;
                        }
                        return Err(error);
                    }
                    return if stream {
                        read_stream(response, cancelled, &mut on_chunk).await
                    } else {
                        let value: serde_json::Value = response
                            .json()
                            .await
                            .map_err(|_| AiError::InvalidResponse)?;
                        message_content(&value).ok_or(AiError::InvalidResponse)
                    };
                }
                Err(error) => {
                    let mapped = if error.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::Network
                    };
                    if attempt + 1 < attempts
                        && matches!(mapped, AiError::Network | AiError::Timeout)
                    {
                        tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Err(mapped);
                }
            }
        }
        Err(AiError::ProviderUnavailable)
    }
}

pub struct EmbeddingGateway {
    client: reqwest::Client,
}

impl Default for EmbeddingGateway {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl EmbeddingGateway {
    pub async fn embed(
        &self,
        profile: &ModelProfile,
        secret: &str,
        input: &str,
    ) -> Result<Vec<f32>, AiError> {
        if profile.capability != ModelCapability::Embedding {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
        if secret.trim().is_empty() {
            return Err(AiError::MissingSecret);
        }
        if input.trim().is_empty() {
            return Err(AiContractError::EmptyAcceptedText.into());
        }
        let endpoint = format!("{}/embeddings", profile.base_url.trim_end_matches('/'));
        let body = serde_json::json!({ "model": profile.model_id, "input": input });
        let attempts = usize::from(profile.retry_limit) + 1;
        for attempt in 0..attempts {
            match self
                .client
                .post(&endpoint)
                .timeout(Duration::from_secs(u64::from(profile.timeout_seconds)))
                .bearer_auth(secret)
                .json(&body)
                .send()
                .await
            {
                Ok(response) => {
                    if !response.status().is_success() {
                        let error = map_status(response.status());
                        if attempt + 1 < attempts
                            && matches!(error, AiError::RateLimited | AiError::ProviderUnavailable)
                        {
                            tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1)))
                                .await;
                            continue;
                        }
                        return Err(error);
                    }
                    let value: serde_json::Value = response
                        .json()
                        .await
                        .map_err(|_| AiError::InvalidResponse)?;
                    let item = value.pointer("/data/0").ok_or(AiError::InvalidResponse)?;
                    return parse_embedding_item(item);
                }
                Err(error) => {
                    let mapped = if error.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::Network
                    };
                    if attempt + 1 < attempts {
                        tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Err(mapped);
                }
            }
        }
        Err(AiError::ProviderUnavailable)
    }

    pub async fn embed_many(
        &self,
        profile: &ModelProfile,
        secret: &str,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, AiError> {
        if profile.capability != ModelCapability::Embedding {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
        if secret.trim().is_empty() {
            return Err(AiError::MissingSecret);
        }
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        if inputs.iter().any(|input| input.trim().is_empty()) {
            return Err(AiContractError::EmptyAcceptedText.into());
        }
        let endpoint = format!("{}/embeddings", profile.base_url.trim_end_matches('/'));
        let body = serde_json::json!({ "model": profile.model_id, "input": inputs });
        let attempts = usize::from(profile.retry_limit) + 1;
        for attempt in 0..attempts {
            match self
                .client
                .post(&endpoint)
                .timeout(Duration::from_secs(u64::from(profile.timeout_seconds)))
                .bearer_auth(secret)
                .json(&body)
                .send()
                .await
            {
                Ok(response) => {
                    if !response.status().is_success() {
                        let error = map_status(response.status());
                        if attempt + 1 < attempts
                            && matches!(error, AiError::RateLimited | AiError::ProviderUnavailable)
                        {
                            tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1)))
                                .await;
                            continue;
                        }
                        return Err(error);
                    }
                    let value: serde_json::Value = response
                        .json()
                        .await
                        .map_err(|_| AiError::InvalidResponse)?;
                    let data = value
                        .get("data")
                        .and_then(serde_json::Value::as_array)
                        .ok_or(AiError::InvalidResponse)?;
                    if data.len() != inputs.len() {
                        return Err(AiError::InvalidResponse);
                    }
                    let mut vectors = vec![None; inputs.len()];
                    for (position, item) in data.iter().enumerate() {
                        let index = item
                            .get("index")
                            .and_then(serde_json::Value::as_u64)
                            .map(|index| usize::try_from(index).unwrap_or(usize::MAX))
                            .unwrap_or(position);
                        let slot = vectors.get_mut(index).ok_or(AiError::InvalidResponse)?;
                        if slot.is_some() {
                            return Err(AiError::InvalidResponse);
                        }
                        *slot = Some(parse_embedding_item(item)?);
                    }
                    return vectors
                        .into_iter()
                        .map(|vector| vector.ok_or(AiError::InvalidResponse))
                        .collect();
                }
                Err(error) => {
                    let mapped = if error.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::Network
                    };
                    if attempt + 1 < attempts {
                        tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Err(mapped);
                }
            }
        }
        Err(AiError::ProviderUnavailable)
    }
}

fn parse_embedding_item(item: &serde_json::Value) -> Result<Vec<f32>, AiError> {
    let vector = item
        .get("embedding")
        .and_then(serde_json::Value::as_array)
        .ok_or(AiError::InvalidResponse)?
        .iter()
        .map(|value| {
            value
                .as_f64()
                .map(embedding_component)
                .ok_or(AiError::InvalidResponse)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if vector.is_empty() {
        return Err(AiError::InvalidResponse);
    }
    Ok(vector)
}

fn content_text(content: &serde_json::Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_owned());
    }
    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
                .collect::<String>()
        })
        .filter(|text| !text.trim().is_empty())
}

fn message_content(value: &serde_json::Value) -> Option<String> {
    content_text(value.pointer("/choices/0/message/content")?)
}

fn stream_delta_content(value: &serde_json::Value) -> Option<String> {
    content_text(value.pointer("/choices/0/delta/content")?)
}

async fn read_stream<F>(
    response: reqwest::Response,
    cancelled: Arc<AtomicBool>,
    on_chunk: &mut F,
) -> Result<String, AiError>
where
    F: FnMut(&str),
{
    let mut bytes = response.bytes_stream();
    let mut raw = Vec::new();
    while let Some(chunk) = bytes.next().await {
        if cancelled.load(Ordering::Relaxed) {
            return Err(AiError::Cancelled);
        }
        let chunk = chunk.map_err(|error| {
            if error.is_timeout() {
                AiError::Timeout
            } else {
                AiError::Network
            }
        })?;
        raw.extend_from_slice(&chunk);
    }

    let body = String::from_utf8_lossy(&raw);
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        let value: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|_| AiError::InvalidResponse)?;
        let output = message_content(&value).ok_or(AiError::InvalidResponse)?;
        on_chunk(&output);
        return Ok(output);
    }

    let mut output = String::new();
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(data).map_err(|_| AiError::InvalidResponse)?;
        if let Some(text) = stream_delta_content(&value) {
            output.push_str(&text);
            on_chunk(&text);
        }
    }
    if output.trim().is_empty() {
        Err(AiError::InvalidResponse)
    } else {
        Ok(output)
    }
}

fn map_status(status: StatusCode) -> AiError {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => AiError::Authentication,
        StatusCode::TOO_MANY_REQUESTS => AiError::RateLimited,
        StatusCode::REQUEST_TIMEOUT | StatusCode::GATEWAY_TIMEOUT => AiError::Timeout,
        code if code.is_server_error() => AiError::ProviderUnavailable,
        _ => AiError::InvalidResponse,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn embedding_component(number: f64) -> f32 {
    number as f32
}

/// Application-wide model configuration store. It intentionally remains
/// independent from the currently open novel project.
pub struct ModelProfileStore {
    database: crate::Database,
}

impl ModelProfileStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        Ok(Self {
            database: crate::Database::open(path)?,
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, DatabaseError> {
        Ok(Self {
            database: crate::Database::in_memory()?,
        })
    }

    pub fn list(&self) -> Result<Vec<ModelProfile>, AiError> {
        let mut statement = self.database.connection.prepare(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles ORDER BY updated_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], read_profile)
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_ai_task_preferences(&self) -> Result<AiTaskPreferences, AiError> {
        let stored = self
            .database
            .connection
            .query_row(
                "SELECT value FROM app_metadata WHERE key = ?1",
                [AI_TASK_PREFERENCES_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let mut preferences = stored.map_or_else(
            || Ok(AiTaskPreferences::default()),
            |value| serde_json::from_str(&value).map_err(|_| AiError::ContextSerialization),
        )?;
        preferences.set_recommended_defaults();
        Ok(preferences)
    }

    pub fn save_ai_task_preferences(
        &mut self,
        preferences: &AiTaskPreferences,
    ) -> Result<AiTaskPreferences, AiError> {
        let mut preferences = preferences.clone();
        preferences.set_recommended_defaults();
        let profiles = self.list()?;
        for preference in preferences.entries() {
            validate_ai_task_preference(preference, &profiles)?;
        }
        let value =
            serde_json::to_string(&preferences).map_err(|_| AiError::ContextSerialization)?;
        self.database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![AI_TASK_PREFERENCES_KEY, value],
            )
            .map_err(DatabaseError::from)?;
        Ok(preferences)
    }

    pub fn get_ai_budget_settings(&self) -> Result<AiBudgetSettings, AiError> {
        let stored = self
            .database
            .connection
            .query_row(
                "SELECT value FROM app_metadata WHERE key = ?1",
                [AI_BUDGET_SETTINGS_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        stored.map_or_else(
            || Ok(AiBudgetSettings::default()),
            |value| {
                let settings = serde_json::from_str::<AiBudgetSettings>(&value)
                    .map_err(|_| AiError::ContextSerialization)?;
                settings.validate()?;
                Ok(settings)
            },
        )
    }

    pub fn save_ai_budget_settings(
        &mut self,
        settings: &AiBudgetSettings,
    ) -> Result<AiBudgetSettings, AiError> {
        settings.validate()?;
        let mut normalized = settings.clone();
        normalized.currency = normalized.currency.trim().to_uppercase();
        let value =
            serde_json::to_string(&normalized).map_err(|_| AiError::ContextSerialization)?;
        self.database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![AI_BUDGET_SETTINGS_KEY, value],
            )
            .map_err(DatabaseError::from)?;
        Ok(normalized)
    }

    pub fn get(&self, id: Uuid) -> Result<ModelProfile, AiError> {
        self.database.connection.query_row(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles WHERE id = ?1",
            [id.to_string()], read_profile,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProfile(id))
    }

    pub fn upsert(&mut self, input: ModelProfileInput) -> Result<ModelProfile, AiError> {
        input.validate()?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        self.database.connection.execute(
            "INSERT INTO model_profiles (id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, capability=excluded.capability, base_url=excluded.base_url, model_id=excluded.model_id, context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens, privacy_level=excluded.privacy_level, timeout_seconds=excluded.timeout_seconds, retry_limit=excluded.retry_limit, input_price_micros_per_million=excluded.input_price_micros_per_million, output_price_micros_per_million=excluded.output_price_micros_per_million, price_currency=excluded.price_currency, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id.to_string(), input.name.trim(), provider_str(input.provider), capability_str(input.capability), input.base_url.trim_end_matches('/'), input.model_id.trim(), input.context_window, input.max_output_tokens, privacy_str(input.privacy_level), input.timeout_seconds, input.retry_limit, i64::try_from(input.input_price_micros_per_million).unwrap_or(i64::MAX), i64::try_from(input.output_price_micros_per_million).unwrap_or(i64::MAX), input.price_currency.trim()],
        ).map_err(DatabaseError::from)?;
        self.get(id)
    }

    pub fn set_secret_ref(
        &mut self,
        id: Uuid,
        secret_ref: Option<&str>,
    ) -> Result<ModelProfile, AiError> {
        let changed = self.database.connection.execute(
            "UPDATE model_profiles SET secret_ref = ?2, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?1",
            rusqlite::params![id.to_string(), secret_ref],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::MissingProfile(id));
        }
        self.get(id)
    }
}

impl ProjectManager {
    pub fn get_project_ai_task_overrides(&self) -> Result<ProjectAiTaskOverrides, AiError> {
        let Some(session) = self.current.as_ref() else {
            return Ok(ProjectAiTaskOverrides::default());
        };
        let mut overrides = ProjectAiTaskOverrides {
            available: true,
            ..ProjectAiTaskOverrides::default()
        };
        let mut statement = session
            .database
            .connection
            .prepare("SELECT task_key, preference_json FROM project_ai_task_overrides")
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let (task_key, preference_json) = row.map_err(DatabaseError::from)?;
            let preference = serde_json::from_str::<AiTaskPreference>(&preference_json)
                .map_err(|_| AiError::ContextSerialization)?;
            match task_key.as_str() {
                "workDesign" => overrides.work_design = Some(preference),
                "outline" => overrides.outline = Some(preference),
                "volumePlanning" => overrides.volume_planning = Some(preference),
                "chapterSplit" => overrides.chapter_split = Some(preference),
                "chapterPlan" => overrides.chapter_plan = Some(preference),
                "consistencyReview" => overrides.consistency_review = Some(preference),
                "writing" => overrides.writing = Some(preference),
                "knowledgeExtraction" => overrides.knowledge_extraction = Some(preference),
                _ => {}
            }
        }
        Ok(overrides)
    }

    pub fn save_project_ai_task_override(
        &mut self,
        task: AiTaskKind,
        preference: &AiTaskPreference,
    ) -> Result<(), AiError> {
        let profiles = self.list_model_profiles()?;
        validate_ai_task_preference(preference, &profiles)?;
        let preference_json =
            serde_json::to_string(preference).map_err(|_| AiError::ContextSerialization)?;
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "INSERT INTO project_ai_task_overrides (task_key, preference_json)
                 VALUES (?1, ?2)
                 ON CONFLICT(task_key) DO UPDATE SET
                    preference_json=excluded.preference_json,
                    updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![task.storage_key(), preference_json],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn save_project_ai_task_overrides(
        &mut self,
        preferences: &AiTaskPreferences,
    ) -> Result<(), AiError> {
        let profiles = self.list_model_profiles()?;
        let entries = [
            (AiTaskKind::WorkDesign, &preferences.work_design),
            (AiTaskKind::Outline, &preferences.outline),
            (AiTaskKind::VolumePlanning, &preferences.volume_planning),
            (AiTaskKind::ChapterSplit, &preferences.chapter_split),
            (AiTaskKind::ChapterPlan, &preferences.chapter_plan),
            (
                AiTaskKind::ConsistencyReview,
                &preferences.consistency_review,
            ),
            (AiTaskKind::Writing, &preferences.writing),
            (
                AiTaskKind::KnowledgeExtraction,
                &preferences.knowledge_extraction,
            ),
        ];
        let mut serialized = Vec::with_capacity(entries.len());
        for (task, preference) in entries {
            validate_ai_task_preference(preference, &profiles)?;
            serialized.push((
                task.storage_key(),
                serde_json::to_string(preference).map_err(|_| AiError::ContextSerialization)?,
            ));
        }

        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        for (task_key, preference_json) in serialized {
            transaction
                .execute(
                    "INSERT INTO project_ai_task_overrides (task_key, preference_json)
                     VALUES (?1, ?2)
                     ON CONFLICT(task_key) DO UPDATE SET
                        preference_json=excluded.preference_json,
                        updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    rusqlite::params![task_key, preference_json],
                )
                .map_err(DatabaseError::from)?;
        }
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn remove_project_ai_task_override(&mut self, task: AiTaskKind) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "DELETE FROM project_ai_task_overrides WHERE task_key=?1",
                [task.storage_key()],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn list_model_profiles(&self) -> Result<Vec<ModelProfile>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles ORDER BY updated_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], read_profile)
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_model_profile(&self, id: Uuid) -> Result<ModelProfile, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session.database.connection.query_row(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency, secret_ref, created_at, updated_at FROM model_profiles WHERE id = ?1",
            [id.to_string()], read_profile,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProfile(id))
    }

    pub fn upsert_model_profile(
        &mut self,
        input: ModelProfileInput,
    ) -> Result<ModelProfile, AiError> {
        input.validate()?;
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        session.database.connection.execute(
            "INSERT INTO model_profiles (id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, input_price_micros_per_million, output_price_micros_per_million, price_currency)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, capability=excluded.capability, base_url=excluded.base_url, model_id=excluded.model_id, context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens, privacy_level=excluded.privacy_level, timeout_seconds=excluded.timeout_seconds, retry_limit=excluded.retry_limit, input_price_micros_per_million=excluded.input_price_micros_per_million, output_price_micros_per_million=excluded.output_price_micros_per_million, price_currency=excluded.price_currency, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id.to_string(), input.name.trim(), provider_str(input.provider), capability_str(input.capability), input.base_url.trim_end_matches('/'), input.model_id.trim(), input.context_window, input.max_output_tokens, privacy_str(input.privacy_level), input.timeout_seconds, input.retry_limit, i64::try_from(input.input_price_micros_per_million).unwrap_or(i64::MAX), i64::try_from(input.output_price_micros_per_million).unwrap_or(i64::MAX), input.price_currency.trim()],
        ).map_err(DatabaseError::from)?;
        self.get_model_profile(id)
    }

    pub fn set_model_profile_secret_ref(
        &mut self,
        id: Uuid,
        secret_ref: Option<&str>,
    ) -> Result<ModelProfile, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let changed = session.database.connection.execute(
            "UPDATE model_profiles SET secret_ref = ?2, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?1",
            rusqlite::params![id.to_string(), secret_ref],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::MissingProfile(id));
        }
        self.get_model_profile(id)
    }

    pub fn create_ai_task(
        &mut self,
        profile_id: Uuid,
        context: &ContextPackage,
    ) -> Result<Uuid, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let profile_snapshot: Option<(String, String, u64, u64, String)> = session
            .database
            .connection
            .query_row(
                "SELECT p.capability, COALESCE(c.title, '未命名章节'),
                        p.input_price_micros_per_million, p.output_price_micros_per_million,
                        p.price_currency
                 FROM model_profiles p
                 LEFT JOIN chapters c ON c.id = ?2
                 WHERE p.id = ?1",
                rusqlite::params![profile_id.to_string(), context.chapter_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        u64::try_from(row.get::<_, i64>(2)?.max(0)).unwrap_or(0),
                        u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let Some((capability, chapter_title, input_price, output_price, price_currency)) =
            profile_snapshot
        else {
            return Err(AiError::MissingProfile(profile_id));
        };
        match capability.as_str() {
            "CHAT" => {}
            _ => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let task_id = Uuid::new_v4();
        let task_contract_json = serde_json::to_string(&context.task_contract)
            .map_err(|_| AiError::ContextSerialization)?;
        let context_section_audit_json = serde_json::to_string(&context.section_audit)
            .map_err(|_| AiError::ContextSerialization)?;
        let task_kind = if context.action == AiAction::ConsistencyCheck {
            AiTaskKind::ConsistencyReview
        } else {
            AiTaskKind::Writing
        };
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        transaction.execute(
            "INSERT INTO ai_tasks (id, profile_id, chapter_id, action, target_revision_id, context_version, prompt_version, task_contract_json, context_section_audit_json, status, estimated_input_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![task_id.to_string(), profile_id.to_string(), context.chapter_id.to_string(), action_str(context.action), context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, task_contract_json, context_section_audit_json, task_status_str(AiTaskStatus::Running), context.estimated_input_tokens],
        ).map_err(DatabaseError::from)?;
        transaction
            .execute(
                "INSERT INTO ai_run_records (
                id, task_key, source, chapter_id, display_title, profile_id, action, status,
                estimated_input_tokens, input_price_micros_per_million,
                output_price_micros_per_million, price_currency, prompt_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    task_id.to_string(),
                    task_kind.storage_key(),
                    AiRunSource::Writing.storage_key(),
                    context.chapter_id.to_string(),
                    chapter_title,
                    profile_id.to_string(),
                    action_str(context.action),
                    task_status_str(AiTaskStatus::Running),
                    context.estimated_input_tokens,
                    i64::try_from(input_price).unwrap_or(i64::MAX),
                    i64::try_from(output_price).unwrap_or(i64::MAX),
                    price_currency,
                    context.prompt_version
                ],
            )
            .map_err(DatabaseError::from)?;
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(task_id)
    }

    pub fn start_ai_run(&mut self, input: AiRunStart<'_>) -> Result<Uuid, AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability_and_prices: Option<(String, u64, u64, String)> = session
            .database
            .connection
            .query_row(
                "SELECT capability, input_price_micros_per_million,
                        output_price_micros_per_million, price_currency
                 FROM model_profiles WHERE id = ?1",
                [input.profile_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        u64::try_from(row.get::<_, i64>(1)?.max(0)).unwrap_or(0),
                        u64::try_from(row.get::<_, i64>(2)?.max(0)).unwrap_or(0),
                        row.get(3)?,
                    ))
                },
            )
            .optional()
            .map_err(DatabaseError::from)?;
        let Some((capability, input_price, output_price, price_currency)) = capability_and_prices
        else {
            return Err(AiError::MissingProfile(input.profile_id));
        };
        if capability != "CHAT" {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
        let run_id = Uuid::new_v4();
        session
            .database
            .connection
            .execute(
                "INSERT INTO ai_run_records (
                id, task_key, source, job_id, chapter_id, display_title, profile_id, action,
                status, estimated_input_tokens, input_price_micros_per_million,
                output_price_micros_per_million, price_currency, prompt_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?2, 'RUNNING', ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    run_id.to_string(),
                    input.task.storage_key(),
                    input.source.storage_key(),
                    input.job_id.map(|id| id.to_string()),
                    input.chapter_id.map(|id| id.to_string()),
                    input.display_title.trim(),
                    input.profile_id.to_string(),
                    input.estimated_input_tokens,
                    i64::try_from(input_price).unwrap_or(i64::MAX),
                    i64::try_from(output_price).unwrap_or(i64::MAX),
                    price_currency,
                    input.prompt_version
                ],
            )
            .map_err(DatabaseError::from)?;
        Ok(run_id)
    }

    pub fn complete_ai_task(
        &mut self,
        task_id: Uuid,
        context: &ContextPackage,
        output_text: String,
    ) -> Result<AiProposal, AiError> {
        if output_text.trim().is_empty() {
            return Err(AiError::InvalidResponse);
        }
        let estimated_output_tokens =
            u32::try_from(output_text.trim().chars().count().div_ceil(4)).unwrap_or(u32::MAX);
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        transaction.execute("UPDATE ai_tasks SET status='COMPLETED', estimated_output_tokens=?2, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1 AND status='RUNNING'", rusqlite::params![task_id.to_string(), estimated_output_tokens]).map_err(DatabaseError::from)?;
        transaction.execute(
            "UPDATE ai_run_records SET status='COMPLETED', estimated_output_tokens=?2,
                finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1 AND status='RUNNING'",
            rusqlite::params![task_id.to_string(), estimated_output_tokens],
        )
        .map_err(DatabaseError::from)?;
        let proposal_id = Uuid::new_v4();
        transaction.execute(
            "INSERT INTO ai_proposals (id, task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING')",
            rusqlite::params![proposal_id.to_string(), task_id.to_string(), context.chapter_id.to_string(), action_str(context.action), context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, output_text],
        ).map_err(DatabaseError::from)?;
        transaction.commit().map_err(DatabaseError::from)?;
        self.get_ai_proposal(proposal_id)
    }

    pub fn fail_ai_task(&mut self, task_id: Uuid, error: &AiError) -> Result<(), AiError> {
        self.fail_ai_run(task_id, error)
    }

    pub fn fail_ai_run(&mut self, run_id: Uuid, error: &AiError) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let status = if matches!(error, AiError::Cancelled) {
            "CANCELLED"
        } else {
            "FAILED"
        };
        session
            .database
            .connection
            .execute(
                "UPDATE ai_tasks SET status=?2, error_code=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
                rusqlite::params![run_id.to_string(), status, error.code()],
            )
            .map_err(DatabaseError::from)?;
        session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET status=?2, error_code=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
                rusqlite::params![run_id.to_string(), status, error.code()],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn complete_ai_run(
        &mut self,
        run_id: Uuid,
        estimated_output_tokens: u32,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let changed = session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET status='COMPLETED', estimated_output_tokens=?2,
                    finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![run_id.to_string(), estimated_output_tokens],
            )
            .map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        Ok(())
    }

    pub fn record_ai_task_fallback(
        &mut self,
        task_id: Uuid,
        fallback_profile_id: Uuid,
        reason: &str,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability: Option<String> = session
            .database
            .connection
            .query_row(
                "SELECT capability FROM model_profiles WHERE id = ?1",
                [fallback_profile_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        match capability.as_deref() {
            None => return Err(AiError::MissingProfile(fallback_profile_id)),
            Some("CHAT") => {}
            Some(_) => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let changed = session.database.connection.execute(
            "UPDATE ai_tasks SET profile_id=?2, fallback_profile_id=?2, attempt_count=attempt_count+1, retry_reason=?3 WHERE id=?1 AND status='RUNNING'",
            rusqlite::params![task_id.to_string(), fallback_profile_id.to_string(), reason],
        ).map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET
                profile_id=?2,
                fallback_profile_id=?2,
                attempt_count=attempt_count+1,
                retry_reason=?3,
                input_price_micros_per_million=COALESCE(
                    (SELECT input_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                ),
                output_price_micros_per_million=COALESCE(
                    (SELECT output_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                ),
                price_currency=COALESCE(
                    (SELECT price_currency FROM model_profiles WHERE id=?2), 'USD'
                )
             WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![task_id.to_string(), fallback_profile_id.to_string(), reason],
            )
            .map_err(DatabaseError::from)?;
        Ok(())
    }

    pub fn record_ai_run_fallback(
        &mut self,
        run_id: Uuid,
        fallback_profile_id: Uuid,
        reason: &str,
    ) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let capability: Option<String> = session
            .database
            .connection
            .query_row(
                "SELECT capability FROM model_profiles WHERE id = ?1",
                [fallback_profile_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        match capability.as_deref() {
            None => return Err(AiError::MissingProfile(fallback_profile_id)),
            Some("CHAT") => {}
            Some(_) => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let changed = session
            .database
            .connection
            .execute(
                "UPDATE ai_run_records SET
                    profile_id=?2,
                    fallback_profile_id=?2,
                    attempt_count=attempt_count+1,
                    retry_reason=?3,
                    input_price_micros_per_million=COALESCE(
                        (SELECT input_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                    ),
                    output_price_micros_per_million=COALESCE(
                        (SELECT output_price_micros_per_million FROM model_profiles WHERE id=?2), 0
                    ),
                    price_currency=COALESCE(
                        (SELECT price_currency FROM model_profiles WHERE id=?2), 'USD'
                    )
                 WHERE id=?1 AND status='RUNNING'",
                rusqlite::params![run_id.to_string(), fallback_profile_id.to_string(), reason],
            )
            .map_err(DatabaseError::from)?;
        if changed == 0 {
            return Err(AiError::InvalidResponse);
        }
        Ok(())
    }

    pub fn list_ai_runs(&self, limit: u32) -> Result<Vec<AiRun>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT t.id, t.action, t.status, t.display_title, COALESCE(p.name, '已删除模型'),
                        t.attempt_count, t.retry_reason, t.error_code, t.estimated_input_tokens,
                        t.estimated_output_tokens, t.prompt_version, t.created_at, t.finished_at,
                        t.task_key, t.source, t.input_price_micros_per_million,
                        t.output_price_micros_per_million, t.price_currency
                 FROM ai_run_records t
                 LEFT JOIN model_profiles p ON p.id = t.profile_id
                 ORDER BY t.created_at DESC, t.rowid DESC
                 LIMIT ?1",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([i64::from(limit.clamp(1, 100))], |row| {
                let id = Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(AiRun {
                    id,
                    task_key: row.get(13)?,
                    source: row.get(14)?,
                    action: row.get(1)?,
                    status: row.get(2)?,
                    chapter_title: row.get(3)?,
                    profile_name: row.get(4)?,
                    attempt_count: row.get(5)?,
                    retry_reason: row.get(6)?,
                    error_code: row.get(7)?,
                    estimated_input_tokens: row.get(8)?,
                    estimated_output_tokens: row.get(9)?,
                    estimated_cost_micros: estimate_run_cost_micros(
                        row.get(8)?,
                        row.get(9)?,
                        u64::try_from(row.get::<_, i64>(15)?.max(0)).unwrap_or(0),
                        u64::try_from(row.get::<_, i64>(16)?.max(0)).unwrap_or(0),
                    ),
                    price_currency: row.get(17)?,
                    prompt_version: row.get(10)?,
                    created_at: row.get(11)?,
                    finished_at: row.get(12)?,
                })
            })
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn get_ai_usage_summary(&self, days: u32) -> Result<AiUsageSummary, AiError> {
        let days = days.clamp(1, 365);
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut total_by_currency = HashMap::<String, UsageAggregate>::new();
        let mut total_by_task = HashMap::<(String, String), UsageAggregate>::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT task_key, estimated_input_tokens, estimated_output_tokens,
                        input_price_micros_per_million, output_price_micros_per_million,
                        price_currency
                 FROM ai_run_records",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], |row| {
                Ok(UsageRunRow {
                    task_key: row.get(0)?,
                    input_tokens: u64::from(row.get::<_, u32>(1)?),
                    output_tokens: u64::from(row.get::<_, u32>(2)?),
                    input_price: u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                    output_price: u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                    currency: row.get(5)?,
                    date: None,
                })
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let row = row.map_err(DatabaseError::from)?;
            total_by_currency
                .entry(row.currency.clone())
                .or_default()
                .add(&row);
            total_by_task
                .entry((row.task_key.clone(), row.currency.clone()))
                .or_default()
                .add(&row);
        }

        let modifier = format!("-{} days", days.saturating_sub(1));
        let mut daily_by_currency = HashMap::<(String, String), UsageAggregate>::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT task_key, estimated_input_tokens, estimated_output_tokens,
                        input_price_micros_per_million, output_price_micros_per_million,
                        price_currency, date(created_at, 'localtime')
                 FROM ai_run_records
                 WHERE date(created_at, 'localtime') >= date('now', 'localtime', ?1)",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([modifier], |row| {
                Ok(UsageRunRow {
                    task_key: row.get(0)?,
                    input_tokens: u64::from(row.get::<_, u32>(1)?),
                    output_tokens: u64::from(row.get::<_, u32>(2)?),
                    input_price: u64::try_from(row.get::<_, i64>(3)?.max(0)).unwrap_or(0),
                    output_price: u64::try_from(row.get::<_, i64>(4)?.max(0)).unwrap_or(0),
                    currency: row.get(5)?,
                    date: Some(row.get(6)?),
                })
            })
            .map_err(DatabaseError::from)?;
        for row in rows {
            let row = row.map_err(DatabaseError::from)?;
            let date = row.date.clone().ok_or(AiError::InvalidResponse)?;
            daily_by_currency
                .entry((date, row.currency.clone()))
                .or_default()
                .add(&row);
        }

        let mut total = total_by_currency
            .into_iter()
            .map(|(currency, aggregate)| aggregate.into_currency(currency))
            .collect::<Vec<_>>();
        total.sort_by(|left, right| left.currency.cmp(&right.currency));
        let mut daily = daily_by_currency
            .into_iter()
            .map(|((date, currency), aggregate)| AiUsageDailySummary {
                date,
                usage: aggregate.into_currency(currency),
            })
            .collect::<Vec<_>>();
        daily.sort_by(|left, right| {
            right
                .date
                .cmp(&left.date)
                .then_with(|| left.usage.currency.cmp(&right.usage.currency))
        });
        let mut by_task = total_by_task
            .into_iter()
            .map(|((task_key, currency), aggregate)| AiUsageTaskSummary {
                task_key,
                usage: aggregate.into_currency(currency),
            })
            .collect::<Vec<_>>();
        by_task.sort_by(|left, right| {
            left.task_key
                .cmp(&right.task_key)
                .then_with(|| left.usage.currency.cmp(&right.usage.currency))
        });
        Ok(AiUsageSummary {
            days,
            total,
            daily,
            by_task,
        })
    }

    pub fn get_ai_quality_summary(&self, limit: u32) -> Result<AiQualitySummary, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT r.task_key, r.action, r.prompt_version,
                        COALESCE(p.name, '已删除模型'), pr.status, pr.output_text,
                        f.rating
                 FROM ai_proposals pr
                 INNER JOIN ai_run_records r ON r.id = pr.task_id
                 LEFT JOIN model_profiles p ON p.id = r.profile_id
                 LEFT JOIN ai_proposal_feedback f ON f.proposal_id = pr.id",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(DatabaseError::from)?;
        let mut groups = HashMap::<(String, String, String, String), QualityAggregate>::new();
        for row in rows {
            let (task_key, action, prompt_version, profile_name, status, output_text, rating) =
                row.map_err(DatabaseError::from)?;
            let validation = validate_ai_output(parse_action(&action), &output_text);
            let aggregate = groups
                .entry((task_key, action, prompt_version, profile_name))
                .or_default();
            aggregate.proposals = aggregate.proposals.saturating_add(1);
            if matches!(status.as_str(), "ACCEPTED" | "PARTIALLY_ACCEPTED") {
                aggregate.accepted = aggregate.accepted.saturating_add(1);
            }
            match rating.as_deref() {
                Some("HELPFUL") => {
                    aggregate.rated = aggregate.rated.saturating_add(1);
                    aggregate.helpful = aggregate.helpful.saturating_add(1);
                }
                Some("NOT_HELPFUL") => {
                    aggregate.rated = aggregate.rated.saturating_add(1);
                    aggregate.not_helpful = aggregate.not_helpful.saturating_add(1);
                }
                _ => {}
            }
            match validation.status.as_str() {
                "VALID" => aggregate.valid = aggregate.valid.saturating_add(1),
                "WARNING" => aggregate.warnings = aggregate.warnings.saturating_add(1),
                "NEEDS_INPUT" => {
                    aggregate.needs_input = aggregate.needs_input.saturating_add(1);
                }
                _ => aggregate.invalid = aggregate.invalid.saturating_add(1),
            }
        }

        let mut summary = AiQualitySummary {
            total_proposals: 0,
            total_rated: 0,
            total_helpful: 0,
            total_with_issues: 0,
            groups: Vec::new(),
        };
        for ((task_key, action, prompt_version, profile_name), aggregate) in groups {
            summary.total_proposals = summary.total_proposals.saturating_add(aggregate.proposals);
            summary.total_rated = summary.total_rated.saturating_add(aggregate.rated);
            summary.total_helpful = summary.total_helpful.saturating_add(aggregate.helpful);
            summary.total_with_issues = summary
                .total_with_issues
                .saturating_add(aggregate.warnings)
                .saturating_add(aggregate.needs_input)
                .saturating_add(aggregate.invalid);
            summary.groups.push(AiQualityGroup {
                task_key,
                action,
                prompt_version,
                profile_name,
                proposal_count: aggregate.proposals,
                accepted_count: aggregate.accepted,
                rated_count: aggregate.rated,
                helpful_count: aggregate.helpful,
                not_helpful_count: aggregate.not_helpful,
                valid_count: aggregate.valid,
                warning_count: aggregate.warnings,
                needs_input_count: aggregate.needs_input,
                invalid_count: aggregate.invalid,
            });
        }
        summary.groups.sort_by(|left, right| {
            right
                .proposal_count
                .cmp(&left.proposal_count)
                .then_with(|| left.task_key.cmp(&right.task_key))
                .then_with(|| left.prompt_version.cmp(&right.prompt_version))
                .then_with(|| left.profile_name.cmp(&right.profile_name))
        });
        summary
            .groups
            .truncate(usize::try_from(limit.clamp(1, 100)).unwrap_or(100));
        Ok(summary)
    }

    pub fn list_ai_proposals(&self, chapter_id: Uuid) -> Result<Vec<AiProposal>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, accepted_text, status, created_at, decided_at FROM ai_proposals WHERE chapter_id=?1 ORDER BY created_at DESC"
        ).map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([chapter_id.to_string()], read_proposal)
            .map_err(DatabaseError::from)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn list_ai_proposal_reviews(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<AiProposalReview>, AiError> {
        let proposals = self.list_ai_proposals(chapter_id)?;
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut feedback = HashMap::new();
        let mut statement = session
            .database
            .connection
            .prepare(
                "SELECT f.proposal_id, f.rating, f.note, f.created_at, f.updated_at
                 FROM ai_proposal_feedback f
                 INNER JOIN ai_proposals p ON p.id = f.proposal_id
                 WHERE p.chapter_id = ?1",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement
            .query_map([chapter_id.to_string()], read_proposal_feedback)
            .map_err(DatabaseError::from)?;
        for item in rows {
            let item = item.map_err(DatabaseError::from)?;
            feedback.insert(item.proposal_id, item);
        }
        Ok(proposals
            .into_iter()
            .map(|proposal| {
                let consistency = (proposal.action == AiAction::ConsistencyCheck)
                    .then(|| parse_consistency_report(&proposal.output_text));
                AiProposalReview {
                    validation: validate_ai_output(proposal.action, &proposal.output_text),
                    feedback: feedback.remove(&proposal.id),
                    consistency,
                    consistency_freshness: None,
                    proposal,
                }
            })
            .collect())
    }

    pub fn mark_consistency_review_freshness(
        reviews: &mut [AiProposalReview],
        current_context_version: Option<&str>,
    ) {
        let Some(current_context_version) = current_context_version else {
            return;
        };
        for review in reviews {
            if review.proposal.action == AiAction::ConsistencyCheck
                && review.proposal.status == AiProposalStatus::Pending
            {
                review.consistency_freshness = Some(
                    if review.proposal.context_version == current_context_version {
                        ConsistencyReviewFreshness::Fresh
                    } else {
                        ConsistencyReviewFreshness::Stale
                    },
                );
            }
        }
    }

    pub fn chapter_writing_admission(
        &self,
        chapter_id: Uuid,
        current_context_version: Option<&str>,
    ) -> Result<WritingAdmission, AiError> {
        let Some(review) = self
            .list_ai_proposal_reviews(chapter_id)?
            .into_iter()
            .find(|item| {
                item.proposal.action == AiAction::ConsistencyCheck
                    && item.proposal.status == AiProposalStatus::Pending
            })
        else {
            return Ok(WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: None,
                review_freshness: ConsistencyReviewFreshness::Missing,
            });
        };
        if current_context_version.is_some_and(|version| version != review.proposal.context_version)
        {
            return Ok(WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: Some(
                    "审核依据已经变化，原审核结果已过期，不再参与正文生成准入。".to_owned(),
                ),
                review_freshness: ConsistencyReviewFreshness::Stale,
            });
        }
        let Some(report) = review.consistency else {
            return Ok(WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: None,
                review_freshness: ConsistencyReviewFreshness::Missing,
            });
        };
        match report.verdict {
            AiConsistencyVerdict::Blocked => {
                let blocker_count = report
                    .findings
                    .iter()
                    .filter(|finding| finding.severity == AiConsistencySeverity::Blocker)
                    .count();
                Ok(WritingAdmission {
                    allowed: false,
                    blocker_count,
                    reason: Some(format!(
                        "最近一次一致性审核发现 {blocker_count} 个阻断问题，请先处理并关闭审核后再生成正文。"
                    )),
                    review_freshness: ConsistencyReviewFreshness::Fresh,
                })
            }
            AiConsistencyVerdict::NeedsInput => Ok(WritingAdmission {
                allowed: false,
                blocker_count: 0,
                reason: Some(
                    "最近一次一致性审核缺少判断准入所需的正式设定，请补齐并关闭审核后再生成正文。"
                        .to_owned(),
                ),
                review_freshness: ConsistencyReviewFreshness::Fresh,
            }),
            AiConsistencyVerdict::Pass
            | AiConsistencyVerdict::Review
            | AiConsistencyVerdict::Unparsed => Ok(WritingAdmission {
                allowed: true,
                blocker_count: 0,
                reason: None,
                review_freshness: ConsistencyReviewFreshness::Fresh,
            }),
        }
    }

    pub fn rate_ai_proposal(
        &mut self,
        proposal_id: Uuid,
        rating: AiProposalFeedbackRating,
        note: Option<String>,
    ) -> Result<AiProposalFeedback, AiError> {
        let _ = self.get_ai_proposal(proposal_id)?;
        let note = note.filter(|value| !value.trim().is_empty());
        if note
            .as_deref()
            .is_some_and(|value| value.chars().count() > 2_000)
        {
            return Err(AiContractError::InvalidGenerationOptions.into());
        }
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .execute(
                "INSERT INTO ai_proposal_feedback (proposal_id, rating, note)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(proposal_id) DO UPDATE SET
                    rating=excluded.rating,
                    note=excluded.note,
                    updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![proposal_id.to_string(), feedback_rating_str(rating), note],
            )
            .map_err(DatabaseError::from)?;
        self.get_ai_proposal_feedback(proposal_id)?
            .ok_or(AiError::InvalidResponse)
    }

    pub fn get_ai_proposal_feedback(
        &self,
        proposal_id: Uuid,
    ) -> Result<Option<AiProposalFeedback>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session
            .database
            .connection
            .query_row(
                "SELECT proposal_id, rating, note, created_at, updated_at
                 FROM ai_proposal_feedback WHERE proposal_id=?1",
                [proposal_id.to_string()],
                read_proposal_feedback,
            )
            .optional()
            .map_err(DatabaseError::from)
            .map_err(AiError::from)
    }

    pub fn decide_ai_proposal(
        &mut self,
        id: Uuid,
        status: AiProposalStatus,
        accepted_text: Option<String>,
    ) -> Result<AiProposal, AiError> {
        let current = self.get_ai_proposal(id)?;
        if current.status != AiProposalStatus::Pending || status == AiProposalStatus::Pending {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        if current.action == AiAction::ConsistencyCheck && status != AiProposalStatus::Rejected {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        if status != AiProposalStatus::Rejected
            && validate_ai_output(current.action, &current.output_text).status == "NEEDS_INPUT"
        {
            return Err(AiContractError::InvalidProposalTransition.into());
        }
        let accepted = match status {
            AiProposalStatus::Accepted => Some(current.output_text.clone()),
            AiProposalStatus::PartiallyAccepted => {
                let text = accepted_text
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AiContractError::EmptyAcceptedText)?;
                Some(text)
            }
            AiProposalStatus::Rejected => None,
            AiProposalStatus::Pending => unreachable!(),
        };
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        session.database.connection.execute(
            "UPDATE ai_proposals SET status=?2, accepted_text=?3, decided_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
            rusqlite::params![id.to_string(), proposal_status_str(status), accepted],
        ).map_err(DatabaseError::from)?;
        self.get_ai_proposal(id)
    }

    fn get_ai_proposal(&self, id: Uuid) -> Result<AiProposal, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        session.database.connection.query_row(
            "SELECT id, task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, accepted_text, status, created_at, decided_at FROM ai_proposals WHERE id=?1",
            [id.to_string()], read_proposal,
        ).optional().map_err(DatabaseError::from)?.ok_or(AiError::MissingProposal(id))
    }
}

fn read_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelProfile> {
    let secret_ref: Option<String> = row.get(14)?;
    Ok(ModelProfile {
        id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        name: row.get(1)?,
        provider: parse_provider(&row.get::<_, String>(2)?),
        capability: parse_capability(&row.get::<_, String>(3)?),
        base_url: row.get(4)?,
        model_id: row.get(5)?,
        context_window: row.get(6)?,
        max_output_tokens: row.get(7)?,
        privacy_level: parse_privacy(&row.get::<_, String>(8)?),
        timeout_seconds: row.get(9)?,
        retry_limit: row.get(10)?,
        input_price_micros_per_million: u64::try_from(row.get::<_, i64>(11)?.max(0)).unwrap_or(0),
        output_price_micros_per_million: u64::try_from(row.get::<_, i64>(12)?.max(0)).unwrap_or(0),
        price_currency: row.get(13)?,
        has_secret: secret_ref.is_some(),
        secret_ref,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

struct UsageRunRow {
    task_key: String,
    input_tokens: u64,
    output_tokens: u64,
    input_price: u64,
    output_price: u64,
    currency: String,
    date: Option<String>,
}

#[derive(Default)]
struct UsageAggregate {
    run_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    estimated_cost_micros: Option<u64>,
}

impl UsageAggregate {
    fn add(&mut self, row: &UsageRunRow) {
        self.run_count = self.run_count.saturating_add(1);
        self.input_tokens = self.input_tokens.saturating_add(row.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(row.output_tokens);
        if let Some(cost) = estimate_run_cost_micros(
            u32::try_from(row.input_tokens).unwrap_or(u32::MAX),
            u32::try_from(row.output_tokens).unwrap_or(u32::MAX),
            row.input_price,
            row.output_price,
        ) {
            self.estimated_cost_micros =
                Some(self.estimated_cost_micros.unwrap_or(0).saturating_add(cost));
        }
    }

    fn into_currency(self, currency: String) -> AiUsageCurrencySummary {
        AiUsageCurrencySummary {
            currency,
            run_count: u32::try_from(self.run_count).unwrap_or(u32::MAX),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            estimated_cost_micros: self.estimated_cost_micros,
        }
    }
}

#[derive(Default)]
struct QualityAggregate {
    proposals: u32,
    accepted: u32,
    rated: u32,
    helpful: u32,
    not_helpful: u32,
    valid: u32,
    warnings: u32,
    needs_input: u32,
    invalid: u32,
}

fn estimate_run_cost_micros(
    input_tokens: u32,
    output_tokens: u32,
    input_price_micros_per_million: u64,
    output_price_micros_per_million: u64,
) -> Option<u64> {
    if input_price_micros_per_million == 0 && output_price_micros_per_million == 0 {
        return None;
    }
    let cost = u128::from(input_tokens) * u128::from(input_price_micros_per_million)
        + u128::from(output_tokens) * u128::from(output_price_micros_per_million);
    u64::try_from(cost / 1_000_000).ok()
}

fn read_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProposal> {
    Ok(AiProposal {
        id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        task_id: parse_uuid(row.get::<_, String>(1)?, 1)?,
        chapter_id: parse_uuid(row.get::<_, String>(2)?, 2)?,
        action: parse_action(&row.get::<_, String>(3)?),
        target_revision_id: row
            .get::<_, Option<String>>(4)?
            .map(|value| parse_uuid(value, 4))
            .transpose()?,
        context_version: row.get(5)?,
        prompt_version: row.get(6)?,
        output_text: row.get(7)?,
        accepted_text: row.get(8)?,
        status: parse_proposal_status(&row.get::<_, String>(9)?),
        created_at: row.get(10)?,
        decided_at: row.get(11)?,
    })
}

fn read_proposal_feedback(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProposalFeedback> {
    Ok(AiProposalFeedback {
        proposal_id: parse_uuid(row.get::<_, String>(0)?, 0)?,
        rating: parse_feedback_rating(&row.get::<_, String>(1)?),
        note: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn parse_uuid(value: String, column: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
fn provider_str(value: ModelProvider) -> &'static str {
    match value {
        ModelProvider::SiliconFlow => "SILICON_FLOW",
        ModelProvider::DeepSeek => "DEEPSEEK",
        ModelProvider::OpenAi => "OPEN_AI",
        ModelProvider::OpenAiCompatible => "OPEN_AI_COMPATIBLE",
    }
}
fn parse_provider(value: &str) -> ModelProvider {
    match value {
        "SILICON_FLOW" => ModelProvider::SiliconFlow,
        "DEEPSEEK" => ModelProvider::DeepSeek,
        "OPEN_AI" => ModelProvider::OpenAi,
        _ => ModelProvider::OpenAiCompatible,
    }
}
fn capability_str(value: ModelCapability) -> &'static str {
    match value {
        ModelCapability::Chat => "CHAT",
        ModelCapability::Embedding => "EMBEDDING",
    }
}
fn parse_capability(value: &str) -> ModelCapability {
    if value == "EMBEDDING" {
        ModelCapability::Embedding
    } else {
        ModelCapability::Chat
    }
}
fn privacy_str(value: PrivacyLevel) -> &'static str {
    match value {
        PrivacyLevel::LocalOnly => "LOCAL_ONLY",
        PrivacyLevel::AllowCloud => "ALLOW_CLOUD",
    }
}
fn parse_privacy(value: &str) -> PrivacyLevel {
    if value == "ALLOW_CLOUD" {
        PrivacyLevel::AllowCloud
    } else {
        PrivacyLevel::LocalOnly
    }
}
fn feedback_rating_str(value: AiProposalFeedbackRating) -> &'static str {
    match value {
        AiProposalFeedbackRating::Helpful => "HELPFUL",
        AiProposalFeedbackRating::NotHelpful => "NOT_HELPFUL",
    }
}
fn parse_feedback_rating(value: &str) -> AiProposalFeedbackRating {
    match value {
        "HELPFUL" => AiProposalFeedbackRating::Helpful,
        _ => AiProposalFeedbackRating::NotHelpful,
    }
}
fn validate_ai_task_preference(
    preference: &AiTaskPreference,
    profiles: &[ModelProfile],
) -> Result<(), AiError> {
    if preference
        .temperature
        .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        || preference.max_output_tokens == Some(0)
        || preference
            .prompt
            .context
            .input_token_budget
            .is_some_and(|value| !(256..=1_000_000).contains(&value))
        || preference
            .prompt
            .system_prompt
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
        || preference
            .prompt
            .instruction_template
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
    {
        return Err(AiContractError::InvalidGenerationOptions.into());
    }
    if let Some(profile_id) = preference.profile_id {
        let profile = profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(AiError::MissingProfile(profile_id))?;
        if profile.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
    }
    if let Some(fallback_profile_id) = preference.fallback_profile_id {
        if preference.profile_id == Some(fallback_profile_id) {
            return Err(AiContractError::InvalidGenerationOptions.into());
        }
        let fallback = profiles
            .iter()
            .find(|profile| profile.id == fallback_profile_id)
            .ok_or(AiError::MissingProfile(fallback_profile_id))?;
        if fallback.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
    }
    Ok(())
}
fn parse_consistency_report(output_text: &str) -> AiConsistencyReport {
    let trimmed = output_text.trim();
    if trimmed.contains("[上下文不足]") {
        return AiConsistencyReport {
            verdict: AiConsistencyVerdict::NeedsInput,
            summary: first_report_line(trimmed)
                .unwrap_or_else(|| "正式设定不足，无法判断生成准入。".to_owned()),
            findings: Vec::new(),
            parse_warnings: Vec::new(),
        };
    }

    let mut summary = None;
    let mut findings = Vec::new();
    let mut parse_warnings = Vec::new();
    for raw_line in trimmed.lines() {
        let line = raw_line.trim().trim_start_matches(['-', '*']).trim();
        if line.is_empty() {
            continue;
        }
        let Some((severity, body)) = parse_consistency_finding_line(line) else {
            if summary.is_none() {
                summary = Some(
                    line.trim_start_matches("审核结论：")
                        .trim_start_matches("审核结论:")
                        .to_owned(),
                );
            }
            continue;
        };
        let parts = split_consistency_finding(body);
        if parts.is_empty() {
            parse_warnings.push(format!("忽略缺少问题内容的审核行：{line}"));
            continue;
        }
        if parts.len() < 3 {
            parse_warnings.push(format!("问题缺少“依据｜建议”字段：{}", parts[0]));
        }
        findings.push(AiConsistencyFinding {
            severity,
            problem: parts.first().cloned().unwrap_or_default(),
            evidence: parts.get(1).cloned().unwrap_or_default(),
            suggestion: parts.get(2..).unwrap_or_default().join("｜"),
        });
    }

    let verdict = if findings
        .iter()
        .any(|finding| finding.severity == AiConsistencySeverity::Blocker)
    {
        AiConsistencyVerdict::Blocked
    } else if !findings.is_empty() {
        AiConsistencyVerdict::Review
    } else if summary
        .as_deref()
        .is_some_and(|value| value.contains("未发现冲突") || value.contains("通过"))
    {
        AiConsistencyVerdict::Pass
    } else {
        AiConsistencyVerdict::Unparsed
    };
    AiConsistencyReport {
        verdict,
        summary: summary.unwrap_or_else(|| "审核报告未提供明确结论。".to_owned()),
        findings,
        parse_warnings,
    }
}

fn first_report_line(output_text: &str) -> Option<String> {
    output_text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_consistency_finding_line(line: &str) -> Option<(AiConsistencySeverity, &str)> {
    let rest = line.strip_prefix('[')?;
    let marker_end = rest.find(']')?;
    let severity = match rest[..marker_end].trim() {
        "阻断" | "阻断级" | "BLOCKER" | "blocker" => AiConsistencySeverity::Blocker,
        "严重" | "重要" | "MAJOR" | "major" => AiConsistencySeverity::Major,
        "一般" | "MINOR" | "minor" => AiConsistencySeverity::Minor,
        "提示" | "建议" | "INFO" | "info" => AiConsistencySeverity::Info,
        _ => return None,
    };
    Some((
        severity,
        rest[marker_end + 1..]
            .trim()
            .trim_start_matches([':', '：'])
            .trim(),
    ))
}

fn split_consistency_finding(body: &str) -> Vec<String> {
    let separator = if body.contains('｜') {
        '｜'
    } else if body.contains('|') {
        '|'
    } else {
        return body
            .trim()
            .is_empty()
            .then(Vec::new)
            .unwrap_or_else(|| vec![body.trim().to_owned()]);
    };
    body.split(separator)
        .map(str::trim)
        .map(ToOwned::to_owned)
        .collect()
}

fn validate_ai_output(action: AiAction, output_text: &str) -> AiOutputValidation {
    let trimmed = output_text.trim();
    let needs_input = trimmed.contains("[上下文不足]");
    let character_count = trimmed.chars().count();
    let paragraph_count = trimmed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let mut messages = Vec::new();
    if needs_input {
        messages.push("模型没有生成可用结果，要求先补齐正式设定。".to_owned());
    } else if trimmed.is_empty() {
        messages.push("输出为空，不能形成候选。".to_owned());
    } else {
        if character_count < 20 {
            messages.push("输出明显过短，建议检查是否被模型提前截断。".to_owned());
        }
        if paragraph_count == 0 {
            messages.push("输出没有可识别的段落结构。".to_owned());
        }
        if trimmed.contains("```") {
            messages.push("正文候选包含 Markdown 代码围栏，应用前建议清理。".to_owned());
        }
        if [
            "好的",
            "当然",
            "以下是",
            "我会",
            "下面是",
            "作为AI",
            "作为 AI",
        ]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
        {
            messages.push("输出开头包含对话式说明，可能混入了模型元话语。".to_owned());
        }
        if trimmed.ends_with("...")
            || trimmed.ends_with('…')
            || trimmed.ends_with("（未完")
            || trimmed.ends_with("(未完")
        {
            messages.push("输出结尾像未完成内容，建议续写或重新生成。".to_owned());
        }
        if trimmed.starts_with('{') && trimmed.ends_with('}') && action != AiAction::Summarize {
            messages.push("正文候选看起来是 JSON 结构，与应用合同不一致。".to_owned());
        }
    }
    AiOutputValidation {
        status: if needs_input {
            "NEEDS_INPUT".to_owned()
        } else if trimmed.is_empty() {
            "INVALID".to_owned()
        } else if messages.is_empty() {
            "VALID".to_owned()
        } else {
            "WARNING".to_owned()
        },
        messages,
        character_count,
        paragraph_count,
        estimated_output_tokens: u32::try_from(character_count.div_ceil(4)).unwrap_or(u32::MAX),
    }
}
fn action_str(value: AiAction) -> &'static str {
    match value {
        AiAction::Draft => "DRAFT",
        AiAction::Continue => "CONTINUE",
        AiAction::Rewrite => "REWRITE",
        AiAction::Polish => "POLISH",
        AiAction::Summarize => "SUMMARIZE",
        AiAction::ConsistencyCheck => "CONSISTENCY_CHECK",
    }
}
fn parse_action(value: &str) -> AiAction {
    match value {
        "DRAFT" => AiAction::Draft,
        "REWRITE" => AiAction::Rewrite,
        "POLISH" => AiAction::Polish,
        "SUMMARIZE" => AiAction::Summarize,
        "CONSISTENCY_CHECK" => AiAction::ConsistencyCheck,
        _ => AiAction::Continue,
    }
}
fn task_status_str(value: AiTaskStatus) -> &'static str {
    match value {
        AiTaskStatus::Running => "RUNNING",
        AiTaskStatus::Completed => "COMPLETED",
        AiTaskStatus::Failed => "FAILED",
        AiTaskStatus::Cancelled => "CANCELLED",
    }
}
fn proposal_status_str(value: AiProposalStatus) -> &'static str {
    match value {
        AiProposalStatus::Pending => "PENDING",
        AiProposalStatus::Accepted => "ACCEPTED",
        AiProposalStatus::PartiallyAccepted => "PARTIALLY_ACCEPTED",
        AiProposalStatus::Rejected => "REJECTED",
    }
}
fn parse_proposal_status(value: &str) -> AiProposalStatus {
    match value {
        "ACCEPTED" => AiProposalStatus::Accepted,
        "PARTIALLY_ACCEPTED" => AiProposalStatus::PartiallyAccepted,
        "REJECTED" => AiProposalStatus::Rejected,
        _ => AiProposalStatus::Pending,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    use std::time::Duration;

    fn serve(body: &'static str, content_type: &'static str, delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock provider");
        let address = listener.local_addr().expect("mock address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0_u8; 16_384];
            let _ = stream.read(&mut request);
            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{address}/v1")
    }

    fn profile(base_url: String, timeout_seconds: u32) -> novel_domain::ModelProfile {
        novel_domain::ModelProfile {
            id: uuid::Uuid::new_v4(),
            name: "mock".into(),
            provider: novel_domain::ModelProvider::OpenAiCompatible,
            capability: novel_domain::ModelCapability::Chat,
            base_url,
            model_id: "mock-model".into(),
            context_window: 4_096,
            max_output_tokens: 512,
            privacy_level: novel_domain::PrivacyLevel::AllowCloud,
            timeout_seconds,
            retry_limit: 0,
            input_price_micros_per_million: 0,
            output_price_micros_per_million: 0,
            price_currency: "USD".into(),
            secret_ref: None,
            has_secret: false,
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }

    fn context() -> novel_application::ContextPackage {
        novel_application::ContextPackage::connection_test()
    }

    #[test]
    fn writing_actions_round_trip() {
        for action in [
            novel_domain::AiAction::Draft,
            novel_domain::AiAction::Continue,
            novel_domain::AiAction::Rewrite,
            novel_domain::AiAction::Polish,
            novel_domain::AiAction::Summarize,
            novel_domain::AiAction::ConsistencyCheck,
        ] {
            assert_eq!(super::parse_action(super::action_str(action)), action);
        }
    }

    #[test]
    fn context_insufficient_output_requires_input_instead_of_becoming_prose() {
        let validation = super::validate_ai_output(
            novel_domain::AiAction::Draft,
            "[上下文不足]\n- 主角卡：未建立\n- 境界规则：缺失",
        );
        assert_eq!(validation.status, "NEEDS_INPUT");
        assert!(
            validation
                .messages
                .iter()
                .any(|message| message.contains("没有生成可用结果"))
        );
    }

    #[test]
    fn consistency_report_parser_classifies_findings_and_admission() {
        let report = super::parse_consistency_report(
            "审核结论：阻断\n[阻断] 主角姓名未确定｜主角卡未建立｜先确定主角姓名并建立主角卡。\n[提示] 开场动机可以更具体｜执行卡只写了寻找师父｜补充动机来源。",
        );
        assert_eq!(report.verdict, super::AiConsistencyVerdict::Blocked);
        assert_eq!(report.findings.len(), 2);
        assert_eq!(
            report.findings[0].severity,
            super::AiConsistencySeverity::Blocker
        );
        assert_eq!(report.findings[0].problem, "主角姓名未确定");
        assert_eq!(report.findings[0].evidence, "主角卡未建立");
        assert_eq!(
            report.findings[0].suggestion,
            "先确定主角姓名并建立主角卡。"
        );

        let passed = super::parse_consistency_report("审核结论：通过（未发现冲突）");
        assert_eq!(passed.verdict, super::AiConsistencyVerdict::Pass);

        let incomplete = super::parse_consistency_report("[严重] 境界边界冲突");
        assert_eq!(incomplete.findings.len(), 1);
        assert!(!incomplete.parse_warnings.is_empty());
    }

    #[test]
    fn provider_statuses_are_stable() {
        assert_eq!(
            super::map_status(reqwest::StatusCode::UNAUTHORIZED).code(),
            "PROVIDER_AUTHENTICATION"
        );
        assert_eq!(
            super::map_status(reqwest::StatusCode::TOO_MANY_REQUESTS).code(),
            "PROVIDER_RATE_LIMITED"
        );
        assert_eq!(
            super::provider_str(novel_domain::ModelProvider::SiliconFlow),
            "SILICON_FLOW"
        );
    }

    #[test]
    fn ai_task_defaults_match_product_recommendations() {
        let cases: [(super::AiTaskKind, f64, u32); 8] = [
            (super::AiTaskKind::WorkDesign, 0.45, 4_096),
            (super::AiTaskKind::Outline, 0.6, 6_144),
            (super::AiTaskKind::VolumePlanning, 0.55, 6_144),
            (super::AiTaskKind::ChapterSplit, 0.3, 4_096),
            (super::AiTaskKind::ChapterPlan, 0.35, 4_096),
            (super::AiTaskKind::ConsistencyReview, 0.2, 4_096),
            (super::AiTaskKind::Writing, 0.9, 8_192),
            (super::AiTaskKind::KnowledgeExtraction, 0.1, 4_096),
        ];

        for (task, temperature, max_output_tokens) in cases {
            assert_eq!(task.default_temperature().to_bits(), temperature.to_bits());
            assert_eq!(task.default_max_output_tokens(), max_output_tokens);
        }
    }

    #[test]
    fn model_profile_store_is_available_without_an_open_project() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let saved = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "应用级模型".into(),
                provider: novel_domain::ModelProvider::DeepSeek,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-v4-flash".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 2_000_000,
                output_price_micros_per_million: 4_000_000,
                price_currency: "USD".into(),
            })
            .expect("save profile");

        let saved = store
            .set_secret_ref(saved.id, Some("model-profile:test"))
            .expect("save secret reference");
        assert!(saved.has_secret);
        assert_eq!(store.list().expect("list profiles").len(), 1);
    }

    #[test]
    fn ai_task_model_preferences_round_trip_without_an_open_project() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let chat = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "任务模型".into(),
                provider: novel_domain::ModelProvider::DeepSeek,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-v4-flash".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 2_000_000,
                output_price_micros_per_million: 4_000_000,
                price_currency: "USD".into(),
            })
            .expect("chat profile");
        let fallback = store
            .upsert(novel_domain::ModelProfileInput {
                id: None,
                name: "备用任务模型".into(),
                provider: novel_domain::ModelProvider::OpenAi,
                capability: novel_domain::ModelCapability::Chat,
                base_url: "https://api.openai.com/v1".into(),
                model_id: "gpt-test".into(),
                context_window: 128_000,
                max_output_tokens: 8_192,
                privacy_level: novel_domain::PrivacyLevel::AllowCloud,
                timeout_seconds: 120,
                retry_limit: 1,
                input_price_micros_per_million: 1_000_000,
                output_price_micros_per_million: 2_000_000,
                price_currency: "USD".into(),
            })
            .expect("fallback profile");
        let preference = super::AiTaskPreference {
            profile_id: Some(chat.id),
            fallback_profile_id: Some(fallback.id),
            temperature: Some(0.8),
            max_output_tokens: Some(4_096),
            prompt: super::AiTaskPromptPreference {
                system_prompt: Some("优先保持人物视角一致。".into()),
                instruction_template: Some("章节：{{chapterTitle}}".into()),
                context: super::AiTaskContextPreference {
                    include_project_context: Some(true),
                    include_reference_content: Some(false),
                    include_project_knowledge: Some(true),
                    include_current_draft: Some(false),
                    include_chapter_plan: Some(true),
                    input_token_budget: Some(24_576),
                },
            },
        };
        let preferences = super::AiTaskPreferences {
            work_design: preference.clone(),
            outline: preference.clone(),
            volume_planning: preference.clone(),
            chapter_split: preference.clone(),
            chapter_plan: preference.clone(),
            consistency_review: preference.clone(),
            writing: preference.clone(),
            knowledge_extraction: preference,
        };

        let saved = store
            .save_ai_task_preferences(&preferences)
            .expect("save preferences");
        assert_eq!(saved, preferences);
        assert_eq!(
            store.get_ai_task_preferences().expect("read preferences"),
            preferences
        );
    }

    #[test]
    fn ai_budget_settings_round_trip_and_normalize_currency() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        assert_eq!(
            store.get_ai_budget_settings().expect("default settings"),
            super::AiBudgetSettings::default()
        );
        let saved = store
            .save_ai_budget_settings(&super::AiBudgetSettings {
                currency: " cny ".into(),
                daily_limit_micros: Some(10_000_000),
                project_limit_micros: Some(100_000_000),
            })
            .expect("save budget");
        assert_eq!(saved.currency, "CNY");
        assert_eq!(store.get_ai_budget_settings().expect("read budget"), saved);
    }

    #[test]
    fn ai_task_preferences_read_legacy_profile_ids() {
        let profile_id = uuid::Uuid::new_v4();
        let preferences: super::AiTaskPreferences = serde_json::from_str(&format!(
            r#"{{"workDesign":"{profile_id}","outline":null}}"#
        ))
        .expect("legacy preferences");

        assert_eq!(preferences.work_design.profile_id, Some(profile_id));
        assert_eq!(preferences.work_design.temperature, None);
        assert_eq!(preferences.work_design.max_output_tokens, None);
        assert_eq!(
            preferences.work_design.prompt,
            super::AiTaskPromptPreference::default()
        );
        assert_eq!(preferences.outline, super::AiTaskPreference::default());
    }

    #[test]
    fn ai_task_preferences_read_fills_missing_tuning_with_recommendations() {
        let store = super::ModelProfileStore::in_memory().expect("settings store");
        let profile_id = uuid::Uuid::new_v4();
        store
            .database
            .connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)",
                rusqlite::params![
                    super::AI_TASK_PREFERENCES_KEY,
                    format!(
                        r#"{{"workDesign":"{profile_id}","outline":{{"profileId":null,"temperature":null,"maxOutputTokens":null}}}}"#
                    )
                ],
            )
            .expect("legacy preferences");

        let preferences = store.get_ai_task_preferences().expect("read preferences");

        assert_eq!(preferences.work_design.profile_id, Some(profile_id));
        assert_eq!(preferences.work_design.temperature, Some(0.45));
        assert_eq!(preferences.work_design.max_output_tokens, Some(4_096));
        assert_eq!(preferences.outline.temperature, Some(0.6));
        assert_eq!(preferences.outline.max_output_tokens, Some(6_144));
        assert_eq!(preferences.volume_planning.temperature, Some(0.55));
        assert_eq!(preferences.volume_planning.max_output_tokens, Some(6_144));
        assert_eq!(preferences.chapter_split.temperature, Some(0.3));
        assert_eq!(preferences.chapter_split.max_output_tokens, Some(4_096));
        assert_eq!(preferences.chapter_plan.temperature, Some(0.35));
        assert_eq!(preferences.chapter_plan.max_output_tokens, Some(4_096));
        assert_eq!(preferences.consistency_review.temperature, Some(0.2));
        assert_eq!(
            preferences.consistency_review.max_output_tokens,
            Some(4_096)
        );
        assert_eq!(preferences.writing.temperature, Some(0.9));
        assert_eq!(preferences.writing.max_output_tokens, Some(8_192));
        assert_eq!(preferences.knowledge_extraction.temperature, Some(0.1));
        assert_eq!(
            preferences.knowledge_extraction.max_output_tokens,
            Some(4_096)
        );
    }

    #[test]
    fn ai_task_preferences_save_fills_defaults_without_overriding_user_tuning() {
        let mut store = super::ModelProfileStore::in_memory().expect("settings store");
        let mut preferences = super::AiTaskPreferences {
            work_design: super::AiTaskPreference::default(),
            outline: super::AiTaskPreference::default(),
            volume_planning: super::AiTaskPreference::default(),
            chapter_split: super::AiTaskPreference::default(),
            chapter_plan: super::AiTaskPreference::default(),
            consistency_review: super::AiTaskPreference::default(),
            writing: super::AiTaskPreference::default(),
            knowledge_extraction: super::AiTaskPreference::default(),
        };
        preferences.outline.temperature = Some(0.75);
        preferences.outline.max_output_tokens = Some(3_200);
        preferences
            .chapter_split
            .prompt
            .context
            .include_project_knowledge = Some(false);

        let saved = store
            .save_ai_task_preferences(&preferences)
            .expect("save preferences");

        assert_eq!(saved.work_design.temperature, Some(0.45));
        assert_eq!(saved.work_design.max_output_tokens, Some(4_096));
        assert_eq!(saved.outline.temperature, Some(0.75));
        assert_eq!(saved.outline.max_output_tokens, Some(3_200));
        assert_eq!(
            saved.chapter_split.prompt.context.include_project_knowledge,
            Some(false)
        );
        assert_eq!(saved.chapter_plan.temperature, Some(0.35));
        assert_eq!(saved.chapter_plan.max_output_tokens, Some(4_096));
        assert_eq!(saved.consistency_review.temperature, Some(0.2));
        assert_eq!(saved.consistency_review.max_output_tokens, Some(4_096));
        assert_eq!(saved.writing.temperature, Some(0.9));
        assert_eq!(saved.writing.max_output_tokens, Some(8_192));
        assert_eq!(
            store.get_ai_task_preferences().expect("read preferences"),
            saved
        );
    }

    #[test]
    fn task_prompt_preferences_render_variables_and_change_context_versions() {
        let mut context = novel_application::ContextPackage::connection_test();
        let original_prompt_version = context.prompt_version.clone();
        let original_context_version = context.context_version.clone();
        let preference = super::AiTaskPreference {
            prompt: super::AiTaskPromptPreference {
                system_prompt: Some("你是严谨的执行编辑。".into()),
                instruction_template: Some(
                    "章节：{{chapterTitle}}\n作者意见：{{userInstruction}}".into(),
                ),
                context: super::AiTaskContextPreference::default(),
            },
            ..super::AiTaskPreference::default()
        };

        super::apply_task_prompt_preferences(
            &mut context,
            &preference,
            &[
                ("chapterTitle", "雨夜来客"),
                ("userInstruction", "让冲突先藏后露"),
            ],
        );

        assert_eq!(context.system_prompt, "你是严谨的执行编辑。");
        assert!(
            context
                .user_prompt
                .ends_with("[P0 自定义任务模板]\n章节：雨夜来客\n作者意见：让冲突先藏后露")
        );
        assert_ne!(context.prompt_version, original_prompt_version);
        assert_ne!(context.context_version, original_context_version);
    }

    #[test]
    fn request_preview_applies_and_clamps_generation_options() {
        let gateway = super::ModelGateway::default();
        let (_, body) = gateway.request_preview_with_options(
            &profile("https://example.invalid/v1".into(), 9),
            &context(),
            false,
            false,
            super::GenerationOptions {
                temperature: Some(0.5),
                max_output_tokens: Some(99_999),
            },
        );

        assert_eq!(body["temperature"], serde_json::json!(0.5));
        assert_eq!(body["max_tokens"], serde_json::json!(512));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires unsandboxed Windows credential or DPAPI storage access"]
    fn windows_secret_store_round_trips() {
        let secret_ref = format!("test:{}", uuid::Uuid::new_v4());
        super::SecretStore::set(&secret_ref, "temporary-test-secret").expect("write credential");
        assert_eq!(
            super::SecretStore::get(&secret_ref).expect("read credential"),
            "temporary-test-secret"
        );
        super::SecretStore::delete(&secret_ref).expect("delete credential");
    }

    #[tokio::test]
    async fn gateway_reads_non_streaming_and_streaming_responses() {
        let gateway = super::ModelGateway::default();
        let non_stream_url = serve(
            r#"{"choices":[{"message":{"content":"候选正文"}}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(non_stream_url, 3),
                Some("test-key"),
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("non-stream response");
        assert_eq!(output, "候选正文");

        let stream_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"候选\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"正文\"}}]}\n\ndata: [DONE]\n\n",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("stream response");
        assert_eq!(output, "候选正文");

        let json_stream_url = serve(
            r#"{"choices":[{"message":{"content":"非流式候选"}}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(json_stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("json fallback response");
        assert_eq!(output, "非流式候选");

        let unterminated_stream_url = serve(
            "data: {\"choices\":[{\"delta\":{\"content\":\"无结束空行\"}}]}",
            "text/event-stream",
            Duration::ZERO,
        );
        let output = gateway
            .generate(
                &profile(unterminated_stream_url, 3),
                None,
                &context(),
                true,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("unterminated stream response");
        assert_eq!(output, "无结束空行");
    }

    #[tokio::test]
    async fn deepseek_requests_enable_thinking_mode() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock provider");
        let address = listener.local_addr().expect("mock address");
        let request = Arc::new(Mutex::new(String::new()));
        let request_capture = Arc::clone(&request);
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 16_384];
            let count = stream.read(&mut buffer).expect("read request");
            *request_capture.lock().expect("request lock") =
                String::from_utf8_lossy(&buffer[..count]).into_owned();
            let body = r#"{"choices":[{"message":{"content":"连接成功"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let mut profile = profile(format!("http://{address}/v1"), 3);
        profile.provider = novel_domain::ModelProvider::DeepSeek;
        let output = super::ModelGateway::default()
            .generate(
                &profile,
                Some("test-key"),
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("DeepSeek response");

        assert_eq!(output, "连接成功");
        assert!(
            request
                .lock()
                .expect("request lock")
                .contains(r#""thinking":{"type":"enabled"}"#)
        );
    }

    #[tokio::test]
    async fn gateway_honors_cancellation_and_timeout() {
        let gateway = super::ModelGateway::default();
        let cancelled = Arc::new(AtomicBool::new(true));
        assert!(matches!(
            gateway
                .generate(
                    &profile("https://example.invalid/v1".into(), 3),
                    None,
                    &context(),
                    false,
                    false,
                    cancelled,
                    |_| {},
                )
                .await,
            Err(super::AiError::Cancelled)
        ));

        let timeout_url = serve(
            r#"{"choices":[{"message":{"content":"too late"}}]}"#,
            "application/json",
            Duration::from_millis(1_200),
        );
        let result = gateway
            .generate(
                &profile(timeout_url, 1),
                None,
                &context(),
                false,
                false,
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await;
        assert!(matches!(result, Err(super::AiError::Timeout)));
    }

    #[tokio::test]
    async fn embedding_gateway_reads_vectors_and_rejects_chat_profiles() {
        let gateway = super::EmbeddingGateway::default();
        let embedding_url = serve(
            r#"{"data":[{"embedding":[0.25,-0.5,0.75]}]}"#,
            "application/json",
            Duration::ZERO,
        );
        let mut embedding_profile = profile(embedding_url, 3);
        embedding_profile.provider = novel_domain::ModelProvider::SiliconFlow;
        embedding_profile.capability = novel_domain::ModelCapability::Embedding;
        let vector = gateway
            .embed(&embedding_profile, "test-key", "测试文本")
            .await
            .expect("embedding");
        assert_eq!(vector, vec![0.25, -0.5, 0.75]);

        let batch_url = serve(
            r#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#,
            "application/json",
            Duration::ZERO,
        );
        embedding_profile.base_url = batch_url;
        let vectors = gateway
            .embed_many(
                &embedding_profile,
                "test-key",
                &["first".to_owned(), "second".to_owned()],
            )
            .await
            .expect("batch embeddings");
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);

        assert!(matches!(
            gateway
                .embed(
                    &profile("https://example.invalid/v1".into(), 3),
                    "test-key",
                    "text"
                )
                .await,
            Err(super::AiError::Contract(
                novel_domain::AiContractError::InvalidProviderCapability
            ))
        ));
    }
}
