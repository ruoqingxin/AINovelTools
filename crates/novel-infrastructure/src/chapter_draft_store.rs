use super::*;

fn ensure_chapter(connection: &Connection, chapter_id: Uuid) -> Result<(), ManuscriptError> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chapters WHERE id=?1)",
            [chapter_id.to_string()],
            |row| row.get(0),
        )
        .map_err(DatabaseError::from)?;
    if !exists {
        return Err(ManuscriptError::MissingChapter(chapter_id));
    }
    Ok(())
}

fn read_draft(
    connection: &Connection,
    chapter_id: Uuid,
) -> Result<ManuscriptDraft, ManuscriptError> {
    let row: Option<(Option<String>, Option<String>, i64, String)> = connection.query_row(
        "SELECT document_json, base_revision_id, version, updated_at FROM manuscript_drafts WHERE chapter_id=?1",
        [chapter_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(DatabaseError::from)?;
    let (document_json, base, version, updated_at) = row.unwrap_or((None, None, 0, String::new()));
    let base_revision_id = base
        .map(|id| Uuid::parse_str(&id))
        .transpose()
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))?;
    let base_document_json = if let Some(base) = base_revision_id {
        connection
            .query_row(
                "SELECT document_json FROM manuscript_revisions WHERE id=?1 AND chapter_id=?2",
                rusqlite::params![base.to_string(), chapter_id.to_string()],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?
    } else {
        String::new()
    };
    Ok(ManuscriptDraft {
        chapter_id,
        document_json,
        base_revision_id,
        base_document_json,
        version,
        updated_at,
    })
}

pub(super) fn insert_revision(
    connection: &Connection,
    chapter_id: Uuid,
    base_revision_id: Option<Uuid>,
    document_json: &str,
    creation_reason: String,
) -> Result<ManuscriptRevision, ManuscriptError> {
    ensure_chapter(connection, chapter_id)?;
    let current: Option<String> = connection.query_row(
        "SELECT id FROM manuscript_revisions WHERE chapter_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [chapter_id.to_string()], |row| row.get(0),
    ).optional().map_err(DatabaseError::from)?;
    let current = current
        .map(|id| Uuid::parse_str(&id))
        .transpose()
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))?;
    if current != base_revision_id {
        return Err(ManuscriptError::Conflict {
            expected: base_revision_id,
            actual: current,
        });
    }
    let document_json = normalize_document(document_json)?;
    let mut revision = ManuscriptRevision {
        id: Uuid::new_v4(),
        chapter_id,
        parent_revision_id: current,
        base_revision_id: current,
        content_hash: format!("{:x}", Sha256::digest(document_json.as_bytes())),
        document_json,
        creation_reason,
        document_schema_version: 1,
        created_at: String::new(),
    };
    connection.execute(
        "INSERT INTO manuscript_revisions (id, chapter_id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![revision.id.to_string(), chapter_id.to_string(), current.map(|id| id.to_string()),
            revision.document_json, revision.content_hash, revision.creation_reason, revision.document_schema_version],
    ).map_err(DatabaseError::from)?;
    revision.created_at = connection
        .query_row(
            "SELECT created_at FROM manuscript_revisions WHERE id=?1",
            [revision.id.to_string()],
            |row| row.get(0),
        )
        .map_err(DatabaseError::from)?;
    Ok(revision)
}

impl Database {
    pub(super) fn current_manuscript_draft(
        &self,
        chapter_id: Uuid,
    ) -> Result<ManuscriptDraft, ManuscriptError> {
        ensure_chapter(&self.connection, chapter_id)?;
        read_draft(&self.connection, chapter_id)
    }

