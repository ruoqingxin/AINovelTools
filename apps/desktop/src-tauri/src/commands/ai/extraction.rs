use super::*;

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
            .saturating_sub(8_192)
            .saturating_sub(1_024)
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
        context.system_prompt.chars().count() + context.user_prompt.chars().count(),
    )
    .unwrap_or(u32::MAX)
    .min(input_token_budget);
    let run_id = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .start_ai_run(novel_infrastructure::AiRunStart {
                task: task_kind,
                source: novel_infrastructure::AiRunSource::KnowledgeExtraction,
                job_id: None,
                chapter_id: None,
                display_title: &format!("知识提炼 · {entity_name}"),
                profile_id: profile.id,
                prompt_version: &context.prompt_version,
                estimated_input_tokens: context.estimated_input_tokens,
            })
            .map_err(ApiError::from)?
    };
    if let Err(error) = persist_ai_run_request(
        &state,
        run_id,
        &profile,
        &context,
        false,
        false,
        generation_options,
    ) {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_run(run_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        return Err(error);
    }
    let outcome = generate_with_task_fallback(
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
    .await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Ok(mut manager) = state.manager.lock() {
                let _ = manager.fail_ai_run(run_id, &error);
            }
            return Err(ApiError::from(error));
        }
    };
    if let Some(fallback) = outcome.fallback_profile.as_ref() {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.record_ai_run_fallback(
                run_id,
                fallback.id,
                outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN"),
            );
        }
        let _ = persist_ai_run_request(
            &state,
            run_id,
            fallback,
            &context,
            false,
            false,
            generation_options,
        );
    }
    let output = outcome.output;
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
    if let Ok(entities) = serde_json::from_str(json) {
        if let Ok(mut manager) = state.manager.lock() {
            let output_tokens =
                u32::try_from(output.chars().count().div_ceil(4)).unwrap_or(u32::MAX);
            let _ = manager.complete_ai_run(run_id, outcome.usage.as_ref(), output_tokens);
        }
        Ok(entities)
    } else {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_run(run_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        Err(ApiError {
            code: "INVALID_RESPONSE",
            message: "AI 返回的提炼结果不是有效 JSON，请重试".to_owned(),
        })
    }
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub(crate) async fn extract_chapter_candidates(
    state: tauri::State<'_, ProjectState>,
    input: ExtractChapterCandidatesInput,
) -> Result<novel_infrastructure::ChapterExtractionProposal, ApiError> {
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
            message: "请选择聊天模型配置".to_owned(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }

    let revision = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let revisions = manager
            .list_manuscript_revisions(input.chapter_id)
            .map_err(ApiError::from)?;
        input
            .source_revision_id
            .map_or_else(
                || revisions.first().cloned(),
                |revision_id| {
                    revisions
                        .iter()
                        .find(|item| item.id == revision_id)
                        .cloned()
                },
            )
            .ok_or_else(|| ApiError {
                code: "NOT_FOUND",
                message: "指定的正文修订不存在".to_owned(),
            })?
    };
    let blocks = manuscript_blocks(&revision.document_json)?;
    if blocks.is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "当前正文修订没有可提取的文字".to_owned(),
        });
    }
    let block_payload = serde_json::to_string(
        &blocks
            .iter()
            .map(|block| serde_json::json!({"blockId": block.0, "text": block.1}))
            .collect::<Vec<_>>(),
    )
    .map_err(|error| ApiError::internal(error.to_string()))?;

    let task_kind = novel_infrastructure::AiTaskKind::KnowledgeExtraction;
    let task_preference = load_ai_task_preference(&state, task_kind)?;
    let generation_options =
        task_generation_options(Some(task_kind), input.temperature, input.max_output_tokens)?;
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let secret_ref = profile
        .secret_ref
        .as_deref()
        .ok_or(novel_infrastructure::AiError::MissingSecret)
        .map_err(ApiError::from)?;
    let secret = novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
    let guidance = input.user_guidance.unwrap_or_default();
    let source_text = truncate_text_to_char_budget(
        &block_payload,
        usize::try_from(input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_sub(8_192)
            .saturating_sub(1_024)
            .max(1_024),
        "\n[已按上下文预算截断正文块]",
    );
    let mut context = novel_application::ContextPackage::connection_test();
    "你是小说正文知识提取器。只提取给定正文中有明确原文证据的内容，不补写、不推断未写出的设定。"
        .clone_into(&mut context.system_prompt);
    context.user_prompt = format!(
        "请从正文块中提取值得作者审核的新角色、地点、势力、物品、概念、事实、关系、事件或伏笔。\n\
         作者补充要求：{}\n\
         输出严格 JSON 数组，不要 Markdown，不要解释。每项格式：\n\
         {{\"kind\":\"ENTITY|FACT|RELATION|EVENT|FORESHADOWING\",\"blockId\":\"原块 ID\",\"quote\":\"逐字原文片段\",\
         \"entityType\":\"CHARACTER|LOCATION|FACTION|ITEM|CONCEPT\",\"name\":\"实体名\",\
         \"aliases\":[],\"tags\":[],\"description\":\"仅依据原文的描述\",\
         \"subject\":\"事实主体\",\"predicate\":\"事实谓词\",\"object\":\"事实结论\",\
         \"relationType\":\"关系类型\",\"title\":\"事件或伏笔标题\",\
         \"occurredAt\":\"原文事件时间；未注明时写“原文未注明”\",\"status\":\"OPEN\"}}\n\
         只填写与 kind 对应的字段。RELATION 的 subject/object 只是待作者绑定的起点与终点事实线索，\
         不得编造知识 ID；EVENT 的参与者也由作者后续绑定。quote 必须逐字来自对应 block 的 text，不得改写。\n\n正文块：\n{source_text}",
        if guidance.trim().is_empty() {
            "无"
        } else {
            guidance.trim()
        }
    );
    novel_infrastructure::apply_task_prompt_preferences(
        &mut context,
        &task_preference,
        &[
            ("userGuidance", guidance.as_str()),
            ("sourceText", source_text.as_str()),
        ],
    );
    EXTRACTION_PROMPT_VERSION.clone_into(&mut context.prompt_version);
    context.estimated_input_tokens = u32::try_from(
        context.system_prompt.chars().count() + context.user_prompt.chars().count(),
    )
    .unwrap_or(u32::MAX)
    .min(input_token_budget);

    let run_id = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .start_ai_run(novel_infrastructure::AiRunStart {
                task: task_kind,
                source: novel_infrastructure::AiRunSource::KnowledgeExtraction,
                job_id: None,
                chapter_id: Some(input.chapter_id),
                display_title: "正文候选提取",
                profile_id: profile.id,
                prompt_version: EXTRACTION_PROMPT_VERSION,
                estimated_input_tokens: context.estimated_input_tokens,
            })
            .map_err(ApiError::from)?
    };
    if let Err(error) = persist_ai_run_request(
        &state,
        run_id,
        &profile,
        &context,
        false,
        false,
        generation_options,
    ) {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_run(run_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        return Err(error);
    }
    let outcome = generate_with_task_fallback(
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
    .await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Ok(mut manager) = state.manager.lock() {
                let _ = manager.fail_ai_run(run_id, &error);
            }
            return Err(ApiError::from(error));
        }
    };
    if let Some(fallback) = outcome.fallback_profile.as_ref() {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.record_ai_run_fallback(
                run_id,
                fallback.id,
                outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN"),
            );
        }
        let _ = persist_ai_run_request(
            &state,
            run_id,
            fallback,
            &context,
            false,
            false,
            generation_options,
        );
    }

    let parsed =
        parse_json_array::<ChapterExtractionAiItem>(&outcome.output).map_err(|()| ApiError {
            code: "INVALID_RESPONSE",
            message: "AI 返回的正文候选不是有效 JSON，请重试".to_owned(),
        })?;
    let proposal_id = uuid::Uuid::new_v4();
    let source_version = format!("manuscript:{}", revision.id);
    let project_id = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager.project_id().map_err(ApiError::from)?
    };
    let mut anchors = Vec::new();
    let mut items = Vec::new();
    for candidate in parsed.into_iter().take(80) {
        let Some((block_id, block_text)) = blocks
            .iter()
            .find(|(block_id, _)| block_id == &candidate.block_id)
        else {
            continue;
        };
        let Some((start_offset, end_offset)) = locate_quote(block_text, &candidate.quote) else {
            continue;
        };
        let (kind, payload) = match candidate.kind.trim().to_ascii_uppercase().as_str() {
            "ENTITY" => {
                let Some(entity_type) = candidate.entity_type else {
                    continue;
                };
                let Some(name) = candidate.name.filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                (
                    novel_infrastructure::ExtractionItemKind::Entity,
                    serde_json::json!({
                        "entityType": entity_type,
                        "name": name.trim(),
                        "aliases": candidate.aliases,
                        "tags": candidate.tags,
                        "description": candidate.description.unwrap_or_default().trim(),
                    }),
                )
            }
            "FACT" => {
                let Some(subject) = candidate.subject.filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                let Some(predicate) = candidate.predicate.filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                let Some(object) = candidate.object.filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                (
                    novel_infrastructure::ExtractionItemKind::Fact,
                    serde_json::json!({
                        "subject": subject.trim(),
                        "predicate": predicate.trim(),
                        "object": object.trim(),
                    }),
                )
            }
            "RELATION" => {
                let Some(from_hint) = candidate.subject.filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                let Some(relation_type) = candidate
                    .relation_type
                    .filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                let Some(to_hint) = candidate.object.filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                (
                    novel_infrastructure::ExtractionItemKind::Relation,
                    serde_json::json!({
                        "fromKnowledgeId": "",
                        "toKnowledgeId": "",
                        "fromHint": from_hint.trim(),
                        "toHint": to_hint.trim(),
                        "relationType": relation_type.trim(),
                    }),
                )
            }
            "EVENT" => {
                let Some(name) = candidate.title.filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                (
                    novel_infrastructure::ExtractionItemKind::Event,
                    serde_json::json!({
                        "name": name.trim(),
                        "occurredAt": candidate
                            .occurred_at
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or_else(|| "原文未注明".to_owned())
                            .trim(),
                        "participantFactIds": [],
                    }),
                )
            }
            "FORESHADOWING" => {
                let Some(title) = candidate.title.filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                (
                    novel_infrastructure::ExtractionItemKind::Foreshadowing,
                    serde_json::json!({
                        "title": title.trim(),
                        "status": candidate.status.unwrap_or_else(|| "OPEN".to_owned()),
                    }),
                )
            }
            _ => continue,
        };
        let anchor_id = uuid::Uuid::new_v4();
        anchors.push(novel_infrastructure::EvidenceAnchor {
            id: anchor_id,
            project_id,
            chapter_id: input.chapter_id,
            source_revision_id: revision.id,
            block_id: block_id.clone(),
            start_offset,
            end_offset,
            source_version: source_version.clone(),
            source_hash: revision.content_hash.clone(),
            lifecycle_status: novel_infrastructure::KnowledgeLifecycleStatus::Active,
            created_by: "ai-extraction".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        });
        items.push(novel_infrastructure::ChapterExtractionItem {
            id: uuid::Uuid::new_v4(),
            proposal_id,
            kind,
            payload,
            evidence_anchor_id: anchor_id,
            status: novel_infrastructure::ExtractionItemStatus::PendingReview,
            final_object_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        });
    }
    if items.is_empty() {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_run(run_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        return Err(ApiError {
            code: "NO_EVIDENCE",
            message: "没有识别到带逐字正文证据的候选，请调整提取要求后重试".to_owned(),
        });
    }
    let proposal = novel_infrastructure::ChapterExtractionProposal {
        id: proposal_id,
        project_id,
        chapter_id: input.chapter_id,
        source_revision_id: revision.id,
        ai_run_id: Some(run_id),
        status: novel_infrastructure::ChapterExtractionProposalStatus::PendingReview,
        items,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let proposal = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let mut proposal = proposal;
        proposal.project_id = project_id;
        for anchor in &mut anchors {
            anchor.project_id = proposal.project_id;
        }
        manager
            .create_chapter_extraction(proposal, anchors)
            .map_err(ApiError::from)?
    };
    if let Ok(mut manager) = state.manager.lock() {
        let output_tokens =
            u32::try_from(outcome.output.chars().count().div_ceil(4)).unwrap_or(u32::MAX);
        let _ = manager.complete_ai_run(run_id, outcome.usage.as_ref(), output_tokens);
    }
    Ok(proposal)
}

