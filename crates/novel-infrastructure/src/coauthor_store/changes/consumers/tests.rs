use super::*;
use crate::coauthor_store::tests::project;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    decision: CoauthorDecision,
}
impl Fixture {
    fn new() -> Self {
        let (mut manager,root,scope)=project();
        let mut document=manager.coauthor_document(&scope).unwrap();
        document.kind=CoauthorDocumentKind::Manuscript;
        document.title="突破试写".into();document.content="他失去一段记忆。".into();
        let document=manager.save_coauthor_document(&scope,document).unwrap();
        let run=manager.start_coauthor_run(&scope,Uuid::new_v4(),"沿用失忆代价",document.version).unwrap();
        let decision=manager.set_coauthor_decision(&scope,run.id,CoauthorDecisionInput {
            decision_id:None,expected_version:0,topic:"突破代价".into(),aliases:vec![],
            content:"失去记忆".into(),status:"CHOSEN".into(),quote:"沿用失忆代价".into(),
        }).unwrap();
        manager.finish_coauthor_run(&scope,run.id,"COMPLETED","",&[]).unwrap();
        Self {manager,root,scope,decision}
    }
    fn db(&self) -> &Database { &self.manager.current.as_ref().unwrap().database }
    fn request(&self) -> CoauthorChangeRequest {
        CoauthorChangeRequest {
            expected_document_version:self.manager.coauthor_document(&self.scope).unwrap().version,
            title:"失忆规则的关联方案".into(),draft_depends_on:vec![],include_draft:true,
            items:vec![CoauthorChangeItemInput {
                id:"setting".into(),kind:CoauthorDocumentKind::Setting,title:"突破代价".into(),content:"突破失忆。".into(),
                target_key:None,target_revision:None,depends_on:vec![],manuscript_edits:vec![],outline_edits:vec![],
            }],
            impacts:vec![],coverage:"仅声明明确依赖，未查全书。".into(),
            decision_dependencies:vec![CoauthorDecisionDependencyInput {
                item_ids:vec!["draft".into(),"setting".into()],decision_id:self.decision.id,version:self.decision.version,
            }],
        }
    }
    fn prepare(&mut self) -> CoauthorChangeSet {
        self.manager.prepare_coauthor_changeset(&self.scope,self.request(),None).unwrap()
    }
    fn page(&self, review: bool, offset: u32) -> CoauthorDecisionConsumersPage {
        self.manager.coauthor_decision_consumers(&self.scope,self.decision.id,review,offset).unwrap()
    }
    fn correct(&mut self) {
        self.manager.correct_coauthor_decision(&self.scope,self.decision.id,1,"改为寿元","CHOSEN").unwrap();
    }
    fn adopt_setting(&mut self, changes: &CoauthorChangeSet) {
        self.manager.commit_coauthor_changeset(&self.scope,changes.id,1,vec!["setting".into()]).unwrap();
    }
    fn count(&self, table: &str) -> i64 {
        self.db().connection.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|row|row.get(0)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { self.manager.close();let _=std::fs::remove_dir_all(&self.root); }
}

#[test]
fn directories_distinguish_pending_adopted_unselected_discarded_and_reversed_items() {
    let mut f=Fixture::new();
    let pending=f.prepare();let applied=f.prepare();f.adopt_setting(&applied);
    let discarded=f.prepare();f.manager.discard_coauthor_changeset(&f.scope,discarded.id,1).unwrap();
    let reversed=f.prepare();f.adopt_setting(&reversed);
    let reversal=f.manager.prepare_coauthor_reversal(&f.scope,reversed.id,2,1).unwrap();
    f.manager.commit_coauthor_reversal(&f.scope,reversed.id,reversal.version).unwrap();
    assert!(f.page(true,0).entries.is_empty());
    f.correct();
    let active=f.page(true,0);
    assert_eq!(active.entries.len(),3);
    assert!(active.entries.iter().all(|item|item.needs_review && [pending.id,applied.id].contains(&item.change_set_id)));
    let all=f.page(false,0);
    assert_eq!(all.entries.len(),8);
    for state in ["PENDING","ADOPTED","NOT_ADOPTED","DISCARDED","REVERSED"] {
        assert!(all.entries.iter().any(|item|item.state==state));
    }
    let adopted=all.entries.iter().find(|item|item.state=="ADOPTED").unwrap();
    assert!(adopted.published_key.as_ref().unwrap().starts_with("ENTITY:"));
    assert!(adopted.published_revision.is_some());
    assert!(all.entries.iter().filter(|item|["DISCARDED","REVERSED","NOT_ADOPTED"].contains(&item.state.as_str())).all(|item|!item.needs_review));
}

#[test]
fn stable_pages_keep_exact_item_identities_without_loading_documents_or_receipt_bodies() {
    let mut f=Fixture::new();
    for _ in 0..10 { f.prepare(); }
    f.correct();
    f.db().connection.execute_batch(
        "UPDATE coauthor_changesets SET payload=json_set(payload,'$.items',42);
         UPDATE coauthor_documents SET payload='{}';",
    ).unwrap();
    let first=f.page(true,0);let second=f.page(true,16);
    assert_eq!((first.entries.len(),second.entries.len()),(16,4));
    assert!(first.has_more && !second.has_more);
    let identities=first.entries.iter().chain(&second.entries).map(|item|(item.change_set_id,&item.item_id)).collect::<BTreeSet<_>>();
    assert_eq!(identities.len(),20);
    assert!(f.manager.coauthor_changeset(&f.scope,first.entries[0].change_set_id).is_err());
    assert!(f.page(true,100).entries.is_empty());
}

#[test]
fn exact_decision_scope_never_leaks_other_discussions_or_foreign_projects() {
    let mut f=Fixture::new();f.prepare();f.correct();
    let child=f.manager.fork_coauthor_session(&f.scope,"独立讨论".into()).unwrap();
    let scope=CoauthorScope {session_id:child.id,..f.scope.clone()};
    assert!(f.manager.coauthor_decision_consumers(&scope,f.decision.id,false,0).is_err());
    let copied=f.manager.search_coauthor_decisions(&scope,"",0).unwrap().memories.remove(0).decision;
    assert!(f.manager.coauthor_decision_consumers(&scope,copied.id,false,0).unwrap().entries.is_empty());
    let wrong=CoauthorScope {project_id:Uuid::new_v4(),..f.scope.clone()};
    assert!(f.manager.coauthor_decision_consumers(&wrong,f.decision.id,false,0).is_err());
    assert!(f.manager.coauthor_decision_consumers(&f.scope,Uuid::new_v4(),false,0).is_err());
    assert_eq!(f.page(true,0).entries.len(),2);
}

#[test]
fn explicit_branch_adoption_immediately_exposes_old_local_consumers_without_adopting_source_drafts() {
    let mut f=Fixture::new();f.prepare();
    let child=f.manager.fork_coauthor_session(&f.scope,"寿元方向".into()).unwrap();
    let scope=CoauthorScope {session_id:child.id,..f.scope.clone()};
    let source=f.manager.search_coauthor_decisions(&scope,"",0).unwrap().memories.remove(0).decision;
    f.manager.correct_coauthor_decision(&scope,source.id,source.version,"改用寿元","CHOSEN").unwrap();
    assert!(f.page(true,0).entries.is_empty());
    let preview=f.manager.prepare_coauthor_branch_decision(&f.scope,CoauthorBranchDecisionInput {
        source_session_id:scope.session_id,source_decision_id:source.id,source_version:2,
        target_decision_id:Some(f.decision.id),expected_version:1,
    }).unwrap();
    f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    assert_eq!(f.page(true,0).entries.len(),2);
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap().content,"他失去一段记忆。");
    assert_eq!(f.count("entities"),0);
}

