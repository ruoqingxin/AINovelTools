use super::*;

impl Fixture {
    fn evidence_run(&mut self) -> Uuid {
        self.manager.start_coauthor_run(&self.scope, Uuid::new_v4(), "继续核对正文证据", 0).unwrap().id
    }

    fn evidence_progress(&self, source: &CoauthorSource) -> CoauthorEvidenceProgress {
        self.manager.coauthor_knowledge_evidence_progress(&self.scope,&source.key,&source.revision,0).unwrap()
    }

    fn tracked_evidence(&mut self, run: Uuid, source: &CoauthorSource, anchor: Uuid, offset: usize, limit: usize) -> CoauthorEvidenceRead {
        self.manager.read_coauthor_knowledge_evidence_for_run(
            &self.scope,run,&source.key,&source.revision,anchor,offset,limit,
        ).unwrap()
    }
}

#[test]
fn directory_author_reads_and_progress_queries_never_fabricate_model_reading_or_delivery() {
    let f = Fixture::new();
    let source = f.fact();
    let id = f.facts[0].evidence_anchor_ids[0];
    f.manager.coauthor_knowledge_anchors(&f.scope,&source.key,&source.revision,0).unwrap();
    f.manager.read_coauthor_knowledge_evidence(&f.scope,&source.key,&source.revision,id,0,99).unwrap();
    let progress = f.evidence_progress(&source);
    assert!(progress.id.is_none());
    assert_eq!((progress.total_anchors,progress.validated_anchors,progress.read_anchors,progress.sent_anchors),(1,0,0,0));
    assert!(!progress.all_evidence_sent);
    assert_eq!(progress.entries[0].total_chars,None);
    assert!(f.manager.list_coauthor_evidence_checks(&f.scope,0).unwrap().checks.is_empty());
    assert_eq!(f.db().connection.query_row("SELECT COUNT(*) FROM coauthor_evidence_reads",[],|row|row.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn unicode_overlaps_gaps_and_out_of_order_reads_resume_from_the_first_unsent_gap_across_runs() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    let tail = f.tracked_evidence(run,&source,anchor,3,99);
    assert_eq!(tail.evidence.content,"掌握魂灯。");
    let progress = f.evidence_progress(&source);
    assert_eq!((progress.validated_anchors,progress.read_anchors,progress.sent_anchors),(1,0,0));
    assert_eq!(progress.entries[0].read_chars,5);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[tail.read_id]).unwrap();
    assert_eq!(f.evidence_progress(&source).entries[0].next_offset,0);
    let prefix = f.tracked_evidence(run,&source,anchor,0,2);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[prefix.read_id]).unwrap();
    let progress = f.evidence_progress(&source);
    assert_eq!((progress.entries[0].sent_chars,progress.entries[0].next_offset),(7,2));
    f.manager.finish_coauthor_run(&f.scope,run,"COMPLETED","只剩一个字符缺口",&[]).unwrap();
    let run = f.evidence_run();
    let gap = f.tracked_evidence(run,&source,anchor,2,1);
    assert_eq!(gap.evidence.content,"😀");
    let progress = f.evidence_progress(&source);
    assert_eq!((progress.read_anchors,progress.sent_anchors),(1,0));
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[gap.read_id,gap.read_id]).unwrap();
    let duplicate = f.tracked_evidence(run,&source,anchor,1,5);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[duplicate.read_id]).unwrap();
    let progress = f.evidence_progress(&source);
    assert_eq!((progress.entries[0].read_chars,progress.entries[0].sent_chars,progress.entries[0].next_offset),(8,8,8));
    assert_eq!((progress.validated_anchors,progress.read_anchors,progress.sent_anchors),(1,1,1));
    assert!(progress.all_evidence_sent);
}

#[test]
fn failed_cancelled_or_interrupted_turns_keep_reading_but_never_confirm_delivery() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    for status in ["FAILED","CANCELLED","INTERRUPTED","LIMIT_REACHED"] {
        let run = f.evidence_run();
        let read = f.tracked_evidence(run,&source,anchor,0,99);
        if status=="INTERRUPTED" {
            f.manager.close();
            f.manager.open(&f.root).unwrap();
        } else {
            f.manager.finish_coauthor_run(&f.scope,run,status,"结果未获成功送达确认",&[]).unwrap();
        }
        assert!(f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).is_err());
    }
    let progress = f.evidence_progress(&source);
    assert_eq!((progress.validated_anchors,progress.read_anchors,progress.sent_anchors),(1,1,0));
    assert_eq!(progress.entries[0].next_offset,0);
    assert!(!progress.all_evidence_sent);
}

