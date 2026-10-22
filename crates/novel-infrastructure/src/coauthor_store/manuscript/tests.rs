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
        after_runs: vec![],
    }
}

fn cross_edit() -> CoauthorManuscriptEdit {
    CoauthorManuscriptEdit {
        start: 4,
        end: 10,
        before: "寿元，仍记得".into(),
        after: "记忆，却忘了".into(),
        after_runs: vec![
            CoauthorReplacementRun { text: "记忆".into(), marks_from: 4 },
            CoauthorReplacementRun { text: "，却忘了".into(), marks_from: 6 },
        ],
        ..edit()
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
                manuscript_edits: vec![edit()], outline_edits: vec![],
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
            manuscript_edits: vec![], outline_edits: vec![],
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

#[test]
fn cross_format_replacement_retains_unicode_prefix_suffix_original_marks_and_structure() {
    let original: Value = serde_json::from_str(&rich_document()).unwrap();
    let actual: Value = serde_json::from_str(&apply_edits(&rich_document(), &[cross_edit()]).unwrap()).unwrap();
    let mut expected = original.clone();
    expected["content"][1]["content"][0]["content"] = json!([
        {"type":"text","text":"甲😀失去","marks":[{"type":"bold"}]},
        {"type":"text","text":"记忆","marks":[{"type":"bold"}]},
        {"type":"text","text":"，却忘了","marks":[{"type":"italic"}]},
        {"type":"text","text":"声音。","marks":[{"type":"italic"}]},
        {"type":"hardBreak"},{"type":"text","text":"不动这一行"}
    ]);
    assert_eq!(actual, expected);
    let mut swapped = cross_edit();
    swapped.after_runs[0].marks_from = 8;
    swapped.after_runs[1].marks_from = 5;
    let actual: Value = serde_json::from_str(&apply_edits(&rich_document(), &[swapped]).unwrap()).unwrap();
    assert_eq!(actual["content"][1]["content"][0]["content"][1]["marks"], json!([{"type":"italic"}]));
    assert_eq!(actual["content"][1]["content"][0]["content"][2]["marks"], json!([{"type":"bold"}]));
}

#[test]
fn cross_format_range_pairs_never_modify_unselected_text_or_infer_replacement_marks() {
    let original = rich_document();
    let doc: Value = serde_json::from_str(&original).unwrap();
    let body = &doc["content"][1]["content"][0];
    let original_text = block_text(body);
    for start in 0..6 {
        for end in 7..=13 {
            let replacement = CoauthorManuscriptEdit {
                start, end,
                before: original_text.chars().skip(start).take(end-start).collect(),
                after: "新😀文".into(),
                after_runs: vec![
                    CoauthorReplacementRun { text: "新😀".into(), marks_from: start },
                    CoauthorReplacementRun { text: "文".into(), marks_from: end-1 },
                ],
                ..edit()
            };
            let actual: Value = serde_json::from_str(&apply_edits(&original, &[replacement]).unwrap()).unwrap();
            let changed = &actual["content"][1]["content"][0];
            assert_eq!(block_text(changed), format!("{}新😀文{}",
                original_text.chars().take(start).collect::<String>(),
                original_text.chars().skip(end).collect::<String>()));
            let pieces = runs(changed).unwrap();
            assert_eq!(pieces.iter().find(|run| run.text == "新😀").unwrap().marks, vec![json!({"type":"bold"})]);
            assert_eq!(pieces.iter().find(|run| run.text == "文").unwrap().marks, vec![json!({"type":"italic"})]);
            assert_eq!(actual["content"][0], doc["content"][0]);
            assert_eq!(actual["content"][2], doc["content"][2]);
            assert_eq!(actual["content"][3], doc["content"][3]);
            assert_eq!(changed["attrs"], body["attrs"]);
            assert_eq!(changed["content"].as_array().unwrap().last(), body["content"].as_array().unwrap().last());
        }
    }
}

#[test]
fn cross_format_deletion_does_not_remove_breaks_blocks_or_surviving_run_marks() {
    let deletion = CoauthorManuscriptEdit { after: String::new(), after_runs: vec![], ..cross_edit() };
    let actual: Value = serde_json::from_str(&apply_edits(&rich_document(), &[deletion]).unwrap()).unwrap();
    assert_eq!(actual["content"][1]["content"][0]["content"], json!([
        {"type":"text","text":"甲😀失去","marks":[{"type":"bold"}]},
        {"type":"text","text":"声音。","marks":[{"type":"italic"}]},
        {"type":"hardBreak"},{"type":"text","text":"不动这一行"}
    ]));
    let deletion = CoauthorManuscriptEdit {
        start: 0, end: 13, before: "甲😀失去寿元，仍记得声音。".into(),
        after: String::new(), after_runs: vec![], ..edit()
    };
    let actual: Value = serde_json::from_str(&apply_edits(&rich_document(), &[deletion]).unwrap()).unwrap();
    assert_eq!(actual["content"][1]["content"][0]["content"], json!([
        {"type":"hardBreak"},{"type":"text","text":"不动这一行"}
    ]));
}

#[test]
fn three_format_replacement_copies_all_original_mark_attributes_and_can_inherit_plain_text() {
    let original = json!({"type":"doc","content":[{"type":"heading","attrs":{"blockId":"p","level":2},"content":[
        {"type":"text","text":"甲😀","marks":[{"type":"bold"}]},
        {"type":"text","text":"寿"},
        {"type":"text","text":"元声","marks":[{"type":"italic"},{"type":"textStyle","attrs":{"color":"#194232"}}]}
    ]}]}).to_string();
    let replacement = CoauthorManuscriptEdit {
        start: 1, end: 4, before: "😀寿元".into(), after: "新素彩".into(),
        after_runs: vec![
            CoauthorReplacementRun { text: "新".into(), marks_from: 1 },
            CoauthorReplacementRun { text: "素".into(), marks_from: 2 },
            CoauthorReplacementRun { text: "彩".into(), marks_from: 3 },
        ], ..edit()
    };
    let actual: Value = serde_json::from_str(&apply_edits(&original, &[replacement]).unwrap()).unwrap();
    assert_eq!(actual["content"][0]["attrs"], json!({"blockId":"p","level":2}));
    let content = &actual["content"][0]["content"];
    assert_eq!(content[1]["marks"], json!([{"type":"bold"}]));
    assert!(content[2].get("marks").is_none());
    assert_eq!(content[3]["marks"], json!([{"type":"italic"},{"type":"textStyle","attrs":{"color":"#194232"}}]));
    assert_eq!(content[4]["text"], "声");
    assert_eq!(content[4]["marks"], content[3]["marks"]);
}

#[test]
fn cross_format_mapping_rejects_unknown_or_unselected_styles_wrong_text_and_size_limits() {
    let mut bad = Vec::new();
    let mut missing = cross_edit();
    missing.after_runs.clear();
    bad.push(missing);
    for marks_from in [0, 3, 10, 13, usize::MAX] {
        let mut outside = cross_edit();
        outside.after_runs[0].marks_from = marks_from;
        bad.push(outside);
    }
    let mut mismatched = cross_edit();
    mismatched.after_runs[0].text = "错误替换".into();
    bad.push(mismatched);
    let mut empty = cross_edit();
    empty.after_runs[0].text.clear();
    bad.push(empty);
    let mut too_many = cross_edit();
    too_many.after = "甲".repeat(65);
    too_many.after_runs = (0..65).map(|_| CoauthorReplacementRun { text: "甲".into(), marks_from: 4 }).collect();
    bad.push(too_many);
    let mut too_long = cross_edit();
    too_long.after = "甲".repeat(12_001);
    too_long.after_runs = vec![CoauthorReplacementRun { text: too_long.after.clone(), marks_from: 4 }];
    bad.push(too_long);
    let mut deletion_with_format = cross_edit();
    deletion_with_format.after.clear();
    bad.push(deletion_with_format);
    for item in bad {
        assert!(apply_edits(&rich_document(), &[item]).is_err());
    }
    assert!(serde_json::from_value::<CoauthorReplacementRun>(json!({
        "text":"替换","marksFrom":4,"marks":[{"type":"bold"}]
    })).is_err());
}

#[test]
fn cross_format_edits_still_reject_hard_breaks_newlines_unknown_inline_nodes_and_cross_blocks() {
    let crossing_break = CoauthorManuscriptEdit {
        start: 12, end: 15, before: "。\n不".into(), after: "换".into(),
        after_runs: vec![CoauthorReplacementRun { text: "换".into(), marks_from: 12 }],
        ..edit()
    };
    assert!(apply_edits(&rich_document(), &[crossing_break]).is_err());
    for newline in ["\n", "\r", "\r\n"] {
        let mut replacement = cross_edit();
        replacement.after.push_str(newline);
        replacement.after_runs[1].text.push_str(newline);
        assert!(apply_edits(&rich_document(), &[replacement]).is_err());
    }
    let mut unknown: Value = serde_json::from_str(&rich_document()).unwrap();
    unknown["content"][1]["content"][0]["content"].as_array_mut().unwrap()
        .insert(1, json!({"type":"mention","attrs":{"id":"secret"}}));
    assert!(apply_edits(&unknown.to_string(), &[cross_edit()]).is_err());
    let crossing_block = CoauthorManuscriptEdit { end: 100, ..cross_edit() };
    assert!(apply_edits(&rich_document(), &[crossing_block]).is_err());
}

#[test]
fn cross_format_and_adjacent_edits_share_original_offsets_and_are_order_independent() {
    let earlier = CoauthorManuscriptEdit { start: 1, end: 2, before: "😀".into(), after: "他".into(), ..edit() };
    let later = CoauthorManuscriptEdit { start: 10, end: 11, before: "声".into(), after: "嗓".into(), ..edit() };
    let one = apply_edits(&rich_document(), &[cross_edit(), earlier.clone(), later.clone()]).unwrap();
    let two = apply_edits(&rich_document(), &[later, earlier, cross_edit()]).unwrap();
    assert_eq!(one, two);
    let actual: Value = serde_json::from_str(&one).unwrap();
    assert_eq!(block_text(&actual["content"][1]["content"][0]), "甲他失去记忆，却忘了嗓音。\n不动这一行");
    assert!(apply_edits(&rich_document(), &[cross_edit(), edit()]).is_err());
}

#[test]
fn cross_format_adoption_is_versioned_idempotent_searchable_and_does_not_publish_working_draft() {
    let mut f = Fixture::new();
    let draft = f.manager.coauthor_state(&f.scope).unwrap().document;
    let mut input = f.input();
    input.items[0].manuscript_edits = vec![cross_edit()];
    let changes = f.manager.prepare_coauthor_changeset(&f.scope, input, None).unwrap();
    assert!(changes.published.is_empty());
    let adopted = f.commit(&changes).unwrap();
    assert_eq!(adopted.published.len(), 1);
    assert_eq!(f.commit(&changes).unwrap().published[0].revision, adopted.published[0].revision);
    let current = f.manager.current_manuscript(f.revision.chapter_id).unwrap().unwrap();
    assert_eq!(current.parent_revision_id, Some(f.revision.id));
    assert_eq!(Some(&current.document_json), changes.items[0].manuscript_after_json.as_ref());
    assert_eq!(f.manager.coauthor_state(&f.scope).unwrap().document, draft);
    assert_eq!(f.manager.list_manuscript_revisions(f.revision.chapter_id).unwrap().len(), 2);
    let found = f.manager.search_coauthor_sources(&f.scope, "记忆", false, 0).unwrap();
    assert!(found.hits.iter().any(|hit| hit.key == f.source.key && hit.content.contains("记忆，却忘了声音")));
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    let reopened = f.manager.coauthor_changeset(&f.scope, changes.id).unwrap();
    assert_eq!(reopened.items[0].manuscript_edits[0].after_runs[1].marks_from, 6);
}

#[test]
fn cross_format_late_failure_rolls_back_the_group_and_same_text_new_revision_rejects_retry() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.items[0].manuscript_edits = vec![cross_edit()];
    input.items.insert(0, CoauthorChangeItemInput {
        id: "setting".into(), kind: CoauthorDocumentKind::Setting, title: "代价".into(),
        content: "突破失去记忆".into(), target_key: None, target_revision: None,
        depends_on: vec![], manuscript_edits: vec![], outline_edits: vec![],
    });
    input.items[1].depends_on.push("setting".into());
    let changes = f.manager.prepare_coauthor_changeset(&f.scope, input, None).unwrap();
    f.manager.current.as_ref().unwrap().database.connection.execute_batch(
        "CREATE TRIGGER fail_cross_format_receipt BEFORE UPDATE ON coauthor_changesets
         WHEN NEW.status='COMMITTED' BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope, changes.id, 1, vec!["setting".into(), "patch".into()]).is_err());
    assert!(f.manager.list_entities(false).unwrap().is_empty());
    assert_eq!(f.manager.current_manuscript(f.revision.chapter_id).unwrap().unwrap().id, f.revision.id);
    assert_eq!(f.manager.coauthor_changeset(&f.scope, changes.id).unwrap().status, "PENDING");
    f.manager.current.as_ref().unwrap().database.connection.execute_batch("DROP TRIGGER fail_cross_format_receipt").unwrap();
    f.manager.save_manuscript(f.revision.chapter_id, rich_document(), "AUTHOR".into()).unwrap();
    assert!(f.manager.commit_coauthor_changeset(&f.scope, changes.id, 1, vec!["setting".into(), "patch".into()]).is_err());
    assert!(f.manager.list_entities(false).unwrap().is_empty());
}

