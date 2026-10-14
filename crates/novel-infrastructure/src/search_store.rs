use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub object_type: String,
    pub object_id: Uuid,
    pub block_id: Option<String>,
    pub source_version: Option<String>,
    pub snippet: String,
    pub title: Option<String>,
    pub chapter_id: Option<Uuid>,
    pub chapter_title: Option<String>,
    pub updated_at: Option<String>,
}

fn search_result_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchResult> {
    let object_id: String = row.get(1)?;
    let object_id = Uuid::parse_str(&object_id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let object_type: String = row.get(0)?;
    let source_version = if object_type == "MANUSCRIPT" {
        Some(format!("manuscript:{object_id}"))
    } else {
        row.get(2)?
    };
    Ok(SearchResult {
        object_type,
        object_id,
        block_id: None,
        source_version,
        snippet: row.get(3)?,
        title: None,
        chapter_id: None,
        chapter_title: None,
        updated_at: None,
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
        tx.execute("INSERT INTO search_index SELECT 'MANUSCRIPT', id, ?1, 'manuscript:' || id, document_json FROM manuscript_revisions WHERE chapter_id IN (SELECT id FROM chapters)", [project_id.to_string()])?;
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
        let literal_query = query.to_owned();
        let limit = i64::from(limit.clamp(1, 100));
        let offset = i64::from(offset);
        let short_query = query.chars().take(3).count() < 3;
        let sql = if short_query {
            "SELECT object_type, object_id, source_version, substr(content,1,180) FROM search_index WHERE project_id = ?1 AND (?2 IS NULL OR object_type = ?2) AND content LIKE '%' || ?3 || '%' ESCAPE '\\' ORDER BY rowid LIMIT ?4 OFFSET ?5"
        } else {
            "SELECT object_type, object_id, source_version, snippet(search_index, 4, '', '', '…', 12) FROM search_index WHERE project_id = ?1 AND (?2 IS NULL OR object_type = ?2) AND search_index MATCH ?3 ORDER BY rank, rowid LIMIT ?4 OFFSET ?5"
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
        let mut results = rows.collect::<Result<Vec<_>, _>>()?;
        self.enrich_search_results(project_id, &mut results)?;
        self.locate_manuscript_results(&mut results, &literal_query)?;
        Ok(results)
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
        let mut results = rows.collect::<Result<Vec<_>, _>>()?;
        self.enrich_search_results(project_id, &mut results)?;
        Ok(results)
    }

    fn enrich_search_results(
        &self,
        project_id: Uuid,
        results: &mut [SearchResult],
    ) -> Result<(), DatabaseError> {
        if results.is_empty() {
            return Ok(());
        }
        let ids = serde_json::to_string(
            &results
                .iter()
                .map(|result| result.object_id)
                .collect::<Vec<_>>(),
        )
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        // Enrich a whole result page without changing its order or revision identity.
        let mut statement = self.connection.prepare_cached(
            "SELECT s.object_type, s.object_id,
                CASE s.object_type
                    WHEN 'PLAN' THEN p.title WHEN 'ENTITY' THEN er.name WHEN 'CARD' THEN w.title
                    WHEN 'MANUSCRIPT' THEN chapter.title
                    WHEN 'SUMMARY' THEN CASE sm.generation_mode
                        WHEN 'EXTRACTIVE_AUTO' THEN '章节记忆' WHEN 'EXTRACTIVE_AUTO_PROJECT' THEN '作品概览'
                        WHEN 'EXTRACTIVE_AUTO_SETTINGS' THEN '设定概览' ELSE '参考摘要' END END,
                COALESCE(m.chapter_id, source.id, CASE WHEN p.kind = 'CHAPTER' THEN p.id END),
                COALESCE(chapter.title, source.title, CASE WHEN p.kind = 'CHAPTER' THEN p.title END),
                COALESCE(m.created_at, e.updated_at, sm.updated_at, w.updated_at,
                    strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(
                        (SELECT created_at FROM plan_node_revisions WHERE node_id = p.id ORDER BY revision DESC LIMIT 1),
                        p.created_at)))
             FROM json_each(?2) requested JOIN search_index s ON s.object_id = requested.value
             LEFT JOIN plan_nodes p ON s.object_type = 'PLAN' AND p.id = s.object_id
             LEFT JOIN entities e ON s.object_type = 'ENTITY' AND e.id = s.object_id AND e.project_id = ?1
             LEFT JOIN entity_revisions er ON er.id = e.current_revision_id AND er.entity_id = e.id
             LEFT JOIN writing_cards w ON s.object_type = 'CARD' AND w.id = s.object_id AND w.project_id = ?1
             LEFT JOIN summary_materials sm ON s.object_type = 'SUMMARY' AND sm.id = s.object_id AND sm.project_id = ?1
             LEFT JOIN manuscript_revisions m ON s.object_type = 'MANUSCRIPT' AND m.id = s.object_id
             LEFT JOIN plan_nodes chapter ON chapter.id = m.chapter_id
             LEFT JOIN plan_nodes source ON sm.kind = 'CHAPTER' AND source.id = sm.source_id AND source.kind = 'CHAPTER'
             WHERE s.project_id = ?1",
        )?;
        let rows = statement.query_map(rusqlite::params![project_id.to_string(), ids], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                (
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ),
            ))
        })?;
        let metadata = rows.collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        for result in results {
            if let Some((title, chapter_id, chapter_title, updated_at)) =
                metadata.get(&(result.object_type.clone(), result.object_id.to_string()))
            {
                result.title.clone_from(title);
                result.chapter_id = chapter_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok());
                result.chapter_title.clone_from(chapter_title);
                result.updated_at.clone_from(updated_at);
            }
        }
        Ok(())
    }

    fn locate_manuscript_results(
        &self,
        results: &mut [SearchResult],
        query: &str,
    ) -> Result<(), DatabaseError> {
        let needle = query.to_lowercase();
        let ids: Vec<_> = results
            .iter()
            .filter(|result| result.object_type == "MANUSCRIPT")
            .map(|result| result.object_id)
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        let ids = serde_json::to_string(&ids)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let mut statement = self.connection.prepare_cached(
            "SELECT m.id, m.document_json FROM json_each(?1) requested
             JOIN manuscript_revisions m ON m.id = requested.value",
        )?;
        let rows = statement.query_map([ids], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let documents = rows.collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        for result in results
            .iter_mut()
            .filter(|result| result.object_type == "MANUSCRIPT")
        {
            let Some(document) = documents
                .get(&result.object_id.to_string())
                .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
            else {
                continue;
            };
            if let Some((block_id, text)) =
                super::manuscript_source_store::manuscript_blocks(&document)
                    .into_iter()
                    .find(|(_, text)| text.to_lowercase().contains(&needle))
            {
                let lower = text.to_lowercase();
                let start = lower
                    .find(&needle)
                    .map_or(0, |start| lower[..start].chars().count());
                result.block_id = Some(block_id);
                result.snippet = text
                    .chars()
                    .skip(start.saturating_sub(50))
                    .take(180)
                    .collect();
            }
        }
        Ok(())
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
            assert!(database
                .search_project(project_id, query, Some("CARD"), 50, 0)
                .expect("filter")
                .is_empty());
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
        assert!(database
            .search_project_objects(project_id, &[])
            .expect("empty lookup")
            .is_empty());
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

    #[test]
    fn manuscript_search_locates_opaque_nested_blocks_and_historical_revisions() {
        let root = std::env::temp_dir().join(format!("ainovel-search-source-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "search test").unwrap();
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "章".into())
            .unwrap();
        let old = manager
            .save_manuscript(
                chapter.id,
                serde_json::json!({
                    "type": "doc", "content": [{"type":"blockquote","attrs":{"blockId":"parent"},
                        "content":[{"type":"paragraph","attrs":{"blockId":"block:1"},
                        "content":[{"type":"text","text":"调查者进入北境，进度50%，编号A_B。"}]}]}]
                })
                .to_string(),
                "TEST".into(),
            )
            .unwrap();
        manager.save_manuscript(chapter.id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"新正文"}]}]}"#.into(),
            "NEW".into()).unwrap();
        for query in ["调查者", "50%", "%", "_", " 北境 "] {
            let results = manager
                .search_project(query.into(), Some("MANUSCRIPT".into()), 50, 0)
                .unwrap();
            assert_eq!(results.len(), 1, "{query}");
            assert_eq!(results[0].object_id, old.id);
            assert_eq!(results[0].title.as_deref(), Some("章"));
            assert_eq!(results[0].chapter_id, Some(chapter.id));
            assert_eq!(results[0].chapter_title.as_deref(), Some("章"));
            assert_eq!(results[0].updated_at, Some(old.created_at.clone()));
            assert_eq!(results[0].block_id.as_deref(), Some("block:1"));
            assert_eq!(
                results[0].source_version,
                Some(format!("manuscript:{}", old.id))
            );
            assert!(results[0].snippet.starts_with("调查者"));
            assert!(!results[0].snippet.contains("\"type\""));
        }
        let metadata = manager
            .search_project("blockquote".into(), Some("MANUSCRIPT".into()), 50, 0)
            .unwrap();
        assert!(metadata.iter().all(|hit| hit.block_id.is_none()));
        assert_eq!(
            manager.search_project_objects(&[old.id]).unwrap()[0].source_version,
            Some(format!("manuscript:{}", old.id))
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn search_metadata_uses_current_names_and_handles_missing_objects() {
        let root = std::env::temp_dir().join(format!("ainovel-search-metadata-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let manifest = manager.create(&root, "metadata").unwrap();
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "铜铃之城".into())
            .unwrap();
        let results = manager
            .search_project("铜铃".into(), Some("PLAN".into()), 50, 0)
            .unwrap();
        assert_eq!(results[0].title.as_deref(), Some("铜铃之城"));
        assert_eq!(results[0].chapter_id, Some(chapter.id));
        assert!(results[0].updated_at.is_some());
        let unknown = Uuid::new_v4();
        insert(
            &manager.current.as_ref().unwrap().database,
            manifest.project_id,
            &unknown.to_string(),
            "missing metadata",
        );
        let missing = manager
            .search_project("missing".into(), None, 50, 0)
            .unwrap();
        assert_eq!(missing.len(), 1);
        assert!(missing[0].title.is_none());
        assert!(missing[0].updated_at.is_none());
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn search_enriches_entity_card_and_summary_metadata_in_requested_order() {
        let mut database = Database::in_memory().unwrap();
        let project = Uuid::new_v4();
        let entity = Uuid::new_v4();
        let entity_revision = Uuid::new_v4();
        let card = Uuid::new_v4();
        let summary = Uuid::new_v4();
        database
            .connection
            .execute(
                "INSERT INTO entities (id, project_id, entity_type, current_revision_id)
             VALUES (?1, ?2, 'CHARACTER', ?3)",
                rusqlite::params![
                    entity.to_string(),
                    project.to_string(),
                    entity_revision.to_string()
                ],
            )
            .unwrap();
        database
            .connection
            .execute(
                "INSERT INTO entity_revisions (id, entity_id, revision, name, description)
             VALUES (?1, ?2, 1, '沈砚', '调查者')",
                rusqlite::params![entity_revision.to_string(), entity.to_string()],
            )
            .unwrap();
        database
            .connection
            .execute(
                "INSERT INTO writing_cards (id, project_id, card_type, title, content)
             VALUES (?1, ?2, 'STYLE_RULE', '克制叙事', '调查者保持克制')",
                rusqlite::params![card.to_string(), project.to_string()],
            )
            .unwrap();
        database.connection.execute(
            "INSERT INTO summary_materials (id, project_id, kind, precision, content, generation_mode)
             VALUES (?1, ?2, 'SETTING', 'L1', '调查者的作品概览', 'EXTRACTIVE_AUTO_PROJECT')",
            rusqlite::params![summary.to_string(), project.to_string()],
        ).unwrap();
        database.rebuild_search_index(project).unwrap();
        let results = database
            .search_project_objects(project, &[card, summary, entity, card])
            .unwrap();
        assert_eq!(
            results
                .iter()
                .map(|hit| hit.title.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("克制叙事"),
                Some("作品概览"),
                Some("沈砚"),
                Some("克制叙事")
            ]
        );
        assert!(results.iter().all(|hit| hit.updated_at.is_some()));
        assert!(results.iter().all(|hit| hit.chapter_id.is_none()));
        let hits = database
            .search_project(project, "调查者", None, 50, 0)
            .unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|hit| !hit.snippet.contains("[调查者]")));
    }
}
