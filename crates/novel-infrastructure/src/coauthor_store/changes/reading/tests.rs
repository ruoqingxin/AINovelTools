use super::*;
use crate::coauthor_store::tests::project;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    decision: CoauthorDecision,
    changes: CoauthorChangeSet,
}
impl Fixture {
    fn new() -> Self {
        let (mut manager, root, scope) = project();
        let mut document = manager.coauthor_document(&scope).unwrap();
        document.title = "突破试写".into();
        document.content = "甲😀乙\n".repeat(3_001);
        let document = manager.save_coauthor_document(&scope, document).unwrap();
        let run = manager.start_coauthor_run(&scope, Uuid::new_v4(), "确定失忆代价", document.version).unwrap();
        let decision = manager.set_coauthor_decision(&scope, run.id, CoauthorDecisionInput {
            decision_id: None, expected_version: 0, topic: "突破代价".into(), aliases: vec![],
            content: "不得免除失忆代价。".into(), status: "CHOSEN".into(), quote: "确定失忆代价".into(),
        }).unwrap();
        manager.finish_coauthor_run(&scope, run.id, "COMPLETED", "", &[]).unwrap();
        let changes = manager.prepare_coauthor_changeset(&scope, CoauthorChangeRequest {
            expected_document_version: document.version, title: "突破方案".into(),
            include_draft: true, draft_depends_on: vec![],
            items: vec![CoauthorChangeItemInput {
                id: "setting".into(), kind: CoauthorDocumentKind::Setting, title: "境界规则".into(), content: "旧规则：突破失忆。".into(),
                target_key: None, target_revision: None, depends_on: vec![], manuscript_edits: vec![], outline_edits: vec![],
            }],
            impacts: vec![], coverage: "仅当前试写及规则，不代表全书已核对。".into(),
            decision_dependencies: vec![CoauthorDecisionDependencyInput {
                decision_id: decision.id, version: 1, item_ids: vec!["draft".into()],
            }],
        }, None).unwrap();
        Self { manager, root, scope, decision, changes }
    }
    fn db(&self) -> &Database { &self.manager.current.as_ref().unwrap().database }
    fn read(&self, side: CoauthorChangeItemSide, offset: usize, limit: usize) -> Result<CoauthorChangeItemPage, CoauthorError> {
        self.manager.read_coauthor_change_item(&self.scope, CoauthorChangeItemRead {
            change_set_id: self.changes.id, expected_version: self.changes.version, item_id: "draft".into(), side, offset, limit,
        })
    }
    fn write_payload(&self) {
        self.db().connection.execute("UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
            rusqlite::params![self.changes.id.to_string(), encode(&self.changes).unwrap()]).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { self.manager.close(); let _ = std::fs::remove_dir_all(&self.root); }
}

#[test]
fn plan_metadata_is_compact_and_refreshes_only_the_selected_plans_decision_versions() {
    let mut f = Fixture::new();
    f.manager.correct_coauthor_decision(&f.scope, f.decision.id, 1, "撤回旧方向", "WITHDRAWN").unwrap();
    f.db().connection.execute_batch("UPDATE coauthor_documents SET payload='{}'").unwrap();
    let plan = f.manager.coauthor_change_plan(&f.scope, f.changes.id).unwrap();
    assert!(plan.snapshot_only);
    assert_eq!(plan.items.len(), 2);
    assert!(plan.items.iter().all(|item| item.state == "PENDING"));
    assert_eq!(plan.items[0].after_chars, 12_004);
    let rule = &plan.decision_dependencies.as_ref().unwrap()[0];
    assert_eq!((rule.prepared_version, rule.current_version), (1, Some(2)));
    assert_eq!(rule.current_status.as_deref(), Some("WITHDRAWN"));
    let text = serde_json::to_string(&plan).unwrap();
    assert!(!text.contains("甲") && !text.contains("不得免除"));
    assert!(!text.contains("manuscriptBeforeJson"));
    assert!(text.len() < 4_000);
    assert_eq!(f.read(CoauthorChangeItemSide::After, 0, 4).unwrap().content, "甲😀乙\n");
}

#[test]
fn unicode_snapshot_pages_preserve_exact_offsets_without_skipping_or_repeating_characters() {
    let f = Fixture::new();
    let first = f.read(CoauthorChangeItemSide::After, 0, 12_000).unwrap();
    let last = f.read(CoauthorChangeItemSide::After, first.next_offset, 12_000).unwrap();
    assert_eq!((first.offset, first.next_offset, first.total_chars), (0, 12_000, 12_004));
    assert_eq!((last.offset, last.next_offset), (12_000, 12_004));
    assert_eq!(first.content + &last.content, f.changes.items[0].document.content);
    assert_eq!(f.read(CoauthorChangeItemSide::After, 1, 1).unwrap().content, "😀");
    assert!(f.read(CoauthorChangeItemSide::After, 12_004, 4).unwrap().content.is_empty());
    for (offset, limit) in [(12_005, 4), (0, 0), (0, 12_001), (usize::MAX, 1)] {
        assert!(f.read(CoauthorChangeItemSide::After, offset, limit).is_err());
    }
}

#[test]
fn new_item_has_no_before_snapshot_and_is_not_confused_with_a_present_empty_snapshot() {
    let mut f = Fixture::new();
    let missing = f.read(CoauthorChangeItemSide::Before, 0, 4).unwrap();
    assert!(!missing.available && missing.content.is_empty() && missing.snapshot_only);
    assert_eq!((missing.total_chars, missing.next_offset), (0, 0));
    assert!(f.read(CoauthorChangeItemSide::Before, 1, 4).is_err());
    f.changes.items[0].document.content.clear();
    f.write_payload();
    let present = f.read(CoauthorChangeItemSide::After, 0, 4).unwrap();
    assert!(present.available && present.content.is_empty());
    let mut legacy = serde_json::to_value(&f.changes).unwrap();
    legacy.as_object_mut().unwrap().remove("decisionDependencies");
    f.db().connection.execute("UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
        rusqlite::params![f.changes.id.to_string(), legacy.to_string()]).unwrap();
    assert!(f.manager.coauthor_change_plan(&f.scope, f.changes.id).unwrap().decision_dependencies.is_none());
}

#[test]
fn current_formal_edits_do_not_replace_the_original_before_and_after_snapshots() {
    let mut f = Fixture::new();
    let adopted = f.manager.commit_coauthor_changeset(&f.scope, f.changes.id, 1, vec!["setting".into()]).unwrap();
    let published = &adopted.published[0];
    let replacement = f.manager.prepare_coauthor_changeset(&f.scope, CoauthorChangeRequest {
        expected_document_version: adopted.base_document.version, title: "调整已有规则".into(), include_draft: false,
        draft_depends_on: vec![], items: vec![CoauthorChangeItemInput {
            id: "rule".into(), kind: CoauthorDocumentKind::Setting, title: "境界规则".into(), content: "新规则：失忆限于突破之后。".into(),
            target_key: Some(published.source_key.clone()), target_revision: Some(published.revision.clone()),
            depends_on: vec![], manuscript_edits: vec![], outline_edits: vec![],
        }], impacts: vec![], coverage: "只检查本规则。".into(), decision_dependencies: vec![],
    }, None).unwrap();
    let read = |manager: &ProjectManager, version, side| manager.read_coauthor_change_item(&f.scope, CoauthorChangeItemRead {
        change_set_id: replacement.id, expected_version: version, item_id: "rule".into(), side, offset: 0, limit: 4_000,
    }).unwrap();
    let original = replacement.items[0].before.as_ref().unwrap().content.clone();
    assert!(original.starts_with("旧规则：突破失忆。"));
    assert_eq!(read(&f.manager, 1, CoauthorChangeItemSide::Before).content, original);
    f.manager.commit_coauthor_changeset(&f.scope, replacement.id, 1, vec!["rule".into()]).unwrap();
    assert_eq!(read(&f.manager, 2, CoauthorChangeItemSide::Before).content, original);
    assert_eq!(read(&f.manager, 2, CoauthorChangeItemSide::After).content, "新规则：失忆限于突破之后。");
    let plan = f.manager.coauthor_change_plan(&f.scope, replacement.id).unwrap();
    assert_eq!(plan.items[0].state, "ADOPTED");
    assert_eq!(plan.items[0].target_revision.as_ref(), Some(&published.revision));
    assert_ne!(plan.items[0].target_revision, plan.items[0].published_revision);
}

#[test]
fn commits_and_reversals_change_metadata_without_replaying_or_regranting_old_plan_versions() {
    let mut f = Fixture::new();
    f.manager.commit_coauthor_changeset(&f.scope, f.changes.id, 1, vec!["setting".into()]).unwrap();
    assert!(matches!(f.read(CoauthorChangeItemSide::After, 0, 4), Err(CoauthorError::Conflict)));
    let plan = f.manager.coauthor_change_plan(&f.scope, f.changes.id).unwrap();
    assert_eq!(plan.items.iter().find(|item| item.item_id == "draft").unwrap().state, "NOT_ADOPTED");
    assert_eq!(plan.items.iter().find(|item| item.item_id == "setting").unwrap().state, "ADOPTED");
    let reversal = f.manager.prepare_coauthor_reversal(&f.scope, f.changes.id, 2, 1).unwrap();
    f.manager.commit_coauthor_reversal(&f.scope, f.changes.id, reversal.version).unwrap();
    assert_eq!(f.manager.coauthor_change_plan(&f.scope, f.changes.id).unwrap().items[1].state, "REVERSED");
    f.changes.version = 2;
    assert!(f.read(CoauthorChangeItemSide::After, 0, 4).unwrap().snapshot_only);
}

#[test]
fn discarded_plan_snapshots_remain_historical_but_old_version_pages_are_rejected() {
    let mut f = Fixture::new();
    f.manager.discard_coauthor_changeset(&f.scope, f.changes.id, 1).unwrap();
    let plan = f.manager.coauthor_change_plan(&f.scope, f.changes.id).unwrap();
    assert_eq!(plan.status, "DISCARDED");
    assert!(plan.items.iter().all(|item| item.state == "DISCARDED"));
    assert!(matches!(f.read(CoauthorChangeItemSide::After, 0, 4), Err(CoauthorError::Conflict)));
    f.changes.version = 2;
    assert_eq!(f.read(CoauthorChangeItemSide::After, 0, 4).unwrap().content, "甲😀乙\n");
}

#[test]
fn actual_manuscript_and_outline_patch_snapshots_are_plain_text_without_formatting_or_write_authority() {
    let mut f = Fixture::new();
    let chapter = f.manager.create_plan_node(None, PlanNodeKind::Chapter, "突破正文".into()).unwrap();
    let rich = serde_json::json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"p"},
        "content":[{"type":"text","text":"甲😀寿元","marks":[{"type":"bold"}]}]}]}).to_string();
    f.manager.save_manuscript(chapter.id, rich, "TEST".into()).unwrap();
    let body_key = format!("MANUSCRIPT:{}", chapter.id);
    let body = f.db().coauthor_source(&body_key).unwrap().unwrap();
    let body_revision = body.revision.clone();
    let outline = f.manager.create_plan_node(None, PlanNodeKind::Outline, "突破大纲".into()).unwrap();
    let section = f.manager.save_planning_section_checked(PlanningSection {
        id: format!("plan-node:{}", outline.id), content: "寿元代价".into(), pending_content: String::new(),
        story_state: PlanningStoryState::Confirmed, rationale: String::new(), consequence: String::new(),
        references: vec![], updated_at: String::new(),
    }, 0).unwrap();
    let outline_key = format!("PLAN:{}", section.section.id);
    let before_outline = f.db().coauthor_source(&outline_key).unwrap().unwrap();
    let original_outline = before_outline.content.clone();
    let item = |id: &str, kind, title, key, revision| CoauthorChangeItemInput {
        id: id.into(), kind, title, content: String::new(), target_key: Some(key), target_revision: Some(revision),
        depends_on: vec![], manuscript_edits: vec![], outline_edits: vec![],
    };
    let mut body_item = item("body", CoauthorDocumentKind::Manuscript, body.title, body.key, body.revision);
    body_item.manuscript_edits.push(CoauthorManuscriptEdit {
        block_id: "p".into(), start: 2, end: 4, before: "寿元".into(), after: "记忆".into(), after_runs: vec![],
    });
    let mut outline_item = item("outline", CoauthorDocumentKind::Outline, outline.title, before_outline.key, before_outline.revision);
    outline_item.outline_edits.push(CoauthorOutlineEdit { start: 0, end: 2, before: "寿元".into(), after: "记忆".into() });
    let plan = f.manager.prepare_coauthor_changeset(&f.scope, CoauthorChangeRequest {
        expected_document_version: 1, title: "局部改稿快照".into(), include_draft: false, draft_depends_on: vec![],
        items: vec![body_item, outline_item], impacts: vec![], coverage: "只核对两处修改".into(), decision_dependencies: vec![],
    }, None).unwrap();
    let summary = f.manager.coauthor_change_plan(&f.scope, plan.id).unwrap();
    assert!(summary.items.iter().all(|item| item.has_structured_edits && item.before_available));
    for (item_id, expected) in [("body", "甲😀记忆"), ("outline", "记忆代价")] {
        let page = f.manager.read_coauthor_change_item(&f.scope, CoauthorChangeItemRead {
            change_set_id: plan.id, expected_version: 1, item_id: item_id.into(),
            side: CoauthorChangeItemSide::After, offset: 0, limit: 100,
        }).unwrap();
        assert_eq!(page.content, expected);
        assert!(page.snapshot_only);
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("blockId") && !json.contains("marks"));
    }
    assert_eq!(f.db().coauthor_source(&body_key).unwrap().unwrap().revision, body_revision);
    assert_eq!(f.db().coauthor_source(&outline_key).unwrap().unwrap().content, original_outline);
}

