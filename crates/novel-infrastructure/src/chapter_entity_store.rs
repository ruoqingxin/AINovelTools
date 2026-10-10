use super::*;
use std::collections::HashSet;

#[derive(Debug, Error)]
pub enum EntityReferenceError {
    #[error("no project is open")]
    NoProject,
    #[error("reference project does not match the open project")]
    WrongProject,
    #[error("reference chapter is missing, archived, or not a chapter")]
    InvalidChapter,
    #[error("entity reference is missing, archived, or belongs to another project")]
    InvalidEntity,
    #[error("choose at most eight distinct entity references")]
    InvalidSelection,
    #[error("chapter references changed in another operation; local edits were not saved")]
    Conflict,
    #[error(transparent)]
    Entity(#[from] EntityStoreError),
    #[error("entity reference database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterEntityReferences {
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub version: i64,
    pub entities: Vec<EntityCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterEntitySave {
    pub project_id: Uuid,
    pub chapter_id: Uuid,
    pub expected_version: i64,
    pub entity_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityChapter {
    pub chapter_id: Uuid,
    pub title: String,
    pub archived: bool,
}

fn check_chapter(
    connection: &Connection,
    id: Uuid,
    writable: bool,
) -> Result<(), EntityReferenceError> {
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM plan_nodes WHERE id=?1 AND kind='CHAPTER' AND (NOT ?2 OR archived=0))",
        rusqlite::params![id.to_string(), writable], |row| row.get(0),
    )?;
    if valid {
        Ok(())
    } else {
        Err(EntityReferenceError::InvalidChapter)
    }
}

impl ProjectManager {
    fn reference_project(&self, id: Uuid) -> Result<&ProjectSession, EntityReferenceError> {
        let session = self
            .current
            .as_ref()
            .ok_or(EntityReferenceError::NoProject)?;
        if session.manifest.project_id != id {
            return Err(EntityReferenceError::WrongProject);
        }
        Ok(session)
    }

    pub fn get_chapter_entity_references(
        &self,
        project_id: Uuid,
        chapter_id: Uuid,
    ) -> Result<ChapterEntityReferences, EntityReferenceError> {
        let session = self.reference_project(project_id)?;
        check_chapter(&session.database.connection, chapter_id, false)?;
        session
            .database
            .read_chapter_entity_references(project_id, chapter_id)
    }

    pub fn save_chapter_entity_references(
        &mut self,
        input: ChapterEntitySave,
    ) -> Result<ChapterEntityReferences, EntityReferenceError> {
        self.reference_project(input.project_id)?;
        if input.expected_version < 0
            || input.entity_ids.len() > 8
            || input.entity_ids.iter().collect::<HashSet<_>>().len() != input.entity_ids.len()
        {
            return Err(EntityReferenceError::InvalidSelection);
        }
        let session = self
            .current
            .as_mut()
            .ok_or(EntityReferenceError::NoProject)?;
        let tx = session.database.connection.transaction()?;
        check_chapter(&tx, input.chapter_id, true)?;
        let version = tx
            .query_row(
                "SELECT version FROM chapter_entity_reference_sets WHERE chapter_id=?1",
                [input.chapter_id.to_string()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0);
        if version != input.expected_version {
            return Err(EntityReferenceError::Conflict);
        }
        for id in &input.entity_ids {
            let valid: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM entities e JOIN entity_revisions r ON r.id=e.current_revision_id AND r.entity_id=e.id
                 WHERE e.id=?1 AND e.project_id=?2 AND (e.lifecycle_status='ACTIVE' OR EXISTS(
                     SELECT 1 FROM chapter_entity_references WHERE chapter_id=?3 AND entity_id=e.id)))",
                rusqlite::params![id.to_string(), input.project_id.to_string(), input.chapter_id.to_string()], |row| row.get(0),
            )?;
            if !valid {
                return Err(EntityReferenceError::InvalidEntity);
            }
        }
        tx.execute(
            "INSERT INTO chapter_entity_reference_sets(chapter_id,version) VALUES (?1,1)
             ON CONFLICT(chapter_id) DO UPDATE SET version=version+1",
            [input.chapter_id.to_string()],
        )?;
        tx.execute(
            "DELETE FROM chapter_entity_references WHERE chapter_id=?1",
            [input.chapter_id.to_string()],
        )?;
        for id in input.entity_ids {
            tx.execute(
                "INSERT INTO chapter_entity_references(chapter_id,entity_id) VALUES (?1,?2)",
                rusqlite::params![input.chapter_id.to_string(), id.to_string()],
            )?;
        }
        tx.commit()?;
        session
            .database
            .read_chapter_entity_references(input.project_id, input.chapter_id)
    }

