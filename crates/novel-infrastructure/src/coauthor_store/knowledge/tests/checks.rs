use super::*;

fn input(kinds: &[&str]) -> CoauthorSourceCheckInput {
    CoauthorSourceCheckInput {
        title: "全部知识记录查证".into(), query: "突破代价与母亲记忆".into(),
        kinds: kinds.iter().map(|kind| (*kind).into()).collect(),
    }
}

fn read_and_assess(f: &mut Fixture, page: &CoauthorCheckPage, run: Uuid) -> CoauthorCheckPage {
    let mut result = page.clone();
    for entry in &page.entries {
        let read = f.manager.read_coauthor_check_source(
            &f.scope, run, page.check.id, &entry.key, 0, 12000,
        ).unwrap();
        f.manager.acknowledge_coauthor_check_reads(&f.scope, run, &[read.read_id]).unwrap();
        result = f.manager.assess_coauthor_check_source(&f.scope, run, CoauthorCheckAssessment {
            check_id: page.check.id, key: entry.key.clone(), revision: entry.revision.clone(),
            assessment: "IRRELEVANT".into(), reason: "逐项检查记录，未将记录当作正文证据。".into(), quote: String::new(),
        }).unwrap();
    }
    result
}

#[test]
fn knowledge_inventory_is_complete_paged_and_not_filtered_by_query_words() {
    let mut f = Fixture::new();
    for _ in 0..25 {
        let mut relation = f.relation.clone();
        relation.id = Uuid::new_v4();
        f.manager.create_relation(relation).unwrap();
    }
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION", "FACT"])).unwrap();
    assert_eq!(page.check.kinds, vec!["FACT", "RELATION"]);
    assert_eq!(page.check.total, 28);
    assert_eq!(page.check.needs_review, 0);
    assert_eq!(page.entries.len(), 20);
    assert!(page.has_more);
    assert!(page.entries.iter().all(|entry| entry.total_chars.is_none()
        && entry.knowledge_status.as_deref() == Some("CURRENT")));
    let last = f.manager.get_coauthor_source_check(&f.scope, page.check.id, 20).unwrap();
    assert_eq!(last.entries.len(), 8);
    assert!(!last.has_more);
    assert!(last.entries.iter().all(|entry| !page.entries.iter().any(|other| other.key == entry.key)));
}

#[test]
fn record_delivery_is_required_and_does_not_claim_evidence_was_read() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "查全部事实", 0).unwrap();
    let entry = &page.entries[0];
    let mut result = CoauthorCheckAssessment {
        check_id: page.check.id, key: entry.key.clone(), revision: entry.revision.clone(),
        assessment: "RELEVANT".into(), reason: "记录可能有关，原证据仍须另读。".into(), quote: "已审核事实".into(),
    };
    let partial = f.manager.read_coauthor_check_source(&f.scope, run.id, page.check.id, &entry.key, 0, 2).unwrap();
    assert!(partial.source.knowledge_context.is_some());
    f.manager.acknowledge_coauthor_check_reads(&f.scope, run.id, &[partial.read_id]).unwrap();
    assert!(f.manager.assess_coauthor_check_source(&f.scope, run.id, result.clone()).is_err());
    let read = f.manager.read_coauthor_check_source(&f.scope, run.id, page.check.id, &entry.key, 0, 12000).unwrap();
    assert!(f.manager.assess_coauthor_check_source(&f.scope, run.id, result.clone()).is_err());
    f.manager.acknowledge_coauthor_check_reads(&f.scope, run.id, &[read.read_id]).unwrap();
    result.quote = "陆沉😀掌握魂灯。".into();
    assert!(f.manager.assess_coauthor_check_source(&f.scope, run.id, result.clone()).is_err());
    result.quote = "已审核事实".into();
    let progress = f.manager.assess_coauthor_check_source(&f.scope, run.id, result).unwrap();
    assert_eq!(progress.check.reviewed, 1);
    assert!(!progress.check.complete);
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM coauthor_check_reads WHERE check_id=?1",
        [page.check.id.to_string()], |row| row.get::<_, i64>(0),
    ).unwrap(), 2);
}

