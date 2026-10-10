mod codec;

use super::generation::ProposalGenerationInput;
use super::{
    AiStreamChunk, AiTaskAttempt, AiTaskStarted, ApiError, Arc, AtomicBool, Emitter, HashSet,
    ProjectState, effective_max_output_tokens, effective_task_input_budget,
    generate_with_task_fallback, load_ai_task_preference, normalized_document_json,
    persist_ai_run_request, sync_model_profile, task_generation_options,
    truncate_text_to_char_budget,
};
use codec::{
    chapter_contract_review_items, merge_review_findings, parse_review_claims,
    parse_semantic_review, review_report_json, review_target_blocks, review_verdict,
};

fn review_stage_request(
    stage: novel_infrastructure::ReviewStage,
    profile: &novel_infrastructure::ModelProfile,
    context: &novel_application::ContextPackage,
    output: Option<&str>,
    parse_result: impl Into<String>,
    fallback_reason: Option<&str>,
) -> novel_infrastructure::ReviewStageRequest {
    novel_infrastructure::ReviewStageRequest {
        stage,
        profile_id: Some(profile.id),
        model_id: Some(profile.model_id.clone()),
        request_context_version: context.context_version.clone(),
        request_snapshot: Some(format!(
            "SYSTEM:\n{}\n\nUSER:\n{}",
            context.system_prompt, context.user_prompt
        )),
        response_preview: output
            .map(|value| truncate_text_to_char_budget(value, 2_000, "\n[已截断]")),
        parse_result: parse_result.into(),
        fallback_reason: fallback_reason.map(ToOwned::to_owned),
    }
}