#[test]
fn exact_plan_item_project_and_session_identities_cannot_fall_back_to_an_unrelated_plan() {
    let mut f = Fixture::new();
    let wrong = CoauthorScope { project_id: Uuid::new_v4(), ..f.scope.clone() };
    assert!(f.manager.coauthor_change_plan(&wrong, f.changes.id).is_err());
    let branch = f.manager.fork_coauthor_session(&f.scope, "另一分支".into()).unwrap();
    let scope = CoauthorScope { session_id: branch.id, ..f.scope.clone() };
    assert!(f.manager.coauthor_change_plan(&scope, f.changes.id).is_err());
    assert!(f.manager.coauthor_change_plan(&f.scope, Uuid::new_v4()).is_err());
    assert!(f.manager.read_coauthor_change_item(&f.scope, CoauthorChangeItemRead {
        change_set_id: f.changes.id, expected_version: 1, item_id: "missing".into(),
        side: CoauthorChangeItemSide::After, offset: 0, limit: 4,
    }).is_err());
    let original_id = f.changes.id;
    f.changes.id = Uuid::new_v4();
    let wrong_payload = encode(&f.changes).unwrap();
    f.changes.id = original_id;
    f.db().connection.execute("UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
        rusqlite::params![f.changes.id.to_string(), wrong_payload]).unwrap();
    assert!(f.manager.coauthor_change_plan(&f.scope, f.changes.id).is_err());
    assert!(f.read(CoauthorChangeItemSide::After, 0, 4).is_err());
    f.write_payload();
    f.db().connection.execute("UPDATE coauthor_changesets SET payload=json_set(payload,'$.items',42) WHERE id=?1",
        [f.changes.id.to_string()]).unwrap();
    assert!(f.manager.coauthor_change_plan(&f.scope, f.changes.id).is_err());
}

