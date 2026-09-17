
use super::{
    CURRENT_SCHEMA_VERSION, Database, FEATURE_CATALOG, FeatureStatus, R4_CONTRACTS,
    R4_MIGRATION_PLAN, R4_SCHEMA_VERSION,
};

#[test]
fn infrastructure_depends_inward() {
    assert_eq!(
        super::linked_layers(),
        ["domain", "application", "infrastructure"]
    );
}

#[test]
fn sqlite_applies_pragmas_and_initial_migration() {
    let database = Database::in_memory().expect("in-memory database");
    let health = database.health().expect("database health");
    assert_eq!(health.schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(R4_SCHEMA_VERSION, 15);
    assert_eq!(health.journal_mode, "memory");
    assert!(health.foreign_keys_enabled);
    assert!(!health.sqlite_version.is_empty());
}

#[test]
fn r4_baseline_exposes_ordered_migration_and_contract_plans() {
    assert_eq!(R4_MIGRATION_PLAN.first().map(|item| item.version), Some(10));
    assert!(
        R4_MIGRATION_PLAN
            .windows(2)
            .all(|pair| pair[0].version < pair[1].version)
    );
    assert_eq!(R4_MIGRATION_PLAN.last().map(|item| item.version), Some(15));
    assert!(
        R4_CONTRACTS
            .iter()
            .any(|item| item.id == "story_bible_entities")
    );
    assert!(R4_CONTRACTS.iter().all(|item| item.introduced_by >= 10));
}

#[test]
fn r5_schema_baseline_creates_governance_tables() {
    let database = Database::in_memory().expect("in-memory database");
    for table in [
        "knowledge_candidates",
        "evidence_anchors",
        "facts",
        "change_sets",
        "change_set_items",
        "knowledge_audit_records",
        "knowledge_outbox_events",
    ] {
        let exists: i64 = database
            .connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .expect("schema lookup");
        assert_eq!(exists, 1, "missing table {table}");
    }
}

#[test]
fn feature_catalog_matches_r4_implemented_surfaces() {
    let jobs = FEATURE_CATALOG
        .iter()
        .find(|item| item.id == "r4_persistent_jobs")
        .expect("jobs feature");
    assert_eq!(jobs.status, FeatureStatus::Implemented);
    assert!(jobs.unavailable_reason.is_none());
    let reliability = FEATURE_CATALOG
        .iter()
        .find(|item| item.id == "r4_reliability")
        .expect("reliability feature");
    assert_eq!(reliability.status, FeatureStatus::Partial);
}

#[test]
fn r4_project_settings_baseline_is_created_with_safe_defaults() {
    let database = Database::in_memory().expect("in-memory database");
    let settings: (String, String, String) = database
            .connection
            .query_row(
                "SELECT writing_style, privacy_level, metadata_json FROM project_settings WHERE project_id='current'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("project settings baseline");
    assert_eq!(settings.0, "");
    assert_eq!(settings.1, "LOCAL_ONLY");
    assert_eq!(settings.2, "{}");
}

#[test]
fn story_bible_entities_are_versioned_and_archivable() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-entities-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    let manifest = manager.create(&root, "实体测试").expect("create project");
    let created = manager
        .upsert_entity(super::EntityInput {
            id: None,
            entity_type: super::EntityType::Character,
            name: "林澈".to_owned(),
            aliases: vec!["阿澈".to_owned()],
            description: "主角".to_owned(),
            fixed_attributes_json: "{\"age\":18}".to_owned(),
            tags: vec!["主角".to_owned()],
            base_revision_id: None,
            source_version: Some("manuscript:1".to_owned()),
            expected_version: None,
        })
        .expect("create entity");
    assert_eq!(created.project_id, manifest.project_id);
    assert_eq!(created.version, 1);
    let revisions = manager
        .list_entity_revisions(created.id)
        .expect("list revisions");
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].aliases, vec!["阿澈"]);

    let updated = manager
        .upsert_entity(super::EntityInput {
            id: Some(created.id),
            entity_type: super::EntityType::Character,
            name: "林澈（修订）".to_owned(),
            aliases: vec![],
            description: "主角，已成长".to_owned(),
            fixed_attributes_json: "{}".to_owned(),
            tags: vec!["主角".to_owned(), "成长".to_owned()],
            base_revision_id: Some(created.current_revision_id),
            source_version: Some("manuscript:2".to_owned()),
            expected_version: Some(1),
        })
        .expect("update entity");
    assert_eq!(updated.version, 2);
    assert_eq!(
        manager
            .list_entity_revisions(created.id)
            .expect("revisions")
            .len(),
        2
    );
    assert!(matches!(
        manager.upsert_entity(super::EntityInput {
            id: Some(created.id),
            entity_type: super::EntityType::Character,
            name: "过期修改".to_owned(),
            aliases: vec![],
            description: String::new(),
            fixed_attributes_json: "{}".to_owned(),
            tags: vec![],
            base_revision_id: None,
            source_version: None,
            expected_version: Some(1),
        }),
        Err(super::EntityStoreError::Contract(
            super::EntityError::Conflict { actual: 2, .. }
        ))
    ));
    let archived = manager
        .set_entity_archived(created.id, true, 2)
        .expect("archive entity");
    assert_eq!(
        archived.lifecycle_status,
        super::EntityLifecycleStatus::Archived
    );
    assert!(
        manager
            .list_entities(false)
            .expect("active entities")
            .is_empty()
    );
    assert_eq!(manager.list_entities(true).expect("all entities").len(), 1);
    let session = manager.current.as_ref().expect("session");
    assert!(
        session
            .database
            .connection
            .execute(
                "DELETE FROM entity_revisions WHERE id = ?1",
                [created.current_revision_id.to_string()],
            )
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn project_creation_is_complete_and_reopenable() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-project-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    let manifest = manager.create(&root, "测试作品").expect("create project");
    assert_eq!(manifest.name, "测试作品");
    assert!(root.join("project.json").is_file());
    assert!(root.join("project.sqlite").is_file());
    assert!(root.join("attachments").is_dir());
    assert!(manager.health().is_ok());
    assert_eq!(
        manager.get_writing_review_policy().expect("default policy"),
        super::WritingReviewPolicy::Balanced
    );
    assert_eq!(
        manager
            .get_audit_flow_settings()
            .expect("default audit flow"),
        super::AuditFlowSettings::default()
    );
    manager
        .save_writing_review_policy(super::WritingReviewPolicy::Required)
        .expect("save policy");
    manager
        .save_audit_flow_settings(super::AuditFlowSettings {
            admission: false,
            manuscript: true,
            knowledge: false,
        })
        .expect("save audit flow");
    assert_eq!(manager.close(), Some(manifest.clone()));
    let reopened = manager.open(&root).expect("reopen project");
    assert_eq!(reopened, manifest);
    assert_eq!(
        manager
            .get_writing_review_policy()
            .expect("persisted policy"),
        super::WritingReviewPolicy::Required
    );
    assert_eq!(
        manager
            .get_audit_flow_settings()
            .expect("persisted audit flow"),
        super::AuditFlowSettings {
            admission: false,
            manuscript: true,
            knowledge: false,
        }
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn recent_project_is_persisted_and_restored_on_startup() {
    let test_root = std::path::PathBuf::from("target")
        .join(format!("ainovel-recent-project-{}", uuid::Uuid::new_v4()));
    let project_root = test_root.join("project");
    let recent_path = test_root.join("app").join("recent-projects.json");

    let manifest = {
        let mut manager = super::ProjectManager::new_with_recent_projects(&recent_path);
        manager
            .create(&project_root, "最近工程")
            .expect("create project")
    };

    let mut restarted = super::ProjectManager::new_with_recent_projects(&recent_path);
    assert_eq!(
        restarted.restore_last_project().expect("restore project"),
        Some(manifest)
    );
    assert_eq!(
        restarted
            .recent_projects()
            .expect("recent projects")
            .first()
            .map(|project| project.root.as_path()),
        Some(project_root.as_path())
    );

    let _ = std::fs::remove_dir_all(test_root);
}

#[test]
fn manuscript_documents_are_validated_normalized_and_hashed() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-manuscript-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "测试作品").expect("create project");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let revision = manager.save_manuscript(chapter.id, r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"你好"}]}]}"#.into(), "test".into()).expect("save");
    assert_eq!(revision.document_schema_version, 1);
    assert!(revision.document_json.contains("blockId"));
    assert_eq!(revision.content_hash.len(), 64);
    assert!(
        manager
            .save_manuscript(chapter.id, "not-json".into(), "test".into())
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn failed_creation_does_not_leave_project_directory() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-project-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    let _ = manager.create(&root, "测试作品").expect("first create");
    assert!(matches!(
        manager.create(&root, "重复作品"),
        Err(super::ProjectError::AlreadyExists(path)) if path == root
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn plan_nodes_can_be_created_and_listed() {
    let root =
        std::path::PathBuf::from("target").join(format!("ainovel-plan-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "测试作品").expect("create project");
    let _outline = manager
        .create_plan_node(None, super::PlanNodeKind::Outline, "故事总纲".to_owned())
        .expect("create outline");
    let volume_manager = manager
        .create_plan_node(
            None,
            super::PlanNodeKind::VolumeManager,
            "分卷管理".to_owned(),
        )
        .expect("create volume manager");
    let volume = manager
        .create_plan_node(
            Some(volume_manager.id),
            super::PlanNodeKind::Volume,
            "第一卷".to_owned(),
        )
        .expect("create volume");
    let chapter = manager
        .create_plan_node(
            Some(volume.id),
            super::PlanNodeKind::Chapter,
            "第一章".to_owned(),
        )
        .expect("create chapter");
    let nodes = manager.list_plan_nodes().expect("list plan nodes");
    assert_eq!(nodes.len(), 4);
    assert!(
        nodes
            .iter()
            .any(|node| node.parent_id == Some(volume_manager.id))
    );
    assert_eq!(chapter.revision, 1);
    let updated = manager
        .update_plan_node(chapter.id, "第一章（修订）".to_owned(), true)
        .expect("archive chapter");
    assert_eq!(updated.revision, 2);
    assert!(updated.archived);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn planning_sections_preserve_content_reasoning_and_references() {
    let root = std::path::PathBuf::from("target").join(format!(
        "ainovel-planning-sections-{}",
        uuid::Uuid::new_v4()
    ));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "设定测试").expect("create project");
    let saved = manager
        .save_planning_section(super::PlanningSection {
            id: "story-core".to_owned(),
            content: "修仙题材，主题是反抗既定命运。".to_owned(),
            pending_content: "保留作为候选的另一版主题。".to_owned(),
            story_state: super::PlanningStoryState::Confirmed,
            rationale: "灵根等级决定资源分配。".to_owned(),
            consequence: "主角会与宗门秩序发生冲突。".to_owned(),
            references: vec!["planning.txt:1-3".to_owned()],
            updated_at: String::new(),
        })
        .expect("save section");
    assert!(!saved.updated_at.is_empty());
    let restored = manager
        .list_planning_sections()
        .expect("list sections")
        .into_iter()
        .find(|section| section.id == "story-core")
        .expect("saved section");
    assert_eq!(restored.content, saved.content);
    assert_eq!(restored.pending_content, saved.pending_content);
    assert_eq!(restored.story_state, saved.story_state);
    assert_eq!(restored.rationale, saved.rationale);
    assert_eq!(restored.consequence, saved.consequence);
    assert_eq!(restored.references, saved.references);
    let explicit_unknown = manager
        .save_planning_section(super::PlanningSection {
            id: "engine-ending".to_owned(),
            content: String::new(),
            pending_content: String::new(),
            story_state: super::PlanningStoryState::Unknown,
            rationale: "作者尚未决定结局".to_owned(),
            consequence: String::new(),
            references: Vec::new(),
            updated_at: String::new(),
        })
        .expect("save explicit unknown");
    assert_eq!(
        explicit_unknown.story_state,
        super::PlanningStoryState::Unknown
    );
    let promoted = manager
        .save_planning_section(super::PlanningSection {
            id: "seed-hook".to_owned(),
            content: "卖点：主角用记忆交换力量。".to_owned(),
            pending_content: String::new(),
            story_state: super::PlanningStoryState::AiSuggested,
            rationale: String::new(),
            consequence: String::new(),
            references: Vec::new(),
            updated_at: String::new(),
        })
        .expect("save confirmed content");
    assert_eq!(promoted.story_state, super::PlanningStoryState::Confirmed);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn planning_chunk_embeddings_are_cached_until_section_content_changes() {
    let root = std::path::PathBuf::from("target").join(format!(
        "ainovel-planning-chunk-embeddings-{}",
        uuid::Uuid::new_v4()
    ));
    let mut manager = super::ProjectManager::new();
    manager
        .create(&root, "分块向量测试")
        .expect("create project");
    let mut section = super::PlanningSection {
        id: "seed-premise".to_owned(),
        content: "主角在灾后城市寻找失踪姐姐。".to_owned(),
        pending_content: String::new(),
        story_state: super::PlanningStoryState::Confirmed,
        rationale: String::new(),
        consequence: String::new(),
        references: Vec::new(),
        updated_at: String::new(),
    };
    manager
        .save_planning_section(section.clone())
        .expect("save section");
    manager
        .generate_planning_chunk_embedding(super::PlanningChunkEmbedding {
            chunk_id: "seed-premise#chunk-1".to_owned(),
            section_id: section.id.clone(),
            chunk_index: 1,
            profile_id: uuid::Uuid::new_v4(),
            model_id: "embedding-test".to_owned(),
            dimensions: 2,
            content_hash: "sha256:test".to_owned(),
            vector: vec![0.1, 0.2],
            updated_at: String::new(),
        })
        .expect("save chunk embedding");
    assert_eq!(
        manager
            .list_planning_chunk_embeddings()
            .expect("list chunk embeddings")
            .len(),
        1
    );

    section.pending_content = "仅修改候选稿，不应让分块向量失效。".to_owned();
    manager
        .save_planning_section(section.clone())
        .expect("save pending content");
    assert_eq!(
        manager
            .list_planning_chunk_embeddings()
            .expect("list cached chunk embeddings")
            .len(),
        1
    );

    section.content = "主角改为在沿海城市寻找失踪的导师。".to_owned();
    manager
        .save_planning_section(section)
        .expect("save changed content");
    assert!(
        manager
            .list_planning_chunk_embeddings()
            .expect("list invalidated chunk embeddings")
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn search_handles_chinese_short_queries_and_archived_entities() {
    let root =
        std::path::PathBuf::from("target").join(format!("ainovel-search-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "搜索作品").expect("create project");
    let entity = manager
        .upsert_entity(super::EntityInput {
            id: None,
            entity_type: super::EntityType::Character,
            name: "林澈".into(),
            aliases: vec!["小林".into()],
            description: "北境的调查者".into(),
            fixed_attributes_json: "{}".into(),
            tags: vec!["北境".into()],
            base_revision_id: None,
            source_version: Some("test:1".into()),
            expected_version: None,
        })
        .expect("entity");
    assert_eq!(
        manager
            .search_project("林".into(), Some("ENTITY".into()), 50, 0)
            .expect("short search")
            .len(),
        1
    );
    assert_eq!(
        manager
            .search_project("调查者".into(), None, 50, 0)
            .expect("fts search")
            .len(),
        1
    );
    assert!(
        manager
            .search_project("林!".into(), None, 50, 0)
            .expect("special character search")
            .is_empty()
    );
    assert_eq!(
        manager
            .search_project("北境".into(), None, 50, 0)
            .expect("deduplicated search")
            .len(),
        1
    );
    manager
        .set_entity_archived(entity.id, true, entity.version)
        .expect("archive");
    assert!(
        manager
            .search_project("林".into(), None, 50, 0)
            .expect("archived search")
            .is_empty()
    );
    manager.rebuild_search_index().expect("rebuild");
    assert!(
        manager
            .search_project("林".into(), None, 50, 0)
            .expect("rebuilt search")
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn context_assembly_attaches_only_active_project_sources() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-context-search-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "上下文搜索").expect("create project");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    manager
        .upsert_entity(super::EntityInput {
            id: None,
            entity_type: super::EntityType::Character,
            name: "沈砚".into(),
            aliases: vec![],
            description: "负责调查失踪案".into(),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: None,
            source_version: Some("entity:1".into()),
            expected_version: None,
        })
        .expect("entity");
    for action in [
        super::AiAction::Draft,
        super::AiAction::Continue,
        super::AiAction::Rewrite,
        super::AiAction::Polish,
        super::AiAction::Summarize,
    ] {
        let package = manager
                .assemble_context_with_project_knowledge(
                    &novel_application::AssembleContextInput {
                        chapter_id: chapter.id,
                        target_revision_id: None,
                        action,
                        chapter_title: "第一章".into(),
                        chapter_plan: "调查失踪案".into(),
                        volume_plan: "第一卷调查失踪案的全过程。".into(),
                        document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"沈砚来到车站。"}]}]}"#.into(),
                        selection: action
                            .requires_selection()
                            .then(|| "沈砚来到车站。".to_owned()),
                        instruction: Some("调查失踪案".into()),
                        input_token_budget: 4096,
                    },
                )
                .expect("context package");
        assert!(
            package
                .retrieval_evidence
                .iter()
                .any(|item| item.source_revision == "entity:1")
        );
        assert_eq!(package.entity_source_status, "RETRIEVAL_ATTACHED");
        assert_eq!(package.action, action);
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn context_assembly_includes_formal_settings_and_preserves_unknown_state() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-context-settings-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager
        .create(&root, "正式设定上下文")
        .expect("create project");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    for (id, content) in [
        ("engine-protagonist", "主角需要隐藏不能持久战斗的弱点。"),
        (
            "frame-setting",
            "境界分为炼气、筑基、金丹；跨境界战斗必须付出寿元代价。",
        ),
        (
            "frame-narrative",
            "不使用第一人称，采用第三人称有限视角，只跟随主角。",
        ),
    ] {
        manager
            .save_planning_section(super::PlanningSection {
                id: id.to_owned(),
                content: content.to_owned(),
                pending_content: "这段候选不得进入正文上下文。".to_owned(),
                story_state: super::PlanningStoryState::Confirmed,
                rationale: String::new(),
                consequence: String::new(),
                references: Vec::new(),
                updated_at: String::new(),
            })
            .expect("save planning section");
    }
    manager
        .save_planning_section(super::PlanningSection {
            id: "engine-ending".to_owned(),
            content: "结局暂不决定。".to_owned(),
            pending_content: String::new(),
            story_state: super::PlanningStoryState::Deferred,
            rationale: String::new(),
            consequence: String::new(),
            references: Vec::new(),
            updated_at: String::new(),
        })
        .expect("save deferred state");
    manager
        .save_planning_section(super::PlanningSection {
            id: "cast-arcs".to_owned(),
            content: "配角秘密由作者保留。".to_owned(),
            pending_content: String::new(),
            story_state: super::PlanningStoryState::AuthorReserved,
            rationale: String::new(),
            consequence: String::new(),
            references: Vec::new(),
            updated_at: String::new(),
        })
        .expect("save author-reserved state");
    manager
        .save_planning_section(super::PlanningSection {
            id: "seed-hook".to_owned(),
            content: String::new(),
            pending_content: "候选钩子：失踪者留下第二封信。".to_owned(),
            story_state: super::PlanningStoryState::AiSuggested,
            rationale: String::new(),
            consequence: String::new(),
            references: Vec::new(),
            updated_at: String::new(),
        })
        .expect("save AI suggestion");

    let package = manager
        .assemble_context_with_project_knowledge(&novel_application::AssembleContextInput {
            chapter_id: chapter.id,
            target_revision_id: None,
            action: super::AiAction::Draft,
            chapter_title: "第一章".into(),
            chapter_plan: "主角首次越境战斗。".into(),
            volume_plan: "第一卷建立境界规则与越境代价。".into(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: Some("按正式设定创作".into()),
            input_token_budget: 8_192,
        })
        .expect("context package");

    assert!(
        package
            .user_prompt
            .contains("[P1 作品正式设定与生成前判断]")
    );
    assert!(package.user_prompt.contains("主角目标与内在需求"));
    assert!(
        package
            .user_prompt
            .contains("主角需要隐藏不能持久战斗的弱点。")
    );
    assert!(package.user_prompt.contains("舞台、硬规则与资源限制"));
    assert!(package.user_prompt.contains("境界分为炼气、筑基、金丹"));
    assert!(
        package
            .user_prompt
            .contains("叙述视角硬约束：本作品固定使用第三人称")
    );
    assert!(
        package
            .user_prompt
            .contains("人物卡状态：尚未建立人物实体卡")
    );
    assert!(package.user_prompt.contains("未决内容规则"));
    assert!(package.user_prompt.contains("可以提出候选"));
    assert!(package.user_prompt.contains("未决与作者保留边界"));
    assert!(package.user_prompt.contains("结局状态与承诺兑现：暂不决定"));
    assert!(
        package
            .user_prompt
            .contains("人物弧光、秘密与信息差：作者保留")
    );
    assert!(
        package
            .user_prompt
            .contains("AI 建议（未确认，不得当作正式事实）")
    );
    assert!(
        package
            .user_prompt
            .contains("候选钩子：失踪者留下第二封信。")
    );
    assert!(!package.user_prompt.contains("这段候选不得进入正文上下文"));
    assert!(
        package
            .retrieval_evidence
            .iter()
            .any(|item| item.authority == super::ContextAuthority::ProjectSetting)
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn context_assembly_promotes_finalized_facts_into_authoritative_section() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-context-facts-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    let manifest = manager.create(&root, "上下文事实").expect("create project");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let revision = manager
            .save_manuscript(
                chapter.id,
                r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"林澈不饮酒。"}]}]}"#
                    .into(),
                "TEST".into(),
            )
            .expect("save revision");
    let anchor = super::EvidenceAnchor {
        id: uuid::Uuid::new_v4(),
        project_id: manifest.project_id,
        chapter_id: chapter.id,
        source_revision_id: revision.id,
        block_id: "paragraph-1".into(),
        start_offset: 0,
        end_offset: 6,
        source_version: revision.id.to_string(),
        source_hash: revision.content_hash.clone(),
        lifecycle_status: super::KnowledgeLifecycleStatus::Active,
        created_by: "tester".into(),
        created_at: super::now_timestamp(),
        updated_at: super::now_timestamp(),
    };
    manager
        .create_evidence_anchor(anchor.clone())
        .expect("create anchor");
    let candidate = super::KnowledgeCandidate {
        id: uuid::Uuid::new_v4(),
        project_id: manifest.project_id,
        chapter_id: chapter.id,
        proposal_id: None,
        candidate_status: super::CandidateStatus::Pending,
        review_decision: None,
        reviewer: None,
        reviewed_at: None,
        fact: super::Fact {
            knowledge_id: uuid::Uuid::new_v4(),
            project_id: manifest.project_id,
            knowledge_version: 1,
            subject: "林澈".into(),
            predicate: "不饮酒".into(),
            object: "保持".into(),
            source_revision_id: revision.id,
            evidence_anchor_ids: vec![anchor.id],
            lifecycle_status: super::KnowledgeLifecycleStatus::NeedsReview,
            created_by: "tester".into(),
            created_at: super::now_timestamp(),
            updated_at: super::now_timestamp(),
        },
        created_at: super::now_timestamp(),
        updated_at: super::now_timestamp(),
    };
    manager
        .create_knowledge_candidate(candidate.clone())
        .expect("create candidate");
    manager
        .review_knowledge_candidate(
            candidate.id,
            super::CandidateStatus::Pending,
            super::ReviewDecision::Approve,
            "reviewer".into(),
        )
        .expect("approve candidate");
    manager
        .finalize_knowledge_candidates(chapter.id, vec![candidate.id], "tester".into())
        .expect("finalize candidate");
    manager
        .rebuild_world_state("tester".into())
        .expect("rebuild world state");
    manager
        .create_relation(super::Relation {
            id: uuid::Uuid::new_v4(),
            project_id: manifest.project_id,
            relation_version: 1,
            from_knowledge_id: candidate.fact.knowledge_id,
            to_knowledge_id: candidate.fact.knowledge_id,
            relation_type: "自我约束".into(),
            evidence_anchor_ids: vec![anchor.id],
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: super::now_timestamp(),
            updated_at: super::now_timestamp(),
        })
        .expect("create relation");
    manager
        .create_belief(super::Belief {
            id: uuid::Uuid::new_v4(),
            project_id: manifest.project_id,
            belief_version: 1,
            holder_knowledge_id: candidate.fact.knowledge_id,
            proposition: "饮酒会暴露自己的旧伤".into(),
            evidence_anchor_ids: vec![anchor.id],
            lifecycle_status: super::KnowledgeLifecycleStatus::Active,
            created_by: "tester".into(),
            created_at: super::now_timestamp(),
            updated_at: super::now_timestamp(),
        })
        .expect("create belief");

    let package = manager
            .assemble_context_with_project_knowledge(
                &novel_application::AssembleContextInput {
                    chapter_id: chapter.id,
                    target_revision_id: Some(revision.id),
                    action: super::AiAction::Continue,
                    chapter_title: "第一章".into(),
                    chapter_plan: "林澈拒绝饮酒".into(),
                    volume_plan: "第一卷围绕林澈调查旧案。".into(),
                    document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"林澈接过茶盏。"}]}]}"#.into(),
                    selection: None,
                    instruction: Some("续写林澈拒绝饮酒的场面".into()),
                    input_token_budget: 4096,
                },
            )
            .expect("context package");

    assert!(package.user_prompt.contains("[P1 已批准事实]"));
    assert!(package.user_prompt.contains("林澈 不饮酒 保持"));
    assert!(
        package
            .user_prompt
            .contains("所属分卷规划：第一卷围绕林澈调查旧案。")
    );
    assert!(package.user_prompt.contains("正式关系："));
    assert!(package.user_prompt.contains("角色知识边界："));
    assert!(package.user_prompt.contains("饮酒会暴露自己的旧伤"));
    assert!(package.retrieval_evidence.iter().any(|item| {
        item.authority == super::ContextAuthority::AuthoritativeFact
            && item.source_revision.starts_with("fact:")
    }));
    assert!(
        package
            .retrieval_evidence
            .iter()
            .any(|item| { item.source_revision.starts_with("relation:") })
    );
    assert!(
        package
            .retrieval_evidence
            .iter()
            .any(|item| { item.source_revision.starts_with("belief:") })
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn persistent_jobs_enforce_lifecycle_and_retry_failed_work() {
    let root =
        std::path::PathBuf::from("target").join(format!("ainovel-jobs-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "任务测试").expect("create");
    let job = manager
        .enqueue_job(super::JobType::RebuildSearchIndex, "{}".into())
        .expect("enqueue");
    assert_eq!(job.status, super::JobStatus::Queued);
    manager
        .update_job_status(job.id, super::JobStatus::Running, 10, None)
        .expect("running");
    let failed = manager
        .update_job_status(
            job.id,
            super::JobStatus::Failed,
            35,
            Some("索引不可用".into()),
        )
        .expect("failed");
    assert_eq!(failed.error_summary.as_deref(), Some("索引不可用"));
    assert!(failed.acknowledged_at.is_none());
    assert_eq!(manager.acknowledge_failed_jobs().expect("acknowledge"), 1);
    let acknowledged = manager.get_job(job.id).expect("acknowledged job");
    assert!(acknowledged.acknowledged_at.is_some());
    assert_eq!(
        manager
            .acknowledge_failed_jobs()
            .expect("second acknowledge"),
        0
    );
    let retried = manager.retry_job(job.id).expect("retry");
    assert_eq!(retried.status, super::JobStatus::Queued);
    assert_eq!(retried.attempt_count, 1);
    assert!(retried.acknowledged_at.is_none());
    assert!(
        manager
            .update_job_status(job.id, super::JobStatus::Succeeded, 100, None)
            .is_err()
    );
    let cancelled = manager.request_job_cancel(job.id).expect("cancel");
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.status, super::JobStatus::Cancelled);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn job_history_keeps_latest_hundred_terminal_jobs_and_preserves_active_jobs() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-job-retention-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "任务保留测试").expect("create");

    let mut terminal_jobs = Vec::new();
    for _ in 0..105 {
        terminal_jobs.push(
            manager
                .enqueue_job(super::JobType::HealthScan, "{}".into())
                .expect("enqueue terminal job"),
        );
    }
    let active_job = manager
        .enqueue_job(super::JobType::Backup, "{}".into())
        .expect("enqueue active job");
    manager
        .append_job_event(terminal_jobs[0].id, "QUEUED", "将被清理", 0)
        .expect("append event");

    for job in &terminal_jobs {
        manager
            .update_job_status(job.id, super::JobStatus::Running, 5, None)
            .expect("start job");
        manager
            .update_job_status(job.id, super::JobStatus::Succeeded, 100, None)
            .expect("finish job");
    }

    let jobs = manager.list_jobs().expect("list jobs");
    assert_eq!(
        jobs.iter()
            .filter(|job| job.status == super::JobStatus::Succeeded)
            .count(),
        super::JOB_HISTORY_RETENTION
    );
    assert!(
        jobs.iter()
            .any(|job| job.id == active_job.id && job.status == super::JobStatus::Queued)
    );
    assert!(manager.get_job(terminal_jobs[0].id).is_err());
    assert!(manager.get_job(terminal_jobs[5].id).is_ok());
    let event_count: i64 = manager
        .current
        .as_ref()
        .expect("open project")
        .database
        .connection
        .query_row(
            "SELECT COUNT(*) FROM job_events WHERE job_id=?1",
            [terminal_jobs[0].id.to_string()],
            |row| row.get(0),
        )
        .expect("count cascaded events");
    assert_eq!(event_count, 0);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ai_jobs_use_a_separate_queue_and_persist_stage_events() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-ai-jobs-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "AI 任务测试").expect("create");
    let ai_job = manager
        .enqueue_job(super::JobType::AiPlanningExtract, "{}".into())
        .expect("enqueue ai");
    let system_job = manager
        .enqueue_job(super::JobType::HealthScan, "{}".into())
        .expect("enqueue system");
    manager
        .append_job_event(ai_job.id, "QUEUED", "任务已排队", 0)
        .expect("append event");
    manager
        .update_job_payload(ai_job.id, r#"{"finalRequestBody":"{}"}"#.into())
        .expect("update payload");
    assert_eq!(
        manager.get_job(ai_job.id).expect("get updated job").payload,
        r#"{"finalRequestBody":"{}"}"#
    );
    assert_eq!(
        manager.claim_next_job().expect("claim system").unwrap().id,
        system_job.id
    );
    assert_eq!(
        manager.claim_next_ai_job().expect("claim ai").unwrap().id,
        ai_job.id
    );
    let events = manager.list_job_events(ai_job.id).expect("list events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].message, "任务已排队");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn opening_project_recovers_running_jobs_and_claims_once() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-job-recovery-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "任务恢复").expect("create");
    let first = manager
        .enqueue_job(super::JobType::HealthScan, "{}".into())
        .expect("enqueue first");
    let second = manager
        .enqueue_job(super::JobType::Backup, "{}".into())
        .expect("enqueue second");
    let cancelled = manager
        .enqueue_job(super::JobType::RestoreVerify, "{}".into())
        .expect("enqueue cancelled");
    manager
        .update_job_status(first.id, super::JobStatus::Running, 42, None)
        .expect("running");
    manager
        .update_job_status(cancelled.id, super::JobStatus::Running, 18, None)
        .expect("running cancelled");
    manager
        .request_job_cancel(cancelled.id)
        .expect("request cancel");
    manager.close();
    manager.open(&root).expect("reopen");
    let recovered = manager.list_jobs().expect("list recovered");
    assert!(recovered.iter().any(|job| job.id == first.id
        && job.status == super::JobStatus::Queued
        && job.progress == 0));
    assert!(
        recovered
            .iter()
            .any(|job| job.id == cancelled.id && job.status == super::JobStatus::Cancelled)
    );
    let claimed = manager
        .claim_next_job()
        .expect("claim")
        .expect("job available");
    assert_eq!(claimed.id, first.id);
    assert_eq!(claimed.status, super::JobStatus::Running);
    assert_eq!(claimed.attempt_count, 1);
    assert!(manager.claim_next_job().expect("second claim").is_some());
    let _ = std::fs::remove_dir_all(root);
    let _ = second;
}

#[test]
fn run_next_job_persists_success_and_backup_artifacts() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-job-run-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "任务执行").expect("create");
    std::fs::write(root.join("attachments").join("note.txt"), b"attachment").expect("attachment");
    manager
        .enqueue_job(super::JobType::Backup, "{}".into())
        .expect("enqueue");
    let completed = manager.run_next_job().expect("run").expect("completed");
    assert_eq!(completed.status, super::JobStatus::Succeeded);
    let snapshot = root.join("snapshots").join(completed.id.to_string());
    assert!(snapshot.join("project.sqlite").is_file());
    assert_eq!(manager.health_scan().expect("health").status, "HEALTHY");
    let restored = root.with_file_name(format!(
        "{}-restored",
        root.file_name().unwrap().to_string_lossy()
    ));
    manager
        .restore_backup_to_new_project(&snapshot, &restored)
        .expect("restore");
    assert!(restored.join("project.sqlite").is_file());
    assert_eq!(
        std::fs::read(restored.join("attachments").join("note.txt")).expect("restored attachment"),
        b"attachment"
    );
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(restored);
}

