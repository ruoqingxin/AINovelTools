use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityDeleteTarget {
    pub id: Uuid,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteEntitiesInput {
    pub expected_project_id: Uuid,
    pub entities: Vec<EntityDeleteTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityDeletionPreview {
    pub id: Uuid,
    pub name: String,
    pub blockers: Vec<String>,
}

impl ProjectManager {
    pub fn preview_entity_deletion(
        &self,
        input: &DeleteEntitiesInput,
    ) -> Result<Vec<EntityDeletionPreview>, EntityStoreError> {
        let session = self.current.as_ref().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongProject);
        }
        let tx = session.database.connection.unchecked_transaction()?;
        let preview = deletion_preview(&tx, input)?;
        tx.commit()?;
        Ok(preview)
    }

    pub fn delete_entities(&mut self, input: DeleteEntitiesInput) -> Result<(), EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongProject);
        }
        session.database.delete_entities(input)
    }
}

fn deletion_preview(
    connection: &rusqlite::Connection,
    input: &DeleteEntitiesInput,
) -> Result<Vec<EntityDeletionPreview>, EntityStoreError> {
    let unique: std::collections::HashSet<_> = input.entities.iter().map(|item| item.id).collect();
    if input.entities.is_empty()
        || input.entities.len() > 200
        || unique.len() != input.entities.len()
    {
        return Err(EntityStoreError::InvalidDeletion);
    }
    let mut result = Vec::with_capacity(input.entities.len());
    for target in &input.entities {
        let (version, name) = connection
            .query_row(
                "SELECT e.version,r.name FROM entities e
             JOIN entity_revisions r ON r.id=e.current_revision_id AND r.entity_id=e.id
             WHERE e.id=?1 AND e.project_id=?2",
                rusqlite::params![target.id.to_string(), input.expected_project_id.to_string()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or(EntityStoreError::MissingEntity(target.id))?;
        if version != target.expected_version {
            return Err(EntityStoreError::Contract(EntityError::Conflict {
                expected: target.expected_version,
                actual: version,
            }));
        }
        let id = target.id.to_string();
        let mut blockers = Vec::new();
        for (query, label) in [
            (
                "SELECT EXISTS(SELECT 1 FROM chapter_entity_references WHERE entity_id=?1)",
                "章节关联",
            ),
            (
                "SELECT EXISTS(SELECT 1 FROM discussion_workspaces WHERE linked_entity_id=?1
                UNION ALL SELECT 1 FROM discussion_draft_revisions WHERE linked_entity_id=?1)",
                "讨论关联",
            ),
            (
                "SELECT EXISTS(SELECT 1 FROM author_settings WHERE entity_id=?1)",
                "作者规则",
            ),
            (
                "SELECT EXISTS(SELECT 1 FROM chapter_extraction_items WHERE final_object_id=?1)",
                "正文提取采用记录",
            ),
            (
                "SELECT EXISTS(SELECT 1 FROM entity_revisions WHERE entity_id<>?1
                AND base_revision_id IN (SELECT id FROM entity_revisions WHERE entity_id=?1))",
                "其他实体的修订来源",
            ),
            (
                "SELECT EXISTS(SELECT 1 FROM coauthor_publications WHERE source_key='ENTITY:'||?1)",
                "共创发布记录",
            ),
        ] {
            if connection.query_row(query, [&id], |row| row.get::<_, bool>(0))? {
                blockers.push(label.to_owned());
            }
        }
        // Structured references need protection even when they are not SQL foreign keys.
        for (table, column, label) in [
            ("planning_sections", "references_json", "大纲引用"),
            ("discussion_sessions", "scope_text", "讨论来源"),
            (
                "discussion_design_proposals",
                "promoted_entity_ids_json",
                "讨论采用记录",
            ),
            (
                "discussion_design_proposals",
                "confirmed_entities_json",
                "讨论采用记录",
            ),
            ("coauthor_documents", "payload", "共创工作稿"),
            ("coauthor_document_revisions", "payload", "共创工作稿历史"),
            ("coauthor_changesets", "payload", "共创变更记录"),
            ("coauthor_reversals", "payload", "共创撤销记录"),
            ("coauthor_impacts", "payload", "共创影响记录"),
        ] {
            let query = format!(
                "SELECT EXISTS(SELECT 1 FROM {table} t,
                 json_tree(CASE WHEN json_valid(t.{column}) THEN t.{column} ELSE '{{}}' END) j
                 WHERE j.type='text' AND (j.value=?1 OR j.value=?2
                    OR j.value IN (SELECT id FROM entity_revisions WHERE entity_id=?1)))"
            );
            let found: bool = connection.query_row(
                &query,
                rusqlite::params![id, format!("ENTITY:{id}")],
                |row| row.get(0),
            )?;
            if found && !blockers.iter().any(|item| item == label) {
                blockers.push(label.to_owned());
            }
        }
        result.push(EntityDeletionPreview {
            id: target.id,
            name,
            blockers,
        });
    }
    Ok(result)
}

