use super::*;
use crate::coauthor_store::tests::project;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    child: CoauthorScope,
    target: CoauthorDecision,
    source: CoauthorDecision,
}

fn create(manager: &mut ProjectManager, scope: &CoauthorScope, topic: &str) -> CoauthorDecision {
    let version = manager.coauthor_document(scope).unwrap().version;
    let run = manager.start_coauthor_run(scope,Uuid::new_v4(),"否定消耗寿元",version).unwrap();
    let decision = manager.set_coauthor_decision(scope,run.id,CoauthorDecisionInput {
        decision_id:None,expected_version:0,topic:topic.into(),aliases:vec![],
        content:"消耗寿元".into(),status:"REJECTED".into(),quote:"否定消耗寿元".into(),
    }).unwrap();
    manager.finish_coauthor_run(scope,run.id,"COMPLETED","",&[]).unwrap();
    decision
}

impl Fixture {
    fn new() -> Self {
        let (mut manager,root,scope) = project();
        let target = create(&mut manager,&scope,"突破代价");
        let branch = manager.fork_coauthor_session(&scope,"失忆分支".into()).unwrap();
        let child = CoauthorScope { session_id:branch.id,..scope.clone() };
        let copied = manager.search_coauthor_decisions(&child,"",0).unwrap().memories.remove(0).decision;
        let source = manager.correct_coauthor_decision(&child,copied.id,copied.version,"失去😀记忆","CHOSEN").unwrap();
        Self { manager,root,scope,child,target,source }
    }
    fn db(&self) -> &Database { &self.manager.current.as_ref().unwrap().database }
    fn input(&self) -> CoauthorBranchDecisionInput {
        CoauthorBranchDecisionInput {
            source_session_id:self.child.session_id,source_decision_id:self.source.id,source_version:self.source.version,
            target_decision_id:Some(self.target.id),expected_version:self.target.version,
        }
    }
    fn prepare(&mut self) -> CoauthorBranchDecisionAdoption {
        let input=self.input();
        self.manager.prepare_coauthor_branch_decision(&self.scope,input).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn author_preview_then_apply_updates_exact_local_decision_and_records_local_authorization() {
    let mut f=Fixture::new();
    let doc=f.manager.coauthor_document(&f.scope).unwrap();
    let preview=f.prepare();
    assert_eq!(preview.before.as_ref().unwrap().decision.status,"REJECTED");
    assert_eq!(preview.after.decision.status,"CHOSEN");
    assert_eq!(f.manager.search_coauthor_decisions(&f.scope,"",0).unwrap().memories[0].decision,f.target);
    let applied=f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    assert_eq!(applied.status,"APPLIED");
    let history=f.manager.list_coauthor_decision_history(&f.scope,f.target.id,None).unwrap();
    assert_eq!(history.revisions.len(),2);
    assert_eq!(history.current,applied.after);
    assert_eq!(history.current.decision.topic,f.target.topic);
    assert_eq!(f.manager.search_coauthor_decisions(&f.child,"",0).unwrap().memories[0].decision,f.source);
    let (session,role,text):(String,String,String)=f.db().connection.query_row(
        "SELECT session_id,role,content FROM discussion_messages WHERE id=?1",
        [applied.after.decision.source_message_id.to_string()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(session,f.scope.session_id.to_string());
    assert_eq!(role,"USER");
    assert!(text.contains("作者确认采用分支") && text.contains("失去😀记忆"));
    assert_ne!(applied.after.decision.source_message_id,f.source.source_message_id);
    let context=f.manager.coauthor_message_decision_context(&f.scope,f.target.source_message_id).unwrap().unwrap();
    assert!(context.guards[0].superseded);
    assert_eq!(context.guards[0].current,applied.after.decision);
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),doc);
    assert!(f.manager.list_current_facts().unwrap().is_empty());
}

#[test]
fn new_decision_copies_source_status_and_aliases_but_never_duplicates_an_existing_alias() {
    let mut f=Fixture::new();
    let mut input=f.input();input.target_decision_id=None;input.expected_version=0;
    assert!(f.manager.prepare_coauthor_branch_decision(&f.scope,input).is_err());
    for status in ["CHOSEN","REJECTED","OPEN","WITHDRAWN"] {
        let source=create(&mut f.manager,&f.child,&format!("新规则{status}"));
        let source=f.manager.correct_coauthor_decision(&f.child,source.id,1,"新规则内容",status).unwrap();
        let preview=f.manager.prepare_coauthor_branch_decision(&f.scope,CoauthorBranchDecisionInput {
            source_session_id:f.child.session_id,source_decision_id:source.id,source_version:source.version,
            target_decision_id:None,expected_version:0,
        }).unwrap();
        let applied=f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
        assert_eq!(applied.after.decision.status,status);
        assert_ne!(applied.after.decision.id,source.id);
        assert_eq!(applied.after.decision.version,1);
        assert_eq!(applied.after.aliases,vec![format!("新规则{status}")]);
    }
}

#[test]
fn explicit_target_identity_keeps_local_topic_aliases_and_legacy_ambiguity_without_hijacking() {
    let mut f=Fixture::new();
    let other=create(&mut f.manager,&f.scope,"另一个对象");
    f.db().connection.execute(
        "INSERT INTO coauthor_decision_aliases VALUES(?1,?2,?3,?4)",
        rusqlite::params![f.scope.session_id.to_string(),"突破代价",other.id.to_string(),"突破代价"],
    ).unwrap();
    let source=create(&mut f.manager,&f.child,"来源另称");
    let source=f.manager.correct_coauthor_decision(&f.child,source.id,1,"来源新内容","OPEN").unwrap();
    let mut input=f.input();input.source_decision_id=source.id;input.source_version=source.version;
    let preview=f.manager.prepare_coauthor_branch_decision(&f.scope,input).unwrap();
    assert_eq!(preview.after.decision.topic,"突破代价");
    assert_eq!(preview.after.aliases,vec!["突破代价"]);
    f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    let other_history=f.manager.list_coauthor_decision_history(&f.scope,other.id,None).unwrap();
    assert_eq!(other_history.current.decision,other);
    assert!(other_history.current.aliases.contains(&"突破代价".into()));
    let count:i64=f.db().connection.query_row(
        "SELECT COUNT(*) FROM coauthor_decision_aliases WHERE session_id=?1 AND alias_key='来源另称'",
        [f.scope.session_id.to_string()],|row|row.get(0),
    ).unwrap();
    assert_eq!(count,0);
}

#[test]
fn source_or_target_changes_even_to_same_text_invalidate_pending_previews() {
    for change_source in [false,true] {
        let mut f=Fixture::new();
        let preview=f.prepare();
        let (scope,decision)=if change_source {(&f.child,&f.source)} else {(&f.scope,&f.target)};
        f.manager.correct_coauthor_decision(scope,decision.id,decision.version,&decision.content,&decision.status).unwrap();
        assert!(f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).is_err());
        assert_eq!(f.manager.get_coauthor_branch_decision(&f.scope,preview.id).unwrap().status,"PENDING");
    }
}

#[test]
fn equal_content_and_status_is_a_noop_and_unreviewed_result_fields_are_not_accepted() {
    let mut f=Fixture::new();
    f.manager.correct_coauthor_decision(&f.scope,f.target.id,1,&f.source.content,&f.source.status).unwrap();
    let mut input=f.input();input.expected_version=2;
    assert!(f.manager.prepare_coauthor_branch_decision(&f.scope,input).is_err());
    let payload=serde_json::json!({
        "sourceSessionId":f.child.session_id,"sourceDecisionId":f.source.id,"sourceVersion":2,
        "targetDecisionId":f.target.id,"expectedVersion":2,"content":"未经预览的文字"
    });
    assert!(serde_json::from_value::<CoauthorBranchDecisionInput>(payload).is_err());
    assert!(f.manager.list_coauthor_branch_decision_adoptions(&f.scope,0).unwrap().adoptions.is_empty());
}

#[test]
fn active_runs_on_either_side_block_preparation_and_application() {
    for source_active in [false,true] {
        let mut f=Fixture::new();
        let preview=f.prepare();
        let scope=if source_active {&f.child} else {&f.scope};
        let version=f.manager.coauthor_document(scope).unwrap().version;
        let run=f.manager.start_coauthor_run(scope,Uuid::new_v4(),"继续",version).unwrap();
        let input=f.input();
        assert!(f.manager.prepare_coauthor_branch_decision(&f.scope,input).is_err());
        assert!(f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).is_err());
        f.manager.finish_coauthor_run(scope,run.id,"COMPLETED","",&[]).unwrap();
        assert_eq!(f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap().status,"APPLIED");
    }
}

