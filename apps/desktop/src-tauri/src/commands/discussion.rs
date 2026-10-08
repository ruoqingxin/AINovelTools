use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::errors::ApiError;
use crate::state::ProjectState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskProjectDiscussionInput {
    pub(crate) session_id: uuid::Uuid,
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) message: String,
    pub(crate) temperature: Option<f64>,
    pub(crate) max_output_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscussionExchange {
    pub(crate) user_message: novel_infrastructure::DiscussionMessage,
    pub(crate) assistant_message: novel_infrastructure::DiscussionMessage,
}

#[tauri::command]
pub(crate) fn list_discussion_sessions(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::DiscussionSession>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager.list_discussion_sessions().map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn create_discussion_session(
    state: tauri::State<'_, ProjectState>,
    title: String,
    scope_kind: novel_infrastructure::DiscussionScopeKind,
    scope_id: Option<uuid::Uuid>,
    scope_text: Option<String>,
    topic_kind: Option<novel_infrastructure::DiscussionTopicKind>,
    linked_entity_id: Option<uuid::Uuid>,
) -> Result<novel_infrastructure::DiscussionSession, ApiError> {
    if title.trim().is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "讨论标题不能为空".to_owned(),
        });
    }
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    if let Some(id) = linked_entity_id
        && !manager
            .list_entities(false)
            .map_err(ApiError::from)?
            .iter()
            .any(|entity| entity.id == id)
    {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "关联实体不存在或已归档".into(),
        });
    }
    let session = manager
        .create_discussion_session(title, scope_kind, scope_id, scope_text)
        .map_err(ApiError::from)?;
    if topic_kind.is_some() || linked_entity_id.is_some() {
        manager
            .save_discussion_workspace(novel_infrastructure::DiscussionWorkspace {
                session_id: session.id,
                topic_kind: topic_kind.unwrap_or_default(),
                linked_entity_id,
                draft: novel_infrastructure::DiscussionDraft::default(),
                version: 0,
            })
            .map_err(ApiError::from)?;
    }
    Ok(session)
}

