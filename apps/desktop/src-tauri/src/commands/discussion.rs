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
    manager
        .create_discussion_session(title, scope_kind, scope_id, scope_text)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_discussion_messages(
    state: tauri::State<'_, ProjectState>,
    session_id: uuid::Uuid,
    limit: Option<u32>,
) -> Result<Vec<novel_infrastructure::DiscussionMessage>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_discussion_messages(session_id, limit.unwrap_or(100).clamp(1, 200))
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
        let recent_messages = manager
            .list_discussion_messages(session.id, 20)
            .map_err(ApiError::from)?;
        let recent_history = render_history(&recent_messages, None, 8_192);
        let history = if session.summary.trim().is_empty() {
            recent_history
        } else {
            format!(
                "[会话记忆]\n{}\n\n[最近消息]\n{}",
                session.summary.trim(),
                recent_history
            )
        };
        let context = manager
            .assemble_discussion_context(&novel_application::DiscussionContextInput {
                scope_label: scope_label.clone(),
                scope_content,
                history: history.clone(),
                user_message: input.message.trim().to_owned(),
                input_token_budget,
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
        .take(20)
    {
        if used >= max_chars {
            break;
        }
        let role = match message.role {
            novel_infrastructure::DiscussionMessageRole::User => "作者",
            novel_infrastructure::DiscussionMessageRole::Assistant => "AI",
        };
        let content = message.content.trim();
        let allowance = max_chars.saturating_sub(used).min(1_200);
        let content = content.chars().take(allowance).collect::<String>();
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