#[test]
fn same_text_new_manuscript_invalidates_fact_and_endpoint_relation_checks_immediately() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "查全部知识记录", 0).unwrap();
    assert!(read_and_assess(&mut f, &page, run.id).check.complete);
    f.manager.save_manuscript(f.chapter, f.revision.document_json.clone(), "同文新修订".into()).unwrap();
    let dirty = f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap();
    assert_eq!(dirty.check.stale, 3);
    assert_eq!(dirty.check.reviewed, 0);
    assert!(!dirty.check.complete);
    assert!(dirty.entries.iter().all(|entry| entry.assessment.is_some()));
    f.manager.search_coauthor_sources(&f.scope, "陆沉", false, 0).unwrap();
    assert_eq!(f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap().check.stale, 3);
    let new = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(new.check.needs_review, 3);
    let assessed = read_and_assess(&mut f, &new, run.id);
    assert_eq!(assessed.check.reviewed, 3);
    assert_eq!(assessed.check.sent, 3);
    assert!(!assessed.check.complete);
    assert!(assessed.entries.iter().all(|entry| entry.knowledge_status.as_deref() == Some("NEEDS_REVIEW")));
}

#[test]
fn evidence_archive_propagates_to_endpoint_relations_without_invalidating_unrelated_fact() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "核对记录", 0).unwrap();
    assert!(read_and_assess(&mut f, &page, run.id).check.complete);
    for _ in 0..2 {
        f.db().connection.execute(
            "UPDATE evidence_anchors SET lifecycle_status='ARCHIVED' WHERE id=?1",
            [f.facts[0].evidence_anchor_ids[0].to_string()],
        ).unwrap();
    }
    let dirty = f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap();
    assert_eq!(dirty.check.stale, 2);
    assert_eq!(dirty.check.reviewed, 1);
    let notes = f.manager.get_coauthor_check_notes(&f.scope, page.check.id, &f.fact().key, 0).unwrap();
    assert!(notes.stale);
    f.manager.search_coauthor_sources(&f.scope, "苏瑶", false, 0).unwrap();
    let current = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(current.check.needs_review, 2);
    assert_eq!(f.relation().knowledge_context.unwrap().status, "NEEDS_REVIEW");
    assert_eq!(f.source(&format!("FACT:{}", f.facts[1].knowledge_id)).knowledge_context.unwrap().status, "CURRENT");
}

