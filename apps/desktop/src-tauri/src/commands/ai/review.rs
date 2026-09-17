use super::*;

fn parse_json_object<T: serde::de::DeserializeOwned>(output: &str) -> Result<T, ()> {
    let cleaned = output
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json = cleaned
        .find('{')
        .and_then(|start| cleaned.rfind('}').map(|end| &cleaned[start..=end]))
        .unwrap_or(cleaned);
    serde_json::from_str(json).map_err(|_| ())
}

fn parse_review_claims(
    purpose: novel_infrastructure::ReviewPurpose,
    output: &str,
    blocks: &[novel_application::ReviewSourceBlock],
) -> Result<
    (
        Vec<novel_infrastructure::ReviewClaim>,
        Vec<novel_infrastructure::ReviewOmittedItem>,
    ),
    (),
> {
    let response: ReviewClaimExtractionResponse = parse_json_object(output)?;
    let mut claims = Vec::new();
    let mut omitted = Vec::new();
    let mut seen = HashSet::new();
    for candidate in response.claims {
        let claim_type = novel_infrastructure::ReviewClaimType::parse(&candidate.claim_type);
        let Some(claim_type) = claim_type else {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: candidate.quote.clone(),
                reason: "声明类型不在当前审核用途允许的第一版范围内。".to_owned(),
                claim_id: None,
            });
            continue;
        };
        if !claim_type.supports(purpose) {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: candidate.quote.clone(),
                reason: "声明类型不属于当前审核用途。".to_owned(),
                claim_id: None,
            });
            continue;
        }
        let Some(block) = blocks
            .iter()
            .find(|block| block.block_id == candidate.block_id)
        else {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: candidate.quote.clone(),
                reason: format!("找不到对应正文块：{}。", candidate.block_id),
                claim_id: None,
            });
            continue;
        };
        let Some((start_offset, end_offset)) = locate_quote(&block.text, &candidate.quote) else {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: candidate.quote.clone(),
                reason: "quote 无法在对应正文块中逐字定位。".to_owned(),
                claim_id: None,
            });
            continue;
        };
        let subject = candidate.subject.trim();
        let predicate = candidate.predicate.trim();
        let object = candidate.object.trim();
        if subject.is_empty() || predicate.is_empty() || object.is_empty() {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: candidate.quote.clone(),
                reason: "主体、谓词或结论为空。".to_owned(),
                claim_id: None,
            });
            continue;
        }
        let dedupe_key = format!(
            "{}:{}:{}:{}:{}",
            claim_type as u8,
            subject.to_lowercase(),
            predicate.to_lowercase(),
            object.to_lowercase(),
            candidate.block_id
        );
        if !seen.insert(dedupe_key) {
            continue;
        }
        claims.push(novel_infrastructure::ReviewClaim {
            id: uuid::Uuid::new_v4(),
            claim_type,
            subject: subject.to_owned(),
            predicate: predicate.to_owned(),
            object: object.to_owned(),
            quote: candidate.quote.trim().to_owned(),
            block_id: candidate.block_id,
            start_offset,
            end_offset,
            importance: candidate.importance.clamp(1, 5),
            confidence: candidate.confidence.min(100),
        });
        if claims.len() >= 120 {
            break;
        }
    }
    Ok((claims, omitted))
}

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

fn parse_semantic_review(
    output: &str,
    claims: &[novel_infrastructure::ReviewClaim],
    evidence: &[novel_infrastructure::ReviewEvidence],
) -> Result<
    (
        String,
        Vec<novel_infrastructure::ReviewFinding>,
        Vec<novel_infrastructure::ReviewOmittedItem>,
    ),
    (),
