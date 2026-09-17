use super::*;

impl ProjectManager {
    pub fn assemble_context_with_project_knowledge(
        &self,
        input: &novel_application::AssembleContextInput,
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        self.assemble_context_with_project_knowledge_and_objects(input, &[])
    }

    pub fn assemble_context_with_project_knowledge_and_objects(
        &self,
        input: &novel_application::AssembleContextInput,
        object_ids: &[Uuid],
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        let availability = novel_application::RetrievalAvailability {
            knowledge_available: self.current.is_some(),
            keyword_index_ready: true,
            semantic_index_ready: false,
        };
        let plan = novel_application::RetrievalPlanner::plan(
            novel_application::RetrievalIntent::ProjectKnowledge,
            &availability,
        );
        let candidates = self.collect_context_candidates(input, object_ids);
        let evidence = novel_application::ContextPlanner::plan(
            &candidates,
            plan.max_candidates,
            plan.max_attached_chunks,
        );
        novel_application::ContextAssembler::assemble_with_retrieval(input, &evidence)
    }

    pub fn assemble_discussion_context(
        &self,
        input: &novel_application::DiscussionContextInput,
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        let retrieval_input = novel_application::AssembleContextInput {
            chapter_id: Uuid::nil(),
            target_revision_id: None,
            action: AiAction::Summarize,
            chapter_title: input.scope_label.clone(),
            chapter_plan: input.scope_content.clone(),
            volume_plan: String::new(),
            document_json: r#"{"type":"doc","content":[]}"#.to_owned(),
            selection: None,
            instruction: Some(format!("{}\n{}", input.user_message, input.history)),
            input_token_budget: input.input_token_budget,
        };
        let candidates = self.collect_context_candidates(&retrieval_input, &[]);
        let evidence = novel_application::ContextPlanner::plan(&candidates, 24, 10);
        novel_application::ContextAssembler::assemble_discussion(input, &evidence)
    }
}
