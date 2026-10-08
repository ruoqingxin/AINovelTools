use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub object_type: String,
    pub object_id: Uuid,
    pub block_id: Option<Uuid>,
    pub source_version: Option<String>,
    pub snippet: String,
}

fn search_result_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchResult> {
    let object_id: String = row.get(1)?;
    let object_id = Uuid::parse_str(&object_id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(SearchResult {
        object_type: row.get(0)?,
        object_id,
        block_id: None,
        source_version: row.get(2)?,
        snippet: row.get(3)?,
    })
}

#[derive(Debug, Error)]
pub enum SearchStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("search database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

impl ProjectManager {
    pub fn search_project_objects(
        &self,
        object_ids: &[Uuid],
    ) -> Result<Vec<SearchResult>, SearchStoreError> {
        let session = self.current.as_ref().ok_or(SearchStoreError::NoProject)?;
        session
            .database
            .search_project_objects(session.manifest.project_id, object_ids)
            .map_err(Into::into)
    }
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
        object_type: Option<String>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SearchResult>, SearchStoreError> {
        let session = self.current.as_ref().ok_or(SearchStoreError::NoProject)?;
        session
            .database
            .search_project(
                session.manifest.project_id,
                &query,
                object_type.as_deref(),
                limit,
                offset,
            )
            .map_err(Into::into)
    }
}

impl Database {
    pub(super) fn rebuild_search_index(&mut self, project_id: Uuid) -> Result<(), DatabaseError> {
        let tx = self.connection.transaction()?;
        Self::rebuild_search_index_in_tx(&tx, project_id)?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn rebuild_search_index_in_tx(
        tx: &rusqlite::Transaction<'_>,
        project_id: Uuid,
    ) -> Result<(), DatabaseError> {
        tx.execute("DELETE FROM search_index", [])?;
        tx.execute("INSERT INTO search_index (object_type, object_id, project_id, source_version, content) SELECT 'PLAN', id, ?1, CAST(revision AS TEXT), title FROM plan_nodes WHERE archived = 0", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'ENTITY', e.id, e.project_id, er.source_version, er.name || char(10) || er.description || char(10) || er.tags_json FROM entities e JOIN entity_revisions er ON er.id = e.current_revision_id WHERE e.project_id = ?1 AND e.lifecycle_status = 'ACTIVE'", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'SUMMARY', id, project_id, source_version, content FROM summary_materials WHERE project_id = ?1 AND lifecycle_status = 'ACTIVE'", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'CARD', id, project_id, source_version, title || char(10) || content FROM writing_cards WHERE project_id = ?1 AND enabled = 1", [project_id.to_string()])?;
        tx.execute("INSERT INTO search_index SELECT 'MANUSCRIPT', id, ?1, CAST(document_schema_version AS TEXT), document_json FROM manuscript_revisions WHERE chapter_id IN (SELECT id FROM chapters)", [project_id.to_string()])?;
        Ok(())
    }

    fn search_project(
        &self,
        project_id: Uuid,
        query: &str,
        object_type: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SearchResult>, DatabaseError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = i64::from(limit.clamp(1, 100));
        let offset = i64::from(offset);
        let short_query = query.chars().take(3).count() < 3;
        let sql = if short_query {
            "SELECT object_type, object_id, source_version, substr(content,1,180) FROM search_index WHERE project_id = ?1 AND (?2 IS NULL OR object_type = ?2) AND content LIKE '%' || ?3 || '%' ESCAPE '\\' ORDER BY rowid LIMIT ?4 OFFSET ?5"
        } else {
            "SELECT object_type, object_id, source_version, snippet(search_index, 4, '[', ']', '…', 12) FROM search_index WHERE project_id = ?1 AND (?2 IS NULL OR object_type = ?2) AND search_index MATCH ?3 ORDER BY rank, rowid LIMIT ?4 OFFSET ?5"
        };
        let query = if short_query {
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        } else {
            format!("\"{}\"", query.replace('"', "\"\""))
        };
        let mut stmt = self.connection.prepare_cached(sql)?;
        let rows = stmt.query_map(
            rusqlite::params![project_id.to_string(), object_type, query, limit, offset],
            search_result_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn search_project_objects(
        &self,
        project_id: Uuid,
        object_ids: &[Uuid],
    ) -> Result<Vec<SearchResult>, DatabaseError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(object_ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let mut stmt = self.connection.prepare_cached(
            "SELECT s.object_type, s.object_id, s.source_version, substr(s.content,1,180)
             FROM json_each(?2) requested JOIN search_index s ON s.object_id = requested.value
             WHERE s.project_id = ?1 ORDER BY CAST(requested.key AS INTEGER), s.rowid",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![project_id.to_string(), ids],
            search_result_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(database: &Database, project_id: Uuid, object_id: &str, content: &str) {
        database.connection.execute(
            "INSERT INTO search_index (object_type, object_id, project_id, source_version, content) VALUES ('ENTITY', ?1, ?2, 'test:1', ?3)",
            rusqlite::params![object_id, project_id.to_string(), content],
        ).expect("insert search result");
    }

    #[test]
    fn literal_search_handles_punctuation_wildcards_and_blank_input() {
        let database = Database::in_memory().expect("database");
        let project_id = Uuid::new_v4();
        let object_id = Uuid::new_v4();
        insert(
            &database,
            project_id,
            &object_id.to_string(),
            "调查者说\"北境\"，进度50%，编号A_B，路径C:\\。",
        );

        for query in ["调查者", "\"北境\"", "50%", "%", "_", "\\", " 北境 "] {
            let results = database
                .search_project(project_id, query, None, 50, 0)
                .expect("literal search");
            assert_eq!(results.len(), 1, "query: {query}");
            assert_eq!(results[0].object_id, object_id);
        }
        for query in ["", "   ", "调查者 OR 南境", "调查者*", "调查者!"] {
            assert!(
                database
                    .search_project(project_id, query, None, 50, 0)
                    .expect("literal search")
                    .is_empty(),
                "query: {query}"
            );
        }
        insert(
            &database,
            project_id,
            &Uuid::new_v4().to_string(),
            "不含通配符",
        );
        for query in ["%", "_"] {
            assert_eq!(
                database
                    .search_project(project_id, query, None, 50, 0)
                    .expect("escaped wildcard")
                    .len(),
                1
            );
        }
    }

    #[test]
    fn search_pages_have_stable_order_and_respect_project_and_type_filters() {
        let database = Database::in_memory().expect("database");
        let project_id = Uuid::new_v4();
        let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        for id in ids {
            insert(&database, project_id, &id.to_string(), "北境调查者");
        }
        insert(
            &database,
            Uuid::new_v4(),
            &Uuid::new_v4().to_string(),
            "北境调查者",
        );
        for query in ["北", "调查者"] {
            let actual: Vec<_> = (0..3)
                .map(|offset| {
                    database
                        .search_project(project_id, query, Some("ENTITY"), 1, offset)
                        .expect("page")[0]
                        .object_id
                })
                .collect();
            assert_eq!(actual, ids);
            assert!(
                database
                    .search_project(project_id, query, Some("CARD"), 50, 0)
                    .expect("filter")
                    .is_empty()
            );
        }
    }

    #[test]
    fn object_lookup_preserves_requested_order_and_duplicate_ids() {
        let database = Database::in_memory().expect("database");
        let project_id = Uuid::new_v4();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        insert(&database, project_id, &first.to_string(), "first");
        insert(&database, project_id, &second.to_string(), "second");
        insert(
            &database,
            Uuid::new_v4(),
            &other_project.to_string(),
            "other project",
        );
        let results = database
            .search_project_objects(
                project_id,
                &[second, other_project, Uuid::new_v4(), first, second],
            )
            .expect("object lookup");
        assert_eq!(
            results
                .iter()
                .map(|result| result.object_id)
                .collect::<Vec<_>>(),
            vec![second, first, second]
        );
        assert_eq!(results[0].source_version.as_deref(), Some("test:1"));
        assert_eq!(results[0].snippet, "second");
        assert!(
            database
                .search_project_objects(project_id, &[])
                .expect("empty lookup")
                .is_empty()
        );
    }

    #[test]
    fn malformed_search_ids_return_conversion_errors_instead_of_panicking() {
        let database = Database::in_memory().expect("database");
        let project_id = Uuid::new_v4();
        insert(&database, project_id, "invalid-uuid", "调查者");
        assert!(matches!(
            database.search_project(project_id, "调查者", None, 50, 0),
            Err(DatabaseError::Sqlite(
                rusqlite::Error::FromSqlConversionFailure(..)
            ))
        ));
    }
}