> {
    let response: SemanticReviewResponse = parse_json_object(output)?;
    let claim_ids = claims.iter().map(|claim| claim.id).collect::<HashSet<_>>();
    let evidence_by_id = evidence
        .iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let evidence_by_claim = evidence.iter().fold(
        HashMap::<uuid::Uuid, HashSet<uuid::Uuid>>::new(),
        |mut map, item| {
            map.entry(item.claim_id).or_default().insert(item.id);
            map
        },
    );
    let mut findings = Vec::new();
    let mut omitted = response
        .omitted
        .into_iter()
        .map(|item| novel_infrastructure::ReviewOmittedItem {
            item_type: "MODEL_OMISSION".to_owned(),
            label: if item.label.trim().is_empty() {
                "模型未说明".to_owned()
            } else {
                item.label
            },
            reason: if item.reason.trim().is_empty() {
                "模型未提供原因。".to_owned()
            } else {
                item.reason
            },
            claim_id: None,
        })
        .collect::<Vec<_>>();
    let mut seen_claim_ids = HashSet::new();
    for candidate in response.findings {
        let Ok(claim_id) = uuid::Uuid::parse_str(&candidate.claim_id) else {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "FINDING".to_owned(),
                label: candidate.problem,
                reason: "finding.claimId 不是有效 UUID。".to_owned(),
                claim_id: None,
            });
            continue;
        };
        if !claim_ids.contains(&claim_id) || !seen_claim_ids.insert(claim_id) {
            omitted.push(novel_infrastructure::ReviewOmittedItem {
                item_type: "FINDING".to_owned(),
                label: candidate.problem,
                reason: "finding.claimId 不属于当前批次或重复。".to_owned(),
                claim_id: Some(claim_id),
            });
            continue;
        }
        let allowed_evidence = evidence_by_claim.get(&claim_id);
        let evidence_ids = candidate
            .evidence_ids
            .iter()
            .filter_map(|value| uuid::Uuid::parse_str(value).ok())
            .filter(|id| {
                allowed_evidence.is_some_and(|allowed| allowed.contains(id))
                    && evidence_by_id.contains_key(id)
            })
            .collect::<Vec<_>>();
        let mut status = parse_review_status(&candidate.status);
        let mut problem = candidate.problem.trim().to_owned();
        if evidence_ids.is_empty() {
            status = novel_infrastructure::ReviewStatus::Unknown;
            if !problem.is_empty() {
                problem.push(' ');
            }
            problem.push_str("（没有正式证据，已按 UNKNOWN 处理。）");
        }
        findings.push(novel_infrastructure::ReviewFinding {
            id: uuid::Uuid::new_v4(),
            claim_id,
            status,
            severity: normalize_review_severity(&candidate.severity).to_owned(),
            source_kind: novel_infrastructure::FindingSource::Llm,
            rule_id: None,
            rule_version: None,
            rule_scope: None,
            rule_effective_at: None,
            priority: claim_priority(claim_id, claims),
            problem: if problem.is_empty() {
                "模型未提供问题说明。".to_owned()
            } else {
                problem
            },
            evidence_ids,
            suggestion: candidate.suggestion.trim().to_owned(),
            confidence: candidate.confidence.min(100),
        });
    }
    for claim in claims {
        if !seen_claim_ids.contains(&claim.id) {
            findings.push(novel_infrastructure::ReviewFinding {
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
                problem: "语义复核没有返回这条声明的结论，保留为待确认。".to_owned(),
                evidence_ids: evidence
                    .iter()
                    .filter(|item| item.claim_id == claim.id)
                    .map(|item| item.id)
                    .collect(),
                suggestion: "补充正式依据后重新审核。".to_owned(),
                confidence: 0,
            });
        }
    }
    Ok((response.summary.trim().to_owned(), findings, omitted))
}

fn claim_priority(claim_id: uuid::Uuid, claims: &[novel_infrastructure::ReviewClaim]) -> u8 {
    claims
        .iter()
        .find(|claim| claim.id == claim_id)
        .map_or(3, |claim| claim.importance)
}

fn parse_review_status(value: &str) -> novel_infrastructure::ReviewStatus {
    match value.trim().to_ascii_uppercase().as_str() {
        "PASS" => novel_infrastructure::ReviewStatus::Pass,
        "NOTICE" => novel_infrastructure::ReviewStatus::Notice,
        "WARNING" => novel_infrastructure::ReviewStatus::Warning,
        "BLOCK" => novel_infrastructure::ReviewStatus::Block,
        _ => novel_infrastructure::ReviewStatus::Unknown,
    }
}