#[test]
fn actual_backup_restores_cross_format_mapping_snapshots_and_reversal_keeps_exact_original_json() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.items[0].manuscript_edits = vec![cross_edit()];
    let changes = f.manager.prepare_coauthor_changeset(&f.scope, input, None).unwrap();
    let adopted = f.commit(&changes).unwrap();
    f.manager.enqueue_job(JobType::Backup, "{}".into()).unwrap();
    let job = f.manager.run_next_job().unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error_summary);
    let target = f.root.with_file_name(format!("cross-format-restored-{}", Uuid::new_v4()));
    f.manager.restore_backup_to_new_project(f.root.join("snapshots").join(job.id.to_string()), &target).unwrap();
    let mut restored = ProjectManager::new();
    restored.open(&target).unwrap();
    let saved = restored.coauthor_changeset(&f.scope, adopted.id).unwrap();
    assert_eq!(saved.items[0].manuscript_edits[0].after_runs[0].text, "记忆");
    assert_eq!(saved.items[0].manuscript_before_json.as_ref(), Some(&f.revision.document_json));
    let preview = restored.prepare_coauthor_reversal(&f.scope, adopted.id, adopted.version, 0).unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    restored.commit_coauthor_reversal(&f.scope, adopted.id, preview.version).unwrap();
    let current = restored.current_manuscript(f.revision.chapter_id).unwrap().unwrap();
    assert_eq!(current.document_json, f.revision.document_json);
    assert_ne!(current.id, f.revision.id);
    assert_eq!(restored.list_manuscript_revisions(f.revision.chapter_id).unwrap().len(), 3);
    drop(restored);
    let _ = std::fs::remove_dir_all(target);
}
