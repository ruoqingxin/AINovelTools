use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityMoveTarget {
    pub id: Uuid,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveEntitiesInput {
    pub expected_project_id: Uuid,
    pub entity_type: EntityType,
    pub entities: Vec<EntityMoveTarget>,
}

impl ProjectManager {
    pub fn move_entities(
        &mut self,
        input: MoveEntitiesInput,
    ) -> Result<Vec<Entity>, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongMoveProject);
        }
        session.database.move_entities(input)
    }
}

impl Database {
    fn move_entities(&mut self, input: MoveEntitiesInput) -> Result<Vec<Entity>, EntityStoreError> {
        let unique: std::collections::HashSet<_> =
            input.entities.iter().map(|item| item.id).collect();
        if input.entities.is_empty()
            || input.entities.len() > 200
            || unique.len() != input.entities.len()
            || input.entities.iter().any(|item| item.expected_version < 1)
        {
            return Err(EntityStoreError::InvalidMove);
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut result = Vec::with_capacity(input.entities.len());
        for target in &input.entities {
            let entity = tx.query_row(
                "SELECT id,project_id,entity_type,lifecycle_status,current_revision_id,version,created_at,updated_at
                 FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![target.id.to_string(), input.expected_project_id.to_string()],
                map_entity,
            ).optional()?.ok_or(EntityStoreError::MissingEntity(target.id))?;
            if entity.version != target.expected_version {
                return Err(EntityStoreError::Contract(EntityError::Conflict {
                    expected: target.expected_version,
                    actual: entity.version,
                }));
            }
            // Classification is entity metadata. Keep revision IDs and all references unchanged.
            if entity.entity_type != input.entity_type {
                tx.execute(
                    "UPDATE entities SET entity_type=?1,version=version+1,
                     updated_at=(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     WHERE id=?2 AND project_id=?3 AND version=?4",
                    rusqlite::params![
                        entity_type_str(input.entity_type),
                        target.id.to_string(),
                        input.expected_project_id.to_string(),
                        target.expected_version
                    ],
                )?;
            }
            result.push(tx.query_row(
                "SELECT id,project_id,entity_type,lifecycle_status,current_revision_id,version,created_at,updated_at
                 FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![target.id.to_string(), input.expected_project_id.to_string()],
                map_entity,
            )?);
        }
        Self::rebuild_search_index_in_tx(&tx, input.expected_project_id)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        root: PathBuf,
        project_id: Uuid,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("entity-movement-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "movement").unwrap().project_id;
            Self {
                manager,
                root,
                project_id,
            }
        }

        fn entity(&mut self, name: &str) -> Entity {
            self.manager
                .upsert_entity(super::super::tests::input(name))
                .unwrap()
        }

        fn input(&self, entities: &[Entity], entity_type: EntityType) -> MoveEntitiesInput {
            MoveEntitiesInput {
                expected_project_id: self.project_id,
                entity_type,
                entities: entities
                    .iter()
                    .map(|entity| EntityMoveTarget {
                        id: entity.id,
                        expected_version: entity.version,
                    })
                    .collect(),
            }
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

    #[test]
    fn moves_in_place_preserving_history_references_rules_and_search_across_reopen() {
        let mut f = Fixture::new();
        let original = f.entity("Soul Master");
        let mut update = super::super::tests::input("Soul Master revised");
        update.id = Some(original.id);
        update.expected_version = Some(original.version);
        update.base_revision_id = Some(original.current_revision_id);
        let original = f.manager.upsert_entity(update).unwrap();
        let history = f.manager.list_entity_revisions(original.id).unwrap();
        let chapter = f
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into())
            .unwrap();
        f.manager
            .save_chapter_entity_references(ChapterEntitySave {
                project_id: f.project_id,
                chapter_id: chapter.id,
                expected_version: 0,
                entity_ids: vec![original.id],
            })
            .unwrap();
        let session = f
            .manager
            .create_discussion_session(
                "Discussion".into(),
                DiscussionScopeKind::Project,
                None,
                None,
            )
            .unwrap();
        let proposal_id = Uuid::new_v4();
        f.db()
            .connection
            .execute(
                "INSERT INTO discussion_workspaces(session_id,linked_entity_id) VALUES(?1,?2)",
                rusqlite::params![session.id.to_string(), original.id.to_string()],
            )
            .unwrap();
        f.db().connection.execute(
            "INSERT INTO discussion_design_proposals(id,session_id,workspace_version,entities_json,source_message_ids_json,context_version)
             VALUES(?1,?2,0,'[]','[]','test')",
            rusqlite::params![proposal_id.to_string(), session.id.to_string()],
        ).unwrap();
        f.db().connection.execute(
            "INSERT INTO author_settings(id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
             VALUES(?1,?2,?3,?4,'Do not change','AUTHOR_ONLY',?5)",
            rusqlite::params![Uuid::new_v4().to_string(), f.project_id.to_string(), original.id.to_string(),
                original.current_revision_id.to_string(), proposal_id.to_string()],
        ).unwrap();
        let input = f.input(std::slice::from_ref(&original), EntityType::Concept);
        let moved = f.manager.move_entities(input).unwrap().remove(0);
        assert_eq!(moved.id, original.id);
        assert_eq!(moved.current_revision_id, original.current_revision_id);
        assert_eq!(moved.version, original.version + 1);
        assert_eq!(moved.entity_type, EntityType::Concept);
        assert_eq!(moved.created_at, original.created_at);
        assert_eq!(f.manager.list_entity_revisions(moved.id).unwrap(), history);
        let refs = f
            .manager
            .get_chapter_entity_references(f.project_id, chapter.id)
            .unwrap();
        assert_eq!(refs.version, 1);
        assert_eq!(refs.entities[0].entity, moved);
        assert_eq!(
            f.manager
                .list_entity_chapters(f.project_id, moved.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            f.db()
                .connection
                .query_row("SELECT count(*) FROM author_settings", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            f.db()
                .connection
                .query_row(
                    "SELECT linked_entity_id FROM discussion_workspaces",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            moved.id.to_string()
        );
        assert_eq!(
            f.manager
                .search_project("Soul".into(), None, 20, 0)
                .unwrap()[0]
                .object_id,
            moved.id
        );
        assert!(
            f.db()
                .connection
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query([])
                .unwrap()
                .next()
                .unwrap()
                .is_none()
        );
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.manager.list_entities(true).unwrap(), vec![moved]);
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap(),
            history
        );
    }

    #[test]
    fn stale_missing_foreign_and_invalid_batches_leave_every_entity_unchanged() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        let input = f.input(&[first.clone(), second.clone()], EntityType::Concept);
        let mut stale = input.clone();
        stale.entities[1].expected_version += 1;
        assert!(matches!(
            f.manager.move_entities(stale),
            Err(EntityStoreError::Contract(EntityError::Conflict { .. }))
        ));
        let mut missing = input.clone();
        missing.entities[1].id = Uuid::new_v4();
        assert!(matches!(
            f.manager.move_entities(missing),
            Err(EntityStoreError::MissingEntity(_))
        ));
        let mut wrong = input.clone();
        wrong.expected_project_id = Uuid::new_v4();
        assert!(matches!(
            f.manager.move_entities(wrong),
            Err(EntityStoreError::WrongMoveProject)
        ));
        let foreign = f
            .manager
            .current
            .as_mut()
            .unwrap()
            .database
            .upsert_entity(Uuid::new_v4(), super::super::tests::input("Foreign"))
            .unwrap();
        let mut foreign_input = input.clone();
        foreign_input.entities[1].id = foreign.id;
        assert!(matches!(
            f.manager.move_entities(foreign_input),
            Err(EntityStoreError::MissingEntity(_))
        ));
        for entities in [
            vec![],
            vec![input.entities[0].clone(), input.entities[0].clone()],
            vec![EntityMoveTarget {
                id: first.id,
                expected_version: 0,
            }],
            (0..201)
                .map(|_| EntityMoveTarget {
                    id: Uuid::new_v4(),
                    expected_version: 1,
                })
                .collect(),
        ] {
            assert!(matches!(
                f.manager.move_entities(MoveEntitiesInput {
                    entities,
                    ..input.clone()
                }),
                Err(EntityStoreError::InvalidMove)
            ));
        }
        let cards = f.manager.list_entity_cards(true).unwrap();
        assert_eq!(cards.len(), 2);
        assert!(cards.iter().all(
            |card| card.entity.entity_type == EntityType::Character && card.entity.version == 1
        ));
        f.manager.close();
        f.manager.create(f.root.join("other"), "Other").unwrap();
        assert!(matches!(
            f.manager.move_entities(input),
            Err(EntityStoreError::WrongMoveProject)
        ));
    }

    #[test]
    fn database_failure_rolls_back_types_versions_and_search_for_the_whole_batch() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        f.db()
            .connection
            .execute_batch(&format!(
                "CREATE TRIGGER fail_move BEFORE UPDATE ON entities WHEN OLD.id='{}'
             BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
                second.id
            ))
            .unwrap();
        let input = f.input(&[first.clone(), second.clone()], EntityType::Concept);
        assert!(f.manager.move_entities(input).is_err());
        assert_eq!(f.db().get_entity(f.project_id, first.id).unwrap(), first);
        assert_eq!(f.db().get_entity(f.project_id, second.id).unwrap(), second);
        assert_eq!(
            f.manager
                .search_project("First".into(), None, 20, 0)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn search_rebuild_failure_does_not_commit_entity_moves() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        f.db()
            .connection
            .execute_batch("ALTER TABLE search_index RENAME TO unavailable_search_index;")
            .unwrap();
        let input = f.input(std::slice::from_ref(&first), EntityType::Concept);
        assert!(f.manager.move_entities(input).is_err());
        assert_eq!(f.db().get_entity(f.project_id, first.id).unwrap(), first);
        f.db()
            .connection
            .execute_batch("ALTER TABLE unavailable_search_index RENAME TO search_index;")
            .unwrap();
        assert_eq!(
            f.manager
                .search_project("First".into(), None, 20, 0)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn same_type_is_a_noop_and_archived_entities_can_move_without_being_restored() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let input = f.input(std::slice::from_ref(&first), EntityType::Character);
        assert_eq!(f.manager.move_entities(input).unwrap(), vec![first.clone()]);
        let mut entity = f
            .manager
            .set_entity_archived(first.id, true, first.version)
            .unwrap();
        for target in [
            EntityType::Concept,
            EntityType::Location,
            EntityType::Faction,
            EntityType::Item,
            EntityType::Character,
        ] {
            let input = f.input(std::slice::from_ref(&entity), target);
            let moved = f.manager.move_entities(input).unwrap().remove(0);
            assert_eq!(moved.entity_type, target);
            assert_eq!(moved.lifecycle_status, EntityLifecycleStatus::Archived);
            assert_eq!(moved.version, entity.version + 1);
            entity = moved;
        }
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap().len(), 1);
        assert!(
            f.manager
                .search_project("First".into(), None, 20, 0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn moving_invalidates_old_edit_versions_and_does_not_allow_implicit_upsert_reclassification() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let input = f.input(std::slice::from_ref(&first), EntityType::Concept);
        let moved = f.manager.move_entities(input).unwrap().remove(0);
        let mut edit = super::super::tests::input("Stale edit");
        edit.id = Some(first.id);
        edit.expected_version = Some(first.version);
        edit.base_revision_id = Some(first.current_revision_id);
        assert!(matches!(
            f.manager.upsert_entity(edit.clone()),
            Err(EntityStoreError::Contract(EntityError::Conflict { .. }))
        ));
        edit.expected_version = Some(moved.version);
        assert!(f.manager.upsert_entity(edit).is_err());
        assert_eq!(f.db().get_entity(f.project_id, moved.id).unwrap(), moved);
    }
}