fn normalize_review_severity(value: &str) -> &'static str {
    match value.trim().to_ascii_uppercase().as_str() {
        "BLOCKER" => "BLOCKER",
        "MAJOR" => "MAJOR",
        "MINOR" => "MINOR",
        _ => "INFO",
    }
}

fn review_target_blocks(
    purpose: novel_infrastructure::ReviewPurpose,
    chapter_plan: &str,
    volume_plan: &str,
    document_json: &str,
) -> Result<Vec<novel_application::ReviewSourceBlock>, ApiError> {
    if purpose == novel_infrastructure::ReviewPurpose::Manuscript {
        let blocks = manuscript_blocks(document_json)?
            .into_iter()
            .map(|(block_id, text)| novel_application::ReviewSourceBlock { block_id, text })
            .collect::<Vec<_>>();
        if blocks.is_empty() {
            return Err(ApiError {
                code: "INVALID_INPUT",
                message: "当前正文没有可审核的文字块。".to_owned(),
            });
        }
        return Ok(blocks);
    }
    let mut blocks = Vec::new();
    if !chapter_plan.trim().is_empty() {
        blocks.push(novel_application::ReviewSourceBlock {
            block_id: "chapter-plan".to_owned(),
            text: chapter_plan.trim().to_owned(),
        });
    }
    if !volume_plan.trim().is_empty() {
        blocks.push(novel_application::ReviewSourceBlock {
            block_id: "volume-plan".to_owned(),
            text: volume_plan.trim().to_owned(),
        });
    }
    if blocks.is_empty() {
        return Err(ApiError {
            code: "INVALID_INPUT",
            message: "请先填写章节执行卡或分卷阶段约束。".to_owned(),
        });
    }
    Ok(blocks)
}

