use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use super::context::{
    AiTaskContract, AiTaskRole, ContextError, ContextEvidenceRef, ContextPackage,
    ContextSectionAudit, ContextSectionKind, format_task_contract,
};

pub const REVIEW_CLAIM_EXTRACTION_PROMPT_VERSION: &str = "r6.0-review-claim-extraction-v1";
pub const REVIEW_SEMANTIC_PROMPT_VERSION: &str = "r6.0-review-semantic-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewSourceBlock {
    pub block_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewClaimExtractionInput {
    pub review_purpose: novel_domain::ReviewPurpose,
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub chapter_title: String,
    pub blocks: Vec<ReviewSourceBlock>,
    pub locked_rules: String,
    pub input_token_budget: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSemanticInput {
    pub review_purpose: novel_domain::ReviewPurpose,
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub claims: Vec<novel_domain::ReviewClaim>,
    pub evidence: Vec<novel_domain::ReviewEvidence>,
    pub input_token_budget: u32,
}

#[derive(Debug, Error)]
pub enum ReviewContextError {
    #[error("review context serialization failed: {0}")]
    Serialization(String),
}

pub struct ReviewScopeBuilder;

impl ReviewScopeBuilder {
    /// Builds the first-stage context containing only the review target and
    /// locked rules. Project retrieval is intentionally absent.
    ///
    /// # Errors
    ///
    /// Returns [`ReviewContextError`] when the source blocks cannot be
    /// serialized into the fixed output contract.
    pub fn claim_extraction(
        input: &ReviewClaimExtractionInput,
    ) -> Result<ContextPackage, ReviewContextError> {
        let (labels, scope) = purpose_labels(input.review_purpose);
        let blocks_json = serde_json::to_string(&input.blocks)
            .map_err(|error| ReviewContextError::Serialization(error.to_string()))?;
        let task_contract = AiTaskContract {
            role: AiTaskRole::ReviewClaimExtractor,
            goal: format!("从{labels}中提取可逐字定位的待核对事实声明，不判断冲突。"),
            target_type: "REVIEW_TARGET".to_owned(),
            target_id: input.chapter_id,
            target_revision_id: input.target_revision_id,
            permissions: vec!["只读取本次审核目标和作者锁定规则。".to_owned()],
            forbidden_actions: vec![
                "不得判断声明是否冲突。".to_owned(),
                "不得补写审核目标中不存在的事实。".to_owned(),
                "不得读取或引用未提供的作品资料。".to_owned(),
            ],
            acceptance_criteria: vec![
                "每条声明的 quote 必须逐字来自对应 blockId 的原文。".to_owned(),
                "无法逐字定位的内容不得输出。".to_owned(),
                "只输出固定 JSON 对象。".to_owned(),
            ],
            uncertainty_policy: "正文没有明确表达的事实不得作为声明提取。".to_owned(),
            output_contract: claim_extraction_output_contract(input.review_purpose),
        };
        let system_prompt = format!(
            "你是小说{labels}声明提取器。你只回答“目标文本作出了哪些值得核对的事实声明”，不进行一致性判断，不扩写、不推断隐含设定。{scope}"
        );
        let user_prompt = format!(
            "{}\n\n[作者锁定规则]\n{}\n\n[审核目标块 JSON]\n{blocks_json}",
            format_task_contract(&task_contract, input.chapter_title.trim()),
            if input.locked_rules.trim().is_empty() {
                "无"
            } else {
                input.locked_rules.trim()
            }
        );
        Ok(build_review_context(
            input.chapter_id,
            input.target_revision_id,
            input.review_purpose,
            input.input_token_budget,
            REVIEW_CLAIM_EXTRACTION_PROMPT_VERSION,
            system_prompt,
            user_prompt,
            task_contract,
            vec![ContextSectionAudit {
                kind: ContextSectionKind::References,
                priority: 0,
                source_count: u16::try_from(input.blocks.len()).unwrap_or(u16::MAX),
                included_chars: u32::try_from(blocks_json.chars().count()).unwrap_or(u32::MAX),
                truncated: false,
            }],
        ))
    }

    /// Builds the semantic adjudication context containing one small claim
    /// batch and only the evidence resolved for those claims.
    ///
    /// # Errors
    ///
    /// Returns [`ReviewContextError`] when claims or evidence cannot be
    /// serialized into the fixed review contract.
    pub fn semantic_review(
        input: &ReviewSemanticInput,
    ) -> Result<ContextPackage, ReviewContextError> {
        let (labels, _) = purpose_labels(input.review_purpose);
        let claims_json = serde_json::to_string(&input.claims)
            .map_err(|error| ReviewContextError::Serialization(error.to_string()))?;
        let evidence_json = serde_json::to_string(&input.evidence)
            .map_err(|error| ReviewContextError::Serialization(error.to_string()))?;
        let task_contract = AiTaskContract {
            role: AiTaskRole::ReviewSemanticAdjudicator,
            goal: format!("逐条复核{labels}声明与对应正式证据之间的语义冲突。"),
            target_type: "REVIEW_BATCH".to_owned(),
            target_id: input.chapter_id,
            target_revision_id: input.target_revision_id,
            permissions: vec!["只读取本批声明及其证据。".to_owned()],
            forbidden_actions: vec![
                "不得引用本批证据之外的资料。".to_owned(),
                "不得把没有证据支持的判断标记为阻断或警告。".to_owned(),
                "不得修改正文或正式知识。".to_owned(),
            ],
            acceptance_criteria: vec![
                "每条 finding 必须引用 claimId 和实际存在的 evidenceIds。".to_owned(),
                "没有正式证据时返回 UNKNOWN，不得返回 BLOCK。".to_owned(),
                "只输出固定 JSON 对象。".to_owned(),
            ],
            uncertainty_policy:
                "证据不足、证据与声明缺乏直接语义关系或无法形成互斥结论时返回 UNKNOWN。".to_owned(),
            output_contract: semantic_review_output_contract(),
        };
        let system_prompt = format!(
            "你是小说{labels}语义复核器。你只依据本批声明和证据工作，不得重新注入全作品上下文，也不得作出最终写入决定。"
        );
        let user_prompt = format!(
            "{}\n\n[声明 JSON]\n{claims_json}\n\n[证据 JSON]\n{evidence_json}",
            format_task_contract(&task_contract, "声明证据复核")
        );
        Ok(build_review_context(
            input.chapter_id,
            input.target_revision_id,
            input.review_purpose,
            input.input_token_budget,
            REVIEW_SEMANTIC_PROMPT_VERSION,
            system_prompt,
            user_prompt,
            task_contract,
            vec![
                ContextSectionAudit {
                    kind: ContextSectionKind::AuthoritativeFacts,
                    priority: 0,
                    source_count: u16::try_from(input.claims.len()).unwrap_or(u16::MAX),
                    included_chars: u32::try_from(claims_json.chars().count()).unwrap_or(u32::MAX),
                    truncated: false,
                },
                ContextSectionAudit {
                    kind: ContextSectionKind::References,
                    priority: 1,
                    source_count: u16::try_from(input.evidence.len()).unwrap_or(u16::MAX),
                    included_chars: u32::try_from(evidence_json.chars().count())
                        .unwrap_or(u32::MAX),
                    truncated: false,
                },
            ],
        ))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReviewContextIdentity<'a> {
    chapter_id: Uuid,
    target_revision_id: Option<Uuid>,
    review_purpose: novel_domain::ReviewPurpose,
    prompt_version: &'a str,
    system_prompt: &'a str,
    user_prompt: &'a str,
}

#[allow(clippy::too_many_arguments)]
fn build_review_context(
    chapter_id: Uuid,
    target_revision_id: Option<Uuid>,
    review_purpose: novel_domain::ReviewPurpose,
    input_token_budget: u32,
    prompt_version: &str,
    system_prompt: String,
    user_prompt: String,
    task_contract: AiTaskContract,
    section_audit: Vec<ContextSectionAudit>,
) -> ContextPackage {
    let identity = ReviewContextIdentity {
        chapter_id,
        target_revision_id,
        review_purpose,
        prompt_version,
        system_prompt: &system_prompt,
        user_prompt: &user_prompt,
    };
    let context_version = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_string(&identity)
                .unwrap_or_default()
                .as_bytes()
        )
    );
    let estimated_input_tokens =
        u32::try_from((system_prompt.chars().count() + user_prompt.chars().count()).div_ceil(4))
            .unwrap_or(u32::MAX)
            .min(input_token_budget);
    ContextPackage {
        chapter_id,
        target_revision_id,
        action: novel_domain::AiAction::ConsistencyCheck,
        context_version,
        prompt_version: prompt_version.to_owned(),
        system_prompt,
        user_prompt,
        estimated_input_tokens,
        truncated: false,
        entity_source_status: "NOT_USED".to_owned(),
        retrieval_evidence: Vec::<ContextEvidenceRef>::new(),
        task_contract,
        section_audit,
    }
}