#[test]
fn read_validation_failures_and_empty_fragments_cannot_claim_complete_coverage() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    for (revision,id,offset) in [
        ("wrong",anchor,0),(source.revision.as_str(),f.facts[1].evidence_anchor_ids[0],0),
        (source.revision.as_str(),anchor,999),
    ] {
        assert!(f.manager.read_coauthor_knowledge_evidence_for_run(&f.scope,run,&source.key,revision,id,offset,5).is_err());
        assert!(f.db().connection.is_autocommit());
    }
    assert!(f.evidence_progress(&source).id.is_none());
    let empty = f.tracked_evidence(run,&source,anchor,8,20);
    assert!(empty.evidence.content.is_empty());
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[empty.read_id]).unwrap();
    let progress = f.evidence_progress(&source);
    assert_eq!(progress.validated_anchors,1);
    assert_eq!((progress.read_anchors,progress.sent_anchors,progress.entries[0].next_offset),(0,0,0));
}

#[test]
fn delivery_receipts_are_run_project_and_session_scoped_and_unknown_ids_roll_back_the_whole_batch() {
    let mut f = Fixture::new();
    let source = f.fact();
    let run = f.evidence_run();
    let read = f.tracked_evidence(run,&source,f.facts[0].evidence_anchor_ids[0],0,99);
    assert!(f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id,Uuid::new_v4()]).is_err());
    assert_eq!(f.evidence_progress(&source).sent_anchors,0);
    assert!(f.manager.acknowledge_coauthor_evidence_reads(
        &CoauthorScope { project_id:Uuid::new_v4(),..f.scope.clone() },run,&[read.read_id],
    ).is_err());
    let fork = f.manager.fork_coauthor_session(&f.scope,"独立复查".into()).unwrap();
    let other = CoauthorScope { session_id:fork.id,..f.scope.clone() };
    let other_run = f.manager.start_coauthor_run(&other,Uuid::new_v4(),"核对",1).unwrap();
    assert!(f.manager.acknowledge_coauthor_evidence_reads(&other,other_run.id,&[read.read_id]).is_err());
    assert!(f.manager.read_coauthor_knowledge_evidence_for_run(
        &other,run,&source.key,&source.revision,f.facts[0].evidence_anchor_ids[0],0,99,
    ).is_err());
    assert!(f.manager.coauthor_knowledge_evidence_progress(&other,&source.key,&source.revision,0).unwrap().id.is_none());
    assert!(f.manager.list_coauthor_evidence_checks(&other,0).unwrap().checks.is_empty());
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    assert!(f.evidence_progress(&source).all_evidence_sent);
    assert!(f.db().connection.is_autocommit());
}

#[test]
fn source_changes_keep_old_evidence_progress_as_history_and_do_not_reuse_it_for_the_new_revision() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    let read = f.tracked_evidence(run,&source,anchor,0,99);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    f.manager.save_manuscript(f.chapter,f.revision.document_json.clone(),"同文新修订".into()).unwrap();
    let old = f.evidence_progress(&source);
    assert!(old.stale && !old.all_evidence_sent);
    assert_eq!(old.sent_anchors,1);
    let current = f.fact();
    assert_ne!(current.revision,source.revision);
    let new = f.evidence_progress(&current);
    assert!(new.id.is_none() && !new.stale && new.needs_review);
    assert_eq!(new.sent_anchors,0);
    let historical = f.tracked_evidence(run,&current,anchor,0,99);
    assert!(!historical.evidence.is_current_revision);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[historical.read_id]).unwrap();
    let progress = f.evidence_progress(&current);
    assert_eq!(progress.sent_anchors,1);
    assert!(progress.needs_review && !progress.all_evidence_sent);
}

