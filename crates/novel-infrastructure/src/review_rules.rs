use super::*;

pub const FIXED_RULE_VERSION: &str = "1";

pub struct DeterministicReviewInput<'a> {
    pub review_purpose: ReviewPurpose,
    pub claims: &'a [ReviewClaim],
    pub evidence: &'a [ReviewEvidence],
    pub locked_rules: &'a str,
    pub target_text: &'a str,
}

pub struct DeterministicReviewEvaluator;

impl DeterministicReviewEvaluator {
    #[must_use]
    pub fn evaluate(input: &DeterministicReviewInput<'_>) -> Vec<ReviewFinding> {
        let mut findings = Vec::new();
        for claim in input.claims {
            let evidence = input
                .evidence
                .iter()
                .filter(|item| item.claim_id == claim.id)
                .collect::<Vec<_>>();
            if claim.predicate.contains("人称") {
                evaluate_narrative_person(claim, &evidence, input.locked_rules, &mut findings);
            }
            match claim.claim_type {
                ReviewClaimType::CharacterStatus => {
                    evaluate_fact_conflict(claim, &evidence, &mut findings);
                }
                ReviewClaimType::CharacterLocation => {
                    evaluate_location_conflict(claim, &evidence, &mut findings);
                }
                ReviewClaimType::AbilityOrRealm => {
                    evaluate_ability(claim, &evidence, &mut findings);
                }
                ReviewClaimType::ItemPossession => {
                    evaluate_item_ownership(claim, &evidence, &mut findings);
                }
                ReviewClaimType::Relation => {
                    evaluate_relation(claim, &evidence, &mut findings);
                }
                ReviewClaimType::KnowledgeBoundary => {
                    evaluate_knowledge_boundary(claim, &evidence, &mut findings);
                }
                _ => {}
            }
            for evidence in &evidence {
                if evidence.source_kind == "ENTITY" && entity_is_inactive(&evidence.excerpt) {
                    findings.push(rule_finding(
                        claim,
                        "ENTITY_NOT_ACTIVE",
                        ReviewStatus::Block,
                        "BLOCKER",
                        "正文使用了已归档或失效的实体。",
                        vec![evidence.id],
                        "确认实体生命周期，或在正式资料中恢复实体后重写相关事件。",
                        100,
                    ));
                }
            }
        }
        if input.review_purpose == ReviewPurpose::Manuscript {
            evaluate_locked_event_rules(input, &mut findings);
        }
        deduplicate_findings(findings)
    }
}

fn evaluate_fact_conflict(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    for item in evidence
        .iter()
        .filter(|item| matches!(item.source_kind.as_str(), "FACT" | "WORLD_STATE" | "EVENT"))
    {
        let Some((subject, predicate, object)) = fact_triplet(&item.excerpt) else {
            continue;
        };
        if !text_matches(&claim.subject, subject) || !predicate_matches(&claim.predicate, predicate)
        {
            continue;
        }
        if objects_conflict(&claim.object, object) {
            findings.push(rule_finding(
                claim,
                "FACT_OBJECT_CONFLICT",
                ReviewStatus::Block,
                "BLOCKER",
                &format!("声明“{}”与正式事实“{}”互斥。", claim.object, item.excerpt),
                vec![item.id],
                "按正式事实修改正文，或先完成知识候选审核并更新正式事实。",
                100,
            ));
        }
    }
}

fn evaluate_location_conflict(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    for item in evidence
        .iter()
        .filter(|item| matches!(item.source_kind.as_str(), "WORLD_STATE" | "FACT"))
    {
        let Some((subject, predicate, object)) = fact_triplet(&item.excerpt) else {
            continue;
        };
        if text_matches(&claim.subject, subject)
            && is_location_predicate(predicate)
            && !claim.object.trim().is_empty()
            && !text_matches(&claim.object, object)
        {
            findings.push(rule_finding(
                claim,
                "LOCATION_CONFLICT",
                ReviewStatus::Block,
                "BLOCKER",
                &format!("声明位置“{}”与当前正式位置“{object}”冲突。", claim.object),
                vec![item.id],
                "核对移动事件与当前世界状态，修改正文位置或补充状态变更证据。",
                100,
            ));
        }
    }
}

