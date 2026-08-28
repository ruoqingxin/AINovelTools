//! Core business rules for novel projects.
//!
//! This crate must remain independent from desktop, persistence, and network
//! frameworks.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
mod entity;
pub use entity::{
    Entity, EntityError, EntityInput, EntityLifecycleStatus, EntityRevision, EntityType,
};

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
}
