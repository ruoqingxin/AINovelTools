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
use thiserror::Error;
use uuid::Uuid;

use crate::{DatabaseError, ProjectManager};

const SECRET_SERVICE: &str = "AINovelTools";

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

impl SecretStore {
    #[must_use]
    pub fn secret_ref(profile_id: Uuid) -> String {
        format!("model-profile:{profile_id}")
    }

    pub fn set(secret_ref: &str, secret: &str) -> Result<(), AiError> {
        if secret.trim().is_empty() {
            return Err(AiError::MissingSecret);
        }
        Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)?
            .set_password(secret)
            .map_err(|_| AiError::SecretStore)
    }

    pub fn get(secret_ref: &str) -> Result<String, AiError> {
        Entry::new(SECRET_SERVICE, secret_ref)
            .map_err(|_| AiError::SecretStore)?
            .get_password()
            .map_err(|_| AiError::SecretStore)
    }

    pub fn delete(secret_ref: &str) -> Result<(), AiError> {
        let entry = Entry::new(SECRET_SERVICE, secret_ref).map_err(|_| AiError::SecretStore)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AiError::SecretStore),
        }
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

impl ModelGateway {
    pub async fn generate<F>(
        &self,
        profile: &ModelProfile,
        secret: Option<&str>,
        context: &ContextPackage,
        stream: bool,
        cancelled: Arc<AtomicBool>,
        mut on_chunk: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
    {
        if profile.capability != ModelCapability::Chat {
            return Err(AiContractError::InvalidProviderCapability.into());
        }
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
        body[token_field] = serde_json::json!(profile.max_output_tokens);
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
                        value
                            .pointer("/choices/0/message/content")
                            .and_then(serde_json::Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .map(ToOwned::to_owned)
                            .ok_or(AiError::InvalidResponse)
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
                    let vector = value
                        .pointer("/data/0/embedding")
                        .and_then(serde_json::Value::as_array)
                        .ok_or(AiError::InvalidResponse)?
                        .iter()
                        .map(|item| {
                            item.as_f64()
                                .map(embedding_component)
                                .ok_or(AiError::InvalidResponse)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if vector.is_empty() {
                        return Err(AiError::InvalidResponse);
                    }
                    return Ok(vector);
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

async fn read_stream<F>(
    response: reqwest::Response,
    cancelled: Arc<AtomicBool>,
    on_chunk: &mut F,
) -> Result<String, AiError>
where
    F: FnMut(&str),
{
    let mut bytes = response.bytes_stream();
    let mut buffer = String::new();
    let mut output = String::new();
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
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            for line in event.lines().filter_map(|line| line.strip_prefix("data:")) {
                let data = line.trim();
                if data == "[DONE]" {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_str(data).map_err(|_| AiError::InvalidResponse)?;
                if let Some(text) = value
                    .pointer("/choices/0/delta/content")
                    .and_then(serde_json::Value::as_str)
                {
                    output.push_str(text);
                    on_chunk(text);
                }
            }
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

impl ProjectManager {
    pub fn list_model_profiles(&self) -> Result<Vec<ModelProfile>, AiError> {
        let session = self.current.as_ref().ok_or(AiError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, secret_ref, created_at, updated_at FROM model_profiles ORDER BY updated_at DESC"
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
            "SELECT id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit, secret_ref, created_at, updated_at FROM model_profiles WHERE id = ?1",
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
            "INSERT INTO model_profiles (id, name, provider, capability, base_url, model_id, context_window, max_output_tokens, privacy_level, timeout_seconds, retry_limit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, capability=excluded.capability, base_url=excluded.base_url, model_id=excluded.model_id, context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens, privacy_level=excluded.privacy_level, timeout_seconds=excluded.timeout_seconds, retry_limit=excluded.retry_limit, updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![id.to_string(), input.name.trim(), provider_str(input.provider), capability_str(input.capability), input.base_url.trim_end_matches('/'), input.model_id.trim(), input.context_window, input.max_output_tokens, privacy_str(input.privacy_level), input.timeout_seconds, input.retry_limit],
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
        let capability: Option<String> = session
            .database
            .connection
            .query_row(
                "SELECT capability FROM model_profiles WHERE id = ?1",
                [profile_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(DatabaseError::from)?;
        match capability.as_deref() {
            None => return Err(AiError::MissingProfile(profile_id)),
            Some("CHAT") => {}
            Some(_) => return Err(AiContractError::InvalidProviderCapability.into()),
        }
        let task_id = Uuid::new_v4();
        let task_contract_json = serde_json::to_string(&context.task_contract)
            .map_err(|_| AiError::ContextSerialization)?;
        let context_section_audit_json = serde_json::to_string(&context.section_audit)
            .map_err(|_| AiError::ContextSerialization)?;
        session.database.connection.execute(
            "INSERT INTO ai_tasks (id, profile_id, chapter_id, action, target_revision_id, context_version, prompt_version, task_contract_json, context_section_audit_json, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![task_id.to_string(), profile_id.to_string(), context.chapter_id.to_string(), action_str(context.action), context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, task_contract_json, context_section_audit_json, task_status_str(AiTaskStatus::Running)],
        ).map_err(DatabaseError::from)?;
        Ok(task_id)
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
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let transaction = session
            .database
            .connection
            .transaction()
            .map_err(DatabaseError::from)?;
        transaction.execute("UPDATE ai_tasks SET status='COMPLETED', finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1 AND status='RUNNING'", [task_id.to_string()]).map_err(DatabaseError::from)?;
        let proposal_id = Uuid::new_v4();
        transaction.execute(
            "INSERT INTO ai_proposals (id, task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING')",
            rusqlite::params![proposal_id.to_string(), task_id.to_string(), context.chapter_id.to_string(), action_str(context.action), context.target_revision_id.map(|id| id.to_string()), context.context_version, context.prompt_version, output_text],
        ).map_err(DatabaseError::from)?;
        transaction.commit().map_err(DatabaseError::from)?;
        self.get_ai_proposal(proposal_id)
    }

    pub fn fail_ai_task(&mut self, task_id: Uuid, error: &AiError) -> Result<(), AiError> {
        let session = self.current.as_mut().ok_or(AiError::NoProject)?;
        let status = if matches!(error, AiError::Cancelled) {
            "CANCELLED"
        } else {
            "FAILED"
        };
        session.database.connection.execute(
            "UPDATE ai_tasks SET status=?2, error_code=?3, finished_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?1",
            rusqlite::params![task_id.to_string(), status, error.code()],
        ).map_err(DatabaseError::from)?;
        Ok(())
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
    let secret_ref: Option<String> = row.get(11)?;
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
        has_secret: secret_ref.is_some(),
        secret_ref,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
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
fn action_str(value: AiAction) -> &'static str {
    match value {
        AiAction::Continue => "CONTINUE",
        AiAction::Rewrite => "REWRITE",
        AiAction::Polish => "POLISH",
        AiAction::Summarize => "SUMMARIZE",
    }
}
fn parse_action(value: &str) -> AiAction {
    match value {
        "REWRITE" => AiAction::Rewrite,
        "POLISH" => AiAction::Polish,
        "SUMMARIZE" => AiAction::Summarize,
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
    use std::sync::{Arc, atomic::AtomicBool};
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
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .await
            .expect("stream response");
        assert_eq!(output, "候选正文");
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
