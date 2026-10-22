use super::*;
use crate::coauthor_store::tests::{entity, project};
use serde_json::json;

pub(super) fn input(kinds: &[&str]) -> CoauthorSourceCheckInput {
    CoauthorSourceCheckInput {
        title: "查全部突破影响".into(),
        query: "突破代价与母亲记忆".into(),
        kinds: kinds.iter().map(|kind| (*kind).into()).collect(),
    }
}

pub(super) fn chapter(manager: &mut ProjectManager, text: &str) -> String {
    let node = manager
        .create_plan_node(None, PlanNodeKind::Chapter, "旧章".into())
        .unwrap();
    manager
        .save_manuscript(
            node.id,
            json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":text}]}]})
            .to_string(),
            "原稿".into(),
        )
        .unwrap();
    format!("MANUSCRIPT:{}", node.id)
}

fn assessment(page: &CoauthorCheckPage, key: &str, value: &str) -> CoauthorCheckAssessment {
    let entry = page.entries.iter().find(|entry| entry.key == key).unwrap();
    CoauthorCheckAssessment {
        check_id: page.check.id,
        key: key.into(),
        revision: entry.revision.clone(),
        assessment: value.into(),
        reason: "逐项核对突破代价".into(),
        quote: String::new(),
    }
}

#[test]
fn inventory_is_explicit_not_keyword_filtered_and_pages_without_loading_text() {
    let (mut manager, root, scope) = project();
    for i in 0..23 {
        entity(&mut manager, &format!("无关资料{i}"), "没有任何查询词");
    }
    chapter(&mut manager, "无关正文");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["ENTITY", "ENTITY"]))
        .unwrap();
    assert_eq!(page.check.kinds, vec!["ENTITY"]);
    assert_eq!(page.check.total, 23);
    assert_eq!(page.entries.len(), 20);
    assert!(page.has_more);
    assert!(!page.check.complete);
    assert!(
        page.entries
            .iter()
            .all(|entry| entry.total_chars.is_none() && entry.assessment.is_none())
    );
    let next = manager
        .get_coauthor_source_check(&scope, page.check.id, 20)
        .unwrap();
    assert_eq!(next.entries.len(), 3);
    assert!(!next.has_more);
    let empty = manager
        .create_coauthor_source_check(&scope, input(&["PLAN"]))
        .unwrap();
    assert_eq!(empty.check.total, 0);
    assert!(!empty.check.complete);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unicode_gaps_overlap_unsent_reads_and_partial_results_cannot_claim_complete() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "甲😀乙丙丁");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .is_err()
    );
    let a = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 2)
        .unwrap();
    assert_eq!(a.source.content, "甲😀");
    let b = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 3, 2)
        .unwrap();
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert_eq!(current.entries[0].read_chars, 4);
    assert_eq!(current.check.sent, 0);
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[a.read_id, b.read_id])
        .unwrap();
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert_eq!(current.entries[0].sent_chars, 4);
    assert_eq!(current.entries[0].next_offset, 2);
    assert_eq!(current.check.sent, 0);
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .is_err()
    );
    let overlap = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 1, 3)
        .unwrap();
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert_eq!(current.entries[0].read_chars, 5);
    assert_eq!(current.check.read, 1);
    assert_eq!(current.check.sent, 0);
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[overlap.read_id])
        .unwrap();
    let mut result = assessment(&page, &key, "RELEVANT");
    result.quote = "虚构引文".into();
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, result)
            .is_err()
    );
    let mut result = assessment(&page, &key, "RELEVANT");
    result.quote = "😀乙".into();
    let final_page = manager
        .assess_coauthor_check_source(&scope, run.id, result)
        .unwrap();
    assert!(final_page.check.complete);
    assert_eq!(final_page.check.relevant, 1);
    assert_eq!(final_page.entries[0].sent_chars, 5);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn empty_source_must_be_read_and_delivered_and_uncertain_is_not_complete() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    let read = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 10)
        .unwrap();
    assert!(
        !manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .entries[0]
            .sent_complete
    );
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .is_err()
    );
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
        .unwrap();
    let uncertain = manager
        .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "UNCERTAIN"))
        .unwrap();
    assert_eq!(uncertain.check.uncertain, 1);
    assert!(!uncertain.check.complete);
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .unwrap()
            .check
            .complete
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn changed_added_archived_and_same_text_new_versions_invalidate_coverage() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "突破会失忆");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    let read = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 100)
        .unwrap();
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
        .unwrap();
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .unwrap()
            .check
            .complete
    );
    let new_key = chapter(&mut manager, "新增后章");
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert!(current.check.pending_index_updates > 0);
    assert!(!current.check.complete);
    manager
        .search_coauthor_sources(&scope, "新增", false, 0)
        .unwrap();
    assert_eq!(
        manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .check
            .added,
        1
    );
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute(
            "UPDATE plan_nodes SET archived=1,revision=revision+1 WHERE id=?1",
            [new_key.strip_prefix("MANUSCRIPT:").unwrap()],
        )
        .unwrap();
    manager
        .search_coauthor_sources(&scope, "新增", false, 0)
        .unwrap();
    assert!(
        manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .check
            .complete
    );
    let id = key.strip_prefix("MANUSCRIPT:").unwrap().parse().unwrap();
    manager
        .save_manuscript(
            id,
            json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"突破会失忆"}]}]})
            .to_string(),
            "同文新版本".into(),
        )
        .unwrap();
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert_eq!(current.check.stale, 1);
    assert_eq!(current.check.reviewed, 0);
    assert!(current.entries[0].assessment.is_some());
    assert!(!current.check.complete);
    assert!(
        manager
            .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 100)
            .is_err()
    );
    assert!(
        manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .entries[0]
            .last_error
            .is_some()
    );
    manager
        .search_coauthor_sources(&scope, "突破", false, 0)
        .unwrap();
    assert_eq!(
        manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .check
            .stale,
        1
    );
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn cancelled_cross_session_wrong_project_and_unrecorded_delivery_are_rejected() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "原文");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    let read = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 100)
        .unwrap();
    let other = manager
        .create_discussion_session("其他讨论".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let other = CoauthorScope {
        session_id: other.id,
        ..scope.clone()
    };
    assert!(
        manager
            .get_coauthor_source_check(&other, page.check.id, 0)
            .is_err()
    );
    let other_run = manager
        .start_coauthor_run(&other, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    assert!(
        manager
            .read_coauthor_check_source(&other, other_run.id, page.check.id, &key, 0, 100)
            .is_err()
    );
    assert!(
        manager
            .acknowledge_coauthor_check_reads(&other, other_run.id, &[read.read_id])
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(manager.list_coauthor_source_checks(&wrong, 0).is_err());
    assert!(
        manager
            .create_coauthor_source_check(&scope, input(&["MESSAGE"]))
            .is_err()
    );
    assert!(
        manager
            .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id, Uuid::new_v4()])
            .is_err()
    );
    assert_eq!(
        manager
            .get_coauthor_source_check(&scope, page.check.id, 0)
            .unwrap()
            .check
            .sent,
        0
    );
    manager.cancel_coauthor_run(&scope, run.id).unwrap();
    assert!(
        manager
            .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
            .is_err()
    );
    assert!(
        manager
            .assess_coauthor_check_source(&scope, run.id, assessment(&page, &key, "IRRELEVANT"))
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn incomplete_index_never_creates_a_partial_inventory_and_can_continue_bounded_updates() {
    let (mut manager, root, scope) = project();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute_batch(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001)
         INSERT INTO coauthor_source_queue SELECT 'ENTITY','missing-' || x FROM n;",
        )
        .unwrap();
    assert!(
        manager
            .create_coauthor_source_check(&scope, input(&["ENTITY"]))
            .is_err()
    );
    assert!(
        manager
            .list_coauthor_source_checks(&scope, 0)
            .unwrap()
            .checks
            .is_empty()
    );
    assert_eq!(
        manager
            .create_coauthor_source_check(&scope, input(&["ENTITY"]))
            .unwrap()
            .check
            .total,
        0
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn inventory_persistence_backup_resume_and_branch_isolation_preserve_evidence() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "甲😀乙丙");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    let read = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 2)
        .unwrap();
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "阶段结果", &[])
        .unwrap();
    let fork = manager
        .fork_coauthor_session(&scope, "另一分支".into())
        .unwrap();
    assert!(
        manager
            .list_coauthor_source_checks(
                &CoauthorScope {
                    session_id: fork.id,
                    ..scope.clone()
                },
                0
            )
            .unwrap()
            .checks
            .is_empty()
    );
    manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let restored_root = root.with_file_name(format!("coauthor-check-restore-{}", Uuid::new_v4()));
    manager
        .restore_backup_to_new_project(
            root.join("snapshots").join(job.id.to_string()),
            &restored_root,
        )
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&restored_root).unwrap();
    let resumed = restored
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert_eq!(resumed.entries[0].sent_chars, 2);
    assert_eq!(resumed.entries[0].next_offset, 2);
    let next_run = restored
        .start_coauthor_run(&scope, Uuid::new_v4(), "继续查证", 0)
        .unwrap();
    let next = restored
        .read_coauthor_check_source(&scope, next_run.id, page.check.id, &key, 2, 100)
        .unwrap();
    restored
        .acknowledge_coauthor_check_reads(&scope, next_run.id, &[next.read_id])
        .unwrap();
    assert!(
        restored
            .assess_coauthor_check_source(
                &scope,
                next_run.id,
                assessment(&page, &key, "IRRELEVANT")
            )
            .unwrap()
            .check
            .complete
    );
    drop(restored);
    drop(manager);
    let _ = std::fs::remove_dir_all(restored_root);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_and_manifest_creation_failures_roll_back_without_touching_author_text() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "作者原稿");
    let db = &manager.current.as_ref().unwrap().database;
    db.connection.execute_batch(
        "DROP TABLE coauthor_decision_fts; DROP TABLE coauthor_decision_mentions; DROP TABLE coauthor_decision_evidence; DROP TABLE coauthor_decision_aliases;
         DROP TABLE coauthor_check_notes; DROP TABLE coauthor_check_reads; DROP TABLE coauthor_check_entries; DROP TABLE coauthor_source_checks;
         DELETE FROM schema_migrations WHERE version>=55;
         CREATE TRIGGER fail55 BEFORE INSERT ON schema_migrations WHEN NEW.version=55
         BEGIN SELECT RAISE(ABORT,'migration failure'); END;"
    ).unwrap();
    assert!(db.migrate_coauthor_source_checks().is_err());
    assert_eq!(db.health().unwrap().schema_version, 54);
    assert!(db.connection.is_autocommit());
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_source_checks'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.connection.execute_batch("DROP TRIGGER fail55").unwrap();
    db.migrate_coauthor_source_checks().unwrap();
    db.migrate_coauthor_check_notes().unwrap();
    db.migrate_coauthor_decision_memory().unwrap();
    db.connection.execute_batch(
        "CREATE TRIGGER fail_check_entry BEFORE INSERT ON coauthor_check_entries BEGIN SELECT RAISE(ABORT,'entry failure'); END;"
    ).unwrap();
    assert!(
        manager
            .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
            .is_err()
    );
    assert!(
        manager
            .list_coauthor_source_checks(&scope, 0)
            .unwrap()
            .checks
            .is_empty()
    );
    let db = &manager.current.as_ref().unwrap().database;
    assert_eq!(
        db.coauthor_source(&key).unwrap().unwrap().content,
        "作者原稿"
    );
    db.connection
        .execute_batch("DROP TRIGGER fail_check_entry")
        .unwrap();
    manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    assert_eq!(db_health(&manager), CURRENT_SCHEMA_VERSION);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