#[test]
fn receipts_are_scope_checked_and_retries_never_restore_an_old_choice() {
    let mut f=Fixture::new();
    let preview=f.prepare();
    assert!(f.manager.get_coauthor_branch_decision(&f.child,preview.id).is_err());
    assert!(f.manager.apply_coauthor_branch_decision(&f.child,preview.id).is_err());
    f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    let corrected=f.manager.correct_coauthor_decision(&f.scope,f.target.id,2,"后来撤回","WITHDRAWN").unwrap();
    let repeated=f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    assert_eq!(repeated.after,preview.after);
    assert_eq!(f.manager.search_coauthor_decisions(&f.scope,"失去",0).unwrap().memories[0].decision,corrected);
    assert_eq!(f.manager.list_coauthor_decision_history(&f.scope,f.target.id,None).unwrap().revisions.len(),3);
}

#[test]
fn late_failures_roll_back_author_message_decision_evidence_mentions_index_and_receipt() {
    for (table,event) in [("coauthor_decision_revisions","INSERT"),("coauthor_decision_mentions","INSERT"),
        ("coauthor_branch_decision_adoptions","UPDATE")] {
        let mut f=Fixture::new();
        let preview=f.prepare();
        f.db().connection.execute_batch(&format!(
            "CREATE TRIGGER fail_adoption BEFORE {event} ON {table} BEGIN SELECT RAISE(ABORT,'late failure'); END;"
        )).unwrap();
        assert!(f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).is_err());
        assert_eq!(f.manager.search_coauthor_decisions(&f.scope,"",0).unwrap().memories[0].decision,f.target);
        assert_eq!(f.manager.list_coauthor_decision_history(&f.scope,f.target.id,None).unwrap().revisions.len(),1);
        let messages:i64=f.db().connection.query_row(
            "SELECT COUNT(*) FROM discussion_messages WHERE id=?1",[preview.after.decision.source_message_id.to_string()],|row|row.get(0),
        ).unwrap();
        assert_eq!(messages,0);
        assert_eq!(f.manager.get_coauthor_branch_decision(&f.scope,preview.id).unwrap().status,"PENDING");
        f.db().connection.execute_batch("DROP TRIGGER fail_adoption").unwrap();
        f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    }
}