fn evaluate_ability(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    let supporting = evidence.iter().any(|item| {
        matches!(item.source_kind.as_str(), "FACT" | "ENTITY" | "LOCKED_RULE")
            && (text_matches(&item.excerpt, &claim.object)
                || text_matches(&item.excerpt, &claim.predicate))
            && (item.excerpt.contains("能力")
                || item.excerpt.contains("境界")
                || item.excerpt.contains("突破")
                || item.excerpt.contains("解锁")
                || item.excerpt.contains("允许"))
    });
    let prohibited = evidence.iter().any(|item| {
        item.source_kind == "LOCKED_RULE"
            && contains_prohibition(&item.excerpt)
            && text_matches(&item.excerpt, &claim.object)
    });
    if prohibited {
        findings.push(rule_finding(
            claim,
            "ABILITY_UNCONFIRMED",
            ReviewStatus::Block,
            "BLOCKER",
            "该能力或境界推进被作者锁定规则明确禁止。",
            evidence.iter().map(|item| item.id).collect(),
            "遵守锁定规则，调整能力或境界表现。",
            100,
        ));
    } else if evidence.is_empty() {
        findings.push(rule_finding(
            claim,
            "ABILITY_UNCONFIRMED",
            ReviewStatus::Unknown,
            "INFO",
            "没有找到该能力、境界或解锁条件对应的正式证据。",
            Vec::new(),
            "补充能力边界、境界条件或解锁事件后重新审核。",
            30,
        ));
    } else if !supporting {
        findings.push(rule_finding(
            claim,
            "ABILITY_UNCONFIRMED",
            ReviewStatus::Notice,
            "MINOR",
            "现有正式证据没有明确支持这次能力或境界使用。",
            evidence.iter().map(|item| item.id).collect(),
            "补充正式能力记录；若只是推测，请改为保留不确定性的表达。",
            55,
        ));
    }
}

fn evaluate_item_ownership(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    let conflict = evidence.iter().find(|item| {
        matches!(item.source_kind.as_str(), "FACT" | "EVENT" | "WORLD_STATE")
            && text_matches(&item.excerpt, &claim.object)
            && ["消耗", "失去", "丢失", "毁坏", "转交", "被夺", "不在身上"]
                .iter()
                .any(|marker| item.excerpt.contains(marker))
    });
    if let Some(item) = conflict {
        findings.push(rule_finding(
            claim,
            "ITEM_OWNERSHIP_CONFLICT",
            ReviewStatus::Block,
            "BLOCKER",
            "正文使用了已消耗、已失去或已经转交的关键物品。",
            vec![item.id],
            "核对物品归属和消耗事件，修改正文或补充合法取得过程。",
            95,
        ));
    } else if evidence.is_empty() {
        findings.push(rule_finding(
            claim,
            "ITEM_OWNERSHIP_CONFLICT",
            ReviewStatus::Unknown,
            "INFO",
            "没有找到该物品归属、消耗或遗失状态的正式证据。",
            Vec::new(),
            "补充物品实体、归属事实或相关事件。",
            30,
        ));
    }
}

fn evaluate_relation(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    for item in evidence
        .iter()
        .filter(|item| item.source_kind == "RELATION")
    {
        let Some(relation_type) = item
            .excerpt
            .split(" -> ")
            .nth(1)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !text_matches(&claim.object, relation_type)
            && !text_matches(&claim.predicate, relation_type)
        {
            findings.push(rule_finding(
                claim,
                "RELATION_CONFLICT",
                ReviewStatus::Block,
                "BLOCKER",
                &format!(
                    "声明关系“{}”与正式关系“{relation_type}”不一致。",
                    claim.object
                ),
                vec![item.id],
                "核对正式关系记录，修改正文关系或先更新正式知识。",
                95,
            ));
        }
    }
}

