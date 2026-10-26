use super::{ApiError,CoauthorError,CoauthorScope,ProjectState,invalid};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use novel_infrastructure::{
    CoauthorSearchExecution, CoauthorSemanticSettings, CoauthorSemanticStatus, ModelProfile, coauthor_embedding_fingerprint,
};

#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoauthorSemanticBuildResult {
    pub status: CoauthorSemanticStatus,
    pub sent_chars: usize,
    pub sent_chunks: usize,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CoauthorEmbeddingSelection {
    pub profile_id: uuid::Uuid,
    pub base_url: String,
    pub model_id: String,
    pub provider: novel_infrastructure::ModelProvider,
    pub privacy_level: novel_infrastructure::PrivacyLevel,
}

#[tauri::command]
pub(crate) fn get_coauthor_semantic_status(
    state: tauri::State<'_, ProjectState>,
    scope: CoauthorScope,
) -> Result<CoauthorSemanticStatus, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .coauthor_semantic_status(&scope)
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn clear_coauthor_semantic_cache(
    state: tauri::State<'_, ProjectState>,
    scope: CoauthorScope,
    expected_version: i64,
) -> Result<CoauthorSemanticStatus, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .clear_coauthor_semantic_cache(&scope, expected_version)
        .map_err(Into::into)
}

fn embedding_profile(state: &ProjectState, id: uuid::Uuid) -> Result<ModelProfile, ApiError> {
    let mut profile = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model mutex poisoned"))?
        .get(id)?;
    if profile.capability != novel_infrastructure::ModelCapability::Embedding
        || profile.privacy_level != novel_infrastructure::PrivacyLevel::AllowCloud
    {
        return Err(invalid("需要明确允许外发的向量模型。"));
    }
    // Indexing and query requests never silently retry or switch providers.
    profile.retry_limit = 0;
    Ok(profile)
}

#[tauri::command]
pub(crate) fn save_coauthor_semantic_settings(
    state: tauri::State<'_, ProjectState>,
    scope: CoauthorScope,
    expected_version: i64,
    selection: Option<CoauthorEmbeddingSelection>,
    kinds: Vec<String>,
) -> Result<CoauthorSemanticStatus, ApiError> {
    let profile = selection
        .map(|selected| {
            let profile = embedding_profile(&state, selected.profile_id)?;
            if profile.base_url != selected.base_url
                || profile.model_id != selected.model_id
                || profile.provider != selected.provider
                || profile.privacy_level != selected.privacy_level
            {
                return Err(invalid("模型配置已变化，请刷新并核对服务地址后重新确认。"));
            }
            Ok(profile)
        })
        .transpose()?;
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .save_coauthor_semantic_settings(&scope, expected_version, profile.as_ref(), kinds)
        .map_err(Into::into)
}

fn validate_embedding_permission(
    state: &ProjectState,
    scope: &CoauthorScope,
    settings: &CoauthorSemanticSettings,
    run_id: Option<uuid::Uuid>,
) -> Result<(), ApiError> {
    {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        if manager.coauthor_semantic_settings(scope)? != *settings
            || run_id.is_some_and(|id| !matches!(manager.coauthor_run_active(scope, id), Ok(true)))
        {
            return Err(invalid(
                "项目、语义授权或运行状态已变化，未接收迟到向量结果。",
            ));
        }
    }
    let profile = embedding_profile(
        state,
        settings
            .profile_id
            .ok_or_else(|| invalid("语义检索未启用。"))?,
    )?;
    if coauthor_embedding_fingerprint(&profile) != settings.fingerprint {
        return Err(invalid("向量模型或服务地址已变化，请重新授权并建立索引。"));
    }
    Ok(())
}

async fn embed_authorized(
    state: &ProjectState,
    scope: &CoauthorScope,
    settings: &CoauthorSemanticSettings,
    texts: &[String],
    run_id: Option<uuid::Uuid>,
) -> Result<Vec<Vec<f32>>, ApiError> {
    validate_embedding_permission(state, scope, settings, run_id)?;
    let profile = embedding_profile(
        state,
        settings
            .profile_id
            .ok_or_else(|| invalid("语义检索未启用。"))?,
    )?;
    let secret = novel_infrastructure::SecretStore::get(
        profile
            .secret_ref
            .as_deref()
            .ok_or_else(|| ApiError::from(novel_infrastructure::AiError::MissingSecret))?,
    )?;
    let request = state.embedding_gateway.embed_many(&profile, &secret, texts);
    await_authorized_embedding(state, scope, settings, run_id, request).await
}