fn purpose_labels(purpose: novel_domain::ReviewPurpose) -> (&'static str, &'static str) {
    match purpose {
        novel_domain::ReviewPurpose::Admission => {
            ("创作准入", "只提取执行卡和阶段约束中的准入声明。")
        }
        novel_domain::ReviewPurpose::Manuscript => ("正文审核", "只提取正文明确写出的事实声明。"),
    }
}

fn claim_extraction_output_contract(purpose: novel_domain::ReviewPurpose) -> String {
    let types = match purpose {
        novel_domain::ReviewPurpose::Admission => {
            "REQUIRED_EVENT|FORBIDDEN_EVENT|ALLOWED_CHARACTER|TIME_WINDOW|STAGE_BOUNDARY|FORESHADOWING_WINDOW|PLAN_DEPENDENCY"
        }
        novel_domain::ReviewPurpose::Manuscript => {
            "CHARACTER_STATUS|CHARACTER_LOCATION|ABILITY_OR_REALM|ITEM_POSSESSION|RELATION|KNOWLEDGE_BOUNDARY"
        }
    };
    format!(
        "严格 JSON 对象：{{\"claims\":[{{\"type\":\"{types}\",\"subject\":\"\",\"predicate\":\"\",\"object\":\"\",\"quote\":\"\",\"blockId\":\"\",\"importance\":1,\"confidence\":0}}]}}。importance 为 1-5，confidence 为 0-100。不要 Markdown，不要解释。"
    )
}