#[test]
fn projection_failure_rolls_back_preparation_and_does_not_leave_coverage_or_plan_fragments() {
    let mut f=Fixture::new();
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_consumer BEFORE INSERT ON coauthor_decision_consumers
         BEGIN SELECT RAISE(ABORT,'consumer insert failure'); END;",
    ).unwrap();
    assert!(f.manager.prepare_coauthor_changeset(&f.scope,f.request(),None).is_err());
    for table in ["coauthor_changesets","coauthor_decision_consumers","coauthor_changeset_dependency_coverage"] {
        assert_eq!(f.count(table),0);
    }
}

#[test]
fn publication_projection_failure_rolls_back_formal_writes_receipt_and_original_dependency_index() {
    let mut f=Fixture::new();let changes=f.prepare();let count=f.count("entities");
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_published_consumer BEFORE INSERT ON coauthor_decision_consumers
         WHEN NEW.published_key IS NOT NULL BEGIN SELECT RAISE(ABORT,'published consumer failure'); END;",
    ).unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["setting".into()]).is_err());
    assert_eq!(f.count("entities"),count);
    assert_eq!(f.manager.coauthor_changeset(&f.scope,changes.id).unwrap().status,"PENDING");
    assert!(f.page(false,0).entries.iter().all(|item|item.state=="PENDING" && item.published_key.is_none()));
}

