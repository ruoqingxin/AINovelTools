use super::super::{ApiError, locate_quote, manuscript_blocks};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewClaimExtractionResponse {
    #[serde(default)]
    claims: Vec<ExtractedReviewClaim>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedReviewClaim {
    #[serde(rename = "type")]
    claim_type: String,
    subject: String,
    predicate: String,
    object: String,
    quote: String,
    block_id: String,
    #[serde(default = "default_claim_importance")]
    importance: u8,
    #[serde(default)]
    confidence: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewResponse {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    findings: Vec<SemanticReviewFinding>,
    #[serde(default)]
    omitted: Vec<SemanticReviewOmitted>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewFinding {
    claim_id: String,
    status: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    problem: String,
    #[serde(default)]
    evidence_ids: Vec<String>,
    #[serde(default)]
    suggestion: String,
    #[serde(default)]
    confidence: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticReviewOmitted {
    #[serde(default)]
    label: String,
    #[serde(default)]
    reason: String,
}

fn default_claim_importance() -> u8 {
    3
}

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

pub(super) fn parse_review_claims(
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

pub(super) fn parse_semantic_review(
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

pub(super) fn review_target_blocks(
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

pub(super) fn chapter_contract_review_items(
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

pub(super) fn review_verdict(
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

pub(super) fn merge_review_findings(
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

pub(super) fn review_report_json(
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

    #[test]
    fn claim_codec_preserves_purpose_defaults_and_deduplication() {
        let blocks = vec![novel_application::ReviewSourceBlock {
            block_id: "chapter-plan".to_owned(),
            text: "本章必须入城。".to_owned(),
        }];
        let output = r#"```json
        {"claims":[
          {"type":"REQUIRED_EVENT","subject":"主角","predicate":"必须","object":"入城","quote":"必须入城","blockId":"chapter-plan"},
          {"type":"REQUIRED_EVENT","subject":"主角","predicate":"必须","object":"入城","quote":"必须入城","blockId":"chapter-plan"},
          {"type":"CHARACTER_LOCATION","subject":"主角","predicate":"位于","object":"城内","quote":"必须入城","blockId":"chapter-plan"},
          {"type":"UNSUPPORTED","subject":"主角","predicate":"必须","object":"入城","quote":"必须入城","blockId":"chapter-plan"}
        ]}
        ```"#;
        let (claims, omitted) = parse_review_claims(
            novel_infrastructure::ReviewPurpose::Admission,
            output,
            &blocks,
        )
        .expect("claims");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].importance, 3);
        assert_eq!(claims[0].confidence, 0);
        assert_eq!(claims[0].start_offset, 2);
        assert_eq!(claims[0].end_offset, 6);
        assert_eq!(omitted.len(), 2);
        assert!(
            omitted
                .iter()
                .any(|item| item.reason.contains("当前审核用途"))
        );
    }

    #[test]
    fn review_target_blocks_do_not_mix_plan_constraints_with_manuscript() {
        let document = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"body"},"content":[{"type":"text","text":"已经入城。"}]}]}"#;
        let admission = review_target_blocks(
            novel_infrastructure::ReviewPurpose::Admission,
            "  必须入城。  ",
            " 不得离城。 ",
            document,
        )
        .expect("admission blocks");
        assert_eq!(admission.len(), 2);
        assert_eq!(admission[0].block_id, "chapter-plan");
        assert_eq!(admission[0].text, "必须入城。");
        let manuscript = review_target_blocks(
            novel_infrastructure::ReviewPurpose::Manuscript,
            "必须入城。",
            "不得离城。",
            document,
        )
        .expect("manuscript blocks");
        assert_eq!(manuscript.len(), 1);
        assert_eq!(manuscript[0].block_id, "body");
        assert_eq!(manuscript[0].text, "已经入城。");
        assert!(
            review_target_blocks(
                novel_infrastructure::ReviewPurpose::Admission,
                "",
                "",
                document,
            )
            .is_err()
        );
        assert!(
            review_target_blocks(
                novel_infrastructure::ReviewPurpose::Manuscript,
                "必须入城。",
                "",
                r#"{"type":"doc","content":[]}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn semantic_codec_rejects_other_claim_evidence_and_retains_missing_claims() {
        let blocks = vec![novel_application::ReviewSourceBlock {
            block_id: "body".to_owned(),
            text: "林澈在城内，苏晴在城外。".to_owned(),
        }];
        let (claims, _) = parse_review_claims(
            novel_infrastructure::ReviewPurpose::Manuscript,
            r#"{"claims":[
              {"type":"CHARACTER_LOCATION","subject":"林澈","predicate":"位于","object":"城内","quote":"林澈在城内","blockId":"body"},
              {"type":"CHARACTER_LOCATION","subject":"苏晴","predicate":"位于","object":"城外","quote":"苏晴在城外","blockId":"body"}
            ]}"#,
            &blocks,
        ).expect("claims");
        let evidence = novel_infrastructure::ReviewEvidence {
            id: uuid::Uuid::new_v4(),
            claim_id: claims[1].id,
            source_kind: novel_infrastructure::ReviewEvidenceSource::Fact,
            source_record_id: uuid::Uuid::new_v4(),
            authority: novel_infrastructure::EvidenceAuthority::ConfirmedFact,
            excerpt: "苏晴已进入城内。".to_owned(),
            source_revision: "fact:revision-1".to_owned(),
            relevance: 10_000,
        };
        let output = format!(
            r#"{{"findings":[{{"claimId":"{}","status":"BLOCK","severity":"BLOCKER","evidenceIds":["{}"]}}]}}"#,
            claims[0].id, evidence.id,
        );
        let (_, findings, _) =
            parse_semantic_review(&output, &claims, std::slice::from_ref(&evidence))
                .expect("semantic");
        assert_eq!(findings.len(), 2);
        assert_eq!(
            findings[0].status,
            novel_infrastructure::ReviewStatus::Unknown
        );
        assert!(findings[0].evidence_ids.is_empty());
        assert_eq!(findings[1].claim_id, claims[1].id);
        assert_eq!(
            findings[1].status,
            novel_infrastructure::ReviewStatus::Unknown
        );
        assert_eq!(findings[1].evidence_ids, vec![evidence.id]);
    }

    #[test]
    fn review_report_keeps_unknowns_and_omissions_visible() {
        let (_, findings, _) = parse_semantic_review("{}", &[], &[]).expect("empty semantic");
        let omitted = vec![novel_infrastructure::ReviewOmittedItem {
            item_type: "BATCH".to_owned(),
            label: "未检查批次".to_owned(),
            reason: "模型调用失败。".to_owned(),
            claim_id: None,
        }];
        let report = review_report_json(
            "",
            novel_infrastructure::AiConsistencyVerdict::NeedsInput,
            &findings,
            &[],
            &omitted,
        )
        .expect("report");
        let report: novel_infrastructure::AiConsistencyReport =
            serde_json::from_str(&report).expect("roundtrip report");
        assert_eq!(
            report.verdict,
            novel_infrastructure::AiConsistencyVerdict::NeedsInput
        );
        assert!(!report.summary.is_empty());
        assert_eq!(report.parse_warnings, vec!["未检查批次：模型调用失败。"]);
    }
}