impl Database {
    pub(crate) fn migrate_entity_deletion(&self) -> Result<(), DatabaseError> {
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "DROP TRIGGER prevent_entity_revision_delete;
             CREATE TRIGGER prevent_entity_revision_delete
             BEFORE DELETE ON entity_revisions
             WHEN EXISTS(SELECT 1 FROM entities WHERE id=OLD.entity_id)
             BEGIN SELECT RAISE(ABORT, 'immutable entity revision'); END;
             INSERT INTO schema_migrations(version,name) VALUES(67,'explicit_entity_deletion');",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn delete_entities(&mut self, input: DeleteEntitiesInput) -> Result<(), EntityStoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let preview = deletion_preview(&tx, &input)?;
        let blocked: Vec<_> = preview
            .iter()
            .filter(|item| !item.blockers.is_empty())
            .map(|item| format!("{}（{}）", item.name, item.blockers.join("、")))
            .collect();
        if !blocked.is_empty() {
            return Err(EntityStoreError::Referenced(blocked.join("；")));
        }
        // Revisions stay immutable while their entity exists. Remove the parent first;
        // defer FK checks until the complete entity and its own history have been removed.
        tx.execute_batch("PRAGMA defer_foreign_keys=ON;")?;
        for target in &input.entities {
            tx.execute(
                "DELETE FROM entities WHERE id=?1 AND project_id=?2 AND version=?3",
                rusqlite::params![
                    target.id.to_string(),
                    input.expected_project_id.to_string(),
                    target.expected_version
                ],
            )?;
            tx.execute(
                "DELETE FROM entity_revisions WHERE entity_id=?1",
                [target.id.to_string()],
            )?;
        }
        Self::rebuild_search_index_in_tx(&tx, input.expected_project_id)?;
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
            let root = std::env::temp_dir().join(format!("entity-deletion-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "deletion").unwrap().project_id;
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

        fn input(&self, entities: &[Entity]) -> DeleteEntitiesInput {
            DeleteEntitiesInput {
                expected_project_id: self.project_id,
                entities: entities
                    .iter()
                    .map(|entity| EntityDeleteTarget {
                        id: entity.id,
                        expected_version: entity.version,
                    })
                    .collect(),
            }
        }

        fn db(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }

        fn count(&self, table: &str) -> i64 {
            self.db()
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn deletes_only_selected_entities_and_their_history_and_search_then_survives_reopen() {
        let mut f = Fixture::new();
        let first = f.entity("Alpha");
        let keep = f.entity("Keep");
        let mut update = super::super::tests::input("Alpha revised");
        update.id = Some(first.id);
        update.expected_version = Some(first.version);
        update.base_revision_id = Some(first.current_revision_id);
        let first = f.manager.upsert_entity(update).unwrap();
        let second = f.entity("Beta");
        let input = f.input(&[first.clone(), second]);
        assert!(
            f.manager
                .preview_entity_deletion(&input)
                .unwrap()
                .iter()
                .all(|item| item.blockers.is_empty())
        );
        f.manager.delete_entities(input).unwrap();
        assert_eq!(f.count("entity_revisions"), 1);
        assert_eq!(f.manager.list_entities(true).unwrap(), vec![keep.clone()]);
        assert!(
            f.manager
                .search_project("Alpha".into(), None, 20, 0)
                .unwrap()
                .is_empty()
        );
        assert!(
            f.manager
                .list_entity_revisions(first.id)
                .unwrap()
                .is_empty()
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
        assert_eq!(f.manager.list_entities(true).unwrap(), vec![keep]);
    }

    #[test]
    fn rejects_stale_missing_duplicate_and_wrong_project_batches_without_partial_deletion() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        let input = f.input(&[first.clone(), second.clone()]);
        let mut stale = input.clone();
        stale.entities[1].expected_version += 1;
        assert!(matches!(
            f.manager.delete_entities(stale),
            Err(EntityStoreError::Contract(EntityError::Conflict { .. }))
        ));
        let mut wrong = input.clone();
        wrong.expected_project_id = Uuid::new_v4();
        assert!(matches!(
            f.manager.preview_entity_deletion(&wrong),
            Err(EntityStoreError::WrongProject)
        ));
        assert!(matches!(
            f.manager.delete_entities(wrong),
            Err(EntityStoreError::WrongProject)
        ));
        let mut missing = input.clone();
        missing.entities[1].id = Uuid::new_v4();
        assert!(matches!(
            f.manager.delete_entities(missing),
            Err(EntityStoreError::MissingEntity(_))
        ));
        assert!(matches!(
            f.manager.delete_entities(f.input(&[first.clone(), first])),
            Err(EntityStoreError::InvalidDeletion)
        ));
        assert!(matches!(
            f.manager.delete_entities(f.input(&[])),
            Err(EntityStoreError::InvalidDeletion)
        ));
        assert_eq!(f.count("entities"), 2);
        assert_eq!(f.count("entity_revisions"), 2);
        f.manager.close();
        let other_root = f.root.join("other");
        f.manager.create(&other_root, "other").unwrap();
        assert!(matches!(
            f.manager.delete_entities(input),
            Err(EntityStoreError::WrongProject)
        ));
    }

    #[test]
    fn chapter_and_structured_references_block_entire_batch_and_are_rechecked_after_preview() {
        let mut f = Fixture::new();
        let first = f.entity("First");
        let second = f.entity("Second");
        let input = f.input(&[first.clone(), second.clone()]);
        assert!(
            f.manager
                .preview_entity_deletion(&input)
                .unwrap()
                .iter()
                .all(|item| item.blockers.is_empty())
        );
        let chapter = f
            .manager
            .create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into())
            .unwrap();
        f.db()
            .connection
            .execute(
                "INSERT INTO chapter_entity_reference_sets(chapter_id,version) VALUES(?1,1)",
                [chapter.id.to_string()],
            )
            .unwrap();
        f.db()
            .connection
            .execute(
                "INSERT INTO chapter_entity_references(chapter_id,entity_id) VALUES(?1,?2)",
                rusqlite::params![chapter.id.to_string(), second.id.to_string()],
            )
            .unwrap();
        let preview = f.manager.preview_entity_deletion(&input).unwrap();
        assert_eq!(preview[1].blockers, vec!["章节关联"]);
        assert!(matches!(
            f.manager.delete_entities(input.clone()),
            Err(EntityStoreError::Referenced(_))
        ));
        assert_eq!(f.count("entities"), 2);
        assert_eq!(f.count("chapter_entity_references"), 1);
        assert_eq!(f.count("plan_nodes"), 1);
        f.db()
            .connection
            .execute("DELETE FROM chapter_entity_references", [])
            .unwrap();
        f.db().connection.execute("INSERT INTO coauthor_publications(session_id,document_version,source_key) VALUES(?1,1,?2)",
            rusqlite::params![Uuid::new_v4().to_string(), format!("ENTITY:{}", second.id)]).unwrap();
        assert!(
            f.manager.preview_entity_deletion(&input).unwrap()[1]
                .blockers
                .contains(&"共创发布记录".into())
        );
        f.db()
            .connection
            .execute("DELETE FROM coauthor_publications", [])
            .unwrap();
        f.db()
            .connection
            .execute(
                "INSERT INTO planning_sections(id,references_json) VALUES('outline',?1)",
                [serde_json::json!([format!("ENTITY:{}", second.id)]).to_string()],
            )
            .unwrap();
        assert!(matches!(
            f.manager.delete_entities(input),
            Err(EntityStoreError::Referenced(_))
        ));
        assert_eq!(f.count("entities"), 2);
    }

    #[test]
    fn failure_rolls_back_all_deletes_revisions_and_search_and_keeps_revision_immutability() {
        let mut f = Fixture::new();
        let first = f.entity("Alpha");
        let second = f.entity("Beta");
        assert!(
            f.db()
                .connection
                .execute(
                    "DELETE FROM entity_revisions WHERE entity_id=?1",
                    [first.id.to_string()]
                )
                .is_err()
        );
        f.db()
            .connection
            .execute_batch(&format!(
                "CREATE TRIGGER fail_delete BEFORE DELETE ON entities WHEN OLD.id='{}'
             BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
                second.id
            ))
            .unwrap();
        let input = f.input(&[first, second]);
        assert!(f.manager.delete_entities(input.clone()).is_err());
        assert_eq!(f.count("entities"), 2);
        assert_eq!(f.count("entity_revisions"), 2);
        assert_eq!(
            f.manager
                .search_project("Alpha".into(), None, 20, 0)
                .unwrap()
                .len(),
            1
        );
        f.db()
            .connection
            .execute_batch("DROP TRIGGER fail_delete;")
            .unwrap();
        f.manager.delete_entities(input).unwrap();
        assert_eq!(f.count("entities"), 0);
    }

    #[test]
    fn discussion_links_and_author_rules_remain_protected_even_after_archiving() {
        let mut f = Fixture::new();
        let entity = f.entity("Protected");
        let session = f
            .manager
            .create_discussion_session(
                "Discussion".into(),
                DiscussionScopeKind::Project,
                None,
                None,
            )
            .unwrap();
        f.db()
            .connection
            .execute(
                "INSERT INTO discussion_workspaces(session_id,linked_entity_id) VALUES(?1,?2)",
                rusqlite::params![session.id.to_string(), entity.id.to_string()],
            )
            .unwrap();
        let proposal_id = Uuid::new_v4();
        f.db().connection.execute(
            "INSERT INTO discussion_design_proposals(id,session_id,workspace_version,entities_json,source_message_ids_json,context_version)
             VALUES(?1,?2,0,'[]','[]','test')",
            rusqlite::params![proposal_id.to_string(), session.id.to_string()],
        ).unwrap();
        f.db().connection.execute(
            "INSERT INTO author_settings(id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
             VALUES(?1,?2,?3,?4,'Do not remove','AUTHOR_ONLY',?5)",
            rusqlite::params![Uuid::new_v4().to_string(), f.project_id.to_string(), entity.id.to_string(),
                entity.current_revision_id.to_string(), proposal_id.to_string()],
        ).unwrap();
        let archived = f
            .manager
            .set_entity_archived(entity.id, true, entity.version)
            .unwrap();
        let input = f.input(&[archived]);
        let preview = f.manager.preview_entity_deletion(&input).unwrap();
        assert!(preview[0].blockers.contains(&"讨论关联".into()));
        assert!(preview[0].blockers.contains(&"作者规则".into()));
        assert!(matches!(
            f.manager.delete_entities(input),
            Err(EntityStoreError::Referenced(_))
        ));
        assert_eq!(f.count("entities"), 1);
        assert_eq!(f.count("author_settings"), 1);
        assert_eq!(f.count("discussion_sessions"), 1);
    }

    #[test]
    fn failed_search_refresh_rolls_back_entity_history_index_and_queue_changes() {
        let mut f = Fixture::new();
        let first = f.entity("Alpha");
        let input = f.input(&[first]);
        let before_queue = f.count("coauthor_source_queue");
        f.db()
            .connection
            .execute_batch("DROP TABLE writing_cards;")
            .unwrap();
        assert!(f.manager.delete_entities(input).is_err());
        assert_eq!(f.count("entities"), 1);
        assert_eq!(f.count("entity_revisions"), 1);
        assert_eq!(f.count("coauthor_source_queue"), before_queue);
        assert_eq!(f.db().connection.query_row(
            "SELECT COUNT(*) FROM search_index WHERE object_type='ENTITY' AND content LIKE '%Alpha%'",
            [], |row| row.get::<_, i64>(0),
        ).unwrap(), 1);
        assert!(f.db().connection.is_autocommit());
    }

    #[test]
    fn migration_67_rolls_back_and_retries_while_preserving_existing_entity_history() {
        let mut f = Fixture::new();
        let entity = f.entity("Keep");
        f.db()
            .connection
            .execute_batch(
                "DELETE FROM schema_migrations WHERE version=67;
             DROP TRIGGER prevent_entity_revision_delete;
             CREATE TRIGGER prevent_entity_revision_delete BEFORE DELETE ON entity_revisions
             BEGIN SELECT RAISE(ABORT,'immutable entity revision'); END;
             CREATE TRIGGER fail67 BEFORE INSERT ON schema_migrations WHEN NEW.version=67
             BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
            )
            .unwrap();
        assert!(f.db().migrate_entity_deletion().is_err());
        assert_eq!(f.db().health().unwrap().schema_version, 66);
        assert!(
            f.db()
                .connection
                .execute("DELETE FROM entity_revisions", [])
                .is_err()
        );
        f.db()
            .connection
            .execute_batch("DROP TRIGGER fail67;")
            .unwrap();
        f.db().migrate_entity_deletion().unwrap();
        assert_eq!(
            f.db().health().unwrap().schema_version,
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(f.manager.list_entity_revisions(entity.id).unwrap().len(), 1);
        assert!(
            f.db()
                .connection
                .execute("DELETE FROM entity_revisions", [])
                .is_err()
        );
        assert!(
            f.db()
                .connection
                .execute("UPDATE entity_revisions SET name='bad'", [])
                .is_err()
        );
        f.manager.delete_entities(f.input(&[entity])).unwrap();
    }
}
