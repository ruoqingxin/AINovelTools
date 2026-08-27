//! Core business rules for novel projects.
//!
//! This crate must remain independent from desktop, persistence, and network
//! frameworks.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

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
}
