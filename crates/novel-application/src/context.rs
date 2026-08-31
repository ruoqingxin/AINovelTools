use novel_domain::{AiAction, AiContractError, RetrievalEvidence};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

pub const PROMPT_VERSION: &str = "r3-writing-v2";
const TRUNCATION_MARKER: &str = "[已按 TokenBudget 截断]";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RetrievalIntent {
    CurrentChapterOnly,
    ProjectKnowledge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RetrievalPlanReason {
    CurrentChapterIsSufficient,
    KnowledgeUnavailable,
    ProjectKnowledgeRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalAvailability {
    pub knowledge_available: bool,
    pub keyword_index_ready: bool,
    pub semantic_index_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalPlan {
    pub methods: Vec<novel_domain::RetrievalMethod>,
    pub max_candidates: u16,
    pub max_attached_chunks: u16,
    pub reason: RetrievalPlanReason,
}

pub struct RetrievalPlanner;

impl RetrievalPlanner {
    #[must_use]
    pub fn plan(intent: RetrievalIntent, availability: &RetrievalAvailability) -> RetrievalPlan {
        if intent == RetrievalIntent::CurrentChapterOnly {
            return RetrievalPlan {
                methods: Vec::new(),
                max_candidates: 0,
                max_attached_chunks: 0,
                reason: RetrievalPlanReason::CurrentChapterIsSufficient,
            };
        }
        if !availability.knowledge_available {
            return RetrievalPlan {
                methods: Vec::new(),
                max_candidates: 0,
                max_attached_chunks: 0,
                reason: RetrievalPlanReason::KnowledgeUnavailable,
            };
        }

        let mut methods = vec![novel_domain::RetrievalMethod::Structured];
        if availability.keyword_index_ready {
            methods.push(novel_domain::RetrievalMethod::Keyword);
        }
        if availability.semantic_index_ready {
            methods.push(novel_domain::RetrievalMethod::Semantic);
        }
        RetrievalPlan {
            methods,
            max_candidates: 24,
            max_attached_chunks: 8,
            reason: RetrievalPlanReason::ProjectKnowledgeRequested,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssembleContextInput {
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub action: AiAction,
    pub chapter_title: String,
    pub chapter_plan: String,
    pub document_json: String,
    pub selection: Option<String>,
    pub instruction: Option<String>,
    pub input_token_budget: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiTaskRole {
    DraftWriter,
    SelectionReviser,
    ChapterSummarizer,
    ApiConnectionTester,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskContract {
    pub role: AiTaskRole,
    pub goal: String,
    pub target_type: String,
    pub target_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub permissions: Vec<String>,
    pub forbidden_actions: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub uncertainty_policy: String,
    pub output_contract: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContextSectionKind {
    TaskContract,
    UserInstruction,
    AuthoritativeFacts,
    ChapterPlan,
    CurrentState,
    CurrentDraft,
    StyleRules,
    References,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSectionAudit {
    pub kind: ContextSectionKind,
    pub priority: u8,
    pub source_count: u16,
    pub included_chars: u32,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackage {
    pub chapter_id: Uuid,
    pub target_revision_id: Option<Uuid>,
    pub action: AiAction,
    pub context_version: String,
    pub prompt_version: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub estimated_input_tokens: u32,
    pub truncated: bool,
    pub entity_source_status: String,
    pub retrieval_evidence: Vec<ContextEvidenceRef>,
    pub task_contract: AiTaskContract,
    pub section_audit: Vec<ContextSectionAudit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvidenceRef {
    pub chunk_id: Uuid,
    pub source_id: Uuid,
    pub source_revision: String,
    pub source_hash: String,
    pub method: novel_domain::RetrievalMethod,
    pub authority: novel_domain::ContextAuthority,
}

impl ContextPackage {
    #[must_use]
    pub fn connection_test() -> Self {
        let task_contract = AiTaskContract {
            role: AiTaskRole::ApiConnectionTester,
            goal: "验证云端 Chat API 能够返回最小响应。".to_owned(),
            target_type: "CONNECTION".to_owned(),
            target_id: Uuid::nil(),
            target_revision_id: None,
            permissions: vec!["返回固定测试文本。".to_owned()],
            forbidden_actions: vec!["不得执行创作任务。".to_owned()],
            acceptance_criteria: vec!["成功返回非空响应。".to_owned()],
            uncertainty_policy: "不适用。".to_owned(),
            output_contract: "只回复 OK。".to_owned(),
        };
        Self {
            chapter_id: Uuid::nil(),
            target_revision_id: None,
            action: AiAction::Summarize,
            context_version: "connection-test-v2".to_owned(),
            prompt_version: "connection-test-v2".to_owned(),
            system_prompt: "你是 API 连接测试服务。".to_owned(),
            user_prompt: "只回复 OK。".to_owned(),
            estimated_input_tokens: 16,
            truncated: false,
            entity_source_status: "NOT_USED".to_owned(),
            retrieval_evidence: Vec::new(),
            task_contract,
            section_audit: Vec::new(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContextError {
    #[error(transparent)]
    Contract(#[from] AiContractError),
    #[error("document JSON is invalid: {0}")]
    InvalidDocument(String),
    #[error("input token budget must be at least 256")]
    BudgetTooSmall,
}

pub struct ContextAssembler;

impl ContextAssembler {
    /// Compiles a natural-language writing request into versioned model messages.
    ///
    /// The returned package is the adapter-neutral contract sent to a cloud
    /// provider. The provider adapter is responsible only for translating this
    /// contract into its HTTP request shape; it must not invent story context.
    ///
    /// # Errors
    ///
    /// Returns [`ContextError`] when the document is invalid, the input budget
    /// is too small, or an action that requires a selection has no selection.
    pub fn assemble(input: &AssembleContextInput) -> Result<ContextPackage, ContextError> {
        Self::assemble_with_retrieval(input, &[])
    }

    /// Compiles model messages with optional, already-retrieved source text.
    ///
    /// Retrieval remains an outer orchestration concern: structured lookup,
    /// keyword search, and semantic search all return the same evidence
    /// contract. This assembler never receives or sends embedding vectors.
    ///
    /// # Errors
    ///
    /// Returns [`ContextError`] when the fixed context is invalid or any
    /// retrieval evidence lacks auditable source metadata.
    pub fn assemble_with_retrieval(
        input: &AssembleContextInput,
        evidence: &[RetrievalEvidence],
    ) -> Result<ContextPackage, ContextError> {
        if input.input_token_budget < 256 {
            return Err(ContextError::BudgetTooSmall);
        }
        for item in evidence {
            item.validate()?;
        }
        let selection = input.selection.as_deref().unwrap_or("").trim();
        if input.action.requires_selection() && selection.is_empty() {
            return Err(AiContractError::SelectionRequired.into());
        }
        let document = document_text(&input.document_json)?;
        let task_contract = build_task_contract(input);
        let system_prompt = format!(
            "你是{}。你是有边界的认知服务，不是项目事实数据库，也没有最终裁决权。严格服从任务合同和 P0-P6 权威顺序；高优先级与低优先级冲突时采用高优先级，不得自行融合。只根据本次提供的材料工作，不得把模型记忆、推测或新生成细节写成已批准事实。所有输出都只是候选，不能声称已修改正式正文或项目知识。",
            role_label(task_contract.role)
        );
        let compiled_retrieval = compile_retrieval_evidence(evidence);
        let mut sections = build_prompt_sections(
            input,
            selection,
            document,
            &task_contract,
            &compiled_retrieval,
        );
        let character_budget = usize::try_from(input.input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(4);
        let (user_prompt, section_audit, truncated) = compile_sections(
            &mut sections,
            character_budget.saturating_sub(system_prompt.chars().count()),
        );
        let retrieval_evidence = compiled_retrieval.evidence_refs;
        let entity_source_status = compiled_retrieval.source_status;
        let canonical = serde_json::json!({
            "chapterId": input.chapter_id,
            "targetRevisionId": input.target_revision_id,
            "action": input.action,
            "promptVersion": PROMPT_VERSION,
            "system": system_prompt,
            "user": user_prompt,
            "retrievalEvidence": retrieval_evidence,
            "taskContract": task_contract,
            "sectionAudit": section_audit,
        });
        let context_version = format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()));
        let estimated_input_tokens = u32::try_from(
            (system_prompt.chars().count() + user_prompt.chars().count()).div_ceil(4),
        )
        .unwrap_or(u32::MAX);
        Ok(ContextPackage {
            chapter_id: input.chapter_id,
            target_revision_id: input.target_revision_id,
            action: input.action,
            context_version,
            prompt_version: PROMPT_VERSION.to_owned(),
            system_prompt,
            user_prompt,
            estimated_input_tokens,
            truncated,
            entity_source_status,
            retrieval_evidence,
            task_contract,
            section_audit,
        })
    }
}

struct PromptSection {
    kind: ContextSectionKind,
    priority: u8,
    title: &'static str,
    content: String,
    source_count: u16,
    truncate_from_tail: bool,
}

impl PromptSection {
    fn new(
        kind: ContextSectionKind,
        priority: u8,
        title: &'static str,
        content: String,
        source_count: u16,
    ) -> Self {
        Self {
            kind,
            priority,
            title,
            content,
            source_count,
            truncate_from_tail: false,
        }
    }

    const fn truncate_from_tail(mut self, enabled: bool) -> Self {
        self.truncate_from_tail = enabled;
        self
    }
}

struct CompiledRetrieval {
    authoritative_facts: String,
    authoritative_count: u16,
    task_materials: String,
    task_material_count: u16,
    references: String,
    reference_count: u16,
    evidence_refs: Vec<ContextEvidenceRef>,
    source_status: String,
}

fn build_prompt_sections(
    input: &AssembleContextInput,
    selection: &str,
    document: String,
    task_contract: &AiTaskContract,
    retrieval: &CompiledRetrieval,
) -> Vec<PromptSection> {
    let user_material = format!(
        "用户要求：{}\n处理选区：{}",
        input.instruction.as_deref().unwrap_or("无").trim(),
        if selection.is_empty() {
            "无"
        } else {
            selection
        }
    );
    vec![
        PromptSection::new(
            ContextSectionKind::TaskContract,
            0,
            "任务合同",
            format_task_contract(task_contract, input.chapter_title.trim()),
            1,
        ),
        PromptSection::new(
            ContextSectionKind::UserInstruction,
            0,
            "用户本次明确指令",
            user_material,
            1,
        ),
        PromptSection::new(
            ContextSectionKind::AuthoritativeFacts,
            1,
            "已批准事实",
            non_empty_or(
                retrieval.authoritative_facts.clone(),
                "R4 尚未启用正式知识库，本次没有已批准事实来源。",
            ),
            retrieval.authoritative_count,
        ),
        PromptSection::new(
            ContextSectionKind::ChapterPlan,
            2,
            "已批准章节规划",
            non_empty_or(input.chapter_plan.trim().to_owned(), "未提供章节规划。"),
            u16::from(!input.chapter_plan.trim().is_empty()),
        ),
        PromptSection::new(
            ContextSectionKind::CurrentState,
            3,
            "故事当前状态",
            non_empty_or(
                retrieval.task_materials.clone(),
                "R4/R5 尚未启用状态快照，本次没有独立状态来源。",
            ),
            retrieval.task_material_count,
        ),
        PromptSection::new(
            ContextSectionKind::CurrentDraft,
            4,
            "当前编辑草稿",
            non_empty_or(document, "当前草稿为空。"),
            1,
        )
        .truncate_from_tail(input.action != AiAction::Summarize),
        PromptSection::new(
            ContextSectionKind::StyleRules,
            5,
            "风格规范",
            "没有独立风格卡；仅执行 P0 用户指令中明确给出的风格要求。".to_owned(),
            0,
        ),
        PromptSection::new(
            ContextSectionKind::References,
            6,
            "参考信息",
            non_empty_or(
                retrieval.references.clone(),
                "本次没有参考资料；不得用模型记忆补充项目事实。",
            ),
            retrieval.reference_count,
        ),
    ]
}

fn build_task_contract(input: &AssembleContextInput) -> AiTaskContract {
    let (role, goal, target_type, acceptance_criteria, output_contract) = match input.action {
        AiAction::Continue => (
            AiTaskRole::DraftWriter,
            "从当前草稿结尾继续写作，不复述已有内容。",
            "CHAPTER",
            vec![
                "输出能与当前草稿结尾自然衔接。".to_owned(),
                "不改变已提供事实、章节目标和人物知识边界。".to_owned(),
                "只输出新增候选正文。".to_owned(),
            ],
            "纯文本候选正文；不得附带分析、标题、JSON 或变更声明。",
        ),
        AiAction::Rewrite => (
            AiTaskRole::SelectionReviser,
            "在给定选区范围内重写内容。",
            "SELECTION",
            vec![
                "新文本可完整替换选区。".to_owned(),
                "不得修改选区之外的情节和事实。".to_owned(),
                "只输出替换选区的候选正文。".to_owned(),
            ],
            "纯文本替换候选；不得附带分析、标题、JSON 或变更声明。",
        ),
        AiAction::Polish => (
            AiTaskRole::SelectionReviser,
            "润色给定选区并保持原意。",
            "SELECTION",
            vec![
                "保持选区事实、视角、情节结果和人物意图不变。".to_owned(),
                "改善语言表达但不扩大修改范围。".to_owned(),
                "只输出润色后的候选正文。".to_owned(),
            ],
            "纯文本润色候选；不得附带分析、标题、JSON 或变更声明。",
        ),
        AiAction::Summarize => (
            AiTaskRole::ChapterSummarizer,
            "总结当前章节，供后续上下文使用。",
            "CHAPTER",
            vec![
                "覆盖章节中已发生的关键事件和状态变化。".to_owned(),
                "区分正文事实与无法确认的信息。".to_owned(),
                "保持简洁，不引入正文之外的新事实。".to_owned(),
            ],
            "纯文本章节摘要；不得附带分析、标题、JSON 或变更声明。",
        ),
    };
    AiTaskContract {
        role,
        goal: goal.to_owned(),
        target_type: target_type.to_owned(),
        target_id: input.chapter_id,
        target_revision_id: input.target_revision_id,
        permissions: vec![
            "读取本次上下文包。".to_owned(),
            "生成一个待用户审核的候选结果。".to_owned(),
        ],
        forbidden_actions: vec![
            "不得修改、发布或声称已修改正式正文。".to_owned(),
            "不得把模型记忆、推测或新生成细节当作项目事实。".to_owned(),
            "不得越过本次目标对象和修改范围。".to_owned(),
        ],
        acceptance_criteria,
        uncertainty_policy: "关键依据不足或上下文冲突时停止推断，输出“[上下文不足]”并简要列出缺少的信息；不得自行补全项目事实。".to_owned(),
        output_contract: output_contract.to_owned(),
    }
}

fn role_label(role: AiTaskRole) -> &'static str {
    match role {
        AiTaskRole::DraftWriter => "小说候选正文执行器",
        AiTaskRole::SelectionReviser => "小说选区修订执行器",
        AiTaskRole::ChapterSummarizer => "小说章节摘要执行器",
        AiTaskRole::ApiConnectionTester => "API 连接测试器",
    }
}

fn format_task_contract(contract: &AiTaskContract, chapter_title: &str) -> String {
    format!(
        "角色：{}\n目标：{}\n当前对象：章节“{}”，类型 {}，ID {}，目标修订 {}\n权限：{}\n禁区：{}\n不确定性处理：{}\n验收标准：{}\n输出合同：{}",
        role_label(contract.role),
        contract.goal,
        chapter_title,
        contract.target_type,
        contract.target_id,
        contract
            .target_revision_id
            .map_or_else(|| "未保存草稿".to_owned(), |id| id.to_string()),
        contract.permissions.join("；"),
        contract.forbidden_actions.join("；"),
        contract.uncertainty_policy,
        contract.acceptance_criteria.join("；"),
        contract.output_contract,
    )
}

fn compile_sections(
    sections: &mut [PromptSection],
    character_budget: usize,
) -> (String, Vec<ContextSectionAudit>, bool) {
    let mut rendered = Vec::with_capacity(sections.len());
    let mut audits = Vec::with_capacity(sections.len());
    let mut remaining = character_budget;
    let mut any_truncated = false;
    for (index, section) in sections.iter().enumerate() {
        if index > 0 {
            remaining = remaining.saturating_sub(2);
        }
        let header = format!("[P{} {}]\n", section.priority, section.title);
        let header_chars = header.chars().count();
        let content_budget = remaining.saturating_sub(header_chars);
        let (content, truncated) =
            truncate_content(&section.content, content_budget, section.truncate_from_tail);
        let text = if remaining >= header_chars {
            format!("{header}{content}")
        } else {
            header.chars().take(remaining).collect()
        };
        let included_chars = text.chars().count();
        remaining = remaining.saturating_sub(included_chars);
        any_truncated |= truncated || included_chars < header_chars;
        audits.push(ContextSectionAudit {
            kind: section.kind,
            priority: section.priority,
            source_count: section.source_count,
            included_chars: u32::try_from(included_chars).unwrap_or(u32::MAX),
            truncated: truncated || included_chars < header_chars,
        });
        rendered.push(text);
    }
    (rendered.join("\n\n"), audits, any_truncated)
}

fn truncate_content(content: &str, limit: usize, from_tail: bool) -> (String, bool) {
    let length = content.chars().count();
    if length <= limit {
        return (content.to_owned(), false);
    }
    let marker_length = TRUNCATION_MARKER.chars().count();
    if limit <= marker_length {
        return (TRUNCATION_MARKER.chars().take(limit).collect(), true);
    }
    let keep = limit - marker_length;
    let kept = if from_tail {
        content
            .chars()
            .skip(length.saturating_sub(keep))
            .collect::<String>()
    } else {
        content.chars().take(keep).collect::<String>()
    };
    if from_tail {
        (format!("{TRUNCATION_MARKER}{kept}"), true)
    } else {
        (format!("{kept}{TRUNCATION_MARKER}"), true)
    }
}

fn non_empty_or(value: String, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

fn compile_retrieval_evidence(evidence: &[RetrievalEvidence]) -> CompiledRetrieval {
    if evidence.is_empty() {
        return CompiledRetrieval {
            authoritative_facts: String::new(),
            authoritative_count: 0,
            task_materials: String::new(),
            task_material_count: 0,
            references: String::new(),
            reference_count: 0,
            evidence_refs: Vec::new(),
            source_status: "R4_NOT_AVAILABLE".to_owned(),
        };
    }

    let mut ordered = evidence.to_vec();
    ordered.sort_by(|left, right| {
        right
            .relevance
            .cmp(&left.relevance)
            .then_with(|| left.chunk.id.cmp(&right.chunk.id))
    });
    let mut seen = HashSet::new();
    ordered.retain(|item| seen.insert(item.chunk.id));

    let mut authoritative_facts = Vec::new();
    let mut task_materials = Vec::new();
    let mut references = Vec::new();
    let mut evidence_refs = Vec::with_capacity(ordered.len());
    for (index, item) in ordered.into_iter().enumerate() {
        let text = format!(
            "[证据 {} | {} | 来源修订 {}]\n{}",
            index + 1,
            retrieval_method_label(item.method),
            item.chunk.source_revision,
            item.chunk.content.trim()
        );
        match item.authority {
            novel_domain::ContextAuthority::AuthoritativeFact => authoritative_facts.push(text),
            novel_domain::ContextAuthority::TaskMaterial => task_materials.push(text),
            novel_domain::ContextAuthority::Reference => references.push(text),
        }
        evidence_refs.push(ContextEvidenceRef {
            chunk_id: item.chunk.id,
            source_id: item.chunk.source_id,
            source_revision: item.chunk.source_revision,
            source_hash: item.chunk.source_hash,
            method: item.method,
            authority: item.authority,
        });
    }
    let source_status = if evidence
        .iter()
        .any(|item| item.chunk.source_revision == "search:current")
    {
        "SOURCE_VERSION_UNVERIFIED"
    } else {
        "RETRIEVAL_ATTACHED"
    };
    CompiledRetrieval {
        authoritative_count: u16::try_from(authoritative_facts.len()).unwrap_or(u16::MAX),
        authoritative_facts: authoritative_facts.join("\n\n"),
        task_material_count: u16::try_from(task_materials.len()).unwrap_or(u16::MAX),
        task_materials: task_materials.join("\n\n"),
        reference_count: u16::try_from(references.len()).unwrap_or(u16::MAX),
        references: references.join("\n\n"),
        evidence_refs,
        source_status: source_status.to_owned(),
    }
}

fn retrieval_method_label(method: novel_domain::RetrievalMethod) -> &'static str {
    match method {
        novel_domain::RetrievalMethod::Structured => "结构化查询",
        novel_domain::RetrievalMethod::Keyword => "关键词检索",
        novel_domain::RetrievalMethod::Semantic => "语义检索",
    }
}

fn document_text(document_json: &str) -> Result<String, ContextError> {
    let value: serde_json::Value = serde_json::from_str(document_json)
        .map_err(|error| ContextError::InvalidDocument(error.to_string()))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
        return Err(ContextError::InvalidDocument(
            "root type must be doc".to_owned(),
        ));
    }
    let mut output = Vec::new();
    collect_document_text(&value, &mut output);
    Ok(output.concat().trim().to_owned())
}

fn collect_document_text(value: &serde_json::Value, output: &mut Vec<String>) {
    if value.get("type").and_then(serde_json::Value::as_str) == Some("text")
        && let Some(text) = value.get("text").and_then(serde_json::Value::as_str)
    {
        output.push(text.to_owned());
    }
    if let Some(children) = value.get("content").and_then(serde_json::Value::as_array) {
        for child in children {
            collect_document_text(child, output);
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("paragraph") {
            output.push("\n".to_owned());
        }
    }
}
