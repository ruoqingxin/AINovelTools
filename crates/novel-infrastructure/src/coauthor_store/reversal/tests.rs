use super::*;
use crate::coauthor_store::tests::project;
use serde_json::json;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    before_entity: Entity,
    changes: CoauthorChangeSet,
}

impl Fixture {
    fn new() -> Self {
        let (mut manager, root, scope) = project();
        let draft = manager.coauthor_state(&scope).unwrap().document;
        let saved = manager
            .save_coauthor_document(
                &scope,
                CoauthorDocument {
                    kind: CoauthorDocumentKind::Manuscript,
                    title: "突破".into(),
                    content: "他忘了声音。".into(),
                    ..draft
                },
            )
            .unwrap();
        let before_entity = manager
            .upsert_entity(EntityInput {
                id: None,
                entity_type: EntityType::Concept,
                name: "原体系".into(),
                description: "突破消耗寿元。".into(),
                aliases: vec!["修行等级".into()],
                tags: vec!["修炼".into(), "代价".into()],
                fixed_attributes_json: r#"{"settingScope":"CHAPTER","exception":"主角除外"}"#
                    .into(),
                base_revision_id: None,
                source_version: None,
                expected_version: None,
            })
            .unwrap();
        let db = &manager.current.as_ref().unwrap().database;
        let proposal = Uuid::new_v4().to_string();
        db.connection
            .execute(
                "INSERT INTO discussion_design_proposals
            (id,session_id,workspace_version,entities_json,source_message_ids_json,context_version)
            VALUES (?1,?2,0,'[]','[]','test')",
                rusqlite::params![proposal, scope.session_id.to_string()],
            )
            .unwrap();
        db.connection
            .execute(
                "INSERT INTO author_settings
            (id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
            VALUES (?1,?2,?3,?4,'主角代价尚未公开','AUTHOR_ONLY',?5)",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    scope.project_id.to_string(),
                    before_entity.id.to_string(),
                    before_entity.current_revision_id.to_string(),
                    proposal
                ],
            )
            .unwrap();
        let source = manager
            .current
            .as_ref()
            .unwrap()
            .database
            .coauthor_source(&format!("ENTITY:{}", before_entity.id))
            .unwrap()
            .unwrap();
        let changes = manager
            .prepare_coauthor_changeset(
                &scope,
                CoauthorChangeRequest {
                    expected_document_version: saved.version,
                    title: "采用失忆版本".into(),
                    include_draft: true,
                    draft_depends_on: vec!["realm".into()],
                    items: vec![CoauthorChangeItemInput {
                        id: "realm".into(),
                        kind: CoauthorDocumentKind::Setting,
                        title: "新体系".into(),
                        content: "突破消耗记忆。".into(),
                        target_key: Some(source.key),
                        target_revision: Some(source.revision),
                        depends_on: vec![],
                        manuscript_edits: vec![],
                    }],
                    impacts: vec![],
                    coverage: "未检查全书。".into(),
                },
                None,
            )
            .unwrap();
        let changes = manager
            .commit_coauthor_changeset(&scope, changes.id, 1, vec!["draft".into(), "realm".into()])
            .unwrap();
        Self {
            manager,
            root,
            scope,
            before_entity,
            changes,
        }
    }
    fn db(&self) -> &Database {
        &self.manager.current.as_ref().unwrap().database
    }
    fn preview(&mut self) -> CoauthorReversal {
        let version = self
            .manager
            .coauthor_state(&self.scope)
            .unwrap()
            .document
            .version;
        self.manager
            .prepare_coauthor_reversal(&self.scope, self.changes.id, 2, version)
            .unwrap()
    }
    fn commit(&mut self, version: i64) -> Result<CoauthorReversal, CoauthorError> {
        self.manager
            .commit_coauthor_reversal(&self.scope, self.changes.id, version)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn reversal_restores_existing_setting_archives_new_chapter_preserves_history_and_is_idempotent() {
    let mut f = Fixture::new();
    let preview = f.preview();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    assert_eq!(preview.items.len(), 2);
    assert_eq!(preview.items[0].action, "ARCHIVE");
    assert!(
        preview.items[1]
            .after
            .as_ref()
            .unwrap()
            .content
            .contains("寿元")
    );
    let receipt = f.commit(preview.version).unwrap();
    assert_eq!(receipt.status, "COMMITTED");
    let setting = f
        .db()
        .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
        .unwrap()
        .unwrap();
    assert_eq!(setting.title, "原体系");
    assert!(setting.content.contains("寿元"));
    let original = f.db().coauthor_native_snapshot(&setting.key).unwrap();
    assert_eq!(original["revision"]["aliases_json"], r#"["修行等级"]"#);
    assert_eq!(original["revision"]["tags_json"], r#"["修炼","代价"]"#);
    assert_eq!(
        original["revision"]["fixed_attributes_json"],
        r#"{"settingScope":"CHAPTER","exception":"主角除外"}"#
    );
    assert_eq!(original["rules"][0]["content"], "主角代价尚未公开");
    assert_eq!(original["rules"][0]["visibility"], "AUTHOR_ONLY");
    assert_ne!(
        original["revision"]["id"],
        f.before_entity.current_revision_id.to_string()
    );
    let nodes = f.manager.list_plan_nodes().unwrap();
    assert!(nodes[0].archived);
    assert_eq!(
        f.manager
            .list_manuscript_revisions(nodes[0].id)
            .unwrap()
            .len(),
        1
    );
    let restored = f.manager.coauthor_state(&f.scope).unwrap().document;
    assert_eq!(restored.content, f.changes.base_document.content);
    assert_eq!(restored.target_key, None);
    assert_eq!(restored.version, preview.base_document.version + 1);
    assert_eq!(f.commit(preview.version).unwrap(), receipt);
    assert_eq!(
        f.manager
            .coauthor_changeset(&f.scope, f.changes.id)
            .unwrap()
            .reversed_by,
        Some(receipt.id)
    );
    assert!(
        f.manager
            .commit_coauthor_changeset(&f.scope, f.changes.id, 1, f.changes.selected_ids.clone())
            .is_err()
    );
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    assert_eq!(
        f.manager
            .get_coauthor_reversal(&f.scope, f.changes.id)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn changed_working_draft_and_native_source_never_get_overwritten() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let doc = f.manager.coauthor_state(&f.scope).unwrap().document;
    let saved = f
        .manager
        .save_coauthor_document(
            &f.scope,
            CoauthorDocument {
                content: "作者的新文字。".into(),
                ..doc
            },
        )
        .unwrap();
    assert!(f.commit(preview.version).is_err());
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, saved);
    assert!(!f.preview().blockers.is_empty());
    assert!(!f.manager.list_plan_nodes().unwrap()[0].archived);

    let mut g = Fixture::new();
    let preview = g.preview();
    let chapter = g.manager.list_plan_nodes().unwrap()[0].id;
    let current = g.manager.current_manuscript(chapter).unwrap().unwrap();
    g.manager
        .save_manuscript(
            chapter,
            current.document_json.clone(),
            "相同文字的新修订".into(),
        )
        .unwrap();
    assert!(g.commit(preview.version).is_err());
    assert!(
        g.preview()
            .blockers
            .iter()
            .any(|message| message.contains("采用后已有编辑"))
    );
}

#[test]
fn manuscript_editor_draft_even_if_discarded_and_new_children_block_archival() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let chapter = f.manager.list_plan_nodes().unwrap()[0].id;
    let current = f.manager.current_manuscript(chapter).unwrap().unwrap();
    let draft = f
        .manager
        .save_manuscript_draft(chapter, Some(current.id), current.document_json, 0)
        .unwrap();
    assert!(f.commit(preview.version).is_err());
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("未提交"))
    );
    f.manager
        .discard_manuscript_draft(chapter, draft.version)
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("采用后已有编辑"))
    );
}