#[test]
fn migration_65_backfills_exact_receipts_and_unknown_legacy_coverage_atomically_and_retries() {
    let mut f=Fixture::new();let applied=f.prepare();f.adopt_setting(&applied);
    let legacy=f.prepare();
    f.db().connection.execute("UPDATE coauthor_changesets SET payload=json_remove(payload,'$.decisionDependencies') WHERE id=?1",
        [legacy.id.to_string()]).unwrap();
    let payloads: Vec<String>=f.db().connection.prepare("SELECT payload FROM coauthor_changesets ORDER BY rowid").unwrap()
        .query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    f.db().connection.execute_batch(
        "DROP TABLE coauthor_decision_consumers; DROP TABLE coauthor_changeset_dependency_coverage;
         DELETE FROM schema_migrations WHERE version>=65;
         CREATE TRIGGER fail65 BEFORE INSERT ON schema_migrations WHEN NEW.version=65
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
    ).unwrap();
    assert!(f.db().migrate_coauthor_decision_consumers().is_err());
    assert_eq!(f.db().health().unwrap().schema_version,64);
    assert_eq!(f.db().connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('coauthor_decision_consumers','coauthor_changeset_dependency_coverage')",
        [],|row|row.get::<_,i64>(0)).unwrap(),0);
    f.db().connection.execute_batch("DROP TRIGGER fail65").unwrap();
    f.db().migrate_coauthor_decision_consumers().unwrap();
    f.db().connection.execute_batch("ALTER TABLE discussion_sessions DROP COLUMN deleted_at").unwrap();
    f.db().migrate_discussion_session_deletion().unwrap();
    f.db().migrate_entity_deletion().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version,CURRENT_SCHEMA_VERSION);
    assert_eq!(f.page(false,0).unknown_change_sets,1);
    assert_eq!(f.page(false,0).entries.len(),2);
    assert!(f.page(false,0).entries.iter().any(|item|item.state=="ADOPTED" && item.published_key.is_some()));
    let after: Vec<String>=f.db().connection.prepare("SELECT payload FROM coauthor_changesets ORDER BY rowid").unwrap()
        .query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(payloads,after);
}

#[test]
fn no_declared_dependencies_and_missing_projection_never_claim_complete_semantic_coverage() {
    let mut f=Fixture::new();
    let mut request=f.request();request.decision_dependencies.clear();
    let known=f.manager.prepare_coauthor_changeset(&f.scope,request,None).unwrap();
    assert!(f.page(false,0).entries.is_empty());assert_eq!(f.page(false,0).unknown_change_sets,0);
    f.db().connection.execute("DELETE FROM coauthor_changeset_dependency_coverage WHERE change_set_id=?1",[known.id.to_string()]).unwrap();
    assert_eq!(f.page(false,0).unknown_change_sets,1);
    f.manager.discard_coauthor_changeset(&f.scope,known.id,1).unwrap();
    assert_eq!(f.page(false,0).unknown_change_sets,0);
}

#[test]
fn backup_restore_preserves_reverse_lookup_and_rechecking_does_not_rewrite_formal_content() {
    let mut f=Fixture::new();let changes=f.prepare();f.adopt_setting(&changes);f.correct();
    let count=f.count("entities");
    let old_revision=f.page(true,0).entries[0].published_revision.clone();
    f.manager.close();f.manager.open(&f.root).unwrap();
    f.manager.enqueue_job(JobType::Backup,"{}".into()).unwrap();
    let job=f.manager.run_next_job().unwrap().unwrap();assert_eq!(job.status,JobStatus::Succeeded);
    let target=f.root.with_file_name(format!("coauthor-consumer-restore-{}",Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()),&target).unwrap();
    let mut restored=ProjectManager::new();restored.open(&target).unwrap();
    let page=restored.coauthor_decision_consumers(&f.scope,f.decision.id,true,0).unwrap();
    assert_eq!(page.entries.len(),1);assert_eq!(page.entries[0].published_revision,old_revision);
    assert_eq!(f.count("entities"),count);
    drop(restored);let _=std::fs::remove_dir_all(target);
}
