use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewClaimType {
    CharacterStatus,
    CharacterLocation,
    AbilityOrRealm,
    ItemPossession,
    Relation,
    KnowledgeBoundary,
    RequiredEvent,
    ForbiddenEvent,
    AllowedCharacter,
    TimeWindow,
    StageBoundary,
    ForeshadowingWindow,
    PlanDependency,
}

impl ReviewClaimType {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "CHARACTER_STATUS" => Some(Self::CharacterStatus),
            "CHARACTER_LOCATION" => Some(Self::CharacterLocation),
            "ABILITY_OR_REALM" => Some(Self::AbilityOrRealm),
            "ITEM_POSSESSION" => Some(Self::ItemPossession),
            "RELATION" => Some(Self::Relation),
            "KNOWLEDGE_BOUNDARY" => Some(Self::KnowledgeBoundary),
            "REQUIRED_EVENT" => Some(Self::RequiredEvent),
            "FORBIDDEN_EVENT" => Some(Self::ForbiddenEvent),
            "ALLOWED_CHARACTER" => Some(Self::AllowedCharacter),
            "TIME_WINDOW" => Some(Self::TimeWindow),
            "STAGE_BOUNDARY" => Some(Self::StageBoundary),
            "FORESHADOWING_WINDOW" => Some(Self::ForeshadowingWindow),
            "PLAN_DEPENDENCY" => Some(Self::PlanDependency),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewStatus {
    Pass,
    Notice,
    Warning,
    Block,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FindingSource {
    Rule,
    Llm,
    Merged,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceAuthority {
    LockedRule,
    ConfirmedFact,
    CurrentState,
    ChapterContract,
    ApprovedEvent,
    PlanReference,
    SummaryReference,
    Unconfirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewClaim {
    pub id: Uuid,
    pub claim_type: ReviewClaimType,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub quote: String,
    pub block_id: String,
    pub start_offset: u32,
    pub end_offset: u32,
    pub importance: u8,
    pub confidence: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub id: Uuid,
    pub claim_id: Uuid,
    pub source_kind: String,
    pub source_record_id: Uuid,
    pub authority: EvidenceAuthority,
    pub excerpt: String,
    pub source_revision: String,
    pub relevance: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    pub id: Uuid,
    pub claim_id: Uuid,
    pub status: ReviewStatus,
    pub severity: String,
    pub source_kind: FindingSource,
    pub rule_id: Option<String>,
    pub rule_version: Option<String>,
    pub priority: u8,
    pub problem: String,
    pub evidence_ids: Vec<Uuid>,
    pub suggestion: String,
    pub confidence: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOmittedItem {
    pub item_type: String,
    pub label: String,
    pub reason: String,
    pub claim_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewStage {
    ClaimExtraction,
    DeterministicRules,
    SemanticReview,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStageRequest {
    pub stage: ReviewStage,
    pub profile_id: Option<Uuid>,
    pub model_id: Option<String>,
    pub request_context_version: String,
    pub request_snapshot: Option<String>,
    pub response_preview: Option<String>,
    pub parse_result: String,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTrace {
    pub run_id: Uuid,
    pub review_purpose: crate::ReviewPurpose,
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub context_version: String,
    pub claims: Vec<ReviewClaim>,
    pub evidence: Vec<ReviewEvidence>,
    pub deterministic_findings: Vec<ReviewFinding>,
    pub model_findings: Vec<ReviewFinding>,
    pub omitted_items: Vec<ReviewOmittedItem>,
    pub stage_requests: Vec<ReviewStageRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContract {
    pub chapter_id: Uuid,
    pub source_section_id: String,
    pub source_revision: String,
    pub confirmed: bool,
    pub required_events: Vec<String>,
    pub forbidden_events: Vec<String>,
    pub allowed_characters: Vec<String>,
    pub time_windows: Vec<String>,
    pub stage_boundaries: Vec<String>,
}

impl ChapterContract {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.required_events.is_empty()
            && self.forbidden_events.is_empty()
            && self.allowed_characters.is_empty()
            && self.time_windows.is_empty()
            && self.stage_boundaries.is_empty()
    }
}

impl ReviewTrace {
    #[must_use]
    pub fn all_findings(&self) -> Vec<ReviewFinding> {
        self.deterministic_findings
            .iter()
            .chain(self.model_findings.iter())
            .cloned()
            .collect()
    }
}