async fn await_authorized_embedding(
    state: &ProjectState,
    scope: &CoauthorScope,
    settings: &CoauthorSemanticSettings,
    run_id: Option<uuid::Uuid>,
    request: impl std::future::Future<Output = Result<Vec<Vec<f32>>, novel_infrastructure::AiError>>,
) -> Result<Vec<Vec<f32>>, ApiError> {
    validate_embedding_permission(state, scope, settings, run_id)?;
    tokio::pin!(request);
    loop {
        tokio::select! {
            response=&mut request => {
                validate_embedding_permission(state,scope,settings,run_id)?;
                return response.map_err(|error| {
                    let mut failure=ApiError::from(error);
                    failure.message.push_str("；请求可能已发送并产生费用，未自动重试。");
                    failure
                });
            }
            ()=tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                validate_embedding_permission(state,scope,settings,run_id)?;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn build_coauthor_semantic_batch(
    state: tauri::State<'_, ProjectState>,
    scope: CoauthorScope,
    expected_version: i64,
) -> Result<CoauthorSemanticBuildResult, ApiError> {
    let batch = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .prepare_coauthor_semantic_batch(&scope)?;
    if batch.settings.version != expected_version {
        return Err(CoauthorError::Conflict.into());
    }
    let texts = batch
        .chunks
        .iter()
        .map(|chunk| chunk.text.clone())
        .collect::<Vec<_>>();
    let vectors = if texts.is_empty() {
        vec![]
    } else {
        embed_authorized(&state, &scope, &batch.settings, &texts, None).await?
    };
    let status = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .commit_coauthor_semantic_batch(&scope, &batch, &vectors)?;
    Ok(CoauthorSemanticBuildResult {
        status,
        sent_chars: texts.iter().map(|text| text.chars().count()).sum(),
        sent_chunks: texts.len(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SemanticSearchArgs {
    pub query: String,
    #[serde(default)]
    pub offset: u32,
}

pub(super) fn limit_semantic_hits(mut result: Value, budget: usize) -> Value {
    let previous = result["contextOmittedHits"].as_u64().unwrap_or(0);
    let Some(hits) = result.get_mut("hits").and_then(Value::as_array_mut) else {
        return result;
    };
    let original = hits.len();
    let mut used = 0;
    hits.retain(|hit| {
        let size = hit.to_string().chars().count();
        if used + size > budget {
            return false;
        }
        used += size;
        true
    });
    let omitted = original - hits.len();
    result["contextOmittedHits"] =
        json!(previous.saturating_add(u64::try_from(omitted).unwrap_or(u64::MAX)));
    if omitted > 0 {
        let coverage = result["coverage"].as_str().unwrap_or_default();
        result["coverage"] = json!(format!(
            "{coverage}；本轮输入预算另省略 {omitted} 条候选，未送达不等于不存在。"
        ));
    }
    result
}

pub(super) async fn semantic_search(
    state: &ProjectState,
    scope: &CoauthorScope,
    query: &str,
    offset: u32,
    run_id: uuid::Uuid,
) -> Result<Value, ApiError> {
    if query.trim().is_empty() || query.chars().count() > 2000 {
        return Err(invalid("语义查询需要 1 至 2000 字。"));
    }
    let status = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .coauthor_semantic_status(scope)?;
    if status.settings.profile_id.is_none() || status.indexed_chunks == 0 {
        return Ok(
            json!({"execution":CoauthorSearchExecution::NotRun,"hits":[],"hasMore":false,"status":status,"sentChars":0,
            "coverage":"语义检索未授权或尚无可用向量，未调用向量服务；不能据此判断没有相关设定。"}),
        );
    }
    let vectors = embed_authorized(
        state,
        scope,
        &status.settings,
        &[query.to_owned()],
        Some(run_id),
    )
    .await?;
    let vector = vectors
        .first()
        .ok_or_else(|| invalid("查询向量响应缺失。"))?;
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    let result =
        manager.search_coauthor_semantic_vector(scope, &status.settings, vector, offset)?;
    Ok(limit_semantic_hits(
        json!({"execution":result.execution,"hits":result.hits,"hasMore":result.has_more,"pendingIndexUpdates":result.pending_index_updates,
        "coverage":result.coverage,"profileId":status.settings.profile_id,"settingsVersion":status.settings.version,
        "sentChars":query.chars().count(),"status":status}),
        6000,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::coauthor::tools;
    use novel_infrastructure::{
        DiscussionScopeKind, EmbeddingGateway, ModelCapability, ModelGateway, ModelProfileInput,
        ModelProfileStore, ModelProvider, PrivacyLevel, ProjectManager,
    };
    use std::collections::HashMap;
    use std::sync::{Mutex,atomic::Ordering};

    fn fixture() -> (
        ProjectState,
        CoauthorScope,
        std::path::PathBuf,
        ModelProfile,
    ) {
        let root = std::env::temp_dir().join(format!("semantic-native-{}", uuid::Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let project = manager
            .create(root.join("project"), "语义原生测试")
            .unwrap();
        let session = manager
            .create_discussion_session("讨论".into(), DiscussionScopeKind::Project, None, None)
            .unwrap();
        let scope = CoauthorScope {
            project_id: project.project_id,
            session_id: session.id,
        };
        let mut models = ModelProfileStore::open(root.join("models.sqlite")).unwrap();
        let profile = models
            .upsert(ModelProfileInput {
                id: None,
                name: "向量".into(),
                provider: ModelProvider::SiliconFlow,
                capability: ModelCapability::Embedding,
                base_url: "http://127.0.0.1:9/v1".into(),
                model_id: "test".into(),
                context_window: 8192,
                max_output_tokens: 1024,
                privacy_level: PrivacyLevel::AllowCloud,
                timeout_seconds: 10,
                retry_limit: 2,
                input_price_micros_per_million: 0,
                output_price_micros_per_million: 0,
                price_currency: "CNY".into(),
            })
            .unwrap();
        (
            ProjectState {
                manager: Mutex::new(manager),
                model_profiles: Mutex::new(models),
                gateway: ModelGateway::default(),
                embedding_gateway: EmbeddingGateway::default(),
                ai_cancellations: Mutex::new(HashMap::new()),
            },
            scope,
            root,
            profile,
        )
    }

    #[tokio::test]
    async fn disabled_or_unbuilt_semantic_search_never_requests_credentials_or_a_provider() {
        let (state, scope, root, profile) = fixture();
        let result = semantic_search(
            &state,
            &scope,
            "没有关键词重合的表达",
            0,
            uuid::Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(result["execution"], "NOT_RUN");
        assert_eq!(result["sentChars"], 0);
        state
            .manager
            .lock()
            .unwrap()
            .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
            .unwrap();
        let result = semantic_search(&state, &scope, "另一种表达", 0, uuid::Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(result["execution"], "NOT_RUN");
        assert_eq!(result["sentChars"], 0);
        assert_eq!(
            embedding_profile(&state, profile.id).unwrap().retry_limit,
            0
        );
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn semantic_budget_omissions_remain_explicit_and_do_not_invent_sent_evidence() {
        let result = limit_semantic_hits(
            json!({"hits":[{"key":"ENTITY:1","content":"语义候选"},
            {"key":"ENTITY:2","content":"第二候选"}],"coverage":"仅候选"}),
            0,
        );
        assert_eq!(result["hits"].as_array().unwrap().len(), 0);
        assert_eq!(result["contextOmittedHits"], 2);
        assert!(
            result["coverage"]
                .as_str()
                .unwrap()
                .contains("未送达不等于不存在")
        );
    }

    #[tokio::test]
    async fn revoking_authorization_interrupts_an_inflight_embedding_and_rejects_its_result() {
        let (state, scope, root, profile) = fixture();
        let settings = state
            .manager
            .lock()
            .unwrap()
            .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
            .unwrap()
            .settings;
        let pending = await_authorized_embedding(&state, &scope, &settings, None, async {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            Ok(vec![vec![1., 0.]])
        });
        let revoke = async {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            state
                .manager
                .lock()
                .unwrap()
                .save_coauthor_semantic_settings(&scope, 1, None, vec![])
                .unwrap();
        };
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(pending, revoke)
        })
        .await
        .unwrap();
        assert!(result.is_err());
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_runs_cannot_start_embedding_and_tools_cannot_change_authorization() {
        let (state, scope, root, profile) = fixture();
        let settings = state
            .manager
            .lock()
            .unwrap()
            .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
            .unwrap()
            .settings;
        let polled = std::sync::atomic::AtomicBool::new(false);
        let result = await_authorized_embedding(
            &state,
            &scope,
            &settings,
            Some(uuid::Uuid::new_v4()),
            async {
                polled.store(true, Ordering::Relaxed);
                Ok(vec![vec![1., 0.]])
            },
        )
        .await;
        assert!(result.is_err());
        assert!(!polled.load(Ordering::Relaxed));
        assert!(
            serde_json::from_value::<SemanticSearchArgs>(
                json!({"query":"规则","kinds":["MESSAGE"]})
            )
            .is_err()
        );
        let names = tools()
            .into_iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert!(names.contains(&"search_semantic_sources".into()));
        assert!(!names.contains(&"build_coauthor_semantic_batch".into()));
        assert!(!names.contains(&"save_coauthor_semantic_settings".into()));
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }
}
