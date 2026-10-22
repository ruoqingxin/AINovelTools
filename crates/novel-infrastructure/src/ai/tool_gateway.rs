use super::*;
use eventsource_stream::Eventsource;
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ModelToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct ModelToolTurn {
    pub content: String,
    pub calls: Vec<ModelToolCall>,
    pub usage: Option<GenerationUsage>,
    pub finish_reason: String,
}

impl ModelToolTurn {
    #[must_use]
    pub fn message(&self) -> Value {
        let mut message = json!({"role":"assistant","content":self.content});
        if !self.calls.is_empty() {
            message["tool_calls"] = json!(self.calls);
        }
        message
    }
}

impl ModelGateway {
    #[must_use]
    pub fn tool_request_preview(
        &self,
        profile: &ModelProfile,
        messages: &[Value],
        tools: &[Value],
        options: GenerationOptions,
    ) -> (String, Value) {
        let mut body = json!({"model":profile.model_id,"messages":messages,
            "tools":tools,"tool_choice":"auto","stream":true,
            "stream_options":{"include_usage":true}});
        body[if profile.provider == ModelProvider::OpenAi {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }] = json!(
            options
                .max_output_tokens
                .unwrap_or(profile.max_output_tokens)
                .clamp(1, profile.max_output_tokens.max(1))
        );
        if let Some(temperature) = options.temperature {
            body["temperature"] = json!(temperature.clamp(0.0, 2.0));
        }
        if profile.provider == ModelProvider::DeepSeek {
            body["thinking"] = json!({"type":"disabled"});
        }
        (
            format!(
                "{}/chat/completions",
                profile.base_url.trim_end_matches('/')
            ),
            body,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn generate_tool_turn<F>(
        &self,
        profile: &ModelProfile,
        secret: &str,
        messages: &[Value],
        tools: &[Value],
        options: GenerationOptions,
        cancelled: Arc<AtomicBool>,
        mut on_text: F,
    ) -> Result<ModelToolTurn, AiError>
    where
        F: FnMut(&str) + Send,
    {
        if profile.capability != ModelCapability::Chat {
            return Err(AiError::InvalidResponse);
        }
        if profile.privacy_level == PrivacyLevel::LocalOnly {
            return Err(AiError::PrivacyPolicy);
        }
        let (url, body) = self.tool_request_preview(profile, messages, tools, options);
        let request = async {
            let response = self
                .client
                .post(url)
                .bearer_auth(secret)
                .timeout(Duration::from_secs(u64::from(profile.timeout_seconds)))
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        AiError::Timeout
                    } else {
                        AiError::Network
                    }
                })?;
            match response.status() {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    return Err(AiError::Authentication);
                }
                StatusCode::TOO_MANY_REQUESTS => return Err(AiError::RateLimited),
                code if code.is_server_error() => return Err(AiError::ProviderUnavailable),
                code if !code.is_success() => return Err(AiError::InvalidResponse),
                _ => {}
            }
            read_turn(response, &mut on_text).await
        };
        tokio::select! {
            biased;
            ()=async { while !cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }}=>Err(AiError::Cancelled),
            result=request=>if cancelled.load(Ordering::Relaxed){Err(AiError::Cancelled)}else{result}
        }
    }
}

#[derive(Default)]
struct TurnAccumulator {
    content: String,
    calls: std::collections::BTreeMap<u64, ModelToolCall>,
    usage: Option<GenerationUsage>,
    finish: Option<String>,
}

