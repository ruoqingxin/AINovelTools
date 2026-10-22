use super::*;

pub(super) fn project() -> (ProjectManager, PathBuf, CoauthorScope) {
    let root = std::env::temp_dir().join(format!("coauthor-test-{}", Uuid::new_v4()));
    let mut manager = ProjectManager::new();
    let manifest = manager.create(&root, "共创").unwrap();
    let session = manager
        .create_discussion_session("境界".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let scope = CoauthorScope {
        project_id: manifest.project_id,
        session_id: session.id,
    };
    (manager, root, scope)
}

pub(super) fn entity(manager: &mut ProjectManager, name: &str, description: &str) -> Entity {
    manager
        .upsert_entity(EntityInput {
            id: None,
            entity_type: EntityType::Concept,
            name: name.into(),
            aliases: vec!["修行等级".into()],
            description: description.into(),
            fixed_attributes_json: "{\"settingScope\":\"PROJECT\"}".into(),
            tags: vec![],
            base_revision_id: None,
            source_version: None,
            expected_version: None,
        })
        .unwrap()
}

#[test]
fn document_versions_conflicts_history_and_reopen_preserve_originals() {
    let (mut manager, root, scope) = project();
    let mut document = manager.coauthor_state(&scope).unwrap().document;
    document.content = "金丹之后，记忆消散。".into();
    let first = manager
        .save_coauthor_document(&scope, document.clone())
        .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(
        manager
            .save_coauthor_document(&scope, first.clone())
            .unwrap(),
        first
    );
    document.content = "过期修改".into();
    assert!(matches!(
        manager.save_coauthor_document(&scope, document),
        Err(CoauthorError::Conflict)
    ));
    let mut changed = first.clone();
    changed.content.push_str("母亲的声音不见了。");
    let second = manager.save_coauthor_document(&scope, changed).unwrap();
    assert_eq!(second.version, 2);
    drop(manager);
    let mut manager = ProjectManager::new();
    manager.open(&root).unwrap();
    assert_eq!(manager.coauthor_state(&scope).unwrap().document, second);
    assert_eq!(
        manager.coauthor_document_history(&scope, None).unwrap(),
        vec![second, first]
    );
    assert!(manager.list_current_facts().unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn queries_find_chinese_bigrams_aliases_and_refresh_only_changed_sources() {
    let (mut manager, root, scope) = project();
    let saved = entity(&mut manager, "境界体系", "炼气、筑基、金丹。突破消耗寿元。");
    let found = manager
        .search_coauthor_sources(&scope, "修炼等级", false, 0)
        .unwrap();
    assert!(
        found
            .hits
            .iter()
            .any(|hit| hit.key == format!("ENTITY:{}", saved.id))
    );
    assert_eq!(found.pending_index_updates, 0);
    assert!(
        !found
            .hits
            .iter()
            .any(|hit| hit.content.contains("过期规则"))
    );
    let source = found
        .hits
        .iter()
        .find(|hit| hit.kind == "ENTITY")
        .unwrap()
        .clone();
    assert!(
        manager
            .read_coauthor_source(&scope, &source.key, &source.revision, 0, 12000)
            .unwrap()
            .content
            .contains("寿元")
    );
    manager
        .upsert_entity(EntityInput {
            id: Some(saved.id),
            entity_type: EntityType::Concept,
            name: "新境界体系".into(),
            aliases: vec![],
            description: "突破消耗记忆。".into(),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: Some(saved.current_revision_id),
            source_version: None,
            expected_version: Some(saved.version),
        })
        .unwrap();
    assert!(matches!(
        manager.read_coauthor_source(&scope, &source.key, &source.revision, 0, 1000),
        Err(CoauthorError::Conflict)
    ));
    let next = manager
        .search_coauthor_sources(&scope, "突破", false, 0)
        .unwrap();
    assert!(
        next.hits
            .iter()
            .any(|hit| hit.title == "新境界体系" && hit.content.contains("记忆"))
    );
    assert!(!next.hits.iter().any(|hit| hit.content.contains("寿元")));
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn historical_ai_is_searchable_but_does_not_become_formal_knowledge_or_cross_branches() {
    let (mut manager, root, scope) = project();
    manager
        .append_discussion_message(
            scope.session_id,
            DiscussionMessageRole::Assistant,
            "方案二：魂灯消耗记忆。".into(),
            None,
            None,
            None,
        )
        .unwrap();
    let other = manager
        .create_discussion_session("另一分支".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    manager
        .append_discussion_message(
            other.id,
            DiscussionMessageRole::User,
            "魂灯的另一版秘密。".into(),
            None,
            None,
            None,
        )
        .unwrap();
    assert!(
        manager
            .search_coauthor_sources(&scope, "魂灯", false, 0)
            .unwrap()
            .hits
            .is_empty()
    );
    let history = manager
        .search_coauthor_sources(&scope, "魂灯", true, 0)
        .unwrap();
    assert_eq!(history.hits.len(), 1);
    assert!(history.hits[0].content.contains("ASSISTANT"));
    assert!(
        manager
            .read_coauthor_source(
                &scope,
                &format!("MESSAGE:{}", Uuid::new_v4()),
                "missing",
                0,
                100
            )
            .is_err()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn run_supersession_cancellation_and_decision_revisions_are_durable() {
    let (mut manager, root, scope) = project();
    let first = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "就选寿元代价", 0)
        .unwrap();
    let initial=manager
        .set_coauthor_decision(&scope, first.id, CoauthorDecisionInput {
            decision_id:None,expected_version:0,topic:"突破代价".into(),aliases:vec![],
            content:"消耗寿元".into(),status:"CHOSEN".into(),quote:"就选寿元代价".into(),
        })
        .unwrap();
    let next = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "改为记忆", 0)
        .unwrap();
    assert!(!manager.coauthor_run_active(&scope, first.id).unwrap());
    assert!(
        manager
            .set_coauthor_decision(&scope, first.id, CoauthorDecisionInput {
                decision_id:Some(initial.id),expected_version:1,topic:"突破代价".into(),aliases:vec![],
                content:"旧内容".into(),status:"CHOSEN".into(),quote:"就选寿元代价".into(),
            })
            .is_err()
    );
    let chosen = manager
        .set_coauthor_decision(&scope, next.id, CoauthorDecisionInput {
            decision_id:Some(initial.id),expected_version:1,topic:"突破代价".into(),aliases:vec![],
            content:"消耗记忆".into(),status:"CHOSEN".into(),quote:"改为记忆".into(),
        })
        .unwrap();
    assert_eq!(chosen.version, 2);
    assert_eq!(manager.coauthor_state(&scope).unwrap().decisions.len(), 1);
    let db = &manager.current.as_ref().unwrap().database;
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM coauthor_decision_revisions",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    manager.cancel_coauthor_run(&scope, next.id).unwrap();
    assert!(!manager.coauthor_run_active(&scope, next.id).unwrap());
    manager
        .finish_coauthor_run(&scope, next.id, "COMPLETED", "保留的部分输出", &[])
        .unwrap();
    assert_eq!(
        manager.coauthor_state(&scope).unwrap().runs[0].status,
        "CANCELLED"
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn wrong_project_and_stale_target_cannot_write() {
    let (mut manager, root, scope) = project();
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(matches!(
        manager.coauthor_state(&wrong),
        Err(CoauthorError::WrongProject)
    ));
    let saved = entity(&mut manager, "境界体系", "金丹。");
    let mut document = manager.coauthor_state(&scope).unwrap().document;
    document.target_key = Some(format!("ENTITY:{}", saved.id));
    document.target_revision = Some("forged".into());
    assert!(matches!(
        manager.save_coauthor_document(&scope, document),
        Err(CoauthorError::Conflict)
    ));
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unique_quote_replacement_preserves_non_targets_and_unicode() {
    assert_eq!(
        coauthor_replace("前半段保留。\n后半段寿元消散。", "寿元", "记忆").unwrap(),
        "前半段保留。\n后半段记忆消散。"
    );
    assert!(coauthor_replace("寿元寿元", "寿元", "记忆").is_err());
    assert!(coauthor_replace("正文", "", "替换全文").is_err());
    assert!(coauthor_replace("正文", "过期原文", "新文").is_err());
}

#[test]
fn publication_is_versioned_idempotent_and_refreshes_both_search_paths() {
    let (mut manager, root, scope) = project();
    let mut document = manager.coauthor_state(&scope).unwrap().document;
    document.title = "魂灯境界".into();
    document.content = "突破消耗记忆。".into();
    let saved = manager.save_coauthor_document(&scope, document).unwrap();
    let key = manager
        .publish_coauthor_document(&scope, saved.version)
        .unwrap();
    assert_eq!(
        manager
            .publish_coauthor_document(&scope, saved.version)
            .unwrap(),
        key
    );
    assert_eq!(manager.list_entities(false).unwrap().len(), 1);
    assert!(
        !manager
            .search_project("魂灯".into(), None, 10, 0)
            .unwrap()
            .is_empty()
    );
    let linked = manager.coauthor_state(&scope).unwrap().document;
    assert_eq!(linked.target_key.as_deref(), Some(key.as_str()));
    assert_eq!(linked.version, saved.version + 1);
    let edited = manager
        .save_coauthor_document(
            &scope,
            CoauthorDocument {
                content: "突破仅消耗声音的记忆。".into(),
                ..linked
            },
        )
        .unwrap();
    assert_eq!(
        manager
            .publish_coauthor_document(&scope, edited.version)
            .unwrap(),
        key
    );
    let entries = manager.list_entities(false).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        manager.list_entity_revisions(entries[0].id).unwrap().len(),
        2
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn publication_search_failure_rolls_back_without_orphan_identity_or_receipt() {
    let (mut manager, root, scope) = project();
    let document = manager.coauthor_state(&scope).unwrap().document;
    let saved = manager
        .save_coauthor_document(
            &scope,
            CoauthorDocument {
                content: "金丹".into(),
                ..document
            },
        )
        .unwrap();
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TABLE search_index")
        .unwrap();
    assert!(
        manager
            .publish_coauthor_document(&scope, saved.version)
            .is_err()
    );
    let db = &manager.current.as_ref().unwrap().database;
    for table in ["entities", "entity_revisions", "coauthor_publications"] {
        assert_eq!(
            db.connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(manager.coauthor_state(&scope).unwrap().document, saved);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn new_outline_and_manuscript_publish_once_and_do_not_overwrite_existing_rich_text() {
    let (mut manager, root, scope) = project();
    for kind in [
        CoauthorDocumentKind::Outline,
        CoauthorDocumentKind::Manuscript,
    ] {
        let session = manager
            .create_discussion_session("新稿".into(), DiscussionScopeKind::Project, None, None)
            .unwrap();
        let target = CoauthorScope {
            session_id: session.id,
            ..scope.clone()
        };
        let document = manager.coauthor_state(&target).unwrap().document;
        let saved = manager
            .save_coauthor_document(
                &target,
                CoauthorDocument {
                    title: "照魂境".into(),
                    content: "前段。\n\n母亲的声音远去。".into(),
                    kind,
                    ..document
                },
            )
            .unwrap();
        let key = manager
            .publish_coauthor_document(&target, saved.version)
            .unwrap();
        assert_eq!(
            manager
                .publish_coauthor_document(&target, saved.version)
                .unwrap(),
            key
        );
        let linked = manager.coauthor_state(&target).unwrap().document;
        let current = manager
            .read_coauthor_source(
                &target,
                &key,
                linked.target_revision.as_ref().unwrap(),
                0,
                12000,
            )
            .unwrap();
        assert!(current.content.contains("母亲的声音远去"));
        if kind == CoauthorDocumentKind::Manuscript {
            let id: Uuid = key.strip_prefix("MANUSCRIPT:").unwrap().parse().unwrap();
            assert_eq!(manager.list_manuscript_revisions(id).unwrap().len(), 1);
            let formal = manager.current_manuscript(id).unwrap().unwrap();
            let edited = manager
                .save_coauthor_document(
                    &target,
                    CoauthorDocument {
                        content: "不允许覆盖既有富文本".into(),
                        ..linked
                    },
                )
                .unwrap();
            assert!(
                manager
                    .publish_coauthor_document(&target, edited.version)
                    .is_err()
            );
            assert_eq!(manager.current_manuscript(id).unwrap().unwrap(), formal);
        }
    }
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 2);
    assert!(manager.list_current_facts().unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_52_rolls_back_new_tables_on_failure_and_preserves_formal_text_on_retry() {
    let mut db = Database::in_memory().unwrap();
    let chapter = db
        .create_plan_node(None, PlanNodeKind::Chapter, "旧项目章节".into())
        .unwrap();
    let revision = db.save_manuscript_checked(chapter.id, None,
        r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"原始正文"}]}]}"#.into(),
        "原修订".into()).unwrap();
    db.connection.execute_batch("DELETE FROM schema_migrations WHERE version>=52;
        DROP TABLE coauthor_documents;
        CREATE TRIGGER fail_coauthor_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=52
        BEGIN SELECT RAISE(ABORT,'failed migration'); END;").unwrap();
    assert!(db.migrate_coauthor().is_err());
    assert!(db.connection.is_autocommit());
    assert_eq!(db.health().unwrap().schema_version, 51);
    assert_eq!(db.connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='coauthor_documents'",
        [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(
        db.current_manuscript(chapter.id).unwrap().unwrap(),
        revision
    );
    db.connection
        .execute_batch("DROP TRIGGER fail_coauthor_migration")
        .unwrap();
    db.migrate_coauthor().unwrap();
    db.connection.execute_batch(
        "DROP TABLE coauthor_reversals; DROP TABLE coauthor_impact_revisions; DROP TABLE coauthor_impacts; DROP TABLE coauthor_changesets;",
    ).unwrap();
    db.migrate_coauthor_changes().unwrap();
    db.migrate_coauthor_reversals().unwrap();
    db.connection.execute_batch("DROP TABLE coauthor_decision_fts; DROP TABLE coauthor_decision_mentions; DROP TABLE coauthor_decision_evidence; DROP TABLE coauthor_decision_aliases;
        DROP TABLE coauthor_check_notes; DROP TABLE coauthor_check_reads; DROP TABLE coauthor_check_entries; DROP TABLE coauthor_source_checks;").unwrap();
    db.migrate_coauthor_source_checks().unwrap();
    db.migrate_coauthor_check_notes().unwrap();
    db.migrate_coauthor_decision_memory().unwrap();
    assert_eq!(db.health().unwrap().schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(
        db.current_manuscript(chapter.id).unwrap().unwrap(),
        revision
    );
}

#[test]
fn fork_copies_history_and_decisions_atomically_but_future_edits_are_isolated() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "采用失忆版", 0)
        .unwrap();
    manager
        .set_coauthor_decision(&scope, run.id, CoauthorDecisionInput {
            decision_id:None,expected_version:0,topic:"代价".into(),aliases:vec![],
            content:"失忆".into(),status:"CHOSEN".into(),quote:"采用失忆版".into(),
        })
        .unwrap();
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "第二个方案是魂灯。", &[])
        .unwrap();
    let branch = manager
        .fork_coauthor_session(&scope, "寿元分支".into())
        .unwrap();
    let target = CoauthorScope {
        session_id: branch.id,
        ..scope.clone()
    };
    assert_eq!(
        manager
            .list_discussion_messages(branch.id, 100)
            .unwrap()
            .len(),
        2
    );
    let forked = manager.coauthor_state(&target).unwrap();
    assert_eq!(forked.decisions[0].content, "失忆");
    let corrected = manager
        .correct_coauthor_decision(&target, forked.decisions[0].id, 1, "寿元", "CHOSEN")
        .unwrap();
    assert_eq!(corrected.version, 2);
    assert_eq!(
        manager.coauthor_state(&scope).unwrap().decisions[0].content,
        "失忆"
    );
    manager.current.as_ref().unwrap().database.connection.execute_batch(
        "CREATE TRIGGER reject_fork BEFORE INSERT ON coauthor_decisions BEGIN SELECT RAISE(ABORT,'fail'); END;"
    ).unwrap();
    assert!(
        manager
            .fork_coauthor_session(&scope, "失败分支".into())
            .is_err()
    );
    assert_eq!(manager.list_discussion_sessions().unwrap().len(), 2);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn proposals_require_current_instruction_and_unmodified_base_and_cancel_revokes_application() {
    let (mut manager, root, scope) = project();
    let base = manager.coauthor_state(&scope).unwrap().document;
    let proposal = CoauthorDocument {
        content: "他忘了母亲的声音。".into(),
        ..base.clone()
    };
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "写一版", 0)
        .unwrap();
    let audit =
        vec![serde_json::json!({"kind":"draft_proposal","baseDocument":base,"document":proposal})];
    manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "已试写", &audit)
        .unwrap();
    manager.cancel_coauthor_run(&scope, run.id).unwrap();
    assert!(manager.apply_coauthor_proposal(&scope, run.id, 0).is_err());
    let next = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "再写", 0)
        .unwrap();
    manager
        .finish_coauthor_run(&scope, next.id, "COMPLETED", "已试写", &audit)
        .unwrap();
    let saved = manager
        .save_coauthor_document(
            &scope,
            CoauthorDocument {
                content: "作者的新句子。".into(),
                ..base
            },
        )
        .unwrap();
    assert!(manager.apply_coauthor_proposal(&scope, next.id, 0).is_err());
    assert_eq!(manager.coauthor_state(&scope).unwrap().document, saved);
    let newer = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "不要失忆", saved.version)
        .unwrap();
    assert!(
        manager
            .apply_coauthor_proposal(&scope, next.id, saved.version)
            .is_err()
    );
    assert!(manager.coauthor_run_active(&scope, newer.id).unwrap());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reopen_marks_orphan_runs_interrupted_and_keeps_checkpoints() {
    let (mut manager, root, scope) = project();
    let run = manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "试写", 0)
        .unwrap();
    manager
        .checkpoint_coauthor_run(&scope, run.id, "未完成的句子", &[])
        .unwrap();
    drop(manager);
    let mut manager = ProjectManager::new();
    manager.open(&root).unwrap();
    let restored = manager.coauthor_state(&scope).unwrap();
    assert_eq!(restored.runs[0].status, "INTERRUPTED");
    assert_eq!(restored.runs[0].output, "未完成的句子");
    assert_eq!(
        manager
            .list_discussion_messages(scope.session_id, 100)
            .unwrap()[0]
            .content,
        "试写"
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn cancellation_arriving_before_start_is_durable_and_prevents_late_start() {
    let (mut manager, root, scope) = project();
    let id = Uuid::new_v4();
    manager.cancel_coauthor_run(&scope, id).unwrap();
    drop(manager);
    let mut manager = ProjectManager::new();
    manager.open(&root).unwrap();
    assert!(matches!(
        manager.start_coauthor_run(&scope, id, "不应执行的迟到请求", 0),
        Err(CoauthorError::Conflict)
    ));
    assert!(manager.coauthor_state(&scope).unwrap().runs.is_empty());
    assert!(
        manager
            .list_discussion_messages(scope.session_id, 100)
            .unwrap()
            .is_empty()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn equal_text_with_a_new_native_revision_invalidates_old_evidence() {
    let (mut manager, root, scope) = project();
    let first = entity(&mut manager, "境界体系", "突破消耗记忆。");
    let source = manager
        .search_coauthor_sources(&scope, "境界", false, 0)
        .unwrap()
        .hits
        .remove(0);
    manager
        .upsert_entity(EntityInput {
            id: Some(first.id),
            entity_type: EntityType::Concept,
            name: "境界体系".into(),
            aliases: vec!["修行等级".into()],
            description: "突破消耗记忆。".into(),
            fixed_attributes_json: "{\"settingScope\":\"PROJECT\"}".into(),
            tags: vec![],
            base_revision_id: Some(first.current_revision_id),
            source_version: None,
            expected_version: Some(first.version),
        })
        .unwrap();
    assert!(matches!(
        manager.read_coauthor_source(&scope, &source.key, &source.revision, 0, 100),
        Err(CoauthorError::Conflict)
    ));
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
#[ignore = "manual retrieval baseline; run alone without concurrent builds"]
fn retrieval_baseline_against_legacy_context_collection() {
    for size in [100, 600] {
        let (mut manager, root, scope) = project();
        entity(
            &mut manager,
            "境界体系",
            "炼气、筑基、金丹。限制：突破会失忆，但封魂者例外。",
        );
        {
            let db = &manager.current.as_ref().unwrap().database;
            let tx = db.connection.unchecked_transaction().unwrap();
            for index in 0..size {
                let id = Uuid::new_v4().to_string();
                let revision = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO entities(id,project_id,entity_type,current_revision_id)
                    VALUES (?1,?2,'LOCATION',?3)",
                    rusqlite::params![id, scope.project_id.to_string(), revision],
                )
                .unwrap();
                tx.execute("INSERT INTO entity_revisions(id,entity_id,revision,name,description) VALUES (?1,?2,1,?3,?4)",
                    rusqlite::params![revision,id,format!("无关地点{index}"),"荒原草木随风摇曳，集市里灯火明亮。".repeat(150)]).unwrap();
            }
            tx.commit().unwrap();
        }
        let cold = std::time::Instant::now();
        let page = manager
            .search_coauthor_sources(&scope, "境界体系", false, 0)
            .unwrap();
        let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(page.pending_index_updates, 0);
        assert_eq!(page.hits.len(), 1);
        assert!(page.hits[0].content.contains("封魂者例外"));
        let input = novel_application::DiscussionContextInput {
            scope_label: "全书".into(),
            scope_content: String::new(),
            history: String::new(),
            user_message: "境界体系".into(),
            input_token_budget: 24576,
            focus: None,
        };
        let mut legacy = Vec::new();
        let mut indexed = Vec::new();
        for _ in 0..30 {
            let start = std::time::Instant::now();
            manager
                .collect_discussion_context_candidates(&input)
                .unwrap();
            legacy.push(start.elapsed().as_secs_f64() * 1000.0);
            let start = std::time::Instant::now();
            let found = manager
                .search_coauthor_sources(&scope, "境界体系", false, 0)
                .unwrap();
            assert_eq!(found.hits.len(), 1);
            indexed.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        legacy.sort_by(f64::total_cmp);
        indexed.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"unrelatedEntities":size,"coldIndexMs":cold_ms,
            "legacyP50Ms":legacy[15],"legacyP95Ms":legacy[28],"indexedP50Ms":indexed[15],
            "indexedP95Ms":indexed[28],"hits":1,"pendingUpdates":0,"modelRequests":0})
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}
