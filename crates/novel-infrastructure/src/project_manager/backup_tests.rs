use super::*;
use serde_json::json;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("p4-backup-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager
            .create(root.join("original"), "Continuous writing")
            .unwrap();
        Self { manager, root }
    }

    fn project(&self) -> PathBuf {
        self.root.join("original")
    }

    fn backup(&mut self) -> PathBuf {
        self.manager
            .enqueue_job(JobType::Backup, "{}".into())
            .unwrap();
        let job = self.manager.run_next_job().unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
        self.project().join("snapshots").join(job.id.to_string())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn doc(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}

#[test]
fn live_wal_backup_restores_multi_chapter_history_drafts_planning_and_recovery() {
    let mut f = Fixture::new();
    let project_id = f.manager.project_id().unwrap();
    let volume = f
        .manager
        .create_plan_node(None, PlanNodeKind::Volume, "Volume".into())
        .unwrap();
    // Keep a reader on the old database state so checkpoint-and-copy cannot
    // accidentally make this test pass without a consistent SQLite snapshot.
    let reader = rusqlite::Connection::open(f.project().join("project.sqlite")).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM plan_nodes;")
        .unwrap();
    let mut saved = Vec::new();
    let mut chapter_ids = Vec::new();
    for index in 1..=3 {
        let chapter = f
            .manager
            .create_plan_node(
                Some(volume.id),
                PlanNodeKind::Chapter,
                format!("Chapter {index}"),
            )
            .unwrap();
        let first = f
            .manager
            .save_manuscript(
                chapter.id,
                doc(&format!("Saved chapter {index} - 中文")),
                "MANUAL_SAVE".into(),
            )
            .unwrap();
        let draft = f
            .manager
            .save_manuscript_draft(
                chapter.id,
                Some(first.id),
                doc(&format!("Draft chapter {index}")),
                0,
            )
            .unwrap();
        if index == 2 {
            let commit = f
                .manager
                .commit_manuscript_draft(
                    chapter.id,
                    Some(first.id),
                    draft.document_json.unwrap(),
                    draft.version,
                )
                .unwrap();
            saved.push(commit.revision);
        } else {
            saved.push(first);
        }
        chapter_ids.push(chapter.id);
    }
    f.manager
        .save_recovery_log(chapter_ids[2], doc("Interrupted editor content"))
        .unwrap();
    let entity = f
        .manager
        .upsert_entity(EntityInput {
            id: None,
            entity_type: EntityType::Character,
            name: "Reference character".into(),
            aliases: vec![],
            description: "Author setting".into(),
            fixed_attributes_json: "{}".into(),
            tags: vec![],
            base_revision_id: None,
            source_version: None,
            expected_version: None,
        })
        .unwrap();
    let references = f
        .manager
        .save_chapter_entity_references(ChapterEntitySave {
            project_id,
            chapter_id: chapter_ids[0],
            expected_version: 0,
            entity_ids: vec![entity.id],
        })
        .unwrap();
    let planning = f
        .manager
        .save_planning_section_checked(
            PlanningSection {
                id: format!("plan-node:{}", chapter_ids[0]),
                content: "Confirmed plan".into(),
                pending_content: "Unadopted candidate".into(),
                story_state: PlanningStoryState::Confirmed,
                rationale: "Author".into(),
                consequence: String::new(),
                references: vec![],
                updated_at: String::new(),
            },
            0,
        )
        .unwrap();
    let snapshot = f.backup();
    reader.execute_batch("ROLLBACK").unwrap();
    assert!(!snapshot.join("project.sqlite-wal").exists());
    let restored_root = f.root.join("restored");
    let manifest = f
        .manager
        .restore_backup_to_new_project(&snapshot, &restored_root)
        .unwrap();
    assert_eq!(manifest.project_id, project_id);
    let mut restored = ProjectManager::new();
    restored.open(&restored_root).unwrap();
    for (index, revision) in saved.iter().enumerate() {
        let current = restored
            .current_manuscript(chapter_ids[index])
            .unwrap()
            .unwrap();
        assert_eq!(current.id, revision.id);
        assert_eq!(current.content_hash, revision.content_hash);
        assert_eq!(current.document_json, revision.document_json);
    }
    assert_eq!(
        restored
            .list_manuscript_revisions(chapter_ids[1])
            .unwrap()
            .len(),
        2
    );
    let first_draft = restored.current_manuscript_draft(chapter_ids[0]).unwrap();
    assert!(
        first_draft
            .document_json
            .unwrap()
            .contains("Draft chapter 1")
    );
    assert_eq!(first_draft.base_revision_id, Some(saved[0].id));
    assert!(
        restored
            .current_manuscript_draft(chapter_ids[1])
            .unwrap()
            .document_json
            .is_none()
    );
    assert_eq!(
        restored.list_recovery_logs(chapter_ids[2]).unwrap().len(),
        1
    );
    let restored_plan = restored
        .list_versioned_planning_sections()
        .unwrap()
        .into_iter()
        .find(|p| p.section.id == planning.section.id)
        .unwrap();
    assert_eq!(restored_plan.version, planning.version);
    assert_eq!(restored_plan.section.pending_content, "Unadopted candidate");
    let restored_references = restored
        .get_chapter_entity_references(project_id, chapter_ids[0])
        .unwrap();
    assert_eq!(restored_references.version, references.version);
    assert_eq!(restored_references.entities[0].entity.id, entity.id);
    assert_eq!(restored.health_scan().unwrap().sqlite_integrity, "ok");
    let export = restored
        .export_manuscript(ManuscriptExportInput {
            expected_project_id: project_id,
            scope: ManuscriptExportScope::Book {},
            format: ManuscriptExportFormat::Txt,
        })
        .unwrap();
    assert_eq!(export.chapters.len(), 3);
    assert_eq!(export.draft_chapter_count, 2);
    restored.close();
}

#[test]
fn failed_backup_leaves_no_published_or_partial_snapshot_and_same_job_can_retry() {
    let mut f = Fixture::new();
    let manifest_path = f.project().join("project.json");
    let manifest = std::fs::read(&manifest_path).unwrap();
    std::fs::remove_file(&manifest_path).unwrap();
    let job = f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let failed = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(failed.status, JobStatus::Failed);
    assert_eq!(
        std::fs::read_dir(f.project().join("snapshots"))
            .unwrap()
            .count(),
        0
    );
    std::fs::write(&manifest_path, manifest).unwrap();
    f.manager.retry_job(job.id).unwrap();
    let completed = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(completed.status, JobStatus::Succeeded);
    let snapshot = f.project().join("snapshots").join(job.id.to_string());
    let before = std::fs::read(snapshot.join("manifest.json")).unwrap();
    assert!(f.manager.perform_backup(&completed).is_err());
    assert_eq!(
        std::fs::read(snapshot.join("manifest.json")).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_dir(f.project().join("snapshots"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn verified_restore_rejects_corruption_before_publication_and_can_retry() {
    let mut f = Fixture::new();
    let chapter = f
        .manager
        .create_plan_node(None, PlanNodeKind::Chapter, "Chapter".into())
        .unwrap();
    let revision = f
        .manager
        .save_manuscript(chapter.id, doc("Saved manuscript"), "MANUAL_SAVE".into())
        .unwrap();
    let snapshot = f.backup();
    let database_path = snapshot.join("project.sqlite");
    let database = std::fs::read(&database_path).unwrap();
    std::fs::write(&database_path, b"corrupt").unwrap();
    let target = f.root.join("verified");
    let restore = f
        .manager
        .enqueue_job(
            JobType::RestoreVerify,
            json!({"source": snapshot, "target": target}).to_string(),
        )
        .unwrap();
    let failed = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(
        failed
            .error_summary
            .unwrap()
            .contains("backup hash mismatch")
    );
    assert!(!target.exists());
    std::fs::write(&database_path, database).unwrap();
    f.manager.retry_job(restore.id).unwrap();
    assert_eq!(
        f.manager.run_next_job().unwrap().unwrap().status,
        JobStatus::Succeeded
    );
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    assert_eq!(
        restored.current_manuscript(chapter.id).unwrap().unwrap().id,
        revision.id
    );
    restored.close();
    // An existing target must never be replaced by a later verification job.
    std::fs::write(target.join("sentinel.txt"), b"preserve").unwrap();
    f.manager
        .enqueue_job(
            JobType::RestoreVerify,
            json!({"source":snapshot,"target":target}).to_string(),
        )
        .unwrap();
    assert_eq!(
        f.manager.run_next_job().unwrap().unwrap().status,
        JobStatus::Failed
    );
    assert_eq!(
        std::fs::read(target.join("sentinel.txt")).unwrap(),
        b"preserve"
    );
}
