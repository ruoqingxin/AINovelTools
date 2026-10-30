use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityGroup {
    pub id: Uuid,
    pub entity_type: EntityType,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityGroupMembership {
    pub entity_id: Uuid,
    pub group_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityGroupState {
    pub project_id: Uuid,
    pub version: i64,
    pub groups: Vec<EntityGroup>,
    pub memberships: Vec<EntityGroupMembership>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum EntityGroupAction {
    Create {
        entity_type: EntityType,
        name: String,
    },
    Rename {
        id: Uuid,
        name: String,
    },
    Delete {
        id: Uuid,
    },
    Move {
        group_id: Option<Uuid>,
        entities: Vec<EntityMoveTarget>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEntityGroupsInput {
    pub expected_project_id: Uuid,
    pub expected_version: i64,
    pub action: EntityGroupAction,
}

impl ProjectManager {
    pub fn get_entity_groups(
        &self,
        project_id: Uuid,
    ) -> Result<EntityGroupState, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != project_id {
            return Err(EntityStoreError::WrongGroupProject);
        }
        let tx = session.database.connection.unchecked_transaction()?;
        let state = read_groups(&tx, project_id)?;
        tx.commit()?;
        Ok(state)
    }

    pub fn update_entity_groups(
        &mut self,
        input: UpdateEntityGroupsInput,
    ) -> Result<EntityGroupState, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongGroupProject);
        }
        let tx = session
            .database
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let project_id = input.expected_project_id;
        let state = read_groups(&tx, project_id)?;
        if input.expected_version != state.version {
            return Err(EntityStoreError::GroupConflict);
        }
        let find_group = |id| {
            state
                .groups
                .iter()
                .find(|group| group.id == id)
                .ok_or(EntityStoreError::MissingGroup(id))
        };
        let validate_name = |name: &str, entity_type: EntityType, id: Option<Uuid>| {
            let name = name.trim();
            if name.is_empty()
                || name.chars().count() > 64
                || ["全部", "未分组"].contains(&name)
                || name.chars().any(char::is_control)
            {
                return Err(EntityStoreError::InvalidGroup(
                    "分组名称需为 1 至 64 个字符，不能使用“全部”或“未分组”。".into(),
                ));
            }
            if state.groups.iter().any(|group| {
                group.entity_type == entity_type
                    && Some(group.id) != id
                    && group.name.to_lowercase() == name.to_lowercase()
            }) {
                return Err(EntityStoreError::InvalidGroup(
                    "同一实体类型下已有同名分组。".into(),
                ));
            }
            Ok(name.to_owned())
        };
        match input.action {
            EntityGroupAction::Create { entity_type, name } => {
                let name = validate_name(&name, entity_type, None)?;
                tx.execute(
                    "INSERT INTO entity_groups(id,project_id,entity_type,name) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![
                        Uuid::new_v4().to_string(),
                        project_id.to_string(),
                        entity_type_str(entity_type),
                        name
                    ],
                )?;
            }
            EntityGroupAction::Rename { id, name } => {
                let group = find_group(id)?;
                let name = validate_name(&name, group.entity_type, Some(id))?;
                if name != group.name {
                    tx.execute(
                        "UPDATE entity_groups SET name=?1 WHERE id=?2 AND project_id=?3",
                        rusqlite::params![name, id.to_string(), project_id.to_string()],
                    )?;
                }
            }
            EntityGroupAction::Delete { id } => {
                find_group(id)?;
                tx.execute(
                    "DELETE FROM entity_groups WHERE id=?1 AND project_id=?2",
                    rusqlite::params![id.to_string(), project_id.to_string()],
                )?;
            }
            EntityGroupAction::Move { group_id, entities } => {
                let group = group_id.map(find_group).transpose()?;
                let unique: std::collections::HashSet<_> =
                    entities.iter().map(|entity| entity.id).collect();
                if entities.is_empty()
                    || entities.len() > 200
                    || unique.len() != entities.len()
                    || entities.iter().any(|entity| entity.expected_version < 1)
                {
                    return Err(EntityStoreError::InvalidMove);
                }
                for target in entities {
                    let entity = tx.query_row(
                        "SELECT id,project_id,entity_type,lifecycle_status,current_revision_id,version,created_at,updated_at
                         FROM entities WHERE id=?1 AND project_id=?2",
                        rusqlite::params![target.id.to_string(), project_id.to_string()], map_entity,
                    ).optional()?.ok_or(EntityStoreError::MissingEntity(target.id))?;
                    if entity.version != target.expected_version {
                        return Err(EntityError::Conflict {
                            expected: target.expected_version,
                            actual: entity.version,
                        }
                        .into());
                    }
                    if let Some(group) = group {
                        if entity.entity_type != group.entity_type {
                            return Err(EntityStoreError::InvalidGroup(
                                "只能移入同一实体类型下的分组；不同类型的实体请分批整理。".into(),
                            ));
                        }
                        tx.execute(
                            "INSERT INTO entity_group_memberships(project_id,entity_id,group_id) VALUES(?1,?2,?3)
                             ON CONFLICT(entity_id) DO UPDATE SET group_id=excluded.group_id
                             WHERE entity_group_memberships.group_id<>excluded.group_id",
                            rusqlite::params![project_id.to_string(), target.id.to_string(), group.id.to_string()],
                        )?;
                    } else {
                        tx.execute("DELETE FROM entity_group_memberships WHERE entity_id=?1 AND project_id=?2",
                            rusqlite::params![target.id.to_string(), project_id.to_string()])?;
                    }
                }
            }
        }
        let state = read_groups(&tx, project_id)?;
        tx.commit()?;
        Ok(state)
    }
}

