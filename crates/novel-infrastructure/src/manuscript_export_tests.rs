use super::*;
use serde_json::json;

struct Fixture {
    manager: ProjectManager,
    root: PathBuf,
    project_id: Uuid,
    volume: PlanNode,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("manuscript-export-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        let project_id = manager.create(&root, "Book # [title]").unwrap().project_id;
        let parent = manager
            .create_plan_node(None, PlanNodeKind::VolumeManager, "Volumes".into())
            .unwrap();
        let volume = manager
            .create_plan_node(Some(parent.id), PlanNodeKind::Volume, "Volume A".into())
            .unwrap();
        Self {
            manager,
            root,
            project_id,
            volume,
        }
    }

    fn chapter(&mut self, title: &str) -> PlanNode {
        self.manager
            .create_plan_node(Some(self.volume.id), PlanNodeKind::Chapter, title.into())
            .unwrap()
    }

    fn save(&mut self, chapter: Uuid, text: &str) -> ManuscriptRevision {
        self.manager
            .save_manuscript(chapter, doc(text), "MANUAL_SAVE".into())
            .unwrap()
    }

    fn input(
        &self,
        scope: ManuscriptExportScope,
        format: ManuscriptExportFormat,
    ) -> ManuscriptExportInput {
        ManuscriptExportInput {
            expected_project_id: self.project_id,
            scope,
            format,
        }
    }

    fn export(
        &self,
        scope: ManuscriptExportScope,
        format: ManuscriptExportFormat,
    ) -> ManuscriptExportReceipt {
        self.manager
            .export_manuscript(self.input(scope, format))
            .unwrap()
    }

    fn sql(&self, sql: &str) {
        self.manager
            .current
            .as_ref()
            .unwrap()
            .database
            .connection
            .execute_batch(sql)
            .unwrap();
    }

    fn exports(&self) -> usize {
        std::fs::read_dir(self.root.join("exports"))
            .unwrap()
            .count()
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
fn request_requires_project_format_and_an_explicit_valid_scope() {
    let value = json!({"expectedProjectId": Uuid::new_v4(), "format":"TXT",
        "scope":{"kind":"CHAPTER", "chapterId":Uuid::new_v4()}});
    for field in ["expectedProjectId", "format", "scope"] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ManuscriptExportInput>(missing).is_err());
    }
    for scope in [
        json!({"kind":"CHAPTER"}),
        json!({"kind":"CHAPTER","chapterId":"invalid"}),
        json!({"kind":"BOOK","chapterId":Uuid::new_v4()}),
        json!({"kind":"UNKNOWN"}),
    ] {
        let mut invalid = value.clone();
        invalid["scope"] = scope;
        assert!(serde_json::from_value::<ManuscriptExportInput>(invalid).is_err());
    }
}

#[test]
fn no_project_and_foreign_project_never_publish_files() {
    let mut f = Fixture::new();
    let chapter = f.chapter("A");
    f.save(chapter.id, "saved");
    let mut input = f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    input.expected_project_id = Uuid::new_v4();
    assert!(matches!(
        f.manager.export_manuscript(input.clone()),
        Err(ManuscriptExportError::WrongProject)
    ));
    assert_eq!(f.exports(), 0);
    f.manager.close();
    assert!(matches!(
        f.manager.export_manuscript(input),
        Err(ManuscriptExportError::NoProject)
    ));
}

#[test]
fn book_export_uses_hierarchical_order_latest_revisions_and_read_only_snapshot() {
    let mut f = Fixture::new();
    let late_volume = f
        .manager
        .create_plan_node(
            Some(f.volume.parent_id.unwrap()),
            PlanNodeKind::Volume,
            "Volume B".into(),
        )
        .unwrap();
    let late = f
        .manager
        .create_plan_node(Some(late_volume.id), PlanNodeKind::Chapter, "C".into())
        .unwrap();
    let first = f.chapter("A");
    let second = f.chapter("B");
    f.save(first.id, "old");
    let latest = f.save(first.id, "new saved");
    f.save(second.id, "second");
    f.save(late.id, "last");
    let connection = &f.manager.current.as_ref().unwrap().database.connection;
    let changes = connection.total_changes();
    let receipt = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    assert_eq!(connection.total_changes(), changes);
    assert_eq!(
        receipt
            .chapters
            .iter()
            .map(|c| c.chapter_id)
            .collect::<Vec<_>>(),
        [first.id, second.id, late.id]
    );
    assert_eq!(receipt.chapters[0].revision_id, latest.id);
    assert_eq!(
        std::fs::read_to_string(&receipt.path).unwrap(),
        "Book # [title]\n\nVolume A\n\nA\n\nnew saved\n\nB\n\nsecond\n\nVolume B\n\nC\n\nlast\n"
    );
    assert_eq!(
        f.manager.list_manuscript_revisions(first.id).unwrap().len(),
        2
    );
    assert_eq!(f.manager.health().unwrap().schema_version, 51);
}