#[test]
fn foreign_records_and_unreviewed_candidates_never_enter_project_inventory() {
    let mut f = Fixture::new();
    let other = Uuid::new_v4();
    let foreign_fact = Uuid::new_v4();
    f.db().connection.execute(
        "INSERT INTO facts SELECT ?1,?2,knowledge_version,subject,predicate,object,source_revision_id,
            evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM facts WHERE knowledge_id=?3",
        rusqlite::params![foreign_fact.to_string(),other.to_string(),f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    f.db().connection.execute(
        "INSERT INTO fact_current_versions VALUES(?1,1)", [foreign_fact.to_string()],
    ).unwrap();
    let mut relation = f.relation.clone();
    relation.id = Uuid::new_v4();
    relation.project_id = other;
    // Native project validation is bypassed only to simulate an inconsistent imported database.
    f.db().connection.execute(
        "INSERT INTO relations SELECT ?1,?2,relation_version,from_knowledge_id,to_knowledge_id,relation_type,
            evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM relations WHERE id=?3",
        rusqlite::params![relation.id.to_string(),other.to_string(),f.relation.id.to_string()],
    ).unwrap();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(page.check.total, 3);
    assert_eq!(page.check.added, 0);
    assert!(!page.entries.iter().any(|entry| entry.key.ends_with(&foreign_fact.to_string())
        || entry.key.ends_with(&relation.id.to_string())));
    let wrong = CoauthorScope { project_id: other, ..f.scope.clone() };
    assert!(f.manager.get_coauthor_source_check(&wrong, page.check.id, 0).is_err());
    f.db().connection.execute(
        "INSERT INTO facts SELECT knowledge_id,?1,knowledge_version+1,subject,predicate,object,source_revision_id,
            evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM facts WHERE knowledge_id=?2 AND knowledge_version=1",
        rusqlite::params![other.to_string(),f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    f.db().connection.execute(
        "UPDATE fact_current_versions SET knowledge_version=2 WHERE knowledge_id=?1",
        [f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    let isolated = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(isolated.check.total, 2);
    assert_eq!(isolated.check.added, 0);
    assert!(!isolated.entries.iter().any(|entry| entry.key == format!("FACT:{}", f.facts[0].knowledge_id)));
}

#[test]
fn chapter_archive_and_relation_archive_preserve_old_inventory_and_do_not_restore_old_versions() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    f.db().connection.execute(
        "UPDATE plan_nodes SET archived=1,revision=revision+1 WHERE id=?1", [f.chapter.to_string()],
    ).unwrap();
    assert_eq!(f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap().check.stale, 3);
    let mut relation = f.relation.clone();
    relation.relation_version += 1;
    relation.lifecycle_status = KnowledgeLifecycleStatus::Archived;
    f.manager.update_relation(relation, 1).unwrap();
    f.manager.search_coauthor_sources(&f.scope, "魂灯", false, 0).unwrap();
    let current = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(current.check.total, 2);
    assert_eq!(current.check.needs_review, 2);
    let old = f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap();
    assert_eq!(old.check.total, 3);
    assert_eq!(old.check.stale, 3);
}

#[test]
fn migration_failure_rolls_back_dependency_projection_and_retries_without_touching_author_records() {
    let f = Fixture::new();
    f.db().drop_coauthor_knowledge_checks_fixture();
    f.db().connection.execute_batch(
        "DELETE FROM schema_migrations WHERE version>=60;
         CREATE TRIGGER fail60 BEFORE INSERT ON schema_migrations WHEN NEW.version=60
         BEGIN SELECT RAISE(ABORT,'late migration fault'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_knowledge_checks().is_err());
    assert_eq!(f.db().health().unwrap().schema_version, 59);
    assert!(f.db().connection.is_autocommit());
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('coauthor_knowledge_anchor_refs','coauthor_knowledge_index_status')
            OR (type='trigger' AND name LIKE 'coauthor_knowledge_%')",
        [], |row| row.get::<_, i64>(0),
    ).unwrap(), 0);
    f.db().connection.execute_batch("DROP TRIGGER fail60").unwrap();
    f.db().migrate_coauthor_knowledge_checks().unwrap();
    f.db().migrate_coauthor_knowledge_anchor_pages().unwrap();
    f.db().migrate_coauthor_evidence_progress().unwrap();
    f.db().migrate_coauthor_branch_merges().unwrap();
    f.db().migrate_coauthor_branch_decisions().unwrap();
    f.db().migrate_coauthor_decision_consumers().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(f.manager.current_manuscript(f.chapter).unwrap().unwrap().document_json, f.revision.document_json);
    assert_eq!(f.manager.list_current_facts().unwrap().len(), 2);
}

#[test]
fn backup_reopen_preserves_partial_knowledge_checks_notes_and_dependency_invalidation() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "分段核对", 0).unwrap();
    let fact = f.fact();
    let read = f.manager.read_coauthor_check_source(&f.scope, run.id, page.check.id, &fact.key, 0, 5).unwrap();
    f.manager.acknowledge_coauthor_check_reads(&f.scope, run.id, &[read.read_id]).unwrap();
    f.manager.save_coauthor_check_note(&f.scope, run.id, CoauthorCheckNoteInput {
        check_id: page.check.id, key: fact.key.clone(), revision: fact.revision.clone(), start: 0, end: 5,
        expected_version: 0, analysis: "此处是记录标识，不是正文引句。".into(), questions: "尚须读取正文证据。".into(),
        quote: read.source.content,
    }).unwrap();
    f.manager.finish_coauthor_run(&f.scope, run.id, "COMPLETED", "阶段记录", &[]).unwrap();
    let fork = f.manager.fork_coauthor_session(&f.scope, "另一分支".into()).unwrap();
    assert!(f.manager.list_coauthor_source_checks(&CoauthorScope {
        session_id: fork.id, ..f.scope.clone()
    }, 0).unwrap().checks.is_empty());
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded);
    let target = f.root.with_file_name(format!("knowledge-check-restore-{}", Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target).unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let progress = restored.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap();
    assert_eq!(progress.entries.iter().find(|entry| entry.key == fact.key).unwrap().next_offset, 5);
    assert_eq!(restored.get_coauthor_check_notes(&f.scope, page.check.id, &fact.key, 0).unwrap().total_notes, 1);
    let new_run = restored.start_coauthor_run(&f.scope, Uuid::new_v4(), "继续", 0).unwrap();
    let next = restored.read_coauthor_check_source(&f.scope, new_run.id, page.check.id, &fact.key, 5, 12000).unwrap();
    assert_eq!(next.source.offset, 5);
    restored.save_manuscript(f.chapter, f.revision.document_json.clone(), "后续修订".into()).unwrap();
    assert_eq!(restored.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap().check.stale, 3);
    assert!(restored.get_coauthor_check_notes(&f.scope, page.check.id, &fact.key, 0).unwrap().stale);
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn queued_dependency_failure_rolls_back_the_original_edit_and_check_coverage() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "核对记录", 0).unwrap();
    assert!(read_and_assess(&mut f, &page, run.id).check.complete);
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_dependency_queue BEFORE INSERT ON coauthor_source_queue
         WHEN NEW.kind='RELATION' BEGIN SELECT RAISE(ABORT,'queue fault'); END;",
    ).unwrap();
    assert!(f.manager.save_manuscript(f.chapter, f.revision.document_json.clone(), "后续修订".into()).is_err());
    assert_eq!(f.manager.current_manuscript(f.chapter).unwrap().unwrap().id, f.revision.id);
    assert!(f.db().connection.execute(
        "UPDATE evidence_anchors SET lifecycle_status='ARCHIVED' WHERE id=?1",
        [f.facts[0].evidence_anchor_ids[0].to_string()],
    ).is_err());
    assert_eq!(f.fact().knowledge_context.unwrap().status, "CURRENT");
    assert!(f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap().check.complete);
}