fn review_locked_rules(manager: &novel_infrastructure::ProjectManager) -> String {
    let sections = manager.list_planning_sections().unwrap_or_default();
    let mut output = sections
        .into_iter()
        .filter(|section| {
            matches!(
                section.story_state,
                novel_infrastructure::PlanningStoryState::Confirmed
                    | novel_infrastructure::PlanningStoryState::Locked
            ) && !section.content.trim().is_empty()
        })
        .map(|section| format!("[{}] {}", section.id, section.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    if output.chars().count() > 12_000 {
        output = truncate_text_to_char_budget(&output, 12_000, "\n[锁定规则已按预算截断]");
    }
    output
}

fn clear_review_cancellation(state: &ProjectState, task_id: uuid::Uuid) {
    if let Ok(mut cancellations) = state.ai_cancellations.lock() {
        cancellations.remove(&task_id);
    }
}

#[allow(clippy::too_many_lines)]
pub(super) async fn generate_consistency_review_proposal(
    app: tauri::AppHandle,
    state: &ProjectState,
    input: ProposalGenerationInput,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    let ProposalGenerationInput {
        profile_id,
        chapter_id,
        review_purpose,
        chapter_title,
        chapter_plan,
        volume_plan,
        document_json,
        stream,
        temperature,
        max_output_tokens,
        ..
    } = input;
    let review_purpose = review_purpose.unwrap_or(novel_infrastructure::ReviewPurpose::Admission);
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
            message: "请选择聊天模型配置。".to_owned(),
        });
    }
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let target_revision_id = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?
            .map(|value| value.id)
    };
    let task_kind = novel_infrastructure::AiTaskKind::ConsistencyReview;
    let task_preference = load_ai_task_preference(state, task_kind)?;
    let generation_options =
        task_generation_options(Some(task_kind), temperature, max_output_tokens)?;
    let max_output_tokens = effective_max_output_tokens(&profile, generation_options);
    let input_token_budget =
        effective_task_input_budget(&profile, max_output_tokens, &task_preference);
    let normalized_document_json = normalized_document_json(document_json);
    let blocks = review_target_blocks(
        review_purpose,
        &chapter_plan,
        &volume_plan,
        &normalized_document_json,
    )?;
    let (locked_rules, chapter_contract) = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        let chapter_contract = manager
            .chapter_contract(chapter_id)
            .map_err(ApiError::from)?;
        (review_locked_rules(&manager), chapter_contract)
    };
    let extraction_input = novel_application::ReviewClaimExtractionInput {
        review_purpose,
        chapter_id,
        target_revision_id,
        chapter_title: chapter_title.clone(),
        blocks: blocks.clone(),
        locked_rules: locked_rules.clone(),
        input_token_budget,
    };
    let extraction_context = novel_application::ReviewScopeBuilder::claim_extraction(
        &extraction_input,
    )
    .map_err(|error| ApiError {
        code: "INVALID_INPUT",
        message: error.to_string(),
    })?;
    let secret_ref = profile
        .secret_ref
        .as_deref()
        .ok_or(novel_infrastructure::AiError::MissingSecret)
        .map_err(ApiError::from)?;
    let mut active_secret =
        novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
    let task_id = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        sync_model_profile(&mut manager, &profile)?;
        manager
            .create_ai_task(profile_id, &extraction_context, Some(review_purpose))
            .map_err(ApiError::from)?
    };
    if let Err(error) = persist_ai_run_request(
        state,
        task_id,
        &profile,
        &extraction_context,
        stream,
        true,
        generation_options,
    ) {
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_task(task_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        return Err(error);
    }
    let _ = app.emit("ai-task-started", AiTaskStarted { task_id });
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .ai_cancellations
        .lock()
        .map_err(|_| ApiError::internal("AI cancellation mutex poisoned"))?
        .insert(task_id, Arc::clone(&cancelled));
    let claim_outcome = generate_with_task_fallback(
        state,
        &task_preference,
        &profile,
        Some(&active_secret),
        &extraction_context,
        generation_options,
        stream,
        true,
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
    let claim_outcome = match claim_outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Ok(mut manager) = state.manager.lock() {
                let _ = manager.fail_ai_task(task_id, &error);
            }
            clear_review_cancellation(state, task_id);
            return Err(ApiError::from(error));
        }
    };
    let mut active_profile = profile.clone();
    let mut fallback_recorded = false;
    let mut stage_requests = vec![review_stage_request(
        novel_infrastructure::ReviewStage::ClaimExtraction,
        claim_outcome.fallback_profile.as_ref().unwrap_or(&profile),
        &extraction_context,
        Some(&claim_outcome.output),
        "PENDING",
        claim_outcome.fallback_reason.as_deref(),
    )];
    if let Some(fallback) = claim_outcome.fallback_profile.clone() {
        active_profile = fallback.clone();
        if let Some(secret_ref) = active_profile.secret_ref.as_deref() {
            active_secret =
                novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
        }
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.record_ai_task_fallback(
                task_id,
                active_profile.id,
                claim_outcome
                    .fallback_reason
                    .as_deref()
                    .unwrap_or("UNKNOWN"),
            );
            fallback_recorded = true;
        }
        let _ = app.emit(
            "ai-task-attempt",
            AiTaskAttempt {
                task_id,
                attempt: 2,
                profile_name: active_profile.name.clone(),
                fallback_reason: claim_outcome.fallback_reason.clone(),
            },
        );
    }
    let Ok((mut claims, mut omitted_items)) =
        parse_review_claims(review_purpose, &claim_outcome.output, &blocks)
    else {
        "INVALID_JSON".clone_into(&mut stage_requests[0].parse_result);
        if let Ok(mut manager) = state.manager.lock() {
            let _ = manager.fail_ai_task(task_id, &novel_infrastructure::AiError::InvalidResponse);
        }
        clear_review_cancellation(state, task_id);
        return Err(ApiError {
            code: "INVALID_RESPONSE",
            message: "声明提取阶段没有返回有效的固定 JSON。".to_owned(),
        });
    };
    stage_requests[0].parse_result = format!("EXTRACTED_{}", claims.len());
    if claims.len() > 80 {
        omitted_items.push(novel_infrastructure::ReviewOmittedItem {
            item_type: "CLAIM".to_owned(),
            label: "声明总量".to_owned(),
            reason: format!(
                "为保证单次审核可控，仅复核前 80 条高优先声明，另有 {} 条未复核。",
                claims.len() - 80
            ),
            claim_id: None,
        });
        claims.sort_by(|left, right| {
            right
                .importance
                .cmp(&left.importance)
                .then_with(|| right.confidence.cmp(&left.confidence))
        });
        claims.truncate(80);
    }
    let (mut evidence, evidence_omitted) = {
        let manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        manager
            .resolve_review_evidence(chapter_id, &claims, &locked_rules)
            .map_err(ApiError::from)?
    };
    omitted_items.extend(evidence_omitted);
    if let Some(contract) = chapter_contract
        .as_ref()
        .filter(|contract| contract.confirmed)
    {
        let (contract_claims, contract_evidence) = chapter_contract_review_items(contract);
        claims.extend(contract_claims);
        evidence.extend(contract_evidence);
    }
    let target_text = blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let deterministic_findings = novel_infrastructure::DeterministicReviewEvaluator::evaluate(
        &novel_infrastructure::DeterministicReviewInput {
            review_purpose,
            claims: &claims,
            evidence: &evidence,
            locked_rules: &locked_rules,
            target_text: &target_text,
            chapter_contract: chapter_contract.as_ref(),
        },
    );
    stage_requests.push(novel_infrastructure::ReviewStageRequest {
        stage: novel_infrastructure::ReviewStage::DeterministicRules,
        profile_id: None,
        model_id: None,
        request_context_version: extraction_context.context_version.clone(),
        request_snapshot: None,
        response_preview: None,
        parse_result: format!("MATCHED_{}", deterministic_findings.len()),
        fallback_reason: None,
    });
    let mut model_findings = Vec::new();
    let mut summaries = Vec::new();
    for batch in claims.chunks(8) {
        let batch_ids = batch.iter().map(|claim| claim.id).collect::<HashSet<_>>();
        let batch_evidence = evidence
            .iter()
            .filter(|item| batch_ids.contains(&item.claim_id))
            .cloned()
            .collect::<Vec<_>>();
        let semantic_input = novel_application::ReviewSemanticInput {
            review_purpose,
            chapter_id,
            target_revision_id,
            claims: batch.to_vec(),
            evidence: batch_evidence.clone(),
            input_token_budget,
        };
        let semantic_context = novel_application::ReviewScopeBuilder::semantic_review(
            &semantic_input,
        )
        .map_err(|error| ApiError {
            code: "INVALID_INPUT",
            message: error.to_string(),
        })?;
        let outcome = generate_with_task_fallback(
            state,
            &task_preference,
            &active_profile,
            Some(&active_secret),
            &semantic_context,
            generation_options,
            false,
            true,
            Arc::clone(&cancelled),
            |_| {},
        )
        .await;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                stage_requests.push(review_stage_request(
                    novel_infrastructure::ReviewStage::SemanticReview,
                    &active_profile,
                    &semantic_context,
                    None,
                    format!("FAILED:{}", error.code()),
                    Some(error.code()),
                ));
                if matches!(error, novel_infrastructure::AiError::Cancelled) {
                    if let Ok(mut manager) = state.manager.lock() {
                        let _ = manager.fail_ai_task(task_id, &error);
                    }
                    clear_review_cancellation(state, task_id);
                    return Err(ApiError::from(error));
                }
                for claim in batch {
                    model_findings.push(novel_infrastructure::ReviewFinding {
                        id: uuid::Uuid::new_v4(),
                        claim_id: claim.id,
                        status: novel_infrastructure::ReviewStatus::Unknown,
                        severity: "INFO".to_owned(),
                        source_kind: novel_infrastructure::FindingSource::Llm,
                        rule_id: None,
                        rule_version: None,
                        rule_scope: None,
                        rule_effective_at: None,
                        priority: claim.importance,
                        problem: "语义复核批次调用失败，保留为待确认。".to_owned(),
                        evidence_ids: batch_evidence.iter().map(|item| item.id).collect(),
                        suggestion: "检查模型连接后重新审核。".to_owned(),
                        confidence: 0,
                    });
                }
                omitted_items.push(novel_infrastructure::ReviewOmittedItem {
                    item_type: "BATCH".to_owned(),
                    label: format!("{} 条声明", batch.len()),
                    reason: format!("语义复核调用失败：{}。", error.code()),
                    claim_id: None,
                });
                continue;
            }
        };
        if let Some(fallback) = outcome.fallback_profile.clone() {
            active_profile = fallback.clone();
            if let Some(secret_ref) = active_profile.secret_ref.as_deref() {
                active_secret =
                    novel_infrastructure::SecretStore::get(secret_ref).map_err(ApiError::from)?;
            }
            if !fallback_recorded && let Ok(mut manager) = state.manager.lock() {
                let _ = manager.record_ai_task_fallback(
                    task_id,
                    active_profile.id,
                    outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN"),
                );
                fallback_recorded = true;
            }
            let _ = app.emit(
                "ai-task-attempt",
                AiTaskAttempt {
                    task_id,
                    attempt: 2,
                    profile_name: active_profile.name.clone(),
                    fallback_reason: outcome.fallback_reason.clone(),
                },
            );
        }
        let parsed = parse_semantic_review(&outcome.output, batch, &batch_evidence);
        let Ok((summary, findings, semantic_omitted)) = parsed else {
            stage_requests.push(review_stage_request(
                novel_infrastructure::ReviewStage::SemanticReview,
                &active_profile,
                &semantic_context,
                Some(&outcome.output),
                "INVALID_JSON",
                outcome.fallback_reason.as_deref(),
            ));
            for claim in batch {
                model_findings.push(novel_infrastructure::ReviewFinding {
                    id: uuid::Uuid::new_v4(),
                    claim_id: claim.id,
                    status: novel_infrastructure::ReviewStatus::Unknown,
                    severity: "INFO".to_owned(),
                    source_kind: novel_infrastructure::FindingSource::Llm,
                    rule_id: None,
                    rule_version: None,
                    rule_scope: None,
                    rule_effective_at: None,
                    priority: claim.importance,
                    problem: "语义复核没有返回可解析的固定 JSON，保留为待确认。".to_owned(),
                    evidence_ids: batch_evidence.iter().map(|item| item.id).collect(),
                    suggestion: "重试审核；若持续失败，请减少单次审核内容。".to_owned(),
                    confidence: 0,
                });
            }
            omitted_items.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "BATCH".to_owned(),
                label: format!("{} 条声明", batch.len()),
                reason: "语义复核返回的固定 JSON 无法解析。".to_owned(),
                claim_id: None,
            });
            continue;
        };
        summaries.push(summary);
        model_findings.extend(findings);
        omitted_items.extend(semantic_omitted);
        stage_requests.push(review_stage_request(
            novel_infrastructure::ReviewStage::SemanticReview,
            &active_profile,
            &semantic_context,
            Some(&outcome.output),
            format!("PARSED_{}", batch.len()),
            outcome.fallback_reason.as_deref(),
        ));
    }
    let merged_findings = merge_review_findings(&deterministic_findings, &model_findings);
    let verdict = if claims.is_empty() {
        novel_infrastructure::AiConsistencyVerdict::NeedsInput
    } else {
        review_verdict(&merged_findings)
    };
    let summary = if claims.is_empty() {
        "没有提取到可逐字定位的事实声明，当前无法完成一致性裁决。".to_owned()
    } else {
        summaries
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let report_json = review_report_json(
        &summary,
        verdict,
        &merged_findings,
        &evidence,
        &omitted_items,
    )?;
    let trace = novel_infrastructure::ReviewTrace {
        run_id: task_id,
        review_purpose,
        chapter_id,
        target_revision_id,
        context_version: extraction_context.context_version.clone(),
        claims,
        evidence,
        deterministic_findings,
        model_findings,
        omitted_items,
        stage_requests,
    };
    let proposal = {
        let mut manager = state
            .manager
            .lock()
            .map_err(|_| ApiError::internal("project mutex poisoned"))?;
        if let Err(error) = manager.save_ai_review_trace(&trace) {
            let _ = manager.fail_ai_task(task_id, &novel_infrastructure::AiError::InvalidResponse);
            clear_review_cancellation(state, task_id);
            return Err(ApiError::from(error));
        }
        manager
            .complete_ai_task(task_id, &extraction_context, report_json, None)
            .map_err(ApiError::from)?
    };
    clear_review_cancellation(state, task_id);
    Ok(proposal)
}