fn evaluate_knowledge_boundary(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    findings: &mut Vec<ReviewFinding>,
) {
    let beliefs = evidence
        .iter()
        .filter(|item| item.source_kind == "BELIEF")
        .collect::<Vec<_>>();
    let other_holder = beliefs.iter().find(|item| {
        !item.excerpt.contains(&claim.subject) && text_matches(&item.excerpt, &claim.object)
    });
    if let Some(item) = other_holder {
        findings.push(rule_finding(
            claim,
            "KNOWLEDGE_BOUNDARY_SUSPECTED",
            ReviewStatus::Warning,
            "MAJOR",
            "该信息目前只记录在其他人物的认知范围内，当前角色可能不应知道。",
            vec![item.id],
            "核对角色认知和参与者事件；必要时改写为线索或不确定性表达。",
            80,
        ));
    } else if evidence.is_empty() {
        findings.push(rule_finding(
            claim,
            "KNOWLEDGE_BOUNDARY_SUSPECTED",
            ReviewStatus::Unknown,
            "INFO",
            "没有找到角色认知或参与者事件证据，无法确认信息边界。",
            Vec::new(),
            "补充角色已知事实、认知记录或参与者事件。",
            30,
        ));
    }
}

fn evaluate_narrative_person(
    claim: &ReviewClaim,
    evidence: &[&ReviewEvidence],
    locked_rules: &str,
    findings: &mut Vec<ReviewFinding>,
) {
    let third_person = locked_rules.contains("第三人称");
    let first_person_quote = claim.quote.contains('我') || claim.quote.contains("我们");
    if third_person && first_person_quote {
        findings.push(rule_finding(
            claim,
            "NARRATIVE_PERSON_CONFLICT",
            ReviewStatus::Block,
            "BLOCKER",
            "锁定叙述人称与目标的实际表达冲突。",
            evidence.iter().map(|item| item.id).collect(),
            "统一叙述人称，或调整作者锁定规则后重新审核。",
            100,
        ));
    }
}

