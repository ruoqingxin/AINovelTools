use novel_domain::{AiAction, AiContractError, RetrievalEvidence};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

pub const PROMPT_VERSION: &str = "r5.1-writing-v1";
const DISCUSSION_PROMPT_VERSION: &str = "r5.1-discussion-v3";
const TRUNCATION_MARKER: &str = "[已按 TokenBudget 截断]";

/// Conservative upper bound used when converting a token budget to text.
/// Chinese characters can occupy roughly one token each, so a 1:1 budget is
/// intentionally stricter than the old 4:1 character estimate.
const CONSERVATIVE_CHARS_PER_TOKEN: usize = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextCandidateKind {
    ProjectSetting,
    AuthorSetting,
    AuthoritativeFact,
    CurrentState,
    Entity,
    Relation,
    Belief,
    Foreshadowing,
    Summary,
    Event,
    Keyword,
}

impl ContextCandidateKind {
    const fn priority(self) -> u8 {
        match self {
            Self::ProjectSetting => 0,
            Self::AuthorSetting => 1,
            Self::AuthoritativeFact => 2,
            Self::CurrentState => 3,
            Self::Entity => 4,
            Self::Relation => 5,
            Self::Belief => 6,
            Self::Foreshadowing => 7,
            Self::Summary => 8,
            Self::Event => 9,
            Self::Keyword => 10,
        }
    }