#[tauri::command]
pub(crate) fn list_discussion_messages(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
    limit: Option<u32>,
    before_message_id: Option<uuid::Uuid>,
) -> Result<Vec<novel_infrastructure::DiscussionMessage>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_discussion_messages_before(session_id, limit.unwrap_or(100), before_message_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_discussion_candidates(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::DiscussionCandidate>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_discussion_candidates(session_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn get_discussion_workspace(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
) -> Result<novel_infrastructure::DiscussionWorkspace, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .get_discussion_workspace(session_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn save_discussion_workspace(
    state: tauri::State<'_, ProjectState>,
    workspace: novel_infrastructure::DiscussionWorkspace,
) -> Result<novel_infrastructure::DiscussionWorkspace, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .save_discussion_workspace(workspace)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_discussion_draft_revisions(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
    before_version: Option<i64>,
) -> Result<Vec<novel_infrastructure::DiscussionWorkspace>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_discussion_draft_revisions(session_id, before_version)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_discussion_design_proposals(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
    before_id: Option<uuid::Uuid>,
) -> Result<Vec<novel_infrastructure::DiscussionDesignProposal>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_discussion_design_proposals(session_id, before_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn confirm_discussion_design(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    entities: Vec<novel_infrastructure::DiscussionDesignEntity>,
) -> Result<Vec<uuid::Uuid>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .confirm_discussion_design(id, entities)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_author_settings(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<novel_infrastructure::AuthorSetting>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_author_settings()
        .map_err(ApiError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeDiscussionDesignInput {
    pub(crate) session_id: uuid::Uuid,
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) expected_workspace_version: i64,
    pub(crate) temperature: Option<f64>,
    pub(crate) max_output_tokens: Option<u32>,
}

#[tauri::command]
pub(crate) async fn summarize_discussion_design(
    state: tauri::State<'_, ProjectState>,
    input: SummarizeDiscussionDesignInput,
) -> Result<novel_infrastructure::DiscussionDesignProposal, ApiError> {
    let profile = state
        .model_profiles
        .lock()
        .map_err(|_| ApiError::internal("model settings mutex poisoned"))?
        .get(input.profile_id)
        .map_err(ApiError::from)?;
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "整理构思需要聊天模型。".into(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let preference =
        super::ai::load_ai_task_preference(&state, novel_infrastructure::AiTaskKind::WorkDesign)?;
    let options = super::ai::task_generation_options(
        Some(novel_infrastructure::AiTaskKind::WorkDesign),
        input.temperature,
        Some(input.max_output_tokens.unwrap_or(8_192).min(16_384)),
    )?;
    let budget = super::ai::effective_task_input_budget(
        &profile,
        super::ai::effective_max_output_tokens(&profile, options),
        &preference,
    )
    .min(120_000);
    let (workspace, context, source_message_ids, omitted_message_count, linked_snapshot) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let session = manager
            .get_discussion_session(input.session_id)
            .map_err(ApiError::from)?;
        let workspace = manager
            .get_discussion_workspace(session.id)
            .map_err(ApiError::from)?;
        if workspace.version != input.expected_workspace_version {
            return Err(ApiError::from(
                novel_infrastructure::DiscussionStoreError::Conflict,
            ));
        }
        let (label, scope) = discussion_scope(&manager, &session)?;
        let scope_content = workspace_context(&manager, &workspace, &scope)?;
        let linked_snapshot = if let Some(id) = workspace.linked_entity_id {
            manager
                .list_entities(false)
                .map_err(ApiError::from)?
                .into_iter()
                .find(|entity| entity.id == id)
                .map(|entity| (entity.id, entity.version))
        } else {
            None
        };
        let total_count = manager
            .discussion_message_count(session.id)
            .map_err(ApiError::from)?;
        let mut selected = manager
            .list_discussion_messages(session.id, 500)
            .map_err(ApiError::from)?;
        if selected.is_empty() && workspace.draft.chosen.trim().is_empty() {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "请先讨论一个灵感或记录已选定内容。".into(),
            });
        }
        let mut history_size = selected
            .iter()
            .map(|message| message.content.chars().count() + 10)
            .sum::<usize>();
        let history_budget = (budget as usize / 2).min(80_000);
        let mut offset = 0;
        while history_size > history_budget && offset < selected.len() {
            history_size =
                history_size.saturating_sub(selected[offset].content.chars().count() + 10);
            offset += 1;
        }
        selected.drain(..offset);
        let context = loop {
            let history = selected
                .iter()
                .map(|message| {
                    format!(
                        "{}：{}",
                        if message.role == novel_infrastructure::DiscussionMessageRole::User {
                            "作者"
                        } else {
                            "AI"
                        },
                        message.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let context = manager.assemble_discussion_design_context(&novel_application::DiscussionContextInput {
                scope_label: label.clone(), scope_content: scope_content.clone(), history,
                user_message: "请根据构思草稿和提供的整段讨论，整理成实体与作者设定候选；只采用作者已选择的方向，不替作者决定未决内容。关联已有实体时保留它已有的属性，仅整理本次作者选择的修改。".into(),
                input_token_budget: budget,
                focus: None,
            }).map_err(|error| ApiError { code: "INVALID_INPUT", message: error.to_string() })?;
            if context.section_audit.iter().any(|item| {
                item.kind == novel_application::ContextSectionKind::ChapterPlan && item.truncated
            }) {
                return Err(ApiError { code: "INVALID_INPUT", message: "当前模型无法容纳完整构思草稿，请精简草稿或选择更大上下文的模型；草稿原文仍完整保存。".into() });
            }
            let history_truncated = context.section_audit.iter().any(|item| {
                item.kind == novel_application::ContextSectionKind::CurrentDraft && item.truncated
            });
            if !history_truncated || selected.is_empty() {
                break context;
            }
            selected.remove(0);
        };
        if selected.is_empty() && workspace.draft.chosen.trim().is_empty() {
            return Err(ApiError { code: "INVALID_INPUT", message: "模型上下文不足以整理本次讨论，请先把选定内容记入构思草稿或使用更大上下文的模型。".into() });
        }
        let omitted = total_count.saturating_sub(selected.len());
        let ids = selected
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>();
        (workspace, context, ids, omitted, linked_snapshot)
    };
    let secret = profile
        .secret_ref
        .as_deref()
        .ok_or_else(|| ApiError::from(novel_infrastructure::AiError::MissingSecret))?;
    let secret = novel_infrastructure::SecretStore::get(secret).map_err(ApiError::from)?;
    let outcome = super::ai::generate_with_task_fallback(
        &state,
        &preference,
        &profile,
        Some(&secret),
        &context,
        options,
        false,
        false,
        Arc::new(AtomicBool::new(false)),
        |_| {},
    )
    .await
    .map_err(ApiError::from)?;
    let entities = parse_design_entities(&outcome.output)?;
    let proposal = novel_infrastructure::DiscussionDesignProposal {
        id: uuid::Uuid::new_v4(),
        session_id: workspace.session_id,
        workspace_version: workspace.version,
        entities,
        source_message_ids,
        context_version: context.context_version,
        omitted_message_count,
        status: "PENDING".into(),
        promoted_entity_ids: Vec::new(),
        created_at: String::new(),
    };
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    if let Some((id, version)) = linked_snapshot
        && !manager
            .list_entities(false)
            .map_err(ApiError::from)?
            .iter()
            .any(|entity| entity.id == id && entity.version == version)
    {
        return Err(ApiError::from(
            novel_infrastructure::DiscussionStoreError::Conflict,
        ));
    }
    manager
        .create_discussion_design_proposal(proposal)
        .map_err(ApiError::from)
}

fn parse_design_entities(
    output: &str,
) -> Result<Vec<novel_infrastructure::DiscussionDesignEntity>, ApiError> {
    if output.chars().count() > 100_000 {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "整理结果超过 10 万字，请分主题整理。".into(),
        });
    }
    let text = output.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|inner| inner.trim().strip_suffix("```"))
        .unwrap_or(text)
        .trim();
    serde_json::from_str(text).map_err(|_| ApiError {
        code: "INVALID_AI_RESPONSE",
        message: "AI 未返回有效的设定结构，请重新整理。讨论和草稿保持不变。".into(),
    })
}

fn workspace_context(
    manager: &novel_infrastructure::ProjectManager,
    workspace: &novel_infrastructure::DiscussionWorkspace,
    scope: &str,
) -> Result<String, ApiError> {
    let linked = if let Some(id) = workspace.linked_entity_id {
        let revisions = manager.list_entity_revisions(id).map_err(ApiError::from)?;
        let entity = manager
            .list_entities(false)
            .map_err(ApiError::from)?
            .into_iter()
            .find(|entity| entity.id == id);
        entity
            .and_then(|entity| {
                revisions
                    .into_iter()
                    .find(|revision| revision.id == entity.current_revision_id)
            })
            .map_or_else(
                || "关联实体已归档或不存在。".into(),
                |revision| {
                    format!(
                        "已有实体「{}」：{}\n已有属性：{}",
                        revision.name, revision.description, revision.fixed_attributes_json
                    )
                },
            )
    } else {
        "未关联已有实体，可自由构思。".into()
    };
    let linked_rules = if let Some(id) = workspace.linked_entity_id {
        manager
            .list_author_settings()
            .map_err(ApiError::from)?
            .into_iter()
            .filter(|setting| setting.entity_id == id)
            .map(|setting| format!("{}（{}）", setting.content, setting.visibility))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    Ok(format!(
        "构思主题：{}\n\n构思草稿（尚未正式入库）：\n作者已选定：\n{}\n备选方案（不能同时当作设定）：\n{}\n未决问题（允许留白）：\n{}\n\n{}\n已有作者规则（除非作者明确选择修改，否则保留）：\n{}\n\n讨论背景：\n{}",
        workspace.topic_kind.as_str(),
        workspace.draft.chosen,
        workspace.draft.alternatives,
        workspace.draft.questions,
        linked,
        linked_rules,
        scope,
    ))
}

#[tauri::command]
pub(crate) fn create_discussion_candidate(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
    message_id: uuid::Uuid,
    kind: novel_infrastructure::DiscussionCandidateKind,
    content: String,
    target_section_id: Option<String>,
) -> Result<novel_infrastructure::DiscussionCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .create_discussion_candidate(session_id, message_id, kind, content, target_section_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn dismiss_discussion_candidate(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::DiscussionCandidateStatus,
) -> Result<novel_infrastructure::DiscussionCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .dismiss_discussion_candidate(id, expected_status)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn promote_discussion_candidate(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::DiscussionCandidateStatus,
) -> Result<novel_infrastructure::DiscussionCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .promote_discussion_candidate_to_planning(id, expected_status)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn promote_discussion_candidate_to_foreshadowing_review(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::DiscussionCandidateStatus,
    evidence_anchor_id: uuid::Uuid,
) -> Result<novel_infrastructure::DiscussionCandidate, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .promote_discussion_candidate_to_foreshadowing_review(
            id,
            expected_status,
            evidence_anchor_id,
        )
        .map_err(ApiError::from)
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub(crate) async fn ask_project_discussion(
    state: tauri::State<'_, ProjectState>,
    input: AskProjectDiscussionInput,
) -> Result<DiscussionExchange, ApiError> {
    if input.message.trim().is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "讨论内容不能为空".to_owned(),
        });
    }
    if input.message.chars().count() > novel_infrastructure::DISCUSSION_MESSAGE_MAX_CHARS {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "单条讨论最多 20000 字，请拆分发送。".into(),
        });
    }
    let profile = {
        let store = state
            .model_profiles
            .lock()
            .map_err(|_| ApiError::internal("model settings mutex poisoned"))?;
        store.get(input.profile_id).map_err(ApiError::from)?
    };
    if profile.capability != novel_infrastructure::ModelCapability::Chat {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "共创讨论需要聊天模型".to_owned(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let preference =
        super::ai::load_ai_task_preference(&state, novel_infrastructure::AiTaskKind::WorkDesign)?;
    let options = super::ai::task_generation_options(
        Some(novel_infrastructure::AiTaskKind::WorkDesign),
        input.temperature,
        input.max_output_tokens,
    )?;
    let max_output_tokens = super::ai::effective_max_output_tokens(&profile, options);
    let input_token_budget =
        super::ai::effective_task_input_budget(&profile, max_output_tokens, &preference);

    let (scope_label, context, history) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let session = manager
            .get_discussion_session(input.session_id)
            .map_err(ApiError::from)?;
        let (scope_label, scope_content) = discussion_scope(&manager, &session)?;
        let workspace = manager
            .get_discussion_workspace(session.id)
            .map_err(ApiError::from)?;
        let recent_messages = manager
            .list_discussion_messages(session.id, 12)
            .map_err(ApiError::from)?;
        let history = render_history(&recent_messages, None, 5_000);
        let recent_topic = recent_messages
            .iter()
            .rev()
            .filter(|message| message.role == novel_infrastructure::DiscussionMessageRole::User)
            .take(2)
            .map(|message| message.content.chars().take(600).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        let context = manager
            .assemble_discussion_context(&novel_application::DiscussionContextInput {
                scope_label: scope_label.clone(),
                scope_content,
                history: history.clone(),
                user_message: input.message.trim().to_owned(),
                input_token_budget,
                focus: Some(novel_application::DiscussionFocus {
                    topic_kind: workspace.topic_kind.as_str().into(),
                    linked_entity_id: workspace.linked_entity_id,
                    chosen: workspace.draft.chosen,
                    alternatives: workspace.draft.alternatives,
                    questions: workspace.draft.questions,
                    recent_topic,
                }),
            })
            .map_err(|error| ApiError {
                code: "INVALID_INPUT",
                message: error.to_string(),
            })?;
        (scope_label, context, history)
    };
    let secret = profile
        .secret_ref
        .as_deref()
        .ok_or_else(|| ApiError::from(novel_infrastructure::AiError::MissingSecret))
        .and_then(|secret_ref| {
            novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)
        })?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let outcome = super::ai::generate_with_task_fallback(
        &state,
        &preference,
        &profile,
        Some(&secret),
        &context,
        options,
        false,
        false,
        cancelled,
        |_| {},
    )
    .await
    .map_err(ApiError::from)?;
    let model_profile_id = outcome
        .fallback_profile
        .as_ref()
        .map_or(profile.id, |fallback| fallback.id);
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    let assistant_context_summary = if history.is_empty() {
        context.task_contract.goal
    } else {
        format!("{} · 已载入最近讨论", context.task_contract.goal)
    };
    let (user_message, assistant_message) = manager
        .append_discussion_exchange(
            input.session_id,
            input.message.trim().to_owned(),
            outcome.output,
            Some(model_profile_id),
            Some(context.context_version.clone()),
            Some(scope_label),
            Some(assistant_context_summary),
        )
        .map_err(ApiError::from)?;
    Ok(DiscussionExchange {
        user_message,
        assistant_message,
    })
}

fn discussion_scope(
    manager: &novel_infrastructure::ProjectManager,
    session: &novel_infrastructure::DiscussionSession,
) -> Result<(String, String), ApiError> {
    let nodes = manager.list_plan_nodes().map_err(ApiError::from)?;
    let sections = manager.list_planning_sections().map_err(ApiError::from)?;
    let scope_id = session.scope_id.or_else(|| match session.scope_kind {
        novel_infrastructure::DiscussionScopeKind::Project => None,
        novel_infrastructure::DiscussionScopeKind::Volume => nodes
            .iter()
            .find(|node| node.kind == novel_infrastructure::PlanNodeKind::Volume)
            .map(|node| node.id),
        novel_infrastructure::DiscussionScopeKind::Chapter => nodes
            .iter()
            .find(|node| node.kind == novel_infrastructure::PlanNodeKind::Chapter)
            .map(|node| node.id),
        novel_infrastructure::DiscussionScopeKind::Scene => nodes
            .iter()
            .find(|node| node.kind == novel_infrastructure::PlanNodeKind::Scene)
            .map(|node| node.id),
        novel_infrastructure::DiscussionScopeKind::Selection => nodes
            .iter()
            .find(|node| node.kind == novel_infrastructure::PlanNodeKind::Chapter)
            .map(|node| node.id),
    });
    let node = scope_id.and_then(|id| nodes.iter().find(|node| node.id == id));
    let label = match session.scope_kind {
        novel_infrastructure::DiscussionScopeKind::Project => "全书讨论".to_owned(),
        novel_infrastructure::DiscussionScopeKind::Volume => node.map_or_else(
            || "分卷讨论".to_owned(),
            |node| format!("分卷「{}」", node.title),
        ),
        novel_infrastructure::DiscussionScopeKind::Chapter => node.map_or_else(
            || "章节讨论".to_owned(),
            |node| format!("章节「{}」", node.title),
        ),
        novel_infrastructure::DiscussionScopeKind::Scene => node.map_or_else(
            || "场景讨论".to_owned(),
            |node| format!("场景「{}」", node.title),
        ),
        novel_infrastructure::DiscussionScopeKind::Selection => node.map_or_else(
            || "章节选区讨论".to_owned(),
            |node| format!("章节「{}」的选区", node.title),
        ),
    };
    let plan = node.and_then(|node| {
        let section_id = format!("plan-node:{}", node.id);
        sections.iter().find(|section| section.id == section_id)
    });
    let mut scope_content = if let Some(plan) = plan {
        let formal = plan.content.trim();
        let pending = plan.pending_content.trim();
        match (formal.is_empty(), pending.is_empty()) {
            (false, false) => format!("正式规划：{formal}\n待定候选：{pending}"),
            (false, true) => format!("正式规划：{formal}"),
            (true, false) => format!("待定候选：{pending}"),
            (true, true) => "当前范围尚未填写规划。".to_owned(),
        }
    } else if session.scope_kind == novel_infrastructure::DiscussionScopeKind::Project {
        let structure = nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.kind,
                    novel_infrastructure::PlanNodeKind::Outline
                        | novel_infrastructure::PlanNodeKind::Volume
                        | novel_infrastructure::PlanNodeKind::Chapter
                        | novel_infrastructure::PlanNodeKind::Scene
                )
            })
            .take(30)
            .map(|node| format!("{}：{}", plan_kind_label(node.kind), node.title))
            .collect::<Vec<_>>();
        if structure.is_empty() {
            "作品尚未建立规划结构。".to_owned()
        } else {
            format!("当前作品结构：\n{}", structure.join("\n"))
        }
    } else {
        "当前范围不存在或已被删除。".to_owned()
    };
    if session.scope_kind == novel_infrastructure::DiscussionScopeKind::Selection {
        let selection = session
            .scope_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("当前选区为空。");
        scope_content.push_str("\n\n当前选区：\n");
        scope_content.push_str(selection.trim());
    }
    Ok((label, scope_content))
}

