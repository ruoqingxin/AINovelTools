use super::*;

const MAX_BATCH_ITEMS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntitiesInput {
    pub expected_project_id: Uuid,
    pub items: Vec<EntityInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanBatchCandidate {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanBatchInput {
    pub expected_project_id: Uuid,
    pub parent_id: Uuid,
    pub expected_parent_revision: i64,
    pub expected_source_version: i64,
    pub source: PlanningSection,
    pub candidates: Vec<PlanBatchCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanBatchReceipt {
    pub nodes: Vec<PlanNode>,
    pub source: VersionedPlanningSection,
}

#[derive(Debug, Error)]
pub enum BatchStoreError {
    #[error("no project is open")]
    NoProject,
    #[error("batch belongs to another project")]
    WrongProject,
    #[error("invalid or empty batch (maximum 200 new items)")]
    InvalidBatch,
    #[error("batch parent or source is unavailable")]
    InvalidTarget,
    #[error(transparent)]
    Entity(#[from] EntityStoreError),
    #[error(transparent)]
    Plan(#[from] PlanError),
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error(transparent)]
    Database(#[from] DatabaseError),
    #[error("batch sqlite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl ProjectManager {
    pub fn import_entities(
        &mut self,
        input: ImportEntitiesInput,
    ) -> Result<Vec<Entity>, BatchStoreError> {
        let session = self.current.as_mut().ok_or(BatchStoreError::NoProject)?;
        if input.expected_project_id != session.manifest.project_id {
            return Err(BatchStoreError::WrongProject);
        }
        session.database.import_entities_batch(input)
    }

    pub fn adopt_plan_batch(
        &mut self,
        input: PlanBatchInput,
    ) -> Result<PlanBatchReceipt, BatchStoreError> {
        let session = self.current.as_mut().ok_or(BatchStoreError::NoProject)?;
        if input.expected_project_id != session.manifest.project_id {
            return Err(BatchStoreError::WrongProject);
        }
        session.database.adopt_plan_batch(input)
    }
}

impl Database {
    fn import_entities_batch(
        &mut self,
        input: ImportEntitiesInput,
    ) -> Result<Vec<Entity>, BatchStoreError> {
        if input.items.is_empty() || input.items.len() > MAX_BATCH_ITEMS {
            return Err(BatchStoreError::InvalidBatch);
        }
        for item in &input.items {
            // File import creates new author material, never edits an existing entity.
            if item.id.is_some()
                || item.base_revision_id.is_some()
                || item.expected_version.is_some()
            {
                return Err(BatchStoreError::InvalidBatch);
            }
            item.validate().map_err(EntityStoreError::from)?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut entities = Vec::with_capacity(input.items.len());
        for item in input.items {
            let id = Self::upsert_entity_in_tx(&tx, input.expected_project_id, item)?;
            entities.push(tx.query_row(
                "SELECT id, project_id, entity_type, lifecycle_status, current_revision_id, version, created_at, updated_at
                 FROM entities WHERE id=?1 AND project_id=?2",
                rusqlite::params![id.to_string(), input.expected_project_id.to_string()],
                entity_store::map_entity,
            )?);
        }
        Self::rebuild_search_index_in_tx(&tx, input.expected_project_id)?;
        tx.commit()?;
        Ok(entities)
    }

    fn adopt_plan_batch(
        &mut self,
        mut input: PlanBatchInput,
    ) -> Result<PlanBatchReceipt, BatchStoreError> {
        if input.candidates.is_empty()
            || input.candidates.len() > MAX_BATCH_ITEMS
            || input.expected_source_version < 0
            || input.expected_parent_revision < 1
            || input
                .candidates
                .iter()
                .any(|item| item.title.trim().is_empty())
        {
            return Err(BatchStoreError::InvalidBatch);
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let parent: Option<(String, i64)> = tx
            .query_row(
                "SELECT kind, revision FROM plan_nodes WHERE id=?1 AND archived=0",
                [input.parent_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (parent_kind, revision) = parent.ok_or(BatchStoreError::InvalidTarget)?;
        if revision != input.expected_parent_revision {
            return Err(PlanError::Conflict {
                expected: input.expected_parent_revision,
                actual: revision,
            }
            .into());
        }
        let (kind, source_id) = match parent_kind.as_str() {
            "VOLUME_MANAGER" => (
                PlanNodeKind::Volume,
                format!("plan-node:{}", input.parent_id),
            ),
            "VOLUME" => (
                PlanNodeKind::Chapter,
                format!("chapter-split-{}", input.parent_id),
            ),
            _ => return Err(BatchStoreError::InvalidTarget),
        };
        if input.source.id != source_id {
            return Err(BatchStoreError::InvalidTarget);
        }
        if kind == PlanNodeKind::Volume {
            if input.source.pending_content.trim().is_empty() {
                return Err(BatchStoreError::InvalidBatch);
            }
            input
                .source
                .pending_content
                .trim()
                .clone_into(&mut input.source.content);
            input.source.story_state = PlanningStoryState::Confirmed;
        } else {
            // Chapter adoption consumes candidates, not the author's formal source fields.
            let stored: Option<(String, String, String, String, String)> = tx.query_row(
                "SELECT content,story_state,rationale,consequence,references_json FROM planning_sections WHERE id=?1",
                [&source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ).optional()?;
            input.source.content.clear();
            input.source.story_state = PlanningStoryState::Unset;
            input.source.rationale.clear();
            input.source.consequence.clear();
            input.source.references.clear();
            if let Some((content, state, rationale, consequence, references_json)) = stored {
                input.source.content = content;
                input.source.story_state = PlanningStoryState::parse(&state);
                input.source.rationale = rationale;
                input.source.consequence = consequence;
                input.source.references =
                    serde_json::from_str(&references_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
            }
            if input.source.content.trim().is_empty() {
                input.source.story_state = PlanningStoryState::Unset;
            }
        }
        input.source.pending_content.clear();
        // Consume the original source version before creating any children.
        let source = Self::save_planning_section_in_tx(
            &tx,
            input.source,
            Some(input.expected_source_version),
        )?;
        let mut titles = {
            let mut statement = tx.prepare(
                "SELECT title FROM plan_nodes WHERE parent_id=?1 AND kind=?2 AND archived=0",
            )?;
            statement
                .query_map(
                    rusqlite::params![input.parent_id.to_string(), kind.as_str()],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<std::collections::HashSet<_>, _>>()?
        };
        let mut nodes = Vec::new();
        for candidate in input.candidates {
            let title = candidate.title.trim().to_owned();
            if !titles.insert(title.clone()) {
                continue;
            }
            let node = Self::create_plan_node_in_tx(&tx, Some(input.parent_id), kind, title)?;
            if !candidate.content.trim().is_empty() {
                Self::save_planning_section_in_tx(
                    &tx,
                    PlanningSection {
                        id: format!("plan-node:{}", node.id),
                        content: candidate.content.trim().to_owned(),
                        pending_content: String::new(),
                        story_state: PlanningStoryState::Confirmed,
                        rationale: String::new(),
                        consequence: String::new(),
                        references: vec![],
                        updated_at: String::new(),
                    },
                    Some(0),
                )?;
            }
            nodes.push(node);
        }
        if nodes.is_empty() {
            return Err(BatchStoreError::InvalidBatch);
        }
        tx.execute(
            "UPDATE summary_materials SET lifecycle_status='STALE', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE project_id=?1 AND kind='SETTING' AND precision='L4' AND lifecycle_status='ACTIVE'
               AND generation_mode='EXTRACTIVE_AUTO_SETTINGS'",
            [input.expected_project_id.to_string()],
        )?;
        Self::rebuild_search_index_in_tx(&tx, input.expected_project_id)?;
        tx.commit()?;
        Ok(PlanBatchReceipt { nodes, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        root: PathBuf,
        project_id: Uuid,
        parent: PlanNode,
    }

    impl Fixture {
        fn new(kind: PlanNodeKind) -> Self {
            let root = std::env::temp_dir().join(format!("batch-store-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager
                .create(&root, "batch transactions")
                .unwrap()
                .project_id;
            let parent = manager
                .create_plan_node(None, kind, "Parent".into())
                .unwrap();
            Self {
                manager,
                root,
                project_id,
                parent,
            }
        }

        fn db(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }

        fn sql(&self, sql: &str) {
            self.db().connection.execute_batch(sql).unwrap();
        }

        fn count(&self, table: &str) -> i64 {
            self.db()
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        fn source(&self) -> PlanningSection {
            PlanningSection {
                id: if self.parent.kind == PlanNodeKind::VolumeManager {
                    format!("plan-node:{}", self.parent.id)
                } else {
                    format!("chapter-split-{}", self.parent.id)
                },
                content: "Previous formal".into(),
                pending_content: "A | goal\nB | conflict".into(),
                story_state: PlanningStoryState::Locked,
                rationale: "Author reason".into(),
                consequence: "Author consequence".into(),
                references: vec!["discussion:original".into()],
                updated_at: String::new(),
            }
        }

        fn plan(&mut self) -> PlanBatchInput {
            let source = self.source();
            let saved = self
                .manager
                .save_planning_section_checked(source, 0)
                .unwrap();
            PlanBatchInput {
                expected_project_id: self.project_id,
                parent_id: self.parent.id,
                expected_parent_revision: self.parent.revision,
                expected_source_version: saved.version,
                source: saved.section,
                candidates: vec![
                    PlanBatchCandidate {
                        title: "A".into(),
                        content: "Goal A".into(),
                    },
                    PlanBatchCandidate {
                        title: "B".into(),
                        content: "Goal B".into(),
                    },
                ],
            }
        }

        fn entities(&self) -> ImportEntitiesInput {
            ImportEntitiesInput {
                expected_project_id: self.project_id,
                items: ["A", "B"]
                    .into_iter()
                    .map(|name| EntityInput {
                        id: None,
                        entity_type: EntityType::Character,
                        name: name.into(),
                        aliases: vec!["Alias".into()],
                        description: format!("{name} description"),
                        fixed_attributes_json: r#"{"role":"main"}"#.into(),
                        tags: vec!["Tag".into()],
                        base_revision_id: None,
                        source_version: Some("import.md".into()),
                        expected_version: None,
                    })
                    .collect(),
            }
        }

        fn reopen(&mut self) {
            self.manager.close();
            self.manager.open(&self.root).unwrap();
        }

        fn assert_no_children(&self, source: &PlanBatchInput) {
            assert_eq!(self.count("plan_nodes"), 1);
            assert_eq!(self.count("chapters"), 0);
            assert_eq!(self.count("plan_revisions"), 1);
            assert_eq!(self.count("plan_node_revisions"), 1);
            let sections = self.manager.list_versioned_planning_sections().unwrap();
            assert_eq!(sections.len(), 1);
            assert_eq!(sections[0].version, source.expected_source_version);
            assert_eq!(
                sections[0].section.pending_content,
                source.source.pending_content
            );
            assert_eq!(sections[0].section.content, source.source.content);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.close();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn batch_contract_requires_scope_and_original_versions() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let input = serde_json::to_value(f.plan()).unwrap();
        for field in [
            "expectedProjectId",
            "parentId",
            "expectedParentRevision",
            "expectedSourceVersion",
            "source",
            "candidates",
        ] {
            let mut value = input.clone();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<PlanBatchInput>(value).is_err(),
                "{field}"
            );
        }
        let mut value = serde_json::to_value(f.entities()).unwrap();
        value.as_object_mut().unwrap().remove("expectedProjectId");
        assert!(serde_json::from_value::<ImportEntitiesInput>(value).is_err());
    }

    #[test]
    fn entity_import_commits_all_revisions_and_search_without_story_facts() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let receipt = f.manager.import_entities(f.entities()).unwrap();
        assert_eq!(receipt.len(), 2);
        assert!(
            receipt
                .iter()
                .all(|entity| entity.version == 1 && entity.project_id == f.project_id)
        );
        f.reopen();
        assert_eq!(f.manager.list_entities(false).unwrap().len(), 2);
        let revision = &f.manager.list_entity_revisions(receipt[0].id).unwrap()[0];
        assert_eq!(revision.name, "A");
        assert_eq!(revision.aliases, vec!["Alias"]);
        assert_eq!(revision.tags, vec!["Tag"]);
        assert_eq!(revision.source_version.as_deref(), Some("import.md"));
        assert_eq!(f.count("search_index"), 3);
        assert_eq!(f.count("facts"), 0);
        assert_eq!(f.count("evidence_anchors"), 0);
    }

    #[test]
    fn import_validates_the_entire_new_only_bounded_batch_before_writes() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let original = f.entities();
        for case in 0..6 {
            let mut input = original.clone();
            match case {
                0 => input.items.clear(),
                1 => input.items = vec![input.items[0].clone(); 201],
                2 => input.items[1].name = " ".into(),
                3 => input.items[1].fixed_attributes_json = "[]".into(),
                4 => input.items[1].id = Some(Uuid::new_v4()),
                _ => input.expected_project_id = Uuid::new_v4(),
            }
            assert!(f.manager.import_entities(input).is_err());
            assert_eq!(f.count("entities"), 0);
            assert_eq!(f.count("entity_revisions"), 0);
            assert_eq!(f.count("search_index"), 1);
        }
        assert_eq!(f.manager.import_entities(original).unwrap().len(), 2);
    }

    #[test]
    fn second_entity_failure_rolls_back_then_reopen_and_retry_creates_only_one_batch() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let input = f.entities();
        f.sql(
            "CREATE TRIGGER fail_batch BEFORE INSERT ON entity_revisions WHEN NEW.name='B'
               BEGIN SELECT RAISE(ABORT,'second item failed'); END;",
        );
        assert!(f.manager.import_entities(input.clone()).is_err());
        f.reopen();
        assert_eq!(f.count("entities"), 0);
        assert_eq!(f.count("entity_revisions"), 0);
        assert_eq!(f.count("search_index"), 1);
        f.sql("DROP TRIGGER fail_batch");
        f.manager.import_entities(input).unwrap();
        assert_eq!(f.count("entities"), 2);
    }

    #[test]
    fn entity_search_failure_rolls_back_entity_and_revision_inserts() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        f.sql("DROP TABLE writing_cards");
        assert!(f.manager.import_entities(f.entities()).is_err());
        f.reopen();
        assert_eq!(f.count("entities"), 0);
        assert_eq!(f.count("entity_revisions"), 0);
        assert_eq!(f.count("search_index"), 1);
    }

    #[test]
    fn volume_batch_deduplicates_only_actual_siblings_and_promotes_source_with_metadata() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let mut input = f.plan();
        let other = f
            .manager
            .create_plan_node(None, PlanNodeKind::VolumeManager, "Other".into())
            .unwrap();
        f.manager
            .create_plan_node(Some(other.id), PlanNodeKind::Volume, "A".into())
            .unwrap();
        f.manager
            .create_plan_node(Some(f.parent.id), PlanNodeKind::Volume, "B".into())
            .unwrap();
        input.candidates.push(input.candidates[0].clone());
        let receipt = f.manager.adopt_plan_batch(input.clone()).unwrap();
        assert_eq!(receipt.nodes.len(), 1);
        assert_eq!(receipt.nodes[0].title, "A");
        assert_eq!(receipt.nodes[0].parent_id, Some(f.parent.id));
        assert_eq!(receipt.source.version, 2);
        assert_eq!(receipt.source.section.content, input.source.pending_content);
        assert!(receipt.source.section.pending_content.is_empty());
        assert_eq!(
            receipt.source.section.story_state,
            PlanningStoryState::Confirmed
        );
        assert_eq!(receipt.source.section.references, input.source.references);
        assert_eq!(receipt.source.section.rationale, input.source.rationale);
        assert_eq!(receipt.source.section.consequence, input.source.consequence);
        f.reopen();
        let card = f
            .manager
            .list_versioned_planning_sections()
            .unwrap()
            .into_iter()
            .find(|item| item.section.id == format!("plan-node:{}", receipt.nodes[0].id))
            .unwrap();
        assert_eq!(card.section.content, "Goal A");
        assert_eq!(card.version, 1);
        assert_eq!(f.count("chapters"), 0);
    }

    #[test]
    fn chapter_batch_preserves_formal_source_and_creates_chapters_and_execution_cards() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let input = f.plan();
        let receipt = f.manager.adopt_plan_batch(input.clone()).unwrap();
        assert_eq!(receipt.nodes.len(), 2);
        assert!(
            receipt
                .nodes
                .iter()
                .all(|node| node.kind == PlanNodeKind::Chapter)
        );
        assert_eq!(receipt.source.section.content, input.source.content);
        assert_eq!(
            receipt.source.section.story_state,
            PlanningStoryState::Locked
        );
        assert_eq!(receipt.source.section.references, input.source.references);
        assert!(receipt.source.section.pending_content.is_empty());
        assert_eq!(receipt.source.version, 2);
        f.reopen();
        assert_eq!(f.count("chapters"), 2);
        assert_eq!(f.count("plan_revisions"), 3);
        assert_eq!(f.count("plan_node_revisions"), 3);
        assert_eq!(f.count("planning_sections"), 3);
        assert_eq!(f.count("search_index"), 3);
        assert!(matches!(
            f.manager.adopt_plan_batch(input),
            Err(BatchStoreError::Project(
                ProjectError::PlanningConflict { .. }
            ))
        ));
        assert_eq!(f.count("chapters"), 2);
    }

    #[test]
    fn chapter_adoption_ignores_submitted_formal_changes_and_keeps_database_fields() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let mut input = f.plan();
        let original = input.source.clone();
        input.source.content = "Unsubmitted formal edit".into();
        input.source.story_state = PlanningStoryState::Retired;
        input.source.rationale.clear();
        input.source.consequence.clear();
        input.source.references.clear();
        let receipt = f.manager.adopt_plan_batch(input).unwrap();
        assert_eq!(receipt.source.section.content, original.content);
        assert_eq!(receipt.source.section.story_state, original.story_state);
        assert_eq!(receipt.source.section.rationale, original.rationale);
        assert_eq!(receipt.source.section.consequence, original.consequence);
        assert_eq!(receipt.source.section.references, original.references);
    }

    #[test]
    fn unsaved_source_version_zero_is_consumed_once_without_creating_formal_split_content() {
        for kind in [PlanNodeKind::VolumeManager, PlanNodeKind::Volume] {
            let mut f = Fixture::new(kind);
            let input = PlanBatchInput {
                expected_project_id: f.project_id,
                parent_id: f.parent.id,
                expected_parent_revision: 1,
                expected_source_version: 0,
                source: f.source(),
                candidates: vec![PlanBatchCandidate {
                    title: "A".into(),
                    content: "Goal".into(),
                }],
            };
            let receipt = f.manager.adopt_plan_batch(input.clone()).unwrap();
            assert_eq!(receipt.source.version, 1);
            if kind == PlanNodeKind::Volume {
                assert!(receipt.source.section.content.is_empty());
                assert_eq!(
                    receipt.source.section.story_state,
                    PlanningStoryState::Unset
                );
                assert!(receipt.source.section.references.is_empty());
            }
            assert!(matches!(
                f.manager.adopt_plan_batch(input),
                Err(BatchStoreError::Project(
                    ProjectError::PlanningConflict { .. }
                ))
            ));
            assert_eq!(f.count("plan_nodes"), 2);
            f.reopen();
            assert_eq!(f.count("plan_nodes"), 2);
            assert_eq!(f.db().health().unwrap().schema_version, 51);
        }
    }

    #[test]
    fn source_cas_rejects_another_connections_write_before_child_creation() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let input = f.plan();
        let mut other = ProjectManager::new();
        other.open(&f.root).unwrap();
        let mut source = input.source.clone();
        source.pending_content = "Other window".into();
        other.save_planning_section_checked(source, 1).unwrap();
        assert!(matches!(
            f.manager.adopt_plan_batch(input),
            Err(BatchStoreError::Project(ProjectError::PlanningConflict {
                expected: 1,
                actual: 2
            }))
        ));
        assert_eq!(f.count("chapters"), 0);
        assert_eq!(f.count("plan_nodes"), 1);
        assert_eq!(
            f.manager.list_planning_sections().unwrap()[0].pending_content,
            "Other window"
        );
        other.close();
    }

    #[test]
    fn parent_scope_revision_archive_and_source_identity_refuse_the_batch() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let original = f.plan();
        for case in 0..7 {
            let mut input = original.clone();
            match case {
                0 => input.expected_project_id = Uuid::new_v4(),
                1 => input.parent_id = Uuid::new_v4(),
                2 => input.expected_parent_revision += 1,
                3 => input.source.id = format!("plan-node:{}", f.parent.id),
                4 => f.sql("UPDATE plan_nodes SET archived=1"),
                5 => f.sql("UPDATE plan_nodes SET kind='SCENE'"),
                _ => input.source.id = "chapter-split-foreign".into(),
            }
            assert!(f.manager.adopt_plan_batch(input).is_err());
            f.assert_no_children(&original);
            f.sql("UPDATE plan_nodes SET archived=0, kind='VOLUME'");
        }
    }

    #[test]
    fn invalid_later_candidate_and_all_duplicate_candidates_preserve_source() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let original = f.plan();
        let mut input = original.clone();
        input.candidates[1].title.clear();
        assert!(f.manager.adopt_plan_batch(input).is_err());
        f.assert_no_children(&original);
        let mut oversized = original.clone();
        oversized.candidates = vec![original.candidates[0].clone(); 201];
        assert!(f.manager.adopt_plan_batch(oversized).is_err());
        f.assert_no_children(&original);
        f.manager.adopt_plan_batch(original.clone()).unwrap();
        let mut duplicate = original;
        duplicate.expected_source_version = 2;
        assert!(matches!(
            f.manager.adopt_plan_batch(duplicate),
            Err(BatchStoreError::InvalidBatch)
        ));
        assert_eq!(
            f.manager
                .list_versioned_planning_sections()
                .unwrap()
                .into_iter()
                .find(|item| item.section.id == f.source().id)
                .unwrap()
                .version,
            2
        );
    }

    #[test]
    fn child_card_and_source_failures_roll_back_all_tables_and_allow_retry() {
        for failure in [
            "CREATE TRIGGER fail_batch BEFORE INSERT ON plan_node_revisions WHEN NEW.title='B' BEGIN SELECT RAISE(ABORT,'child failure'); END;",
            "CREATE TRIGGER fail_batch BEFORE INSERT ON planning_sections WHEN NEW.content='Goal B' BEGIN SELECT RAISE(ABORT,'card failure'); END;",
            "CREATE TRIGGER fail_batch BEFORE UPDATE ON planning_sections BEGIN SELECT RAISE(ABORT,'source failure'); END;",
        ] {
            let mut f = Fixture::new(PlanNodeKind::Volume);
            let input = f.plan();
            f.sql(failure);
            assert!(f.manager.adopt_plan_batch(input.clone()).is_err());
            f.reopen();
            f.assert_no_children(&input);
            assert_eq!(f.count("search_index"), 1);
            f.sql("DROP TRIGGER fail_batch");
            f.manager.adopt_plan_batch(input).unwrap();
            assert_eq!(f.count("chapters"), 2);
        }
    }

    #[test]
    fn search_failure_rolls_back_source_children_cards_and_summary_invalidation() {
        let mut f = Fixture::new(PlanNodeKind::Volume);
        let input = f.plan();
        f.sql(&format!("INSERT INTO summary_materials (id,project_id,kind,precision,content,generation_mode)
                      VALUES ('summary','{}','SETTING','L4','Formal settings','EXTRACTIVE_AUTO_SETTINGS')", f.project_id));
        f.sql("DROP TABLE writing_cards");
        assert!(f.manager.adopt_plan_batch(input.clone()).is_err());
        f.reopen();
        f.assert_no_children(&input);
        assert_eq!(f.count("search_index"), 1);
        let status: String = f
            .db()
            .connection
            .query_row(
                "SELECT lifecycle_status FROM summary_materials WHERE id='summary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "ACTIVE");
    }

    #[test]
    fn summary_invalidation_is_transactional_and_does_not_change_manual_material() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let input = f.plan();
        f.sql(&format!("INSERT INTO summary_materials (id,project_id,kind,precision,content,generation_mode)
                      VALUES ('auto','{}','SETTING','L4','Formal settings','EXTRACTIVE_AUTO_SETTINGS'),
                             ('manual','{}','SETTING','L4','Manual settings','MANUAL')", f.project_id, f.project_id));
        f.sql("CREATE TRIGGER fail_batch BEFORE UPDATE ON summary_materials WHEN NEW.lifecycle_status='STALE'
               BEGIN SELECT RAISE(ABORT,'summary failure'); END;");
        assert!(f.manager.adopt_plan_batch(input.clone()).is_err());
        f.assert_no_children(&input);
        f.sql("DROP TRIGGER fail_batch");
        f.manager.adopt_plan_batch(input).unwrap();
        for (id, expected) in [("auto", "STALE"), ("manual", "ACTIVE")] {
            let status: String = f
                .db()
                .connection
                .query_row(
                    "SELECT lifecycle_status FROM summary_materials WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, expected);
        }
    }

    #[test]
    fn volume_embedding_invalidation_rolls_back_with_children_and_is_applied_on_retry() {
        let mut f = Fixture::new(PlanNodeKind::VolumeManager);
        let input = f.plan();
        let profile_id = Uuid::new_v4();
        let hash = format!(
            "sha256:{:x}",
            Sha256::digest(input.source.content.as_bytes())
        );
        f.manager
            .generate_planning_embedding(PlanningEmbedding {
                section_id: input.source.id.clone(),
                profile_id,
                model_id: "mock".into(),
                dimensions: 1,
                content_hash: hash.clone(),
                vector: vec![1.0],
                updated_at: String::new(),
            })
            .unwrap();
        f.manager
            .generate_planning_chunk_embedding(PlanningChunkEmbedding {
                chunk_id: "chunk".into(),
                section_id: input.source.id.clone(),
                chunk_index: 0,
                profile_id,
                model_id: "mock".into(),
                dimensions: 1,
                content_hash: hash,
                vector: vec![1.0],
                updated_at: String::new(),
            })
            .unwrap();
        f.sql(
            "CREATE TRIGGER fail_batch BEFORE INSERT ON plan_node_revisions WHEN NEW.title='B'
               BEGIN SELECT RAISE(ABORT,'second child failed'); END;",
        );
        assert!(f.manager.adopt_plan_batch(input.clone()).is_err());
        f.assert_no_children(&input);
        assert_eq!(f.count("planning_embeddings"), 1);
        assert_eq!(f.count("planning_chunk_embeddings"), 1);
        f.sql("DROP TRIGGER fail_batch");
        f.manager.adopt_plan_batch(input).unwrap();
        assert_eq!(f.count("planning_embeddings"), 0);
        assert_eq!(f.count("planning_chunk_embeddings"), 0);
    }
}
