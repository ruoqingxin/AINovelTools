use crate::state::{AiStreamChunk, AiTaskAttempt, AiTaskStarted, ModelConnectionResponse};
use crate::{ApiError, ProjectState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractedEntity {
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAiJobInput {
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) mode: String,
    pub(crate) section_id: String,
    pub(crate) section_title: String,
    pub(crate) section_prompt: String,
    pub(crate) existing_context: String,
    pub(crate) reference_content: String,
    pub(crate) user_guidance: String,
    pub(crate) allow_rewrite: bool,
    #[serde(default)]
    pub(crate) temperature: Option<f64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u32>,
    #[serde(default)]
    pub(crate) task_key: Option<novel_infrastructure::AiTaskKind>,
    pub(crate) source_name: Option<Vec<String>>,
    pub(crate) system_prompt_snapshot: Option<String>,
    pub(crate) user_prompt_snapshot: Option<String>,
    pub(crate) final_request_endpoint: Option<String>,
    pub(crate) final_request_body: Option<String>,
    pub(crate) final_request_estimated_input_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtractEntitiesInput {
    profile_id: uuid::Uuid,
    entity_type: novel_infrastructure::EntityType,
    entity_name: String,
    brief_summary: String,
    applicability_scope: String,
    source_text: String,
    user_guidance: Option<String>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
}

const PLANNING_CONTEXT_RESERVE_TOKENS: u32 = 2_048;

fn task_generation_options(
    task_key: Option<novel_infrastructure::AiTaskKind>,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> Result<novel_infrastructure::GenerationOptions, ApiError> {
    let temperature =
        temperature.or_else(|| task_key.map(novel_infrastructure::AiTaskKind::default_temperature));
    let max_output_tokens = max_output_tokens
        .or_else(|| task_key.map(novel_infrastructure::AiTaskKind::default_max_output_tokens));
    if temperature.is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value)) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "温度必须介于 0 到 2 之间".to_owned(),
        });
    }
    if max_output_tokens == Some(0) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "最大输出 tokens 必须大于 0".to_owned(),
        });
    }
    Ok(novel_infrastructure::GenerationOptions {
        temperature,
        max_output_tokens,
    })
}

fn load_ai_task_preference(
    state: &ProjectState,
    task: novel_infrastructure::AiTaskKind,
) -> Result<novel_infrastructure::AiTaskPreference, ApiError> {
    let mut preference = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        let preferences = store.get_ai_task_preferences().map_err(ApiError::from)?;
        preferences.get(task).clone()
    };
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    if let Some(project_preference) = manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)?
        .get(task)
    {
        preference = project_preference.clone();
    }
    Ok(preference)
}

fn effective_task_input_budget(
    profile: &novel_infrastructure::ModelProfile,
    max_output_tokens: u32,
    preference: &novel_infrastructure::AiTaskPreference,
) -> u32 {
    let model_budget = profile.context_window.saturating_sub(max_output_tokens);
    preference
        .prompt
        .context
        .input_token_budget
        .map_or(model_budget, |budget| model_budget.min(budget))
        .max(256)
}

fn context_option(value: Option<bool>, default: bool) -> bool {
    value.unwrap_or(default)
}

struct AiGenerationOutcome {
    output: String,
    fallback_profile: Option<novel_infrastructure::ModelProfile>,
    fallback_reason: Option<String>,
}

fn should_try_fallback(error: &novel_infrastructure::AiError) -> bool {
    matches!(
        error,
        novel_infrastructure::AiError::RateLimited
            | novel_infrastructure::AiError::Timeout
            | novel_infrastructure::AiError::ProviderUnavailable
            | novel_infrastructure::AiError::Network
            | novel_infrastructure::AiError::InvalidResponse
    )
}

#[allow(clippy::too_many_arguments)]
async fn generate_with_task_fallback<F>(
    state: &ProjectState,
    preference: &novel_infrastructure::AiTaskPreference,
    primary: &novel_infrastructure::ModelProfile,
    primary_secret: Option<&str>,
    context: &novel_application::ContextPackage,
    options: novel_infrastructure::GenerationOptions,
    stream: bool,
    disable_thinking: bool,
    cancelled: Arc<AtomicBool>,
    mut on_chunk: F,
) -> Result<AiGenerationOutcome, novel_infrastructure::AiError>
where
    F: FnMut(&str) + Send,
{
    match state
        .gateway
        .generate_with_options(
            primary,
            primary_secret,
            context,
            options,
            stream,
            disable_thinking,
            Arc::clone(&cancelled),
            &mut on_chunk,
        )
        .await
    {
        Ok(output) => Ok(AiGenerationOutcome {
            output,
            fallback_profile: None,
            fallback_reason: None,
        }),
        Err(error) if !should_try_fallback(&error) => Err(error),
        Err(primary_error) => {
            let Some(fallback_id) = preference
                .fallback_profile_id
                .filter(|profile_id| *profile_id != primary.id)
            else {
                return Err(primary_error);
            };
            let fallback = {
                let store = state
                    .model_profiles
                    .lock()
                    .map_err(|_| novel_infrastructure::AiError::ProviderUnavailable)?;
                let Ok(fallback) = store.get(fallback_id) else {
                    return Err(primary_error);
                };
                fallback
            };
            if fallback.capability != novel_infrastructure::ModelCapability::Chat
                || fallback.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly
            {
                return Err(primary_error);
            }
            let fallback_secret = fallback
                .secret_ref
                .as_deref()
                .ok_or(novel_infrastructure::AiError::MissingSecret)
                .and_then(novel_infrastructure::SecretStore::get)?;
            let fallback_reason = primary_error.code().to_owned();
            let output = state
                .gateway
                .generate_with_options(
                    &fallback,
                    Some(&fallback_secret),
                    context,
                    options,
                    stream,
                    disable_thinking,
                    cancelled,
                    on_chunk,
                )
                .await?;
            Ok(AiGenerationOutcome {
                output,
                fallback_profile: Some(fallback),
                fallback_reason: Some(fallback_reason),
            })
        }
    }
}

fn truncate_text_to_char_budget(value: &str, char_budget: usize, marker: &str) -> String {
    if value.chars().count() <= char_budget {
        return value.to_owned();
    }
    let marker_cost = marker.chars().count();
    let content_budget = char_budget.saturating_sub(marker_cost).max(1);
    let mut truncated = value.chars().take(content_budget).collect::<String>();
    truncated.push_str(marker);
    truncated
}

#[cfg(test)]
mod task_generation_options_tests {
    #[test]
    fn applies_recommended_defaults_without_overriding_explicit_values() {
        let recommended = super::task_generation_options(
            Some(novel_infrastructure::AiTaskKind::Writing),
            None,
            None,
        )
        .expect("recommended options");
        assert_eq!(recommended.temperature, Some(0.9));
        assert_eq!(recommended.max_output_tokens, Some(8_192));

        let explicit = super::task_generation_options(
            Some(novel_infrastructure::AiTaskKind::Writing),
            Some(0.4),
            Some(2_048),
        )
        .expect("explicit options");
        assert_eq!(explicit.temperature, Some(0.4));
        assert_eq!(explicit.max_output_tokens, Some(2_048));
    }

    #[test]
    fn truncates_text_with_a_visible_budget_marker() {
        let truncated = super::truncate_text_to_char_budget("一二三四五六七八九十", 8, "[截断]");
        assert_eq!(truncated, "一二三四[截断]");
    }
}

fn effective_max_output_tokens(
    profile: &novel_domain::ModelProfile,
    options: novel_infrastructure::GenerationOptions,
) -> u32 {
    options
        .max_output_tokens
        .unwrap_or(profile.max_output_tokens)
        .clamp(1, profile.max_output_tokens.max(1))
}

fn is_core_planning_section(section_id: &str) -> bool {
    matches!(
        section_id,
        "seed-premise"
            | "seed-genre-promise"
            | "engine-protagonist"
            | "engine-antagonism"
            | "engine-stakes"
            | "engine-ending"
    )
}

