use super::*;
use crate::coauthor_store::tests::project;

fn input(
    previous: Option<&CoauthorDecision>,
    topic: &str,
    content: &str,
    status: &str,
    quote: &str,
) -> CoauthorDecisionInput {
    CoauthorDecisionInput {
        decision_id: previous.map(|d| d.id),
        expected_version: previous.map_or(0, |d| d.version),
        topic: topic.into(),
        aliases: vec![],
        content: content.into(),
        status: status.into(),
        quote: quote.into(),
    }
}

#[test]
fn old_words_and_aliases_return_current_status_not_superseded_content() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "确定突破消耗寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "突破代价", "消耗寿元", "CHOSEN", "消耗寿元"),
        )
        .unwrap();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "改为失去记忆", 0)
        .unwrap();
    let mut update = input(
        Some(&first),
        "境界损耗",
        "失去记忆",
        "CHOSEN",
        "改为失去记忆",
    );
    update.aliases = vec!["修炼代偿".into()];
    let second = manager
        .set_coauthor_decision(&scope, run.id, update)
        .unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.topic, first.topic);
    for query in ["寿元", "境界损耗", "修炼代偿", "记忆"] {
        let found = manager.search_coauthor_decisions(&scope, query, 0).unwrap();
        assert_eq!(found.memories.len(), 1, "{query}");
        assert_eq!(found.memories[0].decision, second);
    }
    let withdrawn = manager
        .correct_coauthor_decision(
            &scope,
            second.id,
            second.version,
            "暂时撤回失忆方案",
            "WITHDRAWN",
        )
        .unwrap();
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "寿元", 0)
            .unwrap()
            .memories[0]
            .decision,
        withdrawn
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stable_identity_requires_explicit_version_and_blocks_alias_duplicates_and_hijacking() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "确定代价，另一件待定", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, " Realm Cost ", "寿元", "CHOSEN", "确定代价"),
        )
        .unwrap();
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(None, "realmcost", "记忆", "CHOSEN", "确定代价")
            )
            .is_err()
    );
    let other = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "另一主题", "尚未选择", "OPEN", "另一件待定"),
        )
        .unwrap();
    let mut hijack = input(Some(&other), "不同说法", "尚未选择", "OPEN", "另一件待定");
    hijack.aliases = vec!["Realm Cost".into()];
    assert!(
        manager
            .set_coauthor_decision(&scope, run.id, hijack)
            .is_err()
    );
    let second = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(Some(&first), "Realm Cost", "记忆", "CHOSEN", "确定代价"),
        )
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "realmcost", 0)
            .unwrap()
            .memories[0]
            .decision,
        second
    );
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(Some(&first), "Realm Cost", "旧方向", "CHOSEN", "确定代价")
            )
            .is_err()
    );
    assert_eq!(manager.coauthor_state(&scope).unwrap().decisions.len(), 2);
    assert_eq!(
        manager
            .list_coauthor_decision_history(&scope, first.id, None)
            .unwrap()
            .revisions
            .len(),
        2
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn actual_author_message_quote_scope_and_run_state_are_checked_inside_storage() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "如果突破失忆呢，先看看", 0)
        .unwrap();
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(None, "代价", "失忆", "CHOSEN", "作者没有说过")
            )
            .is_err()
    );
    assert!(
        manager
            .set_coauthor_decision(&scope, run.id, input(None, "代价", "失忆", "CHOSEN", ""))
            .is_err()
    );
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "代价", "仍在探索", "OPEN", "先看看"),
        )
        .unwrap();
    let other = manager
        .create_discussion_session("其他".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let other = CoauthorScope {
        session_id: other.id,
        ..scope.clone()
    };
    let foreign = manager
        .start_coauthor_run(&other, Uuid::new_v4(), "改为失忆", 0)
        .unwrap();
    assert!(
        manager
            .set_coauthor_decision(
                &other,
                foreign.id,
                input(Some(&first), "代价", "失忆", "CHOSEN", "改为失忆")
            )
            .is_err()
    );
    assert!(
        manager
            .list_coauthor_decision_history(&other, first.id, None)
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(manager.search_coauthor_decisions(&wrong, "", 0).is_err());
    manager.cancel_coauthor_run(&scope, run.id).unwrap();
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(Some(&first), "代价", "失忆", "CHOSEN", "先看看")
            )
            .is_err()
    );
    assert!(serde_json::from_value::<CoauthorDecisionInput>(serde_json::json!({
        "expectedVersion":0,"topic":"代价","content":"失忆","status":"CHOSEN","quote":"先看看","authorized":true
    })).is_err());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn history_search_and_exact_read_keep_original_text_with_current_decision_guards() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "确定突破消耗寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "突破代价", "消耗寿元", "CHOSEN", "消耗寿元"),
        )
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "接下来沿用寿元方案。", &[])
        .unwrap();
    let before = manager
        .search_coauthor_sources(&scope, "寿元", true, 0)
        .unwrap();
    let author = before
        .hits
        .iter()
        .find(|hit| hit.key == format!("MESSAGE:{}", run.user_message_id))
        .unwrap()
        .clone();
    assert!(!author.decision_context.as_ref().unwrap().guards[0].superseded);
    let updated = manager
        .correct_coauthor_decision(&scope, first.id, 1, "改用记忆，不再沿用寿元", "CHOSEN")
        .unwrap();
    let history = manager
        .search_coauthor_sources(&scope, "寿元", true, 0)
        .unwrap();
    let assistant = history
        .hits
        .iter()
        .find(|hit| hit.content.contains("接下来沿用寿元"))
        .unwrap();
    let context = assistant.decision_context.as_ref().unwrap();
    assert!(context.guards[0].superseded);
    assert_eq!(context.guards[0].current, updated);
    let raw = manager
        .read_coauthor_source(&scope, &author.key, &author.revision, 0, 12000)
        .unwrap();
    assert!(raw.content.contains("确定突破消耗寿元"));
    assert!(!raw.content.contains("改用记忆"));
    assert_eq!(raw.revision, author.revision);
    assert_eq!(
        raw.decision_context.as_ref().unwrap().guards[0].current,
        updated
    );
    assert!(
        manager
            .coauthor_message_decision_context(&scope, run.user_message_id)
            .unwrap()
            .unwrap()
            .guards[0]
            .superseded
    );
    let unrelated = manager
        .append_discussion_message(
            scope.session_id,
            DiscussionMessageRole::Assistant,
            "未关联的寿元建议，只能作历史方案".into(),
            None,
            None,
            None,
        )
        .unwrap();
    assert!(
        manager
            .coauthor_message_decision_context(&scope, unrelated.id)
            .unwrap()
            .is_none()
    );
    let rejected = manager
        .correct_coauthor_decision(
            &scope,
            updated.id,
            2,
            "失忆方案也否定，不作当前规则",
            "REJECTED",
        )
        .unwrap();
    assert_eq!(
        manager
            .read_coauthor_source(&scope, &author.key, &author.revision, 0, 12000)
            .unwrap()
            .decision_context
            .unwrap()
            .guards[0]
            .current,
        rejected
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn guards_and_queries_are_bounded_and_revision_history_pages_preserve_exact_quotes() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "作者选择共同关键字", 0)
        .unwrap();
    let mut first = None;
    for i in 0..18 {
        let decision = manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(
                    None,
                    &format!("主题{i}"),
                    "共同关键字",
                    "CHOSEN",
                    "作者选择",
                ),
            )
            .unwrap();
        if first.is_none() {
            first = Some(decision);
        }
    }
    let context = manager
        .coauthor_message_decision_context(&scope, run.user_message_id)
        .unwrap()
        .unwrap();
    assert_eq!(context.guards.len(), 16);
    assert!(context.has_more);
    let page = manager
        .search_coauthor_decisions(&scope, "共同关键字", 0)
        .unwrap();
    assert_eq!(page.memories.len(), 16);
    assert!(page.has_more);
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "共同关键字", 16)
            .unwrap()
            .memories
            .len(),
        2
    );
    assert!(
        manager
            .search_coauthor_decisions(&scope, "无关词汇", 0)
            .unwrap()
            .memories
            .is_empty()
    );
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "", 0)
            .unwrap()
            .memories
            .len(),
        16
    );
    let mut current = first.unwrap();
    for i in 0..22 {
        current = manager
            .correct_coauthor_decision(
                &scope,
                current.id,
                current.version,
                &format!("修正内容{i}"),
                "OPEN",
            )
            .unwrap();
    }
    let history = manager
        .list_coauthor_decision_history(&scope, current.id, None)
        .unwrap();
    assert_eq!(history.current.decision, current);
    assert_eq!(history.revisions.len(), 20);
    assert!(history.has_more);
    assert_eq!(history.revisions[0].quote.as_deref(), Some("修正内容21"));
    let older = manager
        .list_coauthor_decision_history(
            &scope,
            current.id,
            Some(history.revisions.last().unwrap().decision.version),
        )
        .unwrap();
    assert_eq!(older.revisions.len(), 3);
    assert!(!older.has_more);
    assert_eq!(
        older.revisions.last().unwrap().quote.as_deref(),
        Some("作者选择")
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn late_evidence_failure_rolls_back_state_aliases_mentions_indexes_and_author_correction() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "确认寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "代价", "寿元", "CHOSEN", "确认寿元"),
        )
        .unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute_batch(
            "CREATE TRIGGER fail_evidence BEFORE INSERT ON coauthor_decision_evidence
        BEGIN SELECT RAISE(ABORT,'evidence failure'); END;",
        )
        .unwrap();
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(Some(&first), "新别名", "记忆", "CHOSEN", "确认寿元")
            )
            .is_err()
    );
    assert_eq!(manager.coauthor_state(&scope).unwrap().decisions[0], first);
    assert!(
        manager
            .search_coauthor_decisions(&scope, "新别名", 0)
            .unwrap()
            .memories
            .is_empty()
    );
    let messages = manager
        .list_discussion_messages(scope.session_id, 100)
        .unwrap()
        .len();
    assert!(
        manager
            .correct_coauthor_decision(&scope, first.id, 1, "记忆", "CHOSEN")
            .is_err()
    );
    assert_eq!(
        manager
            .list_discussion_messages(scope.session_id, 100)
            .unwrap()
            .len(),
        messages
    );
    assert_eq!(
        manager
            .list_coauthor_decision_history(&scope, first.id, None)
            .unwrap()
            .revisions
            .len(),
        1
    );
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TRIGGER fail_evidence")
        .unwrap();
    let updated = manager
        .correct_coauthor_decision(&scope, first.id, 1, "记忆", "CHOSEN")
        .unwrap();
    assert_eq!(updated.version, 2);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn independent_connections_cannot_overwrite_a_newer_author_correction() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "选择寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "代价", "寿元", "CHOSEN", "选择寿元"),
        )
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "已记录", &[])
        .unwrap();
    let mut other = ProjectManager::new();
    other.open(&root).unwrap();
    let latest = manager
        .correct_coauthor_decision(&scope, first.id, 1, "记忆", "CHOSEN")
        .unwrap();
    let count = manager
        .list_discussion_messages(scope.session_id, 100)
        .unwrap()
        .len();
    assert!(
        other
            .correct_coauthor_decision(&scope, first.id, 1, "旧寿元", "CHOSEN")
            .is_err()
    );
    assert_eq!(
        other
            .list_discussion_messages(scope.session_id, 100)
            .unwrap()
            .len(),
        count
    );
    assert_eq!(
        other
            .search_coauthor_decisions(&scope, "寿元", 0)
            .unwrap()
            .memories[0]
            .decision,
        latest
    );
    drop(other);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn fork_and_actual_backup_keep_aliases_old_message_guards_and_branch_isolation() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "选择寿元", 0)
        .unwrap();
    let mut choice = input(None, "突破代价", "寿元", "CHOSEN", "选择寿元");
    choice.aliases = vec!["境界代偿".into()];
    let first = manager
        .set_coauthor_decision(&scope, run.id, choice)
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "寿元方案回复", &[])
        .unwrap();
    let latest = manager
        .correct_coauthor_decision(&scope, first.id, 1, "撤回寿元，仍探索记忆", "WITHDRAWN")
        .unwrap();
    let branch = manager
        .fork_coauthor_session(&scope, "探索分支".into())
        .unwrap();
    let fork = CoauthorScope {
        session_id: branch.id,
        ..scope.clone()
    };
    let copied = manager
        .search_coauthor_decisions(&fork, "境界代偿", 0)
        .unwrap()
        .memories[0]
        .decision
        .clone();
    assert_ne!(copied.id, latest.id);
    assert_eq!(copied.status, "WITHDRAWN");
    let old = manager
        .search_coauthor_sources(&fork, "选择寿元", true, 0)
        .unwrap()
        .hits
        .into_iter()
        .find(|hit| hit.content.contains("选择寿元"))
        .unwrap();
    let guard = &old.decision_context.as_ref().unwrap().guards[0];
    assert_eq!(guard.referenced_version, 0);
    assert!(guard.superseded);
    let resumed = manager
        .correct_coauthor_decision(&fork, copied.id, 1, "该分支选择记忆", "CHOSEN")
        .unwrap();
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "寿元", 0)
            .unwrap()
            .memories[0]
            .decision,
        latest
    );
    manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let target = root.with_file_name(format!("decision-memory-restored-{}", Uuid::new_v4()));
    manager
        .restore_backup_to_new_project(root.join("snapshots").join(job.id.to_string()), &target)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let memory = restored
        .search_coauthor_decisions(&fork, "境界代偿", 0)
        .unwrap()
        .memories
        .remove(0);
    assert_eq!(memory.decision, resumed);
    assert_eq!(memory.quote.as_deref(), Some("该分支选择记忆"));
    let read = restored
        .read_coauthor_source(&fork, &old.key, &old.revision, 0, 12000)
        .unwrap();
    assert_eq!(read.decision_context.unwrap().guards[0].current, resumed);
    assert_eq!(
        restored
            .list_coauthor_decision_history(&scope, first.id, None)
            .unwrap()
            .revisions
            .len(),
        2
    );
    drop(restored);
    drop(manager);
    let _ = std::fs::remove_dir_all(target);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_backfills_only_known_links_preserves_raw_messages_and_retries_atomically() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "就选寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "代价", "寿元", "CHOSEN", "就选寿元"),
        )
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "沿用寿元方案", &[])
        .unwrap();
    let latest = manager
        .correct_coauthor_decision(&scope, first.id, 1, "记忆", "CHOSEN")
        .unwrap();
    let messages = manager
        .list_discussion_messages(scope.session_id, 100)
        .unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute_batch(
            "DROP TABLE coauthor_decision_fts; DROP TABLE coauthor_decision_mentions;
         DROP TABLE coauthor_decision_evidence; DROP TABLE coauthor_decision_aliases;
         DELETE FROM schema_migrations WHERE version=57;
         CREATE TRIGGER fail57 BEFORE INSERT ON schema_migrations WHEN NEW.version=57
         BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
        )
        .unwrap();
    assert!(db.migrate_coauthor_decision_memory().is_err());
    assert_eq!(db.health().unwrap().schema_version, 56);
    assert!(db.connection.is_autocommit());
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_decision_aliases'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.connection.execute_batch("DROP TRIGGER fail57").unwrap();
    db.migrate_coauthor_decision_memory().unwrap();
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "寿元", 0)
            .unwrap()
            .memories[0]
            .decision,
        latest
    );
    assert!(
        manager
            .list_coauthor_decision_history(&scope, first.id, None)
            .unwrap()
            .revisions
            .iter()
            .all(|r| r.quote.is_none())
    );
    let old = manager
        .search_coauthor_sources(&scope, "沿用寿元", true, 0)
        .unwrap()
        .hits
        .into_iter()
        .find(|hit| hit.content.contains("沿用寿元方案"))
        .unwrap();
    assert!(old.decision_context.unwrap().guards[0].superseded);
    assert_eq!(
        manager
            .list_discussion_messages(scope.session_id, 100)
            .unwrap(),
        messages
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn author_can_explicitly_reconsider_a_withdrawn_direction_using_latest_identity() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "先确定寿元", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "代价", "寿元", "CHOSEN", "确定寿元"),
        )
        .unwrap();
    let withdrawn = manager
        .correct_coauthor_decision(&scope, first.id, 1, "不再采用寿元", "WITHDRAWN")
        .unwrap();
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "寿元", 0)
            .unwrap()
            .memories[0]
            .decision
            .status,
        "WITHDRAWN"
    );
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "现在重新决定用寿元", 0)
        .unwrap();
    let renewed = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(Some(&withdrawn), "代价", "寿元", "CHOSEN", "重新决定用寿元"),
        )
        .unwrap();
    assert_eq!(renewed.id, first.id);
    assert_eq!(renewed.version, 3);
    assert_eq!(renewed.status, "CHOSEN");
    assert!(
        manager
            .coauthor_message_decision_context(&scope, withdrawn.source_message_id)
            .unwrap()
            .unwrap()
            .guards[0]
            .superseded
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_keeps_ambiguous_legacy_topics_separate_and_updates_require_explicit_identity() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "作者选择两个方案", 0)
        .unwrap();
    let first = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "Cost", "寿元", "CHOSEN", "作者选择"),
        )
        .unwrap();
    let mut second = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(None, "Temporary", "记忆", "OPEN", "两个方案"),
        )
        .unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute_batch(
            "DROP TABLE coauthor_decision_fts; DROP TABLE coauthor_decision_mentions;
         DROP TABLE coauthor_decision_evidence; DROP TABLE coauthor_decision_aliases;
         DELETE FROM schema_migrations WHERE version=57;",
        )
        .unwrap();
    second.topic = " C O S T ".into();
    db.connection
        .execute(
            "UPDATE coauthor_decisions SET topic=?2 WHERE id=?1",
            rusqlite::params![second.id.to_string(), second.topic],
        )
        .unwrap();
    db.connection
        .execute(
            "UPDATE coauthor_decision_revisions SET payload=?2 WHERE decision_id=?1",
            rusqlite::params![second.id.to_string(), encode(&second).unwrap()],
        )
        .unwrap();
    db.migrate_coauthor_decision_memory().unwrap();
    assert_eq!(
        manager
            .search_coauthor_decisions(&scope, "cost", 0)
            .unwrap()
            .memories
            .len(),
        2
    );
    assert!(
        manager
            .set_coauthor_decision(
                &scope,
                run.id,
                input(None, "cost", "另选", "OPEN", "两个方案")
            )
            .is_err()
    );
    let updated = manager
        .set_coauthor_decision(
            &scope,
            run.id,
            input(Some(&first), "Cost", "寿元", "CHOSEN", "作者选择"),
        )
        .unwrap();
    assert_eq!(updated.id, first.id);
    assert_eq!(
        manager
            .list_coauthor_decision_history(&scope, second.id, None)
            .unwrap()
            .current
            .decision,
        second
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
