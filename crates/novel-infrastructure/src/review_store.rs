use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Error)]
pub enum ReviewStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("review trace serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("review trace does not exist: {0}")]
    MissingTrace(Uuid),
    #[error("review trace database operation failed: {0}")]
    Database(#[from] DatabaseError),
    #[error("review trace SQLite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("review evidence resolution failed: {0}")]
    Evidence(String),
}

impl ProjectManager {
    pub fn save_ai_review_trace(&mut self, trace: &ReviewTrace) -> Result<(), ReviewStoreError> {
        let session = self.current.as_mut().ok_or(ReviewStoreError::NoProject)?;
        session.database.save_ai_review_trace(trace)
    }

    pub fn get_consistency_review_trace(
        &self,
        proposal_id: Uuid,
    ) -> Result<ReviewTrace, ReviewStoreError> {
        let session = self.current.as_ref().ok_or(ReviewStoreError::NoProject)?;
        session.database.get_consistency_review_trace(proposal_id)
    }

    pub fn resolve_review_evidence(
        &self,
        chapter_id: Uuid,
        claims: &[ReviewClaim],
        locked_rules: &str,
    ) -> Result<(Vec<ReviewEvidence>, Vec<ReviewOmittedItem>), ReviewStoreError> {
        let entities = self
            .list_entities(false)
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let facts = self
            .list_current_facts()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let world_state = self
            .latest_world_state()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?
            .map(|state| state.entries)
            .unwrap_or_default();
        let relations = self
            .list_relations()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let events = self
            .list_events()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let beliefs = self
            .list_beliefs()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let foreshadowings = self
            .list_foreshadowings()
            .map_err(|error| ReviewStoreError::Evidence(error.to_string()))?;
        let entity_revisions = entities
            .iter()
            .filter_map(|entity| {
                self.list_entity_revisions(entity.id)
                    .ok()
                    .and_then(|mut revisions| revisions.drain(..).next())
                    .map(|revision| (entity.id, revision))
            })
            .collect::<HashMap<_, _>>();
        let fact_labels = facts
            .iter()
            .map(|fact| {
                (
                    fact.knowledge_id,
                    format!("{} {} {}", fact.subject, fact.predicate, fact.object),
                )
            })
            .collect::<HashMap<_, _>>();
        let locked_rule_parts = locked_rules
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        let mut evidence = Vec::new();
        let mut omitted = Vec::new();

        for claim in claims {
            let mut claim_evidence = Vec::new();

            for entity in &entities {
                let Some(revision) = entity_revisions.get(&entity.id) else {
                    continue;
                };
                let content = format!(
                    "{}：{}\n状态：{}\n别名：{}\n固定属性：{}",
                    revision.name,
                    revision.description.trim(),
                    match entity.lifecycle_status {
                        EntityLifecycleStatus::Active => "ACTIVE",
                        EntityLifecycleStatus::Archived => "ARCHIVED",
                    },
                    if revision.aliases.is_empty() {
                        "无".to_owned()
                    } else {
                        revision.aliases.join("、")
                    },
                    revision.fixed_attributes_json.trim()
                );
                let relevance = entity_match_score(
                    claim,
                    &revision.name,
                    &revision.aliases,
                    &revision.description,
                );
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Entity,
                        entity.id,
                        EvidenceAuthority::ConfirmedFact,
                        content,
                        format!("entity-revision:{}", revision.id),
                        relevance,
                    ));
                }
            }

            for fact in &facts {
                let relevance =
                    record_match_score(claim, &fact.subject, &fact.predicate, &fact.object);
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Fact,
                        fact.knowledge_id,
                        EvidenceAuthority::ConfirmedFact,
                        format!("{} {} {}", fact.subject, fact.predicate, fact.object),
                        format!("fact:{}:v{}", fact.knowledge_id, fact.knowledge_version),
                        relevance,
                    ));
                }
            }

            for entry in &world_state {
                let relevance =
                    record_match_score(claim, &entry.subject, &entry.predicate, &entry.object);
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::WorldState,
                        entry.fact_knowledge_id,
                        EvidenceAuthority::CurrentState,
                        format!("{} {} {}", entry.subject, entry.predicate, entry.object),
                        format!(
                            "world-state:{}:fact:{}:v{}",
                            entry.fact_knowledge_id, entry.fact_knowledge_id, entry.fact_version
                        ),
                        relevance.saturating_add(300),
                    ));
                }
            }

            for relation in &relations {
                let from = fact_labels
                    .get(&relation.from_knowledge_id)
                    .map_or("未知对象", String::as_str);
                let to = fact_labels
                    .get(&relation.to_knowledge_id)
                    .map_or("未知对象", String::as_str);
                let content = format!("正式关系：{from} -> {} -> {to}", relation.relation_type);
                let relevance = record_match_score(claim, from, &relation.relation_type, to);
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Relation,
                        relation.id,
                        EvidenceAuthority::ConfirmedFact,
                        content,
                        format!("relation:{}:v{}", relation.id, relation.relation_version),
                        relevance,
                    ));
                }
            }

            for belief in &beliefs {
                let holder = fact_labels
                    .get(&belief.holder_knowledge_id)
                    .map_or("未识别角色", String::as_str);
                let relevance = record_match_score(claim, holder, "认知/已知", &belief.proposition);
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Belief,
                        belief.id,
                        EvidenceAuthority::ConfirmedFact,
                        format!("角色认知：{holder}认为：{}", belief.proposition),
                        format!("belief:{}:v{}", belief.id, belief.belief_version),
                        relevance,
                    ));
                }
            }

            for event in &events {
                let participants = event
                    .participant_fact_ids
                    .iter()
                    .filter_map(|id| fact_labels.get(id))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("、");
                let relevance =
                    record_match_score(claim, &event.name, &participants, &event.occurred_at);
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Event,
                        event.id,
                        EvidenceAuthority::ApprovedEvent,
                        format!(
                            "事件：{}；时间：{}；参与者：{}",
                            event.name,
                            event.occurred_at,
                            if participants.is_empty() {
                                "未记录"
                            } else {
                                &participants
                            }
                        ),
                        format!("event:{}:v{}", event.id, event.event_version),
                        relevance,
                    ));
                }
            }

            for foreshadowing in &foreshadowings {
                let relevance =
                    record_match_score(claim, &foreshadowing.title, &foreshadowing.status, "");
                if relevance > 0
                    || foreshadowing.target_chapter_id == Some(chapter_id)
                        && claim.claim_type == ReviewClaimType::ForeshadowingWindow
                {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::Foreshadowing,
                        foreshadowing.id,
                        EvidenceAuthority::ConfirmedFact,
                        format!(
                            "伏笔：{}；状态：{}；目标章节：{}",
                            foreshadowing.title,
                            foreshadowing.status,
                            foreshadowing
                                .target_chapter_id
                                .map_or_else(|| "未指定".to_owned(), |id| id.to_string())
                        ),
                        format!(
                            "foreshadowing:{}:v{}",
                            foreshadowing.id, foreshadowing.foreshadowing_version
                        ),
                        relevance.max(6_000),
                    ));
                }
            }

            let admission_claim = matches!(
                claim.claim_type,
                ReviewClaimType::RequiredEvent
                    | ReviewClaimType::ForbiddenEvent
                    | ReviewClaimType::AllowedCharacter
                    | ReviewClaimType::TimeWindow
                    | ReviewClaimType::StageBoundary
                    | ReviewClaimType::ForeshadowingWindow
                    | ReviewClaimType::PlanDependency
            );
            for rule in &locked_rule_parts {
                let relevance = if admission_claim {
                    record_match_score(claim, rule, "", "").max(7_000)
                } else {
                    record_match_score(claim, rule, "", "")
                };
                if relevance > 0 {
                    claim_evidence.push(make_evidence(
                        claim,
                        ReviewEvidenceSource::LockedRule,
                        Uuid::nil(),
                        EvidenceAuthority::LockedRule,
                        truncate_excerpt(rule, 500),
                        "author-confirmed-rule".to_owned(),
                        relevance,
                    ));
                }
            }

            let mut seen = HashSet::new();
            claim_evidence.retain(|item| {
                seen.insert((
                    item.source_kind,
                    item.source_record_id,
                    item.excerpt.clone(),
                ))
            });
            claim_evidence.sort_by(|left, right| {
                right
                    .relevance
                    .cmp(&left.relevance)
                    .then_with(|| left.source_kind.as_str().cmp(right.source_kind.as_str()))
            });
            if claim_evidence.len() > 8 {
                omitted.push(ReviewOmittedItem {
                    item_type: "EVIDENCE".to_owned(),
                    label: format!("{}：{}", claim.subject, claim.object),
                    reason: format!(
                        "为保证审核输入最小化，仅保留最高权威的 8 条证据，另有 {} 条未发送。",
                        claim_evidence.len() - 8
                    ),
                    claim_id: Some(claim.id),
                });
                claim_evidence.truncate(8);
            }
            evidence.extend(claim_evidence);
        }

        Ok((evidence, omitted))
    }
}

