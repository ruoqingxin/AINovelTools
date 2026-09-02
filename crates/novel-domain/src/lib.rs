//! Core business rules for novel projects.
//!
//! This crate must remain independent from desktop, persistence, and network
//! frameworks.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
mod entity;
mod materials;
pub use entity::{
    Entity, EntityError, EntityInput, EntityLifecycleStatus, EntityRevision, EntityType,
};
pub use materials::{SummaryKind, SummaryMaterial, SummaryPrecision, WritingCard};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelProvider {
    SiliconFlow,
    DeepSeek,
    OpenAi,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelCapability {
    Chat,
    Embedding,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrivacyLevel {
    LocalOnly,
    AllowCloud,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: Uuid,
    pub name: String,
    pub provider: ModelProvider,
    pub capability: ModelCapability,
    pub base_url: String,
    pub model_id: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub privacy_level: PrivacyLevel,
    pub timeout_seconds: u32,
    pub retry_limit: u8,
    pub secret_ref: Option<String>,
    pub has_secret: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfileInput {
    pub id: Option<Uuid>,
    pub name: String,
    pub provider: ModelProvider,
    pub capability: ModelCapability,
    pub base_url: String,
    pub model_id: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub privacy_level: PrivacyLevel,
    pub timeout_seconds: u32,
    pub retry_limit: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiAction {
    Continue,
    Rewrite,
    Polish,
    Summarize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RetrievalMethod {
    Structured,
    Keyword,
    Semantic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContextAuthority {
    AuthoritativeFact,
    TaskMaterial,
    Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingIdentity {
    pub profile_id: Uuid,
    pub model_id: String,
    pub dimensions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub id: Uuid,
    pub source_id: Uuid,
    pub source_revision: String,
    pub source_hash: String,
    pub chunk_index: u32,
    pub chunking_version: String,
    pub content: String,
    pub embedding: Option<EmbeddingIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalEvidence {
    pub chunk: KnowledgeChunk,
    pub method: RetrievalMethod,
    pub authority: ContextAuthority,
    /// Normalized relevance in the inclusive range `0..=10_000`.
    pub relevance: u16,
}

impl RetrievalEvidence {
    /// Validates source identity and embedding compatibility metadata.
    ///
    /// # Errors
    ///
    /// Returns [`AiContractError::InvalidRetrievalEvidence`] when the source
    /// cannot be audited or the normalized relevance is outside its contract.
    pub fn validate(&self) -> Result<(), AiContractError> {
        let chunk = &self.chunk;
        let invalid_source = chunk.source_revision.trim().is_empty()
            || chunk.source_hash.trim().is_empty()
            || chunk.chunking_version.trim().is_empty()
            || chunk.content.trim().is_empty();
        let invalid_embedding = chunk.embedding.as_ref().is_some_and(|embedding| {
            embedding.model_id.trim().is_empty() || embedding.dimensions == 0
        });
        if invalid_source || invalid_embedding || self.relevance > 10_000 {
            return Err(AiContractError::InvalidRetrievalEvidence);
        }
        Ok(())
    }
}

impl AiAction {
    #[must_use]
    pub const fn requires_selection(self) -> bool {
        matches!(self, Self::Rewrite | Self::Polish)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiTaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiProposalStatus {
    Pending,
    Accepted,
    PartiallyAccepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposal {
    pub id: Uuid,
    pub task_id: Uuid,
    pub chapter_id: Uuid,
    pub action: AiAction,
    pub target_revision_id: Option<Uuid>,
    pub context_version: String,
    pub prompt_version: String,
    pub output_text: String,
    pub accepted_text: Option<String>,
    pub status: AiProposalStatus,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeLifecycleStatus {
    Active,
    NeedsReview,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CandidateStatus {
    Pending,
    NeedsReview,
    Approved,
    Rejected,
    Finalized,
}

impl CandidateStatus {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Pending,
                Self::NeedsReview | Self::Approved | Self::Rejected
            ) | (Self::NeedsReview, Self::Approved | Self::Rejected)
                | (Self::Approved, Self::Finalized)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewDecision {
    Approve,
    Reject,
    NeedsReview,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChangeSetStatus {
    Draft,
    InReview,
    Blocked,
    Finalized,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceAnchor {
    pub id: Uuid,
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub source_revision_id: Uuid,
    pub block_id: String,
    pub start_offset: u32,
    pub end_offset: u32,
    pub source_version: String,
    pub source_hash: String,
    pub lifecycle_status: KnowledgeLifecycleStatus,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub knowledge_id: Uuid,
    pub project_id: Uuid,
    pub knowledge_version: u32,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source_revision_id: Uuid,
    pub evidence_anchor_ids: Vec<Uuid>,
    pub lifecycle_status: KnowledgeLifecycleStatus,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidate {
    pub id: Uuid,
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub proposal_id: Option<Uuid>,
    pub candidate_status: CandidateStatus,
    pub review_decision: Option<ReviewDecision>,
    pub reviewer: Option<String>,
    pub reviewed_at: Option<String>,
    pub fact: Fact,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub id: Uuid,
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub source_revision_id: Uuid,
    pub status: ChangeSetStatus,
    pub candidate_ids: Vec<Uuid>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeConflictKind {
    DuplicateFact,
    ContradictoryObject,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeConflict {
    pub kind: KnowledgeConflictKind,
    pub candidate_ids: Vec<Uuid>,
    pub subject: String,
    pub predicate: String,
    pub objects: Vec<String>,
    pub high_risk: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AiContractError {
    #[error("profile name cannot be empty")]
    EmptyProfileName,
    #[error("model id cannot be empty")]
    EmptyModelId,
    #[error("base URL must use http or https")]
    InvalidBaseUrl,
    #[error("context window and output token limits must be positive")]
    InvalidTokenLimit,
    #[error("timeout must be between 1 and 600 seconds")]
    InvalidTimeout,
    #[error("retry limit cannot exceed 3")]
    InvalidRetryLimit,
    #[error("the selected provider does not support this model capability")]
    InvalidProviderCapability,
    #[error("this action requires a non-empty selection")]
    SelectionRequired,
    #[error("accepted proposal text cannot be empty")]
    EmptyAcceptedText,
    #[error("proposal status transition is invalid")]
    InvalidProposalTransition,
    #[error("retrieval evidence metadata is invalid")]
    InvalidRetrievalEvidence,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum KnowledgeContractError {
    #[error("knowledge text fields cannot be empty")]
    EmptyText,
    #[error("a fact must reference at least one evidence anchor")]
    MissingEvidence,
    #[error("evidence anchor offsets are invalid")]
    InvalidEvidenceRange,
    #[error("evidence anchor block id cannot be empty")]
    EmptyBlockId,
    #[error("knowledge source version and hash cannot be empty")]
    EmptySourceIdentity,
    #[error("knowledge actor cannot be empty")]
    EmptyActor,
    #[error("knowledge version must be positive")]
    InvalidKnowledgeVersion,
    #[error("candidate review decision does not match candidate status")]
    InvalidCandidateReview,
    #[error("change set must contain at least one candidate")]
    EmptyChangeSet,
    #[error("change set status transition is invalid")]
    InvalidChangeSetTransition,
}

impl EvidenceAnchor {
    /// Validates source identity and character range.
    ///
    /// # Errors
    ///
    /// Returns [`KnowledgeContractError`] when source metadata or the range
    /// is invalid.
    pub fn validate(&self) -> Result<(), KnowledgeContractError> {
        if self.block_id.trim().is_empty() {
            return Err(KnowledgeContractError::EmptyBlockId);
        }
        if self.start_offset >= self.end_offset {
            return Err(KnowledgeContractError::InvalidEvidenceRange);
        }
        if self.source_version.trim().is_empty() || self.source_hash.trim().is_empty() {
            return Err(KnowledgeContractError::EmptySourceIdentity);
        }
        if self.created_by.trim().is_empty() {
            return Err(KnowledgeContractError::EmptyActor);
        }
        Ok(())
    }
}

impl Fact {
    /// Validates the immutable fact version contract.
    ///
    /// # Errors
    ///
    /// Returns [`KnowledgeContractError`] when text, version, evidence, or
    /// actor fields are invalid.
    pub fn validate(&self) -> Result<(), KnowledgeContractError> {
        if self.knowledge_version == 0 {
            return Err(KnowledgeContractError::InvalidKnowledgeVersion);
        }
        if self.subject.trim().is_empty()
            || self.predicate.trim().is_empty()
            || self.object.trim().is_empty()
        {
            return Err(KnowledgeContractError::EmptyText);
        }
        if self.evidence_anchor_ids.is_empty() {
            return Err(KnowledgeContractError::MissingEvidence);
        }
        if self.created_by.trim().is_empty() {
            return Err(KnowledgeContractError::EmptyActor);
        }
        Ok(())
    }
}

impl KnowledgeCandidate {
    /// Validates the candidate and review metadata.
    ///
    /// # Errors
    ///
    /// Returns [`KnowledgeContractError`] when the embedded fact or review
    /// state is inconsistent.
    pub fn validate(&self) -> Result<(), KnowledgeContractError> {
        self.fact.validate()?;
        if self.fact.project_id != self.project_id {
            return Err(KnowledgeContractError::InvalidCandidateReview);
        }
        let review_consistent = match self.candidate_status {
            CandidateStatus::Pending | CandidateStatus::NeedsReview => {
                self.review_decision.is_none()
            }
            CandidateStatus::Approved | CandidateStatus::Finalized => {
                self.review_decision == Some(ReviewDecision::Approve)
            }
            CandidateStatus::Rejected => self.review_decision == Some(ReviewDecision::Reject),
        };
        if !review_consistent {
            return Err(KnowledgeContractError::InvalidCandidateReview);
        }
        Ok(())
    }
}

impl ChangeSet {
    /// Validates the minimum `ChangeSet` metadata.
    ///
    /// # Errors
    ///
    /// Returns [`KnowledgeContractError`] when no candidates or actor is
    /// provided.
    pub fn validate(&self) -> Result<(), KnowledgeContractError> {
        if self.candidate_ids.is_empty() {
            return Err(KnowledgeContractError::EmptyChangeSet);
        }
        if self.created_by.trim().is_empty() {
            return Err(KnowledgeContractError::EmptyActor);
        }
        Ok(())
    }
}

impl ChangeSetStatus {
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft | Self::Blocked, Self::InReview | Self::Rejected)
                | (
                    Self::InReview,
                    Self::Blocked | Self::Finalized | Self::Rejected
                )
        )
    }
}

impl ModelProfileInput {
    /// Validates model limits and the cloud API endpoint contract.
    ///
    /// # Errors
    ///
    /// Returns [`AiContractError`] when a required field is empty, the URL is
    /// not HTTP(S), or token, timeout, and retry limits are outside R3 bounds.
    pub fn validate(&self) -> Result<(), AiContractError> {
        if self.name.trim().is_empty() {
            return Err(AiContractError::EmptyProfileName);
        }
        if self.model_id.trim().is_empty() {
            return Err(AiContractError::EmptyModelId);
        }
        if !(self.base_url.starts_with("http://") || self.base_url.starts_with("https://")) {
            return Err(AiContractError::InvalidBaseUrl);
        }
        if self.context_window == 0 || self.max_output_tokens == 0 {
            return Err(AiContractError::InvalidTokenLimit);
        }
        if !(1..=600).contains(&self.timeout_seconds) {
            return Err(AiContractError::InvalidTimeout);
        }
        if self.retry_limit > 3 {
            return Err(AiContractError::InvalidRetryLimit);
        }
        let valid_capability = matches!(
            (self.provider, self.capability),
            (ModelProvider::SiliconFlow, ModelCapability::Embedding)
                | (
                    ModelProvider::DeepSeek
                        | ModelProvider::OpenAi
                        | ModelProvider::OpenAiCompatible,
                    ModelCapability::Chat
                )
        );
        if !valid_capability {
            return Err(AiContractError::InvalidProviderCapability);
        }
        Ok(())
    }
}

/// Returns the stable name used in architecture diagnostics.
#[must_use]
pub const fn layer_name() -> &'static str {
    "domain"
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_domain_layer_name() {
        assert_eq!(super::layer_name(), "domain");
    }

    #[test]
    fn validates_model_profiles_and_selection_actions() {
        let input = super::ModelProfileInput {
            id: None,
            name: "Local".into(),
            provider: super::ModelProvider::OpenAiCompatible,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.example.com/v1".into(),
            model_id: "writer-model".into(),
            context_window: 32_768,
            max_output_tokens: 4_096,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 120,
            retry_limit: 1,
        };
        assert_eq!(input.validate(), Ok(()));
        let mut invalid = input.clone();
        invalid.provider = super::ModelProvider::SiliconFlow;
        assert_eq!(
            invalid.validate(),
            Err(super::AiContractError::InvalidProviderCapability)
        );
        assert!(super::AiAction::Rewrite.requires_selection());
        assert!(!super::AiAction::Continue.requires_selection());
    }

    #[test]
    fn retrieval_evidence_round_trips_with_source_identity() {
        let evidence = super::RetrievalEvidence {
            chunk: super::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::new_v4(),
                source_revision: "entity-revision-3".into(),
                source_hash: "sha256:abc".into(),
                chunk_index: 2,
                chunking_version: "knowledge-chunk-v1".into(),
                content: "林澈不饮酒。".into(),
                embedding: Some(super::EmbeddingIdentity {
                    profile_id: uuid::Uuid::new_v4(),
                    model_id: "BAAI/bge-m3".into(),
                    dimensions: 1024,
                }),
            },
            method: super::RetrievalMethod::Semantic,
            authority: super::ContextAuthority::AuthoritativeFact,
            relevance: 8_700,
        };
        let encoded = serde_json::to_string(&evidence).expect("serialize evidence");
        let decoded = serde_json::from_str(&encoded).expect("deserialize evidence");
        assert_eq!(evidence, decoded);
        assert_eq!(evidence.validate(), Ok(()));

        let mut invalid = evidence;
        invalid.relevance = 10_001;
        assert_eq!(
            invalid.validate(),
            Err(super::AiContractError::InvalidRetrievalEvidence)
        );
    }

    #[test]
    fn validates_fact_and_evidence_contracts() {
        let project_id = uuid::Uuid::new_v4();
        let chapter_id = uuid::Uuid::new_v4();
        let revision_id = uuid::Uuid::new_v4();
        let anchor_id = uuid::Uuid::new_v4();
        let anchor = super::EvidenceAnchor {
            id: anchor_id,
            project_id,
            chapter_id,
            source_revision_id: revision_id,
            block_id: "paragraph-1".into(),
            start_offset: 0,
            end_offset: 5,
            source_version: "revision-1".into(),
            source_hash: "sha256:test".into(),
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "author".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            updated_at: "2026-09-02T00:00:00Z".into(),
        };
        assert_eq!(anchor.validate(), Ok(()));

        let fact = super::Fact {
            knowledge_id: uuid::Uuid::new_v4(),
            project_id,
            knowledge_version: 1,
            subject: "林澈".into(),
            predicate: "喜欢".into(),
            object: "雨天".into(),
            source_revision_id: revision_id,
            evidence_anchor_ids: vec![anchor_id],
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "author".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            updated_at: "2026-09-02T00:00:00Z".into(),
        };
        assert_eq!(fact.validate(), Ok(()));

        let mut invalid = fact;
        invalid.evidence_anchor_ids.clear();
        assert_eq!(
            invalid.validate(),
            Err(super::KnowledgeContractError::MissingEvidence)
        );
    }

    #[test]
    fn validates_candidate_review_and_change_set_transitions() {
        let project_id = uuid::Uuid::new_v4();
        let fact = super::Fact {
            knowledge_id: uuid::Uuid::new_v4(),
            project_id,
            knowledge_version: 1,
            subject: "甲".into(),
            predicate: "认识".into(),
            object: "乙".into(),
            source_revision_id: uuid::Uuid::new_v4(),
            evidence_anchor_ids: vec![uuid::Uuid::new_v4()],
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "author".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            updated_at: "2026-09-02T00:00:00Z".into(),
        };
        let candidate = super::KnowledgeCandidate {
            id: uuid::Uuid::new_v4(),
            project_id,
            chapter_id: uuid::Uuid::new_v4(),
            proposal_id: None,
            candidate_status: super::CandidateStatus::Approved,
            review_decision: Some(super::ReviewDecision::Approve),
            reviewer: Some("reviewer".into()),
            reviewed_at: Some("2026-09-02T00:00:00Z".into()),
            fact,
            created_at: "2026-09-02T00:00:00Z".into(),
            updated_at: "2026-09-02T00:00:00Z".into(),
        };
        assert_eq!(candidate.validate(), Ok(()));
        assert!(super::ChangeSetStatus::Draft.can_transition_to(super::ChangeSetStatus::InReview));
        assert!(
            !super::ChangeSetStatus::Finalized.can_transition_to(super::ChangeSetStatus::Draft)
        );
    }
}
