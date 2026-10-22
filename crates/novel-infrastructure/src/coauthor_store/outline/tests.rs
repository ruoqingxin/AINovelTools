use super::*;
use crate::coauthor_store::tests::project;
use serde_json::json;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    node: PlanNode,
    source: CoauthorSource,
    section: VersionedPlanningSection,
}
impl Fixture {
    fn new() -> Self {
        let (mut manager, root, scope) = project();
        let node = manager
            .create_plan_node(None, PlanNodeKind::Outline, "突破大纲".into())
            .unwrap();
        let section = manager
            .save_planning_section_checked(
                PlanningSection {
                    id: format!("plan-node:{}", node.id),
                    content: "甲😀突破消耗寿元。\n结尾保留声音。".into(),
                    pending_content: "未确认的候选版本".into(),
                    story_state: PlanningStoryState::Confirmed,
                    rationale: "作者备注".into(),
                    consequence: "后续影响".into(),
                    references: vec!["作者来源".into()],
                    updated_at: String::new(),
                },
                0,
            )
            .unwrap();
        let source = manager
            .current
            .as_ref()
            .unwrap()
            .database
            .coauthor_source(&format!("PLAN:{}", section.section.id))
            .unwrap()
            .unwrap();
        Self {
            manager,
            root,
            scope,
            node,
            source,
            section,
        }
    }
    fn request(&self) -> CoauthorChangeRequest {
        CoauthorChangeRequest {
            expected_document_version: 0,
            title: "修改正式大纲".into(),
            include_draft: false,
            draft_depends_on: vec![],
            items: vec![CoauthorChangeItemInput {
                id: "outline".into(),
                kind: CoauthorDocumentKind::Outline,
                title: self.node.title.clone(),
                content: String::new(),
                target_key: Some(self.source.key.clone()),
                target_revision: Some(self.source.revision.clone()),
                depends_on: vec![],
                manuscript_edits: vec![],
                outline_edits: vec![CoauthorOutlineEdit {
                    start: 6,
                    end: 8,
                    before: "寿元".into(),
                    after: "记忆".into(),
                }],
            }],
            impacts: vec![],
            coverage: "只修改指定大纲的代价，未检查全书。".into(),
        }
    }
    fn prepare(&mut self) -> CoauthorChangeSet {
        self.manager
            .prepare_coauthor_changeset(&self.scope, self.request(), None)
            .unwrap()
    }
    fn commit(&mut self, changes: &CoauthorChangeSet) -> Result<CoauthorChangeSet, CoauthorError> {
        self.manager
            .commit_coauthor_changeset(&self.scope, changes.id, 1, vec!["outline".into()])
    }
    fn db(&self) -> &Database {
        &self.manager.current.as_ref().unwrap().database
    }
    fn current(&self) -> VersionedPlanningSection {
        self.manager
            .list_versioned_planning_sections()
            .unwrap()
            .into_iter()
            .find(|item| item.section.id == self.section.section.id)
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
fn exact_unicode_edits_keep_non_targets_and_support_multiline_replacement_and_deletion() {
    let edit = CoauthorOutlineEdit {
        start: 2,
        end: 4,
        before: "寿元".into(),
        after: "记忆\n".into(),
    };
    let second = CoauthorOutlineEdit {
        start: 5,
        end: 7,
        before: "删除".into(),
        after: String::new(),
    };
    assert_eq!(
        apply_outline_edits("甲😀寿元，删除。", &[second, edit]).unwrap(),
        "甲😀记忆\n，。"
    );
}

#[test]
fn ambiguous_overlapping_empty_wrong_ranges_and_oversize_edits_are_rejected() {
    let edit = CoauthorOutlineEdit {
        start: 2,
        end: 4,
        before: "寿元".into(),
        after: "记忆".into(),
    };
    for edits in [
        vec![],
        vec![edit.clone(), edit.clone()],
        vec![CoauthorOutlineEdit {
            start: 4,
            end: 2,
            ..edit.clone()
        }],
        vec![CoauthorOutlineEdit {
            end: 99,
            ..edit.clone()
        }],
        vec![CoauthorOutlineEdit {
            start: 2,
            end: 2,
            ..edit.clone()
        }],
        vec![CoauthorOutlineEdit {
            before: "未知".into(),
            ..edit.clone()
        }],
        vec![CoauthorOutlineEdit {
            after: "寿元".into(),
            ..edit.clone()
        }],
        vec![CoauthorOutlineEdit {
            after: "字".repeat(12_001),
            ..edit.clone()
        }],
    ] {
        assert!(apply_outline_edits("甲😀寿元", &edits).is_err());
    }
    assert!(
        apply_outline_edits(
            "寿元",
            &[CoauthorOutlineEdit {
                start: 0,
                end: 2,
                before: "寿元".into(),
                after: " ".into()
            }]
        )
        .is_err()
    );
}

#[test]
fn paged_reads_use_formal_content_offsets_not_candidate_or_source_prefix_and_enforce_scope() {
    let f = Fixture::new();
    let page = f
        .manager
        .read_coauthor_outline(&f.scope, &f.source.key, &f.source.revision, 1, 7)
        .unwrap();
    assert_eq!(page.content, "😀突破消耗寿元");
    assert_eq!(page.offset, 1);
    assert_eq!(page.next_offset, Some(8));
    assert!(!page.content.contains("候选"));
    assert!(
        f.manager
            .read_coauthor_outline(&f.scope, &f.source.key, "old", 0, 30)
            .is_err()
    );
    assert!(
        f.manager
            .read_coauthor_outline(&f.scope, &f.source.key, &f.source.revision, 999, 30)
            .is_err()
    );
    let foreign = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .read_coauthor_outline(&foreign, &f.source.key, &f.source.revision, 0, 30)
            .is_err()
    );
}

#[test]
fn formal_adoption_preserves_candidates_metadata_identity_and_durable_before_after_history() {
    let mut f = Fixture::new();
    let changes = f.prepare();
    assert_eq!(
        changes.items[0].document.content,
        "甲😀突破消耗记忆。\n结尾保留声音。"
    );
    assert_eq!(changes.items[0].outline_before, Some(f.section.clone()));
    let receipt = f.commit(&changes).unwrap();
    assert_eq!(receipt.published[0].source_key, f.source.key);
    let actual = f.current();
    assert_eq!(actual.version, f.section.version + 1);
    let mut expected = f.section.section.clone();
    expected.content = changes.items[0].document.content.clone();
    expected.updated_at = actual.section.updated_at.clone();
    assert_eq!(actual.section, expected);
    assert_eq!(f.manager.list_plan_nodes().unwrap(), vec![f.node.clone()]);
    assert!(
        f.manager
            .coauthor_state(&f.scope)
            .unwrap()
            .document
            .content
            .is_empty()
    );
    assert_eq!(
        f.commit(&changes).unwrap().published[0].revision,
        receipt.published[0].revision
    );
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "突破 记忆", false, 0)
        .unwrap();
    assert!(
        found
            .hits
            .iter()
            .any(|hit| hit.key == f.source.key && hit.content.contains("记忆"))
    );
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    let persisted = f.manager.coauthor_changeset(&f.scope, changes.id).unwrap();
    assert_eq!(persisted.items[0].outline_before, Some(f.section.clone()));
    assert_eq!(persisted.items[0].document.content, expected.content);
}

