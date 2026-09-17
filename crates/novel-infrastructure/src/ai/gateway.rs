use super::*;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationCompletion {
    Complete,
    LengthLimit,
    ContentFiltered,
    Interrupted,
    LikelyTruncated,
}

impl GenerationCompletion {
    #[must_use]
    pub const fn is_complete(self) -> bool {
        matches!(self, Self::Complete)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub input_cache_hit_tokens: Option<u32>,
    pub input_cache_miss_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationOutput {
    pub output: String,
    pub completion: GenerationCompletion,
    pub finish_reason: Option<String>,
    pub usage: Option<GenerationUsage>,
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
            if stream {
                body["stream_options"] = serde_json::json!({ "include_usage": true });
            }
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
    pub async fn generate_detailed<F>(
        &self,
        profile: &ModelProfile,
        secret: Option<&str>,
        context: &ContextPackage,
        stream: bool,
        disable_thinking: bool,
        cancelled: Arc<AtomicBool>,
        on_chunk: F,
    ) -> Result<GenerationOutput, AiError>
    where
        F: FnMut(&str) + Send,
    {
        self.generate_with_options_detailed(
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
        on_chunk: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
    {
        self.generate_with_options_detailed(
            profile,
            secret,
            context,
            options,
            stream,
            disable_thinking,
            cancelled,
            on_chunk,
        )
        .await
        .map(|generation| generation.output)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate_with_options_detailed<F>(
        &self,
        profile: &ModelProfile,
        secret: Option<&str>,
        context: &ContextPackage,
        options: GenerationOptions,
        stream: bool,
        disable_thinking: bool,
        cancelled: Arc<AtomicBool>,
        mut on_chunk: F,
    ) -> Result<GenerationOutput, AiError>
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
                        read_non_streaming(response, &mut on_chunk).await
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

fn response_finish_reason(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/choices/0/finish_reason")
        .and_then(serde_json::Value::as_str)
        .filter(|reason| !reason.trim().is_empty())
}

fn classify_finish_reason(finish_reason: Option<&str>) -> Option<GenerationCompletion> {
    match finish_reason {
        Some("stop") => Some(GenerationCompletion::Complete),
        Some("length" | "max_tokens") => Some(GenerationCompletion::LengthLimit),
        Some("content_filter" | "content_filtered") => Some(GenerationCompletion::ContentFiltered),
        Some(_) => Some(GenerationCompletion::Interrupted),
        None => None,
    }
}

fn stream_delta_content(value: &serde_json::Value) -> Option<String> {
    content_text(value.pointer("/choices/0/delta/content")?)
}

fn response_usage(value: &serde_json::Value) -> Option<GenerationUsage> {
    let input_tokens = u32::try_from(value.pointer("/usage/prompt_tokens")?.as_u64()?).ok()?;
    let output_tokens = u32::try_from(value.pointer("/usage/completion_tokens")?.as_u64()?).ok()?;
    let token = |name: &str| {
        value
            .pointer(&format!("/usage/{name}"))
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
    };
    Some(GenerationUsage {
        input_tokens,
        output_tokens,
        input_cache_hit_tokens: token("prompt_cache_hit_tokens"),
        input_cache_miss_tokens: token("prompt_cache_miss_tokens"),
    })
}

async fn read_non_streaming<F>(
    response: reqwest::Response,
    on_chunk: &mut F,
) -> Result<GenerationOutput, AiError>
where
    F: FnMut(&str),
{
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| AiError::InvalidResponse)?;
    let output = message_content(&value).ok_or(AiError::InvalidResponse)?;
    let finish_reason = response_finish_reason(&value).map(ToOwned::to_owned);
    let completion =
        classify_finish_reason(finish_reason.as_deref()).unwrap_or(GenerationCompletion::Complete);
    on_chunk(&output);
    Ok(GenerationOutput {
        output,
        completion,
        finish_reason,
        usage: response_usage(&value),
    })
}

async fn read_stream<F>(
    response: reqwest::Response,
    cancelled: Arc<AtomicBool>,
    on_chunk: &mut F,
) -> Result<GenerationOutput, AiError>
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
        let finish_reason = response_finish_reason(&value).map(ToOwned::to_owned);
        let completion = classify_finish_reason(finish_reason.as_deref())
            .unwrap_or(GenerationCompletion::Complete);
        on_chunk(&output);
        return Ok(GenerationOutput {
            output,
            completion,
            finish_reason,
            usage: response_usage(&value),
        });
    }

    let mut output = String::new();
    let mut finish_reason = None;
    let mut usage = None;
    let mut saw_done = false;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            saw_done = true;
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(data).map_err(|_| AiError::InvalidResponse)?;
        if finish_reason.is_none() {
            finish_reason = response_finish_reason(&value).map(ToOwned::to_owned);
        }
        if usage.is_none() {
            usage = response_usage(&value);
        }
        if let Some(text) = stream_delta_content(&value) {
            output.push_str(&text);
            on_chunk(&text);
        }
    }
    let completion = classify_finish_reason(finish_reason.as_deref()).unwrap_or({
        if saw_done {
            GenerationCompletion::Complete
        } else {
            GenerationCompletion::Interrupted
        }
    });
    if output.trim().is_empty() && completion.is_complete() {
        return Err(AiError::InvalidResponse);
    }
    Ok(GenerationOutput {
        output,
        completion,
        finish_reason,
        usage,
    })
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