fn planning_context_sections(value: &str) -> Vec<(String, String)> {
    let mut sections = Vec::<(String, String)>::new();
    let mut current_id: Option<String> = None;
    let mut current_content = String::new();
    for line in value.lines() {
        let candidate = line.split_once(':').and_then(|(id, _)| {
            (!id.is_empty()
                && id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                }))
            .then(|| id.to_owned())
        });
        if let Some(id) = candidate {
            if let Some(previous_id) = current_id.replace(id) {
                sections.push((previous_id, std::mem::take(&mut current_content)));
            }
            current_content.push_str(
                line.split_once(':')
                    .map(|(_, text)| text)
                    .unwrap_or_default(),
            );
            current_content.push('\n');
        } else if current_id.is_some() {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }
    if let Some(id) = current_id {
        sections.push((id, current_content));
    }
    sections
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left_value, right_value) in left.iter().zip(right) {
        dot += left_value * right_value;
        left_norm += left_value * left_value;
        right_norm += right_value * right_value;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

fn planning_content_hash(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

struct PlanningEmbeddingQuery {
    profile: novel_domain::ModelProfile,
    secret: String,
    vector: Vec<f32>,
}

struct PlanningEmbeddingQueryResult {
    query: PlanningEmbeddingQuery,
    elapsed_ms: u128,
}

struct SemanticProjectRetrieval {
    section_similarities: HashMap<String, f32>,
    chunk_similarities: HashMap<String, f32>,
    persisted_vectors: usize,
    embedded_vectors: usize,
    embedded_chars: usize,
    candidate_sections: usize,
    candidate_chunks: usize,
    persisted_chunks: usize,
    embedded_chunks: usize,
    embedded_chunk_chars: usize,
    elapsed_ms: u128,
}

struct SemanticReferenceRetrieval {
    similarities: HashMap<String, f32>,
    candidate_blocks: usize,
    embedded_blocks: usize,
    embedded_chars: usize,
    elapsed_ms: u128,
}

struct PlanningRetrievalSimilarities<'a> {
    project_sections: &'a HashMap<String, f32>,
    project_chunks: &'a HashMap<String, f32>,
    references: &'a HashMap<String, f32>,
}

async fn planning_embedding_query(
    state: &ProjectState,
    query: &str,
) -> Result<PlanningEmbeddingQueryResult, String> {
    let started = Instant::now();
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| "模型配置不可用".to_owned())?;
        let profiles = store
            .list()
            .map_err(|error| format!("读取模型配置失败（{}）", error.code()))?;
        profiles
            .into_iter()
            .find(|item| {
                item.capability == novel_infrastructure::ModelCapability::Embedding
                    && item.has_secret
            })
            .ok_or_else(|| "未配置带密钥的 Embedding 模型".to_owned())?
    };
    let secret_ref = profile
        .secret_ref
        .as_deref()
        .ok_or_else(|| "Embedding 模型缺少密钥".to_owned())?;
    let secret = novel_infrastructure::SecretStore::get(secret_ref)
        .map_err(|_| "读取 Embedding 模型密钥失败".to_owned())?;
    let query_vector = state
        .embedding_gateway
        .embed(&profile, &secret, query)
        .await
        .map_err(|error| format!("查询向量生成失败（{}）", error.code()))?;
    Ok(PlanningEmbeddingQueryResult {
        query: PlanningEmbeddingQuery {
            profile,
            secret,
            vector: query_vector,
        },
        elapsed_ms: started.elapsed().as_millis(),
    })
}