    pub fn list_entity_chapters(
        &self,
        project_id: Uuid,
        entity_id: Uuid,
    ) -> Result<Vec<EntityChapter>, EntityReferenceError> {
        let session = self.reference_project(project_id)?;
        let exists: bool = session.database.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM entities WHERE id=?1 AND project_id=?2)",
            rusqlite::params![entity_id.to_string(), project_id.to_string()],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(EntityReferenceError::InvalidEntity);
        }
        let mut stmt = session.database.connection.prepare(
            "SELECT p.id,p.title,p.archived FROM chapter_entity_references ref JOIN plan_nodes p ON p.id=ref.chapter_id
             WHERE ref.entity_id=?1 AND p.kind='CHAPTER' ORDER BY p.sort_order,p.id",
        )?;
        let rows = stmt.query_map([entity_id.to_string()], |row| {
            let id: String = row.get(0)?;
            let chapter_id = Uuid::parse_str(&id).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(EntityChapter {
                chapter_id,
                title: row.get(1)?,
                archived: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub(crate) fn chapter_entity_context(
        &self,
        chapter_id: Uuid,
    ) -> Result<Option<ChapterEntityReferences>, EntityReferenceError> {
        let Some(session) = &self.current else {
            return Ok(None);
        };
        Ok(Some(session.database.read_chapter_entity_references(
            session.manifest.project_id,
            chapter_id,
        )?))
    }
}

impl Database {
    fn read_chapter_entity_references(
        &self,
        project_id: Uuid,
        chapter_id: Uuid,
    ) -> Result<ChapterEntityReferences, EntityReferenceError> {
        let version = self
            .connection
            .query_row(
                "SELECT version FROM chapter_entity_reference_sets WHERE chapter_id=?1",
                [chapter_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let mut stmt = self
            .connection
            .prepare("SELECT entity_id FROM chapter_entity_references WHERE chapter_id=?1")?;
        let ids = stmt
            .query_map([chapter_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        let entities = if ids.is_empty() {
            Vec::new()
        } else {
            self.list_entity_cards(project_id, true)?
                .into_iter()
                .filter(|card| ids.contains(&card.entity.id.to_string()))
                .collect::<Vec<_>>()
        };
        if entities.len() != ids.len() {
            return Err(EntityReferenceError::InvalidEntity);
        }
        Ok(ChapterEntityReferences {
            project_id,
            chapter_id,
            version,
            entities,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        project_id: Uuid,
        chapter_id: Uuid,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("chapter-entities-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager
                .create(&root, "entity references")
                .unwrap()
                .project_id;
            let chapter_id = manager
                .create_plan_node(None, PlanNodeKind::Chapter, "入城".into())
                .unwrap()
                .id;
            Self {
                manager,
                project_id,
                chapter_id,
                root,
            }
        }
        fn entity(&mut self, name: &str) -> Entity {
            self.manager.upsert_entity(input(name)).unwrap()
        }
        fn save(
            &mut self,
            version: i64,
            ids: &[Uuid],
        ) -> Result<ChapterEntityReferences, EntityReferenceError> {
            self.manager
                .save_chapter_entity_references(ChapterEntitySave {
                    project_id: self.project_id,
                    chapter_id: self.chapter_id,
                    expected_version: version,
                    entity_ids: ids.to_vec(),
                })
        }
        fn read(&self) -> ChapterEntityReferences {
            self.manager
                .get_chapter_entity_references(self.project_id, self.chapter_id)
                .unwrap()
        }
        fn db(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn input(name: &str) -> EntityInput {
        EntityInput {
            id: None,
            entity_type: EntityType::Character,
            name: name.into(),
            aliases: vec!["别名".into()],
            description: format!("{name}的作者设定"),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: None,
            source_version: Some("same-import-file".into()),
            expected_version: None,
        }
    }
    fn context(chapter_id: Uuid) -> novel_application::AssembleContextInput {
        novel_application::AssembleContextInput {
            chapter_id,
            target_revision_id: None,
            action: AiAction::Draft,
            chapter_title: "入城".into(),
            chapter_plan: String::new(),
            volume_plan: String::new(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 4096,
        }
    }

    #[test]
    fn references_reopen_and_inverse_lookup_without_creating_facts_plans_or_revisions() {
        let mut f = Fixture::new();
        let entity = f.entity("沈砚");
        let baseline = f.db().connection.total_changes();
        assert_eq!(f.read().version, 0);
        assert_eq!(f.db().connection.total_changes(), baseline);
        let saved = f.save(0, &[entity.id]).unwrap();
        assert_eq!(saved.version, 1);
        assert_eq!(saved.entities[0].entity.id, entity.id);
        assert_eq!(
            f.manager
                .list_entity_chapters(f.project_id, entity.id)
                .unwrap()[0]
                .chapter_id,
            f.chapter_id
        );
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.read().version, 1);
        assert_eq!(f.read().entities[0].revision.id, entity.current_revision_id);
        assert!(f.manager.list_current_facts().unwrap().is_empty());
        assert!(f.manager.list_planning_sections().unwrap().is_empty());
        assert!(
            f.manager
                .list_manuscript_revisions(f.chapter_id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap().len(), 1);
    }

    #[test]
    fn selection_cas_and_empty_tombstones_reject_stale_writers() {
        let mut f = Fixture::new();
        let first = f.entity("沈砚");
        let second = f.entity("守门人");
        f.save(0, &[first.id]).unwrap();
        assert!(matches!(
            f.save(0, &[second.id]),
            Err(EntityReferenceError::Conflict)
        ));
        assert_eq!(f.read().entities[0].entity.id, first.id);
        f.save(1, &[]).unwrap();
        assert_eq!(f.read().version, 2);
        assert!(f.read().entities.is_empty());
        assert!(matches!(
            f.save(0, &[second.id]),
            Err(EntityReferenceError::Conflict)
        ));
        assert!(matches!(
            f.save(1, &[second.id]),
            Err(EntityReferenceError::Conflict)
        ));
        assert!(
            f.manager
                .list_entity_chapters(f.project_id, first.id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_projects_chapters_entities_duplicates_and_limits_do_not_mutate_the_set() {
        let mut f = Fixture::new();
        let entity = f.entity("沈砚");
        let base = ChapterEntitySave {
            project_id: f.project_id,
            chapter_id: f.chapter_id,
            expected_version: 0,
            entity_ids: vec![entity.id],
        };
        let outline = f
            .manager
            .create_plan_node(None, PlanNodeKind::Outline, "大纲".into())
            .unwrap();
        for request in [
            ChapterEntitySave {
                project_id: Uuid::new_v4(),
                ..base.clone()
            },
            ChapterEntitySave {
                chapter_id: outline.id,
                ..base.clone()
            },
            ChapterEntitySave {
                chapter_id: Uuid::new_v4(),
                ..base.clone()
            },
            ChapterEntitySave {
                entity_ids: vec![Uuid::new_v4()],
                ..base.clone()
            },
            ChapterEntitySave {
                entity_ids: vec![entity.id, entity.id],
                ..base.clone()
            },
            ChapterEntitySave {
                entity_ids: (0..9).map(|_| Uuid::new_v4()).collect(),
                ..base.clone()
            },
            ChapterEntitySave {
                expected_version: -1,
                ..base.clone()
            },
        ] {
            assert!(f.manager.save_chapter_entity_references(request).is_err());
        }
        f.db()
            .connection
            .execute(
                "UPDATE entities SET project_id=?1 WHERE id=?2",
                rusqlite::params![Uuid::new_v4().to_string(), entity.id.to_string()],
            )
            .unwrap();
        assert!(matches!(
            f.save(0, &[entity.id]),
            Err(EntityReferenceError::InvalidEntity)
        ));
        assert_eq!(f.read().version, 0);
        assert!(
            f.manager
                .list_entity_chapters(f.project_id, entity.id)
                .is_err()
        );
        assert!(
            f.manager
                .get_chapter_entity_references(Uuid::new_v4(), f.chapter_id)
                .is_err()
        );
        assert!(
            ProjectManager::new()
                .get_chapter_entity_references(f.project_id, f.chapter_id)
                .is_err()
        );
    }

    #[test]
    fn archived_references_remain_visible_and_removable_but_cannot_be_added_to_other_chapters() {
        let mut f = Fixture::new();
        let entity = f.entity("沈砚");
        f.save(0, &[entity.id]).unwrap();
        f.manager
            .set_entity_archived(entity.id, true, entity.version)
            .unwrap();
        assert_eq!(
            f.read().entities[0].entity.lifecycle_status,
            EntityLifecycleStatus::Archived
        );
        f.save(1, &[entity.id]).unwrap();
        let other = f
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "第二章".into())
            .unwrap();
        assert!(matches!(
            f.manager.save_chapter_entity_references(ChapterEntitySave {
                project_id: f.project_id,
                chapter_id: other.id,
                expected_version: 0,
                entity_ids: vec![entity.id]
            }),
            Err(EntityReferenceError::InvalidEntity)
        ));
        f.manager
            .update_plan_node(f.chapter_id, "归档章".into(), true)
            .unwrap();
        assert!(matches!(
            f.save(2, &[]),
            Err(EntityReferenceError::InvalidChapter)
        ));
        assert!(
            f.manager
                .list_entity_chapters(f.project_id, entity.id)
                .unwrap()[0]
                .archived
        );
        f.manager
            .update_plan_node(f.chapter_id, "入城".into(), false)
            .unwrap();
        f.save(2, &[]).unwrap();
        assert!(f.read().entities.is_empty());
    }

    #[test]
    fn mid_write_failure_rolls_back_removed_links_and_version_increment() {
        let mut f = Fixture::new();
        let first = f.entity("沈砚");
        let second = f.entity("守门人");
        f.save(0, &[first.id]).unwrap();
        f.db()
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_reference BEFORE INSERT ON chapter_entity_references
            BEGIN SELECT RAISE(ABORT,'reference failure'); END;",
            )
            .unwrap();
        assert!(f.save(1, &[second.id]).is_err());
        assert_eq!(f.read().version, 1);
        assert_eq!(f.read().entities[0].entity.id, first.id);
    }

    #[test]
    fn linked_entities_prioritize_current_revisions_and_invalidate_context_when_changed_or_removed()
    {
        let mut f = Fixture::new();
        let selected = f.entity("不在章名里的角色");
        for index in 0..12 {
            f.entity(&format!("其他人物{index}"));
        }
        f.save(0, &[selected.id]).unwrap();
        let input = context(f.chapter_id);
        let before_changes = f.db().connection.total_changes();
        let first = f
            .manager
            .assemble_context_with_project_knowledge(&input)
            .unwrap();
        assert!(
            first
                .retrieval_evidence
                .iter()
                .any(|item| item.source_id == selected.id
                    && item.source_revision
                        == format!(
                            "entity:{}:revision:{}",
                            selected.id, selected.current_revision_id
                        ))
        );
        assert_eq!(f.db().connection.total_changes(), before_changes);
        let mut update = input_entity(&selected);
        update.name = "新姓名".into();
        let current = f.manager.upsert_entity(update).unwrap();
        let next = f
            .manager
            .assemble_context_with_project_knowledge(&input)
            .unwrap();
        assert_ne!(first.context_version, next.context_version);
        assert!(next.retrieval_evidence.iter().any(|item| {
            item.source_id == selected.id
                && item
                    .source_revision
                    .ends_with(&current.current_revision_id.to_string())
        }));
        assert_eq!(f.read().entities[0].revision.name, "新姓名");
        f.save(1, &[]).unwrap();
        assert_ne!(
            next.context_version,
            f.manager
                .assemble_context_with_project_knowledge(&input)
                .unwrap()
                .context_version
        );
        f.save(2, &[selected.id]).unwrap();
        f.manager
            .set_entity_archived(selected.id, true, current.version)
            .unwrap();
        let archived = f
            .manager
            .assemble_context_with_project_knowledge(&input)
            .unwrap();
        assert!(
            !archived
                .retrieval_evidence
                .iter()
                .any(|item| item.source_id == selected.id)
        );
        assert!(f.manager.list_current_facts().unwrap().is_empty());
    }

    fn input_entity(entity: &Entity) -> EntityInput {
        EntityInput {
            id: Some(entity.id),
            expected_version: Some(entity.version),
            base_revision_id: Some(entity.current_revision_id),
            ..input("新设定")
        }
    }

    #[test]
    fn broken_reference_storage_blocks_context_instead_of_silently_ignoring_the_selection() {
        let f = Fixture::new();
        f.db()
            .connection
            .execute_batch("DROP TABLE chapter_entity_references")
            .unwrap();
        assert!(matches!(
            f.manager
                .assemble_context_with_project_knowledge(&context(f.chapter_id)),
            Err(novel_application::ContextError::ProjectKnowledgeUnavailable(_))
        ));
    }

    #[test]
    fn association_identity_invalidates_context_even_when_an_entity_is_not_attached() {
        let mut f = Fixture::new();
        let entities = (0..8)
            .map(|index| f.entity(&format!("人物{index}")))
            .collect::<Vec<_>>();
        let ids = entities.iter().map(|entity| entity.id).collect::<Vec<_>>();
        f.save(0, &ids).unwrap();
        let first = f
            .manager
            .assemble_context_with_project_knowledge(&context(f.chapter_id))
            .unwrap();
        let omitted = entities
            .iter()
            .find(|entity| {
                !first
                    .retrieval_evidence
                    .iter()
                    .any(|item| item.source_id == entity.id)
            })
            .unwrap();
        f.manager.upsert_entity(input_entity(omitted)).unwrap();
        let next = f
            .manager
            .assemble_context_with_project_knowledge(&context(f.chapter_id))
            .unwrap();
        assert_ne!(first.context_version, next.context_version);
    }
}