#[test]
fn snapshot_queries_survive_reopen_and_backup_restore_without_writing_author_content() {
    let mut f = Fixture::new();
    let original = f.manager.coauthor_document(&f.scope).unwrap();
    let before = encode(&f.manager.coauthor_changeset(&f.scope, f.changes.id).unwrap()).unwrap();
    f.manager.close(); f.manager.open(&f.root).unwrap();
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded);
    let target = f.root.with_file_name(format!("coauthor-snapshot-restore-{}", Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target).unwrap();
    let mut restored = ProjectManager::new(); restored.open(&target).unwrap();
    assert_eq!(restored.coauthor_change_plan(&f.scope, f.changes.id).unwrap().items.len(), 2);
    assert!(restored.read_coauthor_change_item(&f.scope, CoauthorChangeItemRead {
        change_set_id: f.changes.id, expected_version: 1, item_id: "draft".into(),
        side: CoauthorChangeItemSide::After, offset: 1, limit: 1,
    }).unwrap().snapshot_only);
    assert_eq!(restored.coauthor_document(&f.scope).unwrap(), original);
    assert_eq!(encode(&restored.coauthor_changeset(&f.scope, f.changes.id).unwrap()).unwrap(), before);
    drop(restored); let _ = std::fs::remove_dir_all(target);
}