async fn semantic_planning_context(
    state: &ProjectState,
    existing_context: &str,
    query: &str,
    embedding: &PlanningEmbeddingQuery,
) -> Result<SemanticProjectRetrieval, String> {
    const MAX_PROJECT_SEMANTIC_SECTIONS: usize = 8;
    const MAX_PROJECT_CHUNK_CANDIDATES_PER_SECTION: usize = 6;

    let started = Instant::now();
    let sections = planning_context_sections(existing_context);
    if sections.len() < 2 {
        return Ok(SemanticProjectRetrieval {
            section_similarities: HashMap::new(),
            chunk_similarities: HashMap::new(),
            persisted_vectors: 0,
            embedded_vectors: 0,
            embedded_chars: 0,
            candidate_sections: 0,
            candidate_chunks: 0,
            persisted_chunks: 0,
            embedded_chunks: 0,
            embedded_chunk_chars: 0,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    let (persisted, persisted_chunks) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| "读取正式设定向量失败".to_owned())?;
        let dimensions = i64::try_from(embedding.vector.len()).unwrap_or_default();
        let persisted = manager
            .list_planning_embeddings()
            .map_err(|_| "读取正式设定向量失败".to_owned())?
            .into_iter()
            .filter(|item| {
                item.profile_id == embedding.profile.id
                    && item.model_id == embedding.profile.model_id
                    && item.dimensions == dimensions
            })
            .map(|item| (item.section_id, item.vector))
            .collect::<HashMap<_, _>>();
        let persisted_chunks = manager
            .list_planning_chunk_embeddings()
            .map_err(|_| "读取正式设定分块向量失败".to_owned())?
            .into_iter()
            .filter(|item| {
                item.profile_id == embedding.profile.id
                    && item.model_id == embedding.profile.model_id
                    && item.dimensions == dimensions
            })
            .map(|item| (item.chunk_id.clone(), item))
            .collect::<HashMap<_, _>>();
        (persisted, persisted_chunks)
    };
    let persisted_vectors = sections
        .iter()
        .filter(|(id, _)| persisted.contains_key(id))
        .count();
    let mut section_similarities = HashMap::with_capacity(sections.len());
    let mut missing_briefs = Vec::new();
    for (id, content) in &sections {
        let brief = novel_application::PlanningContextPlanner::project_section_brief(content, 240);
        if !brief.is_empty() {
            missing_briefs.push((id.clone(), brief));
        }
    }
    let embedded_vectors = missing_briefs.len();
    let embedded_chars = missing_briefs
        .iter()
        .map(|(_, content)| content.chars().count())
        .sum();
    if !missing_briefs.is_empty() {
        let inputs = missing_briefs
            .iter()
            .map(|(_, content)| content.clone())
            .collect::<Vec<_>>();
        let embedded = state
            .embedding_gateway
            .embed_many(&embedding.profile, &embedding.secret, &inputs)
            .await
            .map_err(|error| format!("正式设定摘要批量向量化失败（{}）", error.code()))?;
        if embedded.len() != missing_briefs.len() {
            return Err("正式设定摘要向量数量不匹配".to_owned());
        }
        for ((id, _), vector) in missing_briefs.into_iter().zip(embedded) {
            let brief_similarity = cosine_similarity(&embedding.vector, &vector);
            let section_similarity = persisted.get(&id).map_or(brief_similarity, |vector| {
                brief_similarity * 0.7 + cosine_similarity(&embedding.vector, vector) * 0.3
            });
            section_similarities.insert(id, section_similarity);
        }
    }
    let mut ranked = sections
        .iter()
        .enumerate()
        .map(|(index, (id, _))| {
            (
                index,
                section_similarities.get(id).copied().unwrap_or_default(),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let section_limit = MAX_PROJECT_SEMANTIC_SECTIONS.min(sections.len());
    let mut selected = sections
        .iter()
        .enumerate()
        .filter(|(_, (id, _))| is_core_planning_section(id))
        .map(|(index, _)| index)
        .take(section_limit)
        .collect::<HashSet<_>>();
    for (index, _) in ranked {
        if selected.len() >= section_limit {
            break;
        }
        selected.insert(index);
    }
    let candidate_sections = selected.len();
    let candidate_blocks = sections
        .iter()
        .enumerate()
        .filter(|(index, _)| selected.contains(index))
        .map(
            |(_, (id, content))| novel_application::PlanningContextBlock {
                id: id.clone(),
                heading: String::new(),
                content: content.clone(),
            },
        )
        .collect::<Vec<_>>();
    let candidates = novel_application::PlanningContextPlanner::project_semantic_candidates(
        &candidate_blocks,
        query,
        MAX_PROJECT_CHUNK_CANDIDATES_PER_SECTION,
    );
    let candidate_chunks = candidates.len();
    let mut chunk_similarities = HashMap::with_capacity(candidate_chunks);
    let mut missing_chunks = Vec::new();
    for candidate in candidates {
        let content_hash = planning_content_hash(&candidate.content);
        if let Some(cached) = persisted_chunks.get(&candidate.id)
            && cached.content_hash == content_hash
        {
            chunk_similarities.insert(
                candidate.id,
                cosine_similarity(&embedding.vector, &cached.vector),
            );
        } else {
            missing_chunks.push((candidate, content_hash));
        }
    }
    let persisted_chunks = candidate_chunks.saturating_sub(missing_chunks.len());
    let embedded_chunks = missing_chunks.len();
    let embedded_chunk_chars = missing_chunks
        .iter()
        .map(|(candidate, _)| candidate.content.chars().count())
        .sum();
    let mut generated_chunks = Vec::with_capacity(missing_chunks.len());
    if !missing_chunks.is_empty() {
        let inputs = missing_chunks
            .iter()
            .map(|(candidate, _)| candidate.content.clone())
            .collect::<Vec<_>>();
        let vectors = state
            .embedding_gateway
            .embed_many(&embedding.profile, &embedding.secret, &inputs)
            .await
            .map_err(|error| format!("正式设定分块批量向量化失败（{}）", error.code()))?;
        if vectors.len() != missing_chunks.len() {
            return Err("正式设定分块向量数量不匹配".to_owned());
        }
        for ((candidate, content_hash), vector) in missing_chunks.into_iter().zip(vectors) {
            chunk_similarities.insert(
                candidate.id.clone(),
                cosine_similarity(&embedding.vector, &vector),
            );
            generated_chunks.push((candidate, content_hash, vector));
        }
    }
    if !generated_chunks.is_empty()
        && let Ok(mut manager) = state.manager.lock()
    {
        for (candidate, content_hash, vector) in generated_chunks {
            let chunk_index = candidate
                .id
                .rsplit_once("#chunk-")
                .and_then(|(_, index)| index.parse::<i64>().ok())
                .unwrap_or_default();
            let _ = manager.generate_planning_chunk_embedding(
                novel_infrastructure::PlanningChunkEmbedding {
                    chunk_id: candidate.id,
                    section_id: candidate.section_id,
                    chunk_index,
                    profile_id: embedding.profile.id,
                    model_id: embedding.profile.model_id.clone(),
                    dimensions: i64::try_from(vector.len()).unwrap_or_default(),
                    content_hash,
                    vector,
                    updated_at: String::new(),
                },
            );
        }
    }
    Ok(SemanticProjectRetrieval {
        section_similarities,
        chunk_similarities,
        persisted_vectors,
        embedded_vectors,
        embedded_chars,
        candidate_sections,
        candidate_chunks,
        persisted_chunks,
        embedded_chunks,
        embedded_chunk_chars,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

async fn semantic_reference_similarities(
    state: &ProjectState,
    reference_content: &str,
    query: &str,
    embedding: &PlanningEmbeddingQuery,
) -> Result<SemanticReferenceRetrieval, String> {
    const MAX_REFERENCE_EMBEDDING_CANDIDATES: usize = 24;
    const MAX_REFERENCE_EMBEDDING_CHARS: usize = 4_000;

    let started = Instant::now();
    let candidates = novel_application::PlanningContextPlanner::reference_semantic_candidates(
        reference_content,
        query,
        MAX_REFERENCE_EMBEDDING_CANDIDATES,
    );
    if candidates.is_empty() {
        return Ok(SemanticReferenceRetrieval {
            similarities: HashMap::new(),
            candidate_blocks: 0,
            embedded_blocks: 0,
            embedded_chars: 0,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    let candidate_blocks = candidates.len();
    let inputs = candidates
        .iter()
        .map(|candidate| {
            candidate
                .content
                .chars()
                .take(MAX_REFERENCE_EMBEDDING_CHARS)
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    let embedded_chars = inputs.iter().map(|input| input.chars().count()).sum();
    let vectors = state
        .embedding_gateway
        .embed_many(&embedding.profile, &embedding.secret, &inputs)
        .await
        .map_err(|error| format!("文件片段批量向量化失败（{}）", error.code()))?;
    if vectors.len() != candidates.len() {
        return Err("文件片段向量数量不匹配".to_owned());
    }
    let embedded_blocks = vectors.len();
    let similarities = candidates
        .into_iter()
        .zip(vectors)
        .map(|(candidate, vector)| (candidate.id, cosine_similarity(&embedding.vector, &vector)))
        .collect();
    Ok(SemanticReferenceRetrieval {
        similarities,
        candidate_blocks,
        embedded_blocks,
        embedded_chars,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn planning_context_mode(
    mode: &str,
    allow_rewrite: bool,
) -> Result<novel_application::PlanningContextMode, ApiError> {
    match (mode, allow_rewrite) {
        ("GENERATE", _) => Ok(novel_application::PlanningContextMode::Generate),
        ("EXTRACT", true) => Ok(novel_application::PlanningContextMode::ExtractRewrite),
        ("EXTRACT", false) => Ok(novel_application::PlanningContextMode::Extract),
        _ => Err(ApiError {
            code: "INVALID_INPUT",
            message: "不支持的规划 AI 模式".to_owned(),
        }),
    }
}

fn build_planning_context_plan(
    existing_context: &str,
    reference_content: &str,
    query: &str,
    mode: novel_application::PlanningContextMode,
    input_token_budget: u32,
    similarities: PlanningRetrievalSimilarities<'_>,
) -> novel_application::PlanningContextPlan {
    let available_chars = usize::try_from(
        input_token_budget
            .saturating_sub(PLANNING_CONTEXT_RESERVE_TOKENS)
            .max(1),
    )
    .unwrap_or(usize::MAX)
    .saturating_mul(4);
    let (project_budget, reference_budget) = match mode {
        novel_application::PlanningContextMode::Generate => (available_chars, available_chars / 4),
        novel_application::PlanningContextMode::Extract => {
            let project_budget = available_chars / 3;
            (
                project_budget,
                available_chars.saturating_sub(project_budget),
            )
        }
        novel_application::PlanningContextMode::ExtractRewrite => {
            let project_budget = available_chars.saturating_mul(2) / 5;
            (
                project_budget,
                available_chars.saturating_sub(project_budget),
            )
        }
    };
    novel_application::PlanningContextPlanner::plan_with_similarities(
        existing_context,
        reference_content,
        query,
        mode,
        project_budget,
        reference_budget,
        similarities.project_sections,
        similarities.project_chunks,
        similarities.references,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanningAiRequestPreview {
    pub(crate) endpoint: Option<String>,
    pub(crate) request_body: Option<String>,
    pub(crate) estimated_input_tokens: Option<u32>,
}

fn validate_planning_input(input: &PlanningAiJobInput) -> Result<bool, ApiError> {
    if input.section_title.trim().is_empty() || input.section_prompt.trim().is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "规划节点名称和目标不能为空".to_owned(),
        });
    }
    let extract_mode = match input.mode.as_str() {
        "GENERATE" => false,
        "EXTRACT" => true,
        _ => {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "不支持的规划 AI 模式".to_owned(),
            });
        }
    };
    if extract_mode && input.reference_content.trim().is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "导入文件内容为空".to_owned(),
        });
    }
    Ok(extract_mode)
}

fn planning_context(
    input: &PlanningAiJobInput,
) -> Result<novel_application::ContextPackage, ApiError> {
    let extract_mode = validate_planning_input(input)?;
    let mut context = novel_application::ContextPackage::connection_test();
    novel_application::PLANNING_PROMPT_VERSION.clone_into(&mut context.context_version);
    novel_application::PLANNING_PROMPT_VERSION.clone_into(&mut context.prompt_version);
    context.system_prompt = if extract_mode && input.allow_rewrite {
        "你是小说设定改写助手。以用户提供的文件为核心依据，围绕当前规划节点筛选信息，并允许重新组织、改写、归纳和合理补全，使结果完整且符合节点范围。补全内容必须与文件事实和已有约束一致，不得引入冲突设定。不要输出解释、标题或分析过程。".to_owned()
    } else if extract_mode {
        "你是小说资料提取助手。只允许从用户提供的文件证据片段中提取与当前规划节点直接相关的信息。不得补写、推测、扩展或引入文件外知识。不要输出解释、标题或分析过程。".to_owned()
    } else {
        "你是小说项目规划助手。你的职责是帮助作者把当前小说要素写成清晰、具体、可继续修改的设定。不得把推测写成已经确认的事实，不要输出解释、标题或分析过程。".to_owned()
    };
    context.user_prompt = if extract_mode && input.allow_rewrite {
        format!(
            "当前规划节点：{}\n节点目标：{}\n作者补充要求：{}\n\n已有正式作品设定（[节点导航] 仅用于定位相关节点，[原文片段] 为原始设定证据；仅用于理解范围和保持一致，不得当作文件事实写入）：\n{}\n\n文件证据片段（均来自用户选择的文件，已按节点相关度和输入预算筛选）：\n{}\n\n请以文件证据为核心依据，生成只属于当前节点范围的设定正文。可以改写表达、重组结构，并补足必要的逻辑连接或缺失细节；补全必须合理、克制，且不能违背文件事实、已有设定和当前节点填写提示。忽略与当前节点无关的内容，只输出连贯、可编辑的正文。",
            input.section_title,
            input.section_prompt,
            if input.user_guidance.trim().is_empty() {
                "无"
            } else {
                input.user_guidance.trim()
            },
            if input.existing_context.trim().is_empty() {
                "暂无"
            } else {
                input.existing_context.trim()
            },
            input.reference_content.trim()
        )
    } else if extract_mode {
        format!(
            "当前规划节点：{}\n节点目标：{}\n作者补充的提取要求：{}\n\n已有正式作品设定（[节点导航] 仅用于定位相关节点，[原文片段] 为原始设定证据；仅用于理解范围和保持一致，不得当作文件事实写入）：\n{}\n\n文件证据片段（均来自用户选择的文件，已按节点相关度和输入预算筛选）：\n{}\n\n只提取与当前节点直接相关的内容，并整理成连贯、可编辑的设定正文。已有正式设定和作者补充要求只能作为筛选、组织和一致性检查规则，不能作为文件事实写入结果。保留文件证据中的事实和限定条件，忽略无关内容，不得补充文件中没有的信息。如果完全没有相关内容，只回复：未提取到相关内容。",
            input.section_title,
            input.section_prompt,
            if input.user_guidance.trim().is_empty() {
                "无"
            } else {
                input.user_guidance.trim()
            },
            if input.existing_context.trim().is_empty() {
                "暂无"
            } else {
                input.existing_context.trim()
            },
            input.reference_content.trim()
        )
    } else {
        format!(
            "当前规划节点：{}\n节点目标：{}\n作者的补充意见：{}\n\n已有项目设定（[节点导航] 仅用于定位相关节点，[原文片段] 为原始设定证据；有冲突时以 [原文片段] 为准）：\n{}\n\n请遵循作者的补充意见，只输出当前节点的设定正文。内容应具体、内部一致，并为后续人物、冲突和情节规划提供可用约束。",
            input.section_title,
            input.section_prompt,
            if input.user_guidance.trim().is_empty() {
                "无"
            } else {
                input.user_guidance.trim()
            },
            if input.existing_context.trim().is_empty() {
                "暂无"
            } else {
                input.existing_context.trim()
            },
        )
    };
    context.task_contract.role = novel_application::AiTaskRole::ChapterSummarizer;
    context.task_contract.goal = if extract_mode && input.allow_rewrite {
        format!(
            "根据文件改写并补全小说规划节点“{}”的内容",
            input.section_title
        )
    } else if extract_mode {
        format!(
            "从文件中提取与小说规划节点“{}”相关的内容",
            input.section_title
        )
    } else {
        format!("生成小说规划节点“{}”的可编辑设定正文", input.section_title)
    };
    "PLANNING_SECTION".clone_into(&mut context.task_contract.target_type);
    context.task_contract.permissions = if extract_mode && input.allow_rewrite {
        vec!["依据文件改写、重组并合理补全当前节点的设定内容。".to_owned()]
    } else if extract_mode {
        vec!["提取并整理文件中与当前节点直接相关的内容。".to_owned()]
    } else {
        vec!["根据已有设定提出规划文本。".to_owned()]
    };
    context.task_contract.forbidden_actions = if extract_mode && input.allow_rewrite {
        vec![
            "不得修改项目数据。".to_owned(),
            "不得引入与文件事实或已有设定冲突的内容。".to_owned(),
        ]
    } else {
        vec![
            "不得修改项目数据。".to_owned(),
            "不得把不确定内容表述为已确认事实。".to_owned(),
        ]
    };
    context.task_contract.acceptance_criteria = vec!["输出可直接编辑的设定正文。".to_owned()];
    "只输出设定正文，不要 Markdown 标题或解释。"
        .clone_into(&mut context.task_contract.output_contract);
    if let Some(system_prompt) = input.system_prompt_snapshot.as_deref() {
        system_prompt.clone_into(&mut context.system_prompt);
    }
    if let Some(user_prompt) = input.user_prompt_snapshot.as_deref() {
        user_prompt.clone_into(&mut context.user_prompt);
    }
    Ok(context)
}

#[cfg(test)]
mod planning_context_tests {
    use super::*;

    #[test]
    fn planning_context_marks_selected_file_evidence() {
        let context = planning_context(&PlanningAiJobInput {
            profile_id: uuid::Uuid::new_v4(),
            mode: "EXTRACT".to_owned(),
            section_id: "seed-premise".to_owned(),
            section_title: "核心前提与开局情境".to_owned(),
            section_prompt: "提取主角开局遭遇。".to_owned(),
            existing_context: "seed-genre-promise: 都市悬疑。".to_owned(),
            reference_content: "[文件片段 1] 主角在停电城市寻找失踪姐姐。".to_owned(),
            user_guidance: String::new(),
            allow_rewrite: false,
            temperature: None,
            max_output_tokens: None,
            task_key: None,
            source_name: None,
            system_prompt_snapshot: None,
            user_prompt_snapshot: None,
            final_request_endpoint: None,
            final_request_body: None,
            final_request_estimated_input_tokens: None,
        })
        .expect("planning context");

        assert_eq!(
            context.prompt_version,
            novel_application::PLANNING_PROMPT_VERSION
        );
        assert!(context.user_prompt.contains("文件证据片段"));
        assert!(context.user_prompt.contains("主角在停电城市寻找失踪姐姐"));
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_planning_content(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    mode: String,
    section_title: String,
    section_prompt: String,
    existing_context: String,
    reference_content: String,
    user_guidance: String,
    allow_rewrite: bool,
) -> Result<String, ApiError> {
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "请选择聊天模型配置".to_owned(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let secret_ref = profile
        .secret_ref
        .as_deref()
        .ok_or(novel_infrastructure::AiError::MissingSecret)
        .map_err(ApiError::from)?;
    let secret = novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
    let input_token_budget = profile
        .context_window
        .saturating_sub(profile.max_output_tokens);
    let query = format!("{section_title} {section_prompt} {user_guidance}");
    let planning_mode = planning_context_mode(&mode, allow_rewrite)?;
    let embedding_query = planning_embedding_query(&state, &query).await.ok();
    let project_retrieval = if let Some(embedding) = embedding_query.as_ref() {
        semantic_planning_context(&state, &existing_context, &query, &embedding.query)
            .await
            .ok()
    } else {
        None
    };
    let empty_project_section_similarities = HashMap::new();
    let empty_project_chunk_similarities = HashMap::new();
    let project_section_similarities = project_retrieval
        .as_ref()
        .map_or(&empty_project_section_similarities, |retrieval| {
            &retrieval.section_similarities
        });
    let project_chunk_similarities = project_retrieval
        .as_ref()
        .map_or(&empty_project_chunk_similarities, |retrieval| {
            &retrieval.chunk_similarities
        });
    let reference_similarities = if let Some(embedding) = embedding_query.as_ref() {
        semantic_reference_similarities(&state, &reference_content, &query, &embedding.query)
            .await
            .map_or_else(|_| HashMap::new(), |retrieval| retrieval.similarities)
    } else {
        HashMap::new()
    };
    let planned_context = build_planning_context_plan(
        &existing_context,
        &reference_content,
        &query,
        planning_mode,
        input_token_budget,
        PlanningRetrievalSimilarities {
            project_sections: project_section_similarities,
            project_chunks: project_chunk_similarities,
            references: &reference_similarities,
        },
    );
    let input = PlanningAiJobInput {
        profile_id,
        mode,
        section_id: String::new(),
        section_title,
        section_prompt,
        existing_context: planned_context.project_context,
        reference_content: planned_context.reference_context,
        user_guidance,
        allow_rewrite,
        temperature: None,
        max_output_tokens: None,
        task_key: None,
        source_name: None,
        system_prompt_snapshot: None,
        user_prompt_snapshot: None,
        final_request_endpoint: None,
        final_request_body: None,
        final_request_estimated_input_tokens: None,
    };
    let mut context = planning_context(&input)?;
    let estimated_input_chars = context
        .system_prompt
        .len()
        .saturating_add(context.user_prompt.len());
    context.estimated_input_tokens = (u32::try_from(estimated_input_chars).unwrap_or(u32::MAX) / 4)
        .min(
            profile
                .context_window
                .saturating_sub(profile.max_output_tokens),
        );
    state
        .gateway
        .generate(
            &profile,
            Some(&secret),
            &context,
            false,
            false,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn enqueue_planning_ai_job(
    state: tauri::State<'_, ProjectState>,
    mut input: PlanningAiJobInput,
) -> Result<novel_infrastructure::Job, ApiError> {
    validate_planning_input(&input)?;
    input.system_prompt_snapshot = None;
    input.user_prompt_snapshot = None;
    let job_type = match input.mode.as_str() {
        "GENERATE" => novel_infrastructure::JobType::AiPlanningGenerate,
        "EXTRACT" => novel_infrastructure::JobType::AiPlanningExtract,
        _ => {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "不支持的规划 AI 模式".to_owned(),
            });
        }
    };
    let payload =
        serde_json::to_string(&input).map_err(|error| ApiError::internal(error.to_string()))?;
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    let job = manager
        .enqueue_job(job_type, payload)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    manager
        .append_job_event(job.id, "QUEUED", "任务已进入 AI 队列", 0)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(job)
}

#[tauri::command]
pub(crate) fn get_planning_ai_job_request(
    state: tauri::State<'_, ProjectState>,
    job_id: uuid::Uuid,
) -> Result<PlanningAiRequestPreview, ApiError> {
    let job = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .get_job(job_id)
            .map_err(|error| ApiError::internal(error.to_string()))?
    };
    if !matches!(
        job.job_type,
        novel_infrastructure::JobType::AiPlanningGenerate
            | novel_infrastructure::JobType::AiPlanningExtract
    ) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "该任务不是规划 AI 任务".to_owned(),
        });
    }
    let input: PlanningAiJobInput = serde_json::from_str(&job.payload)
        .map_err(|error| ApiError::internal(format!("任务参数无效：{error}")))?;
    Ok(PlanningAiRequestPreview {
        endpoint: input.final_request_endpoint,
        request_body: input.final_request_body,
        estimated_input_tokens: input.final_request_estimated_input_tokens,
    })
}

fn fail_planning_job(state: &ProjectState, job_id: uuid::Uuid, message: impl Into<String>) {
    let message = message.into();
    if let Ok(mut manager) = state.manager.lock() {
        let _ = manager.append_job_event(job_id, "FAILED", &message, 100);
        let _ = manager.update_job_status(
            job_id,
            novel_infrastructure::JobStatus::Failed,
            100,
            Some(message),
        );
    }
}

fn append_planning_job_event(
    state: &ProjectState,
    job_id: uuid::Uuid,
    job_stage: &str,
    message: impl Into<String>,
    progress: u8,
) {
    if let Ok(mut manager) = state.manager.lock() {
        let _ = manager.append_job_event(job_id, job_stage, message, progress);
    }
}

pub(crate) async fn run_next_planning_ai_job(app: &tauri::AppHandle) -> bool {
    let state = app.state::<ProjectState>();
    let job = {
        let Ok(mut manager) = state.manager.lock() else {
            return false;
        };
        match manager.claim_next_ai_job() {
            Ok(job) => job,
            Err(_) => return false,
        }
    };
    let Some(job) = job else {
        return false;
    };
    if let Ok(mut manager) = state.manager.lock() {
        let _ = manager.update_job_progress(job.id, 5);
        let _ = manager.append_job_event(job.id, "PREPARING", "正在读取任务参数", 5);
    }
    let mut input: PlanningAiJobInput = match serde_json::from_str(&job.payload) {
        Ok(input) => input,
        Err(error) => {
            fail_planning_job(&state, job.id, format!("任务参数无效：{error}"));
            return true;
        }
    };
    let profile = {
        let Ok(store) = state.model_profiles.lock() else {
            fail_planning_job(&state, job.id, "无法读取模型配置");
            return true;
        };
        match store.get(input.profile_id) {
            Ok(profile) => profile,
            Err(error) => {
                fail_planning_job(&state, job.id, error.to_string());
                return true;
            }
        }
    };
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        fail_planning_job(&state, job.id, "请选择聊天模型配置");
        return true;
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        fail_planning_job(&state, job.id, "本地隐私策略禁止调用远程模型");
        return true;
    }
    let generation_options =
        match task_generation_options(input.task_key, input.temperature, input.max_output_tokens) {
            Ok(options) => options,
            Err(error) => {
                fail_planning_job(&state, job.id, error.message);
                return true;
            }
        };
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let task_kind = input
        .task_key
        .unwrap_or(novel_infrastructure::AiTaskKind::WorkDesign);
    let task_preference = match load_ai_task_preference(&state, task_kind) {
        Ok(preference) => preference,
        Err(error) => {
            fail_planning_job(&state, job.id, error.message);
            return true;
        }
    };
    let include_project_context = context_option(
        task_preference.prompt.context.include_project_context,
        task_kind.default_include_project_context(),
    );
    let include_reference_content = context_option(
        task_preference.prompt.context.include_reference_content,
        task_kind.default_include_reference_content(),
    );
    let include_project_knowledge = context_option(
        task_preference.prompt.context.include_project_knowledge,
        task_kind.default_include_project_knowledge(),
    );
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let secret = if let Some(secret_ref) = profile.secret_ref.as_deref() {
        match novel_infrastructure::SecretStore::get(secret_ref) {
            Ok(secret) => secret,
            Err(error) => {
                fail_planning_job(&state, job.id, error.to_string());
                return true;
            }
        }
    } else {
        fail_planning_job(&state, job.id, "模型配置缺少 API 密钥");
        return true;
    };
    let query = format!(
        "{} {} {}",
        input.section_title, input.section_prompt, input.user_guidance
    );
    if !include_project_context {
        input.existing_context.clear();
    }
    if !include_reference_content {
        input.reference_content.clear();
    }
    let planning_mode = match planning_context_mode(&input.mode, input.allow_rewrite) {
        Ok(mode) => mode,
        Err(error) => {
            fail_planning_job(&state, job.id, error.message);
            return true;
        }
    };
    let embedding_query =
        if include_project_knowledge && (include_project_context || include_reference_content) {
            match planning_embedding_query(&state, &query).await {
                Ok(result) => {
                    append_planning_job_event(
                        &state,
                        job.id,
                        "RETRIEVAL",
                        format!("查询向量生成完成，耗时 {} ms", result.elapsed_ms),
                        7,
                    );
                    Some(result)
                }
                Err(reason) => {
                    append_planning_job_event(
                        &state,
                        job.id,
                        "RETRIEVAL",
                        format!("向量检索不可用（{reason}），已回退关键词匹配"),
                        7,
                    );
                    None
                }
            }
        } else {
            None
        };
    let project_retrieval = if include_project_context {
        if let Some(embedding) = embedding_query.as_ref() {
            match semantic_planning_context(
                &state,
                &input.existing_context,
                &query,
                &embedding.query,
            )
            .await
            {
                Ok(retrieval) => Some(retrieval),
                Err(reason) => {
                    append_planning_job_event(
                        &state,
                        job.id,
                        "RETRIEVAL",
                        format!("正式设定向量筛选失败（{reason}），已回退关键词匹配"),
                        8,
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let reference_retrieval = if include_reference_content {
        if let Some(embedding) = embedding_query.as_ref() {
            match semantic_reference_similarities(
                &state,
                &input.reference_content,
                &query,
                &embedding.query,
            )
            .await
            {
                Ok(retrieval) => Some(retrieval),
                Err(reason) => {
                    append_planning_job_event(
                        &state,
                        job.id,
                        "RETRIEVAL",
                        format!("文件证据向量筛选失败（{reason}），已回退关键词匹配"),
                        9,
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let empty_similarities = HashMap::new();
    let reference_similarities = reference_retrieval
        .as_ref()
        .map_or(&empty_similarities, |retrieval| &retrieval.similarities);
    let empty_project_section_similarities = HashMap::new();
    let empty_project_chunk_similarities = HashMap::new();
    let project_section_similarities = project_retrieval
        .as_ref()
        .map_or(&empty_project_section_similarities, |retrieval| {
            &retrieval.section_similarities
        });
    let project_chunk_similarities = project_retrieval
        .as_ref()
        .map_or(&empty_project_chunk_similarities, |retrieval| {
            &retrieval.chunk_similarities
        });
    let planned_context = build_planning_context_plan(
        &input.existing_context,
        &input.reference_content,
        &query,
        planning_mode,
        input_token_budget,
        PlanningRetrievalSimilarities {
            project_sections: project_section_similarities,
            project_chunks: project_chunk_similarities,
            references: reference_similarities,
        },
    );
    if let Some(retrieval) = project_retrieval.as_ref()
        && retrieval.candidate_sections > 0
    {
        append_planning_job_event(
            &state,
            job.id,
            "RETRIEVAL",
            format!(
                "正式设定：摘要向量生成 {} 个（{} 字符），整节点向量补充 {} 个；候选 {} 个节点 / {} 个分块，复用 {} 个分块向量，临时生成 {} 个（{} 字符）；最终保留 {} 个节点 / {} 个原文片段，耗时 {} ms",
                retrieval.embedded_vectors,
                retrieval.embedded_chars,
                retrieval.persisted_vectors,
                retrieval.candidate_sections,
                retrieval.candidate_chunks,
                retrieval.persisted_chunks,
                retrieval.embedded_chunks,
                retrieval.embedded_chunk_chars,
                planned_context.selected_project_sections,
                planned_context.selected_project_chunks,
                retrieval.elapsed_ms
            ),
            9,
        );
    }
    if let Some(retrieval) = reference_retrieval.as_ref()
        && retrieval.candidate_blocks > 0
    {
        append_planning_job_event(
            &state,
            job.id,
            "RETRIEVAL",
            format!(
                "文件证据：候选 {} 个片段，向量生成 {} 个（{} 字符），最终保留 {} 个，耗时 {} ms",
                retrieval.candidate_blocks,
                retrieval.embedded_blocks,
                retrieval.embedded_chars,
                planned_context.selected_reference_blocks,
                retrieval.elapsed_ms
            ),
            10,
        );
    }
    if let Ok(mut manager) = state.manager.lock() {
        let _ = manager.append_job_event(
            job.id,
            "CONTEXT",
            format!(
                "已保留 {} 个正式设定节点 / {} 个原文片段（{} 字符）和 {} 个文件片段（{} 字符）",
                planned_context.selected_project_sections,
                planned_context.selected_project_chunks,
                planned_context.project_context.chars().count(),
                planned_context.selected_reference_blocks,
                planned_context.reference_context.chars().count()
            ),
            12,
        );
    }
    input.existing_context = planned_context.project_context;
    input.reference_content = planned_context.reference_context;
    input.system_prompt_snapshot = None;
    input.user_prompt_snapshot = None;
    let mut context = match planning_context(&input) {
        Ok(context) => context,
        Err(error) => {
            fail_planning_job(&state, job.id, error.message);
            return true;
        }
    };
    novel_infrastructure::apply_task_prompt_preferences(
        &mut context,
        &task_preference,
        &[
            ("sectionTitle", input.section_title.as_str()),
            ("sectionPrompt", input.section_prompt.as_str()),
            ("userGuidance", input.user_guidance.as_str()),
            ("existingContext", input.existing_context.as_str()),
            ("referenceContent", input.reference_content.as_str()),
        ],
    );
    input.system_prompt_snapshot = Some(context.system_prompt.clone());
    input.user_prompt_snapshot = Some(context.user_prompt.clone());
    let estimated_input_chars = context
        .system_prompt
        .len()
        .saturating_add(context.user_prompt.len());
    context.estimated_input_tokens = (u32::try_from(estimated_input_chars).unwrap_or(u32::MAX) / 4)
        .min(profile.context_window.saturating_sub(max_output_tokens));
    let (endpoint, request_body) = state.gateway.request_preview_with_options(
        &profile,
        &context,
        true,
        false,
        generation_options,
    );
    input.final_request_endpoint = Some(endpoint);
    input.final_request_estimated_input_tokens = Some(context.estimated_input_tokens);
    input.final_request_body = match serde_json::to_string_pretty(&request_body) {
        Ok(body) => Some(body),
        Err(error) => {
            fail_planning_job(&state, job.id, format!("无法记录最终 AI 请求：{error}"));
            return true;
        }
    };
    let updated_payload = match serde_json::to_string(&input) {
        Ok(payload) => payload,
        Err(error) => {
            fail_planning_job(&state, job.id, format!("无法保存最终 AI 请求：{error}"));
            return true;
        }
    };
    if let Ok(mut manager) = state.manager.lock() {
        let _ = manager.update_job_progress(job.id, 20);
        let _ = manager.append_job_event(job.id, "CONTEXT", "提示词与上下文已准备完成", 20);
        if let Err(error) = manager.update_job_payload(job.id, updated_payload) {
            drop(manager);
            fail_planning_job(&state, job.id, format!("无法保存最终 AI 请求：{error}"));
            return true;
        }
        let _ = manager.update_job_progress(job.id, 30);
        let _ = manager.append_job_event(job.id, "REQUESTING", "正在等待模型响应", 30);
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut cancellations) = state.ai_cancellations.lock() {
        cancellations.insert(job.id, Arc::clone(&cancelled));
    }
    let callback_app = app.clone();
    let mut received_chars = 0usize;
    let mut last_progress = 30u8;
    let result = generate_with_task_fallback(
        &state,
        &task_preference,
        &profile,
        Some(&secret),
        &context,
        generation_options,
        true,
        false,
        Arc::clone(&cancelled),
        move |chunk| {
            received_chars += chunk.chars().count();
            let progress = u8::try_from(35 + (received_chars / 120).min(50)).unwrap_or(u8::MAX);
            if progress >= last_progress.saturating_add(5) {
                last_progress = progress;
                let callback_state = callback_app.state::<ProjectState>();
                if let Ok(mut manager) = callback_state.manager.lock() {
                    let _ = manager.update_job_progress(job.id, progress);
                    let _ = manager.append_job_event(
                        job.id,
                        "RECEIVING",
                        format!("已接收约 {received_chars} 个字符"),
                        progress,
                    );
                }
            }
        },
    )
    .await;
    if let Ok(mut cancellations) = state.ai_cancellations.lock() {
        cancellations.remove(&job.id);
    }
    match result {
        Ok(outcome) => {
            if let Some(fallback) = outcome.fallback_profile.as_ref() {
                append_planning_job_event(
                    &state,
                    job.id,
                    "FALLBACK",
                    format!(
                        "主模型调用失败（{}），已切换到备用模型“{}”",
                        outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN"),
                        fallback.name
                    ),
                    35,
                );
            }
            let Ok(mut manager) = state.manager.lock() else {
                return true;
            };
            if manager.is_job_cancel_requested(job.id).unwrap_or(false) {
                let _ = manager.append_job_event(job.id, "CANCELLED", "任务已取消", 100);
                let _ = manager.update_job_status(
                    job.id,
                    novel_infrastructure::JobStatus::Cancelled,
                    100,
                    None,
                );
                return true;
            }
            let _ = manager.update_job_progress(job.id, 92);
            let _ = manager.append_job_event(job.id, "SAVING", "正在保存到待定区", 92);
            let existing = manager.list_planning_sections().ok().and_then(|sections| {
                sections
                    .into_iter()
                    .find(|item| item.id == input.section_id)
            });
            let mut section = existing.unwrap_or(novel_infrastructure::PlanningSection {
                id: input.section_id.clone(),
                content: String::new(),
                pending_content: String::new(),
                rationale: String::new(),
                consequence: String::new(),
                references: Vec::new(),
                updated_at: String::new(),
            });
            section.pending_content = outcome.output;
            section.references = input.source_name.clone().unwrap_or_default();
            if let Err(error) = manager.save_planning_section(section) {
                drop(manager);
                fail_planning_job(&state, job.id, error.to_string());
                return true;
            }
            let _ = manager.append_job_event(job.id, "COMPLETED", "结果已保存到待定区", 100);
            let _ = manager.update_job_status(
                job.id,
                novel_infrastructure::JobStatus::Succeeded,
                100,
                None,
            );
        }
        Err(novel_infrastructure::AiError::Cancelled) => {
            if let Ok(mut manager) = state.manager.lock() {
                let _ = manager.append_job_event(job.id, "CANCELLED", "任务已取消", 100);
                let _ = manager.update_job_status(
                    job.id,
                    novel_infrastructure::JobStatus::Cancelled,
                    100,
                    None,
                );
            }
        }
        Err(error) => fail_planning_job(&state, job.id, error.to_string()),
    }
    true
}

#[tauri::command]
pub(crate) async fn extract_entities_from_text(
    state: tauri::State<'_, ProjectState>,
    input: ExtractEntitiesInput,
) -> Result<Vec<ExtractedEntity>, ApiError> {
    let ExtractEntitiesInput {
        profile_id,
        entity_type,
        entity_name,
        brief_summary,
        applicability_scope,
        source_text,
        user_guidance,
        temperature,
        max_output_tokens,
    } = input;
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "请选择聊天模型配置".to_owned(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let task_kind = novel_infrastructure::AiTaskKind::KnowledgeExtraction;
    let task_preference = load_ai_task_preference(&state, task_kind)?;
    let include_reference_content = context_option(
        task_preference.prompt.context.include_reference_content,
        task_kind.default_include_reference_content(),
    );
    if !include_reference_content {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "知识提炼已关闭参考文件上下文，请先在 AI 任务设置中开启".to_owned(),
        });
    }
    let generation_options =
        task_generation_options(Some(task_kind), temperature, max_output_tokens)?;
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let secret = profile
        .secret_ref
        .as_deref()
        .ok_or(novel_infrastructure::AiError::MissingSecret)
        .map_err(ApiError::from)?;
    let secret = novel_infrastructure::SecretStore::get(secret).map_err(ApiError::from)?;
    if entity_name.trim().is_empty()
        || brief_summary.trim().is_empty()
        || applicability_scope.trim().is_empty()
        || source_text.trim().is_empty()
    {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "类型、名称、简要概述、适用范围和文件内容都不能为空".to_owned(),
        });
    }
    let topic = format!("{entity_type:?}");
    let user_guidance = user_guidance.unwrap_or_default();
    let source_text = truncate_text_to_char_budget(
        &source_text,
        usize::try_from(input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(4)
            .saturating_sub(8_192)
            .max(1_024),
        "\n[已按上下文预算截断文件内容]",
    );
    let mut context = novel_application::ContextPackage::connection_test();
    "你是小说知识整理助手。只根据用户提供的文件提炼信息，不得补写文件外事实。"
        .clone_into(&mut context.system_prompt);
    context.user_prompt = format!(
        "请围绕以下四项定义，从文件中提炼与主题相关的事实和结构化信息。主题类型：{topic}；主题名称：{entity_name}；简要概述：{brief_summary}；适用范围：{applicability_scope}；作者补充要求：{}。只提炼文件中有依据的内容，不要扩写。输出严格 JSON 数组，每项包含 name、description、aliases(字符串数组)、tags(字符串数组)，不要 Markdown，不要解释。\n\n文件内容：\n{source_text}",
        if user_guidance.trim().is_empty() {
            "无"
        } else {
            user_guidance.trim()
        }
    );
    novel_infrastructure::apply_task_prompt_preferences(
        &mut context,
        &task_preference,
        &[
            ("entityType", topic.as_str()),
            ("entityName", entity_name.as_str()),
            ("briefSummary", brief_summary.as_str()),
            ("applicabilityScope", applicability_scope.as_str()),
            ("userGuidance", user_guidance.as_str()),
            ("sourceText", source_text.as_str()),
        ],
    );
    context.estimated_input_tokens = u32::try_from(
        (context.system_prompt.chars().count() + context.user_prompt.chars().count()).div_ceil(4),
    )
    .unwrap_or(u32::MAX)
    .min(input_token_budget);
    let output = generate_with_task_fallback(
        &state,
        &task_preference,
        &profile,
        Some(&secret),
        &context,
        generation_options,
        false,
        false,
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .map_err(ApiError::from)?
    .output;
    let cleaned = output
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json = cleaned
        .find('[')
        .and_then(|start| cleaned.rfind(']').map(|end| &cleaned[start..=end]))
        .unwrap_or(cleaned);
    serde_json::from_str(json).map_err(|_| ApiError {
        code: "INVALID_RESPONSE",
        message: "AI 返回的提炼结果不是有效 JSON，请重试".to_owned(),
    })
}

fn sync_model_profile(
    manager: &mut novel_infrastructure::ProjectManager,
    profile: &novel_infrastructure::ModelProfile,
) -> Result<(), ApiError> {
    manager
        .upsert_model_profile(novel_infrastructure::ModelProfileInput {
            id: Some(profile.id),
            name: profile.name.clone(),
            provider: profile.provider,
            capability: profile.capability,
            base_url: profile.base_url.clone(),
            model_id: profile.model_id.clone(),
            context_window: profile.context_window,
            max_output_tokens: profile.max_output_tokens,
            privacy_level: profile.privacy_level,
            timeout_seconds: profile.timeout_seconds,
            retry_limit: profile.retry_limit,
        })
        .map_err(ApiError::from)?;
    manager
        .set_model_profile_secret_ref(profile.id, profile.secret_ref.as_deref())
        .map_err(ApiError::from)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn assemble_context_with_project_knowledge(
    state: tauri::State<'_, ProjectState>,
    input: novel_application::AssembleContextInput,
    object_ids: Option<Vec<uuid::Uuid>>,
) -> Result<novel_application::ContextPackage, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .assemble_context_with_project_knowledge_and_objects(
            &input,
            object_ids.as_deref().unwrap_or_default(),
        )
        .map_err(|error| ApiError::internal(error.to_string()))
}

#[tauri::command]
pub(crate) fn list_model_profiles(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::ModelProfile>, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.list().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_ai_task_preferences(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::AiTaskPreferences, ApiError> {
    let store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.get_ai_task_preferences().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_ai_task_preferences(
    state: tauri::State<'_, ProjectState>,
    preferences: novel_infrastructure::AiTaskPreferences,
) -> Result<novel_infrastructure::AiTaskPreferences, ApiError> {
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store
        .save_ai_task_preferences(&preferences)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_project_ai_task_overrides(
    state: tauri::State<'_, ProjectState>,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_project_ai_task_override(
    state: tauri::State<'_, ProjectState>,
    task: novel_infrastructure::AiTaskKind,
    preference: novel_infrastructure::AiTaskPreference,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let profiles = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.list().map_err(ApiError::from)?
    };
    let required_profile_ids = [preference.profile_id, preference.fallback_profile_id];
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    for profile_id in required_profile_ids.into_iter().flatten() {
        let profile = profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                ApiError::from(novel_infrastructure::AiError::MissingProfile(profile_id))
            })?;
        if profile.capability != novel_infrastructure::ModelCapability::Chat {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "项目覆盖只能使用聊天模型".to_owned(),
            });
        }
        sync_model_profile(&mut manager, profile)?;
    }
    manager
        .save_project_ai_task_override(task, &preference)
        .map_err(ApiError::from)?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn remove_project_ai_task_override(
    state: tauri::State<'_, ProjectState>,
    task: novel_infrastructure::AiTaskKind,
) -> Result<novel_infrastructure::ProjectAiTaskOverrides, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .remove_project_ai_task_override(task)
        .map_err(ApiError::from)?;
    manager
        .get_project_ai_task_overrides()
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn upsert_model_profile(
    state: tauri::State<'_, ProjectState>,
    input: novel_infrastructure::ModelProfileInput,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store.upsert(input).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    secret: String,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = novel_infrastructure::SecretStore::secret_ref(profile_id);
    novel_infrastructure::SecretStore::set(&secret_ref, &secret).map_err(ApiError::from)?;
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    match store.set_secret_ref(profile_id, Some(&secret_ref)) {
        Ok(profile) => Ok(profile),
        Err(error) => {
            let _ = novel_infrastructure::SecretStore::delete(&secret_ref);
            Err(ApiError::from(error))
        }
    }
}

#[tauri::command]
pub(crate) fn delete_model_secret(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<novel_infrastructure::ModelProfile, ApiError> {
    let secret_ref = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?.secret_ref
    };
    if let Some(secret_ref) = secret_ref {
        novel_infrastructure::SecretStore::delete(&secret_ref).map_err(ApiError::from)?;
    }
    let mut store = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
    store
        .set_secret_ref(profile_id, None)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) async fn test_model_profile(
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
) -> Result<ModelConnectionResponse, ApiError> {
    let (mut profile, secret) = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        let profile = store.get(profile_id).map_err(ApiError::from)?;
        let secret_ref = profile
            .secret_ref
            .as_deref()
            .ok_or(novel_infrastructure::AiError::MissingSecret)
            .map_err(ApiError::from)?;
        let secret = novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
        (profile, secret)
    };
    let detail = match profile.capability {
        novel_infrastructure::ModelCapability::Chat => {
            let connection_test_token_cap =
                if profile.provider == novel_infrastructure::ModelProvider::DeepSeek {
                    512
                } else {
                    16
                };
            profile.max_output_tokens = profile.max_output_tokens.min(connection_test_token_cap);
            let context = novel_application::ContextPackage::connection_test();
            state
                .gateway
                .generate(
                    &profile,
                    Some(&secret),
                    &context,
                    false,
                    false,
                    Arc::new(AtomicBool::new(false)),
                    |_| {},
                )
                .await
                .map_err(ApiError::from)?;
            "聊天请求成功".to_owned()
        }
        novel_infrastructure::ModelCapability::Embedding => {
            let vector = state
                .embedding_gateway
                .embed(&profile, &secret, "连接测试")
                .await
                .map_err(ApiError::from)?;
            format!("Embedding 请求成功，返回 {} 维向量", vector.len())
        }
    };
    Ok(ModelConnectionResponse {
        capability: profile.capability,
        provider: profile.provider,
        model_id: profile.model_id,
        detail,
    })
}

#[tauri::command]
pub(crate) fn list_ai_proposals(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::AiProposalReview>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_ai_proposal_reviews(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn rate_ai_proposal(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    rating: novel_infrastructure::AiProposalFeedbackRating,
    note: Option<String>,
) -> Result<novel_infrastructure::AiProposalFeedback, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .rate_ai_proposal(id, rating, note)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_ai_runs(
    state: tauri::State<'_, ProjectState>,
    limit: Option<u32>,
) -> Result<Vec<novel_infrastructure::AiRun>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_ai_runs(limit.unwrap_or(20))
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn decide_ai_proposal(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    status: novel_infrastructure::AiProposalStatus,
    accepted_text: Option<String>,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .decide_ai_proposal(id, status, accepted_text)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn cancel_ai_task(
    state: tauri::State<'_, ProjectState>,
    task_id: uuid::Uuid,
) -> Result<(), ApiError> {
    let cancellations = state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?;
    let flag = cancellations.get(&task_id).ok_or_else(|| ApiError {
        code: "NOT_FOUND",
        message: "AI task is not running".to_owned(),
    })?;
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)]
pub(crate) async fn generate_ai_proposal(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    action: novel_infrastructure::AiAction,
    chapter_title: String,
    chapter_plan: String,
    document_json: String,
    selection: Option<String>,
    instruction: Option<String>,
    stream: bool,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(profile_id).map_err(ApiError::from)?
    };
    let target_revision_id = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let revision = manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?;
        revision.map(|value| value.id)
    };
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let task_kind = novel_infrastructure::AiTaskKind::Writing;
    let task_preference = load_ai_task_preference(&state, task_kind)?;
    let include_project_knowledge = context_option(
        task_preference.prompt.context.include_project_knowledge,
        task_kind.default_include_project_knowledge(),
    );
    let include_current_draft = context_option(
        task_preference.prompt.context.include_current_draft,
        task_kind.default_include_current_draft(),
    );
    let include_chapter_plan = context_option(
        task_preference.prompt.context.include_chapter_plan,
        task_kind.default_include_chapter_plan(),
    );
    let generation_options =
        task_generation_options(Some(task_kind), temperature, max_output_tokens)?;
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let effective_document_json =
        if !include_current_draft && action == novel_infrastructure::AiAction::Draft {
            r#"{"type":"doc","content":[]}"#.to_owned()
        } else {
            document_json
        };
    let context_input = novel_application::AssembleContextInput {
        chapter_id,
        target_revision_id,
        action,
        chapter_title,
        chapter_plan: if include_chapter_plan {
            chapter_plan
        } else {
            String::new()
        },
        document_json: effective_document_json,
        selection,
        instruction,
        input_token_budget,
    };
    let mut context = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let result = if include_project_knowledge {
            manager.assemble_context_with_project_knowledge(&context_input)
        } else {
            novel_application::ContextAssembler::assemble(&context_input)
        };
        result.map_err(|error| ApiError {
            code: "INVALID_INPUT",
            message: error.to_string(),
        })?
    };
    let current_draft =
        novel_application::document_text(&context_input.document_json).unwrap_or_default();
    let project_knowledge = context.user_prompt.clone();
    novel_infrastructure::apply_task_prompt_preferences(
        &mut context,
        &task_preference,
        &[
            ("chapterTitle", context_input.chapter_title.as_str()),
            ("chapterPlan", context_input.chapter_plan.as_str()),
            (
                "userInstruction",
                context_input.instruction.as_deref().unwrap_or(""),
            ),
            (
                "selection",
                context_input.selection.as_deref().unwrap_or(""),
            ),
            ("currentDraft", current_draft.as_str()),
            ("projectKnowledge", project_knowledge.as_str()),
        ],
    );
    context.estimated_input_tokens = u32::try_from(
        (context.system_prompt.chars().count() + context.user_prompt.chars().count()).div_ceil(4),
    )
    .unwrap_or(u32::MAX)
    .min(profile.context_window.saturating_sub(max_output_tokens));
    let secret = match profile.secret_ref.as_deref() {
        Some(secret_ref) => {
            Some(novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?)
        }
        None => {
            return Err(ApiError::from(novel_infrastructure::AiError::MissingSecret));
        }
    };
    let task_id = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        sync_model_profile(&mut manager, &profile)?;
        manager
            .create_ai_task(profile_id, &context)
            .map_err(ApiError::from)?
    };
    let _ = app.emit("ai-task-started", AiTaskStarted { task_id });
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .insert(task_id, Arc::clone(&cancelled));
    let result = generate_with_task_fallback(
        &state,
        &task_preference,
        &profile,
        secret.as_deref(),
        &context,
        generation_options,
        stream,
        false,
        Arc::clone(&cancelled),
        |chunk| {
            let _ = app.emit(
                "ai-task-chunk",
                AiStreamChunk {
                    task_id,
                    chunk: chunk.to_owned(),
                },
            );
        },
    )
    .await;
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .remove(&task_id);
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    match result {
        Ok(outcome) => {
            if let Some(fallback) = outcome.fallback_profile.as_ref() {
                let reason = outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN");
                sync_model_profile(&mut manager, fallback)?;
                let _ = manager.record_ai_task_fallback(task_id, fallback.id, reason);
                let _ = app.emit(
                    "ai-task-attempt",
                    AiTaskAttempt {
                        task_id,
                        attempt: 2,
                        profile_name: fallback.name.clone(),
                        fallback_reason: Some(reason.to_owned()),
                    },
                );
            }
            manager
                .complete_ai_task(task_id, &context, outcome.output)
                .map_err(ApiError::from)
        }
        Err(error) => {
            let _ = manager.fail_ai_task(task_id, &error);
            Err(ApiError::from(error))
        }
    }
}