impl Database {
    fn save_ai_review_trace(&self, trace: &ReviewTrace) -> Result<(), ReviewStoreError> {
        self.connection.execute(
            "INSERT INTO ai_review_traces (
                run_id, review_purpose, chapter_id, target_revision_id, context_version,
                claims_json, evidence_json, deterministic_findings_json,
                model_findings_json, omitted_items_json, stage_requests_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(run_id) DO UPDATE SET
                review_purpose=excluded.review_purpose,
                chapter_id=excluded.chapter_id,
                target_revision_id=excluded.target_revision_id,
                context_version=excluded.context_version,
                claims_json=excluded.claims_json,
                evidence_json=excluded.evidence_json,
                deterministic_findings_json=excluded.deterministic_findings_json,
                model_findings_json=excluded.model_findings_json,
                omitted_items_json=excluded.omitted_items_json,
                stage_requests_json=excluded.stage_requests_json",
            rusqlite::params![
                trace.run_id.to_string(),
                trace.review_purpose.storage_key(),
                trace.chapter_id.to_string(),
                trace.target_revision_id.map(|value| value.to_string()),
                trace.context_version.clone(),
                serde_json::to_string(&trace.claims)?,
                serde_json::to_string(&trace.evidence)?,
                serde_json::to_string(&trace.deterministic_findings)?,
                serde_json::to_string(&trace.model_findings)?,
                serde_json::to_string(&trace.omitted_items)?,
                serde_json::to_string(&trace.stage_requests)?,
            ],
        )?;
        Ok(())
    }

