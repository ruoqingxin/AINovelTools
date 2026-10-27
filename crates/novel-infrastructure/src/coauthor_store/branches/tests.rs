use super::*;
use crate::coauthor_store::tests::project;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    child: CoauthorScope,
}

impl Fixture {
    fn new() -> Self {
        let (mut manager,root,scope) = project();
        let mut doc = manager.coauthor_document(&scope).unwrap();
        doc.content = "甲😀旧结尾，保留。".into();
        manager.save_coauthor_document(&scope,doc).unwrap();
        let branch = manager.fork_coauthor_session(&scope,"失忆分支".into()).unwrap();
        let child = CoauthorScope { session_id:branch.id,..scope.clone() };
        let mut doc = manager.coauthor_document(&child).unwrap();
        doc.content = "乙😀新结尾，来源。".into();
        manager.save_coauthor_document(&child,doc).unwrap();
        Self { manager,root,scope,child }
    }

    fn input(&self) -> CoauthorBranchMergeInput {
        CoauthorBranchMergeInput {
            source_session_id:self.child.session_id,
            expected_version:self.manager.coauthor_document(&self.scope).unwrap().version,
            source_version:self.manager.coauthor_document(&self.child).unwrap().version,
            source_start:2,source_end:5,target_start:2,target_end:5,
        }
    }

    fn db(&self) -> &Database { &self.manager.current.as_ref().unwrap().database }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn direct_parent_and_child_comparisons_preserve_the_exact_inheritance_base() {
    let f = Fixture::new();
    let forward = f.manager.compare_coauthor_branch(&f.scope,f.child.session_id).unwrap();
    assert_eq!(forward.branch.relationship,"CHILD");
    assert_eq!(forward.base_document.content,"甲😀旧结尾，保留。");
    assert_eq!(forward.current_document.version,1);
    assert_eq!(forward.source_document.version,2);
    let backward = f.manager.compare_coauthor_branch(&f.child,f.scope.session_id).unwrap();
    assert_eq!(backward.branch.relationship,"PARENT");
    assert_eq!(forward.base_document,backward.base_document);
    let page = f.manager.list_coauthor_branches(&f.scope,0).unwrap();
    assert_eq!(page.branches[0].session_id,f.child.session_id);
    assert!(!page.has_more);
}

#[test]
fn empty_parent_version_zero_is_a_real_comparison_base_not_a_missing_revision() {
    let (mut manager,root,scope) = project();
    let child = manager.fork_coauthor_session(&scope,"空白探索".into()).unwrap();
    let compared = manager.compare_coauthor_branch(&scope,child.id).unwrap();
    assert_eq!(compared.base_document.version,0);
    assert!(compared.base_document.content.is_empty());
    assert_eq!(compared.source_document.version,1);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn directory_is_paged_and_does_not_decode_all_branch_documents_or_old_audits() {
    let mut f = Fixture::new();
    for index in 0..22 {
        f.manager.fork_coauthor_session(&f.scope,format!("探索{index}")).unwrap();
    }
    f.db().connection.execute(
        "UPDATE coauthor_documents SET payload='{}' WHERE session_id=?1",[f.child.session_id.to_string()],
    ).unwrap();
    let a = f.manager.list_coauthor_branches(&f.scope,0).unwrap();
    let b = f.manager.list_coauthor_branches(&f.scope,20).unwrap();
    assert_eq!((a.branches.len(),b.branches.len()),(20,3));
    assert!(a.has_more && !b.has_more);
    let ids = a.branches.into_iter().chain(b.branches).map(|branch|branch.session_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(),23);
    assert!(f.manager.compare_coauthor_branch(&f.scope,f.child.session_id).is_err());
}

#[test]
fn prepared_unicode_range_merge_preserves_metadata_and_only_changes_the_target_working_draft() {
    let mut f = Fixture::new();
    let before = f.manager.coauthor_document(&f.scope).unwrap();
    let source = f.manager.coauthor_document(&f.child).unwrap();
    let input = f.input();
    let merge = f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
    assert_eq!(merge.status,"PENDING");
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),before);
    assert_eq!(merge.after.content,"甲😀新结尾，保留。");
    assert_eq!(merge.after.title,before.title);
    assert_eq!(merge.after.kind,before.kind);
    assert_eq!(merge.after.target_key,before.target_key);
    let applied = f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap();
    assert_eq!(applied.status,"APPLIED");
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),applied.after);
    assert_eq!(f.manager.coauthor_document(&f.child).unwrap(),source);
    assert!(f.manager.coauthor_state(&f.scope).unwrap().decisions.is_empty());
    assert!(f.manager.list_current_facts().unwrap().is_empty());
    assert_eq!(f.manager.coauthor_document_history(&f.scope,None).unwrap().len(),2);
    assert_eq!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap().after,applied.after);
    assert_eq!(f.manager.coauthor_document_history(&f.scope,None).unwrap().len(),2);
}