#[test]
fn a_new_alias_owner_after_preview_prevents_duplicate_creation() {
    let mut f=Fixture::new();
    let source=create(&mut f.manager,&f.child,"后来同名");
    let input=CoauthorBranchDecisionInput {
        source_session_id:f.child.session_id,source_decision_id:source.id,source_version:1,
        target_decision_id:None,expected_version:0,
    };
    let preview=f.manager.prepare_coauthor_branch_decision(&f.scope,input).unwrap();
    create(&mut f.manager,&f.scope,"后来同名");
    assert!(f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).is_err());
}

#[test]
fn unrelated_foreign_and_wrong_decision_identities_or_versions_are_rejected() {
    let mut f=Fixture::new();
    let other=f.manager.create_discussion_session("无关".into(),DiscussionScopeKind::Project,None,None).unwrap();
    assert!(f.manager.list_coauthor_branch_decisions(&f.scope,other.id,"",0).is_err());
    assert!(f.manager.list_coauthor_branch_decisions(&f.scope,f.scope.session_id,"",0).is_err());
    for field in 0..4 {
        let mut input=f.input();
        match field {
            0=>input.source_version+=1,
            1=>input.expected_version+=1,
            2=>input.source_decision_id=f.target.id,
            _=>input.target_decision_id=Some(f.source.id),
        }
        assert!(f.manager.prepare_coauthor_branch_decision(&f.scope,input).is_err());
    }
    let wrong=CoauthorScope { project_id:Uuid::new_v4(),..f.scope.clone() };
    assert!(f.manager.list_coauthor_branch_decisions(&wrong,f.child.session_id,"",0).is_err());
    f.db().connection.execute("UPDATE discussion_sessions SET project_id=?2 WHERE id=?1",
        rusqlite::params![f.child.session_id.to_string(),Uuid::new_v4().to_string()]).unwrap();
    assert!(f.manager.list_coauthor_branch_decisions(&f.scope,f.child.session_id,"",0).is_err());
}