    fn get_consistency_review_trace(
        &self,
        proposal_id: Uuid,
    ) -> Result<ReviewTrace, ReviewStoreError> {
        let run_id = self
            .connection
            .query_row(
                "SELECT task_id FROM ai_proposals WHERE id=?1",
                [proposal_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(ReviewStoreError::MissingTrace(proposal_id))?;
        let run_id = Uuid::parse_str(&run_id)
            .map_err(|error| ReviewStoreError::Sqlite(parse_text_error(0, error)))?;
        self.connection
            .query_row(
                "SELECT run_id, review_purpose, chapter_id, target_revision_id, context_version,
                        claims_json, evidence_json, deterministic_findings_json,
                        model_findings_json, omitted_items_json, stage_requests_json
                 FROM ai_review_traces WHERE run_id=?1",
                [run_id.to_string()],
                |row| {
                    let review_purpose = match row.get::<_, String>(1)?.as_str() {
                        "MANUSCRIPT" => ReviewPurpose::Manuscript,
                        _ => ReviewPurpose::Admission,
                    };
                    Ok(ReviewTrace {
                        run_id: parse_uuid(row.get::<_, String>(0)?, 0)?,
                        review_purpose,
                        chapter_id: parse_uuid(row.get::<_, String>(2)?, 2)?,
                        target_revision_id: row
                            .get::<_, Option<String>>(3)?
                            .map(|value| parse_uuid(value, 3))
                            .transpose()?,
                        context_version: row.get(4)?,
                        claims: parse_trace_json(row, 5)?,
                        evidence: parse_trace_json(row, 6)?,
                        deterministic_findings: parse_trace_json(row, 7)?,
                        model_findings: parse_trace_json(row, 8)?,
                        omitted_items: parse_trace_json(row, 9)?,
                        stage_requests: parse_trace_json(row, 10)?,
                    })
                },
            )
            .optional()?
            .ok_or(ReviewStoreError::MissingTrace(run_id))
    }
}

fn parse_trace_json<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    column: usize,
) -> rusqlite::Result<T> {
    serde_json::from_str(&row.get::<_, String>(column)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_text_error(column: usize, error: uuid::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn parse_uuid(value: String, column: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| parse_text_error(column, error))
}

fn make_evidence(
    claim: &ReviewClaim,
    source_kind: ReviewEvidenceSource,
    source_record_id: Uuid,
    authority: EvidenceAuthority,
    excerpt: String,
    source_revision: String,
    relevance: u16,
) -> ReviewEvidence {
    ReviewEvidence {
        id: Uuid::new_v4(),
        claim_id: claim.id,
        source_kind,
        source_record_id,
        authority,
        excerpt: truncate_excerpt(&excerpt, 1_000),
        source_revision,
        relevance,
    }
}

fn record_match_score(claim: &ReviewClaim, left: &str, middle: &str, right: &str) -> u16 {
    let subject = normalize_for_evidence(&claim.subject);
    let object = normalize_for_evidence(&claim.object);
    let predicate = normalize_for_evidence(&claim.predicate);
    let quote = normalize_for_evidence(&claim.quote);
    let left = normalize_for_evidence(left);
    let middle = normalize_for_evidence(middle);
    let right = normalize_for_evidence(right);
    let mut score = 0_u16;
    for (value, weight) in [
        (subject.as_str(), 5_000_u16),
        (object.as_str(), 4_500),
        (predicate.as_str(), 3_000),
        (quote.as_str(), 2_000),
    ] {
        if value.is_empty() {
            continue;
        }
        if (!left.is_empty() && (value.contains(&left) || left.contains(value)))
            || (!right.is_empty() && (value.contains(&right) || right.contains(value)))
            || (!middle.is_empty() && (value.contains(&middle) || middle.contains(value)))
        {
            score = score.max(weight);
        }
    }
    if score == 0 && !left.is_empty() && !subject.is_empty() && left == subject {
        score = 9_000;
    }
    score
}

fn entity_match_score(
    claim: &ReviewClaim,
    name: &str,
    aliases: &[String],
    description: &str,
) -> u16 {
    let values = std::iter::once(name)
        .chain(aliases.iter().map(String::as_str))
        .collect::<Vec<_>>();
    values
        .into_iter()
        .map(|value| record_match_score(claim, value, description, ""))
        .max()
        .unwrap_or_default()
}

fn normalize_for_evidence(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_alphanumeric() || matches!(character, '\u{4e00}'..='\u{9fff}')
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn truncate_excerpt(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let mut output = value.chars().take(limit).collect::<String>();
    output.push('…');
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_entity_aliases_and_roundtrips_review_trace() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-review-trace-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "审核轨迹测试").expect("create");
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第一章".to_owned())
            .expect("chapter");
        manager
            .upsert_entity(EntityInput {
                id: None,
                entity_type: EntityType::Character,
                name: "林澈".to_owned(),
                aliases: vec!["阿澈".to_owned()],
                description: "主角".to_owned(),
                fixed_attributes_json: "{}".to_owned(),
                tags: Vec::new(),
                base_revision_id: None,
                source_version: None,
                expected_version: None,
            })
            .expect("entity");
        let claim = ReviewClaim {
            id: Uuid::new_v4(),
            claim_type: ReviewClaimType::CharacterStatus,
            subject: "阿澈".to_owned(),
            predicate: "状态".to_owned(),
            object: "正常".to_owned(),
            quote: "阿澈站在门外。".to_owned(),
            block_id: "block-1".to_owned(),
            start_offset: 0,
            end_offset: 7,
            importance: 4,
            confidence: 90,
        };
        let (evidence, _) = manager
            .resolve_review_evidence(chapter.id, std::slice::from_ref(&claim), "")
            .expect("evidence");
        assert!(evidence.iter().any(|item| {
            item.source_kind == ReviewEvidenceSource::Entity && item.excerpt.contains("林澈")
        }));

        let profile = manager
            .upsert_model_profile(ModelProfileInput {
                id: None,
                name: "审核模型".to_owned(),
                provider: ModelProvider::DeepSeek,
                capability: ModelCapability::Chat,
                base_url: "https://api.deepseek.com".to_owned(),
                model_id: "deepseek-chat".to_owned(),
                context_window: 32_768,
                max_output_tokens: 4_096,
                privacy_level: PrivacyLevel::AllowCloud,
                timeout_seconds: 30,
                retry_limit: 1,
                input_price_micros_per_million: 1_000_000,
                output_price_micros_per_million: 2_000_000,
                price_currency: "CNY".to_owned(),
            })
            .expect("profile");
        let context = novel_application::ContextAssembler::assemble(
            &novel_application::AssembleContextInput {
                chapter_id: chapter.id,
                target_revision_id: None,
                action: AiAction::ConsistencyCheck,
                chapter_title: chapter.title,
                chapter_plan: "检查主角状态。".to_owned(),
                volume_plan: String::new(),
                document_json:
                    r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"阿澈站在门外。"}]}]}"#
                        .to_owned(),
                selection: None,
                instruction: None,
                input_token_budget: 4_096,
            },
        )
        .expect("context")
        .with_review_purpose(ReviewPurpose::Manuscript);
        let task_id = manager
            .create_ai_task(profile.id, &context, Some(ReviewPurpose::Manuscript))
            .expect("task");
        let trace = ReviewTrace {
            run_id: task_id,
            review_purpose: ReviewPurpose::Manuscript,
            chapter_id: chapter.id,
            target_revision_id: None,
            context_version: context.context_version.clone(),
            claims: vec![claim],
            evidence,
            deterministic_findings: Vec::new(),
            model_findings: vec![ReviewFinding {
                id: Uuid::new_v4(),
                claim_id: Uuid::new_v4(),
                status: ReviewStatus::Unknown,
                severity: "INFO".to_owned(),
                source_kind: FindingSource::Llm,
                rule_id: None,
                rule_version: None,
                rule_scope: None,
                rule_effective_at: None,
                priority: 3,
                problem: "待确认".to_owned(),
                evidence_ids: Vec::new(),
                suggestion: String::new(),
                confidence: 0,
            }],
            omitted_items: vec![ReviewOmittedItem {
                item_type: "CLAIM".to_owned(),
                label: "无法定位".to_owned(),
                reason: "quote 不匹配".to_owned(),
                claim_id: None,
            }],
            stage_requests: vec![ReviewStageRequest {
                stage: ReviewStage::ClaimExtraction,
                profile_id: Some(profile.id),
                model_id: Some(profile.model_id),
                request_context_version: context.context_version.clone(),
                request_snapshot: Some("request".to_owned()),
                response_preview: Some("response".to_owned()),
                parse_result: "EXTRACTED_1".to_owned(),
                fallback_reason: None,
            }],
        };
        manager.save_ai_review_trace(&trace).expect("save trace");
        let proposal = manager
            .complete_ai_task(task_id, &context, "{}".to_owned())
            .expect("proposal");
        let stored = manager
            .get_consistency_review_trace(proposal.id)
            .expect("stored trace");
        assert_eq!(stored, trace);
        assert_eq!(
            manager.health().expect("health").schema_version,
            CURRENT_SCHEMA_VERSION
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