#[test]
fn crash_marker_startup_report_and_diagnostics_are_privacy_safe() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-diagnostics-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "诊断测试").expect("create");
    manager
        .write_crash_marker(&super::CrashMarker {
            process_type: "desktop".into(),
            session_id: uuid::Uuid::new_v4(),
            occurred_at: "now".into(),
            last_trace_id: Some("trace".into()),
            active_project: manager.current().map(|m| m.project_id),
            active_task: None,
            build_version: "test".into(),
            crash_phase: "RUNNING".into(),
        })
        .expect("marker");
    let report = manager.startup_recovery_report().expect("report");
    assert!(report.crash_marker_present);
    let path = manager.create_diagnostic_package().expect("diagnostics");
    let content = std::fs::read_to_string(path).expect("read diagnostics");
    assert!(!content.contains("project.sqlite"));
    manager.clear_crash_marker().expect("clear marker");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn invalid_plan_hierarchy_and_stale_updates_are_rejected() {
    let root =
        std::path::PathBuf::from("target").join(format!("ainovel-rules-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "规则测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    assert!(matches!(
        manager.create_plan_node(
            Some(chapter.id),
            super::PlanNodeKind::Volume,
            "非法分卷".into()
        ),
        Err(super::PlanError::InvalidParentKind)
    ));
    manager
        .update_plan_node_checked(chapter.id, "第一章修订".into(), false, 1)
        .expect("checked update");
    assert!(matches!(
        manager.update_plan_node_checked(chapter.id, "过期修改".into(), false, 1),
        Err(super::PlanError::Conflict { .. })
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn manuscript_history_is_immutable_and_conflicts_are_detected() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-immutable-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "正文测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let doc = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"p1"},"content":[{"type":"text","text":"正文"}]}]}"#;
    let first = manager
        .save_manuscript_checked(chapter.id, None, doc.into(), "FIRST".into())
        .expect("first");
    let second = manager
        .save_manuscript_checked(chapter.id, Some(first.id), doc.into(), "SECOND".into())
        .expect("second");
    assert!(
        matches!(manager.save_manuscript_checked(chapter.id, Some(first.id), doc.into(), "STALE".into()), Err(super::ManuscriptError::Conflict { actual: Some(actual), .. }) if actual == second.id)
    );
    let session = manager.current.as_ref().expect("session");
    assert!(
        session
            .database
            .connection
            .execute(
                "UPDATE manuscript_revisions SET creation_reason = 'BAD' WHERE id = ?1",
                [first.id.to_string()]
            )
            .is_err()
    );
    assert!(
        session
            .database
            .connection
            .execute(
                "DELETE FROM manuscript_revisions WHERE id = ?1",
                [first.id.to_string()]
            )
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn recovery_logs_survive_project_reopen() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-recovery-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "恢复测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let doc = r#"{"type":"doc","content":[]}"#;
    manager
        .save_recovery_log(chapter.id, doc.into())
        .expect("save recovery");
    manager.close();
    manager.open(&root).expect("reopen");
    assert_eq!(manager.list_all_recovery_logs().expect("logs").len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ai_proposals_are_audited_without_changing_manuscript_history() {
    let root =
        std::path::PathBuf::from("target").join(format!("ainovel-ai-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "AI 测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "DeepSeek".into(),
            provider: super::ModelProvider::DeepSeek,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.deepseek.com".into(),
            model_id: "deepseek-chat".into(),
            context_window: 8_192,
            max_output_tokens: 1_024,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 1,
            input_price_micros_per_million: 2_000_000,
            output_price_micros_per_million: 4_000_000,
            price_currency: "USD".into(),
        })
        .expect("profile");
    let fallback = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "备用模型".into(),
            provider: super::ModelProvider::OpenAi,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.openai.com/v1".into(),
            model_id: "gpt-test".into(),
            context_window: 8_192,
            max_output_tokens: 1_024,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 1,
            input_price_micros_per_million: 1_000_000,
            output_price_micros_per_million: 2_000_000,
            price_currency: "USD".into(),
        })
        .expect("fallback profile");
    manager
        .save_project_ai_task_override(
            super::AiTaskKind::Writing,
            &super::AiTaskPreference {
                profile_id: Some(profile.id),
                fallback_profile_id: Some(fallback.id),
                temperature: Some(0.7),
                max_output_tokens: Some(2_048),
                prompt: super::AiTaskPromptPreference {
                    system_prompt: Some("项目专用写作提示".into()),
                    instruction_template: Some("章节 {{chapterTitle}}".into()),
                    context: super::AiTaskContextPreference {
                        include_project_knowledge: Some(false),
                        input_token_budget: Some(16_384),
                        ..super::AiTaskContextPreference::default()
                    },
                },
            },
        )
        .expect("project override");
    let overrides = manager
        .get_project_ai_task_overrides()
        .expect("project overrides");
    assert!(overrides.available);
    assert_eq!(
        overrides
            .get(super::AiTaskKind::Writing)
            .and_then(|item| item.prompt.system_prompt.as_deref()),
        Some("项目专用写作提示")
    );
    manager
        .remove_project_ai_task_override(super::AiTaskKind::Writing)
        .expect("remove override");
    assert!(
        manager
            .get_project_ai_task_overrides()
            .expect("overrides after removal")
            .get(super::AiTaskKind::Writing)
            .is_none()
    );
    assert!(!profile.has_secret);
    let context =
        novel_application::ContextAssembler::assemble(&novel_application::AssembleContextInput {
            chapter_id: chapter.id,
            target_revision_id: None,
            action: super::AiAction::Continue,
            chapter_title: chapter.title,
            chapter_plan: "继续推进冲突".into(),
            volume_plan: "第一卷推进主线冲突。".into(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 4_096,
        })
        .expect("context");
    let task_id = manager
        .create_ai_task(profile.id, &context, None)
        .expect("task");
    manager
        .record_ai_task_fallback(task_id, fallback.id, "PROVIDER_TIMEOUT")
        .expect("record fallback");
    let session = manager.current.as_ref().expect("session");
    let (task_contract_json, context_section_audit_json): (String, String) = session
        .database
        .connection
        .query_row(
            "SELECT task_contract_json, context_section_audit_json FROM ai_tasks WHERE id=?1",
            [task_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("task audit metadata");
    assert!(task_contract_json.contains("DRAFT_WRITER"));
    assert!(context_section_audit_json.contains("CURRENT_DRAFT"));
    assert!(!task_contract_json.contains("继续推进冲突"));
    assert!(!context_section_audit_json.contains("继续推进冲突"));
    let proposal = manager
        .complete_ai_task(task_id, &context, "新的段落。".into(), None)
        .expect("proposal");
    assert_eq!(proposal.status, super::AiProposalStatus::Pending);
    let runs = manager.list_ai_runs(Some(10)).expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].task_key, "writing");
    assert_eq!(runs[0].source, "WRITING");
    let chapter_id = chapter.id.to_string();
    assert_eq!(runs[0].chapter_id.as_deref(), Some(chapter_id.as_str()));
    assert_eq!(runs[0].attempt_count, 2);
    assert_eq!(runs[0].profile_name, "备用模型");
    assert_eq!(runs[0].retry_reason.as_deref(), Some("PROVIDER_TIMEOUT"));
    assert_eq!(runs[0].price_currency, "USD");
    assert!(runs[0].estimated_cost_micros.is_some());
    let usage = manager.get_ai_usage_summary(30).expect("usage summary");
    assert_eq!(usage.days, 30);
    assert_eq!(usage.total.len(), 1);
    assert_eq!(usage.total[0].run_count, 1);
    assert_eq!(
        usage.total[0].input_tokens,
        u64::from(runs[0].estimated_input_tokens)
    );
    assert_eq!(
        usage.total[0].output_tokens,
        u64::from(runs[0].estimated_output_tokens)
    );
    assert_eq!(usage.daily.len(), 1);
    assert_eq!(usage.by_task.len(), 1);
    let feedback = manager
        .rate_ai_proposal(
            proposal.id,
            super::AiProposalFeedbackRating::Helpful,
            Some("冲突推进自然".into()),
        )
        .expect("feedback");
    assert_eq!(feedback.rating, super::AiProposalFeedbackRating::Helpful);
    let reviews = manager
        .list_ai_proposal_reviews(chapter.id, None)
        .expect("proposal reviews");
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].validation.status, "WARNING");
    assert_eq!(
        reviews[0]
            .feedback
            .as_ref()
            .and_then(|item| item.note.as_deref()),
        Some("冲突推进自然")
    );
    manager
        .decide_ai_proposal(proposal.id, super::AiProposalStatus::Accepted, None)
        .expect("accept");
    let quality = manager
        .get_ai_quality_summary(20, None)
        .expect("quality summary");
    assert_eq!(quality.total_proposals, 1);
    assert_eq!(quality.total_rated, 1);
    assert_eq!(quality.total_helpful, 1);
    assert_eq!(quality.total_with_issues, 1);
    assert_eq!(quality.groups.len(), 1);
    assert_eq!(quality.groups[0].accepted_count, 1);
    assert_eq!(quality.groups[0].warning_count, 1);
    let needs_input_task = manager
        .create_ai_task(profile.id, &context, None)
        .expect("task");
    let needs_input_proposal = manager
        .complete_ai_task(
            needs_input_task,
            &context,
            "[上下文不足]\n- 主角卡：未建立\n- 境界规则：缺失".into(),
            None,
        )
        .expect("needs-input proposal");
    let needs_input_review = manager
        .list_ai_proposal_reviews(chapter.id, None)
        .expect("needs-input review")
        .into_iter()
        .find(|item| item.proposal.id == needs_input_proposal.id)
        .expect("needs-input review item");
    assert_eq!(needs_input_review.validation.status, "NEEDS_INPUT");
    assert!(
        manager
            .decide_ai_proposal(
                needs_input_proposal.id,
                super::AiProposalStatus::Accepted,
                None,
            )
            .is_err()
    );
    assert!(
        manager
            .decide_ai_proposal(
                needs_input_proposal.id,
                super::AiProposalStatus::PartiallyAccepted,
                Some("模型说明不能作为正文".into()),
            )
            .is_err()
    );
    assert_eq!(
        manager
            .decide_ai_proposal(
                needs_input_proposal.id,
                super::AiProposalStatus::Rejected,
                None,
            )
            .expect("reject needs-input proposal")
            .status,
        super::AiProposalStatus::Rejected
    );
    let quality = manager
        .get_ai_quality_summary(20, None)
        .expect("quality summary");
    assert_eq!(quality.total_proposals, 2);
    assert_eq!(quality.total_with_issues, 2);
    assert_eq!(quality.groups[0].needs_input_count, 1);
    manager
        .current
        .as_ref()
        .expect("session")
        .database
        .connection
        .execute(
            "UPDATE ai_run_records SET created_at='2000-01-01T00:00:00Z'",
            [],
        )
        .expect("age run records");
    let recent_quality = manager
        .get_ai_quality_summary(20, Some(90))
        .expect("recent quality summary");
    assert_eq!(recent_quality.total_proposals, 0);
    assert!(
        manager
            .current_manuscript(chapter.id)
            .expect("manuscript")
            .is_none()
    );
    let session = manager.current.as_ref().expect("session");
    assert!(
        session
            .database
            .connection
            .execute(
                "UPDATE ai_proposals SET output_text='tampered' WHERE id=?1",
                [proposal.id.to_string()],
            )
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn consistency_review_proposals_are_read_only() {
    let root = std::path::PathBuf::from("target").join(format!(
        "ainovel-consistency-review-{}",
        uuid::Uuid::new_v4()
    ));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "一致性审核测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "审核模型".into(),
            provider: super::ModelProvider::DeepSeek,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.deepseek.com".into(),
            model_id: "deepseek-chat".into(),
            context_window: 32_768,
            max_output_tokens: 4_096,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 1,
            input_price_micros_per_million: 1_000_000,
            output_price_micros_per_million: 2_000_000,
            price_currency: "CNY".into(),
        })
        .expect("profile");
    let context = novel_application::ContextAssembler::assemble(
            &novel_application::AssembleContextInput {
                chapter_id: chapter.id,
                target_revision_id: None,
                action: super::AiAction::ConsistencyCheck,
                chapter_title: chapter.title,
                chapter_plan: "主角进入城市并寻找失踪的师父。".into(),
                volume_plan: "第一卷围绕寻找师父展开。".into(),
                document_json:
                    r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"主角抵达城门。"}]}]}"#
                        .into(),
                selection: None,
                instruction: None,
                input_token_budget: 4_096,
            },
        )
        .expect("context");
    let review_context_version = context.context_version.clone();
    let task_id = manager
        .create_ai_task(profile.id, &context, Some(super::ReviewPurpose::Admission))
        .expect("task");
    let proposal = manager
        .complete_ai_task(
            task_id,
            &context,
            "审核结论：阻断\n[阻断] 主角姓名未确定｜主角卡未建立｜先确定主角姓名并建立主角卡。"
                .into(),
            None,
        )
        .expect("proposal");

    assert_eq!(proposal.action, super::AiAction::ConsistencyCheck);
    let review = manager
        .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Admission))
        .expect("review")
        .into_iter()
        .find(|item| item.proposal.id == proposal.id)
        .expect("review item");
    assert_eq!(
        review.consistency.expect("consistency report").verdict,
        super::AiConsistencyVerdict::Blocked
    );
    let manuscript_context = context
        .clone()
        .with_review_purpose(super::ReviewPurpose::Manuscript);
    let manuscript_task = manager
        .create_ai_task(
            profile.id,
            &manuscript_context,
            Some(super::ReviewPurpose::Manuscript),
        )
        .expect("manuscript task");
    let manuscript_proposal = manager
        .complete_ai_task(
            manuscript_task,
            &manuscript_context,
            "审核结论：阻断\n[阻断] 正文位置冲突｜当前状态位于城外｜修改正文位置。".into(),
            None,
        )
        .expect("manuscript proposal");
    assert_eq!(
        manuscript_proposal.review_purpose,
        super::ReviewPurpose::Manuscript
    );
    assert_eq!(
        manager
            .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Admission),)
            .expect("admission reviews")
            .len(),
        1
    );
    assert_eq!(
        manager
            .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Manuscript),)
            .expect("manuscript reviews")
            .len(),
        1
    );
    let mut fresh_reviews = manager
        .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Admission))
        .expect("fresh reviews");
    super::ProjectManager::mark_consistency_review_freshness(
        &mut fresh_reviews,
        Some(&review_context_version),
    );
    assert_eq!(
        fresh_reviews[0].consistency_freshness,
        Some(super::ConsistencyReviewFreshness::Fresh)
    );
    let mut stale_reviews = manager
        .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Admission))
        .expect("stale reviews");
    super::ProjectManager::mark_consistency_review_freshness(
        &mut stale_reviews,
        Some("changed-context-version"),
    );
    assert_eq!(
        stale_reviews[0].consistency_freshness,
        Some(super::ConsistencyReviewFreshness::Stale)
    );
    let admission = manager
        .chapter_writing_admission(
            chapter.id,
            Some(&review_context_version),
            super::WritingReviewPolicy::Balanced,
        )
        .expect("admission");
    assert!(!admission.allowed);
    assert_eq!(admission.blocker_count, 1);
    assert!(admission.reason.is_some());
    assert_eq!(
        admission.review_freshness,
        super::ConsistencyReviewFreshness::Fresh
    );
    let stale_admission = manager
        .chapter_writing_admission(
            chapter.id,
            Some("changed-context-version"),
            super::WritingReviewPolicy::Balanced,
        )
        .expect("stale admission");
    assert!(stale_admission.allowed);
    assert_eq!(
        stale_admission.review_freshness,
        super::ConsistencyReviewFreshness::Stale
    );
    assert!(
        !manager
            .chapter_writing_admission(
                chapter.id,
                Some("changed-context-version"),
                super::WritingReviewPolicy::Required,
            )
            .expect("strict stale admission")
            .allowed
    );
    assert!(
        manager
            .chapter_writing_admission(
                chapter.id,
                Some(&review_context_version),
                super::WritingReviewPolicy::Advisory,
            )
            .expect("advisory admission")
            .allowed
    );
    assert!(
        manager
            .decide_ai_proposal(proposal.id, super::AiProposalStatus::Accepted, None)
            .is_err()
    );
    assert!(
        manager
            .decide_ai_proposal(
                proposal.id,
                super::AiProposalStatus::PartiallyAccepted,
                Some("审核报告不能写入正文。".into()),
            )
            .is_err()
    );
    assert_eq!(
        manager
            .decide_ai_proposal(proposal.id, super::AiProposalStatus::Rejected, None)
            .expect("close review")
            .status,
        super::AiProposalStatus::Rejected
    );
    assert!(
        manager
            .chapter_writing_admission(
                chapter.id,
                Some(&review_context_version),
                super::WritingReviewPolicy::Balanced,
            )
            .expect("admission after close")
            .allowed
    );
    assert_eq!(
        manager
            .list_ai_proposal_reviews(chapter.id, Some(super::ReviewPurpose::Manuscript),)
            .expect("manuscript review remains open")
            .first()
            .and_then(|item| item.consistency.as_ref())
            .map(|report| report.verdict),
        Some(super::AiConsistencyVerdict::Blocked)
    );
    assert!(
        !manager
            .chapter_writing_admission(chapter.id, None, super::WritingReviewPolicy::Required,)
            .expect("strict admission without review")
            .allowed
    );
    assert_eq!(
        manager.list_ai_runs(Some(10)).expect("runs")[0].task_key,
        "consistencyReview"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn project_ai_task_overrides_can_be_saved_as_a_batch() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-ai-batch-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "批量覆盖测试").expect("create");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "批量模型".into(),
            provider: super::ModelProvider::DeepSeek,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.deepseek.com".into(),
            model_id: "deepseek-chat".into(),
            context_window: 32_768,
            max_output_tokens: 4_096,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 1,
            input_price_micros_per_million: 1_000_000,
            output_price_micros_per_million: 2_000_000,
            price_currency: "CNY".into(),
        })
        .expect("profile");
    let preference = super::AiTaskPreference {
        profile_id: Some(profile.id),
        ..super::AiTaskPreference::default()
    };
    let preferences = super::AiTaskPreferences {
        work_design: preference.clone(),
        outline: preference.clone(),
        volume_planning: preference.clone(),
        chapter_split: preference.clone(),
        chapter_plan: preference.clone(),
        consistency_review: preference.clone(),
        writing: preference.clone(),
        knowledge_extraction: preference,
    };

    manager
        .save_project_ai_task_overrides(&preferences)
        .expect("batch overrides");
    let overrides = manager
        .get_project_ai_task_overrides()
        .expect("project overrides");
    assert!(overrides.available);
    for task in [
        super::AiTaskKind::WorkDesign,
        super::AiTaskKind::Outline,
        super::AiTaskKind::VolumePlanning,
        super::AiTaskKind::ChapterSplit,
        super::AiTaskKind::ChapterPlan,
        super::AiTaskKind::ConsistencyReview,
        super::AiTaskKind::Writing,
        super::AiTaskKind::KnowledgeExtraction,
    ] {
        assert_eq!(
            overrides.get(task).and_then(|item| item.profile_id),
            Some(profile.id)
        );
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn failed_ai_tasks_do_not_create_proposals() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-ai-fail-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "AI 失败测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "云端".into(),
            provider: super::ModelProvider::OpenAiCompatible,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.example.com/v1".into(),
            model_id: "model".into(),
            context_window: 4096,
            max_output_tokens: 512,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 0,
            input_price_micros_per_million: 0,
            output_price_micros_per_million: 0,
            price_currency: "USD".into(),
        })
        .expect("profile");
    let context =
        novel_application::ContextAssembler::assemble(&novel_application::AssembleContextInput {
            chapter_id: chapter.id,
            target_revision_id: None,
            action: super::AiAction::Summarize,
            chapter_title: "第一章".into(),
            chapter_plan: String::new(),
            volume_plan: String::new(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        })
        .expect("context");
    let task_id = manager
        .create_ai_task(profile.id, &context, None)
        .expect("task");
    manager
        .fail_ai_task(task_id, &super::AiError::Timeout)
        .expect("fail");
    assert!(
        manager
            .list_ai_proposals(chapter.id, None)
            .expect("proposals")
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn planning_ai_runs_are_recorded_with_fallback_and_cost_snapshot() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-planning-run-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "AI 运行测试").expect("create");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "规划模型".into(),
            provider: super::ModelProvider::DeepSeek,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.deepseek.com".into(),
            model_id: "deepseek-v4-flash".into(),
            context_window: 128_000,
            max_output_tokens: 8_192,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 120,
            retry_limit: 1,
            input_price_micros_per_million: 2_000_000,
            output_price_micros_per_million: 4_000_000,
            price_currency: "USD".into(),
        })
        .expect("profile");
    let fallback = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "备用规划模型".into(),
            provider: super::ModelProvider::OpenAi,
            capability: super::ModelCapability::Chat,
            base_url: "https://api.openai.com/v1".into(),
            model_id: "gpt-test".into(),
            context_window: 128_000,
            max_output_tokens: 8_192,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 120,
            retry_limit: 1,
            input_price_micros_per_million: 1_000_000,
            output_price_micros_per_million: 2_000_000,
            price_currency: "CNY".into(),
        })
        .expect("fallback");
    let run_id = manager
        .start_ai_run(super::AiRunStart {
            task: super::AiTaskKind::WorkDesign,
            source: super::AiRunSource::Planning,
            job_id: None,
            chapter_id: None,
            display_title: "核心前提",
            profile_id: profile.id,
            prompt_version: "planning-v1",
            estimated_input_tokens: 2_000,
        })
        .expect("run");
    manager
        .record_ai_run_request(
            run_id,
            "https://api.deepseek.com/chat/completions",
            r#"{"model":"deepseek-v4-flash","messages":[]}"#,
        )
        .expect("request snapshot");
    manager
        .record_ai_run_fallback(run_id, fallback.id, "PROVIDER_TIMEOUT")
        .expect("fallback");
    manager
        .complete_ai_run(run_id, None, 500)
        .expect("complete");
    let runs = manager.list_ai_runs(Some(10)).expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].task_key, "workDesign");
    assert_eq!(runs[0].source, "PLANNING");
    assert_eq!(runs[0].chapter_id, None);
    assert_eq!(runs[0].chapter_title, "核心前提");
    assert_eq!(runs[0].profile_name, "备用规划模型");
    assert_eq!(runs[0].attempt_count, 2);
    assert_eq!(runs[0].price_currency, "CNY");
    assert_eq!(runs[0].estimated_cost_micros, Some(3_000));
    let request = manager.get_ai_run_request(run_id).expect("request");
    assert_eq!(
        request.endpoint.as_deref(),
        Some("https://api.deepseek.com/chat/completions")
    );
    assert_eq!(
        request.request_body.as_deref(),
        Some(r#"{"model":"deepseek-v4-flash","messages":[]}"#)
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ai_history_retains_stats_and_limits_request_snapshots_to_latest_hundred() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-ai-run-retention-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "AI 运行保留测试").expect("create");

    let mut run_ids = Vec::new();
    for index in 0..105_i64 {
        let run_id = uuid::Uuid::new_v4();
        manager
                .current
                .as_ref()
                .expect("open project")
                .database
                .connection
                .execute(
                    "INSERT INTO ai_run_records (
                        id, task_key, source, display_title, profile_id, action, status,
                        estimated_input_tokens, estimated_output_tokens, price_currency, prompt_version
                     ) VALUES (?1, 'writing', 'WRITING', ?2, NULL, 'DRAFT', 'COMPLETED', ?3, ?4, 'USD', 'test-v1')",
                    rusqlite::params![
                        run_id.to_string(),
                        format!("run-{index}"),
                        index + 1,
                        (index + 1) * 2
                    ],
                )
                .expect("insert run");
        run_ids.push(run_id);
    }

    for run_id in &run_ids {
        manager
            .record_ai_run_request(
                *run_id,
                "https://api.example.com/chat/completions",
                r#"{"model":"test-model","messages":[]}"#,
            )
            .expect("record request snapshot");
    }

    let (run_count, snapshot_count, input_tokens, output_tokens): (i64, i64, i64, i64) = manager
        .current
        .as_ref()
        .expect("open project")
        .database
        .connection
        .query_row(
            "SELECT COUNT(*),
                            COUNT(request_body),
                            COALESCE(SUM(estimated_input_tokens), 0),
                            COALESCE(SUM(estimated_output_tokens), 0)
                     FROM ai_run_records",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read retention summary");
    assert_eq!(run_count, 105);
    assert_eq!(
        snapshot_count,
        i64::try_from(super::AI_REQUEST_SNAPSHOT_RETENTION).expect("retention fits i64")
    );
    assert_eq!(input_tokens, (1..=105).sum::<i64>());
    assert_eq!(output_tokens, (1..=105).map(|value| value * 2).sum::<i64>());

    let oldest = manager.get_ai_run_request(run_ids[0]).expect("old request");
    assert!(oldest.endpoint.is_none());
    assert!(oldest.request_body.is_none());
    let newest = manager
        .get_ai_run_request(run_ids[104])
        .expect("new request");
    assert_eq!(
        newest.endpoint.as_deref(),
        Some("https://api.example.com/chat/completions")
    );
    assert!(newest.request_body.is_some());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn embedding_profiles_cannot_create_writing_tasks() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-embedding-role-{}", uuid::Uuid::new_v4()));
    let mut manager = super::ProjectManager::new();
    manager.create(&root, "Embedding 角色测试").expect("create");
    let chapter = manager
        .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
        .expect("chapter");
    let profile = manager
        .upsert_model_profile(super::ModelProfileInput {
            id: None,
            name: "硅基流动 Embedding".into(),
            provider: super::ModelProvider::SiliconFlow,
            capability: super::ModelCapability::Embedding,
            base_url: "https://api.siliconflow.cn/v1".into(),
            model_id: "embedding-model".into(),
            context_window: 4096,
            max_output_tokens: 512,
            privacy_level: super::PrivacyLevel::AllowCloud,
            timeout_seconds: 30,
            retry_limit: 0,
            input_price_micros_per_million: 0,
            output_price_micros_per_million: 0,
            price_currency: "USD".into(),
        })
        .expect("profile");
    let context =
        novel_application::ContextAssembler::assemble(&novel_application::AssembleContextInput {
            chapter_id: chapter.id,
            target_revision_id: None,
            action: super::AiAction::Continue,
            chapter_title: "第一章".into(),
            chapter_plan: String::new(),
            volume_plan: String::new(),
            document_json: r#"{"type":"doc","content":[]}"#.into(),
            selection: None,
            instruction: None,
            input_token_budget: 2048,
        })
        .expect("context");
    assert!(matches!(
        manager.create_ai_task(profile.id, &context, None),
        Err(super::AiError::Contract(
            novel_domain::AiContractError::InvalidProviderCapability
        ))
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn malformed_manifest_and_database_are_rejected() {
    let root = std::path::PathBuf::from("target")
        .join(format!("ainovel-corrupt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("dir");
    std::fs::write(root.join("project.json"), b"not-json").expect("manifest");
    let mut manager = super::ProjectManager::new();
    assert!(matches!(
        manager.open(&root),
        Err(super::ProjectError::Manifest(_))
    ));
    std::fs::write(
        root.join("project.json"),
        serde_json::to_vec(&super::ProjectManifest {
            project_id: uuid::Uuid::new_v4(),
            format_version: 1,
            name: "损坏项目".into(),
            created_at: "0".into(),
        })
        .expect("json"),
    )
    .expect("manifest");
    std::fs::write(root.join("project.sqlite"), b"not-sqlite").expect("database");
    assert!(matches!(
        manager.open(&root),
        Err(super::ProjectError::Database(_))
    ));
    let _ = std::fs::remove_dir_all(root);
}
