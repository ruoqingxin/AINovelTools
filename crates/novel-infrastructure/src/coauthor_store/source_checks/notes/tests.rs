use super::*;
use crate::coauthor_store::source_checks::tests::{chapter, input};
use crate::coauthor_store::tests::project;
use serde_json::json;
use std::path::PathBuf;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    page: CoauthorCheckPage,
    key: String,
    run: Uuid,
}

impl Fixture {
    fn new(text: &str) -> Self {
        let (mut manager, root, scope) = project();
        let key = chapter(&mut manager, text);
        let page = manager
            .create_coauthor_source_check(&scope, input(&["MANUSCRIPT"]))
            .unwrap();
        let run = manager
            .start_coauthor_run(&scope, Uuid::new_v4(), "查证", 0)
            .unwrap()
            .id;
        Self {
            manager,
            root,
            scope,
            page,
            key,
            run,
        }
    }

    fn note(&self, start: usize, end: usize, quote: &str) -> CoauthorCheckNoteInput {
        CoauthorCheckNoteInput {
            check_id: self.page.check.id,
            key: self.key.clone(),
            revision: self.page.entries[0].revision.clone(),
            start,
            end,
            expected_version: 0,
            analysis: "仅此段涉及记忆代价，未确认与后文的关系。".into(),
            questions: "叙事时间是否在突破之前？".into(),
            quote: quote.into(),
        }
    }

    fn read(&mut self, start: usize, limit: usize, sent: bool) -> CoauthorCheckRead {
        let read = self
            .manager
            .read_coauthor_check_source(
                &self.scope,
                self.run,
                self.page.check.id,
                &self.key,
                start,
                limit,
            )
            .unwrap();
        if sent {
            self.manager
                .acknowledge_coauthor_check_reads(&self.scope, self.run, &[read.read_id])
                .unwrap();
        }
        read
    }

    fn notes(&self, offset: u32) -> CoauthorCheckNotesPage {
        self.manager
            .get_coauthor_check_notes(&self.scope, self.page.check.id, &self.key, offset)
            .unwrap()
    }

    fn save(&mut self, note: CoauthorCheckNoteInput) -> Result<CoauthorCheckNote, CoauthorError> {
        self.manager
            .save_coauthor_check_note(&self.scope, self.run, note)
    }

    fn cleanup(self) {
        drop(self.manager);
        let _ = std::fs::remove_dir_all(self.root);
    }
}

#[test]
fn notes_require_current_run_delivery_exact_unicode_range_and_local_quote() {
    let mut f = Fixture::new("甲😀乙丙丁");
    let note = f.note(0, 3, "😀乙");
    assert!(f.save(note.clone()).is_err());
    let first = f.read(0, 2, false);
    assert!(f.save(note.clone()).is_err());
    f.manager
        .acknowledge_coauthor_check_reads(&f.scope, f.run, &[first.read_id])
        .unwrap();
    f.read(3, 2, true);
    assert!(f.save(note.clone()).is_err());
    f.read(1, 2, true);
    assert!(f.save(f.note(0, 3, "丙丁")).is_err());
    assert!(f.save(f.note(0, 3, "")).is_err());
    assert!(f.save(f.note(0, 6, "甲")).is_err());
    let saved = f.save(note).unwrap();
    assert_eq!((saved.start, saved.end, saved.version), (0, 3, 1));
    assert_eq!(f.notes(0).noted_chars, 3);
    let progress = f
        .manager
        .get_coauthor_source_check(&f.scope, f.page.check.id, 0)
        .unwrap();
    assert_eq!(progress.check.reviewed, 0);
    assert!(!progress.check.complete);
    f.manager
        .finish_coauthor_run(&f.scope, f.run, "COMPLETED", "分段结果", &[])
        .unwrap();
    f.run = f
        .manager
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "继续", 0)
        .unwrap()
        .id;
    // An old receipt or a restored note is not raw text received by the new run.
    assert!(f.save(f.note(3, 5, "丙丁")).is_err());
    f.cleanup();
}

