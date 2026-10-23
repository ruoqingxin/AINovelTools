use super::*;

impl Fixture {
    pub(super) fn many_anchors(&mut self, count: usize) -> Vec<Uuid> {
        let original = self.manager.list_evidence_anchors().unwrap().into_iter()
            .find(|anchor| anchor.id == self.facts[0].evidence_anchor_ids[0]).unwrap();
        let mut ids = vec![original.id];
        for _ in 1..count {
            let mut anchor = original.clone();
            anchor.id = Uuid::new_v4();
            self.manager.create_evidence_anchor(anchor.clone()).unwrap();
            ids.push(anchor.id);
        }
        self.db().connection.execute(
            "INSERT INTO facts SELECT knowledge_id,project_id,knowledge_version+1,subject,predicate,object,
                source_revision_id,?2,lifecycle_status,created_by,created_at,updated_at
             FROM facts WHERE knowledge_id=?1 AND knowledge_version=1",
            rusqlite::params![self.facts[0].knowledge_id.to_string(), encode(&ids).unwrap()],
        ).unwrap();
        self.db().connection.execute(
            "UPDATE fact_current_versions SET knowledge_version=2 WHERE knowledge_id=?1",
            [self.facts[0].knowledge_id.to_string()],
        ).unwrap();
        let mut relation = self.relation.clone();
        relation.relation_version = 2;
        relation.evidence_anchor_ids = ids.clone();
        self.manager.update_relation(relation, 1).unwrap();
        ids
    }
}

#[test]
fn all_fact_and_relation_anchors_are_pageable_without_promoting_directory_to_evidence() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(35);
    for source in [f.fact(), f.relation()] {
        let context = source.knowledge_context.as_ref().unwrap();
        assert_eq!(context.status, "CURRENT");
        assert_eq!(context.anchors.len(), 16);
        assert_eq!(context.total_anchors, 35);
        assert!(context.has_more_anchors);
        let mut collected = Vec::new();
        let mut offset = 0;
        while offset < ids.len() {
            let page = f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, offset).unwrap();
            assert_eq!(page.knowledge_key, source.key);
            assert_eq!(page.knowledge_revision, source.revision);
            assert_eq!(page.offset, offset);
            assert_eq!(page.total_anchors, ids.len());
            assert!(page.anchors.len() <= 16);
            offset = page.next_offset;
            collected.extend(page.anchors.into_iter().map(|anchor| anchor.id));
        }
        assert_eq!(collected, ids);
        let last = f.manager.read_coauthor_knowledge_evidence(
            &f.scope, &source.key, &source.revision, ids[34], 0, 3,
        ).unwrap();
        assert_eq!(last.content, "陆沉😀");
        assert_eq!(last.next_offset, 3);
        assert_eq!(last.total_chars, 8);
        let end = f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, 35).unwrap();
        assert!(end.anchors.is_empty());
        assert_eq!(end.next_offset, 35);
        assert!(f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, usize::MAX).is_err());
        assert!(f.db().connection.is_autocommit());
    }
}

#[test]
fn unseen_range_changes_invalidate_sources_relations_pages_evidence_and_adoption_dependencies() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(33);
    let old = f.fact();
    let relation = f.relation();
    // Simulate corrupt imported data without relaxing production immutability.
    f.db().connection.execute_batch("DROP TRIGGER prevent_evidence_anchor_identity_update").unwrap();
    f.db().connection.execute(
        "UPDATE evidence_anchors SET start_offset=2,end_offset=5 WHERE id=?1", [ids[32].to_string()],
    ).unwrap();
    let current = f.fact();
    assert_eq!(old.knowledge_context.as_ref().unwrap().anchors, current.knowledge_context.as_ref().unwrap().anchors);
    assert_eq!(current.knowledge_context.as_ref().unwrap().status, "CURRENT");
    assert_ne!(old.revision, current.revision);
    assert_ne!(relation.revision, f.relation().revision);
    assert!(f.manager.coauthor_knowledge_anchors(&f.scope, &old.key, &old.revision, 16).is_err());
    assert!(f.manager.read_coauthor_knowledge_evidence(&f.scope, &old.key, &old.revision, ids[0], 0, 1).is_err());
    assert!(f.db().validate_coauthor_dependencies(&[CoauthorSourceDependency {
        key: old.key, revision: old.revision,
    }]).is_err());
    let quote = f.manager.read_coauthor_knowledge_evidence(&f.scope, &current.key, &current.revision, ids[32], 0, 99).unwrap();
    assert_eq!(quote.content, "😀掌握");
}