#[test]
fn protection_states_non_outline_plain_overwrite_and_mixed_edit_kinds_cannot_bypass_checks() {
    let mut f = Fixture::new();
    for state in [
        PlanningStoryState::Locked,
        PlanningStoryState::AuthorReserved,
        PlanningStoryState::AiSuggested,
    ] {
        f.db()
            .connection
            .execute(
                "UPDATE planning_sections SET story_state=?2 WHERE id=?1",
                rusqlite::params![f.section.section.id, state.as_str()],
            )
            .unwrap();
        f.source = f.db().coauthor_source(&f.source.key).unwrap().unwrap();
        assert!(
            f.manager
                .prepare_coauthor_changeset(&f.scope, f.request(), None)
                .is_err()
        );
    }
    f.db()
        .connection
        .execute(
            "UPDATE planning_sections SET story_state='CONFIRMED' WHERE id=?1",
            [&f.section.section.id],
        )
        .unwrap();
    f.source = f.db().coauthor_source(&f.source.key).unwrap().unwrap();
    let mut input = f.request();
    input.items[0].content = "夹带全文".into();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    let mut input = f.request();
    input.items[0].outline_edits.clear();
    input.items[0].content = "直接覆盖".into();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    let mut input = f.request();
    input.items[0]
        .manuscript_edits
        .push(CoauthorManuscriptEdit {
            block_id: "fake".into(),
            start: 0,
            end: 1,
            before: "甲".into(),
            after: "乙".into(),
            after_runs: vec![],
        });
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    let mut input = f.request();
    input.items[0].title = "擅自改名".into();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    f.db()
        .connection
        .execute(
            "UPDATE plan_nodes SET kind='VOLUME' WHERE id=?1",
            [f.node.id.to_string()],
        )
        .unwrap();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, f.request(), None)
            .is_err()
    );
}