#[test]
fn a_later_adoption_with_read_evidence_is_an_explicit_consumer_and_must_be_handled_first() {
    let mut f = Fixture::new();
    let run = f
        .manager
        .start_coauthor_run(
            &f.scope,
            Uuid::new_v4(),
            "仅创建另一个设定",
            f.changes.base_document.version + 1,
        )
        .unwrap();
    let source = f
        .db()
        .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
        .unwrap()
        .unwrap();
    let audit = vec![json!({"kind":"tool","name":"read_source","result":source})];
    f.manager
        .finish_coauthor_run(&f.scope, run.id, "COMPLETED", "参考新体系", &audit)
        .unwrap();
    let dependent = f
        .manager
        .prepare_coauthor_changeset(
            &f.scope,
            CoauthorChangeRequest {
                expected_document_version: f.changes.base_document.version + 1,
                title: "后续设定".into(),
                include_draft: false,
                draft_depends_on: vec![],
                items: vec![CoauthorChangeItemInput {
                    id: "new".into(),
                    kind: CoauthorDocumentKind::Setting,
                    title: "相关规则".into(),
                    content: "引用失忆代价".into(),
                    target_key: None,
                    target_revision: None,
                    depends_on: vec![],
                    manuscript_edits: vec![],
                }],
                impacts: vec![],
                coverage: "只读体系".into(),
            },
            None,
        )
        .unwrap();
    // Bind the real completed run as a persisted provenance record.
    let mut payload = dependent.clone();
    payload.run_id = Some(run.id);
    f.db()
        .connection
        .execute(
            "UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
            rusqlite::params![dependent.id.to_string(), encode(&payload).unwrap()],
        )
        .unwrap();
    f.manager
        .commit_coauthor_changeset(&f.scope, dependent.id, 1, vec!["new".into()])
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("其他未撤销的采用"))
    );
}

