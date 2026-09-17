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
        Ok(revision)
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
