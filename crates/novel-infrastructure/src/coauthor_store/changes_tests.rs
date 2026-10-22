use super::tests::{entity, project};
use super::*;

fn request(manager: &mut ProjectManager, scope: &CoauthorScope) -> CoauthorChangeRequest {
    let draft = manager.coauthor_state(scope).unwrap().document;
    let saved = manager
        .save_coauthor_document(
            scope,
            CoauthorDocument {
                title: "突破".into(),
                kind: CoauthorDocumentKind::Manuscript,
                content: "他失去了母亲的声音。".into(),
                ..draft
            },
        )
        .unwrap();
    let setting = entity(manager, "修炼体系", "突破消耗寿元。");
    let old = entity(manager, "旧章节规则", "主角突破后还记得母亲的声音。");
    let db = &manager.current.as_ref().unwrap().database;
    let target = db
        .coauthor_source(&format!("ENTITY:{}", setting.id))
        .unwrap()
        .unwrap();
    let impact = db
        .coauthor_source(&format!("ENTITY:{}", old.id))
        .unwrap()
        .unwrap();
    CoauthorChangeRequest {
        include_draft: true,
        expected_document_version: saved.version,
        title: "采用失忆版并更新体系".into(),
        draft_depends_on: vec!["realm".into()],
        items: vec![CoauthorChangeItemInput {
            manuscript_edits: vec![],
            id: "realm".into(),
            kind: CoauthorDocumentKind::Setting,
            title: "修炼体系".into(),
            content: "突破消耗一段记忆。".into(),
            target_key: Some(target.key),
            target_revision: Some(target.revision),
            depends_on: vec![],
        }],
        impacts: vec![CoauthorImpactInput {
            item_ids: vec!["realm".into()],
            key: impact.key,
            revision: impact.revision,
            quote: "还记得母亲的声音".into(),
            reason: "检查新代价与旧描写的衔接，不自动认定矛盾。".into(),
        }],
        coverage: "仅核对修炼体系和旧章节规则，未检查其余正文与伏笔。".into(),
    }
}

