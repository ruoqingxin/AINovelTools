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
        let previous = session
            .database
            .list_planning_sections()?
            .into_iter()
            .find(|existing| existing.id == section.id);
        let saved = session.database.save_planning_section(section)?;
        let is_formal = |item: &PlanningSection| {
            !item.content.trim().is_empty()
                && matches!(
                    item.story_state,
                    PlanningStoryState::Confirmed | PlanningStoryState::Locked
                )
        };
        let formal_changed = match previous.as_ref().filter(|item| is_formal(item)) {
            Some(before) if is_formal(&saved) => {
                before.content != saved.content || before.story_state != saved.story_state
            }
            Some(_) => true,
            None => is_formal(&saved),
        };
        if formal_changed {
            self.invalidate_auto_setting_summaries();
        }
        Ok(saved)
    }

    pub fn refresh_project_setting_summary_from_job(
        &mut self,
        payload: &str,
    ) -> Result<bool, ProjectError> {
        let _ = payload;
        let sections = self.list_planning_sections()?;
        let formal_sections = sections
            .into_iter()
            .filter(|section| {
                !section.content.trim().is_empty()
                    && matches!(
                        section.story_state,
                        PlanningStoryState::Confirmed | PlanningStoryState::Locked
                    )
            })
            .collect::<Vec<_>>();
        if formal_sections.is_empty() {
            return Ok(false);
        }
        let content = formal_sections
            .iter()
            .take(16)
            .map(|section| {
                format!(
                    "{}：{}",
                    section.id,
                    compact_setting_excerpt(&section.content, 280)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let material = SummaryMaterial {
            id: Uuid::new_v4(),
            project_id: Uuid::nil(),
            kind: SummaryKind::Setting,
            precision: SummaryPrecision::L4,
            source_id: None,
            source_version: Some("planning:formal".to_owned()),
            content: compact_setting_excerpt(&content, 2_400),
            generation_mode: "EXTRACTIVE_AUTO_SETTINGS".to_owned(),
            lifecycle_status: "ACTIVE".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        self.invalidate_auto_setting_summaries();
        let _ = self.upsert_summary_material(material);
        Ok(true)
    }

    fn invalidate_auto_setting_summaries(&mut self) {
        let Ok(materials) = self.list_summary_materials() else {
            return;
        };
        for material in materials.into_iter().filter(|material| {
            material.kind == SummaryKind::Setting
                && material.precision == SummaryPrecision::L4
                && material.lifecycle_status == "ACTIVE"
                && material.generation_mode == "EXTRACTIVE_AUTO_SETTINGS"
        }) {
            let _ = self.set_summary_material_lifecycle(material.id, "STALE".to_owned());
        }
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

fn compact_setting_excerpt(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let marker = "\n[设定原文请按需回查]\n";
    let available = max_chars.saturating_sub(marker.chars().count());
    let head = available.saturating_mul(2) / 3;
    let tail = available.saturating_sub(head);
    format!(
        "{}{}{}",
        value.chars().take(head).collect::<String>(),
        marker,
        value
            .chars()
            .skip(value.chars().count().saturating_sub(tail))
            .collect::<String>()
    )
}