fn render_history(
    messages: &[novel_infrastructure::DiscussionMessage],
    excluded_message_id: Option<uuid::Uuid>,
    max_chars: usize,
) -> String {
    let mut rendered = Vec::new();
    let mut used = 0usize;
    for message in messages
        .iter()
        .filter(|message| Some(message.id) != excluded_message_id)
        .rev()
        .take(40)
    {
        if used >= max_chars {
            break;
        }
        let role = match message.role {
            novel_infrastructure::DiscussionMessageRole::User => "作者",
            novel_infrastructure::DiscussionMessageRole::Assistant => "AI",
        };
        let content = message.content.trim();
        let allowance = max_chars.saturating_sub(used).min(6_000);
        let content = if content.chars().count() > allowance {
            format!(
                "[消息片段，完整原文已保存]{}",
                content
                    .chars()
                    .take(allowance.saturating_sub(20))
                    .collect::<String>()
            )
        } else {
            content.to_owned()
        };
        let entry = format!("{role}：{content}");
        used = used.saturating_add(entry.chars().count().saturating_add(2));
        rendered.push(entry);
    }
    rendered.into_iter().rev().collect::<Vec<_>>().join("\n\n")
}

fn plan_kind_label(kind: novel_infrastructure::PlanNodeKind) -> &'static str {
    match kind {
        novel_infrastructure::PlanNodeKind::WorkDesign => "作品设定",
        novel_infrastructure::PlanNodeKind::Outline => "大纲",
        novel_infrastructure::PlanNodeKind::VolumeManager => "分卷管理",
        novel_infrastructure::PlanNodeKind::Volume => "分卷",
        novel_infrastructure::PlanNodeKind::Chapter => "章节",
        novel_infrastructure::PlanNodeKind::Scene => "场景",
    }
}

#[cfg(test)]
mod design_tests {
    use super::*;

    #[test]
    fn structured_design_parser_accepts_json_and_code_fences_without_inventing_fields() {
        let json = r#"[{"entityType":"ITEM","name":"吞声灯","description":"储存声音","attributes":{"capacity":3},"settings":["只能储存三句话。"]}]"#;
        let entities = parse_design_entities(json).expect("json");
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].visibility, "AUTHOR_ONLY");
        assert!(entities[0].target_entity_id.is_none());
        assert_eq!(entities[0].attributes["capacity"], 3);
        assert_eq!(
            parse_design_entities(&format!("```json\n{json}\n```")).expect("fenced"),
            entities
        );
        assert!(parse_design_entities("我建议再讨论一下。").is_err());
        assert!(parse_design_entities("[] trailing commentary").is_err());
    }
}
