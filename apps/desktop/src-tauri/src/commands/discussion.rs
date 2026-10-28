use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::errors::ApiError;
use crate::state::ProjectState;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskProjectDiscussionInput {
    pub(crate) session_id: uuid::Uuid,
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) message: String,
    pub(crate) planning_draft: Option<String>,
    pub(crate) temperature: Option<f64>,
    pub(crate) max_output_tokens: Option<u32>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
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
pub(crate) fn rename_discussion_session(
    state: tauri::State<'_, ProjectState>,
    scope: novel_infrastructure::CoauthorScope,
    title: String,
    expected_title: String,
) -> Result<novel_infrastructure::DiscussionSession, ApiError> {
    state.manager.lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .rename_discussion_session(&scope, title, expected_title).map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn delete_discussion_session(
    state: tauri::State<'_, ProjectState>,
    scope: novel_infrastructure::CoauthorScope,
) -> Result<(), ApiError> {
    state.manager.lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .delete_discussion_session(&scope).map_err(ApiError::from)
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
pub(crate) fn get_discussion_source(
    state: tauri::State<'_, ProjectState>,
    request: novel_infrastructure::DiscussionSourceRequest,
) -> Result<novel_infrastructure::DiscussionSource, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .get_discussion_source(request)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn list_planning_discussion_sources(
    state: tauri::State<'_, ProjectState>,
    section_id: String,
    project_id: uuid::Uuid,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<novel_infrastructure::PlanningDiscussionSource>, ApiError> {
    state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?
        .list_planning_discussion_sources(
            section_id,
            project_id,
            limit.unwrap_or(20),
            offset.unwrap_or(0),
        )
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum DiscussionDesignTarget {
    Auto,
    CharacterCard,
    ProjectSetting,
}

impl DiscussionDesignTarget {
    fn instruction(&self) -> &'static str {
        match self {
            Self::Auto => {
                "按讨论对象整理资料：角色用 CHARACTER，境界体系等全书统一规则用 CONCEPT，并在 attributes 中记录 settingScope=\"PROJECT\"；仅针对某个角色或物品的属性不标记为全书规则。"
            }
            Self::CharacterCard => {
                "整理为人物卡，entityType 必须是 CHARACTER。将作者已认可的身份、外貌、性格、动机、经历、能力、关系和秘密完整保存在描述与有明确名称的属性中。未知信息留白，不为了填满人物卡而编造。"
            }
            Self::ProjectSetting => {
                "整理为全书设定，entityType 必须是 CONCEPT，attributes.settingScope 必须是 PROJECT。境界体系等同一套规则整理为一份完整资料，保留层级顺序、突破条件、能力差异、限制、代价和例外等已确定内容；不要把各境界拆成互不相干的资料。此候选经作者确认后将成为全书统一规则。"
            }
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeDiscussionDesignInput {
    pub(crate) session_id: uuid::Uuid,
    pub(crate) profile_id: uuid::Uuid,
    pub(crate) expected_workspace_version: i64,
    pub(crate) design_target: Option<DiscussionDesignTarget>,
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
    let preference = super::ai::load_ai_task_preference(
        &state,
        novel_infrastructure::AiTaskKind::DiscussionDesign,
    )?;
    let options = super::ai::task_generation_options(
        Some(novel_infrastructure::AiTaskKind::DiscussionDesign),
        input.temperature.or(preference.temperature),
        Some(
            input
                .max_output_tokens
                .or(preference.max_output_tokens)
                .unwrap_or(4_096)
                .min(16_384),
        ),
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
        let (label, scope) = discussion_scope(&manager, &session, None)?;
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
            let mut context = manager.assemble_discussion_design_context(&novel_application::DiscussionContextInput {
                scope_label: label.clone(), scope_content: scope_content.clone(), history: history.clone(),
                user_message: format!("请根据构思草稿和提供的整段讨论，整理成资料候选；没有手工笔记时直接从对话识别作者已接受的最终选择。只采用作者已选择的方向，排除被否定、被后续修改和仍待决定的方案；不要把 AI 曾给出的所有建议都收入结论。关联已有资料时保留未被作者修改的内容。{}", input.design_target.as_ref().unwrap_or(&DiscussionDesignTarget::Auto).instruction()),
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
                novel_infrastructure::apply_task_prompt_preferences(
                    &mut context,
                    &preference,
                    &[("scopeLabel", &label), ("discussionHistory", &history)],
                );
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
        |_, _| Ok(()),
        |_| {},
    )
    .await
    .map_err(ApiError::from)?;
    let mut entities = parse_design_entities(&outcome.output)?;
    apply_design_target(&mut entities, input.design_target.as_ref())?;
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

fn apply_design_target(
    entities: &mut [novel_infrastructure::DiscussionDesignEntity],
    target: Option<&DiscussionDesignTarget>,
) -> Result<(), ApiError> {
    for entity in entities {
        let expected = match target {
            Some(DiscussionDesignTarget::CharacterCard) => {
                Some(novel_infrastructure::EntityType::Character)
            }
            Some(DiscussionDesignTarget::ProjectSetting) => {
                Some(novel_infrastructure::EntityType::Concept)
            }
            _ => None,
        };
        if expected.is_some_and(|expected| entity.entity_type != expected) {
            return Err(ApiError {
                code: "INVALID_AI_RESPONSE",
                message: "整理结果与所选资料类型不符，请重新整理。讨论原文保持不变。".into(),
            });
        }
        if matches!(target, Some(DiscussionDesignTarget::ProjectSetting)) {
            let attributes = entity.attributes.as_object_mut().ok_or_else(|| ApiError {
                code: "INVALID_AI_RESPONSE",
                message: "设定属性格式无效，请重新整理。".into(),
            })?;
            attributes.insert("settingScope".into(), serde_json::json!("PROJECT"));
        }
    }
    Ok(())
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
    if input.planning_draft.as_ref().is_some_and(|draft| {
        draft.chars().count() > novel_infrastructure::DISCUSSION_DRAFT_MAX_CHARS
    }) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "本项讨论参考草稿最多 50000 字，请缩短草稿后重试。".into(),
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
        super::ai::load_ai_task_preference(&state, novel_infrastructure::AiTaskKind::Discussion)?;
    let options = super::ai::task_generation_options(
        Some(novel_infrastructure::AiTaskKind::Discussion),
        input.temperature.or(preference.temperature),
        input.max_output_tokens.or(preference.max_output_tokens),
    )?;
    let max_output_tokens = super::ai::effective_max_output_tokens(&profile, options);
    let input_token_budget =
        super::ai::effective_task_input_budget(&profile, max_output_tokens, &preference);

    let (scope_label, context) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let session = manager
            .get_discussion_session(input.session_id)
            .map_err(ApiError::from)?;
        let (scope_label, scope_content) =
            discussion_scope(&manager, &session, input.planning_draft.as_deref())?;
        let workspace = manager
            .get_discussion_workspace(session.id)
            .map_err(ApiError::from)?;
        let recent_messages = manager
            .list_discussion_messages(session.id, 40)
            .map_err(ApiError::from)?;
        let history_limit = (input_token_budget as usize / 3).clamp(2_000, 24_000);
        let history = render_history(&recent_messages, None, history_limit);
        let recent_topic = recent_messages
            .iter()
            .rev()
            .filter(|message| message.role == novel_infrastructure::DiscussionMessageRole::User)
            .take(2)
            .map(|message| message.content.chars().take(600).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        let mut context = manager
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
        novel_infrastructure::apply_task_prompt_preferences(
            &mut context,
            &preference,
            &[
                ("scopeLabel", &scope_label),
                ("userMessage", input.message.trim()),
                ("discussionHistory", &history),
            ],
        );
        (scope_label, context)
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
        |_, _| Ok(()),
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
    let assistant_context_summary = discussion_context_summary(&context);
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

fn discussion_context_summary(context: &novel_application::ContextPackage) -> String {
    let mut sources = Vec::new();
    for evidence in &context.retrieval_evidence {
        // Only expose sources whose evidence header actually survived the prompt budget.
        let marker = format!("来源修订 {}]\n", evidence.source_revision);
        if let Some((_, content)) = context.user_prompt.split_once(&marker) {
            let title = content.lines().next().unwrap_or_default();
            if !title.is_empty() {
                sources.push(title.chars().take(140).collect::<String>());
            }
        }
    }
    let mut summary = if sources.is_empty() {
        "本轮没有载入相关项目资料，未检索到的内容仍为未知。".to_owned()
    } else {
        format!(
            "本轮参考（按话题选取，不代表读取全书）：\n{}",
            sources.join("\n")
        )
    };
    if context.truncated {
        summary.push_str("\n部分内容已按模型上下文预算截取。");
    }
    summary
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanningDiscussionFocus {
    kind: String,
    section_id: String,
    title: String,
    question: String,
}

fn planning_discussion_scope(
    session: &novel_infrastructure::DiscussionSession,
    sections: &[novel_infrastructure::PlanningSection],
    planning_draft: Option<&str>,
    nodes: &[novel_infrastructure::PlanNode],
) -> Option<(String, String)> {
    if session.scope_kind != novel_infrastructure::DiscussionScopeKind::Project {
        return None;
    }
    let focus: PlanningDiscussionFocus =
        serde_json::from_str(session.scope_text.as_deref()?).ok()?;
    if focus.kind != "planning-section" || focus.section_id.trim().is_empty() {
        return None;
    }
    let node_kind = match focus.section_id.as_str() {
        "preparation:outline" => Some(novel_infrastructure::PlanNodeKind::Outline),
        "preparation:opening" => Some(novel_infrastructure::PlanNodeKind::Chapter),
        _ => None,
    };
    let resolved_id = node_kind.and_then(|kind| {
        nodes
            .iter()
            .find(|node| !node.archived && node.kind == kind)
            .map(|node| format!("plan-node:{}", node.id))
    });
    let section_id = resolved_id.as_deref().unwrap_or(&focus.section_id);
    let section = sections.iter().find(|section| section.id == section_id);
    let mut content = section.map_or_else(
        || "本项尚未记录内容，允许从一个模糊想法开始。".to_owned(),
        |section| {
            format!(
                "当前记录（状态 {}）：\n{}\n\n修订草稿（尚未确认）：\n{}\n\n作者备注：\n{}",
                section.story_state.as_str(),
                section.content,
                section.pending_content,
                section.consequence,
            )
        },
    );
    if let Some(draft) = planning_draft {
        let draft = if draft.trim().is_empty() {
            "当前草稿为空。"
        } else {
            draft
        };
        content = format!(
            "作者当前正在编辑的草稿（尚未保存或确认，以此为本轮最新草稿）：\n{draft}\n\n{content}"
        );
    }
    Some((
        format!("「{}」的逐项讨论", focus.title),
        format!(
            "本次只讨论创作条目「{}」（{}）。\n{}\n\n切入问题：{}\n\n\
            与作者通过多轮交流共同完善这一项。先回应作者当前想法、顾虑或修改，必要时只追问一个最关键的问题；\
            不要求先填表、完成其他准备或确定整本书。不要每次都重写完整方案，不替作者做最终决定。\
            只有作者要求整理时，才把已认可的方向整理为可修改的定稿草案，保留尚未决定的问题。\
            已确认或锁定内容是当前依据；修订草稿和本次对话中的建议均不是已确认事实。\
            作者可以推翻先前讨论方向。讨论本身不代表确认，也不得声称已保存或已确认设定。",
            focus.title, focus.section_id, content, focus.question,
        ),
    ))
}

fn discussion_scope(
    manager: &novel_infrastructure::ProjectManager,
    session: &novel_infrastructure::DiscussionSession,
    planning_draft: Option<&str>,
) -> Result<(String, String), ApiError> {
    let nodes = manager
        .list_plan_nodes()
        .map_err(ApiError::from)?
        .into_iter()
        .filter(|node| !node.archived)
        .collect::<Vec<_>>();
    let sections = manager.list_planning_sections().map_err(ApiError::from)?;
    if let Some(scope) = planning_discussion_scope(session, &sections, planning_draft, &nodes) {
        return Ok(scope);
    }
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
        let label = if matches!(
            plan.story_state,
            novel_infrastructure::PlanningStoryState::Confirmed
                | novel_infrastructure::PlanningStoryState::Locked
        ) {
            "已确认规划（不代表正文已发生）"
        } else {
            "未确认规划记录（不是正式设定）"
        };
        match (formal.is_empty(), pending.is_empty()) {
            (false, false) => format!("{label}：{formal}\n待定候选：{pending}"),
            (false, true) => format!("{label}：{formal}"),
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
    fn selected_design_target_is_validated_and_project_settings_have_explicit_scope() {
        let json = r#"[{"entityType":"CONCEPT","name":"境界体系","description":"炼气后才能筑基。","attributes":{"境界顺序":["炼气","筑基"]},"settings":["炼气后才能筑基。"]}]"#;
        let mut entities = parse_design_entities(json).expect("parse");
        apply_design_target(&mut entities, Some(&DiscussionDesignTarget::ProjectSetting))
            .expect("scope");
        assert_eq!(entities[0].attributes["settingScope"], "PROJECT");
        assert!(
            apply_design_target(&mut entities, Some(&DiscussionDesignTarget::CharacterCard))
                .is_err()
        );
        assert!(
            DiscussionDesignTarget::CharacterCard
                .instruction()
                .contains("未知信息留白")
        );
        assert!(
            DiscussionDesignTarget::ProjectSetting
                .instruction()
                .contains("一份完整资料")
        );
    }

    #[test]
    fn context_sources_only_report_evidence_that_survived_the_prompt_budget() {
        let make = |name: &str| novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::new_v4(),
                source_revision: name.into(),
                source_hash: "sha256:test".into(),
                chunk_index: 0,
                chunking_version: "test".into(),
                content: format!("摘要「{name}」：{}", "参考内容".repeat(1_000)),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Keyword,
            authority: novel_domain::ContextAuthority::Reference,
            relevance: 900,
        };
        let context = novel_application::ContextAssembler::assemble_discussion(
            &novel_application::DiscussionContextInput {
                scope_label: "本书".into(),
                scope_content: String::new(),
                history: String::new(),
                user_message: "聊聊代价。".into(),
                input_token_budget: 4_096,
                focus: None,
            },
            &[make("summary:one"), make("summary:two")],
        )
        .expect("context");
        let summary = discussion_context_summary(&context);
        assert!(summary.contains("不代表读取全书"));
        assert!(summary.contains("上下文预算截取"));
        assert_eq!(summary.matches("摘要「").count(), 1);
    }

    #[test]
    fn preparation_discussion_resolves_the_outline_created_after_the_conversation_started() {
        let session = novel_infrastructure::DiscussionSession {
            id: uuid::Uuid::new_v4(),
            project_id: uuid::Uuid::new_v4(),
            title: "主线大纲讨论".into(),
            scope_kind: novel_infrastructure::DiscussionScopeKind::Project,
            scope_id: None,
            scope_text: Some(r#"{"kind":"planning-section","sectionId":"preparation:outline","title":"主线大纲","question":""}"#.into()),
            summary: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let (_, empty) = planning_discussion_scope(&session, &[], None, &[]).expect("uncreated");
        assert!(empty.contains("本项尚未记录内容"));
        let node = novel_infrastructure::PlanNode {
            id: uuid::Uuid::new_v4(),
            parent_id: None,
            kind: novel_infrastructure::PlanNodeKind::Outline,
            title: "主线大纲".into(),
            sort_order: 0,
            archived: false,
            revision: 1,
        };
        let section = novel_infrastructure::PlanningSection {
            id: format!("plan-node:{}", node.id),
            content: "后来确定的主线".into(),
            pending_content: String::new(),
            story_state: novel_infrastructure::PlanningStoryState::Confirmed,
            rationale: String::new(),
            consequence: String::new(),
            references: vec![],
            updated_at: String::new(),
        };
        let (_, resolved) =
            planning_discussion_scope(&session, &[section], None, &[node]).expect("resolved");
        assert!(resolved.contains("后来确定的主线"));
    }

    #[test]
    fn planning_discussion_scope_loads_current_section_without_treating_drafts_as_confirmed() {
        let session = novel_infrastructure::DiscussionSession {
            id: uuid::Uuid::new_v4(),
            project_id: uuid::Uuid::new_v4(),
            title: "故事核心讨论".into(),
            scope_kind: novel_infrastructure::DiscussionScopeKind::Project,
            scope_id: None,
            scope_text: Some(r#"{"kind":"planning-section","sectionId":"seed-premise","title":"故事核心","question":"故事从哪里开始？"}"#.into()),
            summary: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let mut sections = vec![novel_infrastructure::PlanningSection {
            id: "seed-premise".into(),
            content: "已确认的邮差".into(),
            pending_content: "尚未决定的失忆方向".into(),
            story_state: novel_infrastructure::PlanningStoryState::Confirmed,
            rationale: String::new(),
            consequence: "是否保留失忆仍待讨论".into(),
            references: vec![],
            updated_at: String::new(),
        }];
        let (label, content) =
            planning_discussion_scope(&session, &sections, None, &[]).expect("scope");
        assert!(label.contains("故事核心"));
        assert!(content.contains("已确认的邮差"));
        assert!(content.contains("修订草稿（尚未确认）：\n尚未决定的失忆方向"));
        assert!(content.contains("只追问一个最关键的问题"));
        sections[0].content = "修改后的邮差".into();
        let (_, refreshed) =
            planning_discussion_scope(&session, &sections, None, &[]).expect("fresh scope");
        assert!(refreshed.contains("修改后的邮差"));
        assert!(!refreshed.contains("已确认的邮差"));
        assert!(
            planning_discussion_scope(&session, &[], None, &[])
                .expect("empty")
                .1
                .contains("模糊想法")
        );
        let unrelated = novel_infrastructure::DiscussionSession {
            scope_text: Some("普通参考文字".into()),
            ..session
        };
        assert!(planning_discussion_scope(&unrelated, &sections, None, &[]).is_none());
        let (_, live) =
            planning_discussion_scope(&unrelated, &sections, Some("未保存的即时想法"), &[])
                .unwrap_or_default();
        assert!(!live.contains("未保存的即时想法"));
        let focused = novel_infrastructure::DiscussionSession {
            scope_text: Some(r#"{"kind":"planning-section","sectionId":"seed-premise","title":"故事核心","question":""}"#.into()),
            ..unrelated
        };
        let (_, live) =
            planning_discussion_scope(&focused, &sections, Some("未保存的即时想法"), &[])
                .expect("live");
        assert!(live.contains("以此为本轮最新草稿）：\n未保存的即时想法"));
    }

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