#[test]
fn same_text_new_source_or_target_revision_rejects_old_previews_and_preserves_both_drafts() {
    for change_source in [false,true] {
        let mut f = Fixture::new();
        let input = f.input();
        let merge = f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
        let changed_scope = if change_source { &f.child } else { &f.scope };
        let original = f.manager.coauthor_document(changed_scope).unwrap();
        let mut doc = original.clone();
        doc.content.push_str("暂改");
        let saved = f.manager.save_coauthor_document(changed_scope,doc).unwrap();
        let reverted = f.manager.save_coauthor_document(changed_scope,CoauthorDocument { version:saved.version,..original }).unwrap();
        assert!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).is_err());
        assert_eq!(f.manager.coauthor_document(changed_scope).unwrap(),reverted);
        assert_eq!(f.manager.get_coauthor_branch_merge(&f.scope,merge.id).unwrap().status,"PENDING");
    }
}

#[test]
fn invalid_ranges_types_unrelated_sessions_and_cross_project_targets_are_rejected() {
    let mut f = Fixture::new();
    for (start,end,target_start,target_end) in [(1,1,0,0),(0,999,0,0),(0,1,4,2),(0,1,0,999)] {
        let mut input = f.input();
        input.source_start=start;input.source_end=end;input.target_start=target_start;input.target_end=target_end;
        assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
    }
    let unrelated = f.manager.create_discussion_session("其他讨论".into(),DiscussionScopeKind::Project,None,None).unwrap();
    assert!(f.manager.compare_coauthor_branch(&f.scope,unrelated.id).is_err());
    assert!(f.manager.compare_coauthor_branch(&f.scope,f.scope.session_id).is_err());
    let mut input = f.input();
    input.source_session_id=unrelated.id;
    assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
    assert!(f.manager.list_coauthor_branches(&CoauthorScope { project_id:Uuid::new_v4(),..f.scope.clone() },0).is_err());
    let mut doc = f.manager.coauthor_document(&f.child).unwrap();
    doc.kind=CoauthorDocumentKind::Manuscript;
    f.manager.save_coauthor_document(&f.child,doc).unwrap();
    let input = f.input();
    assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
    assert!(f.manager.list_coauthor_branch_merges(&f.scope,0).unwrap().merges.is_empty());
}

#[test]
fn running_source_or_destination_blocks_prepare_and_apply_without_overwriting_outputs() {
    for source_active in [false,true] {
        let mut f = Fixture::new();
        let input = f.input();
        let merge = f.manager.prepare_coauthor_branch_merge(&f.scope,input.clone()).unwrap();
        let run_scope = if source_active { &f.child } else { &f.scope };
        let version = f.manager.coauthor_document(run_scope).unwrap().version;
        let run = f.manager.start_coauthor_run(run_scope,Uuid::new_v4(),"继续写",version).unwrap();
        assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
        assert!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).is_err());
        f.manager.finish_coauthor_run(run_scope,run.id,"COMPLETED","未改稿",&[]).unwrap();
        assert_eq!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap().status,"APPLIED");
    }
}

#[test]
fn late_revision_or_receipt_failures_roll_back_the_draft_history_and_merge_state() {
    for (table,event) in [("coauthor_document_revisions","INSERT"),("coauthor_branch_merges","UPDATE")] {
        let mut f = Fixture::new();
        let input = f.input();
        let merge = f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
        f.db().connection.execute_batch(&format!(
            "CREATE TRIGGER fail_merge BEFORE {event} ON {table} BEGIN SELECT RAISE(ABORT,'merge failure'); END;",
        )).unwrap();
        assert!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).is_err());
        assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),merge.before);
        assert_eq!(f.manager.coauthor_document_history(&f.scope,None).unwrap().len(),1);
        assert_eq!(f.manager.get_coauthor_branch_merge(&f.scope,merge.id).unwrap().status,"PENDING");
        f.db().connection.execute_batch("DROP TRIGGER fail_merge").unwrap();
        assert_eq!(f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap().status,"APPLIED");
    }
}

#[test]
fn scoped_receipts_survive_later_edits_without_reapplying_old_merges() {
    let mut f = Fixture::new();
    let input = f.input();
    let merge = f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
    assert!(f.manager.get_coauthor_branch_merge(&f.child,merge.id).is_err());
    assert!(f.manager.apply_coauthor_branch_merge(&f.child,merge.id).is_err());
    f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap();
    let mut doc = f.manager.coauthor_document(&f.scope).unwrap();
    doc.content.push_str("作者续写");
    let saved = f.manager.save_coauthor_document(&f.scope,doc).unwrap();
    f.manager.apply_coauthor_branch_merge(&f.scope,merge.id).unwrap();
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),saved);
    assert_eq!(f.manager.get_coauthor_branch_merge(&f.scope,merge.id).unwrap().after,merge.after);
}

