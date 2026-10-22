use super::*;
use crate::coauthor_store::tests::project;

fn finished(manager: &mut ProjectManager, scope: &CoauthorScope, n: usize) -> CoauthorRun {
    let version = manager.coauthor_document(scope).unwrap().version;
    let run = manager
        .start_coauthor_run(scope, Uuid::new_v4(), &format!("讨论第{n}轮"), version)
        .unwrap();
    manager
        .finish_coauthor_run(
            scope,
            run.id,
            "COMPLETED",
            &format!("保留回复{n}"),
            &[serde_json::json!({"kind":"error","message":format!("历史依据{n}")})],
        )
        .unwrap();
    run
}

#[test]
fn cursor_pages_preserve_order_without_duplicates_when_new_runs_arrive() {
    let (mut manager, root, scope) = project();
    let ids = (0..47)
        .map(|n| finished(&mut manager, &scope, n).id)
        .collect::<Vec<_>>();
    let first = manager.list_coauthor_runs(&scope, None).unwrap();
    assert_eq!(first.runs.len(), 20);
    assert!(first.has_more);
    assert_eq!(first.runs[0].id, ids[46]);
    let newest = finished(&mut manager, &scope, 48);
    let second = manager
        .list_coauthor_runs(&scope, first.runs.last().map(|run| run.id))
        .unwrap();
    let third = manager
        .list_coauthor_runs(&scope, second.runs.last().map(|run| run.id))
        .unwrap();
    assert_eq!(second.runs.len(), 20);
    assert!(second.has_more);
    assert_eq!(third.runs.len(), 7);
    assert!(!third.has_more);
    let actual = first
        .runs
        .iter()
        .chain(&second.runs)
        .chain(&third.runs)
        .map(|run| run.id)
        .collect::<Vec<_>>();
    assert_eq!(actual, ids.into_iter().rev().collect::<Vec<_>>());
    assert_eq!(
        manager.list_coauthor_runs(&scope, None).unwrap().runs[0].id,
        newest.id
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn state_and_directory_do_not_decode_or_serialize_historical_output_and_audits() {
    let (mut manager, root, scope) = project();
    let run = finished(&mut manager, &scope, 1);
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute(
            "UPDATE coauthor_runs SET output=?2,audit='{}' WHERE id=?1",
            rusqlite::params![run.id.to_string(), "长原文".repeat(100_000)],
        )
        .unwrap();
    let state = manager.coauthor_state(&scope).unwrap();
    assert_eq!(state.runs.len(), 1);
    let json = serde_json::to_string(&state.runs).unwrap();
    assert!(!json.contains("output"));
    assert!(!json.contains("audit"));
    assert!(json.len() < 500);
    assert!(manager.coauthor_run(&scope, run.id).is_err());
    let good = finished(&mut manager, &scope, 2);
    assert_eq!(
        manager.coauthor_run(&scope, good.id).unwrap().output,
        "保留回复2"
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn direct_old_run_preserves_audit_but_does_not_regain_proposal_application_rights() {
    let (mut manager, root, scope) = project();
    let base = manager.coauthor_document(&scope).unwrap();
    let proposed = CoauthorDocument {
        content: "旧建议不得覆盖".into(),
        ..base.clone()
    };
    let old = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "旧试写", 0)
        .unwrap();
    let audit =
        vec![serde_json::json!({"kind":"draft_proposal","document":proposed,"baseDocument":base})];
    manager
        .finish_coauthor_run(&scope, old.id, "COMPLETED", "旧输出", &audit)
        .unwrap();
    for n in 0..25 {
        finished(&mut manager, &scope, n);
    }
    assert!(
        !manager
            .coauthor_state(&scope)
            .unwrap()
            .runs
            .iter()
            .any(|run| run.id == old.id)
    );
    let detail = manager.coauthor_run(&scope, old.id).unwrap();
    assert_eq!(detail.audit, audit);
    assert_eq!(detail.output, "旧输出");
    assert!(matches!(
        manager.apply_coauthor_proposal(&scope, old.id, 0),
        Err(CoauthorError::Conflict)
    ));
    assert_eq!(manager.coauthor_document(&scope).unwrap(), base);
    assert!(manager.list_entities(false).unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn identities_and_cursors_cannot_cross_projects_or_branches_and_forks_do_not_forge_runs() {
    let (mut manager, root, scope) = project();
    let old = finished(&mut manager, &scope, 1);
    let branch = manager
        .fork_coauthor_session(&scope, "独立分支".into())
        .unwrap();
    let fork = CoauthorScope {
        session_id: branch.id,
        ..scope.clone()
    };
    assert!(
        manager
            .list_coauthor_runs(&fork, None)
            .unwrap()
            .runs
            .is_empty()
    );
    assert!(manager.coauthor_run(&fork, old.id).is_err());
    assert!(manager.list_coauthor_runs(&fork, Some(old.id)).is_err());
    assert!(
        manager
            .list_coauthor_runs(&scope, Some(Uuid::new_v4()))
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(matches!(
        manager.coauthor_run(&wrong, old.id),
        Err(CoauthorError::WrongProject)
    ));
    assert!(manager.list_coauthor_runs(&wrong, None).is_err());
    assert!(manager.coauthor_document(&wrong).is_err());
    assert!(manager.coauthor_running_ids(&wrong).is_err());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reopened_and_actual_restored_backups_keep_old_run_checkpoints_and_interruption_status() {
    let (mut manager, root, scope) = project();
    let old = finished(&mut manager, &scope, 1);
    let running = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "长查证", 0)
        .unwrap();
    let audit = vec![
        serde_json::json!({"kind":"tool","name":"read_source","result":{"key":"ENTITY:old","revision":"r1","content":"当时原文"}}),
    ];
    manager
        .checkpoint_coauthor_run(&scope, running.id, "未完成的原话", &audit)
        .unwrap();
    assert_eq!(
        manager.coauthor_running_ids(&scope).unwrap(),
        vec![running.id]
    );
    manager.close();
    manager.open(&root).unwrap();
    assert!(manager.coauthor_running_ids(&scope).unwrap().is_empty());
    let interrupted = manager.coauthor_run(&scope, running.id).unwrap();
    assert_eq!(interrupted.status, "INTERRUPTED");
    assert_eq!(interrupted.output, "未完成的原话");
    assert_eq!(interrupted.audit, audit);
    manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let target = root.with_file_name(format!("run-directory-restored-{}", Uuid::new_v4()));
    manager
        .restore_backup_to_new_project(root.join("snapshots").join(job.id.to_string()), &target)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    assert_eq!(
        restored.coauthor_run(&scope, old.id).unwrap().output,
        "保留回复1"
    );
    let detail = restored.coauthor_run(&scope, running.id).unwrap();
    assert_eq!(detail.audit, audit);
    assert_eq!(detail.status, "INTERRUPTED");
    assert_eq!(
        restored
            .list_coauthor_runs(&scope, None)
            .unwrap()
            .runs
            .len(),
        2
    );
    drop(restored);
    drop(manager);
    let _ = std::fs::remove_dir_all(target);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn document_hot_read_ignores_unrelated_memory_and_missing_run_storage_is_not_an_empty_history() {
    let (manager, root, scope) = project();
    let base = manager.coauthor_document(&scope).unwrap();
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TABLE coauthor_runs; DROP TABLE coauthor_decisions;")
        .unwrap();
    assert_eq!(manager.coauthor_document(&scope).unwrap(), base);
    assert!(manager.list_coauthor_runs(&scope, None).is_err());
    assert!(manager.coauthor_run(&scope, Uuid::new_v4()).is_err());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