    pub(super) fn save_manuscript_draft(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        document_json: String,
        expected_version: i64,
    ) -> Result<ManuscriptDraft, ManuscriptError> {
        validate_document(&document_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(DatabaseError::from)?;
        ensure_chapter(&transaction, chapter_id)?;
        let current = read_draft(&transaction, chapter_id)?;
        if current.version != expected_version {
            return Err(ManuscriptError::DraftConflict {
                expected: expected_version,
                actual: current.version,
            });
        }
        if let Some(base) = base_revision_id {
            let belongs: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM manuscript_revisions WHERE id=?1 AND chapter_id=?2)",
                rusqlite::params![base.to_string(), chapter_id.to_string()], |row| row.get(0),
            ).map_err(DatabaseError::from)?;
            if !belongs {
                return Err(ManuscriptError::InvalidDocument(
                    "draft baseline belongs to another chapter".into(),
                ));
            }
        }
        transaction
            .execute(
                "INSERT INTO manuscript_drafts (chapter_id,document_json,base_revision_id,version)
             VALUES (?1,?2,?3,1) ON CONFLICT(chapter_id) DO UPDATE SET
             document_json=excluded.document_json,base_revision_id=excluded.base_revision_id,
             version=manuscript_drafts.version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                rusqlite::params![
                    chapter_id.to_string(),
                    document_json,
                    base_revision_id.map(|id| id.to_string())
                ],
            )
            .map_err(DatabaseError::from)?;
        let saved = read_draft(&transaction, chapter_id)?;
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(saved)
    }

    pub(super) fn discard_manuscript_draft(
        &mut self,
        chapter_id: Uuid,
        expected_version: i64,
    ) -> Result<ManuscriptDraft, ManuscriptError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(DatabaseError::from)?;
        ensure_chapter(&transaction, chapter_id)?;
        let current = read_draft(&transaction, chapter_id)?;
        if current.version != expected_version {
            return Err(ManuscriptError::DraftConflict {
                expected: expected_version,
                actual: current.version,
            });
        }
        clear_draft(&transaction, chapter_id)?;
        let cleared = read_draft(&transaction, chapter_id)?;
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(cleared)
    }

    pub(super) fn commit_manuscript_draft(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        document_json: String,
        expected_version: i64,
        project_id: Uuid,
    ) -> Result<ManuscriptDraftCommit, ManuscriptError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(DatabaseError::from)?;
        ensure_chapter(&transaction, chapter_id)?;
        let current = read_draft(&transaction, chapter_id)?;
        if current.version != expected_version {
            return Err(ManuscriptError::DraftConflict {
                expected: expected_version,
                actual: current.version,
            });
        }
        if current.document_json.as_deref() != Some(&document_json)
            || current.base_revision_id != base_revision_id
        {
            return Err(ManuscriptError::InvalidDocument(
                "save the current draft before committing it".into(),
            ));
        }
        let revision = insert_revision(
            &transaction,
            chapter_id,
            base_revision_id,
            &document_json,
            "MANUAL_SAVE".into(),
        )?;
        clear_draft(&transaction, chapter_id)?;
        transaction
            .execute(
                "DELETE FROM recovery_logs WHERE chapter_id=?1",
                [chapter_id.to_string()],
            )
            .map_err(DatabaseError::from)?;
        Self::rebuild_search_index_in_tx(&transaction, project_id)?;
        let draft = read_draft(&transaction, chapter_id)?;
        transaction.commit().map_err(DatabaseError::from)?;
        Ok(ManuscriptDraftCommit { revision, draft })
    }
}