#[test]
fn merge_history_is_lightweight_paged_and_does_not_decode_embedded_source_drafts() {
    let mut f = Fixture::new();
    for _ in 0..12 {
        let input = f.input();
        f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
    }
    f.db().connection.execute_batch(
        "UPDATE coauthor_branch_merges SET payload=json_set(payload,'$.source.content',123);",
    ).unwrap();
    let first = f.manager.list_coauthor_branch_merges(&f.scope,0).unwrap();
    let second = f.manager.list_coauthor_branch_merges(&f.scope,10).unwrap();
    assert_eq!((first.merges.len(),second.merges.len()),(10,2));
    assert!(first.has_more && !second.has_more);
    assert_eq!(first.merges[0].source_title,"失忆分支");
    assert!(f.manager.get_coauthor_branch_merge(&f.scope,first.merges[0].id).is_err());
    assert!(f.manager.list_coauthor_branch_merges(&f.child,0).unwrap().merges.is_empty());
}

#[test]
fn foreign_owned_direct_branches_are_hidden_and_empty_or_unchanged_merges_are_rejected() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.source_start=1;input.source_end=2;input.target_start=1;input.target_end=2;
    assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
    let input = f.input();
    f.db().connection.execute("UPDATE discussion_sessions SET project_id=?2 WHERE id=?1",
        rusqlite::params![f.child.session_id.to_string(),Uuid::new_v4().to_string()]).unwrap();
    assert!(f.manager.list_coauthor_branches(&f.scope,0).unwrap().branches.is_empty());
    assert!(f.manager.compare_coauthor_branch(&f.scope,f.child.session_id).is_err());
    assert!(f.manager.prepare_coauthor_branch_merge(&f.scope,input).is_err());
}

#[test]
fn actual_backup_restore_preserves_pending_comparisons_and_applied_merge_receipts() {
    let mut f = Fixture::new();
    let input = f.input();
    let first = f.manager.prepare_coauthor_branch_merge(&f.scope,input.clone()).unwrap();
    let pending = f.manager.prepare_coauthor_branch_merge(&f.scope,input).unwrap();
    f.manager.apply_coauthor_branch_merge(&f.scope,first.id).unwrap();
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    f.manager.enqueue_job(JobType::Backup,"{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status,JobStatus::Succeeded);
    let target = f.root.with_file_name(format!("coauthor-branch-restore-{}",Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()),&target).unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    assert_eq!(restored.get_coauthor_branch_merge(&f.scope,first.id).unwrap().status,"APPLIED");
    assert_eq!(restored.get_coauthor_branch_merge(&f.scope,pending.id).unwrap().status,"PENDING");
    assert!(restored.apply_coauthor_branch_merge(&f.scope,pending.id).is_err());
    assert_eq!(restored.compare_coauthor_branch(&f.scope,f.child.session_id).unwrap().base_document.content,"甲😀旧结尾，保留。");
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn migration_63_is_atomic_retryable_and_keeps_existing_working_drafts() {
    let f = Fixture::new();
    let original = f.manager.coauthor_document(&f.scope).unwrap();
    f.db().connection.execute_batch(
        "DROP TABLE coauthor_decision_consumers; DROP TABLE coauthor_changeset_dependency_coverage;
         DROP TABLE coauthor_branch_decision_adoptions; DROP TABLE coauthor_branch_merges; DELETE FROM schema_migrations WHERE version>=63;
         CREATE TRIGGER fail63 BEFORE INSERT ON schema_migrations WHEN NEW.version=63
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_branch_merges().is_err());
    assert_eq!(f.db().health().unwrap().schema_version,62);
    assert!(f.db().connection.is_autocommit());
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_branch_merges'",[],|row|row.get::<_,i64>(0),
    ).unwrap(),0);
    f.db().connection.execute_batch("DROP TRIGGER fail63").unwrap();
    f.db().migrate_coauthor_branch_merges().unwrap();
    f.db().migrate_coauthor_branch_decisions().unwrap();
    f.db().migrate_coauthor_decision_consumers().unwrap();
    f.db().connection.execute_batch("ALTER TABLE discussion_sessions DROP COLUMN deleted_at").unwrap();
    f.db().migrate_discussion_session_deletion().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version,CURRENT_SCHEMA_VERSION);
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),original);
}
