use super::*;
use crate::coauthor_store::tests::project;

mod checks;
mod pages;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    chapter: Uuid,
    revision: ManuscriptRevision,
    facts: Vec<Fact>,
    relation: Relation,
}

impl Fixture {
    fn new() -> Self {
        let (mut manager, root, scope) = project();
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "魂灯之夜".into())
            .unwrap()
            .id;
        let revision=manager.save_manuscript(chapter,
            r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"p1"},"content":[{"type":"text","text":"陆沉😀掌握魂灯。"}]},{"type":"paragraph","attrs":{"blockId":"p2"},"content":[{"type":"text","text":"苏瑶守在门外。"}]}]}"#.into(),"TEST".into()).unwrap();
        let mut facts = Vec::new();
        for (block, subject, predicate, object, text) in [
            ("p1", "陆沉", "掌握", "魂灯", "陆沉😀掌握魂灯。"),
            ("p2", "苏瑶", "守在", "门外", "苏瑶守在门外。"),
        ] {
            let anchor = manager
                .create_evidence_anchor(EvidenceAnchor {
                    id: Uuid::new_v4(),
                    project_id: scope.project_id,
                    chapter_id: chapter,
                    source_revision_id: revision.id,
                    block_id: block.into(),
                    start_offset: 0,
                    end_offset: text.chars().count() as u32,
                    source_version: format!("manuscript:{}", revision.id),
                    source_hash: revision.content_hash.clone(),
                    lifecycle_status: KnowledgeLifecycleStatus::Active,
                    created_by: "test".into(),
                    created_at: now_timestamp(),
                    updated_at: now_timestamp(),
                })
                .unwrap();
            let fact = Fact {
                knowledge_id: Uuid::new_v4(),
                project_id: scope.project_id,
                knowledge_version: 1,
                subject: subject.into(),
                predicate: predicate.into(),
                object: object.into(),
                source_revision_id: revision.id,
                evidence_anchor_ids: vec![anchor.id],
                lifecycle_status: KnowledgeLifecycleStatus::NeedsReview,
                created_by: "test".into(),
                created_at: now_timestamp(),
                updated_at: now_timestamp(),
            };
            let candidate = manager
                .create_knowledge_candidate(KnowledgeCandidate {
                    id: Uuid::new_v4(),
                    project_id: scope.project_id,
                    chapter_id: chapter,
                    proposal_id: None,
                    candidate_status: CandidateStatus::Pending,
                    review_decision: None,
                    reviewer: None,
                    reviewed_at: None,
                    fact: fact.clone(),
                    created_at: now_timestamp(),
                    updated_at: now_timestamp(),
                })
                .unwrap();
            manager
                .review_knowledge_candidate(
                    candidate.id,
                    CandidateStatus::Pending,
                    ReviewDecision::Approve,
                    "作者".into(),
                )
                .unwrap();
            manager
                .finalize_knowledge_candidates(chapter, vec![candidate.id], "作者".into())
                .unwrap();
            facts.push(fact);
        }
        let relation = manager
            .create_relation(Relation {
                id: Uuid::new_v4(),
                project_id: scope.project_id,
                relation_version: 1,
                from_knowledge_id: facts[0].knowledge_id,
                to_knowledge_id: facts[1].knowledge_id,
                relation_type: "守护".into(),
                evidence_anchor_ids: vec![facts[1].evidence_anchor_ids[0]],
                lifecycle_status: KnowledgeLifecycleStatus::Active,
                created_by: "test".into(),
                created_at: now_timestamp(),
                updated_at: now_timestamp(),
            })
            .unwrap();
        Self {
            manager,
            root,
            scope,
            chapter,
            revision,
            facts,
            relation,
        }
    }

    fn db(&self) -> &Database {
        &self.manager.current.as_ref().unwrap().database
    }
    fn source(&self, key: &str) -> CoauthorSource {
        self.db().coauthor_source(key).unwrap().unwrap()
    }
    fn fact(&self) -> CoauthorSource {
        self.source(&format!("FACT:{}", self.facts[0].knowledge_id))
    }
    fn relation(&self) -> CoauthorSource {
        self.source(&format!("RELATION:{}", self.relation.id))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn indexed_finalized_facts_and_relations_retain_identity_and_do_not_promote_candidates() {
    let mut f = Fixture::new();
    let source = f.fact();
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    assert!(found.hits.iter().any(|hit| hit.key == source.key));
    assert!(
        found.hits.iter().any(|hit| hit.kind == "RELATION"
            && hit.knowledge_context.as_ref().unwrap().facts.len() == 2)
    );
    assert_eq!(source.knowledge_context.unwrap().status, "CURRENT");
    assert!(
        !f.manager
            .search_coauthor_sources(&f.scope, "陆沉", true, 0)
            .unwrap()
            .hits
            .iter()
            .any(|hit| hit.kind == "FACT")
    );
    let mut candidate = f.facts[0].clone();
    candidate.knowledge_id = Uuid::new_v4();
    candidate.subject = "未经确认的秘密".into();
    f.manager
        .create_knowledge_candidate(KnowledgeCandidate {
            id: Uuid::new_v4(),
            project_id: f.scope.project_id,
            chapter_id: f.chapter,
            proposal_id: None,
            candidate_status: CandidateStatus::Pending,
            review_decision: None,
            reviewer: None,
            reviewed_at: None,
            fact: candidate.clone(),
            created_at: now_timestamp(),
            updated_at: now_timestamp(),
        })
        .unwrap();
    assert!(
        f.db()
            .coauthor_source(&format!("FACT:{}", candidate.knowledge_id))
            .unwrap()
            .is_none()
    );
    assert!(
        f.manager
            .search_coauthor_sources(&f.scope, "未经确认的秘密", false, 0)
            .unwrap()
            .hits
            .iter()
            .all(|hit| !hit.content.contains("未经确认的秘密"))
    );
}

#[test]
fn direct_relationships_page_by_stable_fact_identity_without_recursive_or_unrelated_expansion() {
    let mut f = Fixture::new();
    for _ in 0..25 {
        let mut relation = f.relation.clone();
        relation.id = Uuid::new_v4();
        f.manager.create_relation(relation).unwrap();
    }
    let fact = f.fact();
    let mut keys = std::collections::BTreeSet::new();
    for offset in [0, 12, 24] {
        let page = f
            .manager
            .coauthor_related_knowledge(&f.scope, &fact.key, &fact.revision, offset)
            .unwrap();
        assert_eq!(page.has_more, offset < 24);
        assert_eq!(page.hits.len(), if offset < 24 { 12 } else { 2 });
        for hit in page.hits {
            assert!(keys.insert(hit.key));
            assert!(hit.content.chars().count() <= 600);
        }
    }
    let relation = f.relation();
    assert!(
        f.manager
            .coauthor_related_knowledge(&f.scope, &relation.key, &relation.revision, 0)
            .is_err()
    );
    assert!(
        f.manager
            .coauthor_related_knowledge(&f.scope, &fact.key, "wrong", 0)
            .is_err()
    );
}

#[test]
fn pointer_and_relation_versions_invalidate_old_sources_and_archive_does_not_fall_back() {
    let mut f = Fixture::new();
    f.manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    let old = f.fact();
    let old_relation = f.relation();
    f.db().connection.execute(
        "INSERT INTO facts SELECT knowledge_id,project_id,knowledge_version+1,'陆沉新称',predicate,object,
            source_revision_id,evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM facts WHERE knowledge_id=?1 AND knowledge_version=1",
        [f.facts[0].knowledge_id.to_string()],
    ).unwrap();
    f.db()
        .connection
        .execute(
            "UPDATE fact_current_versions SET knowledge_version=2 WHERE knowledge_id=?1",
            [f.facts[0].knowledge_id.to_string()],
        )
        .unwrap();
    assert_ne!(old.revision, f.fact().revision);
    assert_ne!(old_relation.revision, f.relation().revision);
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "陆沉新称", false, 0)
        .unwrap();
    assert!(
        found
            .hits
            .iter()
            .any(|hit| hit.kind == "RELATION" && hit.content.contains("陆沉新称"))
    );
    let mut archived = f.relation.clone();
    archived.relation_version = 2;
    archived.lifecycle_status = KnowledgeLifecycleStatus::Archived;
    f.manager.update_relation(archived, 1).unwrap();
    assert!(f.db().coauthor_source(&old_relation.key).unwrap().is_none());
    assert!(
        !f.manager
            .search_coauthor_sources(&f.scope, "守护", false, 0)
            .unwrap()
            .hits
            .iter()
            .any(|hit| hit.key == old_relation.key)
    );
    assert!(
        f.manager
            .read_coauthor_source(&f.scope, &old.key, &old.revision, 0, 1)
            .is_err()
    );
}