impl TurnAccumulator {
    fn push(&mut self, value: &Value) -> Result<String, AiError> {
        if let Some(reason) = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
        {
            self.finish = Some(reason.into());
        }
        if let (Some(input), Some(output)) = (
            value
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64),
            value
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64),
        ) {
            self.usage = Some(GenerationUsage {
                input_tokens: input.min(u64::from(u32::MAX)) as u32,
                output_tokens: output.min(u64::from(u32::MAX)) as u32,
                input_cache_hit_tokens: None,
                input_cache_miss_tokens: None,
            });
        }
        let delta = value
            .pointer("/choices/0/delta")
            .or_else(|| value.pointer("/choices/0/message"));
        let text = delta
            .and_then(|d| d.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.content.push_str(text);
        if let Some(calls) = delta
            .and_then(|d| d.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for (position, call) in calls.iter().enumerate() {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(position as u64);
                if index > 31 {
                    return Err(AiError::InvalidResponse);
                }
                let accumulated = self.calls.entry(index).or_insert_with(|| ModelToolCall {
                    id: String::new(),
                    call_type: "function".into(),
                    function: ModelToolFunction {
                        name: String::new(),
                        arguments: String::new(),
                    },
                });
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    accumulated.id.push_str(id);
                }
                if call
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s != "function")
                {
                    return Err(AiError::InvalidResponse);
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    accumulated.function.name.push_str(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
                    accumulated.function.arguments.push_str(arguments);
                }
                if accumulated.function.arguments.len() > 2_000_000 {
                    return Err(AiError::InvalidResponse);
                }
            }
        }
        if self.content.len() > 2_000_000 {
            return Err(AiError::InvalidResponse);
        }
        Ok(text.into())
    }

    fn finish(self) -> Result<ModelToolTurn, AiError> {
        let finish = self.finish.ok_or(AiError::StreamInterrupted)?;
        if finish == "length" {
            return Err(AiError::OutputLengthLimit);
        }
        if finish == "content_filter" {
            return Err(AiError::ContentFiltered);
        }
        if !["stop", "tool_calls"].contains(&finish.as_str()) {
            return Err(AiError::StreamInterrupted);
        }
        let calls = self.calls.into_values().collect::<Vec<_>>();
        let ids = calls
            .iter()
            .map(|c| &c.id)
            .collect::<std::collections::HashSet<_>>();
        if ids.len() != calls.len()
            || calls.iter().any(|c| {
                c.id.is_empty()
                    || c.function.name.is_empty()
                    || serde_json::from_str::<Value>(&c.function.arguments).is_err()
            })
            || (calls.is_empty() && self.content.trim().is_empty())
        {
            return Err(AiError::InvalidResponse);
        }
        Ok(ModelToolTurn {
            content: self.content,
            calls,
            usage: self.usage,
            finish_reason: finish,
        })
    }
}

async fn read_turn<F: FnMut(&str)>(
    mut response: reqwest::Response,
    on_text: &mut F,
) -> Result<ModelToolTurn, AiError> {
    let mut prefix = Vec::new();
    let json_body = loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| AiError::Network)?
            .ok_or(AiError::StreamInterrupted)?;
        let first = chunk.iter().copied().find(|b| !b.is_ascii_whitespace());
        prefix.push(chunk);
        if let Some(first) = first {
            break first == b'{';
        }
    };
    let mut accumulated = TurnAccumulator::default();
    if json_body {
        let mut bytes = prefix.into_iter().flatten().collect::<Vec<_>>();
        bytes.extend_from_slice(&response.bytes().await.map_err(|_| AiError::Network)?);
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| AiError::InvalidResponse)?;
        on_text(&accumulated.push(&value)?);
    } else {
        let bytes =
            futures_util::stream::iter(prefix.into_iter().map(Ok)).chain(response.bytes_stream());
        let mut events = bytes.eventsource();
        while let Some(event) = events.next().await {
            let event = event.map_err(|_| AiError::StreamInterrupted)?;
            if event.data.trim() == "[DONE]" {
                break;
            }
            if event.data.trim().is_empty() {
                continue;
            }
            let value: Value =
                serde_json::from_str(&event.data).map_err(|_| AiError::InvalidResponse)?;
            on_text(&accumulated.push(&value)?);
        }
    }
    accumulated.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_stream_tool_arguments_are_reassembled_without_exposing_them_as_text() {
        let mut turn = TurnAccumulator::default();
        assert_eq!(turn.push(&json!({"choices":[{"delta":{"tool_calls":[{
            "index":0,"id":"call_1","type":"function","function":{"name":"search_sources","arguments":"{\"query\":\"境"}
        }]}}]})).unwrap(),"");
        turn.push(&json!({"choices":[{"delta":{"tool_calls":[{
            "index":0,"function":{"arguments":"界\"}"}
        }]},"finish_reason":"tool_calls"}]}))
            .unwrap();
        let turn = turn.finish().unwrap();
        assert_eq!(turn.calls[0].function.arguments, "{\"query\":\"境界\"}");
        assert_eq!(turn.message()["tool_calls"][0]["id"], "call_1");
    }
    #[test]
    fn truncation_and_duplicate_call_ids_are_not_executable() {
        let mut turn = TurnAccumulator::default();
        turn.push(&json!({"choices":[{"message":{"content":"不完整"},"finish_reason":"length"}]}))
            .unwrap();
        assert!(matches!(turn.finish(), Err(AiError::OutputLengthLimit)));
        let mut turn = TurnAccumulator::default();
        turn.push(&json!({"choices":[{"message":{"tool_calls":[
            {"id":"same","function":{"name":"x","arguments":"{}"}},
            {"id":"same","function":{"name":"x","arguments":"{}"}}
        ]},"finish_reason":"tool_calls"}]}))
            .unwrap();
        assert!(matches!(turn.finish(), Err(AiError::InvalidResponse)));
    }
}