#[test]
fn chapter_export_omits_drafts_recovery_plans_and_other_chapters_after_reopen() {
    let mut f = Fixture::new();
    let first = f.chapter("A");
    let second = f.chapter("B");
    let revision = f.save(first.id, "saved prose");
    f.save(second.id, "other chapter");
    f.manager
        .save_manuscript_draft(first.id, Some(revision.id), doc("draft only"), 0)
        .unwrap();
    f.manager
        .save_recovery_log(first.id, doc("recovery only"))
        .unwrap();
    f.manager
        .save_planning_section(PlanningSection {
            id: format!("plan-node:{}", first.id),
            content: "plan only".into(),
            pending_content: "candidate only".into(),
            story_state: PlanningStoryState::Confirmed,
            rationale: String::new(),
            consequence: String::new(),
            references: vec![],
            updated_at: String::new(),
        })
        .unwrap();
    f.manager.close();
    f.manager.open(&f.root).unwrap();
    let receipt = f.export(
        ManuscriptExportScope::Chapter {
            chapter_id: first.id,
        },
        ManuscriptExportFormat::Txt,
    );
    assert_eq!(receipt.chapters.len(), 1);
    assert_eq!(receipt.draft_chapter_count, 1);
    let text = std::fs::read_to_string(&receipt.path).unwrap();
    assert!(text.contains("saved prose"));
    for private in [
        "draft only",
        "recovery only",
        "plan only",
        "candidate only",
        "other chapter",
    ] {
        assert!(!text.contains(private));
    }
    assert!(
        f.manager
            .current_manuscript_draft(first.id)
            .unwrap()
            .document_json
            .unwrap()
            .contains("draft only")
    );
    assert_eq!(f.manager.list_recovery_logs(first.id).unwrap().len(), 1);
}

#[test]
fn missing_saved_chapters_are_reported_and_all_empty_scope_is_rejected() {
    let mut f = Fixture::new();
    let saved = f.chapter("Saved");
    let missing = f.chapter("No revision");
    assert!(matches!(
        f.manager.export_manuscript(
            f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt)
        ),
        Err(ManuscriptExportError::NoSavedManuscript)
    ));
    assert_eq!(f.exports(), 0);
    f.save(saved.id, "prose");
    let receipt = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    assert_eq!(receipt.skipped_chapters.len(), 1);
    assert_eq!(receipt.skipped_chapters[0].chapter_id, missing.id);
    assert!(
        !std::fs::read_to_string(receipt.path)
            .unwrap()
            .contains("No revision")
    );
    assert!(matches!(
        f.manager.export_manuscript(f.input(
            ManuscriptExportScope::Chapter {
                chapter_id: missing.id
            },
            ManuscriptExportFormat::Txt
        )),
        Err(ManuscriptExportError::NoSavedManuscript)
    ));
}

#[test]
fn archived_chapters_and_archived_ancestors_are_not_exported() {
    let mut f = Fixture::new();
    let first = f.chapter("Archived chapter");
    let second = f.chapter("Archived volume child");
    f.save(first.id, "one");
    f.save(second.id, "two");
    f.sql(&format!(
        "UPDATE plan_nodes SET archived=1 WHERE id='{}'",
        first.id
    ));
    let receipt = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    assert_eq!(receipt.chapters.len(), 1);
    for target in [first.id, f.volume.id, Uuid::new_v4()] {
        assert!(matches!(
            f.manager.export_manuscript(f.input(
                ManuscriptExportScope::Chapter { chapter_id: target },
                ManuscriptExportFormat::Txt
            )),
            Err(ManuscriptExportError::InvalidTarget)
        ));
    }
    f.sql(&format!(
        "UPDATE plan_nodes SET archived=1 WHERE id='{}'",
        f.volume.id
    ));
    assert!(matches!(
        f.manager.export_manuscript(
            f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt)
        ),
        Err(ManuscriptExportError::NoSavedManuscript)
    ));
    assert!(matches!(
        f.manager.export_manuscript(f.input(
            ManuscriptExportScope::Chapter {
                chapter_id: second.id
            },
            ManuscriptExportFormat::Txt
        )),
        Err(ManuscriptExportError::InvalidTarget)
    ));
}