#[tauri::command]
pub(crate) fn list_chapter_extractions(
    state: tauri::State<'_, ProjectState>,
    chapter_id: uuid::Uuid,
) -> Result<Vec<novel_infrastructure::ChapterExtractionProposal>, ApiError> {
    let manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .list_chapter_extractions(chapter_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn update_extraction_item(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    payload: serde_json::Value,
    expected_status: novel_infrastructure::ExtractionItemStatus,
) -> Result<novel_infrastructure::ChapterExtractionItem, ApiError> {
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .update_extraction_item_payload(id, payload, expected_status)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn decide_extraction_item(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::ExtractionItemStatus,
    decision: novel_infrastructure::ExtractionItemStatus,
) -> Result<novel_infrastructure::ChapterExtractionItem, ApiError> {
    if !matches!(
        decision,
        novel_infrastructure::ExtractionItemStatus::Deferred
            | novel_infrastructure::ExtractionItemStatus::Rejected
    ) {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "请使用采用操作创建正式对象".to_owned(),
        });
    }
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .decide_extraction_item(id, expected_status, decision, None)
        .map_err(ApiError::from)
}

#[tauri::command]
pub(crate) fn adopt_extraction_item(
    state: tauri::State<'_, ProjectState>,
    id: uuid::Uuid,
    expected_status: novel_infrastructure::ExtractionItemStatus,
) -> Result<novel_infrastructure::ChapterExtractionItem, ApiError> {
    let item = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager.get_extraction_item(id).map_err(ApiError::from)?
    };
    if item.status != expected_status {
        return Err(ApiError {
            code: "VERSION_CONFLICT",
            message: "候选状态已变化，请刷新后重试".to_owned(),
        });
    }
    let anchor = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .list_evidence_anchors()
            .map_err(ApiError::from)?
            .into_iter()
            .find(|anchor| anchor.id == item.evidence_anchor_id)
            .ok_or_else(|| ApiError {
                code: "NOT_FOUND",
                message: "候选对应的正文证据不存在".to_owned(),
            })?
    };
    let adoption = match item.kind {
        novel_infrastructure::ExtractionItemKind::Entity => {
            let entity_type = item
                .payload
                .get("entityType")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_entity_type)
                .ok_or_else(|| ApiError {
                    code: "INVALID_INPUT",
                    message: "实体候选缺少有效类型".to_owned(),
                })?;
            novel_infrastructure::ExtractionAdoption::Entity(novel_infrastructure::EntityInput {
                id: None,
                entity_type,
                name: string_field(&item.payload, "name")?,
                aliases: string_array(&item.payload, "aliases"),
                description: item
                    .payload
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
                fixed_attributes_json: "{}".to_owned(),
                tags: string_array(&item.payload, "tags"),
                base_revision_id: None,
                source_version: Some(anchor.source_version.clone()),
                expected_version: None,
            })
        }
        novel_infrastructure::ExtractionItemKind::Fact => {
            let subject = string_field(&item.payload, "subject")?;
            let predicate = string_field(&item.payload, "predicate")?;
            let object = string_field(&item.payload, "object")?;
            novel_infrastructure::ExtractionAdoption::Fact(
                novel_infrastructure::KnowledgeCandidate {
                    id: uuid::Uuid::new_v4(),
                    project_id: anchor.project_id,
                    chapter_id: anchor.chapter_id,
                    proposal_id: None,
                    candidate_status: novel_infrastructure::CandidateStatus::Pending,
                    review_decision: None,
                    reviewer: None,
                    reviewed_at: None,
                    fact: novel_infrastructure::Fact {
                        knowledge_id: uuid::Uuid::new_v4(),
                        project_id: anchor.project_id,
                        knowledge_version: 1,
                        subject,
                        predicate,
                        object,
                        source_revision_id: anchor.source_revision_id,
                        evidence_anchor_ids: vec![anchor.id],
                        lifecycle_status:
                            novel_infrastructure::KnowledgeLifecycleStatus::NeedsReview,
                        created_by: "ai-extraction".to_owned(),
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                    created_at: String::new(),
                    updated_at: String::new(),
                },
            )
        }
        novel_infrastructure::ExtractionItemKind::Relation => {
            let relation_type = string_field(&item.payload, "relationType")?;
            novel_infrastructure::ExtractionAdoption::Relation(novel_infrastructure::Relation {
                id: uuid::Uuid::new_v4(),
                project_id: anchor.project_id,
                relation_version: 1,
                from_knowledge_id: uuid_field(&item.payload, "fromKnowledgeId")?,
                to_knowledge_id: uuid_field(&item.payload, "toKnowledgeId")?,
                relation_type,
                evidence_anchor_ids: vec![anchor.id],
                lifecycle_status: novel_infrastructure::KnowledgeLifecycleStatus::Active,
                created_by: "ai-extraction".to_owned(),
                created_at: String::new(),
                updated_at: String::new(),
            })
        }
        novel_infrastructure::ExtractionItemKind::Event => {
            novel_infrastructure::ExtractionAdoption::Event(novel_infrastructure::Event {
                id: uuid::Uuid::new_v4(),
                project_id: anchor.project_id,
                event_version: 1,
                name: string_field(&item.payload, "name")?,
                occurred_at: string_field(&item.payload, "occurredAt")?,
                participant_fact_ids: uuid_array(&item.payload, "participantFactIds")?,
                evidence_anchor_ids: vec![anchor.id],
                lifecycle_status: novel_infrastructure::KnowledgeLifecycleStatus::Active,
                created_by: "ai-extraction".to_owned(),
                created_at: String::new(),
                updated_at: String::new(),
            })
        }
        novel_infrastructure::ExtractionItemKind::Foreshadowing => {
            let title = string_field(&item.payload, "title")?;
            novel_infrastructure::ExtractionAdoption::Foreshadowing(
                novel_infrastructure::Foreshadowing {
                    id: uuid::Uuid::new_v4(),
                    project_id: anchor.project_id,
                    foreshadowing_version: 1,
                    title,
                    target_chapter_id: None,
                    status: item
                        .payload
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("OPEN")
                        .to_owned(),
                    evidence_anchor_ids: vec![anchor.id],
                    lifecycle_status: novel_infrastructure::KnowledgeLifecycleStatus::Active,
                    created_by: "ai-extraction".to_owned(),
                    created_at: String::new(),
                    updated_at: String::new(),
                },
            )
        }
    };
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| ApiError::internal("project mutex poisoned"))?;
    manager
        .adopt_extraction_item(id, expected_status, adoption)
        .map_err(ApiError::from)
}

