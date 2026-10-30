use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityImportTarget {
    pub id: Uuid,
    pub expected_version: i64,
    pub expected_revision_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityImportCandidate {
    pub entity_type: EntityType,
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub target: Option<EntityImportTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityImportResolution {
    pub target_id: Uuid,
    pub description: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntityImportInput {
    pub expected_project_id: Uuid,
    pub source_name: String,
    pub items: Vec<EntityImportCandidate>,
    #[serde(default)]
    pub resolutions: Vec<EntityImportResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityImportPreview {
    pub before: Option<EntityCard>,
    pub after: EntityInput,
    pub incoming_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EntityImportReceipt {
    pub created: Vec<Entity>,
    pub merged: Vec<Entity>,
}

impl ProjectManager {
    pub fn preview_entity_import(
        &mut self,
        input: ReviewEntityImportInput,
    ) -> Result<Vec<EntityImportPreview>, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongImportProject);
        }
        let tx = session.database.connection.transaction()?;
        Database::prepare_entity_import(&tx, &input)
    }

    pub fn apply_entity_import(
        &mut self,
        input: ReviewEntityImportInput,
    ) -> Result<EntityImportReceipt, EntityStoreError> {
        let session = self.current.as_mut().ok_or(EntityStoreError::NoProject)?;
        if session.manifest.project_id != input.expected_project_id {
            return Err(EntityStoreError::WrongImportProject);
        }
        let tx = session
            .database
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let preview = Database::prepare_entity_import(&tx, &input)?;
        let mut receipt = EntityImportReceipt {
            created: vec![],
            merged: vec![],
        };
        for entry in preview {
            let merged = entry.before.is_some();
            let id = Database::upsert_entity_in_tx(&tx, input.expected_project_id, entry.after)?;
            let entity = tx.query_row(
                "SELECT id,project_id,entity_type,lifecycle_status,current_revision_id,version,created_at,updated_at
                 FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![id.to_string(), input.expected_project_id.to_string()],
                map_entity,
            )?;
            if merged {
                receipt.merged.push(entity);
            } else {
                receipt.created.push(entity);
            }
        }
        Database::rebuild_search_index_in_tx(&tx, input.expected_project_id)?;
        tx.commit()?;
        Ok(receipt)
    }
}

fn append_unique(target: &mut Vec<String>, values: impl IntoIterator<Item = String>) {
    for value in values {
        if !value.trim().is_empty() && !target.contains(&value) {
            target.push(value);
        }
    }
}

impl Database {
    fn prepare_entity_import(
        tx: &rusqlite::Transaction<'_>,
        input: &ReviewEntityImportInput,
    ) -> Result<Vec<EntityImportPreview>, EntityStoreError> {
        if input.items.is_empty()
            || input.items.len() > 200
            || input.resolutions.len() > input.items.len()
        {
            return Err(EntityStoreError::InvalidImport);
        }
        let mut result: Vec<EntityImportPreview> = Vec::new();
        for candidate in &input.items {
            let mut after = EntityInput {
                id: None,
                entity_type: candidate.entity_type,
                name: candidate.name.trim().to_owned(),
                aliases: candidate.aliases.clone(),
                description: candidate.description.clone(),
                fixed_attributes_json: "{}".into(),
                tags: candidate.tags.clone(),
                base_revision_id: None,
                source_version: Some(input.source_name.clone()),
                expected_version: None,
            };
            after.validate()?;
            let Some(target) = &candidate.target else {
                result.push(EntityImportPreview {
                    before: None,
                    after,
                    incoming_count: 1,
                });
                continue;
            };
            let entity = tx.query_row(
                "SELECT id,project_id,entity_type,lifecycle_status,current_revision_id,version,created_at,updated_at
                 FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![target.id.to_string(), input.expected_project_id.to_string()],
                map_entity,
            ).optional()?.ok_or(EntityStoreError::MissingEntity(target.id))?;
            if entity.version != target.expected_version {
                return Err(EntityError::Conflict {
                    expected: target.expected_version,
                    actual: entity.version,
                }
                .into());
            }
            if entity.current_revision_id != target.expected_revision_id
                || entity.entity_type != candidate.entity_type
                || entity.lifecycle_status != EntityLifecycleStatus::Active
            {
                return Err(EntityStoreError::InvalidImport);
            }
            let entry_index = if let Some(index) = result
                .iter()
                .position(|entry| entry.after.id == Some(target.id))
            {
                index
            } else {
                let revision = tx.query_row(
                    "SELECT id,entity_id,revision,name,aliases_json,description,fixed_attributes_json,tags_json,base_revision_id,source_version,created_at
                     FROM entity_revisions WHERE id=?1 AND entity_id=?2",
                    rusqlite::params![target.expected_revision_id.to_string(), target.id.to_string()],
                    map_entity_revision,
                )?;
                after.id = Some(entity.id);
                after.name = revision.name.clone();
                after.aliases = revision.aliases.clone();
                after.description = revision.description.clone();
                after.fixed_attributes_json = revision.fixed_attributes_json.clone();
                after.tags = revision.tags.clone();
                after.base_revision_id = Some(revision.id);
                // Original provenance stays in history; each appended section names its source.
                // Never forward a discussion: marker, which denotes replacement author rules.
                after.source_version = Some(format!("import-merge:{}", input.source_name));
                after.expected_version = Some(entity.version);
                result.push(EntityImportPreview {
                    before: Some(EntityCard { entity, revision }),
                    after,
                    incoming_count: 0,
                });
                result.len() - 1
            };
            let entry = &mut result[entry_index];
            entry.incoming_count += 1;
            if !candidate.description.is_empty() {
                if !entry.after.description.is_empty() {
                    entry.after.description.push_str("\n\n");
                }
                entry.after.description.push_str(&format!(
                    "【导入补充：{} · {}】\n{}",
                    input.source_name,
                    candidate.name.trim(),
                    candidate.description,
                ));
            }
            append_unique(&mut entry.after.aliases, candidate.aliases.clone());
            if candidate.name.trim() != entry.after.name {
                append_unique(&mut entry.after.aliases, [candidate.name.trim().to_owned()]);
            }
            append_unique(&mut entry.after.tags, candidate.tags.clone());
            entry.after.validate()?;
        }
        let mut resolved = Vec::new();
        for resolution in &input.resolutions {
            if resolved.contains(&resolution.target_id) {
                return Err(EntityStoreError::InvalidImport);
            }
            let entry = result
                .iter_mut()
                .find(|entry| {
                    entry.before.is_some() && entry.after.id == Some(resolution.target_id)
                })
                .ok_or(EntityStoreError::InvalidImport)?;
            // Only author-editable content is replaced; identity, CAS and provenance stay pinned.
            entry.after.description = resolution.description.clone();
            entry.after.aliases = resolution.aliases.clone();
            entry.after.tags = resolution.tags.clone();
            entry.after.validate()?;
            resolved.push(resolution.target_id);
        }
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
            let root =
                std::env::temp_dir().join(format!("entity-import-review-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "review").unwrap().project_id;
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
        fn input(&self, entity: &Entity) -> ReviewEntityImportInput {
            ReviewEntityImportInput {
                expected_project_id: self.project_id,
                source_name: "source.md".into(),
                resolutions: vec![],
                items: vec![EntityImportCandidate {
                    entity_type: entity.entity_type,
                    name: "New full name".into(),
                    description: "Incoming text".into(),
                    aliases: vec!["alias".into(), "new alias".into()],
                    tags: vec!["new tag".into()],
                    target: Some(EntityImportTarget {
                        id: entity.id,
                        expected_version: entity.version,
                        expected_revision_id: entity.current_revision_id,
                    }),
                }],
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
    fn preview_is_read_only_and_merge_preserves_identity_content_history_rules_and_links() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let original_history = f.manager.list_entity_revisions(original.id).unwrap();
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
        let proposal = Uuid::new_v4();
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
            rusqlite::params![proposal.to_string(), session.id.to_string()],
        ).unwrap();
        f.db().connection.execute(
            "INSERT INTO author_settings(id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
             VALUES(?1,?2,?3,?4,'Keep rule','AUTHOR_ONLY',?5)",
            rusqlite::params![Uuid::new_v4().to_string(), f.project_id.to_string(), original.id.to_string(),
                original.current_revision_id.to_string(), proposal.to_string()],
        ).unwrap();
        let mut input = f.input(&original);
        // Even a filename with this prefix must not trigger author-rule replacement.
        input.source_name = "discussion:source.md".into();
        input.items.push(EntityImportCandidate {
            name: "Second incoming".into(),
            description: "Second text".into(),
            ..input.items[0].clone()
        });
        let changes = f.db().connection.total_changes();
        let preview = f.manager.preview_entity_import(input.clone()).unwrap();
        assert_eq!(f.db().connection.total_changes(), changes);
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].incoming_count, 2);
        assert_eq!(preview[0].before.as_ref().unwrap().entity, original);
        let receipt = f.manager.apply_entity_import(input).unwrap();
        assert!(receipt.created.is_empty());
        assert_eq!(receipt.merged.len(), 1);
        let merged = &receipt.merged[0];
        assert_eq!(merged.id, original.id);
        assert_eq!(merged.version, original.version + 1);
        let history = f.manager.list_entity_revisions(original.id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1..], original_history);
        let revision = &history[0];
        assert_eq!(revision.name, "Original");
        assert_eq!(revision.description, preview[0].after.description);
        assert!(revision.description.starts_with("Original description\n\n"));
        assert!(revision.description.contains("Incoming text"));
        assert!(revision.description.ends_with("Second text"));
        assert_eq!(
            revision.fixed_attributes_json,
            original_history[0].fixed_attributes_json
        );
        assert_eq!(
            revision.base_revision_id,
            Some(original.current_revision_id)
        );
        assert_eq!(
            revision.aliases,
            ["alias", "new alias", "New full name", "Second incoming"]
        );
        assert_eq!(revision.tags, ["tag", "new tag"]);
        assert_eq!(
            f.manager
                .get_chapter_entity_references(f.project_id, chapter.id)
                .unwrap()
                .entities[0]
                .entity
                .id,
            original.id
        );
        let rules: i64 = f.db().connection.query_row(
            "SELECT count(*) FROM author_settings WHERE entity_revision_id=?1 AND content='Keep rule'",
            [merged.current_revision_id.to_string()], |row| row.get(0),
        ).unwrap();
        assert_eq!(rules, 1);
        assert_eq!(
            f.db()
                .connection
                .query_row(
                    "SELECT linked_entity_id FROM discussion_workspaces",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            original.id.to_string()
        );
        assert_eq!(
            f.manager
                .search_project("Incoming".into(), None, 20, 0)
                .unwrap()[0]
                .object_id,
            original.id
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
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap(),
            history
        );
    }

    #[test]
    fn author_resolution_replaces_conflicting_content_once_and_keeps_original_history() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let original_history = f.manager.list_entity_revisions(original.id).unwrap();
        let mut input = f.input(&original);
        input.items.push(input.items[0].clone());
        input.resolutions.push(EntityImportResolution {
            target_id: original.id,
            description: "Author resolved the conflicting accounts.".into(),
            aliases: vec!["Chosen alias".into()],
            tags: vec![],
        });
        let changes = f.db().connection.total_changes();
        let preview = f.manager.preview_entity_import(input.clone()).unwrap();
        assert_eq!(f.db().connection.total_changes(), changes);
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].incoming_count, 2);
        assert_eq!(preview[0].after.description, input.resolutions[0].description);
        let receipt = f.manager.apply_entity_import(input.clone()).unwrap();
        assert_eq!(receipt.merged[0].id, original.id);
        let history = f.manager.list_entity_revisions(original.id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1..], original_history);
        assert_eq!(history[0].description, input.resolutions[0].description);
        assert_eq!(history[0].aliases, ["Chosen alias"]);
        assert!(history[0].tags.is_empty());
        assert_eq!(history[0].name, original_history[0].name);
        assert_eq!(
            history[0].fixed_attributes_json,
            original_history[0].fixed_attributes_json
        );
        assert_eq!(history[0].base_revision_id, Some(original.current_revision_id));
        assert_eq!(
            f.manager.search_project("resolved".into(), None, 20, 0).unwrap()[0].object_id,
            original.id
        );
        // A retry cannot create a second revision from the same reviewed snapshot.
        assert!(f.manager.apply_entity_import(input).is_err());
        assert_eq!(f.manager.list_entity_revisions(original.id).unwrap(), history);
    }

    #[test]
    fn resolutions_reject_unselected_foreign_and_duplicate_targets_without_partial_writes() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let other = f.entity("Not selected");
        let foreign = f
            .manager
            .current
            .as_mut()
            .unwrap()
            .database
            .upsert_entity(Uuid::new_v4(), super::super::tests::input("Foreign"))
            .unwrap();
        let mut input = f.input(&original);
        input.items.insert(
            0,
            EntityImportCandidate {
                name: "Created".into(), target: None, ..input.items[0].clone()
            },
        );
        let resolution = EntityImportResolution {
            target_id: original.id, description: String::new(), aliases: vec![], tags: vec![],
        };
        for resolutions in [
            vec![EntityImportResolution { target_id: other.id, ..resolution.clone() }],
            vec![EntityImportResolution { target_id: foreign.id, ..resolution.clone() }],
            vec![EntityImportResolution { target_id: Uuid::new_v4(), ..resolution.clone() }],
            vec![resolution.clone(), resolution.clone()],
        ] {
            input.resolutions = resolutions;
            assert!(f.manager.preview_entity_import(input.clone()).is_err());
            assert!(f.manager.apply_entity_import(input.clone()).is_err());
            assert_eq!(f.manager.list_entities(true).unwrap().len(), 2);
            assert_eq!(f.manager.list_entity_revisions(original.id).unwrap().len(), 1);
        }
        // Clearing all three fields is an explicit author choice, not a fallback to concatenation.
        input.resolutions = vec![resolution];
        f.manager.apply_entity_import(input).unwrap();
        let history = f.manager.list_entity_revisions(original.id).unwrap();
        assert!(history[0].description.is_empty());
        assert!(history[0].aliases.is_empty());
        assert!(history[0].tags.is_empty());
    }

    #[test]
    fn mixed_create_merge_is_atomic_including_search_and_database_failures() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let mut input = f.input(&original);
        input.items.insert(
            0,
            EntityImportCandidate {
                target: None,
                name: "Created".into(),
                ..input.items[0].clone()
            },
        );
        input.resolutions.push(EntityImportResolution {
            target_id: original.id,
            description: "Resolved content".into(),
            aliases: vec![],
            tags: vec![],
        });
        f.db().connection.execute_batch(
            "CREATE TRIGGER fail_import BEFORE UPDATE ON entities BEGIN SELECT RAISE(ABORT,'injected'); END;"
        ).unwrap();
        assert!(f.manager.apply_entity_import(input.clone()).is_err());
        assert_eq!(
            f.manager.list_entities(true).unwrap(),
            vec![original.clone()]
        );
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap().len(),
            1
        );
        f.db().connection.execute_batch("DROP TRIGGER fail_import; ALTER TABLE search_index RENAME TO unavailable_search_index;").unwrap();
        assert!(f.manager.apply_entity_import(input.clone()).is_err());
        assert_eq!(
            f.manager.list_entities(true).unwrap(),
            vec![original.clone()]
        );
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap().len(),
            1
        );
        f.db()
            .connection
            .execute_batch("ALTER TABLE unavailable_search_index RENAME TO search_index;")
            .unwrap();
        assert!(
            f.manager
                .search_project("Incoming".into(), None, 20, 0)
                .unwrap()
                .is_empty()
        );
        let result = f.manager.apply_entity_import(input).unwrap();
        assert_eq!(result.created.len(), 1);
        assert_eq!(result.merged.len(), 1);
        assert_eq!(f.manager.list_entities(true).unwrap().len(), 2);
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap()[0].description,
            "Resolved content"
        );
    }

    #[test]
    fn rejects_stale_revision_type_archived_missing_foreign_and_invalid_inputs() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let base = f.input(&original);
        let mut cases = Vec::new();
        let mut stale = base.clone();
        stale.items[0].target.as_mut().unwrap().expected_version += 1;
        cases.push(stale);
        let mut revision = base.clone();
        revision.items[0]
            .target
            .as_mut()
            .unwrap()
            .expected_revision_id = Uuid::new_v4();
        cases.push(revision);
        let mut wrong_type = base.clone();
        wrong_type.items[0].entity_type = EntityType::Concept;
        cases.push(wrong_type);
        let mut missing = base.clone();
        missing.items[0].target.as_mut().unwrap().id = Uuid::new_v4();
        cases.push(missing);
        let foreign = f
            .manager
            .current
            .as_mut()
            .unwrap()
            .database
            .upsert_entity(Uuid::new_v4(), super::super::tests::input("Foreign"))
            .unwrap();
        let mut foreign_input = base.clone();
        foreign_input.items[0].target = f.input(&foreign).items[0].target.clone();
        cases.push(foreign_input);
        cases.push(ReviewEntityImportInput {
            items: vec![],
            ..base.clone()
        });
        cases.push(ReviewEntityImportInput {
            items: vec![base.items[0].clone(); 201],
            ..base.clone()
        });
        let mut empty_name = base.clone();
        empty_name.items[0].name = " ".into();
        cases.push(empty_name);
        for input in cases {
            assert!(f.manager.preview_entity_import(input.clone()).is_err());
            assert!(f.manager.apply_entity_import(input).is_err());
            assert_eq!(
                f.db().get_entity(f.project_id, original.id).unwrap(),
                original
            );
        }
        let archived = f
            .manager
            .set_entity_archived(original.id, true, original.version)
            .unwrap();
        let input = f.input(&archived);
        assert!(f.manager.preview_entity_import(input.clone()).is_err());
        assert!(f.manager.apply_entity_import(input).is_err());
        assert_eq!(
            f.manager.list_entity_revisions(original.id).unwrap().len(),
            1
        );
    }

    #[test]
    fn project_switch_and_edits_after_preview_reject_the_entire_batch() {
        let mut f = Fixture::new();
        let original = f.entity("Original");
        let mut input = f.input(&original);
        input.items.insert(
            0,
            EntityImportCandidate {
                target: None,
                ..input.items[0].clone()
            },
        );
        input.resolutions.push(EntityImportResolution {
            target_id: original.id, description: "Resolved draft".into(), aliases: vec![], tags: vec![],
        });
        f.manager.preview_entity_import(input.clone()).unwrap();
        let mut edit = super::super::tests::input("Edited after preview");
        edit.id = Some(original.id);
        edit.expected_version = Some(original.version);
        let edited = f.manager.upsert_entity(edit).unwrap();
        assert!(matches!(
            f.manager.apply_entity_import(input.clone()),
            Err(EntityStoreError::Contract(EntityError::Conflict { .. }))
        ));
        assert_eq!(f.manager.list_entities(true).unwrap(), vec![edited]);
        f.manager.close();
        f.manager.create(f.root.join("other"), "Other").unwrap();
        assert!(matches!(
            f.manager.preview_entity_import(input.clone()),
            Err(EntityStoreError::WrongImportProject)
        ));
        assert!(matches!(
            f.manager.apply_entity_import(input),
            Err(EntityStoreError::WrongImportProject)
        ));
        assert!(f.manager.list_entities(true).unwrap().is_empty());
    }
}