fn count(manager: &ProjectManager, table: &str) -> i64 {
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn composite_adoption_commits_both_objects_impacts_receipts_and_survives_reopen() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    assert_eq!(count(&manager, "coauthor_impacts"), 0);
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 0);
    assert!(
        changes.items[1]
            .before
            .as_ref()
            .unwrap()
            .content
            .contains("寿元")
    );
    let result = manager
        .commit_coauthor_changeset(&scope, changes.id, 1, vec!["draft".into(), "realm".into()])
        .unwrap();
    assert_eq!(result.status, "COMMITTED");
    assert_eq!(result.published.len(), 2);
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 1);
    assert_eq!(count(&manager, "coauthor_impacts"), 1);
    assert_eq!(count(&manager, "coauthor_publications"), 2);
    assert!(manager.list_current_facts().unwrap().is_empty());
    let linked = manager.coauthor_state(&scope).unwrap().document;
    assert_eq!(
        linked.target_key.as_ref(),
        Some(&result.published[0].source_key)
    );
    let retry = manager
        .commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into(), "draft".into()])
        .unwrap();
    assert_eq!(
        retry.published[0].source_key,
        result.published[0].source_key
    );
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 1);
    assert_eq!(count(&manager, "coauthor_impacts"), 1);
    assert!(matches!(
        manager.commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into()],),
        Err(CoauthorError::Conflict)
    ));
    drop(manager);
    let mut manager = ProjectManager::new();
    manager.open(&root).unwrap();
    assert_eq!(
        manager
            .coauthor_changeset(&scope, changes.id)
            .unwrap()
            .status,
        "COMMITTED"
    );
    assert_eq!(
        manager.coauthor_changes(&scope, 0, 0).unwrap().impacts[0].status,
        "PENDING"
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn partial_adoption_checks_dependencies_and_only_commits_the_selected_subset() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    assert!(
        manager
            .publish_coauthor_document(&scope, changes.base_document.version)
            .unwrap_err()
            .to_string()
            .contains("关联依赖")
    );
    assert!(
        manager
            .commit_coauthor_changeset(&scope, changes.id, 1, vec!["draft".into()],)
            .unwrap_err()
            .to_string()
            .contains("依赖")
    );
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 0);
    let base = manager.coauthor_state(&scope).unwrap().document;
    let result = manager
        .commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into()])
        .unwrap();
    assert_eq!(result.published.len(), 1);
    assert_eq!(result.selected_ids, vec!["realm"]);
    assert_eq!(manager.coauthor_state(&scope).unwrap().document, base);
    assert_eq!(count(&manager, "coauthor_publications"), 0);
    assert_eq!(count(&manager, "coauthor_impacts"), 1);
    let mut independent = CoauthorChangeRequest {
        include_draft: true,
        expected_document_version: base.version,
        title: "仅采用独立正文".into(),
        draft_depends_on: vec![],
        items: vec![],
        impacts: vec![],
        coverage: "当前正文已不依赖任何未采用规则。未检查全书。".into(),
    };
    let ignored = entity(&mut manager, "未采用的新设定", "原设定");
    independent.items.push(CoauthorChangeItemInput {
        manuscript_edits: vec![],
        id: "unselected".into(), kind: CoauthorDocumentKind::Setting,
        title: "未采用的新设定".into(), content: "未采用的变化".into(),
        target_key: None, target_revision: None, depends_on: vec![],
    });
    let evidence = manager.current.as_ref().unwrap().database.coauthor_source(
        &format!("ENTITY:{}", ignored.id),
    ).unwrap().unwrap();
    independent.impacts.push(CoauthorImpactInput {
        item_ids: vec!["unselected".into()], key: evidence.key, revision: evidence.revision,
        quote: "原设定".into(), reason: "只有未采用的设定引起的线索，不应保存为已生效影响。".into(),
    });
    let independent = manager.prepare_coauthor_changeset(&scope, independent, None).unwrap();
    manager.commit_coauthor_changeset(&scope, independent.id, 1, vec!["draft".into()]).unwrap();
    assert_eq!(count(&manager, "coauthor_impacts"), 1);
    assert_eq!(manager.list_plan_nodes().unwrap().len(), 1);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stale_draft_or_target_rejects_the_entire_group() {
    for mutate_draft in [true, false] {
        let (mut manager, root, scope) = project();
        let input = request(&mut manager, &scope);
        let changes = manager
            .prepare_coauthor_changeset(&scope, input, None)
            .unwrap();
        if mutate_draft {
            let current = manager.coauthor_state(&scope).unwrap().document;
            manager
                .save_coauthor_document(
                    &scope,
                    CoauthorDocument {
                        content: "作者的新结尾。".into(),
                        ..current
                    },
                )
                .unwrap();
        } else {
            let target_id: Uuid = changes.items[1]
                .document
                .target_key
                .as_ref()
                .unwrap()
                .strip_prefix("ENTITY:")
                .unwrap()
                .parse()
                .unwrap();
            let target = manager
                .list_entities(false)
                .unwrap()
                .into_iter()
                .find(|e| e.id == target_id)
                .unwrap();
            manager
                .upsert_entity(EntityInput {
                    id: Some(target.id),
                    entity_type: EntityType::Concept,
                    name: "修炼体系".into(),
                    aliases: vec![],
                    description: "其他编辑器中的新规则".into(),
                    fixed_attributes_json: "{}".into(),
                    tags: vec![],
                    base_revision_id: Some(target.current_revision_id),
                    source_version: None,
                    expected_version: Some(target.version),
                })
                .unwrap();
        }
        let before = count(&manager, "entity_revisions");
        assert!(matches!(
            manager.commit_coauthor_changeset(
                &scope,
                changes.id,
                1,
                vec!["draft".into(), "realm".into()],
            ),
            Err(CoauthorError::Conflict)
        ));
        assert_eq!(count(&manager, "entity_revisions"), before);
        assert_eq!(manager.list_plan_nodes().unwrap().len(), 0);
        assert_eq!(count(&manager, "coauthor_impacts"), 0);
        assert_eq!(
            manager
                .coauthor_changeset(&scope, changes.id)
                .unwrap()
                .status,
            "PENDING"
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn later_item_or_impact_failure_rolls_back_earlier_writes_draft_link_and_receipt() {
    for table in ["entity_revisions", "coauthor_impacts"] {
        let (mut manager, root, scope) = project();
        let input = request(&mut manager, &scope);
        let changes = manager
            .prepare_coauthor_changeset(&scope, input, None)
            .unwrap();
        let base = manager.coauthor_state(&scope).unwrap().document;
        let revisions = count(&manager, "entity_revisions");
        manager
            .current
            .as_ref()
            .unwrap()
            .database
            .connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_composite BEFORE INSERT ON {table}
                BEGIN SELECT RAISE(ABORT,'injected failure'); END;"
            ))
            .unwrap();
        assert!(
            manager
                .commit_coauthor_changeset(
                    &scope,
                    changes.id,
                    1,
                    vec!["draft".into(), "realm".into()],
                )
                .is_err()
        );
        assert_eq!(count(&manager, "entity_revisions"), revisions);
        assert_eq!(count(&manager, "coauthor_publications"), 0);
        assert_eq!(count(&manager, "manuscript_revisions"), 0);
        assert_eq!(count(&manager, "coauthor_impacts"), 0);
        assert_eq!(manager.list_plan_nodes().unwrap().len(), 0);
        assert_eq!(manager.coauthor_state(&scope).unwrap().document, base);
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[test]
fn invalid_graphs_duplicate_targets_and_forged_impacts_never_persist() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    for variant in 0..5 {
        let mut invalid = input.clone();
        match variant {
            0 => invalid.items[0].id = "draft".into(),
            1 => invalid.items[0].depends_on = vec!["draft".into()],
            2 => invalid.draft_depends_on = vec!["missing".into()],
            3 => invalid.impacts[0].quote = "不在原文中的引用".into(),
            _ => {
                let mut item = invalid.items[0].clone();
                item.id = "another".into();
                invalid.items.push(item);
            }
        }
        assert!(
            manager
                .prepare_coauthor_changeset(&scope, invalid, None)
                .is_err()
        );
    }
    assert_eq!(count(&manager, "coauthor_changesets"), 0);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn impacts_require_reasons_use_cas_keep_history_and_report_changed_evidence() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    manager
        .commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into()])
        .unwrap();
    let impact = manager
        .coauthor_changes(&scope, 0, 0)
        .unwrap()
        .impacts
        .remove(0);
    assert!(!impact.source_changed);
    assert!(
        manager
            .update_coauthor_impact(&scope, impact.id, 1, "RESOLVED", "")
            .is_err()
    );
    let resolved = manager
        .update_coauthor_impact(
            &scope,
            impact.id,
            1,
            "ACCEPTED_DIFFERENCE",
            "保留旧章作为主角误以为仍记得的描写。",
        )
        .unwrap();
    assert_eq!(resolved.version, 2);
    assert!(matches!(
        manager.update_coauthor_impact(&scope, impact.id, 1, "RESOLVED", "旧请求",),
        Err(CoauthorError::Conflict)
    ));
    assert_eq!(count(&manager, "coauthor_impact_revisions"), 2);
    let target_id: Uuid = impact
        .evidence
        .key
        .strip_prefix("ENTITY:")
        .unwrap()
        .parse()
        .unwrap();
    let target = manager
        .list_entities(false)
        .unwrap()
        .into_iter()
        .find(|e| e.id == target_id)
        .unwrap();
    manager
        .upsert_entity(EntityInput {
            id: Some(target.id),
            entity_type: EntityType::Concept,
            name: "旧章节规则".into(),
            aliases: vec![],
            description: "改写后的旧章".into(),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: Some(target.current_revision_id),
            source_version: None,
            expected_version: Some(target.version),
        })
        .unwrap();
    assert!(manager.coauthor_changes(&scope, 0, 0).unwrap().impacts[0].source_changed);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn changes_are_branch_and_project_scoped_and_run_cannot_self_commit() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let run = manager
        .start_coauthor_run(
            &scope,
            Uuid::new_v4(),
            "采用并更新设定",
            input.expected_document_version,
        )
        .unwrap();
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, Some(run.id))
        .unwrap();
    assert!(
        manager
            .commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into()])
            .is_err()
    );
    let branch = manager
        .fork_coauthor_session(&scope, "另一分支".into())
        .unwrap();
    let other = CoauthorScope {
        session_id: branch.id,
        ..scope.clone()
    };
    assert!(
        manager
            .coauthor_changes(&other, 0, 0)
            .unwrap()
            .change_sets
            .is_empty()
    );
    assert!(manager.coauthor_changeset(&other, changes.id).is_err());
    assert!(
        manager
            .commit_coauthor_changeset(&other, changes.id, 1, vec!["realm".into()])
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(matches!(
        manager.coauthor_changes(&wrong, 0, 0),
        Err(CoauthorError::WrongProject)
    ));
    manager.cancel_coauthor_run(&scope, run.id).unwrap();
    assert_eq!(count(&manager, "coauthor_publications"), 0);
    assert!(
        manager
            .commit_coauthor_changeset(&scope, changes.id, 1, vec!["realm".into()])
            .is_ok()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stale_impact_evidence_prevents_every_formal_write() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    let key = &changes.impacts[0].key;
    manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute(
            "UPDATE entities SET lifecycle_status='ARCHIVED' WHERE id=?1",
            [key.strip_prefix("ENTITY:").unwrap()],
        )
        .unwrap();
    assert!(
        manager
            .commit_coauthor_changeset(&scope, changes.id, 1, vec!["draft".into(), "realm".into()])
            .is_err()
    );
    assert_eq!(count(&manager, "coauthor_publications"), 0);
    assert_eq!(count(&manager, "manuscript_revisions"), 0);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn migration_53_failure_rolls_back_and_retry_preserves_author_documents() {
    let (manager, root, scope) = project();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection.execute_batch(
        "DROP TABLE coauthor_impact_revisions; DROP TABLE coauthor_impacts; DROP TABLE coauthor_changesets;
         DELETE FROM schema_migrations WHERE version=53;
         CREATE TRIGGER fail_53 BEFORE INSERT ON schema_migrations WHEN NEW.version=53
         BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
    ).unwrap();
    assert!(db.migrate_coauthor_changes().is_err());
    assert_eq!(db.health().unwrap().schema_version, 52);
    assert!(db.connection.is_autocommit());
    assert!(
        db.connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE name='coauthor_changesets'",
                [],
                |row| row.get::<_, String>(0)
            )
            .optional()
            .unwrap()
            .is_none()
    );
    db.connection.execute_batch("DROP TRIGGER fail_53").unwrap();
    db.migrate_coauthor_changes().unwrap();
    assert_eq!(manager.coauthor_state(&scope).unwrap().document.version, 0);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn synthetic_project_backup_restores_pending_and_committed_changes_impacts_and_receipts() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let committed = manager
        .prepare_coauthor_changeset(&scope, input.clone(), None)
        .unwrap();
    let pending = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    manager
        .commit_coauthor_changeset(
            &scope,
            committed.id,
            1,
            vec!["draft".into(), "realm".into()],
        )
        .unwrap();
    let impact = manager
        .coauthor_changes(&scope, 0, 0)
        .unwrap()
        .impacts
        .remove(0);
    manager
        .update_coauthor_impact(
            &scope,
            impact.id,
            1,
            "ACCEPTED_DIFFERENCE",
            "保留旧章的限知视角。",
        )
        .unwrap();
    let draft = manager.coauthor_state(&scope).unwrap().document;
    manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let snapshot = root.join("snapshots").join(job.id.to_string());
    let recovered = root.with_file_name(format!("coauthor-restore-{}", Uuid::new_v4()));
    manager
        .restore_backup_to_new_project(&snapshot, &recovered)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&recovered).unwrap();
    assert_eq!(restored.coauthor_state(&scope).unwrap().document, draft);
    assert_eq!(
        restored
            .coauthor_changeset(&scope, pending.id)
            .unwrap()
            .status,
        "PENDING"
    );
    assert_eq!(
        restored
            .coauthor_changeset(&scope, committed.id)
            .unwrap()
            .status,
        "COMMITTED"
    );
    assert_eq!(
        restored.coauthor_changes(&scope, 0, 0).unwrap().impacts[0].resolution,
        "保留旧章的限知视角。"
    );
    let result = restored
        .commit_coauthor_changeset(
            &scope,
            committed.id,
            1,
            vec!["draft".into(), "realm".into()],
        )
        .unwrap();
    assert_eq!(result.published.len(), 2);
    assert_eq!(restored.list_plan_nodes().unwrap().len(), 1);
    assert_eq!(count(&restored, "coauthor_impact_revisions"), 2);
    drop(restored);
    drop(manager);
    let _ = std::fs::remove_dir_all(recovered);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn impact_paging_does_not_claim_or_return_the_entire_history() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    for _ in 0..23 {
        manager
            .prepare_coauthor_changeset(&scope, input.clone(), None)
            .unwrap();
    }
    let first = manager.coauthor_changes(&scope, 0, 0).unwrap();
    assert_eq!(first.change_sets.len(), 20);
    assert!(first.has_more_changes);
    let next = manager.coauthor_changes(&scope, 20, 0).unwrap();
    assert_eq!(next.change_sets.len(), 3);
    assert!(!next.has_more_changes);
    assert!(
        next.change_sets
            .iter()
            .all(|entry| !first.change_sets.iter().any(|old| old.id == entry.id))
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn discarded_changes_preserve_proposal_but_cannot_commit_or_block_independent_publication() {
    let (mut manager, root, scope) = project();
    let input = request(&mut manager, &scope);
    let changes = manager
        .prepare_coauthor_changeset(&scope, input, None)
        .unwrap();
    assert!(
        manager
            .publish_coauthor_document(&scope, changes.base_document.version)
            .is_err()
    );
    let abandoned = manager
        .discard_coauthor_changeset(&scope, changes.id, 1)
        .unwrap();
    assert_eq!(abandoned.items.len(), 2);
    assert_eq!(abandoned.status, "DISCARDED");
    assert_eq!(
        manager
            .discard_coauthor_changeset(&scope, changes.id, 1)
            .unwrap()
            .version,
        2
    );
    assert!(manager.discard_coauthor_changeset(&scope, changes.id, i64::MAX).is_err());
    assert!(
        manager
            .commit_coauthor_changeset(&scope, changes.id, 2, vec!["realm".into()])
            .is_err()
    );
    assert_eq!(count(&manager, "coauthor_publications"), 0);
    assert!(
        manager
            .publish_coauthor_document(&scope, changes.base_document.version)
            .is_ok()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn manuscript_impact_preserves_actual_rich_text_and_never_updates_story_facts() {
    let (mut manager, root, scope) = project();
    let mut input = request(&mut manager, &scope);
    let chapter = manager.create_plan_node(None, PlanNodeKind::Chapter, "旧章".into()).unwrap();
    let rich = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"original"},"content":[{"type":"text","marks":[{"type":"bold"}],"text":"他还记得母亲的声音。"}]}]}"#;
    let revision = manager.save_manuscript(chapter.id, rich.into(), "AUTHOR".into()).unwrap();
    let source = manager.current.as_ref().unwrap().database.coauthor_source(
        &format!("MANUSCRIPT:{}", chapter.id),
    ).unwrap().unwrap();
    input.impacts = vec![CoauthorImpactInput {
        key: source.key, revision: source.revision, quote: "还记得母亲的声音".into(),
        reason: "复查旧章是否位于突破之前".into(), item_ids: vec!["realm".into()],
    }];
    let changes = manager.prepare_coauthor_changeset(&scope, input, None).unwrap();
    manager.commit_coauthor_changeset(&scope, changes.id, 1, vec!["draft".into(), "realm".into()]).unwrap();
    assert_eq!(manager.current_manuscript(chapter.id).unwrap().unwrap(), revision);
    let todo = manager.coauthor_changes(&scope, 0, 0).unwrap().impacts.remove(0);
    assert_eq!(todo.title, "旧章");
    assert_eq!(todo.evidence.key, format!("MANUSCRIPT:{}", chapter.id));
    assert!(!todo.source_changed);
    assert!(manager.list_current_facts().unwrap().is_empty());
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
