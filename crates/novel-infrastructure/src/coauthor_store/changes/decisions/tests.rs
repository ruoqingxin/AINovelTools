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
            title:"规则与独立设定".into(),draft_depends_on:vec![],include_draft:true,
            items:vec![CoauthorChangeItemInput {
                id:"setting".into(),kind:CoauthorDocumentKind::Setting,title:"独立地点".into(),content:"城门向南。".into(),
                target_key:None,target_revision:None,depends_on:vec![],manuscript_edits:vec![],outline_edits:vec![],
            }],
            impacts:vec![],coverage:"只核对明确声明的决定依赖，未排查全部语义关系。".into(),
            decision_dependencies:vec![CoauthorDecisionDependencyInput {
                item_ids:vec!["draft".into()],decision_id:self.decision.id,version:self.decision.version,
            }],
        }
    }
    fn prepare(&mut self) -> CoauthorChangeSet {
        let request=self.request();
        self.manager.prepare_coauthor_changeset(&self.scope,request,None).unwrap()
    }
    fn formal_count(&self) -> i64 {
        self.db().connection.query_row(
            "SELECT (SELECT COUNT(*) FROM entities)+(SELECT COUNT(*) FROM chapters)+(SELECT COUNT(*) FROM plan_nodes)",
            [],|row|row.get(0),
        ).unwrap()
    }
    fn correct(&mut self, status: &str) {
        self.manager.correct_coauthor_decision(&self.scope,self.decision.id,self.decision.version,"失去记忆",status).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { self.manager.close();let _=std::fs::remove_dir_all(&self.root); }
}

#[test]
fn precise_decision_snapshot_is_frozen_without_changing_author_or_formal_content() {
    let mut f=Fixture::new();let count=f.formal_count();let before=f.manager.coauthor_document(&f.scope).unwrap();
    let mut input=serde_json::to_value(f.request()).unwrap();
    input.as_object_mut().unwrap().remove("decisionDependencies");
    assert!(serde_json::from_value::<CoauthorChangeRequest>(input.clone()).is_err());
    input["decisionDependencies"]=serde_json::json!(null);
    assert!(serde_json::from_value::<CoauthorChangeRequest>(input.clone()).is_err());
    input["decisionDependencies"]=serde_json::json!([]);
    assert!(serde_json::from_value::<CoauthorChangeRequest>(input).is_ok());
    let changes=f.prepare();
    let dependency=&changes.decision_dependencies.as_ref().unwrap()[0];
    assert_eq!(dependency.decision,f.decision);assert_eq!(dependency.current,Some(f.decision.clone()));
    assert_eq!(dependency.item_ids,vec!["draft"]);
    assert_eq!(f.formal_count(),count);assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(),before);
    assert_eq!(f.manager.list_coauthor_decision_history(&f.scope,f.decision.id,None).unwrap().revisions.len(),1);
}

#[test]
fn author_correction_or_same_text_new_version_invalidates_only_dependent_selected_items() {
    for status in ["CHOSEN","REJECTED","OPEN","WITHDRAWN"] {
        let mut f=Fixture::new();let changes=f.prepare();let count=f.formal_count();
        f.correct(status);
        let loaded=f.manager.coauthor_changeset(&f.scope,changes.id).unwrap();
        let dependency=&loaded.decision_dependencies.as_ref().unwrap()[0];
        assert_eq!(dependency.decision,f.decision);assert_eq!(dependency.current.as_ref().unwrap().version,2);
        assert_eq!(dependency.current.as_ref().unwrap().status,status);
        assert!(f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into(),"setting".into()]).is_err());
        assert_eq!(f.formal_count(),count);
        let applied=f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["setting".into()]).unwrap();
        assert_eq!(applied.selected_ids,vec!["setting"]);assert_eq!(f.formal_count(),count+1);
    }
}

#[test]
fn unrelated_decisions_do_not_block_and_rejected_boundaries_are_preserved() {
    let mut f=Fixture::new();
    f.correct("REJECTED");
    f.decision=f.manager.list_coauthor_decision_history(&f.scope,f.decision.id,None).unwrap().current.decision;
    let branch=f.manager.fork_coauthor_session(&f.scope,"不同方向".into()).unwrap();
    let changes=f.prepare();
    let child=CoauthorScope {session_id:branch.id,..f.scope.clone()};
    let copied=f.manager.search_coauthor_decisions(&child,"",0).unwrap().memories.remove(0).decision;
    f.manager.correct_coauthor_decision(&child,copied.id,copied.version,"分支另选寿元","CHOSEN").unwrap();
    let applied=f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into()]).unwrap();
    assert_eq!(applied.decision_dependencies.unwrap()[0].decision.status,"REJECTED");
}

#[test]
fn adoption_from_a_branch_invalidates_prepared_rules_without_synchronizing_formal_content() {
    let mut f=Fixture::new();
    let branch=f.manager.fork_coauthor_session(&f.scope,"改用寿元".into()).unwrap();
    let child=CoauthorScope {session_id:branch.id,..f.scope.clone()};
    let copied=f.manager.search_coauthor_decisions(&child,"",0).unwrap().memories.remove(0).decision;
    let source=f.manager.correct_coauthor_decision(&child,copied.id,copied.version,"改用寿元","CHOSEN").unwrap();
    let changes=f.prepare();let count=f.formal_count();
    let preview=f.manager.prepare_coauthor_branch_decision(&f.scope,CoauthorBranchDecisionInput {
        source_session_id:child.session_id,source_decision_id:source.id,source_version:source.version,
        target_decision_id:Some(f.decision.id),expected_version:f.decision.version,
    }).unwrap();
    f.manager.apply_coauthor_branch_decision(&f.scope,preview.id).unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into()]).is_err());
    assert_eq!(f.formal_count(),count);
}

