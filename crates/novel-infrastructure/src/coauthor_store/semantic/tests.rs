use super::*;
use crate::coauthor_store::tests::{entity, project};

fn profile() -> ModelProfile {
    ModelProfile {
        id: Uuid::new_v4(),
        name: "向量测试".into(),
        provider: ModelProvider::SiliconFlow,
        capability: ModelCapability::Embedding,
        base_url: "http://127.0.0.1:9/v1".into(),
        model_id: "embedding-test".into(),
        context_window: 8192,
        max_output_tokens: 1024,
        privacy_level: PrivacyLevel::AllowCloud,
        timeout_seconds: 10,
        retry_limit: 0,
        input_price_micros_per_million: 0,
        output_price_micros_per_million: 0,
        price_currency: "CNY".into(),
        secret_ref: None,
        has_secret: false,
        created_at: now_timestamp(),
        updated_at: now_timestamp(),
    }
}

#[test]
fn clearing_derived_cache_preserves_sources_and_invalidates_inflight_batches() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "保留原设定", "不会被清理缓存删除");
    manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile()), vec!["ENTITY".into()])
        .unwrap();
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    manager
        .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
        .unwrap();
    assert!(manager.clear_coauthor_semantic_cache(&scope, 0).is_err());
    let cleared = manager.clear_coauthor_semantic_cache(&scope, 1).unwrap();
    assert_eq!(cleared.indexed_chunks, 0);
    assert_eq!(cleared.total_chunks, 0);
    assert!(cleared.pending_source_updates > 0);
    assert_eq!(cleared.settings.version, 2);
    assert!(
        manager
            .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
            .is_err()
    );
    assert!(
        manager
            .search_coauthor_sources(&scope, "保留原设定", false, 0)
            .unwrap()
            .hits
            .iter()
            .any(|hit| hit.content.contains("不会被清理缓存删除"))
    );
    let retry = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    manager
        .commit_coauthor_semantic_batch(&scope, &retry, &[vec![0., 1., 0.]])
        .unwrap();
    assert_eq!(
        manager
            .coauthor_semantic_status(&scope)
            .unwrap()
            .indexed_chunks,
        1
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn expired_cached_revisions_requeue_for_repair_instead_of_remaining_permanently_indexed() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "有效规则", "精读始终使用真实版本");
    let settings = manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile()), vec!["ENTITY".into()])
        .unwrap()
        .settings;
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    manager
        .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
        .unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection
        .execute(
            "UPDATE coauthor_semantic_chunks SET revision='expired-cache'",
            [],
        )
        .unwrap();
    let found = manager
        .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
        .unwrap();
    assert!(found.hits.is_empty());
    assert!(found.coverage.contains("跳过 1 项过期来源"));
    assert!(found.pending_index_updates > 0);
    let repair = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    assert_eq!(repair.chunks.len(), 1);
    assert_ne!(repair.chunks[0].revision, "expired-cache");
    manager
        .commit_coauthor_semantic_batch(&scope, &repair, &[vec![1., 0.]])
        .unwrap();
    assert_eq!(
        manager
            .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
            .unwrap()
            .hits
            .len(),
        1
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn explicit_permission_is_versioned_scoped_and_never_includes_messages_or_drafts() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "魂灯", "以遗忘换力量");
    assert!(manager.prepare_coauthor_semantic_batch(&scope).is_err());
    let profile = profile();
    assert!(
        manager
            .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["MESSAGE".into()])
            .is_err()
    );
    let mut local = profile.clone();
    local.privacy_level = PrivacyLevel::LocalOnly;
    assert!(
        manager
            .save_coauthor_semantic_settings(&scope, 0, Some(&local), vec!["ENTITY".into()])
            .is_err()
    );
    let allowed = manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
        .unwrap();
    assert_eq!(allowed.settings.version, 1);
    assert!(
        manager
            .save_coauthor_semantic_settings(&scope, 0, None, vec![])
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..scope.clone()
    };
    assert!(manager.prepare_coauthor_semantic_batch(&wrong).is_err());
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    assert_eq!(batch.chunks.len(), 1);
    manager
        .save_coauthor_semantic_settings(&scope, 1, None, vec![])
        .unwrap();
    assert!(
        manager
            .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
            .is_err()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn semantic_vectors_find_different_wording_with_exact_unicode_offsets_and_no_keyword_hit() {
    let (mut manager, root, scope) = project();
    let description = format!(
        "{}陆沉😀从此再也记不起母亲的声音。",
        "无关记录。".repeat(260)
    );
    let source = entity(&mut manager, "照夜秘术", &description);
    let profile = profile();
    let settings = manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
        .unwrap()
        .settings;
    assert!(
        manager
            .search_coauthor_sources(&scope, "牺牲回忆换取力量", false, 0)
            .unwrap()
            .hits
            .is_empty()
    );
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    assert_eq!(batch.chunks.len(), 2);
    assert!(
        batch
            .chunks
            .iter()
            .all(|chunk| chunk.text.chars().count() <= 1361)
    );
    manager
        .commit_coauthor_semantic_batch(&scope, &batch, &[vec![0., 1.], vec![1., 0.]])
        .unwrap();
    let found = manager
        .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
        .unwrap();
    assert_eq!(found.hits.len(), 1);
    let hit = &found.hits[0];
    assert_eq!(hit.key, format!("ENTITY:{}", source.id));
    assert_eq!(hit.offset, 1200);
    assert!(hit.content.contains("陆沉😀"));
    assert!(
        manager
            .read_coauthor_source(&scope, &hit.key, &hit.revision, hit.offset, 1200)
            .is_ok()
    );
    assert!(
        manager
            .prepare_coauthor_semantic_batch(&scope)
            .unwrap()
            .chunks
            .is_empty()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn pending_source_updates_and_new_revisions_never_use_old_vectors_or_accept_late_results() {
    let (mut manager, root, scope) = project();
    let chapter = manager
        .create_plan_node(None, PlanNodeKind::Chapter, "旧章".into())
        .unwrap();
    let json = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"作者唯一原稿😀"}]}]}"#;
    manager
        .save_manuscript(chapter.id, json.into(), "TEST".into())
        .unwrap();
    let settings = manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile()), vec!["MANUSCRIPT".into()])
        .unwrap()
        .settings;
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    manager
        .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
        .unwrap();
    manager
        .save_manuscript(chapter.id, json.into(), "同文新修订".into())
        .unwrap();
    assert!(
        manager
            .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
            .unwrap()
            .hits
            .is_empty()
    );
    assert!(
        manager
            .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.]])
            .is_err()
    );
    let updated = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    assert_ne!(updated.chunks[0].revision, batch.chunks[0].revision);
    assert_eq!(
        manager
            .coauthor_semantic_status(&scope)
            .unwrap()
            .indexed_chunks,
        0
    );
    assert!(
        manager
            .current_manuscript(chapter.id)
            .unwrap()
            .unwrap()
            .document_json
            .contains("作者唯一原稿")
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn invalid_batch_vectors_roll_back_and_spaces_do_not_mix_across_model_or_endpoint_changes() {
    let (mut manager, root, scope) = project();
    entity(&mut manager, "甲规则", "回忆");
    entity(&mut manager, "乙规则", "力量");
    let mut profile = profile();
    manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile), vec!["ENTITY".into()])
        .unwrap();
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    for vectors in [
        vec![vec![1., 0.]],
        vec![vec![1., 0.], vec![1.]],
        vec![vec![1., 0.], vec![0., 0.]],
        vec![vec![1., 0.], vec![f32::NAN, 1.]],
    ] {
        assert!(
            manager
                .commit_coauthor_semantic_batch(&scope, &batch, &vectors)
                .is_err()
        );
        assert_eq!(
            manager
                .coauthor_semantic_status(&scope)
                .unwrap()
                .indexed_chunks,
            0
        );
    }
    manager
        .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.], vec![1., 0.]])
        .unwrap();
    assert!(
        manager
            .search_coauthor_semantic_vector(&scope, &batch.settings, &[1.], 0)
            .is_err()
    );
    profile.base_url = "http://127.0.0.1:10/v1".into();
    let changed = manager
        .save_coauthor_semantic_settings(&scope, 1, Some(&profile), vec!["ENTITY".into()])
        .unwrap();
    assert_eq!(changed.indexed_chunks, 0);
    assert_ne!(changed.settings.fingerprint, batch.settings.fingerprint);
    assert!(
        manager
            .search_coauthor_semantic_vector(&scope, &batch.settings, &[1., 0.], 0)
            .is_err()
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn bounded_batches_resume_after_reopen_and_actual_backup_restore_without_reembedding() {
    let (mut manager, root, scope) = project();
    for index in 0..17 {
        entity(&mut manager, &format!("规则{index}"), "事实正文");
    }
    let settings = manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile()), vec!["ENTITY".into()])
        .unwrap()
        .settings;
    for size in [8, 8, 1] {
        let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
        assert_eq!(batch.chunks.len(), size);
        manager
            .commit_coauthor_semantic_batch(&scope, &batch, &vec![vec![1., 0.]; size])
            .unwrap();
        manager.close();
        manager.open(&root).unwrap();
    }
    let first = manager
        .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
        .unwrap();
    let second = manager
        .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 12)
        .unwrap();
    assert_eq!(first.hits.len(), 12);
    assert!(first.has_more);
    assert_eq!(second.hits.len(), 5);
    assert!(!second.has_more);
    manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded);
    let target = root.with_file_name(format!("semantic-restore-{}", Uuid::new_v4()));
    manager
        .restore_backup_to_new_project(root.join("snapshots").join(job.id.to_string()), &target)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    assert_eq!(
        restored
            .coauthor_semantic_status(&scope)
            .unwrap()
            .indexed_chunks,
        17
    );
    assert_eq!(
        restored
            .search_coauthor_semantic_vector(&scope, &settings, &[1., 0.], 0)
            .unwrap()
            .hits,
        first.hits
    );
    drop(restored);
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(target);
}