#[test]
fn same_text_new_manuscript_revision_marks_derived_sources_for_review_but_retains_old_evidence() {
    let mut f = Fixture::new();
    let old = f.fact();
    let relation = f.relation();
    f.manager
        .save_manuscript(
            f.chapter,
            f.revision.document_json.clone(),
            "同文新修订".into(),
        )
        .unwrap();
    let current = f.fact();
    assert_ne!(old.revision, current.revision);
    assert_eq!(
        current.knowledge_context.as_ref().unwrap().status,
        "NEEDS_REVIEW"
    );
    assert_eq!(
        f.relation().knowledge_context.as_ref().unwrap().status,
        "NEEDS_REVIEW"
    );
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    assert!(found.hits.iter().any(|hit| hit.key == old.key
        && hit.knowledge_context.as_ref().unwrap().status == "NEEDS_REVIEW"));
    let evidence = f
        .manager
        .read_coauthor_knowledge_evidence(
            &f.scope,
            &current.key,
            &current.revision,
            f.facts[0].evidence_anchor_ids[0],
            0,
            12000,
        )
        .unwrap();
    assert_eq!(evidence.content, "陆沉😀掌握魂灯。");
    assert!(!evidence.is_current_revision);
    assert_ne!(relation.revision, f.relation().revision);
    assert!(
        f.db()
            .validate_coauthor_dependencies(&[CoauthorSourceDependency {
                key: current.key,
                revision: current.revision
            }])
            .is_err()
    );
    assert_eq!(f.manager.list_current_facts().unwrap().len(), 2);
}

