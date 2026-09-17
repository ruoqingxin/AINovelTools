use super::*;

impl ProjectManager {
    pub fn current_manuscript(
        &self,
        chapter_id: Uuid,
    ) -> Result<Option<ManuscriptRevision>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        Ok(session.database.current_manuscript(chapter_id)?)
    }

    pub fn list_manuscript_revisions(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<ManuscriptRevision>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        Ok(session.database.list_manuscript_revisions(chapter_id)?)
    }

    pub fn save_manuscript(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        if document_json.trim().is_empty() {
            return Err(ManuscriptError::EmptyDocument);
        }
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        let revision = session.database.save_manuscript_checked(
            chapter_id,
            None,
            document_json,
            creation_reason,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        self.invalidate_chapter_summaries(chapter_id);
        Ok(revision)
    }

    pub fn save_manuscript_checked(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        if document_json.trim().is_empty() {
            return Err(ManuscriptError::EmptyDocument);
        }
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        let revision = session.database.save_manuscript_checked(
            chapter_id,
            base_revision_id,
            document_json,
            creation_reason,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        self.invalidate_chapter_summaries(chapter_id);
        Ok(revision)
    }

    pub fn refresh_chapter_summary_from_job(
        &mut self,
        payload: &str,
    ) -> Result<bool, ManuscriptError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SummaryJobPayload {
            chapter_id: Uuid,
            revision_id: Uuid,
        }

        let payload = serde_json::from_str::<SummaryJobPayload>(payload)
            .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))?;
        let Some(revision) = self.current_manuscript(payload.chapter_id)? else {
            return Ok(false);
        };
        if revision.id != payload.revision_id {
            return Ok(false);
        }
        self.upsert_extractive_chapter_summary(&revision);
        self.refresh_extractive_project_summary();
        Ok(true)
    }

    fn upsert_extractive_chapter_summary(&mut self, revision: &ManuscriptRevision) {
        let Ok(text) = novel_application::document_text(&revision.document_json) else {
            return;
        };
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let summary = extractive_summary(text, 1_600);
        let material = SummaryMaterial {
            id: Uuid::new_v4(),
            project_id: Uuid::nil(),
            kind: SummaryKind::Chapter,
            precision: SummaryPrecision::L1,
            source_id: Some(revision.chapter_id),
            source_version: Some(format!("manuscript:{}", revision.id)),
            content: summary,
            generation_mode: "EXTRACTIVE_AUTO".to_owned(),
            lifecycle_status: "ACTIVE".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let _ = self.upsert_summary_material(material);
    }

    fn refresh_extractive_project_summary(&mut self) {
        let Ok(materials) = self.list_summary_materials() else {
            return;
        };
        let mut chapter_summaries = materials
            .iter()
            .filter(|material| {
                material.kind == SummaryKind::Chapter
                    && material.precision == SummaryPrecision::L1
                    && material.lifecycle_status == "ACTIVE"
                    && material.generation_mode == "EXTRACTIVE_AUTO"
            })
            .collect::<Vec<_>>();
        chapter_summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        if chapter_summaries.is_empty() {
            return;
        }
        let content = chapter_summaries
            .into_iter()
            .take(8)
            .enumerate()
            .map(|(index, material)| {
                format!(
                    "章节记忆 {}：{}",
                    index + 1,
                    extractive_summary(&material.content, 320)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        for material in materials.into_iter().filter(|material| {
            material.kind == SummaryKind::Setting
                && material.precision == SummaryPrecision::L5
                && material.source_id.is_none()
                && material.lifecycle_status == "ACTIVE"
                && material.generation_mode == "EXTRACTIVE_AUTO_PROJECT"
        }) {
            let _ = self.set_summary_material_lifecycle(material.id, "STALE".to_owned());
        }
        let material = SummaryMaterial {
            id: Uuid::new_v4(),
            project_id: Uuid::nil(),
            kind: SummaryKind::Setting,
            precision: SummaryPrecision::L5,
            source_id: None,
            source_version: None,
            content: extractive_summary(&content, 2_400),
            generation_mode: "EXTRACTIVE_AUTO_PROJECT".to_owned(),
            lifecycle_status: "ACTIVE".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let _ = self.upsert_summary_material(material);
    }

    /// A manuscript revision makes summaries derived from that chapter stale.
    /// They remain available for navigation, but context retrieval must not
    /// treat them as authoritative until rebuilt from the new revision.
    fn invalidate_chapter_summaries(&mut self, chapter_id: Uuid) {
        let Ok(materials) = self.list_summary_materials() else {
            return;
        };
        for material in materials.into_iter().filter(|material| {
            material.source_id == Some(chapter_id) && material.lifecycle_status == "ACTIVE"
        }) {
            let _ = self.set_summary_material_lifecycle(material.id, "STALE".to_owned());
        }
    }

    pub fn save_recovery_log(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
    ) -> Result<(), ManuscriptError> {
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .save_recovery_log(chapter_id, document_json)
            .map_err(ManuscriptError::Database)
    }

    pub fn list_recovery_logs(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<RecoveryLog>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .list_recovery_logs(chapter_id)
            .map_err(ManuscriptError::Database)
    }

    pub fn list_all_recovery_logs(&self) -> Result<Vec<RecoveryLog>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .list_all_recovery_logs()
            .map_err(ManuscriptError::Database)
    }

    pub fn clear_recovery_logs(&mut self, chapter_id: Uuid) -> Result<(), ManuscriptError> {
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .clear_recovery_logs(chapter_id)
            .map_err(ManuscriptError::Database)
    }

    pub fn merge_manuscript(
        &self,
        base: &str,
        current: &str,
        draft: &str,
    ) -> Result<MergeResult, ManuscriptError> {
        merge_documents(base, current, draft)
    }
}

fn extractive_summary(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let marker = "\n\n[中段原文请按需回查]\n\n";
    let available = max_chars.saturating_sub(marker.chars().count());
    let head_len = available.saturating_mul(2) / 5;
    let tail_len = available.saturating_sub(head_len);
    let head = text.chars().take(head_len).collect::<String>();
    let tail = text
        .chars()
        .skip(text.chars().count().saturating_sub(tail_len))
        .collect::<String>();
    format!("{head}{marker}{tail}")
}
