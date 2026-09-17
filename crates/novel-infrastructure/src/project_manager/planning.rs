use super::*;

impl ProjectManager {
    pub fn list_planning_sections(&self) -> Result<Vec<PlanningSection>, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.list_planning_sections()?)
    }

    pub fn save_planning_section(
        &mut self,
        mut section: PlanningSection,
    ) -> Result<PlanningSection, ProjectError> {
        if !section.content.trim().is_empty()
            && section.story_state == PlanningStoryState::AiSuggested
        {
            section.story_state = PlanningStoryState::Confirmed;
        }
        if section.content.trim().is_empty()
            && section.pending_content.trim().is_empty()
            && matches!(
                section.story_state,
                PlanningStoryState::Confirmed | PlanningStoryState::Locked
            )
        {
            section.story_state = PlanningStoryState::Unset;
        }
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.save_planning_section(section)?)
    }

    pub fn list_planning_embeddings(&self) -> Result<Vec<PlanningEmbedding>, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.list_planning_embeddings()?)
    }

    pub fn generate_planning_embedding(
        &mut self,
        embedding: PlanningEmbedding,
    ) -> Result<PlanningEmbedding, ProjectError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.save_planning_embedding(embedding)?)
    }

    pub fn clear_planning_embedding(&mut self, section_id: &str) -> Result<(), ProjectError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        session.database.delete_planning_embedding(section_id)?;
        session
            .database
            .delete_planning_chunk_embeddings(section_id)?;
        Ok(())
    }

    pub fn list_planning_chunk_embeddings(
        &self,
    ) -> Result<Vec<PlanningChunkEmbedding>, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.list_planning_chunk_embeddings()?)
    }

    pub fn generate_planning_chunk_embedding(
        &mut self,
        embedding: PlanningChunkEmbedding,
    ) -> Result<PlanningChunkEmbedding, ProjectError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.save_planning_chunk_embedding(embedding)?)
    }

    pub fn clear_planning_chunk_embeddings(
        &mut self,
        section_id: &str,
    ) -> Result<(), ProjectError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        session
            .database
            .delete_planning_chunk_embeddings(section_id)?;
        Ok(())
    }

    pub fn create_plan_node(
        &mut self,
        parent_id: Option<Uuid>,
        kind: PlanNodeKind,
        title: String,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        let node = session.database.create_plan_node(parent_id, kind, title)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
    }

    pub fn update_plan_node(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        let node = session.database.update_plan_node(id, title, archived)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
    }

    pub fn update_plan_node_checked(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        let node =
            session
                .database
                .update_plan_node_checked(id, title, archived, expected_version)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
    }

    pub fn move_plan_node(
        &mut self,
        id: Uuid,
        parent_id: Option<Uuid>,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        let node = session
            .database
            .move_plan_node(id, parent_id, expected_version)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
    }
}