#[test]
fn migration_failure_and_late_cache_write_fault_leave_no_partial_data_or_author_changes() {
    let (mut manager, root, scope) = project();
    let original = entity(&mut manager, "原始规则", "作者原始设定");
    let db = &manager.current.as_ref().unwrap().database;
    db.connection.execute_batch(
        "DROP TABLE coauthor_semantic_vectors; DROP TABLE coauthor_semantic_chunks; DROP TABLE coauthor_semantic_settings;
         DELETE FROM schema_migrations WHERE version>=59;
         CREATE TRIGGER fail59 BEFORE INSERT ON schema_migrations WHEN NEW.version=59
         BEGIN SELECT RAISE(ABORT,'late fault'); END;").unwrap();
    assert!(db.migrate_coauthor_semantic().is_err());
    assert_eq!(db.health().unwrap().schema_version, 58);
    db.connection.execute_batch("DROP TRIGGER fail59").unwrap();
    db.migrate_coauthor_semantic().unwrap();
    assert_eq!(db.health().unwrap().schema_version, 59);
    manager
        .save_coauthor_semantic_settings(&scope, 0, Some(&profile()), vec!["ENTITY".into()])
        .unwrap();
    entity(&mut manager, "第二规则", "其他");
    let batch = manager.prepare_coauthor_semantic_batch(&scope).unwrap();
    let db = &manager.current.as_ref().unwrap().database;
    db.connection.execute_batch(
        "CREATE TRIGGER fail_vector BEFORE INSERT ON coauthor_semantic_vectors
         WHEN (SELECT COUNT(*) FROM coauthor_semantic_vectors)>0 BEGIN SELECT RAISE(ABORT,'late vector fault'); END;").unwrap();
    assert!(
        manager
            .commit_coauthor_semantic_batch(&scope, &batch, &[vec![1., 0.], vec![1., 0.]])
            .is_err()
    );
    assert_eq!(
        manager
            .coauthor_semantic_status(&scope)
            .unwrap()
            .indexed_chunks,
        0
    );
    assert_eq!(
        manager.list_entity_revisions(original.id).unwrap()[0].description,
        "作者原始设定"
    );
    drop(manager);
    let _ = std::fs::remove_dir_all(root);
}