fn evaluate_locked_event_rules(
    input: &DeterministicReviewInput<'_>,
    findings: &mut Vec<ReviewFinding>,
) {
    if input.claims.is_empty() {
        return;
    }
    let target = normalize(input.target_text);
    for line in input
        .locked_rules
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let evidence = input
            .evidence
            .iter()
            .filter(|item| item.source_kind == "LOCKED_RULE" && line.contains(&item.excerpt))
            .map(|item| item.id)
            .collect::<Vec<_>>();
        if contains_prohibition(line)
            && let Some(fragment) = event_fragment(line, &["不得", "禁止", "严禁", "不能"])
            && text_contains_fragment(&target, &fragment)
        {
            let claim = input
                .claims
                .iter()
                .find(|claim| {
                    text_contains_fragment(&normalize(&claim.quote), &fragment)
                        || text_contains_fragment(&normalize(&claim.object), &fragment)
                })
                .unwrap_or(&input.claims[0]);
            findings.push(rule_finding(
                claim,
                "CHAPTER_FORBIDDEN_EVENT",
                ReviewStatus::Block,
                "BLOCKER",
                "目标文本出现了章节合同明确禁止的事件。",
                evidence.clone(),
                "删除该事件，或先由作者解除对应锁定规则。",
                100,
            ));
        }
        if contains_requirement(line)
            && let Some(fragment) = event_fragment(line, &["必须", "需要", "应当"])
            && !text_contains_fragment(&target, &fragment)
        {
            let claim = input
                .claims
                .iter()
                .find(|claim| claim.claim_type == ReviewClaimType::RequiredEvent)
                .unwrap_or(&input.claims[0]);
            findings.push(rule_finding(
                claim,
                "CHAPTER_REQUIRED_EVENT_MISSING",
                ReviewStatus::Block,
                "BLOCKER",
                "没有在目标文本中确认章节合同要求的事件。",
                evidence,
                "补齐必须事件；若计划已经变化，请先由作者更新章节合同。",
                90,
            ));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn rule_finding(
    claim: &ReviewClaim,
    rule_id: &str,
    status: ReviewStatus,
    severity: &str,
    problem: &str,
    evidence_ids: Vec<Uuid>,
    suggestion: &str,
    confidence: u8,
) -> ReviewFinding {
    ReviewFinding {
        id: Uuid::new_v4(),
        claim_id: claim.id,
        status,
        severity: severity.to_owned(),
        source_kind: FindingSource::Rule,
        rule_id: Some(rule_id.to_owned()),
        rule_version: Some(FIXED_RULE_VERSION.to_owned()),
        priority: claim.importance,
        problem: problem.to_owned(),
        evidence_ids,
        suggestion: suggestion.to_owned(),
        confidence,
    }
}

fn fact_triplet(excerpt: &str) -> Option<(&str, &str, &str)> {
    let words = excerpt.split_whitespace().collect::<Vec<_>>();
    if words.len() < 3 {
        return None;
    }
    let object_start = excerpt.find(words[2])?;
    Some((words[0], words[1], &excerpt[object_start..]))
}

fn objects_conflict(left: &str, right: &str) -> bool {
    if text_matches(left, right) {
        return false;
    }
    let groups = [
        &["死亡", "身亡", "已死", "不在世"][..],
        &["存活", "活着", "在世", "正常"][..],
        &["失踪", "下落不明"][..],
        &["在场", "抵达", "位于"][..],
        &["已消耗", "失去", "丢失", "毁坏", "转交"][..],
        &["持有", "拥有", "携带"][..],
    ];
    groups.iter().enumerate().any(|(left_index, group)| {
        group.iter().any(|value| text_matches(left, value))
            && groups.iter().enumerate().any(|(right_index, other)| {
                left_index != right_index && other.iter().any(|value| text_matches(right, value))
            })
    })
}

fn predicate_matches(left: &str, right: &str) -> bool {
    let left = normalize(left);
    let right = normalize(right);
    !left.is_empty()
        && !right.is_empty()
        && (left.contains(&right) || right.contains(&left) || same_predicate_family(&left, &right))
}

fn is_location_predicate(value: &str) -> bool {
    let value = normalize(value);
    ["位置", "位于", "所在", "抵达", "前往", "在"]
        .iter()
        .any(|marker| value.contains(marker))
}

fn same_predicate_family(left: &str, right: &str) -> bool {
    [
        &["状态", "存活", "生死", "生命"][..],
        &["位置", "位于", "所在", "抵达", "前往"][..],
        &["关系", "身份", "阵营"][..],
        &["持有", "携带", "使用", "拥有"][..],
        &["知道", "认知", "获悉", "得知"][..],
    ]
    .iter()
    .any(|family| {
        family.iter().any(|value| left.contains(value))
            && family.iter().any(|value| right.contains(value))
    })
}

fn entity_is_inactive(excerpt: &str) -> bool {
    ["ARCHIVED", "INACTIVE", "已归档", "已失效"]
        .iter()
        .any(|marker| excerpt.contains(marker))
}

fn contains_prohibition(value: &str) -> bool {
    ["不得", "禁止", "严禁", "不能"]
        .iter()
        .any(|marker| value.contains(marker))
}

fn contains_requirement(value: &str) -> bool {
    ["必须", "需要", "应当"]
        .iter()
        .any(|marker| value.contains(marker))
}

fn event_fragment(value: &str, markers: &[&str]) -> Option<String> {
    let marker = markers
        .iter()
        .filter_map(|marker| value.find(marker).map(|index| (index, marker.len())))
        .min_by_key(|(index, _)| *index)?;
    let mut fragment = value[marker.0 + marker.1..]
        .trim()
        .trim_start_matches(['：', ':', '，', ','])
        .to_owned();
    for prefix in ["发生", "出现", "完成", "包含", "安排", "写出"] {
        if let Some(stripped) = fragment.strip_prefix(prefix) {
            fragment = stripped.trim().to_owned();
            break;
        }
    }
    let fragment = fragment
        .split(['。', '；', ';', '，', ',', '\n'])
        .next()
        .unwrap_or_default()
        .trim();
    (!fragment.is_empty()).then(|| fragment.to_owned())
}

fn text_contains_fragment(target: &str, fragment: &str) -> bool {
    let fragment = normalize(fragment);
    if target.contains(&fragment) {
        return true;
    }
    let characters = fragment.chars().collect::<Vec<_>>();
    if characters.len() < 4 {
        return false;
    }
    characters
        .windows(4)
        .filter(|window| window.iter().all(|character| !character.is_ascii()))
        .any(|window| target.contains(&window.iter().collect::<String>()))
}

fn text_matches(left: &str, right: &str) -> bool {
    let left = normalize(left);
    let right = normalize(right);
    !left.is_empty() && !right.is_empty() && (left.contains(&right) || right.contains(&left))
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn deduplicate_findings(findings: Vec<ReviewFinding>) -> Vec<ReviewFinding> {
    let mut seen = std::collections::HashSet::new();
    findings
        .into_iter()
        .filter(|finding| {
            seen.insert((
                finding.claim_id,
                finding.rule_id.clone(),
                finding.status,
                finding.problem.clone(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_conflicting_fact_and_location_with_rule_evidence() {
        let claim = ReviewClaim {
            id: Uuid::new_v4(),
            claim_type: ReviewClaimType::CharacterStatus,
            subject: "林澈".to_owned(),
            predicate: "状态".to_owned(),
            object: "已经死亡".to_owned(),
            quote: "林澈已经死亡。".to_owned(),
            block_id: "block-1".to_owned(),
            start_offset: 0,
            end_offset: 7,
            importance: 5,
            confidence: 90,
        };
        let evidence = ReviewEvidence {
            id: Uuid::new_v4(),
            claim_id: claim.id,
            source_kind: "FACT".to_owned(),
            source_record_id: Uuid::new_v4(),
            authority: EvidenceAuthority::ConfirmedFact,
            excerpt: "林澈 状态 存活".to_owned(),
            source_revision: "fact:v1".to_owned(),
            relevance: 9_000,
        };
        let findings = DeterministicReviewEvaluator::evaluate(&DeterministicReviewInput {
            review_purpose: ReviewPurpose::Manuscript,
            claims: std::slice::from_ref(&claim),
            evidence: std::slice::from_ref(&evidence),
            locked_rules: "",
            target_text: &claim.quote,
        });
        assert!(findings.iter().any(|finding| {
            finding.rule_id.as_deref() == Some("FACT_OBJECT_CONFLICT")
                && finding.status == ReviewStatus::Block
                && finding.evidence_ids == vec![evidence.id]
        }));
    }

    #[test]
    fn missing_evidence_stays_unknown_instead_of_blocking() {
        let claim = ReviewClaim {
            id: Uuid::new_v4(),
            claim_type: ReviewClaimType::AbilityOrRealm,
            subject: "林澈".to_owned(),
            predicate: "突破".to_owned(),
            object: "筑基".to_owned(),
            quote: "林澈突破筑基。".to_owned(),
            block_id: "block-1".to_owned(),
            start_offset: 0,
            end_offset: 7,
            importance: 5,
            confidence: 90,
        };
        let findings = DeterministicReviewEvaluator::evaluate(&DeterministicReviewInput {
            review_purpose: ReviewPurpose::Manuscript,
            claims: std::slice::from_ref(&claim),
            evidence: &[],
            locked_rules: "",
            target_text: &claim.quote,
        });
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].status, ReviewStatus::Unknown);
        assert_eq!(findings[0].rule_id.as_deref(), Some("ABILITY_UNCONFIRMED"));
    }

    #[test]
    fn location_rule_ignores_non_location_predicates() {
        let claim = ReviewClaim {
            id: Uuid::new_v4(),
            claim_type: ReviewClaimType::CharacterLocation,
            subject: "林澈".to_owned(),
            predicate: "位于".to_owned(),
            object: "城门外".to_owned(),
            quote: "林澈在城门外。".to_owned(),
            block_id: "block-1".to_owned(),
            start_offset: 0,
            end_offset: 7,
            importance: 5,
            confidence: 90,
        };
        let evidence = ReviewEvidence {
            id: Uuid::new_v4(),
            claim_id: claim.id,
            source_kind: "FACT".to_owned(),
            source_record_id: Uuid::new_v4(),
            authority: EvidenceAuthority::ConfirmedFact,
            excerpt: "林澈 状态 存活".to_owned(),
            source_revision: "fact:v1".to_owned(),
            relevance: 9_000,
        };
        let findings = DeterministicReviewEvaluator::evaluate(&DeterministicReviewInput {
            review_purpose: ReviewPurpose::Manuscript,
            claims: std::slice::from_ref(&claim),
            evidence: std::slice::from_ref(&evidence),
            locked_rules: "",
            target_text: &claim.quote,
        });
        assert!(
            findings
                .iter()
                .all(|finding| finding.rule_id.as_deref() != Some("LOCATION_CONFLICT"))
        );
    }

    #[test]
    fn event_fragment_matching_does_not_use_short_common_phrases() {
        assert!(!text_contains_fragment("众人再次发生冲突。", "守门冲突"));
        assert!(text_contains_fragment(
            "林澈在城门外与守卫发生守门冲突。",
            "守门冲突"
        ));
    }
}