#[test]
fn inline_text_unicode_hard_breaks_and_nested_blocks_keep_content_without_metadata() {
    let mut f = Fixture::new();
    let chapter = f.chapter("Chapter");
    let document = json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"沈"},{"type":"text","text":"砚","marks":[{"type":"bold"}]},
            {"type":"hardBreak"},{"type":"text","text":"城门🙂"}]},
        {"type":"paragraph"},
        {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"引文"}]}]},
        {"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"列表"}]}]}]}
    ]});
    f.manager
        .save_manuscript(chapter.id, document.to_string(), "MANUAL_SAVE".into())
        .unwrap();
    let receipt = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    let text = std::fs::read_to_string(receipt.path).unwrap();
    assert!(text.contains("沈砚\n城门🙂\n\n\n\n引文\n\n列表"));
    assert!(!text.contains("blockId"));
    assert!(!text.contains("bold"));
}

#[test]
fn markdown_has_literal_prose_and_titles_not_accidental_links_html_or_headings() {
    let mut f = Fixture::new();
    let chapter = f.chapter("A # [chapter]");
    f.save(
        chapter.id,
        "# not a heading\n<script> &amp; [link](https://invalid) *literal*",
    );
    let receipt = f.export(
        ManuscriptExportScope::Book {},
        ManuscriptExportFormat::Markdown,
    );
    assert_eq!(receipt.path.extension().unwrap(), "md");
    let text = std::fs::read_to_string(receipt.path).unwrap();
    assert!(text.starts_with("# Book \\# \\[title\\]\n\n## Volume A\n\n### A \\# \\[chapter\\]"));
    assert!(text.contains(
        "\\# not a heading  \n\\<script\\> \\&amp; \\[link\\]\\(https://invalid\\) \\*literal\\*"
    ));
}

#[test]
fn unsupported_nodes_hashes_versions_and_bad_structure_fail_without_partial_success() {
    let mut f = Fixture::new();
    let chapter = f.chapter("Unsupported");
    let revision = f
        .manager
        .save_manuscript(
            chapter.id,
            json!({"type":"doc","content":[{"type":"image","attrs":{"src":"secret"}}]}).to_string(),
            "MANUAL_SAVE".into(),
        )
        .unwrap();
    assert!(matches!(
        f.manager.export_manuscript(
            f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt)
        ),
        Err(ManuscriptExportError::InvalidDocument(_))
    ));
    assert_eq!(f.exports(), 0);
    let mut good = f.save(chapter.id, "good");
    good.document_schema_version = 2;
    assert!(prose(&good).is_err());
    good.document_schema_version = 1;
    for document in [
        json!({"type":"doc","text":"must not vanish"}),
        json!({"type":"doc","content":[{"type":"hardBreak","text":"must not vanish"}]}),
        json!({"type":"doc","content":[{"type":"horizontalRule","text":"must not vanish"}]}),
        json!({"type":"doc","content":[{"type":"doc","content":[]}]}),
    ] {
        let mut malformed = good.clone();
        malformed.document_json = document.to_string();
        malformed.content_hash =
            format!("{:x}", Sha256::digest(malformed.document_json.as_bytes()));
        assert!(prose(&malformed).is_err());
    }
    good.content_hash = revision.content_hash;
    assert!(prose(&good).is_err());
    f.sql(&format!(
        "UPDATE plan_nodes SET parent_id='{}' WHERE id='{}'",
        chapter.id, chapter.id
    ));
    assert!(matches!(
        f.manager.export_manuscript(
            f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt)
        ),
        Err(ManuscriptExportError::InvalidStructure)
    ));
    assert_eq!(f.exports(), 0);
}

#[test]
fn publication_is_unique_utf8_and_write_failure_can_be_retried_without_database_changes() {
    let mut f = Fixture::new();
    let chapter = f.chapter("../reserved");
    f.save(chapter.id, "完整正文🙂");
    std::fs::remove_dir(f.root.join("exports")).unwrap();
    std::fs::write(f.root.join("exports"), "blocked").unwrap();
    let changes = f
        .manager
        .current
        .as_ref()
        .unwrap()
        .database
        .connection
        .total_changes();
    assert!(matches!(
        f.manager.export_manuscript(
            f.input(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt)
        ),
        Err(ManuscriptExportError::Io(_))
    ));
    assert_eq!(
        std::fs::read_to_string(f.root.join("exports")).unwrap(),
        "blocked"
    );
    std::fs::remove_file(f.root.join("exports")).unwrap();
    let first = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    let second = f.export(ManuscriptExportScope::Book {}, ManuscriptExportFormat::Txt);
    assert_ne!(first.path, second.path);
    assert!(
        first
            .path
            .starts_with(f.root.join("exports").canonicalize().unwrap())
    );
    let bytes = std::fs::read(first.path).unwrap();
    assert_eq!(bytes, std::fs::read(second.path).unwrap());
    assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
    assert_eq!(f.exports(), 2);
    assert_eq!(
        f.manager
            .current
            .as_ref()
            .unwrap()
            .database
            .connection
            .total_changes(),
        changes
    );
}
