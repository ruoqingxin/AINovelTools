use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub object_type: String,
    pub object_id: Uuid,
    pub source_version: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Error)]
pub enum SearchStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("search database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl ProjectManager {
    pub fn rebuild_search_index(&mut self) -> Result<(), SearchStoreError> {
        let session = self.current.as_mut().ok_or(SearchStoreError::NoProject)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)
            .map_err(Into::into)
    }
    pub fn search_project(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<SearchResult>, SearchStoreError> {
        let session = self.current.as_ref().ok_or(SearchStoreError::NoProject)?;
        session
            .database
            .search_project(session.manifest.project_id, &query, limit)
            .map_err(Into::into)
    }
}

impl Database {
    pub(super) fn rebuild_search_index(&mut self, project_id: Uuid) -> Result<(), DatabaseError> {
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM search_index", [])?;
        tx.execute("INSERT INTO search_index (object_type, object_id, project_id, source_version, content) SELECT 'PLAN', id, ?1, CAST(revision AS TEXT), title FROM plan_nodes WHERE archived = 0", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'ENTITY', e.id, e.project_id, er.source_version, er.name || char(10) || er.description || char(10) || er.tags_json FROM entities e JOIN entity_revisions er ON er.id = e.current_revision_id WHERE e.project_id = ?1 AND e.lifecycle_status = 'ACTIVE'", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'SUMMARY', id, project_id, source_version, content FROM summary_materials WHERE project_id = ?1 AND lifecycle_status = 'ACTIVE'", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'CARD', id, project_id, source_version, title || char(10) || content FROM writing_cards WHERE project_id = ?1 AND enabled = 1", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'MANUSCRIPT', id, ?1, CAST(document_schema_version AS TEXT), document_json FROM manuscript_revisions WHERE chapter_id IN (SELECT id FROM chapters)", [project_id.to_string()])?;
        tx.commit()?;
        Ok(())
    }

    fn search_project(
        &self,
        project_id: Uuid,
        query: &str,
        limit: u32,
    ) -> Result<Vec<SearchResult>, DatabaseError> {
        let limit = i64::from(limit.clamp(1, 100));
        let sql = if query.chars().count() < 3 {
            "SELECT object_type, object_id, source_version, substr(content,1,180) FROM search_index WHERE project_id = ?1 AND content LIKE '%' || ?2 || '%' LIMIT ?3"
        } else {
            "SELECT object_type, object_id, source_version, snippet(search_index, 4, '[', ']', '…', 12) FROM search_index WHERE project_id = ?1 AND search_index MATCH ?2 LIMIT ?3"
        };
        let mut stmt = self.connection.prepare(sql)?;
        let rows = stmt.query_map(
            rusqlite::params![project_id.to_string(), query, limit],
            |row| {
                Ok(SearchResult {
                    object_type: row.get(0)?,
                    object_id: Uuid::parse_str(&row.get::<_, String>(1)?).unwrap(),
                    source_version: row.get(2)?,
                    snippet: row.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}