fn semantic_review_output_contract() -> String {
    "严格 JSON 对象：{\"summary\":\"\",\"findings\":[{\"claimId\":\"UUID\",\"status\":\"PASS|NOTICE|WARNING|BLOCK|UNKNOWN\",\"severity\":\"BLOCKER|MAJOR|MINOR|INFO\",\"problem\":\"\",\"evidenceIds\":[\"UUID\"],\"suggestion\":\"\",\"confidence\":0}],\"omitted\":[{\"label\":\"\",\"reason\":\"\"}]}。不要 Markdown，不要解释。"
        .to_owned()
}

impl From<ReviewContextError> for ContextError {
    fn from(value: ReviewContextError) -> Self {
        Self::InvalidDocument(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use novel_domain::{
        EvidenceAuthority, ReviewClaim, ReviewClaimType, ReviewEvidence, ReviewPurpose,
    };

    #[test]
    fn review_stages_keep_unrelated_project_context_out() {
        let chapter_id = Uuid::new_v4();
        let claim_id = Uuid::new_v4();
        let extraction = ReviewScopeBuilder::claim_extraction(&ReviewClaimExtractionInput {
            review_purpose: ReviewPurpose::Manuscript,
            chapter_id,
            target_revision_id: Some(Uuid::new_v4()),
            chapter_title: "第一章".to_owned(),
            blocks: vec![ReviewSourceBlock {
                block_id: "block-1".to_owned(),
                text: "林澈抵达城门。".to_owned(),
            }],
            locked_rules: "人物死亡后不得再次正常出场。".to_owned(),
            input_token_budget: 4_096,
        })
        .expect("claim context");
        assert!(extraction.user_prompt.contains("林澈抵达城门"));
        assert!(
            extraction
                .user_prompt
                .contains("人物死亡后不得再次正常出场")
        );
        assert!(!extraction.user_prompt.contains("无关作品全量摘要"));

        let semantic = ReviewScopeBuilder::semantic_review(&ReviewSemanticInput {
            review_purpose: ReviewPurpose::Manuscript,
            chapter_id,
            target_revision_id: None,
            claims: vec![ReviewClaim {
                id: claim_id,
                claim_type: ReviewClaimType::CharacterLocation,
                subject: "林澈".to_owned(),
                predicate: "位于".to_owned(),
                object: "城门".to_owned(),
                quote: "林澈抵达城门".to_owned(),
                block_id: "block-1".to_owned(),
                start_offset: 0,
                end_offset: 6,
                importance: 4,
                confidence: 90,
            }],
            evidence: vec![ReviewEvidence {
                id: Uuid::new_v4(),
                claim_id,
                source_kind: "WORLD_STATE".to_owned(),
                source_record_id: Uuid::new_v4(),
                authority: EvidenceAuthority::CurrentState,
                excerpt: "林澈位于城门。".to_owned(),
                source_revision: "world-state-v1".to_owned(),
                relevance: 9_000,
            }],
            input_token_budget: 4_096,
        })
        .expect("semantic context");
        assert!(semantic.user_prompt.contains("林澈位于城门"));
        assert!(!semantic.user_prompt.contains("无关作品全量摘要"));
        assert_ne!(extraction.context_version, semantic.context_version);
    }
}