#[test]
fn all_anchor_progress_is_bounded_paged_and_unseen_anchor_changes_invalidate_the_record() {
    let mut f = Fixture::new();
    let ids = f.many_anchors(35);
    let source = f.fact();
    let run = f.evidence_run();
    let read = f.tracked_evidence(run,&source,ids[34],0,99);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    let mut collected = Vec::new();
    for offset in [0,16,32] {
        let page = f.manager.coauthor_knowledge_evidence_progress(&f.scope,&source.key,&source.revision,offset).unwrap();
        assert_eq!(page.total_anchors,35);
        assert_eq!((page.validated_anchors,page.read_anchors,page.sent_anchors),(1,1,1));
        assert!(!page.all_evidence_sent);
        assert_eq!(page.next_offset,if offset==32 {35}else{offset+16});
        collected.extend(page.entries.into_iter().map(|entry|entry.anchor.id));
    }
    assert_eq!(collected,ids);
    assert!(f.manager.coauthor_knowledge_evidence_progress(&f.scope,&source.key,&source.revision,usize::MAX).is_err());
    f.db().connection.execute(
        "UPDATE evidence_anchors SET lifecycle_status='NEEDS_REVIEW' WHERE id=?1", [ids[33].to_string()],
    ).unwrap();
    assert!(f.evidence_progress(&source).stale);
    assert!(f.manager.read_coauthor_knowledge_evidence_for_run(&f.scope,run,&source.key,&source.revision,ids[34],0,99).is_err());
}

#[test]
fn repeated_anchor_references_are_counted_once_and_records_do_not_borrow_each_others_receipts() {
    let mut f = Fixture::new();
    let fact = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    let read = f.tracked_evidence(run,&fact,anchor,0,99);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    let mut relation = f.relation.clone();
    relation.relation_version=2;
    relation.evidence_anchor_ids=vec![anchor,anchor];
    f.manager.update_relation(relation,1).unwrap();
    let relation = f.relation();
    let initial = f.evidence_progress(&relation);
    assert_eq!((initial.listed_anchors,initial.total_anchors,initial.sent_anchors),(2,1,0));
    let read = f.tracked_evidence(run,&relation,anchor,0,99);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    let progress = f.evidence_progress(&relation);
    assert_eq!((progress.listed_anchors,progress.total_anchors,progress.sent_anchors),(2,1,1));
    assert!(progress.all_evidence_sent);
}

#[test]
fn late_receipt_and_delivery_projection_failures_roll_back_without_advancing_progress() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_read_projection BEFORE UPDATE OF read_chars ON coauthor_evidence_entries
         BEGIN SELECT RAISE(ABORT,'late read projection failure'); END;",
    ).unwrap();
    assert!(f.manager.read_coauthor_knowledge_evidence_for_run(&f.scope,run,&source.key,&source.revision,anchor,0,99).is_err());
    assert!(f.evidence_progress(&source).id.is_none());
    assert_eq!(f.db().connection.query_row("SELECT COUNT(*) FROM coauthor_evidence_reads",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    f.db().connection.execute_batch("DROP TRIGGER fail_read_projection").unwrap();
    let read = f.tracked_evidence(run,&source,anchor,0,99);
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_sent_projection BEFORE UPDATE OF sent_chars ON coauthor_evidence_entries
         WHEN NEW.sent_chars>OLD.sent_chars BEGIN SELECT RAISE(ABORT,'late delivery projection failure'); END;",
    ).unwrap();
    assert!(f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).is_err());
    assert_eq!(f.evidence_progress(&source).sent_anchors,0);
    f.db().connection.execute_batch("DROP TRIGGER fail_sent_projection").unwrap();
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    assert!(f.evidence_progress(&source).all_evidence_sent);
}