#[test]
fn metadata_or_same_text_new_version_and_node_rename_reversion_invalidate_old_preview() {
    for mutation in [
        "UPDATE planning_sections SET rationale=rationale || '新备注' WHERE id=?1",
        "UPDATE planning_sections SET version=version+1 WHERE id=?1",
        "UPDATE plan_nodes SET revision=revision+1 WHERE 'plan-node:' || id=?1",
    ] {
        let mut f = Fixture::new();
        let changes = f.prepare();
        f.db()
            .connection
            .execute(mutation, [&f.section.section.id])
            .unwrap();
        assert!(f.commit(&changes).is_err());
        assert_eq!(f.current().section.content, f.section.section.content);
    }
}

#[test]
fn adoption_and_reversal_invalidate_embeddings_and_summaries_transactionally() {
    let mut f = Fixture::new();
    let changes = f.prepare();
    f.db().connection.execute("INSERT INTO planning_embeddings
        (section_id,profile_id,model_id,dimensions,content_hash,vector_json) VALUES (?1,?2,'test',1,'old','[1]')",
        rusqlite::params![f.section.section.id,Uuid::new_v4().to_string()]).unwrap();
    let material = f
        .manager
        .upsert_summary_material(SummaryMaterial {
            id: Uuid::new_v4(),
            project_id: f.scope.project_id,
            kind: SummaryKind::Setting,
            precision: SummaryPrecision::L4,
            source_id: None,
            source_version: None,
            content: "旧摘要".into(),
            generation_mode: "EXTRACTIVE_AUTO_SETTINGS".into(),
            lifecycle_status: "ACTIVE".into(),
            created_at: String::new(),
            updated_at: String::new(),
        })
        .unwrap();
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_outline_summary BEFORE UPDATE ON summary_materials
        BEGIN SELECT RAISE(ABORT,'test'); END;",
        )
        .unwrap();
    assert!(f.commit(&changes).is_err());
    assert_eq!(f.current(), f.section);
    assert_eq!(f.manager.list_planning_embeddings().unwrap().len(), 1);
    assert_eq!(
        f.manager
            .list_summary_materials()
            .unwrap()
            .iter()
            .find(|item| item.id == material.id)
            .unwrap()
            .lifecycle_status,
        "ACTIVE"
    );
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail_outline_summary")
        .unwrap();
    f.commit(&changes).unwrap();
    assert!(f.manager.list_planning_embeddings().unwrap().is_empty());
    assert_eq!(
        f.manager
            .list_summary_materials()
            .unwrap()
            .iter()
            .find(|item| item.id == material.id)
            .unwrap()
            .lifecycle_status,
        "STALE"
    );
    let preview = f
        .manager
        .prepare_coauthor_reversal(&f.scope, changes.id, 2, 0)
        .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    f.manager
        .commit_coauthor_reversal(&f.scope, changes.id, preview.version)
        .unwrap();
    let restored = f.current();
    assert_eq!(restored.version, f.section.version + 2);
    let mut expected = f.section.section.clone();
    expected.updated_at = restored.section.updated_at.clone();
    assert_eq!(restored.section, expected);
    assert!(!f.manager.list_plan_nodes().unwrap()[0].archived);
}