#[test]
fn fact_pointer_changes_invalidate_old_record_and_relation_without_reviving_the_old_verdict() {
    let mut f = Fixture::new();
    let page = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    let run = f.manager.start_coauthor_run(&f.scope, Uuid::new_v4(), "查全部记录", 0).unwrap();
    assert!(read_and_assess(&mut f, &page, run.id).check.complete);
    f.db().connection.execute(
        "INSERT INTO facts SELECT knowledge_id,project_id,knowledge_version+1,'陆沉新称',predicate,object,
            source_revision_id,evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM facts WHERE knowledge_id=?1 AND knowledge_version=1",
        [f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    f.db().connection.execute(
        "UPDATE fact_current_versions SET knowledge_version=2 WHERE knowledge_id=?1",
        [f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    let dirty = f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap();
    assert_eq!(dirty.check.stale, 2);
    assert_eq!(dirty.check.reviewed, 1);
    f.manager.search_coauthor_sources(&f.scope, "陆沉新称", false, 0).unwrap();
    assert_eq!(f.manager.get_coauthor_source_check(&f.scope, page.check.id, 0).unwrap().check.stale, 2);
    let fresh = f.manager.create_coauthor_source_check(&f.scope, input(&["FACT", "RELATION"])).unwrap();
    assert_eq!(fresh.check.total, 3);
    assert_eq!(fresh.check.reviewed, 0);
    assert_eq!(fresh.check.needs_review, 0);
    assert!(fresh.entries.iter().any(|entry| entry.title.contains("陆沉新称")));
    f.db().connection.execute(
        "UPDATE evidence_anchors SET lifecycle_status='NEEDS_REVIEW' WHERE id=?1",
        [f.facts[0].evidence_anchor_ids[0].to_string()],
    ).unwrap();
    let context = f.fact().knowledge_context.unwrap();
    assert_eq!(context.status, "NEEDS_REVIEW");
    assert_eq!(context.anchors[0].status, "NEEDS_REVIEW");
    assert_eq!(f.manager.get_coauthor_source_check(&f.scope, fresh.check.id, 0).unwrap().check.stale, 2);
}