#[test]
fn catalog_pages_restore_exact_version_identities_without_loading_chapter_bodies() {
    let mut f = Fixture::new();
    let run = f.evidence_run();
    for _ in 0..12 {
        let mut relation = f.relation.clone();
        relation.id=Uuid::new_v4();
        let relation = f.manager.create_relation(relation).unwrap();
        let source = f.source(&format!("RELATION:{}",relation.id));
        f.tracked_evidence(run,&source,relation.evidence_anchor_ids[0],0,3);
    }
    f.manager.search_coauthor_sources(&f.scope,"守护",false,0).unwrap();
    f.db().connection.execute_batch("DROP TRIGGER prevent_manuscript_revision_update").unwrap();
    f.db().connection.execute("UPDATE manuscript_revisions SET document_json='{}' WHERE id=?1",[f.revision.id.to_string()]).unwrap();
    let first = f.manager.list_coauthor_evidence_checks(&f.scope,0).unwrap();
    let next = f.manager.list_coauthor_evidence_checks(&f.scope,10).unwrap();
    assert_eq!((first.checks.len(),next.checks.len()),(10,2));
    assert!(first.has_more && !next.has_more);
    let mut keys = std::collections::BTreeSet::new();
    for summary in first.checks.into_iter().chain(next.checks) {
        assert!(keys.insert(summary.knowledge_key.clone()));
        let detail = f.manager.coauthor_knowledge_evidence_progress(&f.scope,&summary.knowledge_key,&summary.knowledge_revision,0).unwrap();
        assert_eq!(detail.entries[0].read_chars,3);
        assert_eq!(detail.sent_anchors,0);
    }
}

#[test]
fn backup_reopen_preserves_partial_receipts_and_a_new_run_continues_the_exact_gap() {
    let mut f = Fixture::new();
    let source = f.fact();
    let anchor = f.facts[0].evidence_anchor_ids[0];
    let run = f.evidence_run();
    let read = f.tracked_evidence(run,&source,anchor,0,3);
    f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).unwrap();
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    assert_eq!(f.evidence_progress(&source).entries[0].next_offset,3);
    assert!(f.manager.acknowledge_coauthor_evidence_reads(&f.scope,run,&[read.read_id]).is_err());
    f.manager.enqueue_job(JobType::Backup,"{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status,JobStatus::Succeeded);
    let target = f.root.with_file_name(format!("coauthor-evidence-progress-restore-{}",Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()),&target).unwrap();
    let mut restored=ProjectManager::new();
    restored.open(&target).unwrap();
    let progress=restored.coauthor_knowledge_evidence_progress(&f.scope,&source.key,&source.revision,0).unwrap();
    assert_eq!((progress.entries[0].read_chars,progress.entries[0].sent_chars,progress.entries[0].next_offset),(3,3,3));
    let run=restored.start_coauthor_run(&f.scope,Uuid::new_v4(),"继续剩余原文",0).unwrap();
    let read=restored.read_coauthor_knowledge_evidence_for_run(&f.scope,run.id,&source.key,&source.revision,anchor,3,99).unwrap();
    assert_eq!(read.evidence.content,"掌握魂灯。");
    restored.acknowledge_coauthor_evidence_reads(&f.scope,run.id,&[read.read_id]).unwrap();
    assert!(restored.coauthor_knowledge_evidence_progress(&f.scope,&source.key,&source.revision,0).unwrap().all_evidence_sent);
    drop(restored);
    let _=std::fs::remove_dir_all(target);
}

#[test]
fn migration_62_failure_is_atomic_retryable_and_never_backfills_unconfirmed_historical_audits() {
    let f=Fixture::new();
    f.db().connection.execute_batch("DROP TABLE coauthor_branch_merges; DELETE FROM schema_migrations WHERE version=63;").unwrap();
    f.db().drop_coauthor_evidence_progress_fixture();
    f.db().connection.execute_batch(
        "DELETE FROM schema_migrations WHERE version=62;
         CREATE TRIGGER fail62 BEFORE INSERT ON schema_migrations WHEN NEW.version=62
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_evidence_progress().is_err());
    assert_eq!(f.db().health().unwrap().schema_version,61);
    assert!(f.db().connection.is_autocommit());
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('coauthor_evidence_checks','coauthor_evidence_entries','coauthor_evidence_reads')",
        [],|row|row.get::<_,i64>(0),
    ).unwrap(),0);
    f.db().connection.execute_batch("DROP TRIGGER fail62").unwrap();
    f.db().migrate_coauthor_evidence_progress().unwrap();
    f.db().migrate_coauthor_branch_merges().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version,CURRENT_SCHEMA_VERSION);
    assert_eq!(f.manager.current_manuscript(f.chapter).unwrap().unwrap(),f.revision);
    assert!(f.evidence_progress(&f.fact()).id.is_none());
}