#[test]
fn unselected_impact_proposals_do_not_become_formal_consumers() {
    let mut f = Fixture::new();
    let source = f.db().coauthor_source(&format!("ENTITY:{}",f.before_entity.id)).unwrap().unwrap();
    let mut input = new_setting_request(f.manager.coauthor_state(&f.scope).unwrap().document.version);
    input.items.push(CoauthorChangeItemInput { id:"unused".into(),..input.items[0].clone() });
    input.impacts = vec![CoauthorImpactInput {
        item_ids:vec!["unused".into()],key:source.key,revision:source.revision,
        quote:"突破".into(),reason:"未采用方案的复查建议".into(),
    }];
    let changes = f.manager.prepare_coauthor_changeset(&f.scope,input,None).unwrap();
    f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["new".into()]).unwrap();
    assert!(f.preview().blockers.is_empty());
}

#[test]
fn late_reversal_write_failure_rolls_back_settings_chapter_draft_receipt_and_indexes() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let before = f.manager.coauthor_state(&f.scope).unwrap().document;
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_reverse_archive BEFORE UPDATE ON plan_nodes
        WHEN NEW.archived=1 BEGIN SELECT RAISE(ABORT,'test'); END;",
        )
        .unwrap();
    assert!(f.commit(preview.version).is_err());
    assert!(
        f.db()
            .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
            .unwrap()
            .unwrap()
            .content
            .contains("记忆")
    );
    assert!(!f.manager.list_plan_nodes().unwrap()[0].archived);
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, before);
    assert_eq!(
        f.manager
            .get_coauthor_reversal(&f.scope, f.changes.id)
            .unwrap()
            .unwrap()
            .status,
        "PENDING"
    );
    assert!(
        f.manager
            .coauthor_changeset(&f.scope, f.changes.id)
            .unwrap()
            .reversed_by
            .is_none()
    );
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail_reverse_archive")
        .unwrap();
    f.commit(preview.version).unwrap();
}

