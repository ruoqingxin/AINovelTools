//! Application use cases and infrastructure ports.

mod ai_evaluation;
mod context;
mod discussion_context;
mod planning_context;
mod review;
pub use ai_evaluation::*;
pub use context::*;
pub use discussion_context::*;
pub use planning_context::*;
pub use review::*;

/// Returns the ordered layers currently linked into the application core.
#[must_use]
pub fn linked_layers() -> [&'static str; 2] {
    [novel_domain::layer_name(), "application"]
}

#[cfg(test)]
mod tests {
    #[test]
    fn application_depends_on_domain() {
        assert_eq!(super::linked_layers(), ["domain", "application"]);
    }

    #[test]
    fn context_versions_are_stable_and_selection_is_enforced() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::Continue,
            chapter_title: "第一章".into(),
            chapter_plan: "主角抵达车站".into(),
            volume_plan: "第一卷围绕失踪案展开。".into(),
            document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"雨停了。"}]}]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        };
        let first = super::ContextAssembler::assemble(&input).expect("assemble");
        let second = super::ContextAssembler::assemble(&input).expect("assemble again");
        assert_eq!(first.context_version, second.context_version);
        let mut changed_plan = input.clone();
        changed_plan.chapter_plan = "主角改在码头下车".into();
        let changed_plan = super::ContextAssembler::assemble(&changed_plan).expect("changed plan");
        assert_ne!(first.context_version, changed_plan.context_version);
        let mut changed_volume = input.clone();
        changed_volume.volume_plan = "第一卷改为在港城收束。".into();
        let changed_volume =
            super::ContextAssembler::assemble(&changed_volume).expect("changed volume plan");
        assert_ne!(first.context_version, changed_volume.context_version);
        let mut changed_document = input.clone();
        changed_document.document_json = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"雨又下起来了。"}]}]}"#.into();
        let changed_document =
            super::ContextAssembler::assemble(&changed_document).expect("changed document");
        assert_ne!(first.context_version, changed_document.context_version);
        let mut rewrite = input;
        rewrite.action = novel_domain::AiAction::Rewrite;
        assert!(matches!(
            super::ContextAssembler::assemble(&rewrite),
            Err(super::ContextError::Contract(
                novel_domain::AiContractError::SelectionRequired
            ))
        ));
    }

    #[test]
    fn retrieved_original_text_is_deduplicated_and_auditable() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::Continue,
            chapter_title: "第十章".into(),
            chapter_plan: "宴会冲突".into(),
            volume_plan: "第一卷围绕失踪案展开。".into(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: Some("保持人物习惯".into()),
            input_token_budget: 2048,
        };
        let chunk_id = uuid::Uuid::new_v4();
        let source_id = uuid::Uuid::new_v4();
        let make_evidence = |relevance| novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: chunk_id,
                source_id,
                source_revision: "character-r2".into(),
                source_hash: "sha256:def".into(),
                chunk_index: 0,
                chunking_version: "knowledge-chunk-v1".into(),
                content: "林澈不饮酒。".into(),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Structured,
            authority: novel_domain::ContextAuthority::AuthoritativeFact,
            relevance,
        };
        let package = super::ContextAssembler::assemble_with_retrieval(
            &input,
            &[make_evidence(9_000), make_evidence(8_000)],
        )
        .expect("assemble with retrieval");
        assert_eq!(package.entity_source_status, "RETRIEVAL_ATTACHED");
        assert_eq!(package.retrieval_evidence.len(), 1);
        assert_eq!(package.user_prompt.matches("林澈不饮酒。").count(), 1);
        assert!(package.user_prompt.contains("[P1 已批准事实]"));
        assert_eq!(
            package.retrieval_evidence[0].authority,
            novel_domain::ContextAuthority::AuthoritativeFact
        );
    }

    #[test]
    fn retrieval_planner_skips_simple_tasks_and_enables_hybrid_when_ready() {
        let ready = super::RetrievalAvailability {
            knowledge_available: true,
            keyword_index_ready: true,
            semantic_index_ready: true,
        };
        let simple =
            super::RetrievalPlanner::plan(super::RetrievalIntent::CurrentChapterOnly, &ready);
        assert!(simple.methods.is_empty());

        let hybrid =
            super::RetrievalPlanner::plan(super::RetrievalIntent::ProjectKnowledge, &ready);
        assert_eq!(
            hybrid.methods,
            [
                novel_domain::RetrievalMethod::Structured,
                novel_domain::RetrievalMethod::Keyword,
                novel_domain::RetrievalMethod::Semantic,
            ]
        );
        assert_eq!(hybrid.max_attached_chunks, 8);
    }

    #[test]
    fn retrieval_marks_missing_source_versions_as_unverified() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::Continue,
            chapter_title: "第一章".into(),
            chapter_plan: String::new(),
            volume_plan: String::new(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        };
        let evidence = novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::new_v4(),
                source_revision: "search:current".into(),
                source_hash: "sha256:test".into(),
                chunk_index: 0,
                chunking_version: "r4-search-v1".into(),
                content: "未绑定版本的搜索材料".into(),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Keyword,
            authority: novel_domain::ContextAuthority::Reference,
            relevance: 5000,
        };
        let package = super::ContextAssembler::assemble_with_retrieval(&input, &[evidence])
            .expect("assemble");
        assert_eq!(package.entity_source_status, "SOURCE_VERSION_UNVERIFIED");
    }

    #[test]
    fn writing_calls_have_bounded_roles_and_audited_priority_sections() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: Some(uuid::Uuid::new_v4()),
            action: novel_domain::AiAction::Continue,
            chapter_title: "第三章".into(),
            chapter_plan: "主角必须在雨夜抵达码头。".into(),
            volume_plan: "第一卷围绕失踪案展开。".into(),
            document_json: format!(
                r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{}结尾锚点"}}]}}]}}"#,
                "远处的雨声。".repeat(1_000)
            ),
            selection: None,
            instruction: Some("不要新增命名人物。".into()),
            input_token_budget: 1_024,
        };
        let package = super::ContextAssembler::assemble(&input).expect("assemble contract");
        assert_eq!(package.prompt_version, "r5.1-writing-v1");
        assert_eq!(package.task_contract.role, super::AiTaskRole::DraftWriter);
        assert!(
            package
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("正式正文"))
        );
        assert!(
            package
                .task_contract
                .uncertainty_policy
                .contains("正式设定")
        );
        assert!(
            package
                .task_contract
                .acceptance_criteria
                .iter()
                .any(|item| item.contains("叙述人称"))
        );
        assert!(package.user_prompt.contains("[P0 任务合同]"));
        assert!(package.user_prompt.contains("[P0 用户本次明确指令]"));
        assert!(package.user_prompt.contains("[P2 当前章节与分卷规划]"));
        assert!(package.user_prompt.contains("第一卷围绕失踪案展开。"));
        assert!(package.user_prompt.contains("不要新增命名人物。"));
        assert!(package.user_prompt.contains("结尾锚点"));
        assert!(package.truncated);
        assert!(
            package
                .section_audit
                .iter()
                .any(|item| item.kind == super::ContextSectionKind::CurrentDraft && item.truncated)
        );

        for (action, expected_role) in [
            (
                novel_domain::AiAction::Draft,
                super::AiTaskRole::DraftWriter,
            ),
            (
                novel_domain::AiAction::Continue,
                super::AiTaskRole::DraftWriter,
            ),
            (
                novel_domain::AiAction::Rewrite,
                super::AiTaskRole::SelectionReviser,
            ),
            (
                novel_domain::AiAction::Polish,
                super::AiTaskRole::SelectionReviser,
            ),
            (
                novel_domain::AiAction::Summarize,
                super::AiTaskRole::ChapterSummarizer,
            ),
            (
                novel_domain::AiAction::ConsistencyCheck,
                super::AiTaskRole::ContinuityAuditor,
            ),
        ] {
            let mut action_input = input.clone();
            action_input.action = action;
            action_input.selection = action.requires_selection().then(|| "选区内容".to_owned());
            let action_package =
                super::ContextAssembler::assemble(&action_input).expect("assemble action role");
            assert_eq!(action_package.task_contract.role, expected_role);
        }
    }

    #[test]
    fn consistency_review_contract_is_read_only_and_evidence_bound() {
        let review = super::ContextAssembler::assemble(&super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::ConsistencyCheck,
            chapter_title: "第三章".into(),
            chapter_plan: "主角必须在雨夜抵达码头。".into(),
            volume_plan: "第一卷围绕失踪案展开。".into(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 4_096,
        })
        .expect("assemble review contract");
        assert!(
            review
                .task_contract
                .acceptance_criteria
                .iter()
                .any(|item| item.contains("能力或境界边界"))
        );
        assert!(review.task_contract.uncertainty_policy.contains("无法确认"));
        assert!(review.task_contract.output_contract.contains("审核报告"));
        assert!(
            review
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("正式正文"))
        );
        let admission = review
            .clone()
            .with_review_purpose(novel_domain::ReviewPurpose::Admission);
        let manuscript = review.with_review_purpose(novel_domain::ReviewPurpose::Manuscript);
        assert_ne!(admission.context_version, manuscript.context_version);
        assert!(admission.user_prompt.contains("创作准入"));
        assert!(manuscript.user_prompt.contains("正文审核"));
        assert!(admission.user_prompt.contains("不得把正文审核结论"));
        assert!(
            manuscript
                .user_prompt
                .contains("不得让本次结论参与写作准入")
        );
    }

    #[test]
    fn context_planner_spreads_available_kinds_before_filling_same_kind() {
        let make_candidate = |kind, relevance, content: &str| {
            super::ContextCandidate::new(
                kind,
                novel_domain::RetrievalEvidence {
                    chunk: novel_domain::KnowledgeChunk {
                        id: uuid::Uuid::new_v4(),
                        source_id: uuid::Uuid::new_v4(),
                        source_revision: "test:1".into(),
                        source_hash: "sha256:test".into(),
                        chunk_index: 0,
                        chunking_version: "test-v1".into(),
                        content: content.into(),
                        embedding: None,
                    },
                    method: novel_domain::RetrievalMethod::Structured,
                    authority: novel_domain::ContextAuthority::TaskMaterial,
                    relevance,
                },
            )
        };
        let candidates = vec![
            make_candidate(super::ContextCandidateKind::Keyword, 10_000, "高相关关键词"),
            make_candidate(
                super::ContextCandidateKind::ProjectSetting,
                10_000,
                "主角目标与境界规则",
            ),
            make_candidate(super::ContextCandidateKind::Entity, 4_000, "当前人物卡"),
            make_candidate(
                super::ContextCandidateKind::AuthoritativeFact,
                9_000,
                "林澈不饮酒。",
            ),
            make_candidate(
                super::ContextCandidateKind::AuthoritativeFact,
                8_000,
                "林澈左臂受伤。",
            ),
            make_candidate(super::ContextCandidateKind::CurrentState, 800, "当前状态"),
            make_candidate(
                super::ContextCandidateKind::Foreshadowing,
                750,
                "未回收伏笔",
            ),
            make_candidate(super::ContextCandidateKind::Summary, 700, "章节摘要"),
            make_candidate(super::ContextCandidateKind::Event, 650, "历史事件"),
            make_candidate(super::ContextCandidateKind::Keyword, 600, "参考片段"),
        ];

        let selected = super::ContextPlanner::plan(&candidates, 24, 8);
        assert_eq!(selected.len(), 8);
        assert_eq!(selected[0].chunk.content, "主角目标与境界规则");
        assert_eq!(selected[1].chunk.content, "林澈不饮酒。");
        assert_eq!(selected[2].chunk.content, "当前状态");
        assert_eq!(selected[3].chunk.content, "当前人物卡");
        assert_eq!(selected[4].chunk.content, "未回收伏笔");
        assert_eq!(selected[5].chunk.content, "章节摘要");
        assert_eq!(selected[6].chunk.content, "历史事件");
        assert_eq!(selected[7].chunk.content, "高相关关键词");
        assert!(selected.iter().all(|item| item.chunk.content != "参考片段"));

        let mut duplicate = candidates[0].clone();
        duplicate.evidence.chunk.content = " 高相关关键词 ".into();
        let mut with_duplicate = candidates.clone();
        with_duplicate.push(duplicate);
        assert_eq!(
            super::ContextPlanner::plan(&with_duplicate, 24, 8),
            selected
        );
        assert!(super::ContextPlanner::plan(&candidates, 0, 8).is_empty());
        assert!(super::ContextPlanner::plan(&candidates, 24, 0).is_empty());
        assert_eq!(
            super::ContextPlanner::plan(&candidates, 2, 8),
            selected[..2]
        );
    }

    #[test]
    fn discussion_context_is_read_only_and_separates_formal_material_from_history() {
        let input = super::DiscussionContextInput {
            scope_label: "第二卷讨论".into(),
            scope_content: "第二卷末揭露真相。".into(),
            history: "作者：先比较三种方案。\nAI：方案甲推进更快。".into(),
            user_message: "如果推迟到第三卷会怎样？".into(),
            input_token_budget: 4_096,
            focus: None,
        };
        let evidence = novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::new_v4(),
                source_revision: "fact:test:v1".into(),
                source_hash: "sha256:test".into(),
                chunk_index: 0,
                chunking_version: "test-v1".into(),
                content: "林澈还不知道使者已经死亡。".into(),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Structured,
            authority: novel_domain::ContextAuthority::AuthoritativeFact,
            relevance: 9_000,
        };
        let package = super::ContextAssembler::assemble_discussion(&input, &[evidence])
            .expect("assemble discussion context");
        assert_eq!(
            package.task_contract.role,
            super::AiTaskRole::DiscussionFacilitator
        );
        assert_eq!(package.prompt_version, "r5.1-discussion-v3");
        assert!(package.user_prompt.contains("[P0 作者本次问题]"));
        assert!(package.user_prompt.contains("如果推迟到第三卷会怎样？"));
        assert!(package.user_prompt.contains("林澈还不知道使者已经死亡。"));
        assert!(package.user_prompt.contains("最近讨论"));
        assert!(
            package
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("正式正文"))
        );
        assert!(
            package
                .task_contract
                .output_contract
                .contains("不输出修改后的正式对象")
        );
    }

    #[test]
    fn discussion_invites_creativity_without_treating_suggestions_as_formal_settings() {
        let input = super::DiscussionContextInput {
            scope_label: "法宝构思".into(),
            scope_content: String::new(),
            history: String::new(),
            user_message: "借鉴科幻的意识存储，做一个玄幻法宝。".into(),
            input_token_budget: 4_096,
            focus: None,
        };
        let package =
            super::ContextAssembler::assemble_discussion(&input, &[]).expect("creative discussion");
        assert!(package.system_prompt.contains("允许大胆发散和跨题材借鉴"));
        assert!(package.system_prompt.contains("转化为适合本书的表达"));
        assert!(package.system_prompt.contains("不反复警告"));
        assert!(package.system_prompt.contains("背景未定也能开始"));
        assert!(
            package
                .task_contract
                .uncertainty_policy
                .contains("可以自由提出新想法")
        );
        assert!(
            package
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("不得修改"))
        );
        assert!(
            package
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("新建议写成已批准事实"))
        );

        let summary = super::ContextAssembler::assemble_discussion_design(&input, &[])
            .expect("candidate summary");
        assert!(summary.system_prompt.contains("不继续发散或追问"));
        assert!(summary.system_prompt.contains("作者审核确认"));
        assert!(summary.task_contract.output_contract.contains("严格 JSON"));
        assert!(
            summary
                .task_contract
                .output_contract
                .contains("未决定的字段省略")
        );
        assert!(!summary.system_prompt.contains("允许大胆发散"));
    }

    #[test]
    fn discussion_reserves_background_before_oversized_questions_drafts_and_history() {
        let input = super::DiscussionContextInput {
            scope_label: "本书灵感".into(),
            scope_content: "构思细节".repeat(12_500),
            history: "以前的讨论".repeat(5_000),
            user_message: "本轮想法：魂灯。".into(),
            input_token_budget: 4_096,
            focus: None,
        };
        let evidence = novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::nil(),
                source_revision: "planning:discussion-background:test".into(),
                source_hash: "sha256:test".into(),
                chunk_index: 0,
                chunking_version: "test-v1".into(),
                content: format!(
                    "题材：玄幻。\n基调：轻松冒险。\n世界：魂魄可寄存在法宝中。\n{}",
                    "其他正式设定".repeat(3_000)
                ),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Structured,
            authority: novel_domain::ContextAuthority::ProjectSetting,
            relevance: 10_000,
        };
        let package = super::ContextAssembler::assemble_discussion(&input, &[evidence])
            .expect("bounded discussion");
        for anchor in [
            "题材：玄幻",
            "基调：轻松冒险",
            "世界：魂魄可寄存在法宝中",
            "本轮想法：魂灯",
        ] {
            assert!(package.user_prompt.contains(anchor), "missing {anchor}");
        }
        let background = package
            .user_prompt
            .find("[P0 本书背景与相关设定]")
            .expect("background");
        let question = package
            .user_prompt
            .find("[P0 作者本次问题]")
            .expect("question");
        assert!(background < question);
        let audit = package
            .section_audit
            .iter()
            .find(|item| item.kind == super::ContextSectionKind::ProjectSettings)
            .expect("background audit");
        assert!(audit.truncated);
        assert!(audit.included_chars <= 1_400);
        assert!(package.truncated);
        assert!(package.estimated_input_tokens <= input.input_token_budget);
    }

    #[test]
    fn discussion_balances_decisions_related_rules_and_recent_history_under_a_long_scope() {
        let input = super::DiscussionContextInput {
            scope_label: "本书".into(),
            scope_content: "很长的章节规划".repeat(5_000),
            history: format!("{}最新回复：代价只能由本人承担。", "旧消息".repeat(5_000)),
            user_message: "魂灯的寿元代价应该怎么完善？".into(),
            input_token_budget: 8_192,
            focus: Some(super::DiscussionFocus {
                topic_kind: "ITEM".into(),
                chosen: format!(
                    "作者已决定：魂灯以寿元为燃料。{}",
                    "草稿细节".repeat(10_000)
                ),
                alternatives: "备选：吞噬别人的魂魄。".into(),
                questions: "寿元能否由他人支付？".into(),
                ..Default::default()
            }),
        };
        let rule = novel_domain::RetrievalEvidence {
            chunk: novel_domain::KnowledgeChunk {
                id: uuid::Uuid::new_v4(),
                source_id: uuid::Uuid::new_v4(),
                source_revision: "author-setting:test:revision:current".into(),
                source_hash: "sha256:test".into(),
                chunk_index: 0,
                chunking_version: "test-v1".into(),
                content: "重要规则：寿元不可转嫁。".into(),
                embedding: None,
            },
            method: novel_domain::RetrievalMethod::Structured,
            authority: novel_domain::ContextAuthority::ProjectSetting,
            relevance: 9_000,
        };
        let package =
            super::ContextAssembler::assemble_discussion(&input, std::slice::from_ref(&rule))
                .expect("balanced context");
        for anchor in [
            "魂灯以寿元为燃料",
            "寿元不可转嫁",
            "最新回复：代价只能由本人承担",
        ] {
            assert!(package.user_prompt.contains(anchor), "missing {anchor}");
        }
        assert!(package.user_prompt.contains("备选（不是选定结论）"));
        assert!(
            package.system_prompt.chars().count() + package.user_prompt.chars().count() <= 8_192
        );
        assert_eq!(
            package.retrieval_evidence[0].authority,
            novel_domain::ContextAuthority::ProjectSetting
        );
        for kind in [
            super::ContextSectionKind::CurrentState,
            super::ContextSectionKind::AuthoritativeFacts,
            super::ContextSectionKind::CurrentDraft,
        ] {
            assert!(
                package
                    .section_audit
                    .iter()
                    .any(|item| item.kind == kind && item.included_chars > 0)
            );
        }
        let mut changed = input;
        changed.focus.as_mut().expect("focus").chosen = "改用灵力，不再消耗寿元。".into();
        let changed =
            super::ContextAssembler::assemble_discussion(&changed, &[rule]).expect("new memory");
        assert_ne!(package.context_version, changed.context_version);
        assert!(!changed.user_prompt.contains("魂灯以寿元为燃料"));
    }

    #[test]
    fn oversized_discussion_questions_are_rejected_instead_of_silently_truncated() {
        let mut input = super::DiscussionContextInput {
            scope_label: "本书".into(),
            scope_content: String::new(),
            history: String::new(),
            user_message: "玄".repeat(20_000),
            input_token_budget: 4_096,
            focus: None,
        };
        assert!(matches!(
            super::ContextAssembler::assemble_discussion(&input, &[]),
            Err(super::ContextError::DiscussionQuestionTooLong)
        ));
        input.input_token_budget = 120_000;
        let package =
            super::ContextAssembler::assemble_discussion(&input, &[]).expect("large enough");
        assert!(package.user_prompt.contains(&input.user_message));
        assert!(
            package.system_prompt.chars().count() + package.user_prompt.chars().count() <= 24_000
        );
        assert!(
            !package
                .section_audit
                .iter()
                .find(|item| item.kind == super::ContextSectionKind::UserInstruction)
                .expect("question")
                .truncated
        );
    }

    #[test]
    fn discussion_keeps_author_design_before_large_manuscript_fact_excerpts() {
        let input = super::DiscussionContextInput {
            scope_label: "法宝".into(),
            scope_content: String::new(),
            history: String::new(),
            user_message: "魂灯有哪些能力？".into(),
            input_token_budget: 4_096,
            focus: None,
        };
        let evidence = [
            (
                novel_domain::ContextAuthority::AuthoritativeFact,
                "正文旧事件".repeat(5_000),
                10_000,
            ),
            (
                novel_domain::ContextAuthority::ProjectSetting,
                "作者确认能力：魂灯可保存记忆。".into(),
                7_000,
            ),
        ]
        .into_iter()
        .map(
            |(authority, content, relevance)| novel_domain::RetrievalEvidence {
                chunk: novel_domain::KnowledgeChunk {
                    id: uuid::Uuid::new_v4(),
                    source_id: uuid::Uuid::new_v4(),
                    source_revision: "test:current".into(),
                    source_hash: "sha256:test".into(),
                    chunk_index: 0,
                    chunking_version: "test-v1".into(),
                    content,
                    embedding: None,
                },
                method: novel_domain::RetrievalMethod::Structured,
                authority,
                relevance,
            },
        )
        .collect::<Vec<_>>();
        let package =
            super::ContextAssembler::assemble_discussion(&input, &evidence).expect("context");
        assert!(package.user_prompt.contains("魂灯可保存记忆"));
        assert!(package.section_audit.iter().any(|item| item.kind
            == super::ContextSectionKind::AuthoritativeFacts
            && item.truncated));
    }

    #[test]
    fn long_drafts_keep_both_ends_instead_of_only_the_head() {
        let input = super::AssembleContextInput {
            chapter_id: uuid::Uuid::new_v4(),
            target_revision_id: None,
            action: novel_domain::AiAction::Summarize,
            chapter_title: "长章".into(),
            chapter_plan: "总结当前章节".into(),
            volume_plan: String::new(),
            document_json: format!(
                r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"开场锚点{}结尾锚点"}}]}}]}}"#,
                "中段内容".repeat(6_000)
            ),
            selection: None,
            instruction: None,
            input_token_budget: 20_000,
        };
        let package = super::ContextAssembler::assemble(&input).expect("assemble");
        assert!(package.user_prompt.contains("开场锚点"));
        assert!(package.user_prompt.contains("结尾锚点"));
        assert!(
            package
                .user_prompt
                .contains("正文中段已移入章节摘要或按需检索")
        );
    }
}