#[test]
fn late_anchor_status_and_missing_or_foreign_ownership_affect_whole_record_without_leaking_metadata() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(17);
    let old = f.fact();
    f.db().connection.execute(
        "UPDATE evidence_anchors SET lifecycle_status='NEEDS_REVIEW' WHERE id=?1", [ids[16].to_string()],
    ).unwrap();
    let review = f.fact();
    assert_ne!(old.revision, review.revision);
    assert_eq!(review.knowledge_context.as_ref().unwrap().status, "NEEDS_REVIEW");
    let page = f.manager.coauthor_knowledge_anchors(&f.scope, &review.key, &review.revision, 16).unwrap();
    assert_eq!(page.anchors[0].status, "NEEDS_REVIEW");
    assert!(f.manager.read_coauthor_knowledge_evidence(&f.scope, &review.key, &review.revision, ids[16], 0, 100).is_err());
    f.db().connection.execute_batch("DROP TRIGGER prevent_evidence_anchor_identity_update").unwrap();
    f.db().connection.execute(
        "UPDATE evidence_anchors SET project_id=?2 WHERE id=?1",
        rusqlite::params![ids[16].to_string(), Uuid::new_v4().to_string()],
    ).unwrap();
    let foreign = f.fact();
    let page = f.manager.coauthor_knowledge_anchors(&f.scope, &foreign.key, &foreign.revision, 16).unwrap();
    assert_eq!(page.anchors[0].status, "MISSING");
    assert!(page.anchors[0].chapter_id.is_none());
    assert!(page.anchors[0].revision_id.is_none());
    assert!(page.anchors[0].block_id.is_none());
    assert!(f.manager.read_coauthor_knowledge_evidence(&f.scope, &foreign.key, &foreign.revision, ids[16], 0, 100).is_err());
}

#[test]
fn directory_reads_enforce_project_session_kind_and_exact_revision() {
    let f = Fixture::new();
    let source = f.fact();
    assert!(f.manager.coauthor_knowledge_anchors(
        &CoauthorScope { project_id: Uuid::new_v4(), ..f.scope.clone() }, &source.key, &source.revision, 0,
    ).is_err());
    assert!(f.manager.coauthor_knowledge_anchors(
        &CoauthorScope { session_id: Uuid::new_v4(), ..f.scope.clone() }, &source.key, &source.revision, 0,
    ).is_err());
    assert!(f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, "wrong", 0).is_err());
    let manuscript = f.source(&format!("MANUSCRIPT:{}", f.chapter));
    assert!(f.manager.coauthor_knowledge_anchors(&f.scope, &manuscript.key, &manuscript.revision, 0).is_err());
    assert!(f.db().connection.is_autocommit());
}

#[test]
fn directory_paging_never_parses_chapter_bodies_and_does_not_hide_evidence_validation_failures() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(18);
    let source = f.fact();
    f.db().connection.execute_batch("DROP TRIGGER prevent_manuscript_revision_update").unwrap();
    f.db().connection.execute(
        "UPDATE manuscript_revisions SET document_json='{}' WHERE id=?1", [f.revision.id.to_string()],
    ).unwrap();
    assert_eq!(source.revision, f.fact().revision);
    let page = f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, 16).unwrap();
    assert_eq!(page.anchors.len(), 2);
    assert_eq!(page.anchors[1].status, "CURRENT_REVISION");
    assert!(f.manager.read_coauthor_knowledge_evidence(&f.scope, &source.key, &source.revision, ids[17], 0, 100).is_err());
    assert!(f.db().connection.is_autocommit());
}