fn chapter_contract_review_items(
    contract: &novel_infrastructure::ChapterContract,
) -> (
    Vec<novel_infrastructure::ReviewClaim>,
    Vec<novel_infrastructure::ReviewEvidence>,
) {
    let mut claims = Vec::new();
    let mut evidence = Vec::new();
    let mut append = |claim_type, predicate: &str, value: &str| {
        let claim = novel_infrastructure::ReviewClaim {
            id: uuid::Uuid::new_v4(),
            claim_type,
            subject: "章节合同".to_owned(),
            predicate: predicate.to_owned(),
            object: value.to_owned(),
            quote: value.to_owned(),
            block_id: "chapter-contract".to_owned(),
            start_offset: 0,
            end_offset: u32::try_from(value.chars().count()).unwrap_or(u32::MAX),
            importance: 5,
            confidence: 100,
        };
        evidence.push(novel_infrastructure::ReviewEvidence {
            id: uuid::Uuid::new_v4(),
            claim_id: claim.id,
            source_kind: novel_infrastructure::ReviewEvidenceSource::ChapterContract,
            source_record_id: uuid::Uuid::nil(),
            authority: novel_infrastructure::EvidenceAuthority::ChapterContract,
            excerpt: format!("{predicate}：{value}"),
            source_revision: contract.source_revision.clone(),
            relevance: 10_000,
        });
        claims.push(claim);
    };
    for value in &contract.required_events {
        append(
            novel_infrastructure::ReviewClaimType::RequiredEvent,
            "必须事件",
            value,
        );
    }
    for value in &contract.forbidden_events {
        append(
            novel_infrastructure::ReviewClaimType::ForbiddenEvent,
            "禁止事件",
            value,
        );
    }
    for value in &contract.allowed_characters {
        append(
            novel_infrastructure::ReviewClaimType::AllowedCharacter,
            "允许人物",
            value,
        );
    }
    for value in &contract.time_windows {
        append(
            novel_infrastructure::ReviewClaimType::TimeWindow,
            "时间窗口",
            value,
        );
    }
    for value in &contract.stage_boundaries {
        append(
            novel_infrastructure::ReviewClaimType::StageBoundary,
            "阶段边界",
            value,
        );
    }
    (claims, evidence)
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

fn review_finding_to_report(
    finding: &novel_infrastructure::ReviewFinding,
    evidence: &HashMap<uuid::Uuid, &novel_infrastructure::ReviewEvidence>,
) -> novel_infrastructure::AiConsistencyFinding {
    let evidence_text = finding
        .evidence_ids
        .iter()
        .filter_map(|id| evidence.get(id))
        .map(|item| {
            format!(
                "[{} · {:?}] {}",
                item.source_kind.as_str(),
                item.authority,
                item.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    novel_infrastructure::AiConsistencyFinding {
        severity: match finding.severity.as_str() {
            "BLOCKER" => novel_infrastructure::AiConsistencySeverity::Blocker,
            "MAJOR" => novel_infrastructure::AiConsistencySeverity::Major,
            "MINOR" => novel_infrastructure::AiConsistencySeverity::Minor,
            _ => novel_infrastructure::AiConsistencySeverity::Info,
        },
        problem: finding.problem.clone(),
        evidence: if evidence_text.is_empty() {
            "没有找到可引用的正式证据。".to_owned()
        } else {
            evidence_text
        },
        suggestion: if finding.suggestion.trim().is_empty() {
            "补充对应正式依据后重新审核。".to_owned()
        } else {
            finding.suggestion.clone()
        },
    }
}

fn review_verdict(
    findings: &[novel_infrastructure::ReviewFinding],
) -> novel_infrastructure::AiConsistencyVerdict {
    if findings
        .iter()
        .any(|finding| finding.status == novel_infrastructure::ReviewStatus::Block)
    {
        return novel_infrastructure::AiConsistencyVerdict::Blocked;
    }
    if findings
        .iter()
        .any(|finding| finding.status == novel_infrastructure::ReviewStatus::Warning)
    {
        return novel_infrastructure::AiConsistencyVerdict::Review;
    }
    if findings
        .iter()
        .any(|finding| finding.status == novel_infrastructure::ReviewStatus::Unknown)
    {
        return novel_infrastructure::AiConsistencyVerdict::NeedsInput;
    }
    novel_infrastructure::AiConsistencyVerdict::Pass
}

fn review_status_rank(status: novel_infrastructure::ReviewStatus) -> u8 {
    match status {
        novel_infrastructure::ReviewStatus::Pass => 0,
        novel_infrastructure::ReviewStatus::Notice => 1,
        novel_infrastructure::ReviewStatus::Unknown => 2,
        novel_infrastructure::ReviewStatus::Warning => 3,
        novel_infrastructure::ReviewStatus::Block => 4,
    }
}

fn merge_review_findings(
    deterministic_findings: &[novel_infrastructure::ReviewFinding],
    model_findings: &[novel_infrastructure::ReviewFinding],
) -> Vec<novel_infrastructure::ReviewFinding> {
    let mut merged = deterministic_findings.to_vec();
    let mut seen = deterministic_findings
        .iter()
        .map(|finding| {
            (
                finding.claim_id,
                finding.rule_id.clone().unwrap_or_default(),
                finding.problem.trim().to_owned(),
            )
        })
        .collect::<HashSet<_>>();
    for finding in model_findings {
        let overridden_by_rule = deterministic_findings.iter().any(|rule_finding| {
            rule_finding.claim_id == finding.claim_id
                && review_status_rank(rule_finding.status) > review_status_rank(finding.status)
        });
        if overridden_by_rule {
            continue;
        }
        let key = (
            finding.claim_id,
            finding.rule_id.clone().unwrap_or_default(),
            finding.problem.trim().to_owned(),
        );
        if seen.insert(key) {
            merged.push(finding.clone());
        }
    }
    merged.sort_by(|left, right| {
        review_status_rank(right.status)
            .cmp(&review_status_rank(left.status))
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| {
                u8::from(left.source_kind != novel_infrastructure::FindingSource::Rule).cmp(
                    &u8::from(right.source_kind != novel_infrastructure::FindingSource::Rule),
                )
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    merged
}

fn review_report_json(
    summary: &str,
    verdict: novel_infrastructure::AiConsistencyVerdict,
    findings: &[novel_infrastructure::ReviewFinding],
    evidence: &[novel_infrastructure::ReviewEvidence],
    omitted: &[novel_infrastructure::ReviewOmittedItem],
) -> Result<String, ApiError> {
    let evidence_by_id = evidence.iter().map(|item| (item.id, item)).collect();
    let report_findings = findings
        .iter()
        .map(|finding| review_finding_to_report(finding, &evidence_by_id))
        .collect::<Vec<_>>();
    let warnings = omitted
        .iter()
        .map(|item| format!("{}：{}", item.label, item.reason))
        .collect::<Vec<_>>();
    serde_json::to_string(&novel_infrastructure::AiConsistencyReport {
        verdict,
        summary: if summary.trim().is_empty() {
            format!("本次审核提取 {} 条声明。", findings.len())
        } else {
            summary.trim().to_owned()
        },
        findings: report_findings,
        parse_warnings: warnings,
    })
    .map_err(|error| ApiError::internal(format!("无法生成审核报告：{error}")))
}

fn clear_review_cancellation(state: &ProjectState, task_id: uuid::Uuid) {
    if let Ok(mut cancellations) = state.ai_cancellations.lock() {
        cancellations.remove(&task_id);
    }
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn generate_consistency_review_proposal(
    app: tauri::AppHandle,
    state: &ProjectState,
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    review_purpose: novel_infrastructure::ReviewPurpose,
    chapter_title: String,
    chapter_plan: String,
    volume_plan: String,
    document_json: String,
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)]
pub(crate) async fn generate_ai_proposal(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    profile_id: uuid::Uuid,
    chapter_id: uuid::Uuid,
    action: novel_infrastructure::AiAction,
    review_purpose: Option<novel_infrastructure::ReviewPurpose>,
    chapter_title: String,
    chapter_plan: String,
    volume_plan: String,
    document_json: String,
    selection: Option<String>,
    instruction: Option<String>,
    stream: bool,
    temperature: Option<f64>,
    max_output_tokens: Option<u32>,
) -> Result<novel_infrastructure::AiProposal, ApiError> {
    if action == novel_infrastructure::AiAction::ConsistencyCheck {
        return generate_consistency_review_proposal(
            app,
            &state,
            profile_id,
            chapter_id,
            review_purpose.unwrap_or(novel_infrastructure::ReviewPurpose::Admission),
            chapter_title,
            chapter_plan,
            volume_plan,
            document_json,
            stream,
            temperature,
            max_output_tokens,
        )
        .await;
    }
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
        manager
            .current_manuscript(chapter_id)
            .map_err(ApiError::from)?
            .map(|value| value.id)
    };
    if profile.privacy_level == novel_infrastructure::PrivacyLevel::LocalOnly {
        return Err(ApiError::from(novel_infrastructure::AiError::PrivacyPolicy));
    }
    let task_kind = if action == novel_infrastructure::AiAction::ConsistencyCheck {
        novel_infrastructure::AiTaskKind::ConsistencyReview
    } else {
        novel_infrastructure::AiTaskKind::Writing
    };
    let effective_review_purpose =
        review_purpose.unwrap_or(novel_infrastructure::ReviewPurpose::Admission);
    let task_review_purpose = (action == novel_infrastructure::AiAction::ConsistencyCheck)
        .then_some(effective_review_purpose);
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
    let effective_include_current_draft =
        if action == novel_infrastructure::AiAction::ConsistencyCheck {
            effective_review_purpose == novel_infrastructure::ReviewPurpose::Manuscript
        } else {
            include_current_draft
        };
    let effective_document_json = if !effective_include_current_draft
        && matches!(
            action,
            novel_infrastructure::AiAction::Draft
                | novel_infrastructure::AiAction::ConsistencyCheck
        ) {
        r#"{"type":"doc","content":[]}"#.to_owned()
    } else {
        normalized_document_json(document_json.clone())
    };
    let context_input = novel_application::AssembleContextInput {
        chapter_id,
        target_revision_id,
        action,
        chapter_title: chapter_title.clone(),
        chapter_plan: if include_chapter_plan {
            chapter_plan.clone()
        } else {
            String::new()
        },
        volume_plan: if action == novel_infrastructure::AiAction::ConsistencyCheck
            && effective_review_purpose == novel_infrastructure::ReviewPurpose::Manuscript
        {
            String::new()
        } else if include_chapter_plan {
            volume_plan.clone()
        } else {
            String::new()
        },
        document_json: effective_document_json,
        selection: if action == novel_infrastructure::AiAction::ConsistencyCheck {
            None
        } else {
            selection.clone()
        },
        instruction: instruction.clone(),
        input_token_budget,
    };
    let mut context = assemble_task_context(
        &state,
        &context_input,
        include_project_knowledge,
        &task_preference,
    )?;
    if action == novel_infrastructure::AiAction::ConsistencyCheck {
        context = context.with_review_purpose(effective_review_purpose);
    }
    context.estimated_input_tokens = u32::try_from(
        (context.system_prompt.chars().count() + context.user_prompt.chars().count()).div_ceil(4),
    )
    .unwrap_or(u32::MAX)
    .min(profile.context_window.saturating_sub(max_output_tokens));
    if matches!(
        action,
        novel_infrastructure::AiAction::Draft | novel_infrastructure::AiAction::Continue
    ) {
        let current_review_context_version = current_consistency_review_context_version(
            &state,
            novel_infrastructure::ReviewPurpose::Admission,
            chapter_id,
            target_revision_id,
            chapter_title,
            chapter_plan,
            volume_plan,
            document_json,
            instruction,
        )?;
        let admission = {
            let manager = state
                .manager
                .lock()
                .map_err(|_| ApiError::internal("project mutex poisoned"))?;
            if !manager
                .get_audit_flow_settings()
                .map_err(ApiError::from)?
                .admission
            {
                novel_infrastructure::WritingAdmission {
                    allowed: true,
                    blocker_count: 0,
                    reason: None,
                    review_freshness: novel_infrastructure::ConsistencyReviewFreshness::Missing,
                }
            } else {
                let policy = manager
                    .get_writing_review_policy()
                    .map_err(ApiError::from)?;
                manager
                    .chapter_writing_admission(
                        chapter_id,
                        current_review_context_version.as_deref(),
                        policy,
                    )
                    .map_err(ApiError::from)?
            }
        };
        if !admission.allowed {
            return Err(ApiError {
                code: "WRITING_BLOCKED",
                message: admission
                    .reason
                    .unwrap_or_else(|| "最近一次一致性审核未通过，暂时不能生成正文。".to_owned()),
            });
        }
    }
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
            .create_ai_task(profile_id, &context, task_review_purpose)
            .map_err(ApiError::from)?
    };
    if let Err(error) = persist_ai_run_request(
        &state,
        task_id,
        &profile,
        &context,
        stream,
        false,
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
            let review_output_incomplete = task_kind
                == novel_infrastructure::AiTaskKind::ConsistencyReview
                && !outcome.completion.is_complete();
            if outcome.output.trim().is_empty() || review_output_incomplete {
                let (error, message) = if outcome.completion.is_complete() {
                    (
                        novel_infrastructure::AiError::InvalidResponse,
                        "模型返回了空内容，没有生成可用的审核报告或候选正文。".to_owned(),
                    )
                } else {
                    incomplete_generation_failure(
                        outcome.completion,
                        outcome.output.chars().count(),
                        outcome.finish_reason.as_deref(),
                    )
                };
                let _ = manager.fail_ai_task(task_id, &error);
                return Err(ApiError {
                    code: error.code(),
                    message,
                });
            }
            if let Some(fallback) = outcome.fallback_profile.as_ref() {
                let reason = outcome.fallback_reason.as_deref().unwrap_or("UNKNOWN");
                sync_model_profile(&mut manager, fallback)?;
                let _ = manager.record_ai_task_fallback(task_id, fallback.id, reason);
                let (endpoint, request_body) = state.gateway.request_preview_with_options(
                    fallback,
                    &context,
                    stream,
                    false,
                    generation_options,
                );
                if let Ok(request_body) = serde_json::to_string_pretty(&request_body) {
                    let _ = manager.record_ai_run_request(task_id, &endpoint, &request_body);
                }
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
                .complete_ai_task(task_id, &context, outcome.output, outcome.usage.as_ref())
                .map_err(ApiError::from)
        }
        Err(error) => {
            let _ = manager.fail_ai_task(task_id, &error);
            Err(ApiError::from(error))
        }
    }
}

#[cfg(test)]
mod review_pipeline_tests {
    use super::*;

    #[test]
    fn claim_extraction_locates_quotes_and_drops_unlocatable_claims() {
        let blocks = vec![novel_application::ReviewSourceBlock {
            block_id: "block-1".to_owned(),
            text: "林澈在城门外停下。".to_owned(),
        }];
        let output = r#"{
            "claims": [
                {
                    "type": "CHARACTER_LOCATION",
                    "subject": "林澈",
                    "predicate": "位于",
                    "object": "城门外",
                    "quote": "林澈在城门外",
                    "blockId": "block-1",
                    "importance": 4,
                    "confidence": 91
                },
                {
                    "type": "CHARACTER_LOCATION",
                    "subject": "林澈",
                    "predicate": "位于",
                    "object": "城内",
                    "quote": "林澈在城内",
                    "blockId": "block-1",
                    "importance": 4,
                    "confidence": 90
                }
            ]
        }"#;
        let (claims, omitted) = parse_review_claims(
            novel_infrastructure::ReviewPurpose::Manuscript,
            output,
            &blocks,
        )
        .expect("claims");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].start_offset, 0);
        assert_eq!(claims[0].end_offset, 6);
        assert_eq!(omitted.len(), 1);
        assert!(omitted[0].reason.contains("逐字定位"));
    }

    #[test]
    fn semantic_review_downgrades_hard_findings_without_evidence() {
        let claim = novel_infrastructure::ReviewClaim {
            id: uuid::Uuid::new_v4(),
            claim_type: novel_infrastructure::ReviewClaimType::CharacterStatus,
            subject: "林澈".to_owned(),
            predicate: "状态".to_owned(),
            object: "已经死亡".to_owned(),
            quote: "林澈已经死亡".to_owned(),
            block_id: "block-1".to_owned(),
            start_offset: 0,
            end_offset: 6,
            importance: 5,
            confidence: 90,
        };
        let output = format!(
            r#"{{"summary":"存在冲突","findings":[{{"claimId":"{}","status":"BLOCK","severity":"BLOCKER","problem":"与正式状态冲突","evidenceIds":[],"suggestion":"修改正文","confidence":95}}],"omitted":[]}}"#,
            claim.id
        );
        let (_, findings, _) = parse_semantic_review(&output, &[claim], &[]).expect("semantic");
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].status,
            novel_infrastructure::ReviewStatus::Unknown
        );
        assert!(findings[0].problem.contains("没有正式证据"));
    }

    #[test]
    fn deterministic_block_survives_a_model_pass() {
        let claim_id = uuid::Uuid::new_v4();
        let rule_finding = novel_infrastructure::ReviewFinding {
            id: uuid::Uuid::new_v4(),
            claim_id,
            status: novel_infrastructure::ReviewStatus::Block,
            severity: "BLOCKER".to_owned(),
            source_kind: novel_infrastructure::FindingSource::Rule,
            rule_id: Some("FACT_OBJECT_CONFLICT".to_owned()),
            rule_version: Some("1".to_owned()),
            rule_scope: Some("MANUSCRIPT".to_owned()),
            rule_effective_at: None,
            priority: 5,
            problem: "与正式事实冲突。".to_owned(),
            evidence_ids: vec![uuid::Uuid::new_v4()],
            suggestion: "按正式事实修改。".to_owned(),
            confidence: 100,
        };
        let model_finding = novel_infrastructure::ReviewFinding {
            id: uuid::Uuid::new_v4(),
            claim_id,
            status: novel_infrastructure::ReviewStatus::Pass,
            severity: "INFO".to_owned(),
            source_kind: novel_infrastructure::FindingSource::Llm,
            rule_id: None,
            rule_version: None,
            rule_scope: None,
            rule_effective_at: None,
            priority: 5,
            problem: "模型认为没有冲突。".to_owned(),
            evidence_ids: Vec::new(),
            suggestion: String::new(),
            confidence: 80,
        };

        let merged = merge_review_findings(std::slice::from_ref(&rule_finding), &[model_finding]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, rule_finding.id);
        assert_eq!(merged[0].status, novel_infrastructure::ReviewStatus::Block);
    }
}
