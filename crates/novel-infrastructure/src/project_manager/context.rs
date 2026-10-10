use super::*;
use std::fmt::Write as _;

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
        let references = self
            .chapter_entity_context(input.chapter_id)
            .map_err(|error| {
                novel_application::ContextError::ProjectKnowledgeUnavailable(error.to_string())
            })?;
        let mut selected_ids = object_ids.to_vec();
        if let Some(references) = &references {
            selected_ids.extend(
                references
                    .entities
                    .iter()
                    .filter(|card| card.entity.lifecycle_status == EntityLifecycleStatus::Active)
                    .map(|card| card.entity.id),
            );
        }
        let mut candidates = self.collect_context_candidates(input, &selected_ids);
        if let Some(references) = references.filter(|references| references.version > 0) {
            let mut identity = references
                .entities
                .iter()
                .map(|card| {
                    (
                        card.entity.id,
                        card.entity.current_revision_id,
                        card.entity.version,
                    )
                })
                .collect::<Vec<_>>();
            identity.sort_unstable();
            // Selection changes invalidate admission even when attachment budgets omit a reference.
            if let Some(candidate) = candidates.iter_mut().find(|candidate| {
                candidate.kind == novel_application::ContextCandidateKind::ProjectSetting
            }) {
                let digest = Sha256::digest(
                    serde_json::to_vec(&(references.version, identity)).unwrap_or_default(),
                );
                let _ = write!(
                    candidate.evidence.chunk.source_revision,
                    ":chapter-references:{digest:x}"
                );
            }
        }
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
        self.assemble_discussion_context_with_mode(input, false)
    }

    pub fn assemble_discussion_design_context(
        &self,
        input: &novel_application::DiscussionContextInput,
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        self.assemble_discussion_context_with_mode(input, true)
    }

    fn assemble_discussion_context_with_mode(
        &self,
        input: &novel_application::DiscussionContextInput,
        design: bool,
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
            instruction: Some(if design {
                format!("{}\n{}", input.user_message, input.history)
            } else {
                input.user_message.clone()
            }),
            input_token_budget: input.input_token_budget,
        };
        let candidates = if design {
            self.collect_context_candidates(&retrieval_input, &[])
        } else {
            self.collect_discussion_context_candidates(input)
        };
        let evidence =
            novel_application::ContextPlanner::plan(&candidates, 24, if design { 10 } else { 8 });
        if design {
            novel_application::ContextAssembler::assemble_discussion_design(input, &evidence)
        } else {
            novel_application::ContextAssembler::assemble_discussion(input, &evidence)
        }
    }
}