fn clear_draft(connection: &Connection, chapter_id: Uuid) -> Result<(), ManuscriptError> {
    // Keep the version after clearing so stale windows cannot recreate an old draft.
    connection.execute(
        "INSERT INTO manuscript_drafts (chapter_id,document_json,base_revision_id,version) VALUES (?1,NULL,NULL,1)
         ON CONFLICT(chapter_id) DO UPDATE SET document_json=NULL,base_revision_id=NULL,
         version=manuscript_drafts.version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [chapter_id.to_string()],
    ).map_err(DatabaseError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(text: &str) -> String {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}).to_string()
    }

    fn setup() -> (Database, Uuid) {
        let mut db = Database::in_memory().unwrap();
        let chapter = db
            .create_plan_node(None, PlanNodeKind::Chapter, "chapter".into())
            .unwrap();
        (db, chapter.id)
    }

    #[test]
    fn autosave_is_separate_from_revisions_and_recovery_and_retains_original_baseline() {
        let (mut db, chapter) = setup();
        let first = db
            .save_manuscript_checked(chapter, None, document("first"), "test".into())
            .unwrap();
        let saved = db
            .save_manuscript_draft(chapter, Some(first.id), document("draft"), 0)
            .unwrap();
        let second = db
            .save_manuscript_checked(chapter, Some(first.id), document("external"), "test".into())
            .unwrap();
        let draft = db.current_manuscript_draft(chapter).unwrap();
        assert_eq!(draft, saved);
        assert_eq!(draft.base_document_json, first.document_json);
        assert_eq!(db.list_manuscript_revisions(chapter).unwrap().len(), 2);
        assert!(db.list_recovery_logs(chapter).unwrap().is_empty());
        assert!(matches!(
            db.commit_manuscript_draft(chapter, Some(first.id), document("draft"), draft.version, Uuid::nil()),
            Err(ManuscriptError::Conflict { actual: Some(id), .. }) if id == second.id
        ));
        assert_eq!(db.current_manuscript_draft(chapter).unwrap(), draft);
    }

    #[test]
    fn stale_save_discard_and_commit_leave_all_data_unchanged() {
        let (mut db, chapter) = setup();
        let draft = db
            .save_manuscript_draft(chapter, None, document("draft"), 0)
            .unwrap();
        db.save_recovery_log(chapter, document("recovery")).unwrap();
        assert!(matches!(
            db.save_manuscript_draft(chapter, None, document("stale"), 0),
            Err(ManuscriptError::DraftConflict { .. })
        ));
        assert!(matches!(
            db.discard_manuscript_draft(chapter, 0),
            Err(ManuscriptError::DraftConflict { .. })
        ));
        assert!(matches!(
            db.commit_manuscript_draft(chapter, None, document("draft"), 0, Uuid::nil()),
            Err(ManuscriptError::DraftConflict { .. })
        ));
        assert_eq!(db.current_manuscript_draft(chapter).unwrap(), draft);
        assert!(db.list_manuscript_revisions(chapter).unwrap().is_empty());
        assert_eq!(db.list_recovery_logs(chapter).unwrap().len(), 1);
        let cleared = db.discard_manuscript_draft(chapter, draft.version).unwrap();
        assert_eq!(cleared.version, 2);
        assert!(cleared.document_json.is_none());
        assert!(matches!(
            db.save_manuscript_draft(chapter, None, document("old window"), 1),
            Err(ManuscriptError::DraftConflict { actual: 2, .. })
        ));
        assert_eq!(db.list_recovery_logs(chapter).unwrap().len(), 1);
    }

    #[test]
    fn commit_appends_revision_and_clears_draft_and_recovery_atomically() {
        let (mut db, chapter) = setup();
        let draft = db
            .save_manuscript_draft(chapter, None, document("draft"), 0)
            .unwrap();
        db.save_recovery_log(chapter, document("recovery")).unwrap();
        db.connection.execute_batch("CREATE TRIGGER fail_draft_clear BEFORE UPDATE ON manuscript_drafts WHEN NEW.document_json IS NULL BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(
            db.commit_manuscript_draft(
                chapter,
                None,
                document("draft"),
                draft.version,
                Uuid::nil()
            )
            .is_err()
        );
        assert!(db.list_manuscript_revisions(chapter).unwrap().is_empty());
        assert_eq!(db.current_manuscript_draft(chapter).unwrap(), draft);
        assert_eq!(db.list_recovery_logs(chapter).unwrap().len(), 1);
        db.connection
            .execute_batch("DROP TRIGGER fail_draft_clear")
            .unwrap();
        let committed = db
            .commit_manuscript_draft(chapter, None, document("draft"), draft.version, Uuid::nil())
            .unwrap();
        assert_eq!(db.list_manuscript_revisions(chapter).unwrap().len(), 1);
        assert_eq!(committed.draft.version, 2);
        assert!(committed.draft.document_json.is_none());
        assert!(db.list_recovery_logs(chapter).unwrap().is_empty());
        let indexed: i64 = db
            .connection
            .query_row(
                "SELECT count(*) FROM search_index WHERE object_type='MANUSCRIPT' AND object_id=?1",
                [committed.revision.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);
    }

    #[test]
    fn search_refresh_failure_does_not_leave_an_unacknowledged_formal_commit() {
        let (mut db, chapter) = setup();
        let draft = db
            .save_manuscript_draft(chapter, None, document("draft"), 0)
            .unwrap();
        db.save_recovery_log(chapter, document("recovery")).unwrap();
        db.connection
            .execute_batch("DROP TABLE search_index")
            .unwrap();
        assert!(
            db.commit_manuscript_draft(
                chapter,
                None,
                document("draft"),
                draft.version,
                Uuid::nil()
            )
            .is_err()
        );
        assert!(db.list_manuscript_revisions(chapter).unwrap().is_empty());
        assert_eq!(db.current_manuscript_draft(chapter).unwrap(), draft);
        assert_eq!(db.list_recovery_logs(chapter).unwrap().len(), 1);
    }

    #[test]
    fn missing_formal_baseline_and_mismatched_snapshot_cannot_overwrite() {
        let (mut db, chapter) = setup();
        let first = db
            .save_manuscript_checked(chapter, None, document("first"), "test".into())
            .unwrap();
        assert!(matches!(
            db.save_manuscript_checked(chapter, None, document("overwrite"), "test".into()),
            Err(ManuscriptError::Conflict { expected: None, .. })
        ));
        let draft = db
            .save_manuscript_draft(chapter, Some(first.id), document("draft"), 0)
            .unwrap();
        assert!(
            db.commit_manuscript_draft(
                chapter,
                Some(first.id),
                document("not saved"),
                draft.version,
                Uuid::nil()
            )
            .is_err()
        );
        let other = db
            .create_plan_node(None, PlanNodeKind::Chapter, "other".into())
            .unwrap();
        assert!(
            db.save_manuscript_draft(other.id, Some(first.id), document("wrong baseline"), 0)
                .is_err()
        );
        assert_eq!(db.list_manuscript_revisions(chapter).unwrap().len(), 1);
    }

    #[test]
    fn project_reopen_restores_draft_and_baseline_without_creating_history() {
        let root = PathBuf::from("target").join(format!("draft-reopen-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "draft test").unwrap();
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "chapter".into())
            .unwrap();
        let revision = manager
            .save_manuscript(chapter.id, document("formal"), "test".into())
            .unwrap();
        let draft = manager
            .save_manuscript_draft(chapter.id, Some(revision.id), document("draft"), 0)
            .unwrap();
        manager.close();
        manager.open(&root).unwrap();
        assert_eq!(manager.current_manuscript_draft(chapter.id).unwrap(), draft);
        assert_eq!(
            manager.list_manuscript_revisions(chapter.id).unwrap().len(),
            1
        );
        assert!(manager.list_recovery_logs(chapter.id).unwrap().is_empty());
        manager.close();
        std::fs::remove_dir_all(root).unwrap();
    }
}
