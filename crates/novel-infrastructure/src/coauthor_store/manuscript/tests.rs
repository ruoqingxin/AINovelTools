use super::*;
use crate::coauthor_store::tests::project;
use serde_json::json;

fn rich_document() -> String {
    json!({"type":"doc","content":[
        {"type":"heading","attrs":{"blockId":"title","level":2},"content":[{"type":"text","text":"旧章标题"}]},
        {"type":"blockquote","attrs":{"blockId":"quote"},"content":[
            {"type":"paragraph","attrs":{"blockId":"p","textAlign":"center"},"content":[
                {"type":"text","text":"甲😀失去寿元","marks":[{"type":"bold"}]},
                {"type":"text","text":"，仍记得声音。","marks":[{"type":"italic"}]},
                {"type":"hardBreak"},{"type":"text","text":"不动这一行"}
            ]}
        ]},
        {"type":"horizontalRule","attrs":{"blockId":"rule"}},
        {"type":"paragraph","attrs":{"blockId":"last"},"content":[{"type":"text","text":"不动结尾"}]}
    ]}).to_string()
}

fn edit() -> CoauthorManuscriptEdit {
    CoauthorManuscriptEdit {
        block_id: "p".into(),
        start: 4,
        end: 6,
        before: "寿元".into(),
        after: "记忆".into(),
    }
}

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    scope: CoauthorScope,
    revision: ManuscriptRevision,
    source: CoauthorSource,
}
impl Fixture {
    fn new() -> Self {
        let (mut manager, root, scope) = project();
        let chapter = manager
            .create_plan_node(None, PlanNodeKind::Chapter, "旧章".into())
            .unwrap();
        let revision = manager
            .save_manuscript(chapter.id, rich_document(), "TEST".into())
            .unwrap();
        let source = manager
            .current
            .as_ref()
            .unwrap()
            .database
            .coauthor_source(&format!("MANUSCRIPT:{}", chapter.id))
            .unwrap()
            .unwrap();
        Self {
            manager,
            root,
            scope,
            revision,
            source,
        }
    }
    fn input(&self) -> CoauthorChangeRequest {
        CoauthorChangeRequest {
            expected_document_version: 0,
            include_draft: false,
            title: "旧章局部改稿".into(),
            draft_depends_on: vec![],
            items: vec![CoauthorChangeItemInput {
                id: "patch".into(),
                kind: CoauthorDocumentKind::Manuscript,
                title: "旧章".into(),
                content: String::new(),
                target_key: Some(self.source.key.clone()),
                target_revision: Some(self.source.revision.clone()),
                depends_on: vec![],
                manuscript_edits: vec![edit()],
            }],
            impacts: vec![],
            coverage: "只修改旧章寿元一词；未检查全书。".into(),
        }
    }
    fn prepare(&mut self) -> CoauthorChangeSet {
        let input = self.input();
        self.manager
            .prepare_coauthor_changeset(&self.scope, input, None)
            .unwrap()
    }
    fn commit(&mut self, changes: &CoauthorChangeSet) -> Result<CoauthorChangeSet, CoauthorError> {
        self.manager
            .commit_coauthor_changeset(&self.scope, changes.id, 1, vec!["patch".into()])
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn unicode_local_edits_keep_marks_attributes_nested_structure_and_untouched_nodes() {
    let before = rich_document();
    let mut expected: Value = serde_json::from_str(&before).unwrap();
    expected["content"][1]["content"][0]["content"][0]["text"] = json!("甲😀失去记忆");
    assert_eq!(
        serde_json::from_str::<Value>(&apply_edits(&before, &[edit()]).unwrap()).unwrap(),
        expected
    );
    let mut second = edit();
    second.start = 0;
    second.end = 1;
    second.before = "甲".into();
    second.after = "他".into();
    let applied = apply_edits(&before, &[second.clone(), edit()]).unwrap();
    assert_eq!(applied, apply_edits(&before, &[edit(), second]).unwrap());
    assert!(applied.contains("他😀失去记忆"));
}

#[test]
fn ambiguous_missing_overlapping_stale_cross_format_and_newline_edits_are_rejected() {
    let before = rich_document();
    for changed in [
        CoauthorManuscriptEdit {
            block_id: "missing".into(),
            ..edit()
        },
        CoauthorManuscriptEdit { end: 100, ..edit() },
        CoauthorManuscriptEdit {
            start: 6,
            end: 4,
            ..edit()
        },
        CoauthorManuscriptEdit {
            before: "记忆".into(),
            ..edit()
        },
        CoauthorManuscriptEdit {
            start: 4,
            end: 7,
            before: "寿元，".into(),
            ..edit()
        },
        CoauthorManuscriptEdit {
            after: "换\n段".into(),
            ..edit()
        },
    ] {
        assert!(apply_edits(&before, &[changed]).is_err());
    }
    assert!(apply_edits(&before, &[edit(), edit()]).is_err());
    let mut duplicate: Value = serde_json::from_str(&before).unwrap();
    let block = duplicate["content"][1]["content"][0].clone();
    duplicate["content"].as_array_mut().unwrap().push(block);
    assert!(apply_edits(&duplicate.to_string(), &[edit()]).is_err());
    assert!(apply_edits(&before, &[]).is_err());
}

#[test]
fn deleting_a_whole_text_run_keeps_other_marks_and_nodes() {
    let mut deletion = edit();
    deletion.start = 0;
    deletion.before = "甲😀失去寿元".into();
    deletion.after.clear();
    let result: Value =
        serde_json::from_str(&apply_edits(&rich_document(), &[deletion]).unwrap()).unwrap();
    assert_eq!(
        result["content"][1]["content"][0]["content"][0]["marks"],
        json!([{"type":"italic"}])
    );
    assert_eq!(
        result["content"][1]["content"][0]["content"][1]["type"],
        "hardBreak"
    );
}

#[test]
fn paged_block_reads_retain_absolute_unicode_ranges_and_revision_guard() {
    let f = Fixture::new();
    // Heading has 4 scalars and one separator; paragraph begins at global offset 5.
    let page = f
        .manager
        .read_coauthor_manuscript(&f.scope, &f.source.key, &f.source.revision, 6, 5)
        .unwrap();
    assert_eq!(page.blocks.len(), 1);
    let block = &page.blocks[0];
    assert_eq!(block.block_id, "p");
    assert_eq!(block.text, "😀失去寿元");
    assert_eq!(block.offset, 1);
    assert_eq!(block.runs[0].start, 1);
    assert_eq!(block.runs[0].end, 6);
    assert_eq!(block.runs[0].marks, vec![json!({"type":"bold"})]);
    assert_eq!(page.next_offset, Some(11));
    assert!(
        f.manager
            .read_coauthor_manuscript(&f.scope, &f.source.key, "stale", 0, 100)
            .is_err()
    );
    let foreign = CoauthorScope {
        project_id: Uuid::new_v4(),
        ..f.scope.clone()
    };
    assert!(
        f.manager
            .read_coauthor_manuscript(&foreign, &f.source.key, &f.source.revision, 0, 100)
            .is_err()
    );
}

#[test]
fn formal_local_adoption_keeps_history_and_receipt_without_adopting_empty_working_draft() {
    let mut f = Fixture::new();
    let base = f.manager.coauthor_state(&f.scope).unwrap().document;
    let changes = f.prepare();
    assert_eq!(changes.items.len(), 1);
    let item = &changes.items[0];
    assert_eq!(
        item.manuscript_before_json.as_ref(),
        Some(&f.revision.document_json)
    );
    assert!(
        item.manuscript_after_json
            .as_ref()
            .unwrap()
            .contains("甲😀失去记忆")
    );
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        1
    );
    let adopted = f.commit(&changes).unwrap();
    assert_eq!(adopted.published[0].source_key, f.source.key);
    let current = f
        .manager
        .current_manuscript(f.revision.chapter_id)
        .unwrap()
        .unwrap();
    assert_eq!(current.parent_revision_id, Some(f.revision.id));
    assert_eq!(
        current.document_json,
        *item.manuscript_after_json.as_ref().unwrap()
    );
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, base);
    assert_eq!(
        f.commit(&changes).unwrap().published[0].revision,
        adopted.published[0].revision
    );
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        2
    );
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    assert_eq!(
        f.manager
            .coauthor_changeset(&f.scope, changes.id)
            .unwrap()
            .items[0]
            .manuscript_edits[0]
            .before,
        "寿元"
    );
}