fn db_health(manager: &ProjectManager) -> i64 {
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .health()
        .unwrap()
        .schema_version
}

#[test]
fn read_and_delivery_failures_roll_back_progress_and_check_reads_remain_versioned_dependencies() {
    let (mut manager, root, scope) = project();
    let key = chapter(&mut manager, "甲😀乙");
    let page = manager
        .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "查全部", 0)
        .unwrap();
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_progress BEFORE UPDATE OF read_chars ON coauthor_check_entries
         BEGIN SELECT RAISE(ABORT,'progress failure'); END;",
        )
        .unwrap();
    assert!(
        manager
            .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 100)
            .is_err()
    );
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert!(current.entries[0].total_chars.is_none());
    assert_eq!(current.entries[0].read_chars, 0);
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch(
            "DROP TRIGGER fail_progress;
         CREATE TRIGGER fail_delivery BEFORE UPDATE OF sent_complete ON coauthor_check_entries
         WHEN NEW.sent_complete=1 BEGIN SELECT RAISE(ABORT,'delivery failure'); END;",
        )
        .unwrap();
    let read = manager
        .read_coauthor_check_source(&scope, run.id, page.check.id, &key, 0, 100)
        .unwrap();
    assert!(
        manager
            .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
            .is_err()
    );
    let current = manager
        .get_coauthor_source_check(&scope, page.check.id, 0)
        .unwrap();
    assert!(!current.entries[0].sent_complete);
    assert_eq!(current.entries[0].sent_chars, 0);
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TRIGGER fail_delivery")
        .unwrap();
    manager
        .acknowledge_coauthor_check_reads(&scope, run.id, &[read.read_id])
        .unwrap();
    let audit = vec![json!({"kind":"tool","name":"read_check_source","result":read})];
    assert_eq!(audit[0]["result"]["key"], key);
    manager
        .checkpoint_coauthor_run(&scope, run.id, "", &audit)
        .unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    let dependencies = db.coauthor_read_dependencies(run.id).unwrap();
    assert_eq!(dependencies.len(), 1);
    assert_eq!(dependencies[0].key, key);
    assert!(db.validate_coauthor_dependencies(&dependencies).is_ok());
    db.connection
        .execute(
            "UPDATE plan_nodes SET archived=1,revision=revision+1 WHERE id=?1",
            [key.strip_prefix("MANUSCRIPT:").unwrap()],
        )
        .unwrap();
    assert!(db.validate_coauthor_dependencies(&dependencies).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn check_lists_are_paged_and_source_content_is_not_part_of_progress_queries() {
    let (mut manager, root, scope) = project();
    chapter(&mut manager, "原稿保持不变");
    for _ in 0..11 {
        manager
            .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
            .unwrap();
    }
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute(
            "UPDATE coauthor_sources SET content=?1",
            ["不会读进查证进度的索引原文".repeat(10000)],
        )
        .unwrap();
    let first = manager.list_coauthor_source_checks(&scope, 0).unwrap();
    assert_eq!(first.checks.len(), 10);
    assert!(first.has_more);
    let second = manager.list_coauthor_source_checks(&scope, 10).unwrap();
    assert_eq!(second.checks.len(), 1);
    assert!(!second.has_more);
    assert!(
        !first
            .checks
            .iter()
            .any(|check| check.id == second.checks[0].id)
    );
    assert_eq!(
        manager
            .get_coauthor_source_check(&scope, second.checks[0].id, 0)
            .unwrap()
            .entries
            .len(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}