#[test]
fn previews_are_versioned_and_cannot_be_reused_across_sessions_projects_or_pending_sets() {
    let mut f = Fixture::new();
    let first = f.preview();
    let second = f.preview();
    assert_eq!(first.id, second.id);
    assert_eq!(second.version, first.version + 1);
    assert!(f.commit(first.version).is_err());
    let other = f
        .manager
        .create_discussion_session("其他讨论".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let other_scope = CoauthorScope {
        session_id: other.id,
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .get_coauthor_reversal(&other_scope, f.changes.id)
            .unwrap()
            .is_none()
    );
    assert!(
        f.manager
            .commit_coauthor_reversal(&other_scope, f.changes.id, second.version)
            .is_err()
    );
    assert!(
        f.manager
            .prepare_coauthor_reversal(&other_scope, f.changes.id, 2, 0)
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .commit_coauthor_reversal(&wrong, f.changes.id, second.version)
            .is_err()
    );
}

#[test]
fn migration_54_is_atomic_retryable_and_preserves_prior_author_data() {
    let f = Fixture::new();
    let before = f.manager.coauthor_state(&f.scope).unwrap().document;
    f.db().connection.execute_batch("DROP TABLE coauthor_reversals; DELETE FROM schema_migrations WHERE version=54;
        CREATE TRIGGER fail54 BEFORE INSERT ON schema_migrations WHEN NEW.version=54 BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(f.db().migrate_coauthor_reversals().is_err());
    assert_eq!(f.db().health().unwrap().schema_version, 53);
    assert!(f.db().connection.is_autocommit());
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail54")
        .unwrap();
    f.db().migrate_coauthor_reversals().unwrap();
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, before);
    assert_eq!(f.manager.list_plan_nodes().unwrap().len(), 1);
}

fn new_setting_request(version: i64) -> CoauthorChangeRequest {
    CoauthorChangeRequest {
        expected_document_version: version,
        include_draft: false,
        title: "后续设定".into(),
        draft_depends_on: vec![],
        items: vec![CoauthorChangeItemInput {
            id: "new".into(),
            kind: CoauthorDocumentKind::Setting,
            title: "相关规则".into(),
            content: "突破之后不能回忆声音。".into(),
            target_key: None,
            target_revision: None,
            depends_on: vec![],
            manuscript_edits: vec![],
        }],
        impacts: vec![],
        coverage: "仅查证已读来源。".into(),
    }
}

#[test]
fn durable_read_dependencies_are_captured_and_reversal_invalidates_pending_adoption() {
    let mut f = Fixture::new();
    let other = f
        .manager
        .create_discussion_session("另一讨论".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let scope = CoauthorScope {
        session_id: other.id,
        ..f.scope.clone()
    };
    let version = f.manager.coauthor_state(&scope).unwrap().document.version;
    let run = f
        .manager
        .start_coauthor_run(&scope, Uuid::new_v4(), "参考体系", version)
        .unwrap();
    let source = f
        .db()
        .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
        .unwrap()
        .unwrap();
    // The first preparation has no durable read result. A later checkpoint supplies it.
    let no_read = f
        .manager
        .prepare_coauthor_changeset(&scope, new_setting_request(version), Some(run.id))
        .unwrap();
    assert!(no_read.read_dependencies.is_empty());
    let audit = vec![
        json!({"kind":"tool","name":"search_sources","result":{"key":"not-a-read","revision":"x"}}),
        json!({"kind":"tool","name":"read_source","result":source}),
        json!({"kind":"tool","name":"read_source","result":source}),
    ];
    f.manager
        .checkpoint_coauthor_run(&scope, run.id, "", &audit)
        .unwrap();
    let dependent = f
        .manager
        .prepare_coauthor_changeset(&scope, new_setting_request(version), Some(run.id))
        .unwrap();
    assert_eq!(dependent.read_dependencies.len(), 1);
    assert_eq!(dependent.read_dependencies[0].revision, source.revision);
    f.manager
        .finish_coauthor_run(&scope, run.id, "COMPLETED", "", &audit)
        .unwrap();
    let preview = f.preview();
    assert!(preview.blockers.is_empty());
    f.commit(preview.version).unwrap();
    assert!(
        matches!(f.manager.commit_coauthor_changeset(&scope, dependent.id, 1, vec!["new".into()]),
        Err(CoauthorError::Invalid(message)) if message.contains("读取的来源已经变化"))
    );
}

#[test]
fn changed_source_prevents_preparation_until_the_model_reads_current_revision() {
    let mut f = Fixture::new();
    let version = f.manager.coauthor_state(&f.scope).unwrap().document.version;
    let run = f
        .manager
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "核对", version)
        .unwrap();
    let key = format!("ENTITY:{}", f.before_entity.id);
    let source = f.db().coauthor_source(&key).unwrap().unwrap();
    let audit = vec![json!({"kind":"tool","name":"read_source","result":source})];
    f.manager
        .checkpoint_coauthor_run(&f.scope, run.id, "", &audit)
        .unwrap();
    f.db()
        .connection
        .execute(
            "UPDATE entities SET version=version+1 WHERE id=?1",
            [f.before_entity.id.to_string()],
        )
        .unwrap();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, new_setting_request(version), Some(run.id))
            .is_err()
    );
    let latest = f.db().coauthor_source(&key).unwrap().unwrap();
    let audit = vec![
        audit[0].clone(),
        json!({"kind":"tool","name":"read_manuscript_blocks","result":{
        "key":latest.key,"revision":latest.revision}}),
    ];
    f.manager
        .checkpoint_coauthor_run(&f.scope, run.id, "", &audit)
        .unwrap();
    let prepared = f
        .manager
        .prepare_coauthor_changeset(&f.scope, new_setting_request(version), Some(run.id))
        .unwrap();
    assert_eq!(prepared.read_dependencies[0].revision, latest.revision);
}