#[test]
fn empty_and_repeated_anchor_directories_are_faithful_to_the_native_version() {
    let mut f = Fixture::new();
    let original = f.facts[0].evidence_anchor_ids[0];
    let mut relation = f.relation.clone();
    relation.relation_version = 2;
    relation.evidence_anchor_ids = vec![original, original];
    f.manager.update_relation(relation.clone(), 1).unwrap();
    let source = f.relation();
    let page = f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, 0).unwrap();
    assert_eq!(page.anchors.len(), 2);
    // Legacy/corrupt empty evidence must remain readable as unverified metadata.
    f.db().connection.execute(
        "INSERT INTO relations SELECT id,project_id,3,from_knowledge_id,to_knowledge_id,relation_type,
            '[]',lifecycle_status,created_by,created_at,updated_at FROM relations WHERE id=?1 AND relation_version=2",
        [relation.id.to_string()],
    ).unwrap();
    let source = f.relation();
    assert_eq!(source.knowledge_context.as_ref().unwrap().status, "NEEDS_REVIEW");
    let page = f.manager.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, 0).unwrap();
    assert!(page.anchors.is_empty());
    assert_eq!(page.next_offset, 0);
    assert_eq!(page.total_anchors, 0);
}

#[test]
fn unseen_evidence_lifecycle_change_blocks_a_prepared_formal_adoption_based_on_a_later_page() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(33);
    let source = f.fact();
    let draft = f.manager.coauthor_document(&f.scope).unwrap();
    let draft = f.manager.save_coauthor_document(&f.scope, CoauthorDocument {
        content: "基于魂灯事实准备试写。".into(), ..draft
    }).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "核对采用", draft.version).unwrap();
    let result = f.manager.read_coauthor_knowledge_evidence(
        &f.scope, &source.key, &source.revision, ids[16], 0, 12000,
    ).unwrap();
    let audit = vec![serde_json::json!({"kind":"tool","name":"read_knowledge_evidence","result":result})];
    f.manager.checkpoint_coauthor_run(&f.scope, run.id, "已查看一条后续页证据", &audit).unwrap();
    let changes = f.manager.prepare_coauthor_changeset(&f.scope, CoauthorChangeRequest {
        title: "采用试写".into(), include_draft: true, expected_document_version: draft.version,
        draft_depends_on: vec![], items: vec![], impacts: vec![], coverage: "仅核验第17条证据".into(),
    }, Some(run.id)).unwrap();
    assert_eq!(changes.read_dependencies[0].key, source.key);
    f.manager.finish_coauthor_run(&f.scope, run.id, "COMPLETED", "等待作者确认", &audit).unwrap();
    f.db().connection.execute(
        "UPDATE evidence_anchors SET lifecycle_status='NEEDS_REVIEW' WHERE id=?1", [ids[32].to_string()],
    ).unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope, changes.id, changes.version, vec!["draft".into()]).is_err());
    assert_eq!(f.manager.list_plan_nodes().unwrap().len(), 1);
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(), draft);
    assert_eq!(f.manager.current_manuscript(f.chapter).unwrap().unwrap(), f.revision);
}

#[test]
fn version_61_requeues_old_derived_indexes_atomically_and_preserves_author_content() {
    let f = Fixture::new();
    f.db().connection.execute_batch(
        "DELETE FROM coauthor_source_queue; DELETE FROM schema_migrations WHERE version>=61;
         CREATE TRIGGER fail61 BEFORE INSERT ON schema_migrations WHEN NEW.version=61
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_knowledge_anchor_pages().is_err());
    assert!(f.db().connection.is_autocommit());
    assert_eq!(f.db().health().unwrap().schema_version, 60);
    assert_eq!(f.db().coauthor_pending_updates().unwrap(), 0);
    f.db().connection.execute_batch("DROP TRIGGER fail61").unwrap();
    f.db().migrate_coauthor_knowledge_anchor_pages().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version, 61);
    assert_eq!(f.db().coauthor_pending_updates().unwrap(), 3);
    assert_eq!(f.manager.current_manuscript(f.chapter).unwrap().unwrap(), f.revision);
    assert_eq!(f.manager.list_current_facts().unwrap().len(), 2);
}

#[test]
fn backup_reopen_restores_late_pages_and_unicode_evidence_without_a_separate_author_data_copy() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(33);
    let source = f.fact();
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    assert_eq!(source, f.fact());
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded);
    let target = f.root.with_file_name(format!("coauthor-anchor-pages-restore-{}", Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target).unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let page = restored.coauthor_knowledge_anchors(&f.scope, &source.key, &source.revision, 32).unwrap();
    assert_eq!(page.anchors[0].id, ids[32]);
    let quote = restored.read_coauthor_knowledge_evidence(&f.scope, &source.key, &source.revision, ids[32], 2, 3).unwrap();
    assert_eq!(quote.content, "😀掌握");
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
}