#[test]
fn evidence_reads_validate_exact_ownership_unicode_range_hash_and_offsets() {
    let mut f = Fixture::new();
    let source = f.fact();
    let id = f.facts[0].evidence_anchor_ids[0];
    let first = f
        .manager
        .read_coauthor_knowledge_evidence(&f.scope, &source.key, &source.revision, id, 0, 3)
        .unwrap();
    assert_eq!(first.content, "陆沉😀");
    assert_eq!(first.next_offset, 3);
    assert!(first.is_current_revision);
    assert_eq!(first.start, 0);
    assert_eq!(first.end, 8);
    let next = f
        .manager
        .read_coauthor_knowledge_evidence(
            &f.scope,
            &source.key,
            &source.revision,
            id,
            first.next_offset,
            12000,
        )
        .unwrap();
    assert_eq!(next.content, "掌握魂灯。");
    assert_eq!(next.total_chars, 8);
    assert!(
        f.manager
            .read_coauthor_knowledge_evidence(&f.scope, &source.key, &source.revision, id, 999, 1)
            .is_err()
    );
    assert!(
        f.manager
            .read_coauthor_knowledge_evidence(
                &f.scope,
                &source.key,
                &source.revision,
                f.facts[1].evidence_anchor_ids[0],
                0,
                1
            )
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .read_coauthor_knowledge_evidence(&wrong, &source.key, &source.revision, id, 0, 1)
            .is_err()
    );
    let mut relation = f.relation.clone();
    relation.relation_version = 2;
    let mut bad = EvidenceAnchor {
        id: Uuid::new_v4(),
        project_id: f.scope.project_id,
        chapter_id: f.chapter,
        source_revision_id: f.revision.id,
        block_id: "not-a-real-block".into(),
        start_offset: 0,
        end_offset: 3,
        source_version: f.revision.id.to_string(),
        source_hash: f.revision.content_hash.clone(),
        lifecycle_status: KnowledgeLifecycleStatus::Active,
        created_by: "test".into(),
        created_at: now_timestamp(),
        updated_at: now_timestamp(),
    };
    f.manager.create_evidence_anchor(bad.clone()).unwrap();
    relation.evidence_anchor_ids = vec![bad.id];
    f.manager.update_relation(relation, 1).unwrap();
    let source = f.relation();
    assert!(
        f.manager
            .read_coauthor_knowledge_evidence(
                &f.scope,
                &source.key,
                &source.revision,
                bad.id,
                0,
                10
            )
            .is_err()
    );
    bad.id = Uuid::new_v4();
    bad.block_id = "p1".into();
    bad.source_hash = "wrong".into();
    f.manager.create_evidence_anchor(bad.clone()).unwrap();
    let mut relation = f.relation.clone();
    relation.relation_version = 3;
    relation.evidence_anchor_ids = vec![bad.id];
    f.manager.update_relation(relation, 2).unwrap();
    assert_eq!(
        f.relation().knowledge_context.unwrap().status,
        "NEEDS_REVIEW"
    );
}