#[test]
fn rich_manuscript_reversal_restores_exact_json_as_a_new_revision() {
    let mut f = Fixture::new();
    let chapter = f
        .manager
        .create_plan_node(None, PlanNodeKind::Chapter, "原章".into())
        .unwrap();
    let rich = json!({"type":"doc","content":[
        {"type":"paragraph","attrs":{"blockId":"p","textAlign":"center"},"content":[
            {"type":"text","text":"甲😀消耗寿元","marks":[{"type":"bold"}]},
            {"type":"text","text":"保留声音","marks":[{"type":"italic"}]}]},
        {"type":"horizontalRule","attrs":{"blockId":"rule"}}
    ]})
    .to_string();
    let before = f
        .manager
        .save_manuscript(chapter.id, rich.clone(), "AUTHOR".into())
        .unwrap();
    let source = f
        .db()
        .coauthor_source(&format!("MANUSCRIPT:{}", chapter.id))
        .unwrap()
        .unwrap();
    let mut request =
        new_setting_request(f.manager.coauthor_state(&f.scope).unwrap().document.version);
    request.items = vec![CoauthorChangeItemInput {
        id: "patch".into(),
        kind: CoauthorDocumentKind::Manuscript,
        title: "原章".into(),
        content: String::new(),
        target_key: Some(source.key),
        target_revision: Some(source.revision),
        depends_on: vec![],
        manuscript_edits: vec![CoauthorManuscriptEdit {
            block_id: "p".into(),
            start: 4,
            end: 6,
            before: "寿元".into(),
            after: "记忆".into(),
        }],
    }];
    let changes = f
        .manager
        .prepare_coauthor_changeset(&f.scope, request, None)
        .unwrap();
    let adopted = f
        .manager
        .commit_coauthor_changeset(&f.scope, changes.id, 1, vec!["patch".into()])
        .unwrap();
    f.changes = adopted;
    let preview = f.preview();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    assert_eq!(
        preview.items[0].after_document_json,
        Some(before.document_json.clone())
    );
    let receipt = f.commit(preview.version).unwrap();
    let current = f.manager.current_manuscript(chapter.id).unwrap().unwrap();
    assert_eq!(current.document_json, before.document_json);
    assert_ne!(current.id, before.id);
    assert_eq!(
        f.manager
            .list_manuscript_revisions(chapter.id)
            .unwrap()
            .len(),
        3
    );
    assert!(receipt.items[0].result_revision.is_some());
    assert!(
        !f.manager
            .list_plan_nodes()
            .unwrap()
            .iter()
            .find(|node| node.id == chapter.id)
            .unwrap()
            .archived
    );
}