#[test]
fn revisions_use_exact_ranges_cas_and_keep_previous_analysis_without_overlap() {
    let mut f = Fixture::new("甲😀乙丙丁");
    f.read(0, 100, true);
    let initial = f.save(f.note(0, 3, "😀")).unwrap();
    assert!(f.save(f.note(0, 3, "😀")).is_err());
    assert!(f.save(f.note(2, 5, "丙丁")).is_err());
    let mut update = f.note(0, 3, "😀乙");
    update.expected_version = 1;
    update.analysis = "修正：这里仍只是回忆，不能当作突破后的状态。".into();
    let latest = f.save(update.clone()).unwrap();
    assert_eq!(latest.version, 2);
    assert!(f.save(update).is_err());
    f.save(f.note(3, 5, "丙丁")).unwrap();
    let notes = f.notes(0);
    assert_eq!(notes.total_notes, 2);
    assert_eq!(notes.noted_chars, 5);
    assert_eq!(notes.notes[0].id, latest.id);
    let db = &f.manager.current.as_ref().unwrap().database;
    let history: String = db
        .connection
        .query_row(
            "SELECT analysis FROM coauthor_check_notes WHERE id=?1",
            [initial.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history, initial.analysis);
    f.cleanup();
}

#[test]
fn changed_and_archived_sources_keep_notes_but_make_them_historical() {
    let mut f = Fixture::new("旧代价");
    f.read(0, 100, true);
    let saved = f.save(f.note(0, 3, "旧代价")).unwrap();
    let id = f.key.strip_prefix("MANUSCRIPT:").unwrap().parse().unwrap();
    f.manager
        .save_manuscript(
            id,
            json!({"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"旧代价"}]}]})
            .to_string(),
            "同文新修订".into(),
        )
        .unwrap();
    assert!(f.notes(0).stale);
    assert_eq!(f.notes(0).notes[0].id, saved.id);
    let mut revised = f.note(0, 3, "旧代价");
    revised.expected_version = 1;
    assert!(f.save(revised).is_err());
    f.manager
        .search_coauthor_sources(&f.scope, "代价", false, 0)
        .unwrap();
    assert!(f.notes(0).stale);
    f.manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute(
            "UPDATE plan_nodes SET archived=1,revision=revision+1 WHERE id=?1",
            [id.to_string()],
        )
        .unwrap();
    assert!(f.notes(0).stale);
    assert_eq!(f.notes(0).notes[0].quote, "旧代价");
    f.cleanup();
}

#[test]
fn notes_are_scoped_to_project_branch_check_and_active_run() {
    let mut f = Fixture::new("甲乙");
    f.read(0, 100, true);
    f.save(f.note(0, 2, "甲")).unwrap();
    let fork = f
        .manager
        .fork_coauthor_session(&f.scope, "另一分支".into())
        .unwrap();
    let other = CoauthorScope {
        session_id: fork.id,
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .get_coauthor_check_notes(&other, f.page.check.id, &f.key, 0)
            .is_err()
    );
    let wrong = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .get_coauthor_check_notes(&wrong, f.page.check.id, &f.key, 0)
            .is_err()
    );
    let run = f
        .manager
        .start_coauthor_run(&other, Uuid::new_v4(), "继续", 1)
        .unwrap();
    assert!(
        f.manager
            .save_coauthor_check_note(&other, run.id, f.note(0, 2, "甲"))
            .is_err()
    );
    assert!(
        f.manager
            .get_coauthor_check_notes(&f.scope, Uuid::new_v4(), &f.key, 0)
            .is_err()
    );
    f.manager.cancel_coauthor_run(&f.scope, f.run).unwrap();
    let mut note = f.note(0, 2, "甲");
    note.expected_version = 1;
    assert!(f.save(note).is_err());
    assert_eq!(f.notes(0).total_notes, 1);
    f.cleanup();
}

#[test]
fn note_pages_are_bounded_sorted_and_do_not_read_whole_source_text() {
    let mut f = Fixture::new("甲甲甲甲甲甲甲甲甲甲甲甲");
    f.read(0, 100, true);
    for i in (0..12).rev() {
        f.save(f.note(i, i + 1, "甲")).unwrap();
    }
    let first = f.notes(0);
    assert_eq!(first.notes.len(), 5);
    assert_eq!(first.total_notes, 12);
    assert_eq!(first.noted_chars, 12);
    assert!(first.has_more);
    assert_eq!(first.notes[0].start, 0);
    assert_eq!(f.notes(5).notes[0].start, 5);
    assert_eq!(f.notes(10).notes.len(), 2);
    assert!(!f.notes(10).has_more);
    assert!(f.notes(u32::MAX).notes.is_empty());
    // Metadata queries must work even when the current raw document cannot be parsed.
    f.manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute(
            "INSERT INTO manuscript_revisions(id,chapter_id,document_json,content_hash,creation_reason)
             VALUES(?1,?2,'broken','synthetic-invalid','故障注入')",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                f.key.strip_prefix("MANUSCRIPT:").unwrap()
            ],
        )
        .unwrap();
    let historical = f.notes(0);
    assert!(historical.stale);
    assert_eq!(historical.notes.len(), 5);
    f.cleanup();
}

#[test]
fn actual_backup_restores_analysis_questions_versions_and_can_resume() {
    let mut f = Fixture::new("甲😀乙丙");
    f.read(0, 2, true);
    f.save(f.note(0, 2, "😀")).unwrap();
    let mut update = f.note(0, 2, "甲😀");
    update.expected_version = 1;
    update.analysis = "此处只确认记忆的描写，后文影响仍待核对。".into();
    let saved = f.save(update).unwrap();
    f.manager
        .finish_coauthor_run(&f.scope, f.run, "COMPLETED", "阶段结束", &[])
        .unwrap();
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let target = f
        .root
        .with_file_name(format!("coauthor-notes-restored-{}", Uuid::new_v4()));
    f.manager
        .restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target)
        .unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let notes = restored
        .get_coauthor_check_notes(&f.scope, f.page.check.id, &f.key, 0)
        .unwrap();
    assert!(!notes.stale);
    assert_eq!(notes.notes[0].id, saved.id);
    assert_eq!(notes.notes[0].version, 2);
    assert_eq!(notes.notes[0].analysis, saved.analysis);
    assert_eq!(notes.notes[0].questions, saved.questions);
    assert_eq!(
        restored
            .current
            .as_ref()
            .unwrap()
            .database
            .connection
            .query_row(
                "SELECT COUNT(*) FROM coauthor_check_notes WHERE check_id=?1",
                [f.page.check.id.to_string()],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    let run = restored
        .start_coauthor_run(&f.scope, Uuid::new_v4(), "恢复分析并继续", 0)
        .unwrap();
    let read = restored
        .read_coauthor_check_source(&f.scope, run.id, f.page.check.id, &f.key, 2, 2)
        .unwrap();
    restored
        .acknowledge_coauthor_check_reads(&f.scope, run.id, &[read.read_id])
        .unwrap();
    restored
        .save_coauthor_check_note(&f.scope, run.id, f.note(2, 4, "乙丙"))
        .unwrap();
    assert_eq!(
        restored
            .get_coauthor_check_notes(&f.scope, f.page.check.id, &f.key, 0)
            .unwrap()
            .noted_chars,
        4
    );
    let final_page = restored
        .assess_coauthor_check_source(
            &f.scope,
            run.id,
            CoauthorCheckAssessment {
                check_id: f.page.check.id,
                key: f.key.clone(),
                revision: f.page.entries[0].revision.clone(),
                assessment: "UNCERTAIN".into(),
                reason: "原文已读完，但叙事时间尚待作者确认。".into(),
                quote: "甲😀".into(),
            },
        )
        .unwrap();
    assert!(!final_page.check.complete);
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
    f.cleanup();
}

#[test]
fn migration_failure_rolls_back_and_retry_keeps_author_text() {
    let f = Fixture::new("作者唯一原文");
    let db = &f.manager.current.as_ref().unwrap().database;
    db.connection
        .execute_batch(
            "DROP TABLE coauthor_decision_fts; DROP TABLE coauthor_decision_mentions; DROP TABLE coauthor_decision_evidence; DROP TABLE coauthor_decision_aliases;
             DROP TABLE coauthor_check_notes; DELETE FROM schema_migrations WHERE version>=56;
         CREATE TRIGGER fail56 BEFORE INSERT ON schema_migrations WHEN NEW.version=56
         BEGIN SELECT RAISE(ABORT,'migration failure'); END;",
        )
        .unwrap();
    assert!(db.migrate_coauthor_check_notes().is_err());
    assert!(db.connection.is_autocommit());
    assert_eq!(db.health().unwrap().schema_version, 55);
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='coauthor_check_notes'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db.connection.execute_batch("DROP TRIGGER fail56").unwrap();
    db.migrate_coauthor_check_notes().unwrap();
    db.migrate_coauthor_decision_memory().unwrap();
    db.migrate_coauthor_knowledge().unwrap();
    db.migrate_coauthor_semantic().unwrap();
    db.drop_coauthor_knowledge_checks_fixture();
    db.migrate_coauthor_knowledge_checks().unwrap();
    db.migrate_coauthor_knowledge_anchor_pages().unwrap();
    db.migrate_coauthor_evidence_progress().unwrap();
    db.migrate_coauthor_branch_merges().unwrap();
    assert_eq!(db.health().unwrap().schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(
        db.coauthor_source(&f.key).unwrap().unwrap().content,
        "作者唯一原文"
    );
    f.cleanup();
}

#[test]
fn note_save_failure_is_atomic_and_retry_does_not_advance_reading_or_assessment() {
    let mut f = Fixture::new("甲乙");
    f.read(0, 2, true);
    f.manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_note BEFORE INSERT ON coauthor_check_notes
         BEGIN SELECT RAISE(ABORT,'note failure'); END;",
        )
        .unwrap();
    assert!(f.save(f.note(0, 2, "甲")).is_err());
    assert_eq!(f.notes(0).total_notes, 0);
    f.manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TRIGGER fail_note")
        .unwrap();
    f.save(f.note(0, 2, "甲")).unwrap();
    let progress = f
        .manager
        .get_coauthor_source_check(&f.scope, f.page.check.id, 0)
        .unwrap();
    assert_eq!(progress.check.sent, 1);
    assert_eq!(progress.check.reviewed, 0);
    assert!(!progress.check.complete);
    f.cleanup();
}

#[test]
fn note_validation_bounds_and_explicit_empty_source_are_enforced() {
    let mut f = Fixture::new("");
    assert!(f.save(f.note(0, 0, "")).is_err());
    f.read(0, 1, true);
    let saved = f.save(f.note(0, 0, "")).unwrap();
    assert_eq!(saved.end, 0);
    for field in ["analysis", "questions", "quote", "range", "version"] {
        let mut note = f.note(0, 0, "");
        note.expected_version = 1;
        match field {
            "analysis" => note.analysis = "甲".repeat(1001),
            "questions" => note.questions = "甲".repeat(601),
            "quote" => note.quote = "甲".repeat(501),
            "range" => note.end = usize::MAX,
            _ => note.expected_version = -1,
        }
        assert!(f.save(note).is_err(), "{field}");
    }
    assert_eq!(f.notes(0).total_notes, 1);
    assert_eq!(f.notes(0).noted_chars, 0);
    f.cleanup();
}