fn read_groups(
    connection: &rusqlite::Connection,
    project_id: Uuid,
) -> Result<EntityGroupState, EntityStoreError> {
    let project = project_id.to_string();
    let version = connection
        .query_row(
            "SELECT version FROM entity_group_state WHERE project_id=?1",
            [&project],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let mut statement = connection.prepare(
        "SELECT id,entity_type,name FROM entity_groups WHERE project_id=?1 ORDER BY name COLLATE NOCASE,id",
    )?;
    let groups = statement
        .query_map([&project], |row| {
            Ok(EntityGroup {
                id: parse_group_uuid(row, 0)?,
                entity_type: parse_entity_type(&row.get::<_, String>(1)?)?,
                name: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut statement = connection.prepare(
        "SELECT entity_id,group_id FROM entity_group_memberships WHERE project_id=?1 ORDER BY entity_id",
    )?;
    let memberships = statement
        .query_map([&project], |row| {
            Ok(EntityGroupMembership {
                entity_id: parse_group_uuid(row, 0)?,
                group_id: parse_group_uuid(row, 1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(EntityGroupState {
        project_id,
        version,
        groups,
        memberships,
    })
}

fn parse_group_uuid(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&row.get::<_, String>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

impl Database {
    pub(crate) fn migrate_entity_groups(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS entity_group_state (
                project_id TEXT PRIMARY KEY NOT NULL,
                version INTEGER NOT NULL CHECK(version >= 0)
             );
             CREATE TABLE IF NOT EXISTS entity_groups (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL,
                entity_type TEXT NOT NULL CHECK(entity_type IN ('CHARACTER','LOCATION','FACTION','ITEM','CONCEPT')),
                name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64),
                UNIQUE(project_id,entity_type,name COLLATE NOCASE)
             );
             CREATE TABLE IF NOT EXISTS entity_group_memberships (
                project_id TEXT NOT NULL,
                entity_id TEXT PRIMARY KEY NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                group_id TEXT NOT NULL REFERENCES entity_groups(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_entity_group_memberships_group ON entity_group_memberships(group_id);
             CREATE TRIGGER IF NOT EXISTS clear_entity_group_on_type_change
             AFTER UPDATE OF entity_type ON entities WHEN NEW.entity_type<>OLD.entity_type BEGIN
                DELETE FROM entity_group_memberships WHERE entity_id=NEW.id;
             END;",
        )?;
        for event in ["INSERT", "UPDATE"] {
            tx.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS validate_entity_group_membership_{event}
                 BEFORE {event} ON entity_group_memberships
                 WHEN NOT EXISTS (
                    SELECT 1 FROM entities e JOIN entity_groups g ON g.id=NEW.group_id
                    WHERE e.id=NEW.entity_id AND e.project_id=NEW.project_id
                      AND g.project_id=NEW.project_id AND e.entity_type=g.entity_type
                 ) BEGIN SELECT RAISE(ABORT,'invalid entity group membership'); END;"
            ))?;
        }
        // Cascades and type correction must invalidate stale folder selections too.
        for table in ["entity_groups", "entity_group_memberships"] {
            for event in ["INSERT", "UPDATE", "DELETE"] {
                let row = if event == "DELETE" { "OLD" } else { "NEW" };
                tx.execute_batch(&format!(
                    "CREATE TRIGGER IF NOT EXISTS bump_{table}_{event} AFTER {event} ON {table} BEGIN
                     INSERT INTO entity_group_state(project_id,version) VALUES({row}.project_id,1)
                     ON CONFLICT(project_id) DO UPDATE SET version=version+1; END;"
                ))?;
            }
        }
        tx.execute(
            "INSERT INTO schema_migrations(version,name) VALUES(68,'entity_library_groups')",
            [],
        )?;
        tx.commit()?;
        Ok(())
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
            let root = std::env::temp_dir().join(format!("entity-groups-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "groups").unwrap().project_id;
            Self {
                manager,
                root,
                project_id,
            }
        }
        fn db(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }
        fn state(&self) -> EntityGroupState {
            self.manager.get_entity_groups(self.project_id).unwrap()
        }
        fn entity(&mut self, name: &str) -> Entity {
            self.manager
                .upsert_entity(super::super::tests::input(name))
                .unwrap()
        }
        fn input(&self, action: EntityGroupAction) -> UpdateEntityGroupsInput {
            UpdateEntityGroupsInput {
                expected_project_id: self.project_id,
                expected_version: self.state().version,
                action,
            }
        }
        fn apply(&mut self, action: EntityGroupAction) -> EntityGroupState {
            self.manager
                .update_entity_groups(self.input(action))
                .unwrap()
        }
        fn group(&mut self, entity_type: EntityType, name: &str) -> EntityGroup {
            self.apply(EntityGroupAction::Create {
                entity_type,
                name: name.into(),
            })
            .groups
            .into_iter()
            .find(|group| group.entity_type == entity_type && group.name == name.trim())
            .unwrap()
        }
        fn movement(group_id: Option<Uuid>, entities: &[Entity]) -> EntityGroupAction {
            EntityGroupAction::Move {
                group_id,
                entities: entities
                    .iter()
                    .map(|entity| EntityMoveTarget {
                        id: entity.id,
                        expected_version: entity.version,
                    })
                    .collect(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn groups_are_project_metadata_with_validated_unique_names_and_read_only_reopen() {
        let mut f = Fixture::new();
        assert_eq!(f.state().version, 0);
        let changes = f.db().connection.total_changes();
        assert!(f.state().groups.is_empty());
        assert_eq!(f.db().connection.total_changes(), changes);
        let group = f.group(EntityType::Character, "  Main  ");
        f.group(EntityType::Concept, "Main");
        let old = f.state();
        for name in [
            "",
            "  ",
            "全部",
            "未分组",
            "main",
            "bad\nname",
            &"x".repeat(65),
        ] {
            let input = f.input(EntityGroupAction::Create {
                entity_type: EntityType::Character,
                name: name.into(),
            });
            assert!(f.manager.update_entity_groups(input).is_err());
            assert_eq!(f.state(), old);
        }
        f.apply(EntityGroupAction::Rename {
            id: group.id,
            name: "Main cast".into(),
        });
        let state = f.state();
        let noop = f.apply(EntityGroupAction::Rename {
            id: group.id,
            name: " Main cast ".into(),
        });
        assert_eq!(state, noop);
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.state(), state);
        assert!(f.manager.list_entities(true).unwrap().is_empty());
    }

    #[test]
    fn grouping_and_folder_deletion_preserve_exact_entities_history_links_and_search() {
        let mut f = Fixture::new();
        let entity = f.entity("Original");
        let group = f.group(EntityType::Character, "Cast");
        let cards = f.manager.list_entities(true).unwrap();
        let history = f.manager.list_entity_revisions(entity.id).unwrap();
        let chapter = f
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into())
            .unwrap();
        f.manager
            .save_chapter_entity_references(ChapterEntitySave {
                project_id: f.project_id,
                chapter_id: chapter.id,
                expected_version: 0,
                entity_ids: vec![entity.id],
            })
            .unwrap();
        let state = f.apply(Fixture::movement(
            Some(group.id),
            std::slice::from_ref(&entity),
        ));
        assert_eq!(
            state.memberships,
            [EntityGroupMembership {
                entity_id: entity.id,
                group_id: group.id
            }]
        );
        let noop = f.apply(Fixture::movement(
            Some(group.id),
            std::slice::from_ref(&entity),
        ));
        assert_eq!(noop, state);
        assert_eq!(f.manager.list_entities(true).unwrap(), cards);
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap(), history);
        f.apply(EntityGroupAction::Rename {
            id: group.id,
            name: "Heroes".into(),
        });
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.state().memberships, state.memberships);
        let state = f.apply(EntityGroupAction::Delete { id: group.id });
        assert!(state.groups.is_empty());
        assert!(state.memberships.is_empty());
        assert_eq!(f.manager.list_entities(true).unwrap(), cards);
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap(), history);
        assert_eq!(
            f.manager
                .get_chapter_entity_references(f.project_id, chapter.id)
                .unwrap()
                .entities[0]
                .entity,
            entity
        );
        assert_eq!(
            f.manager
                .search_project("Original".into(), None, 20, 0)
                .unwrap()[0]
                .object_id,
            entity.id
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
    }

    #[test]
    fn invalid_cross_type_foreign_missing_and_stale_moves_roll_back_the_entire_batch() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        let group = f.group(EntityType::Character, "Cast");
        let other_type = f.group(EntityType::Concept, "Rules");
        let base = f.input(Fixture::movement(
            Some(group.id),
            &[first.clone(), second.clone()],
        ));
        let before = f.state();
        let mut stale_group = base.clone();
        stale_group.expected_version -= 1;
        assert!(matches!(
            f.manager.update_entity_groups(stale_group),
            Err(EntityStoreError::GroupConflict)
        ));
        let foreign = f
            .manager
            .current
            .as_mut()
            .unwrap()
            .database
            .upsert_entity(Uuid::new_v4(), super::super::tests::input("Foreign"))
            .unwrap();
        let mut batches = vec![];
        for second_id in [Uuid::new_v4(), foreign.id] {
            batches.push(vec![
                EntityMoveTarget {
                    id: first.id,
                    expected_version: first.version,
                },
                EntityMoveTarget {
                    id: second_id,
                    expected_version: 1,
                },
            ]);
        }
        batches.push(vec![
            EntityMoveTarget {
                id: first.id,
                expected_version: first.version,
            },
            EntityMoveTarget {
                id: second.id,
                expected_version: second.version + 1,
            },
        ]);
        batches.push(vec![]);
        batches.push(vec![EntityMoveTarget {
            id: first.id,
            expected_version: 0,
        }]);
        batches.push(vec![
            EntityMoveTarget {
                id: first.id,
                expected_version: 1
            };
            2
        ]);
        batches.push(
            (0..201)
                .map(|_| EntityMoveTarget {
                    id: Uuid::new_v4(),
                    expected_version: 1,
                })
                .collect(),
        );
        for entities in batches {
            let input = f.input(EntityGroupAction::Move {
                group_id: Some(group.id),
                entities,
            });
            assert!(f.manager.update_entity_groups(input).is_err());
            assert_eq!(f.state(), before);
        }
        for id in [other_type.id, Uuid::new_v4()] {
            let input = f.input(Fixture::movement(Some(id), std::slice::from_ref(&first)));
            assert!(f.manager.update_entity_groups(input).is_err());
            assert_eq!(f.state(), before);
        }
        assert_eq!(f.db().get_entity(f.project_id, first.id).unwrap(), first);
        assert_eq!(f.db().get_entity(f.project_id, second.id).unwrap(), second);
    }

    #[test]
    fn type_correction_entity_deletion_and_ungrouping_clean_memberships_and_invalidate_old_snapshots()
     {
        let mut f = Fixture::new();
        let entity = f.entity("Original");
        let other = f.entity("Other");
        let group = f.group(EntityType::Character, "Cast");
        f.apply(Fixture::movement(
            Some(group.id),
            &[entity.clone(), other.clone()],
        ));
        let stale = f.input(EntityGroupAction::Delete { id: group.id });
        let history = f.manager.list_entity_revisions(entity.id).unwrap();
        let archived = f
            .manager
            .set_entity_archived(entity.id, true, entity.version)
            .unwrap();
        assert_eq!(f.state().memberships.len(), 2);
        let moved = f
            .manager
            .move_entities(MoveEntitiesInput {
                expected_project_id: f.project_id,
                entity_type: EntityType::Concept,
                entities: vec![EntityMoveTarget {
                    id: archived.id,
                    expected_version: archived.version,
                }],
            })
            .unwrap()
            .remove(0);
        assert_eq!(moved.lifecycle_status, EntityLifecycleStatus::Archived);
        assert_eq!(
            f.state().memberships,
            [EntityGroupMembership {
                entity_id: other.id,
                group_id: group.id
            }]
        );
        assert!(matches!(
            f.manager.update_entity_groups(stale),
            Err(EntityStoreError::GroupConflict)
        ));
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap(), history);
        f.apply(Fixture::movement(None, std::slice::from_ref(&other)));
        assert!(f.state().memberships.is_empty());
        f.apply(Fixture::movement(
            Some(group.id),
            std::slice::from_ref(&other),
        ));
        let old = f.state();
        f.manager
            .delete_entities(DeleteEntitiesInput {
                expected_project_id: f.project_id,
                entities: vec![EntityDeleteTarget {
                    id: other.id,
                    expected_version: other.version,
                }],
            })
            .unwrap();
        assert!(f.state().memberships.is_empty());
        assert!(f.state().version > old.version);
        assert_eq!(f.state().groups.len(), 1);
    }

    #[test]
    fn membership_and_folder_deletion_failures_are_atomic_including_group_versions() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        let group = f.group(EntityType::Character, "Cast");
        let before = f.state();
        f.db().connection.execute_batch(&format!(
            "CREATE TRIGGER fail_group_move BEFORE INSERT ON entity_group_memberships WHEN NEW.entity_id='{}'
             BEGIN SELECT RAISE(ABORT,'injected'); END;", second.id
        )).unwrap();
        let input = f.input(Fixture::movement(Some(group.id), &[first.clone(), second]));
        assert!(f.manager.update_entity_groups(input).is_err());
        assert_eq!(f.state(), before);
        f.db()
            .connection
            .execute_batch("DROP TRIGGER fail_group_move;")
            .unwrap();
        f.apply(Fixture::movement(
            Some(group.id),
            std::slice::from_ref(&first),
        ));
        let before = f.state();
        f.db()
            .connection
            .execute_batch(
                "CREATE TRIGGER fail_group_delete BEFORE DELETE ON entity_group_memberships
             BEGIN SELECT RAISE(ABORT,'injected'); END;",
            )
            .unwrap();
        let input = f.input(EntityGroupAction::Delete { id: group.id });
        assert!(f.manager.update_entity_groups(input).is_err());
        assert_eq!(f.state(), before);
        assert_eq!(f.db().get_entity(f.project_id, first.id).unwrap(), first);
    }

    #[test]
    fn project_switches_and_foreign_groups_cannot_mutate_another_project() {
        let mut f = Fixture::new();
        let group = f.group(EntityType::Character, "Cast");
        let action = f.input(EntityGroupAction::Delete { id: group.id });
        f.db().connection.execute(
            "INSERT INTO entity_groups(id,project_id,entity_type,name) VALUES(?1,?2,'CHARACTER','Foreign')",
            rusqlite::params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
        ).unwrap();
        assert_eq!(f.state().groups.len(), 1);
        f.manager.close();
        let other = f
            .manager
            .create(f.root.join("other"), "Other")
            .unwrap()
            .project_id;
        assert!(matches!(
            f.manager.get_entity_groups(f.project_id),
            Err(EntityStoreError::WrongGroupProject)
        ));
        assert!(matches!(
            f.manager.update_entity_groups(action),
            Err(EntityStoreError::WrongGroupProject)
        ));
        assert!(
            f.manager
                .get_entity_groups(other)
                .unwrap()
                .groups
                .is_empty()
        );
        f.manager.close();
        f.manager.open(&f.root).unwrap();
        assert_eq!(f.state().groups, [group]);
    }

    #[test]
    fn migration_68_rolls_back_and_retries_without_changing_existing_entities() {
        let mut f = Fixture::new();
        let original = f.entity("Keep");
        f.db()
            .connection
            .execute_batch(
                "DROP TRIGGER clear_entity_group_on_type_change;
             DROP TABLE entity_group_memberships;
             DROP TABLE entity_groups;
             DROP TABLE entity_group_state;
             DELETE FROM schema_migrations WHERE version=68;
             CREATE TRIGGER fail68 BEFORE INSERT ON schema_migrations WHEN NEW.version=68
             BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
            )
            .unwrap();
        assert!(f.db().migrate_entity_groups().is_err());
        assert_eq!(f.db().health().unwrap().schema_version, 67);
        assert_eq!(f.db().connection.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'entity_group%' AND type='table'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap(), 0);
        assert_eq!(
            f.db().get_entity(f.project_id, original.id).unwrap(),
            original
        );
        f.db()
            .connection
            .execute_batch("DROP TRIGGER fail68;")
            .unwrap();
        f.db().migrate_entity_groups().unwrap();
        assert_eq!(
            f.db().health().unwrap().schema_version,
            CURRENT_SCHEMA_VERSION
        );
        assert!(f.state().memberships.is_empty());
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap().len(),
            1
        );
    }
}