#[test]
fn author_editor_draft_blocks_preparation_and_any_intervening_draft_version_blocks_commit() {
    let mut f = Fixture::new();
    let changes = f.prepare();
    let draft = f
        .manager
        .save_manuscript_draft(
            f.revision.chapter_id,
            Some(f.revision.id),
            rich_document(),
            0,
        )
        .unwrap();
    assert!(f.commit(&changes).is_err());
    let input = f.input();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    f.manager
        .discard_manuscript_draft(f.revision.chapter_id, draft.version)
        .unwrap();
    assert!(matches!(f.commit(&changes), Err(CoauthorError::Conflict)));
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn new_native_revision_with_identical_text_invalidates_old_changeset_and_plain_overwrite_stays_blocked()
 {
    let mut f = Fixture::new();
    let changes = f.prepare();
    f.manager
        .save_manuscript(
            f.revision.chapter_id,
            f.revision.document_json.clone(),
            "MANUAL".into(),
        )
        .unwrap();
    assert!(f.commit(&changes).is_err());
    let mut input = f.input();
    input.items[0].manuscript_edits.clear();
    input.items[0].content = "纯文本覆盖".into();
    assert!(
        f.manager
            .prepare_coauthor_changeset(&f.scope, input, None)
            .is_err()
    );
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn late_manuscript_failure_rolls_back_earlier_objects_and_leaves_proposal_pending() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.items.insert(
        0,
        CoauthorChangeItemInput {
            id: "setting".into(),
            kind: CoauthorDocumentKind::Setting,
            title: "新规则".into(),
            content: "突破失去记忆".into(),
            target_key: None,
            target_revision: None,
            depends_on: vec![],
            manuscript_edits: vec![],
        },
    );
    input.items[1].depends_on.push("setting".into());
    let changes = f
        .manager
        .prepare_coauthor_changeset(&f.scope, input, None)
        .unwrap();
    let db = &f.manager.current.as_ref().unwrap().database;
    db.connection.execute_batch("CREATE TRIGGER fail_local_revision BEFORE INSERT ON manuscript_revisions BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(
        f.manager
            .commit_coauthor_changeset(
                &f.scope,
                changes.id,
                1,
                vec!["patch".into(), "setting".into()]
            )
            .is_err()
    );
    assert!(f.manager.list_entities(false).unwrap().is_empty());
    assert_eq!(
        f.manager
            .coauthor_changeset(&f.scope, changes.id)
            .unwrap()
            .status,
        "PENDING"
    );
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn summary_failure_rolls_back_revision_and_search_then_retry_invalidates_only_derived_scope() {
    let mut f = Fixture::new();
    let db = &f.manager.current.as_ref().unwrap().database;
    for (id, source, mode) in [
        (
            "chapter",
            Some(f.revision.chapter_id.to_string()),
            "EXTRACTIVE_AUTO",
        ),
        ("project", None, "EXTRACTIVE_AUTO_PROJECT"),
        ("other", Some(Uuid::new_v4().to_string()), "MANUAL"),
    ] {
        db.connection.execute("INSERT INTO summary_materials(id,project_id,kind,precision,source_id,content,generation_mode)
            VALUES (?1,?2,'CHAPTER','L1',?3,'原摘要',?4)",
            rusqlite::params![id, f.scope.project_id.to_string(), source, mode]).unwrap();
    }
    let changes = f.prepare();
    f.manager.current.as_ref().unwrap().database.connection.execute_batch(
        "CREATE TRIGGER fail_summary_invalidation BEFORE UPDATE ON summary_materials BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(f.commit(&changes).is_err());
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        1
    );
    let db = &f.manager.current.as_ref().unwrap().database;
    let search_count: i64 = db
        .connection
        .query_row(
            "SELECT COUNT(*) FROM search_index WHERE object_type='MANUSCRIPT'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(search_count, 1);
    db.connection
        .execute_batch("DROP TRIGGER fail_summary_invalidation")
        .unwrap();
    f.commit(&changes).unwrap();
    let db = &f.manager.current.as_ref().unwrap().database;
    for (id, status) in [
        ("chapter", "STALE"),
        ("project", "STALE"),
        ("other", "ACTIVE"),
    ] {
        assert_eq!(
            db.connection
                .query_row(
                    "SELECT lifecycle_status FROM summary_materials WHERE id=?1",
                    [id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            status
        );
    }
    let found = f
        .manager
        .search_coauthor_sources(&f.scope, "记忆", false, 0)
        .unwrap();
    assert!(
        found
            .hits
            .iter()
            .any(|hit| hit.key == f.source.key && hit.content.contains("记忆"))
    );
}

#[test]
fn missing_search_storage_rolls_back_new_revision_and_does_not_acknowledge_adoption() {
    let mut f = Fixture::new();
    let changes = f.prepare();
    f.manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .execute_batch("DROP TABLE search_index")
        .unwrap();
    assert!(f.commit(&changes).is_err());
    assert_eq!(
        f.manager
            .list_manuscript_revisions(f.revision.chapter_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.manager
            .coauthor_changeset(&f.scope, changes.id)
            .unwrap()
            .status,
        "PENDING"
    );
}

#[test]
fn block_pages_bound_metadata_and_continue_inside_many_short_formatted_runs() {
    let mut f = Fixture::new();
    let content = (0..40)
        .map(|index| {
            json!({
                "type":"paragraph", "attrs":{"blockId":format!("p{index}")},
                "content": (0..80).map(|_| json!({"type":"text","text":"甲"})).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    f.manager
        .save_manuscript(
            f.revision.chapter_id,
            json!({"type":"doc","content":content}).to_string(),
            "TEST".into(),
        )
        .unwrap();
    let source = f
        .manager
        .current
        .as_ref()
        .unwrap()
        .database
        .coauthor_source(&f.source.key)
        .unwrap()
        .unwrap();
    let first = f
        .manager
        .read_coauthor_manuscript(&f.scope, &source.key, &source.revision, 0, 12_000)
        .unwrap();
    assert_eq!(first.blocks.len(), 1);
    assert_eq!(first.blocks[0].runs.len(), 64);
    assert_eq!(first.next_offset, Some(64));
    let second = f
        .manager
        .read_coauthor_manuscript(
            &f.scope,
            &source.key,
            &source.revision,
            first.next_offset.unwrap(),
            12_000,
        )
        .unwrap();
    assert_eq!(second.blocks[0].offset, 64);
    assert_eq!(second.blocks[0].runs[0].start, 64);
    assert!(second.next_offset.unwrap() > 64);

    let content = (0..40)
        .map(|index| {
            json!({
                "type":"paragraph","attrs":{"blockId":format!("b{index}")},
                "content":[{"type":"text","text":"甲"}],
            })
        })
        .collect::<Vec<_>>();
    f.manager
        .save_manuscript(
            f.revision.chapter_id,
            json!({"type":"doc","content":content}).to_string(),
            "TEST".into(),
        )
        .unwrap();
    let source = f
        .manager
        .current
        .as_ref()
        .unwrap()
        .database
        .coauthor_source(&f.source.key)
        .unwrap()
        .unwrap();
    let page = f
        .manager
        .read_coauthor_manuscript(&f.scope, &source.key, &source.revision, 0, 12_000)
        .unwrap();
    assert_eq!(page.blocks.len(), 24);
    assert_eq!(page.next_offset, Some(48));
    let tail = f
        .manager
        .read_coauthor_manuscript(&f.scope, &source.key, &source.revision, 48, 12_000)
        .unwrap();
    assert_eq!(tail.blocks[0].block_id, "b24");
    assert!(tail.next_offset.is_none());
}
