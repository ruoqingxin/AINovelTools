use super::*;
use super::tests::project;

#[test]
fn renaming_persists_without_changing_messages_documents_or_branches() {
    let (mut manager, root, scope) = project();
    let mut document = manager.coauthor_state(&scope).unwrap().document;
    document.content = "保留的工作稿".into();
    let saved = manager.save_coauthor_document(&scope, document).unwrap();
    manager.append_discussion_message(scope.session_id, DiscussionMessageRole::User,
        "保留的讨论".into(), None, None, None).unwrap();
    let messages = manager.list_discussion_messages_before(scope.session_id, 100, None).unwrap();
    let branch = manager.fork_coauthor_session(&scope, "另一方向".into()).unwrap();
    let renamed = manager.rename_discussion_session(&scope, "  新的讨论名  ".into(), "境界".into()).unwrap();
    assert_eq!(renamed.title, "新的讨论名");
    assert_eq!(renamed.id, scope.session_id);
    assert_eq!(manager.coauthor_state(&scope).unwrap().document, saved);
    assert_eq!(manager.list_discussion_messages_before(scope.session_id, 100, None).unwrap(), messages);
    assert_eq!(manager.get_discussion_session(branch.id).unwrap().title, "另一方向");
    drop(manager);
    let mut reopened = ProjectManager::new();
    reopened.open(&root).unwrap();
    assert_eq!(reopened.get_discussion_session(scope.session_id).unwrap().title, "新的讨论名");
    assert_eq!(reopened.coauthor_state(&scope).unwrap().document, saved);
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn renaming_rejects_invalid_stale_deleted_and_cross_project_requests() {
    let (mut manager, root, scope) = project();
    for title in [" \n ".to_owned(), "字".repeat(201)] {
        assert!(matches!(manager.rename_discussion_session(&scope, title, "境界".into()),
            Err(CoauthorError::Invalid(_))));
    }
    assert!(matches!(manager.rename_discussion_session(&CoauthorScope {
        project_id: Uuid::new_v4(), ..scope.clone()
    }, "不能改".into(), "境界".into()), Err(CoauthorError::WrongProject)));
    assert!(manager.rename_discussion_session(&CoauthorScope {
        session_id: Uuid::new_v4(), ..scope.clone()
    }, "不能改".into(), "境界".into()).is_err());
    assert_eq!(manager.get_discussion_session(scope.session_id).unwrap().title, "境界");
    let title = "字".repeat(200);
    manager.rename_discussion_session(&scope, title.clone(), "境界".into()).unwrap();
    assert!(matches!(manager.rename_discussion_session(&scope, "过期覆盖".into(), "境界".into()),
        Err(CoauthorError::Conflict)));
    assert_eq!(manager.get_discussion_session(scope.session_id).unwrap().title, title);
    manager.delete_discussion_session(&scope).unwrap();
    assert!(manager.rename_discussion_session(&scope, "不能复活".into(), title).is_err());
    assert!(manager.list_discussion_sessions().unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