#[test]
fn later_outline_write_or_receipt_failure_rolls_back_other_targets_and_restoration() {
    let mut f = Fixture::new();
    let mut input = f.request();
    input.items.insert(
        0,
        CoauthorChangeItemInput {
            id: "setting".into(),
            kind: CoauthorDocumentKind::Setting,
            title: "关联设定".into(),
            content: "突破失忆".into(),
            target_key: None,
            target_revision: None,
            depends_on: vec![],
            manuscript_edits: vec![],
            outline_edits: vec![],
        },
    );
    let changes = f
        .manager
        .prepare_coauthor_changeset(&f.scope, input, None)
        .unwrap();
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_outline BEFORE UPDATE ON planning_sections
        BEGIN SELECT RAISE(ABORT,'test'); END;",
        )
        .unwrap();
    assert!(
        f.manager
            .commit_coauthor_changeset(
                &f.scope,
                changes.id,
                1,
                vec!["setting".into(), "outline".into()]
            )
            .is_err()
    );
    let count: i64 = f
        .db()
        .connection
        .query_row("SELECT COUNT(*) FROM entities", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(f.current(), f.section);
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail_outline")
        .unwrap();
    f.manager
        .commit_coauthor_changeset(
            &f.scope,
            changes.id,
            1,
            vec!["setting".into(), "outline".into()],
        )
        .unwrap();
    let preview = f
        .manager
        .prepare_coauthor_reversal(&f.scope, changes.id, 2, 0)
        .unwrap();
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_outline_receipt BEFORE UPDATE ON coauthor_reversals
        WHEN NEW.status='COMMITTED' BEGIN SELECT RAISE(ABORT,'test'); END;",
        )
        .unwrap();
    assert!(
        f.manager
            .commit_coauthor_reversal(&f.scope, changes.id, preview.version)
            .is_err()
    );
    assert!(f.current().section.content.contains("记忆"));
    let active: i64 = f
        .db()
        .connection
        .query_row(
            "SELECT COUNT(*) FROM entities WHERE lifecycle_status='ACTIVE'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active, 1);
}

#[test]
fn outline_read_dependencies_are_durable_and_changed_sources_block_pending_adoption() {
    let mut f = Fixture::new();
    let run = f
        .manager
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "修改大纲", 0)
        .unwrap();
    let page = f
        .manager
        .read_coauthor_outline(&f.scope, &f.source.key, &f.source.revision, 0, 12000)
        .unwrap();
    let audit = vec![json!({"kind":"tool","name":"read_outline_content","result":page})];
    f.manager
        .checkpoint_coauthor_run(&f.scope, run.id, "", &audit)
        .unwrap();
    let input = f.request();
    let changes = f
        .manager
        .prepare_coauthor_changeset(&f.scope, input, Some(run.id))
        .unwrap();
    assert_eq!(changes.read_dependencies.len(), 1);
    f.manager
        .finish_coauthor_run(&f.scope, run.id, "COMPLETED", "", &audit)
        .unwrap();
    f.db()
        .connection
        .execute(
            "UPDATE planning_sections SET version=version+1 WHERE id=?1",
            [&f.section.section.id],
        )
        .unwrap();
    assert!(f.commit(&changes).is_err());
}

#[test]
fn actual_backup_restores_outline_snapshots_and_can_reverse_without_losing_candidate_metadata() {
    let mut f = Fixture::new();
    let changes = f.prepare();
    f.commit(&changes).unwrap();
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let snapshot = f.root.join("snapshots").join(job.id.to_string());
    let recovered = f
        .root
        .with_file_name(format!("coauthor-outline-restore-{}", Uuid::new_v4()));
    f.manager
        .restore_backup_to_new_project(&snapshot, &recovered)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&recovered).unwrap();
    let receipt = restored.coauthor_changeset(&f.scope, changes.id).unwrap();
    assert_eq!(receipt.items[0].outline_before, Some(f.section.clone()));
    let preview = restored
        .prepare_coauthor_reversal(&f.scope, changes.id, 2, 0)
        .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    restored
        .commit_coauthor_reversal(&f.scope, changes.id, preview.version)
        .unwrap();
    let section = restored
        .list_versioned_planning_sections()
        .unwrap()
        .into_iter()
        .find(|item| item.section.id == f.section.section.id)
        .unwrap();
    assert_eq!(section.section.content, f.section.section.content);
    assert_eq!(
        section.section.pending_content,
        f.section.section.pending_content
    );
    assert_eq!(section.section.references, f.section.section.references);
    assert_eq!(section.version, 3);
    restored.close();
    let _ = std::fs::remove_dir_all(recovered);
}
