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
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CharacterStatus => "CHARACTER_STATUS",
            Self::CharacterLocation => "CHARACTER_LOCATION",
            Self::AbilityOrRealm => "ABILITY_OR_REALM",
            Self::ItemPossession => "ITEM_POSSESSION",
            Self::Relation => "RELATION",
            Self::KnowledgeBoundary => "KNOWLEDGE_BOUNDARY",
            Self::RequiredEvent => "REQUIRED_EVENT",
            Self::ForbiddenEvent => "FORBIDDEN_EVENT",
            Self::AllowedCharacter => "ALLOWED_CHARACTER",
            Self::TimeWindow => "TIME_WINDOW",
            Self::StageBoundary => "STAGE_BOUNDARY",
            Self::ForeshadowingWindow => "FORESHADOWING_WINDOW",
            Self::PlanDependency => "PLAN_DEPENDENCY",
        }
    }

    #[must_use]
    pub fn supports(self, purpose: crate::ReviewPurpose) -> bool {
        match purpose {
            crate::ReviewPurpose::Admission => matches!(
                self,
                Self::RequiredEvent
                    | Self::ForbiddenEvent
                    | Self::AllowedCharacter
                    | Self::TimeWindow
                    | Self::StageBoundary
                    | Self::ForeshadowingWindow
                    | Self::PlanDependency
            ),
            crate::ReviewPurpose::Manuscript => matches!(
                self,
                Self::CharacterStatus
                    | Self::CharacterLocation
                    | Self::AbilityOrRealm
                    | Self::ItemPossession
                    | Self::Relation
                    | Self::KnowledgeBoundary
            ),
        }
    }

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvidenceSource {
    Entity,
    Fact,
    WorldState,
    Relation,
    Belief,
    Event,
    Foreshadowing,
    LockedRule,
    ChapterContract,
}

impl ReviewEvidenceSource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Entity => "ENTITY",
            Self::Fact => "FACT",
            Self::WorldState => "WORLD_STATE",
            Self::Relation => "RELATION",
            Self::Belief => "BELIEF",
            Self::Event => "EVENT",
            Self::Foreshadowing => "FORESHADOWING",
            Self::LockedRule => "LOCKED_RULE",
            Self::ChapterContract => "CHAPTER_CONTRACT",
        }
    }
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
    pub source_kind: ReviewEvidenceSource,
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
    #[serde(default)]
    pub rule_scope: Option<String>,
    #[serde(default)]
    pub rule_effective_at: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_types_declare_their_review_purpose() {
        assert!(ReviewClaimType::RequiredEvent.supports(crate::ReviewPurpose::Admission));
        assert!(!ReviewClaimType::RequiredEvent.supports(crate::ReviewPurpose::Manuscript));
        assert!(ReviewClaimType::CharacterStatus.supports(crate::ReviewPurpose::Manuscript));
        assert!(!ReviewClaimType::CharacterStatus.supports(crate::ReviewPurpose::Admission));
        assert_eq!(
            ReviewClaimType::KnowledgeBoundary.as_str(),
            "KNOWLEDGE_BOUNDARY"
        );
    }

    #[test]
    fn evidence_source_keeps_existing_json_shape() {
        let sources = [
            (ReviewEvidenceSource::Entity, "\"ENTITY\""),
            (ReviewEvidenceSource::Fact, "\"FACT\""),
            (ReviewEvidenceSource::WorldState, "\"WORLD_STATE\""),
            (ReviewEvidenceSource::Relation, "\"RELATION\""),
            (ReviewEvidenceSource::Belief, "\"BELIEF\""),
            (ReviewEvidenceSource::Event, "\"EVENT\""),
            (ReviewEvidenceSource::Foreshadowing, "\"FORESHADOWING\""),
            (ReviewEvidenceSource::LockedRule, "\"LOCKED_RULE\""),
            (
                ReviewEvidenceSource::ChapterContract,
                "\"CHAPTER_CONTRACT\"",
            ),
        ];
        for (source, expected) in sources {
            let serialized = serde_json::to_string(&source).expect("serialize");
            assert_eq!(serialized, expected);
            let restored: ReviewEvidenceSource =
                serde_json::from_str(expected).expect("deserialize");
            assert_eq!(restored, source);
            assert_eq!(source.as_str(), expected.trim_matches('"'));
        }
    }

    #[test]
    fn legacy_findings_without_rule_metadata_still_deserialize() {
        let finding: ReviewFinding = serde_json::from_str(
            r#"{
                "id": "00000000-0000-0000-0000-000000000001",
                "claimId": "00000000-0000-0000-0000-000000000002",
                "status": "BLOCK",
                "severity": "BLOCKER",
                "sourceKind": "RULE",
                "ruleId": "FACT_OBJECT_CONFLICT",
                "ruleVersion": "1",
                "priority": 5,
                "problem": "冲突",
                "evidenceIds": [],
                "suggestion": "修改",
                "confidence": 100
            }"#,
        )
        .expect("legacy finding");
        assert_eq!(finding.rule_scope, None);
        assert_eq!(finding.rule_effective_at, None);
    }
}