#[test]
fn partial_adoption_reversal_archives_only_adopted_new_entity_and_outline() {
    let mut f = Fixture::new();
    let mut request =
        new_setting_request(f.manager.coauthor_state(&f.scope).unwrap().document.version);
    request.items.push(CoauthorChangeItemInput {
        id: "outline".into(),
        kind: CoauthorDocumentKind::Outline,
        title: "失忆之后".into(),
        content: "主角寻找记忆".into(),
        target_key: None,
        target_revision: None,
        depends_on: vec!["new".into()],
        manuscript_edits: vec![],
    });
    request.items.push(CoauthorChangeItemInput {
        id: "unused".into(),
        ..request.items[0].clone()
    });
    let prepared = f
        .manager
        .prepare_coauthor_changeset(&f.scope, request, None)
        .unwrap();
    f.changes = f
        .manager
        .commit_coauthor_changeset(
            &f.scope,
            prepared.id,
            1,
            vec!["new".into(), "outline".into()],
        )
        .unwrap();
    let preview = f.preview();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    assert_eq!(preview.items.len(), 2);
    assert!(preview.items.iter().all(|item| item.action == "ARCHIVE"));
    f.commit(preview.version).unwrap();
    for published in &f.changes.published {
        assert!(
            f.db()
                .coauthor_source(&published.source_key)
                .unwrap()
                .is_none()
        );
    }
    assert!(
        f.db()
            .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        f.manager
            .coauthor_changeset(&f.scope, f.changes.id)
            .unwrap()
            .selected_ids
            .len(),
        2
    );
}

#[test]
fn legacy_receipts_other_linked_drafts_running_tasks_and_new_references_block_reversal() {
    let mut f = Fixture::new();
    let original = f.changes.clone();
    let mut legacy = original.clone();
    legacy.undo.clear();
    f.db()
        .connection
        .execute(
            "UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
            rusqlite::params![legacy.id.to_string(), encode(&legacy).unwrap()],
        )
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("缺少结构校验"))
    );
    f.db()
        .connection
        .execute(
            "UPDATE coauthor_changesets SET payload=?2 WHERE id=?1",
            rusqlite::params![original.id.to_string(), encode(&original).unwrap()],
        )
        .unwrap();
    let other = f
        .manager
        .create_discussion_session("其他稿".into(), DiscussionScopeKind::Project, None, None)
        .unwrap();
    let scope = CoauthorScope {
        session_id: other.id,
        ..f.scope.clone()
    };
    let doc = f.manager.coauthor_state(&scope).unwrap().document;
    f.manager
        .save_coauthor_document(
            &scope,
            CoauthorDocument {
                target_key: Some(original.published[1].source_key.clone()),
                target_revision: Some(original.published[1].revision.clone()),
                ..doc
            },
        )
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("其他工作稿关联"))
    );
    let version = f.manager.coauthor_state(&f.scope).unwrap().document.version;
    let run = f
        .manager
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "继续", version)
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("仍在生成"))
    );
    f.manager
        .finish_coauthor_run(&f.scope, run.id, "COMPLETED", "", &[])
        .unwrap();
    let chapter = f.manager.list_plan_nodes().unwrap()[0].id;
    f.manager
        .create_plan_node(Some(chapter), PlanNodeKind::Scene, "后增子节点".into())
        .unwrap();
    assert!(
        f.preview()
            .blockers
            .iter()
            .any(|message| message.contains("结构变化"))
    );
}