#[test]
fn duplicate_unknown_empty_overlarge_or_foreign_bindings_are_rejected_without_persisting_plans() {
    let mut f=Fixture::new();
    for case in 0..7 {
        let mut request=f.request();
        match case {
            0=>request.decision_dependencies[0].item_ids.clear(),
            1=>request.decision_dependencies[0].item_ids=vec!["unknown".into()],
            2=>request.decision_dependencies[0].item_ids=vec!["draft".into(),"draft".into()],
            3=>request.decision_dependencies.push(request.decision_dependencies[0].clone()),
            4=>request.decision_dependencies[0].version+=1,
            5=>request.decision_dependencies[0].decision_id=Uuid::new_v4(),
            _=>request.decision_dependencies=vec![request.decision_dependencies[0].clone();33],
        }
        assert!(f.manager.prepare_coauthor_changeset(&f.scope,request,None).is_err());
    }
    let child=f.manager.fork_coauthor_session(&f.scope,"隔离".into()).unwrap();
    let foreign=f.manager.search_coauthor_decisions(&CoauthorScope {session_id:child.id,..f.scope.clone()},"",0).unwrap().memories.remove(0).decision;
    let mut request=f.request();request.decision_dependencies[0].decision_id=foreign.id;
    assert!(f.manager.prepare_coauthor_changeset(&f.scope,request,None).is_err());
    assert!(f.manager.coauthor_changes(&f.scope,0,0).unwrap().change_sets.is_empty());
}

#[test]
fn single_document_publication_cannot_bypass_a_declared_rule_or_legacy_unknown_binding() {
    for legacy in [false,true] {
        let mut f=Fixture::new();let changes=f.prepare();
        if legacy {
            f.db().connection.execute(
                "UPDATE coauthor_changesets SET payload=json_remove(payload,'$.decisionDependencies') WHERE id=?1",
                [changes.id.to_string()],
            ).unwrap();
            assert!(f.manager.coauthor_changeset(&f.scope,changes.id).unwrap().decision_dependencies.is_none());
            assert!(f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["setting".into()]).is_err());
        }
        assert!(f.manager.publish_coauthor_document(&f.scope,changes.base_document.version).is_err());
        f.manager.discard_coauthor_changeset(&f.scope,changes.id,1).unwrap();
        let mut request=f.request();request.decision_dependencies.clear();
        let independent=f.manager.prepare_coauthor_changeset(&f.scope,request,None).unwrap();
        assert!(independent.decision_dependencies.unwrap().is_empty());
        assert!(f.manager.publish_coauthor_document(&f.scope,changes.base_document.version).is_ok());
    }
}

#[test]
fn committed_receipts_remain_idempotent_after_later_rule_changes() {
    let mut f=Fixture::new();let changes=f.prepare();
    f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into()]).unwrap();
    let count=f.formal_count();f.correct("WITHDRAWN");
    let repeated=f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into()]).unwrap();
    assert_eq!(repeated.status,"COMMITTED");assert_eq!(f.formal_count(),count);
    let dep=&repeated.decision_dependencies.as_ref().unwrap()[0];
    assert_eq!(dep.decision.version,1);assert_eq!(dep.current.as_ref().unwrap().version,2);
}

#[test]
fn late_failure_keeps_dependency_snapshot_pending_and_rolls_back_all_formal_objects() {
    let mut f=Fixture::new();let changes=f.prepare();let count=f.formal_count();
    f.db().connection.execute_batch(
        "CREATE TRIGGER fail_rule_receipt BEFORE UPDATE ON coauthor_changesets
         BEGIN SELECT RAISE(ABORT,'late failure'); END;",
    ).unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into(),"setting".into()]).is_err());
    assert_eq!(f.formal_count(),count);
    let pending=f.manager.coauthor_changeset(&f.scope,changes.id).unwrap();
    assert_eq!(pending.status,"PENDING");assert_eq!(pending.decision_dependencies.unwrap()[0].decision,f.decision);
}

#[test]
fn backup_restore_keeps_exact_rules_and_old_plans_do_not_regain_validity() {
    let mut f=Fixture::new();let changes=f.prepare();f.correct("WITHDRAWN");
    f.manager.close();f.manager.open(&f.root).unwrap();
    f.manager.enqueue_job(JobType::Backup,"{}".into()).unwrap();
    let job=f.manager.run_next_job().unwrap().unwrap();assert_eq!(job.status,JobStatus::Succeeded);
    let target=f.root.with_file_name(format!("coauthor-rule-restore-{}",Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()),&target).unwrap();
    let mut restored=ProjectManager::new();restored.open(&target).unwrap();
    let loaded=restored.coauthor_changeset(&f.scope,changes.id).unwrap();
    assert_eq!(loaded.decision_dependencies.as_ref().unwrap()[0].decision,f.decision);
    assert!(restored.commit_coauthor_changeset(&f.scope,changes.id,1,vec!["draft".into()]).is_err());
    drop(restored);let _=std::fs::remove_dir_all(target);
}