#[test]
fn foreign_facts_and_relations_never_enter_project_search_or_exact_reads() {
    let mut f = Fixture::new();
    let foreign = Uuid::new_v4();
    let foreign_id = Uuid::new_v4();
    f.db()
        .connection
        .execute(
            "INSERT INTO facts SELECT ?1,?2,1,'跨项目秘密',predicate,object,source_revision_id,
            evidence_anchor_ids_json,lifecycle_status,created_by,created_at,updated_at
         FROM facts WHERE knowledge_id=?3",
            rusqlite::params![
                foreign_id.to_string(),
                foreign.to_string(),
                f.facts[0].knowledge_id.to_string()
            ],
        )
        .unwrap();
    f.db()
        .connection
        .execute(
            "INSERT INTO fact_current_versions VALUES(?1,1)",
            [foreign_id.to_string()],
        )
        .unwrap();
    let foreign_source = f.source(&format!("FACT:{foreign_id}"));
    assert!(
        f.manager
            .read_coauthor_source(
                &f.scope,
                &foreign_source.key,
                &foreign_source.revision,
                0,
                100
            )
            .is_err()
    );
    assert!(
        f.manager
            .coauthor_related_knowledge(&f.scope, &foreign_source.key, &foreign_source.revision, 0)
            .is_err()
    );
    assert!(
        f.manager
            .search_coauthor_sources(&f.scope, "跨项目秘密", false, 0)
            .unwrap()
            .hits
            .iter()
            .all(|hit| hit.key != foreign_source.key)
    );
    let fork = f
        .manager
        .fork_coauthor_session(&f.scope, "另一分支".into())
        .unwrap();
    let fork_scope = CoauthorScope {
        session_id: fork.id,
        ..f.scope.clone()
    };
    let fact = f.fact();
    assert!(
        f.manager
            .read_coauthor_source(&fork_scope, &fact.key, &fact.revision, 0, 100)
            .is_ok()
    );
    assert_eq!(f.manager.list_current_facts().unwrap().len(), 2);
}

#[test]
fn metadata_queries_do_not_load_chapter_text_and_evidence_failures_are_not_empty_results() {
    let mut f = Fixture::new();
    let source = f.fact();
    f.manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    f.db()
        .connection
        .execute_batch(
            "CREATE TRIGGER deny_chapter_lookup BEFORE INSERT ON coauthor_source_queue
         WHEN NEW.kind='MANUSCRIPT' BEGIN SELECT RAISE(ABORT,'unrelated indexing fault'); END;",
        )
        .unwrap();
    // Isolate metadata lookup from manuscript search before corrupting its text.
    f.db()
        .connection
        .execute(
            "DELETE FROM coauthor_fts WHERE source_key=?1",
            [format!("MANUSCRIPT:{}", f.chapter)],
        )
        .unwrap();
    let triggers=f.db().connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='manuscript_revisions'").unwrap()
        .query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    for trigger in triggers {
        f.db()
            .connection
            .execute_batch(&format!(
                "DROP TRIGGER \"{}\"",
                trigger.replace('"', "\"\"")
            ))
            .unwrap();
    }
    f.db()
        .connection
        .execute(
            "UPDATE manuscript_revisions SET document_json='{}' WHERE id=?1",
            [f.revision.id.to_string()],
        )
        .unwrap();
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    assert!(found.hits.iter().any(|hit| hit.key == source.key));
    assert!(
        f.manager
            .read_coauthor_knowledge_evidence(
                &f.scope,
                &source.key,
                &source.revision,
                f.facts[0].evidence_anchor_ids[0],
                0,
                12000
            )
            .is_err()
    );
}