#[test]
fn receipt_failure_rolls_back_every_native_revision_and_linked_draft() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let before = f.manager.coauthor_state(&f.scope).unwrap().document;
    let source = f
        .db()
        .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
        .unwrap()
        .unwrap();
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_reverse_receipt BEFORE UPDATE ON coauthor_reversals
        WHEN NEW.status='COMMITTED' BEGIN SELECT RAISE(ABORT,'test'); END;",
        )
        .unwrap();
    assert!(f.commit(preview.version).is_err());
    assert_eq!(
        f.db().coauthor_source(&source.key).unwrap().unwrap(),
        source
    );
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, before);
    assert_eq!(
        f.manager
            .list_entity_revisions(f.before_entity.id)
            .unwrap()
            .len(),
        2
    );
    assert!(!f.manager.list_plan_nodes().unwrap()[0].archived);
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail_reverse_receipt")
        .unwrap();
    f.commit(preview.version).unwrap();
}

#[test]
fn actual_backup_restores_pending_preview_and_committed_reversal_with_impact_history() {
    let mut f = Fixture::new();
    let source = f
        .db()
        .coauthor_source(&format!("ENTITY:{}", f.before_entity.id))
        .unwrap()
        .unwrap();
    let impact = CoauthorImpact {
        id: Uuid::new_v4(),
        change_set_id: f.changes.id,
        version: 2,
        title: source.title.clone(),
        evidence: CoauthorImpactInput {
            item_ids: vec!["realm".into()],
            key: source.key,
            revision: source.revision,
            quote: "突破".into(),
            reason: "复查旧规则".into(),
        },
        status: "ACCEPTED_DIFFERENCE".into(),
        resolution: "保留角色误解".into(),
        source_changed: false,
        origin_reversed: false,
    };
    f.db()
        .connection
        .execute(
            "INSERT INTO coauthor_impacts VALUES (?1,?2,2,?3)",
            rusqlite::params![
                impact.id.to_string(),
                f.scope.session_id.to_string(),
                encode(&impact).unwrap()
            ],
        )
        .unwrap();
    f.db()
        .connection
        .execute(
            "INSERT INTO coauthor_impact_revisions VALUES (?1,2,?2)",
            rusqlite::params![impact.id.to_string(), encode(&impact).unwrap()],
        )
        .unwrap();
    let preview = f.preview();
    for committed in [false, true] {
        if committed {
            f.commit(preview.version).unwrap();
        }
        f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
        let job = f.manager.run_next_job().unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
        let snapshot = f.root.join("snapshots").join(job.id.to_string());
        let recovered = f
            .root
            .with_file_name(format!("coauthor-reversal-restore-{}", Uuid::new_v4()));
        f.manager
            .restore_backup_to_new_project(&snapshot, &recovered)
            .unwrap();
        let mut restored = ProjectManager::new();
        restored.open(&recovered).unwrap();
        let actual = restored
            .get_coauthor_reversal(&f.scope, f.changes.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            actual.status,
            if committed { "COMMITTED" } else { "PENDING" }
        );
        let todo = restored
            .coauthor_changes(&f.scope, 0, 0)
            .unwrap()
            .impacts
            .remove(0);
        assert_eq!(todo.status, impact.status);
        assert_eq!(todo.resolution, impact.resolution);
        assert_eq!(todo.version, 2);
        assert_eq!(todo.origin_reversed, committed);
        let receipt = restored
            .commit_coauthor_reversal(&f.scope, f.changes.id, preview.version)
            .unwrap();
        assert_eq!(receipt.status, "COMMITTED");
        restored.close();
        let _ = std::fs::remove_dir_all(recovered);
    }
}