fn string_field(payload: &serde_json::Value, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ApiError {
            code: "INVALID_INPUT",
            message: format!("候选缺少必填字段：{key}"),
        })
}

fn string_array(payload: &serde_json::Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn uuid_field(payload: &serde_json::Value, key: &str) -> Result<uuid::Uuid, ApiError> {
    let value = string_field(payload, key)?;
    uuid::Uuid::parse_str(&value).map_err(|_| ApiError {
        code: "INVALID_INPUT",
        message: format!("候选字段 {key} 不是有效 ID"),
    })
}

fn uuid_array(payload: &serde_json::Value, key: &str) -> Result<Vec<uuid::Uuid>, ApiError> {
    let Some(items) = payload.get(key).and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .map(|value| {
            value
                .as_str()
                .and_then(|value| uuid::Uuid::parse_str(value).ok())
                .ok_or_else(|| ApiError {
                    code: "INVALID_INPUT",
                    message: format!("候选字段 {key} 包含无效 ID"),
                })
        })
        .collect()
}

fn parse_entity_type(value: &str) -> Option<novel_infrastructure::EntityType> {
    match value {
        "CHARACTER" => Some(novel_infrastructure::EntityType::Character),
        "LOCATION" => Some(novel_infrastructure::EntityType::Location),
        "FACTION" => Some(novel_infrastructure::EntityType::Faction),
        "ITEM" => Some(novel_infrastructure::EntityType::Item),
        "CONCEPT" => Some(novel_infrastructure::EntityType::Concept),
        _ => None,
    }
}

fn parse_json_array<T: serde::de::DeserializeOwned>(output: &str) -> Result<Vec<T>, ()> {
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
    serde_json::from_str(json).map_err(|_| ())
}

pub(crate) fn manuscript_blocks(document_json: &str) -> Result<Vec<(String, String)>, ApiError> {
    let document: serde_json::Value =
        serde_json::from_str(document_json).map_err(|_| ApiError {
            code: "INVALID_DOCUMENT",
            message: "正文文档不是有效 JSON".to_owned(),
        })?;
    let mut blocks = Vec::new();
    for (index, node) in document
        .get("content")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = node
            .get("attrs")
            .and_then(|attrs| attrs.get("blockId"))
            .and_then(serde_json::Value::as_str)
            .map_or_else(|| format!("block-{index}"), ToOwned::to_owned);
        let mut text = String::new();
        collect_node_text(node, &mut text);
        if !text.trim().is_empty() {
            blocks.push((id, text));
        }
    }
    Ok(blocks)
}

fn collect_node_text(node: &serde_json::Value, output: &mut String) {
    if let Some(text) = node.get("text").and_then(serde_json::Value::as_str) {
        output.push_str(text);
    }
    if let Some(content) = node.get("content").and_then(serde_json::Value::as_array) {
        for child in content {
            collect_node_text(child, output);
        }
    }
}

pub(crate) fn locate_quote(text: &str, quote: &str) -> Option<(u32, u32)> {
    let quote = quote.trim();
    if quote.is_empty() {
        return None;
    }
    let byte_start = text.find(quote)?;
    let start = u32::try_from(text[..byte_start].chars().count()).ok()?;
    let end = start.checked_add(u32::try_from(quote.chars().count()).ok()?)?;
    (end > start).then_some((start, end))
}

pub(crate) fn sync_model_profile(
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
            input_price_micros_per_million: profile.input_price_micros_per_million,
            output_price_micros_per_million: profile.output_price_micros_per_million,
            price_currency: profile.price_currency.clone(),
        })
        .map_err(ApiError::from)?;
    manager
        .set_model_profile_secret_ref(profile.id, profile.secret_ref.as_deref())
        .map_err(ApiError::from)?;
    Ok(())
}
