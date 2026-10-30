use super::*;
use super::tests::{entity, project};

#[test]
fn deleted_discussion_stays_deleted_after_reopen_without_removing_formal_content_or_child_snapshots() {
    let (mut manager, root, scope) = project();
    let formal = entity(&mut manager, "已采用的设定", "正式内容不能因删除讨论而消失。");
    let mut document = manager.coauthor_state(&scope).unwrap().document;
    document.content = "工作稿原文。".into();
    let saved = manager.save_coauthor_document(&scope, document).unwrap();
    let branch = manager.fork_coauthor_session(&scope, "保留的分支".into()).unwrap();
    let child_scope = CoauthorScope { session_id: branch.id, ..scope.clone() };
    let before_child = manager.coauthor_state(&child_scope).unwrap().document;
    let run_id = Uuid::new_v4();
    manager.start_coauthor_run(&scope, run_id, "历史发言", saved.version).unwrap();
    manager.finish_coauthor_run(&scope, run_id, "COMPLETED", "历史回复", &[]).unwrap();
    manager.delete_discussion_session(&scope).unwrap();
    assert!(manager.list_discussion_sessions().unwrap().iter().all(|session| session.id != scope.session_id));
    assert!(manager.coauthor_state(&scope).is_err());
    assert!(manager.start_coauthor_run(&scope, Uuid::new_v4(), "不能复活", saved.version).is_err());
    assert!(manager.save_coauthor_document(&scope, saved.clone()).is_err());
    assert!(manager.append_discussion_message(scope.session_id, DiscussionMessageRole::User,
        "不能继续写入".into(), None, None, None).is_err());
    assert_eq!(manager.coauthor_state(&child_scope).unwrap().document, before_child);
    assert!(manager.list_coauthor_branches(&child_scope, 0).unwrap().branches.is_empty());
    assert!(manager.list_entities(false).unwrap().iter().any(|entry| entry.id == formal.id));
    let db = &manager.current.as_ref().unwrap().database;
    assert_eq!(db.coauthor_document(scope.session_id).unwrap(), saved);
    assert_eq!(db.connection.query_row("SELECT output FROM coauthor_runs WHERE id=?1",
        [run_id.to_string()], |row| row.get::<_, String>(0)).unwrap(), "历史回复");
    assert_eq!(db.connection.query_row("SELECT COUNT(*) FROM discussion_messages WHERE session_id=?1",
        [scope.session_id.to_string()], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert!(db.connection.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
    drop(manager);
    let mut reopened = ProjectManager::new();
    reopened.open(&root).unwrap();
    assert!(reopened.get_discussion_session(scope.session_id).is_err());
    assert_eq!(reopened.coauthor_state(&child_scope).unwrap().document, before_child);
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn deleting_rejects_running_and_cross_project_requests_without_mutating_the_discussion() {
    let (mut manager, root, scope) = project();
    let run_id = Uuid::new_v4();
    manager.start_coauthor_run(&scope, run_id, "仍在运行", 0).unwrap();
    assert!(matches!(manager.delete_discussion_session(&scope), Err(CoauthorError::Invalid(_))));
    assert_eq!(manager.coauthor_run(&scope, run_id).unwrap().status, "RUNNING");
    assert!(matches!(manager.delete_discussion_session(&CoauthorScope {
        project_id: Uuid::new_v4(), ..scope.clone()
    }), Err(CoauthorError::WrongProject)));
    assert!(manager.delete_discussion_session(&CoauthorScope {
        session_id: Uuid::new_v4(), ..scope.clone()
    }).is_err());
    assert_eq!(manager.list_discussion_sessions().unwrap().len(), 1);
    manager.cancel_coauthor_run(&scope, run_id).unwrap();
    manager.delete_discussion_session(&scope).unwrap();
    assert!(manager.finish_coauthor_run(&scope, run_id, "COMPLETED", "迟到的回复", &[]).is_err());
    assert!(manager.list_discussion_sessions().unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_66_rolls_back_and_retries_without_changing_existing_discussions() {
    let (manager, root, scope) = project();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection.execute_batch(
        "ALTER TABLE discussion_sessions DROP COLUMN deleted_at;
         DELETE FROM schema_migrations WHERE version>=66;
         CREATE TRIGGER fail66 BEFORE INSERT ON schema_migrations WHEN NEW.version=66
         BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
    ).unwrap();
    assert!(db.migrate_discussion_session_deletion().is_err());
    assert_eq!(db.health().unwrap().schema_version, 65);
    assert_eq!(db.connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('discussion_sessions') WHERE name='deleted_at'",
        [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    db.connection.execute_batch("DROP TRIGGER fail66").unwrap();
    db.migrate_discussion_session_deletion().unwrap();
    db.migrate_entity_deletion().unwrap();
    assert_eq!(db.health().unwrap().schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(db.get_discussion_session(scope.session_id).unwrap().unwrap().title, "境界");
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
