//! Application use cases and infrastructure ports.

mod context;
pub use context::*;

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
            document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"雨停了。"}]}]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        };
        let first = super::ContextAssembler::assemble(&input).expect("assemble");
        let second = super::ContextAssembler::assemble(&input).expect("assemble again");
        assert_eq!(first.context_version, second.context_version);
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
            document_json: format!(
                r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{}结尾锚点"}}]}}]}}"#,
                "远处的雨声。".repeat(1_000)
            ),
            selection: None,
            instruction: Some("不要新增命名人物。".into()),
            input_token_budget: 1_024,
        };
        let package = super::ContextAssembler::assemble(&input).expect("assemble contract");
        assert_eq!(package.prompt_version, "r3-writing-v2");
        assert_eq!(package.task_contract.role, super::AiTaskRole::DraftWriter);
        assert!(
            package
                .task_contract
                .forbidden_actions
                .iter()
                .any(|item| item.contains("正式正文"))
        );
        assert!(package.user_prompt.contains("[P0 任务合同]"));
        assert!(package.user_prompt.contains("[P0 用户本次明确指令]"));
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
        ] {
            let mut action_input = input.clone();
            action_input.action = action;
            action_input.selection = action.requires_selection().then(|| "选区内容".to_owned());
            let action_package =
                super::ContextAssembler::assemble(&action_input).expect("assemble action role");
            assert_eq!(action_package.task_contract.role, expected_role);
        }
    }
}