#[test]
fn migration_is_atomic_retryable_and_preserves_author_content() {
    let f = Fixture::new();
    let original = f.revision.document_json.clone();
    f.db()
        .connection
        .execute_batch(
            "DELETE FROM schema_migrations WHERE version>=58;
         DROP TRIGGER coauthor_dirty_fact_insert;
         CREATE TRIGGER fail58 BEFORE INSERT ON schema_migrations WHEN NEW.version=58
         BEGIN SELECT RAISE(ABORT,'late migration failure'); END;",
        )
        .unwrap();
    assert!(f.db().migrate_coauthor_knowledge().is_err());
    assert!(f.db().connection.is_autocommit());
    assert_eq!(f.db().health().unwrap().schema_version, 57);
    assert_eq!(
        f.db()
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_dirty_fact_insert'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    f.db()
        .connection
        .execute_batch("DROP TRIGGER fail58")
        .unwrap();
    f.db().migrate_coauthor_knowledge().unwrap();
    assert_eq!(f.db().health().unwrap().schema_version, 58);
    assert_eq!(
        f.manager
            .current_manuscript(f.chapter)
            .unwrap()
            .unwrap()
            .document_json,
        original
    );
}

#[test]
fn actual_backup_reopen_restores_fact_links_anchors_and_exact_evidence() {
    let mut f = Fixture::new();
    let source = f.fact();
    f.manager
        .search_coauthor_sources(&f.scope, "陆沉", false, 0)
        .unwrap();
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    assert_eq!(source, f.fact());
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let target = f
        .root
        .with_file_name(format!("coauthor-knowledge-restore-{}", Uuid::new_v4()));
    f.manager
        .restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let related = restored
        .coauthor_related_knowledge(&f.scope, &source.key, &source.revision, 0)
        .unwrap();
    assert_eq!(
        related.hits[0]
            .knowledge_context
            .as_ref()
            .unwrap()
            .facts
            .len(),
        2
    );
    let evidence = restored
        .read_coauthor_knowledge_evidence(
            &f.scope,
            &source.key,
            &source.revision,
            f.facts[0].evidence_anchor_ids[0],
            0,
            12000,
        )
        .unwrap();
    assert_eq!(evidence.content, "陆沉😀掌握魂灯。");
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn evidence_tool_dependencies_are_durable_and_source_changes_block_pending_formal_adoption() {
    let mut f = Fixture::new();
    let source = f.fact();
    let draft = f.manager.coauthor_document(&f.scope).unwrap();
    let document = f
        .manager
        .save_coauthor_document(
            &f.scope,
            CoauthorDocument {
                content: "基于魂灯事实试写。".into(),
                ..draft
            },
        )
        .unwrap();
    let run = f
        .manager
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "采用", document.version)
        .unwrap();
    let result = f
        .manager
        .read_coauthor_knowledge_evidence(
            &f.scope,
            &source.key,
            &source.revision,
            f.facts[0].evidence_anchor_ids[0],
            0,
            12000,
        )
        .unwrap();
    let audit =
        vec![serde_json::json!({"kind":"tool","name":"read_knowledge_evidence","result":result})];
    f.manager
        .checkpoint_coauthor_run(&f.scope, run.id, "保留证据", &audit)
        .unwrap();
    let changes = f
        .manager
        .prepare_coauthor_changeset(
            &f.scope,
            CoauthorChangeRequest {
                title: "基于事实采用工作稿".into(),
                include_draft: true,
                expected_document_version: document.version,
                draft_depends_on: vec![],
                items: vec![],
                impacts: vec![],
                coverage: "只读了指定事实的一个证据片段".into(),
            },
            Some(run.id),
        )
        .unwrap();
    assert_eq!(changes.read_dependencies.len(), 1);
    assert_eq!(changes.read_dependencies[0].key, source.key);
    f.manager
        .finish_coauthor_run(&f.scope, run.id, "COMPLETED", "等待作者确认", &audit)
        .unwrap();
    f.manager
        .save_manuscript(
            f.chapter,
            f.revision.document_json.clone(),
            "同文新修订".into(),
        )
        .unwrap();
    assert!(
        f.manager
            .commit_coauthor_changeset(&f.scope, changes.id, changes.version, vec!["draft".into()])
            .is_err()
    );
    assert_eq!(f.manager.list_plan_nodes().unwrap().len(), 1);
    assert_eq!(f.manager.coauthor_document(&f.scope).unwrap(), document);
}