    const fn max_attached(self) -> usize {
        match self {
            Self::ProjectSetting | Self::Foreshadowing | Self::Summary | Self::Event => 1,
            Self::AuthorSetting => 3,
            Self::AuthoritativeFact | Self::Keyword => 4,
            Self::CurrentState | Self::Entity | Self::Relation | Self::Belief => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextCandidate {
    pub kind: ContextCandidateKind,
    pub evidence: RetrievalEvidence,
}

impl ContextCandidate {
    #[must_use]
    pub const fn new(kind: ContextCandidateKind, evidence: RetrievalEvidence) -> Self {
        Self { kind, evidence }
    }
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

pub struct ContextPlanner;

impl ContextPlanner {
    #[must_use]
    pub fn plan(
        candidates: &[ContextCandidate],
        max_candidates: u16,
        max_attached_chunks: u16,
    ) -> Vec<RetrievalEvidence> {
        let candidate_limit = usize::from(max_candidates);
        let attachment_limit = usize::from(max_attached_chunks);
        if candidate_limit == 0 || attachment_limit == 0 {
            return Vec::new();
        }

        let mut seen = HashSet::new();
        let mut grouped = std::array::from_fn::<_, 11, _>(|_| Vec::new());
        for candidate in candidates {
            let normalized_content = candidate
                .evidence
                .chunk
                .content
                .split_whitespace()
                .collect::<String>()
                .to_lowercase();
            if seen.insert((candidate.evidence.chunk.source_id, normalized_content)) {
                grouped[usize::from(candidate.kind.priority())].push(candidate);
            }
        }
        for group in &mut grouped {
            group.sort_by(|left, right| {
                right
                    .evidence
                    .relevance
                    .cmp(&left.evidence.relevance)
                    .then_with(|| left.evidence.chunk.id.cmp(&right.evidence.chunk.id))
            });
        }

        // Keep every available evidence kind visible before filling extra slots by priority.
        let ordered = grouped
            .iter()
            .filter_map(|group| group.first().copied())
            .chain(
                grouped
                    .iter()
                    .flat_map(|group| group.iter().skip(1).copied()),
            )
            .take(candidate_limit);

        let mut selected = Vec::with_capacity(attachment_limit);
        let mut kind_counts = [0usize; 11];
        for candidate in ordered {
            if selected.len() == attachment_limit {
                break;
            }
            let count = &mut kind_counts[usize::from(candidate.kind.priority())];
            if *count >= candidate.kind.max_attached() {
                continue;
            }
            *count += 1;
            selected.push(candidate.evidence.clone());
        }
        selected
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
    pub volume_plan: String,
    pub document_json: String,
    pub selection: Option<String>,
    pub instruction: Option<String>,
    pub input_token_budget: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionContextInput {
    pub scope_label: String,
    pub scope_content: String,
    pub history: String,
    pub user_message: String,
    pub input_token_budget: u32,
    #[serde(default)]
    pub focus: Option<DiscussionFocus>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionFocus {
    pub topic_kind: String,
    pub linked_entity_id: Option<Uuid>,
    pub chosen: String,
    pub alternatives: String,
    pub questions: String,
    /// Only recent author messages, not old AI proposals.
    pub recent_topic: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AiTaskRole {
    DraftWriter,
    SelectionReviser,
    ChapterSummarizer,
    ContinuityAuditor,
    ReviewClaimExtractor,
    ReviewSemanticAdjudicator,
    DiscussionFacilitator,
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
    ProjectSettings,
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
    pub fn with_review_purpose(mut self, purpose: novel_domain::ReviewPurpose) -> Self {
        let (label, scope) = match purpose {
            novel_domain::ReviewPurpose::Admission => (
                "创作准入",
                "本次只判断当前章节执行卡是否允许进入正文创作。不得把正文审核结论用于放行或阻断写作。",
            ),
            novel_domain::ReviewPurpose::Manuscript => (
                "正文审核",
                "本次只检查当前已成稿正文是否违反已确认事实或正式约束。不得让本次结论参与写作准入。",
            ),
        };
        self.user_prompt = format!("[P0 审核用途：{label}]\n{scope}\n\n{}", self.user_prompt);
        "r5.2-review-purpose-v1".clone_into(&mut self.prompt_version);
        let canonical = serde_json::json!({
            "previousContextVersion": self.context_version,
            "reviewPurpose": purpose,
            "promptVersion": self.prompt_version,
            "userPrompt": self.user_prompt,
        });
        self.context_version = format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()));
        self
    }

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
    #[error(
        "当前模型的输入预算无法容纳完整问题和必要背景，请缩短本条问题或提高输入预算；原文不会被截断发送。"
    )]
    DiscussionQuestionTooLong,
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
            &document,
            &task_contract,
            &compiled_retrieval,
        );
        let character_budget = usize::try_from(input.input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(CONSERVATIVE_CHARS_PER_TOKEN);
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
        let estimated_input_tokens = estimate_input_tokens(&system_prompt, &user_prompt);
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

    /// Compiles a project-bound discussion request without granting write access.
    ///
    /// # Errors
    ///
    /// Returns [`ContextError`] when the budget or retrieval evidence is invalid.
    #[allow(clippy::too_many_lines)]
    pub fn assemble_discussion(
        input: &DiscussionContextInput,
        evidence: &[RetrievalEvidence],
    ) -> Result<ContextPackage, ContextError> {
        Self::assemble_discussion_with_mode(input, evidence, false)
    }

    /// Assembles a candidate-only structured design summary.
    ///
    /// # Errors
    /// Returns [`ContextError`] for invalid evidence or an insufficient budget.
    pub fn assemble_discussion_design(
        input: &DiscussionContextInput,
        evidence: &[RetrievalEvidence],
    ) -> Result<ContextPackage, ContextError> {
        Self::assemble_discussion_with_mode(input, evidence, true)
    }

    #[allow(clippy::too_many_lines)]
    fn assemble_discussion_with_mode(
        input: &DiscussionContextInput,
        evidence: &[RetrievalEvidence],
        design: bool,
    ) -> Result<ContextPackage, ContextError> {
        if input.input_token_budget < 256 {
            return Err(ContextError::BudgetTooSmall);
        }
        for item in evidence {
            item.validate()?;
        }
        let task_contract = AiTaskContract {
            role: AiTaskRole::DiscussionFacilitator,
            goal: if design {
                "仅将提供的讨论和作者选定的构思整理为可审核的实体与作者设定候选，不补写未决内容。"
            } else {
                "以本书背景为出发点，陪作者自由共创角色、物品、环境或剧情；允许探索边界，重大转向由作者决定。"
            }.to_owned(),
            target_type: "PROJECT_DISCUSSION".to_owned(),
            target_id: Uuid::nil(),
            target_revision_id: None,
            permissions: vec![
                "读取本次提供的正式依据、讨论范围和最近讨论。".to_owned(),
                "提出方案、质疑、比较和候选建议。".to_owned(),
            ],
            forbidden_actions: vec![
                "不得修改或声称已修改正式正文、正式规划、正式实体或正式知识。".to_owned(),
                "不得把讨论假设、模型推测或新建议写成已批准事实。".to_owned(),
                "不得要求作者先补全未知设定才能继续讨论。".to_owned(),
            ],
            acceptance_criteria: if design { vec![
                "明确区分已有正式内容、讨论中的推测、新建议和待作者决定事项。".to_owned(),
                "提出多个方向时说明核心体验、收益、代价和受影响内容。".to_owned(),
                "允许结论为暂不决定，并明确哪些内容需要作者确认。".to_owned(),
                "每轮聚焦一两个问题，先回应作者的构思，不要求填写完整角色卡或设定表。".to_owned(),
                "区分作者已选定内容、备选方案和未决问题；不得把全部备选同时当作设定。".to_owned(),
            ] } else { vec![
                "默认贴合本书题材、基调与世界背景；可借鉴其他题材，并自然转化为适合本书的表达。".to_owned(),
                "先回应作者的灵感，按需给有区别的方向，不固定列清单、追问或要求填设定表。".to_owned(),
                "仅在明显改变作品方向或推翻重要设定时简短说明影响，继续探索；作者主动要求的转向不反复警告。".to_owned(),
            ] },
            uncertainty_policy: if design {
                "只使用本次提供的正式依据；没有正式依据时明确说明未检索到，不得声称已经读取完整设定。"
            } else {
                "可以自由提出新想法，但不把新建议或未记录内容说成已有设定；背景不足也可继续讨论，不猜定本书题材，不声称读过未提供的材料。"
            }.to_owned(),
            output_contract: if design {
                "只输出严格 JSON 数组（1-20 项），不加 Markdown。每项包含 entityType（CHARACTER/LOCATION/ITEM/FACTION/CONCEPT）、name、description、aliases（字符串数组）、tags（字符串数组）、attributes（对象）、settings（字符串数组）、visibility（AUTHOR_ONLY/PUBLIC）。根据整段提供的讨论和构思草稿整理候选实体与能力、限制、关系等作者设定。chosen 中的作者选择优先于聊天备选；未决定的字段省略，不得补写或把废弃方案合并。settings 只收录已选定的规则，不收录待发生事件为已发生事实。秘密默认 AUTHOR_ONLY。没有命名时用明确的暂定名，不编造更多背景。不要输出目标 ID、版本或写入指令；候选须由作者编辑确认后入库。"
            } else {
                "自然的纯文本讨论回复，按本轮需要组织内容，不套固定格式；不输出修改后的正式对象。"
            }.to_owned(),
        };
        let system_prompt = if design {
            "你是小说设定整理助手。只根据本次提供的作者选择、草稿、讨论和相关已有设定输出结构化候选，不继续发散或追问。作者已选定内容优先于 AI 曾提出的备选。不得补全未决项、混合互斥方案或把计划事件说成已发生事实。更新已有实体时保留未被作者明确修改的规则和属性。秘密默认作者保留。你没有正式对象写权限，输出须由作者审核确认。".to_owned()
        } else {
            format!(
                "你是{}，是懂这本书的创作伙伴，不是设定审核员。陪作者推敲角色性格与外貌、物品能力与代价、环境氛围与规则以及剧情方向。把本书题材、基调和世界设定当作创作背景，不当作限制新想法的清单。默认贴着本书发挥，允许大胆发散和跨题材借鉴，将借来的灵感自然转化为适合本书的表达，不默默把整本书换成另一种题材。只有明显改变作品方向或推翻重要设定时，用一两句说明变化，再继续探索，由作者决定；作者主动要求转向或已接受变化时顺着讨论，不反复警告。自然回应本轮灵感，按需给少量有区别的方向，不固定追问、列完整表格或做逐项合规检查；背景未定也能开始。尊重草稿中作者已选定的方向，区分已有设定、新建议和正文已发生事件；未公开秘密不能自动成为角色已知信息。你没有正式对象写权限，新想法须由作者选定后再整理确认。",
                role_label(task_contract.role)
            )
        };
        let retrieval = compile_retrieval_evidence_with_mode(evidence, !design);
        let mut sections = vec![
            PromptSection::new(
                ContextSectionKind::TaskContract,
                0,
                "讨论任务合同",
                format_task_contract(&task_contract, &input.scope_label),
                1,
            ),
            PromptSection::new(
                ContextSectionKind::UserInstruction,
                0,
                "作者本次问题",
                input.user_message.trim().to_owned(),
                1,
            ),
            PromptSection::new(
                ContextSectionKind::ChapterPlan,
                1,
                "本次讨论范围",
                format!(
                    "{}\n{}",
                    non_empty_or(input.scope_label.trim().to_owned(), "当前作品"),
                    non_empty_or(
                        input.scope_content.trim().to_owned(),
                        "未提供额外范围材料。"
                    )
                ),
                u16::from(!input.scope_content.trim().is_empty()),
            ),
            PromptSection::new(
                ContextSectionKind::ProjectSettings,
                1,
                "已有正式设定",
                non_empty_or(
                    retrieval.project_settings.clone(),
                    "本次没有可用的正式作品设定；未检索到的内容按未知处理。",
                ),
                retrieval.project_setting_count,
            ),
            PromptSection::new(
                ContextSectionKind::AuthoritativeFacts,
                1,
                "已有正式知识和状态",
                format!(
                    "{}\n\n{}",
                    non_empty_or(
                        retrieval.authoritative_facts.clone(),
                        "本次没有已批准事实来源。",
                    ),
                    non_empty_or(retrieval.task_materials.clone(), "本次没有独立状态来源。")
                ),
                retrieval
                    .authoritative_count
                    .saturating_add(retrieval.task_material_count),
            ),
            PromptSection::new(
                ContextSectionKind::CurrentDraft,
                3,
                "最近讨论",
                non_empty_or(input.history.trim().to_owned(), "尚无历史讨论。"),
                1,
            )
            .truncate_from_tail(true),
            PromptSection::new(
                ContextSectionKind::References,
                6,
                "其他参考",
                non_empty_or(retrieval.references.clone(), "本次没有其他参考资料。"),
                retrieval.reference_count,
            ),
        ];
        let mut character_budget = usize::try_from(input.input_token_budget)
            .unwrap_or(usize::MAX)
            .saturating_mul(CONSERVATIVE_CHARS_PER_TOKEN);
        if !design {
            character_budget = character_budget.min(24_000);
            let fixed = system_prompt.chars().count()
                + sections[0].content.chars().count()
                + input.user_message.trim().chars().count()
                + 400;
            let available = character_budget
                .checked_sub(fixed)
                .filter(|remaining| *remaining >= 256)
                .ok_or(ContextError::DiscussionQuestionTooLong)?;
            let background_budget = (available / 4)
                .max(available.min(1_000))
                .min(available * 2 / 3)
                .min(1_200);
            let flexible = available.saturating_sub(background_budget);
            let mut background = sections.remove(3);
            background.priority = 0;
            background.title = "本书背景与相关设定";
            background.max_content_chars = Some(background_budget);
            sections.insert(1, background);
            for section in &mut sections {
                section.max_content_chars = match section.kind {
                    ContextSectionKind::ChapterPlan => Some((flexible * 12 / 100).min(1_200)),
                    ContextSectionKind::AuthoritativeFacts => {
                        Some((flexible * 30 / 100).min(4_000))
                    }
                    ContextSectionKind::CurrentDraft => Some((flexible * 30 / 100).min(5_000)),
                    ContextSectionKind::References => Some((flexible * 3 / 100).min(300)),
                    _ => section.max_content_chars,
                };
                if section.kind == ContextSectionKind::AuthoritativeFacts {
                    section.title = "相关实体、作者设定与正文知识";
                    section.content = format!(
                        "{}\n\n{}",
                        non_empty_or(
                            retrieval.task_materials.clone(),
                            "本次没有相关实体或作者设定。"
                        ),
                        non_empty_or(
                            retrieval.authoritative_facts.clone(),
                            "本次没有相关正文事实。"
                        ),
                    );
                }
            }
            if let Some(focus) = &input.focus {
                sections.insert(
                    3,
                    PromptSection::new(
                        ContextSectionKind::CurrentState,
                        1,
                        "本轮构思记忆（尚未正式入库）",
                        discussion_focus_memory(
                            focus,
                            &input.user_message,
                            (flexible * 25 / 100).min(2_400),
                        ),
                        1,
                    ),
                );
            }
        }
        let (user_prompt, section_audit, truncated) = compile_sections(
            &mut sections,
            character_budget.saturating_sub(system_prompt.chars().count()),
        );
        let retrieval_evidence = retrieval.evidence_refs;
        let entity_source_status = retrieval.source_status;
        let canonical = serde_json::json!({
            "scopeLabel": input.scope_label,
            "scopeContent": input.scope_content,
            "history": input.history,
            "userMessage": input.user_message,
            "focus": input.focus,
            "promptVersion": DISCUSSION_PROMPT_VERSION,
            "system": system_prompt,
            "user": user_prompt,
            "retrievalEvidence": retrieval_evidence,
            "taskContract": task_contract,
            "sectionAudit": section_audit,
        });
        let context_version = format!("{:x}", Sha256::digest(canonical.to_string().as_bytes()));
        let estimated_input_tokens = estimate_input_tokens(&system_prompt, &user_prompt);
        Ok(ContextPackage {
            chapter_id: Uuid::nil(),
            target_revision_id: None,
            action: AiAction::Summarize,
            context_version,
            prompt_version: DISCUSSION_PROMPT_VERSION.to_owned(),
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
    max_content_chars: Option<usize>,
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
            max_content_chars: None,
        }
    }

    const fn truncate_from_tail(mut self, enabled: bool) -> Self {
        self.truncate_from_tail = enabled;
        self
    }
}

struct CompiledRetrieval {
    project_settings: String,
    project_setting_count: u16,
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
    document: &str,
    task_contract: &AiTaskContract,
    retrieval: &CompiledRetrieval,
) -> Vec<PromptSection> {
    let document = compact_document_for_context(document, 16_000);
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
            ContextSectionKind::ProjectSettings,
            1,
            "作品正式设定与生成前判断",
            non_empty_or(
                retrieval.project_settings.clone(),
                "本次没有可用的正式作品设定；生成前不得自行补全主角、境界或世界规则。",
            ),
            retrieval.project_setting_count,
        ),
        PromptSection::new(
            ContextSectionKind::AuthoritativeFacts,
            1,
            "已批准事实",
            non_empty_or(
                retrieval.authoritative_facts.clone(),
                "本次没有已批准事实来源。",
            ),
            retrieval.authoritative_count,
        ),
        PromptSection::new(
            ContextSectionKind::ChapterPlan,
            2,
            "当前章节与分卷规划",
            format!(
                "当前章节执行卡：{}\n所属分卷规划：{}",
                non_empty_or(input.chapter_plan.trim().to_owned(), "未提供章节规划。"),
                non_empty_or(input.volume_plan.trim().to_owned(), "未提供分卷规划。")
            ),
            u16::from(!input.chapter_plan.trim().is_empty())
                + u16::from(!input.volume_plan.trim().is_empty()),
        ),
        PromptSection::new(
            ContextSectionKind::CurrentState,
            3,
            "故事当前状态",
            non_empty_or(retrieval.task_materials.clone(), "本次没有独立状态来源。"),
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

fn compact_document_for_context(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    let length = value.chars().count();
    if length <= max_chars {
        return value.to_owned();
    }
    let marker = "\n[正文中段已移入章节摘要或按需检索]\n";
    let available = max_chars.saturating_sub(marker.chars().count());
    let head = available.saturating_mul(2) / 5;
    let tail = available.saturating_sub(head);
    let head_text = value.chars().take(head).collect::<String>();
    let tail_text = value
        .chars()
        .skip(length.saturating_sub(tail))
        .collect::<String>();
    format!("{head_text}{marker}{tail_text}")
}

struct TaskContractDefinition {
    role: AiTaskRole,
    goal: &'static str,
    target_type: &'static str,
    acceptance_criteria: &'static [&'static str],
    output_contract: &'static str,
}

fn task_contract_definition(action: AiAction) -> TaskContractDefinition {
    match action {
        AiAction::Draft => TaskContractDefinition {
            role: AiTaskRole::DraftWriter,
            goal: "依据章节执行卡、项目上下文和作者要求创作本章完整初稿。",
            target_type: "CHAPTER",
            acceptance_criteria: &[
                "完整覆盖章节执行卡中的目标、关键行动、冲突变化和结尾钩子。",
                "正文内部的场景、人物行动和因果推进连贯，可直接进入候选审核。",
                "叙述人称和视角边界必须与正式设定一致；同一章节多次生成不得随机切换人称。",
                "只输出完整章节正文。",
            ],
            output_contract: "纯文本完整章节候选正文；不得附带分析、标题、JSON、变更声明或写作说明。",
        },
        AiAction::Continue => TaskContractDefinition {
            role: AiTaskRole::DraftWriter,
            goal: "从当前草稿结尾继续写作，不复述已有内容。",
            target_type: "CHAPTER",
            acceptance_criteria: &[
                "输出能与当前草稿结尾自然衔接。",
                "不改变已提供事实、章节目标和人物知识边界。",
                "延续当前章节既定的叙述人称和视角边界，不得改成另一人称。",
                "只输出新增候选正文。",
            ],
            output_contract: "纯文本候选正文；不得附带分析、标题、JSON 或变更声明。",
        },
        AiAction::Rewrite => TaskContractDefinition {
            role: AiTaskRole::SelectionReviser,
            goal: "在给定选区范围内重写内容。",
            target_type: "SELECTION",
            acceptance_criteria: &[
                "新文本可完整替换选区。",
                "不得修改选区之外的情节和事实。",
                "只输出替换选区的候选正文。",
            ],
            output_contract: "纯文本替换候选；不得附带分析、标题、JSON 或变更声明。",
        },
        AiAction::Polish => TaskContractDefinition {
            role: AiTaskRole::SelectionReviser,
            goal: "润色给定选区并保持原意。",
            target_type: "SELECTION",
            acceptance_criteria: &[
                "保持选区事实、视角、情节结果和人物意图不变。",
                "改善语言表达但不扩大修改范围。",
                "只输出润色后的候选正文。",
            ],
            output_contract: "纯文本润色候选；不得附带分析、标题、JSON 或变更声明。",
        },
        AiAction::Summarize => TaskContractDefinition {
            role: AiTaskRole::ChapterSummarizer,
            goal: "总结当前章节，供后续上下文使用。",
            target_type: "CHAPTER",
            acceptance_criteria: &[
                "覆盖章节中已发生的关键事件和状态变化。",
                "区分正文事实与无法确认的信息。",
                "保持简洁，不引入正文之外的新事实。",
            ],
            output_contract: "纯文本章节摘要；不得附带分析、标题、JSON 或变更声明。",
        },
        AiAction::ConsistencyCheck => TaskContractDefinition {
            role: AiTaskRole::ContinuityAuditor,
            goal: "审核章节执行卡、当前草稿、正式设定和已批准事实之间是否存在会影响正文写作的冲突。",
            target_type: "CHAPTER",
            acceptance_criteria: &[
                "分别检查人物身份与动机、能力或境界边界、世界规则、时间线、既定事实和叙述人称。",
                "每条问题必须给出严重程度、冲突内容和正式依据；没有依据时不得判为冲突。",
                "只输出审核结论和修改建议，不得改写正文，不得声称已修改任何项目数据。",
            ],
            output_contract: "纯文本审核报告；第一行输出“审核结论：通过 / 需复核 / 阻断 / [上下文不足]”，后续每条问题严格按“[阻断|严重|一般|提示] 问题｜依据｜建议”列出；没有问题时明确说明“审核结论：通过（未发现冲突）”。",
        },
    }
}

fn build_task_contract(input: &AssembleContextInput) -> AiTaskContract {
    let definition = task_contract_definition(input.action);
    let uncertainty_policy = match input.action {
        AiAction::Summarize => {
            "只依据当前草稿和已提供的章节材料总结；无法确认的信息标为不确定，不得补写正文之外的事实。"
                .to_owned()
        }
        AiAction::ConsistencyCheck => {
            "只使用本次提供的正式设定、已批准事实、章节执行卡和当前草稿；未记录项按未知处理，证据不足时标记“无法确认”，不得把推测写成冲突。资料不完整不阻止审核，也不要求作者先补全规划。"
                .to_owned()
        }
        _ => {
            "生成前检查 [P1 作品正式设定与生成前判断]；未记录、未知、暂不决定和作者保留都是有效状态，不要求先补全规划。可以把未决内容作为候选提出，但不得把推测写成已确认事实；只有用户指令或当前正文与已锁定正式内容直接冲突时，才说明冲突并给出可选处理。" .to_owned()
        }
    };
    AiTaskContract {
        role: definition.role,
        goal: definition.goal.to_owned(),
        target_type: definition.target_type.to_owned(),
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
        acceptance_criteria: definition
            .acceptance_criteria
            .iter()
            .map(|criterion| (*criterion).to_owned())
            .collect(),
        uncertainty_policy,
        output_contract: definition.output_contract.to_owned(),
    }
}

fn role_label(role: AiTaskRole) -> &'static str {
    match role {
        AiTaskRole::DraftWriter => "小说候选正文执行器",
        AiTaskRole::SelectionReviser => "小说选区修订执行器",
        AiTaskRole::ChapterSummarizer => "小说章节摘要执行器",
        AiTaskRole::ContinuityAuditor => "小说连续性与生成准入审核器",
        AiTaskRole::ReviewClaimExtractor => "小说审核声明提取器",
        AiTaskRole::ReviewSemanticAdjudicator => "小说审核语义复核器",
        AiTaskRole::DiscussionFacilitator => "作品共创讨论协作者",
        AiTaskRole::ApiConnectionTester => "API 连接测试器",
    }
}

pub(crate) fn format_task_contract(contract: &AiTaskContract, chapter_title: &str) -> String {
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
    for section in sections.iter() {
        let separator = usize::from(!rendered.is_empty()) * 2;
        let section_budget = remaining.saturating_sub(separator);
        let header = format!("[P{} {}]\n", section.priority, section.title);
        let header_chars = header.chars().count();
        let content_budget = section_budget
            .saturating_sub(header_chars)
            .min(section.max_content_chars.unwrap_or(usize::MAX));
        let (content, truncated) =
            truncate_content(&section.content, content_budget, section.truncate_from_tail);
        let text = if section_budget >= header_chars {
            format!("{header}{content}")
        } else {
            header.chars().take(section_budget).collect()
        };
        let included_chars = text.chars().count();
        if included_chars > 0 {
            remaining = remaining.saturating_sub(separator + included_chars);
        }
        any_truncated |= truncated || included_chars < header_chars;
        audits.push(ContextSectionAudit {
            kind: section.kind,
            priority: section.priority,
            source_count: section.source_count,
            included_chars: u32::try_from(included_chars).unwrap_or(u32::MAX),
            truncated: truncated || included_chars < header_chars,
        });
        if !text.is_empty() {
            rendered.push(text);
        }
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

/// Estimates prompt tokens conservatively without coupling the application
/// crate to a provider-specific tokenizer. Non-ASCII characters count as one
/// token; ASCII runs use the usual four-characters-per-token approximation.
fn estimate_input_tokens(system_prompt: &str, user_prompt: &str) -> u32 {
    let mut tokens = 0usize;
    let mut ascii_run = 0usize;
    for character in system_prompt.chars().chain(user_prompt.chars()) {
        if character.is_ascii() {
            ascii_run = ascii_run.saturating_add(1);
            if ascii_run == 4 {
                tokens = tokens.saturating_add(1);
                ascii_run = 0;
            }
        } else {
            if ascii_run > 0 {
                tokens = tokens.saturating_add(1);
                ascii_run = 0;
            }
            tokens = tokens.saturating_add(1);
        }
    }
    if ascii_run > 0 {
        tokens = tokens.saturating_add(1);
    }
    u32::try_from(tokens).unwrap_or(u32::MAX)
}

fn discussion_focus_memory(focus: &DiscussionFocus, question: &str, limit: usize) -> String {
    let query = super::DiscussionRelevance::new(question);
    let body_budget = limit.saturating_sub(100);
    let content = format!(
        "主题：{}\n作者已选定：\n{}\n未决问题：\n{}\n备选（不是选定结论）：\n{}",
        focus.topic_kind,
        query.excerpt(&focus.chosen, body_budget * 70 / 100),
        query.excerpt(&focus.questions, body_budget * 20 / 100),
        query.excerpt(&focus.alternatives, body_budget * 10 / 100),
    );
    truncate_content(&content, limit, false).0
}

fn compile_retrieval_evidence(evidence: &[RetrievalEvidence]) -> CompiledRetrieval {
    compile_retrieval_evidence_with_mode(evidence, false)
}

fn compile_retrieval_evidence_with_mode(
    evidence: &[RetrievalEvidence],
    discussion: bool,
) -> CompiledRetrieval {
    if evidence.is_empty() {
        return CompiledRetrieval {
            project_settings: String::new(),
            project_setting_count: 0,
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
    let mut project_settings = Vec::new();
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
            novel_domain::ContextAuthority::ProjectSetting
                if discussion && !item.chunk.source_id.is_nil() =>
            {
                task_materials.push(text);
            }
            novel_domain::ContextAuthority::ProjectSetting => project_settings.push(text),
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
        project_setting_count: u16::try_from(project_settings.len()).unwrap_or(u16::MAX),
        project_settings: project_settings.join("\n\n"),
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

/// Extracts the plain text from a persisted editor document.
///
/// # Errors
///
/// Returns an error when the JSON document is malformed or unsupported.
pub fn document_text(document_json: &str) -> Result<String, ContextError> {
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