#[test]
fn directories_are_paged_and_do_not_decode_drafts_or_embedded_receipt_content() {
    let mut f=Fixture::new();
    for i in 0..17 { create(&mut f.manager,&f.child,&format!("独立规则{i}")); }
    f.db().connection.execute("UPDATE coauthor_documents SET payload='{}' WHERE session_id=?1",[f.child.session_id.to_string()]).unwrap();
    let first=f.manager.list_coauthor_branch_decisions(&f.scope,f.child.session_id,"",0).unwrap();
    let second=f.manager.list_coauthor_branch_decisions(&f.scope,f.child.session_id,"",16).unwrap();
    assert_eq!((first.memories.len(),second.memories.len()),(16,2));
    assert!(first.has_more && !second.has_more);
    for _ in 0..12 { f.prepare(); }
    f.db().connection.execute_batch("UPDATE coauthor_branch_decision_adoptions SET payload=json_set(payload,'$.source.quote',123)").unwrap();
    let first=f.manager.list_coauthor_branch_decision_adoptions(&f.scope,0).unwrap();
    let second=f.manager.list_coauthor_branch_decision_adoptions(&f.scope,10).unwrap();
    assert_eq!((first.adoptions.len(),second.adoptions.len()),(10,2));
    assert!(first.has_more && !second.has_more);
    assert!(f.manager.get_coauthor_branch_decision(&f.scope,first.adoptions[0].id).is_err());
    assert!(f.manager.list_coauthor_branch_decision_adoptions(&f.child,0).unwrap().adoptions.is_empty());
}

#[test]
fn migration_64_is_atomic_retryable_and_leaves_existing_author_decisions_unchanged() {
    let f=Fixture::new();
    f.db().connection.execute_batch(
        "DROP TABLE coauthor_decision_consumers; DROP TABLE coauthor_changeset_dependency_coverage;
         DROP TABLE coauthor_branch_decision_adoptions; DELETE FROM schema_migrations WHERE version>=64;
         CREATE TRIGGER fail64 BEFORE INSERT ON schema_migrations WHEN NEW.version=64
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_branch_decisions().is_err());
    assert_eq!(f.db().health().unwrap().schema_version,63);
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_branch_decision_adoptions'",[],|row|row.get::<_,i64>(0),
    ).unwrap(),0);
    f.db().connection.execute_batch("DROP TRIGGER fail64").unwrap();
    f.db().migrate_coauthor_branch_decisions().unwrap();
    f.db().migrate_coauthor_decision_consumers().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version,CURRENT_SCHEMA_VERSION);
    assert_eq!(f.manager.search_coauthor_decisions(&f.scope,"",0).unwrap().memories[0].decision,f.target);
}

#[test]
fn backup_restore_preserves_provenance_pending_previews_and_applied_receipts() {
    let mut f=Fixture::new();
    let first=f.prepare();
    let pending=f.prepare();
    f.manager.apply_coauthor_branch_decision(&f.scope,first.id).unwrap();
    f.manager.close();f.manager.open(&f.root).unwrap();
    f.manager.enqueue_job(JobType::Backup,"{}".into()).unwrap();
    let job=f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status,JobStatus::Succeeded);
    let target=f.root.with_file_name(format!("coauthor-decision-restore-{}",Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()),&target).unwrap();
    let mut restored=ProjectManager::new();restored.open(&target).unwrap();
    assert_eq!(restored.get_coauthor_branch_decision(&f.scope,first.id).unwrap().source,first.source);
    assert_eq!(restored.get_coauthor_branch_decision(&f.scope,first.id).unwrap().status,"APPLIED");
    assert_eq!(restored.get_coauthor_branch_decision(&f.scope,pending.id).unwrap().status,"PENDING");
    assert!(restored.apply_coauthor_branch_decision(&f.scope,pending.id).is_err());
    drop(restored);let _=std::fs::remove_dir_all(target);
}
