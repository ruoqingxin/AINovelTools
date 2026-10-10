use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManuscriptSourceRequest {
    pub project_id: Option<Uuid>,
    pub revision_id: Option<Uuid>,
    pub evidence_anchor_id: Option<Uuid>,
    pub chapter_id: Option<Uuid>,
    pub block_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptSource {
    pub revision: ManuscriptRevision,
    pub chapter_title: String,
    pub chapter_archived: bool,
    pub is_current_revision: bool,
    pub block_id: Option<String>,
    pub block_text: Option<String>,
    pub quote: Option<String>,
    pub evidence_anchor_id: Option<Uuid>,
}

#[derive(Debug, Error)]
pub enum ManuscriptSourceError {
    #[error("no project is open")]
    NoProject,
    #[error("a manuscript revision or evidence anchor is required")]
    InvalidRequest,
    #[error("the source does not exist in the current project")]
    NotFound,
    #[error("the source chapter, revision, block, hash or range does not match")]
    Mismatch,
    #[error("the manuscript source document is invalid")]
    InvalidDocument,
    #[error("source lookup failed: {0}")]
    Database(#[from] DatabaseError),
}

impl From<rusqlite::Error> for ManuscriptSourceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(DatabaseError::from(error))
    }
}

struct SourceAnchor {
    chapter_id: Uuid,
    revision_id: Uuid,
    block_id: String,
    start: u32,
    end: u32,
    version: String,
    hash: String,
    active: bool,
}

fn row_uuid(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&row.get::<_, String>(index)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub(super) fn node_text(node: &serde_json::Value) -> String {
    let mut text = node
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Some(children) = node.get("content").and_then(serde_json::Value::as_array) {
        for child in children {
            text.push_str(&node_text(child));
        }
    }
    text
}

pub(super) fn manuscript_blocks(document: &serde_json::Value) -> Vec<(String, String)> {
    fn visit(node: &serde_json::Value, blocks: &mut Vec<(String, String)>) {
        if let Some(children) = node.get("content").and_then(serde_json::Value::as_array) {
            for child in children {
                visit(child, blocks);
            }
        }
        if !matches!(
            node.get("type").and_then(serde_json::Value::as_str),
            Some("text" | "doc")
        ) {
            if let Some(id) = node
                .get("attrs")
                .and_then(|attrs| attrs.get("blockId"))
                .and_then(serde_json::Value::as_str)
            {
                blocks.push((id.to_owned(), node_text(node)));
            }
        }
    }
    let mut blocks = Vec::new();
    visit(document, &mut blocks);
    blocks
}

impl ProjectManager {
    pub fn get_manuscript_source(
        &self,
        request: ManuscriptSourceRequest,
    ) -> Result<ManuscriptSource, ManuscriptSourceError> {
        let session = self
            .current
            .as_ref()
            .ok_or(ManuscriptSourceError::NoProject)?;
        if request
            .project_id
            .is_some_and(|id| id != session.manifest.project_id)
        {
            return Err(ManuscriptSourceError::Mismatch);
        }
        session
            .database
            .get_manuscript_source(session.manifest.project_id, request)
    }
}

impl Database {
    fn get_manuscript_source(
        &self,
        project_id: Uuid,
        request: ManuscriptSourceRequest,
    ) -> Result<ManuscriptSource, ManuscriptSourceError> {
        let anchor =
            request
                .evidence_anchor_id
                .map(|id| {
                    self.connection.query_row(
                "SELECT chapter_id, source_revision_id, block_id, start_offset, end_offset,
                        source_version, source_hash, lifecycle_status
                 FROM evidence_anchors WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![id.to_string(), project_id.to_string()],
                |row| Ok(SourceAnchor {
                    chapter_id: row_uuid(row, 0)?, revision_id: row_uuid(row, 1)?,
                    block_id: row.get(2)?, start: row.get(3)?, end: row.get(4)?,
                    version: row.get(5)?, hash: row.get(6)?,
                    active: row.get::<_, String>(7)? == "ACTIVE",
                }),
            ).optional()?.ok_or(ManuscriptSourceError::NotFound)
                })
                .transpose()?;
        let revision_id = request
            .revision_id
            .or(anchor.as_ref().map(|a| a.revision_id))
            .ok_or(ManuscriptSourceError::InvalidRequest)?;
        let (revision, chapter_title, chapter_archived) = self
            .connection
            .query_row(
                "SELECT r.chapter_id, r.parent_revision_id, r.document_json, r.content_hash,
                    r.creation_reason, r.document_schema_version, r.created_at, n.title, n.archived
             FROM manuscript_revisions r JOIN chapters c ON c.id = r.chapter_id
             JOIN plan_nodes n ON n.id = c.plan_node_id
             WHERE r.id = ?1 AND n.kind = 'CHAPTER'",
                [revision_id.to_string()],
                |row| {
                    let parent = row
                        .get::<_, Option<String>>(1)?
                        .map(|id| Uuid::parse_str(&id))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?;
                    Ok((
                        ManuscriptRevision {
                            id: revision_id,
                            chapter_id: row_uuid(row, 0)?,
                            parent_revision_id: parent,
                            base_revision_id: parent,
                            document_json: row.get(2)?,
                            content_hash: row.get(3)?,
                            creation_reason: row.get(4)?,
                            document_schema_version: row.get(5)?,
                            created_at: row.get(6)?,
                        },
                        row.get::<_, String>(7)?,
                        row.get::<_, bool>(8)?,
                    ))
                },
            )
            .optional()?
            .ok_or(ManuscriptSourceError::NotFound)?;
        if request
            .chapter_id
            .is_some_and(|id| id != revision.chapter_id)
            || format!("{:x}", Sha256::digest(revision.document_json.as_bytes()))
                != revision.content_hash
        {
            return Err(ManuscriptSourceError::Mismatch);
        }
        if let Some(anchor) = &anchor {
            if !anchor.active
                || anchor.revision_id != revision_id
                || anchor.chapter_id != revision.chapter_id
                || anchor.hash != revision.content_hash
                || (anchor.version != revision_id.to_string()
                    && anchor.version != format!("manuscript:{revision_id}"))
                || request
                    .block_id
                    .as_ref()
                    .is_some_and(|id| *id != anchor.block_id)
            {
                return Err(ManuscriptSourceError::Mismatch);
            }
        }
        let document: serde_json::Value = serde_json::from_str(&revision.document_json)
            .map_err(|_| ManuscriptSourceError::InvalidDocument)?;
        if document.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
            return Err(ManuscriptSourceError::InvalidDocument);
        }
        let block_id = request
            .block_id
            .or(anchor.as_ref().map(|a| a.block_id.clone()));
        let block_text = block_id
            .as_ref()
            .map(|id| {
                let matches: Vec<_> = manuscript_blocks(&document)
                    .into_iter()
                    .filter(|(block_id, _)| block_id == id)
                    .collect();
                if matches.len() != 1 {
                    return Err(ManuscriptSourceError::Mismatch);
                }
                Ok(matches[0].1.clone())
            })
            .transpose()?;
        let quote = anchor
            .as_ref()
            .map(|anchor| {
                let chars: Vec<_> = block_text.as_deref().unwrap_or_default().chars().collect();
                if anchor.start >= anchor.end || anchor.end as usize > chars.len() {
                    return Err(ManuscriptSourceError::Mismatch);
                }
                Ok(chars[anchor.start as usize..anchor.end as usize]
                    .iter()
                    .collect::<String>())
            })
            .transpose()?;
        let current_id: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM manuscript_revisions WHERE chapter_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [revision.chapter_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(ManuscriptSource {
            is_current_revision: current_id.as_deref() == Some(revision_id.to_string().as_str()),
            revision,
            chapter_title,
            chapter_archived,
            block_id,
            block_text,
            quote,
            evidence_anchor_id: request.evidence_anchor_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        manager: ProjectManager,
        project_id: Uuid,
        chapter_id: Uuid,
        revision: ManuscriptRevision,
        anchor: EvidenceAnchor,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ainovel-source-{}", Uuid::new_v4()));
            let mut manager = ProjectManager::new();
            let project_id = manager.create(&root, "source test").unwrap().project_id;
            let chapter_id = manager
                .create_plan_node(None, PlanNodeKind::Chapter, "原章".into())
                .unwrap()
                .id;
            let revision = manager.save_manuscript(chapter_id, serde_json::json!({
                "type": "doc", "content": [{"type": "blockquote", "attrs": {"blockId": "outer"},
                    "content": [{"type": "paragraph", "attrs": {"blockId": "block:1"},
                        "content": [{"type": "text", "text": "甲😀进入雾城"}]}]}]
            }).to_string(), "TEST".into()).unwrap();
            let anchor = EvidenceAnchor {
                id: Uuid::new_v4(),
                project_id,
                chapter_id,
                source_revision_id: revision.id,
                block_id: "block:1".into(),
                start_offset: 1,
                end_offset: 4,
                source_version: format!("manuscript:{}", revision.id),
                source_hash: revision.content_hash.clone(),
                lifecycle_status: KnowledgeLifecycleStatus::Active,
                created_by: "test".into(),
                created_at: now_timestamp(),
                updated_at: now_timestamp(),
            };
            manager.create_evidence_anchor(anchor.clone()).unwrap();
            Self {
                manager,
                project_id,
                chapter_id,
                revision,
                anchor,
                root,
            }
        }

        fn request(&self) -> ManuscriptSourceRequest {
            ManuscriptSourceRequest {
                project_id: Some(self.project_id),
                evidence_anchor_id: Some(self.anchor.id),
                chapter_id: Some(self.chapter_id),
                revision_id: Some(self.revision.id),
                block_id: Some(self.anchor.block_id.clone()),
            }
        }

        fn database(&self) -> &Database {
            &self.manager.current.as_ref().unwrap().database
        }

        fn copy_anchor_with(&self, column: &str, value: &str) -> Uuid {
            let id = Uuid::new_v4();
            let columns = [
                "project_id",
                "chapter_id",
                "source_revision_id",
                "block_id",
                "start_offset",
                "end_offset",
                "source_version",
                "source_hash",
                "lifecycle_status",
                "created_by",
                "created_at",
                "updated_at",
            ];
            assert!(columns.contains(&column));
            let projection = columns
                .map(|name| if name == column { "?2" } else { name })
                .join(", ");
            self.database().connection.execute(
                &format!("INSERT INTO evidence_anchors (id, {}) SELECT ?1, {projection} FROM evidence_anchors WHERE id = ?3",
                    columns.join(", ")),
                rusqlite::params![id.to_string(), value, self.anchor.id.to_string()]).unwrap();
            id
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.current.take();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn exact_historical_nested_source_uses_unicode_scalar_offsets_and_never_writes() {
        let mut f = Fixture::new();
        f.manager.save_manuscript(f.chapter_id,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"最新内容"}]}]}"#.into(),
            "NEW".into()).unwrap();
        let before = f.database().connection.total_changes();
        let source = f.manager.get_manuscript_source(f.request()).unwrap();
        assert_eq!(source.revision.id, f.revision.id);
        assert_eq!(source.chapter_title, "原章");
        assert_eq!(source.block_text.as_deref(), Some("甲😀进入雾城"));
        assert_eq!(source.quote.as_deref(), Some("😀进入"));
        assert!(!source.is_current_revision);
        assert!(!source.chapter_archived);
        assert_eq!(f.database().connection.total_changes(), before);
        assert_eq!(
            f.manager
                .list_manuscript_revisions(f.chapter_id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn source_requires_open_project_and_revision_or_evidence() {
        assert!(matches!(
            ProjectManager::new().get_manuscript_source(ManuscriptSourceRequest::default()),
            Err(ManuscriptSourceError::NoProject)
        ));
        let f = Fixture::new();
        assert!(matches!(
            f.manager
                .get_manuscript_source(ManuscriptSourceRequest::default()),
            Err(ManuscriptSourceError::InvalidRequest)
        ));
        let current = f
            .manager
            .get_manuscript_source(ManuscriptSourceRequest {
                revision_id: Some(f.revision.id),
                ..Default::default()
            })
            .unwrap();
        assert!(current.is_current_revision);
        assert!(current.block_text.is_none());
    }

    #[test]
    fn rejects_foreign_project_chapter_revision_and_block_without_fallback() {
        let f = Fixture::new();
        let request = f.request();
        for wrong in [
            ManuscriptSourceRequest {
                project_id: Some(Uuid::new_v4()),
                ..request.clone()
            },
            ManuscriptSourceRequest {
                chapter_id: Some(Uuid::new_v4()),
                ..request.clone()
            },
            ManuscriptSourceRequest {
                block_id: Some("wrong".into()),
                ..request.clone()
            },
        ] {
            assert!(matches!(
                f.manager.get_manuscript_source(wrong),
                Err(ManuscriptSourceError::Mismatch)
            ));
        }
        for wrong in [
            ManuscriptSourceRequest {
                revision_id: Some(Uuid::new_v4()),
                ..request.clone()
            },
            ManuscriptSourceRequest {
                evidence_anchor_id: Some(Uuid::new_v4()),
                ..request
            },
        ] {
            assert!(matches!(
                f.manager.get_manuscript_source(wrong),
                Err(ManuscriptSourceError::NotFound)
            ));
        }
    }

    #[test]
    fn rejects_inactive_hash_version_range_and_anchor_project_mismatches() {
        let f = Fixture::new();
        for (column, value) in [
            ("lifecycle_status", "ARCHIVED"),
            ("source_hash", "wrong"),
            ("source_version", "1"),
            ("end_offset", "99"),
            ("project_id", &Uuid::new_v4().to_string()),
        ] {
            let id = f.copy_anchor_with(column, value);
            assert!(
                matches!(
                    f.manager.get_manuscript_source(ManuscriptSourceRequest {
                        evidence_anchor_id: Some(id),
                        ..f.request()
                    }),
                    Err(ManuscriptSourceError::Mismatch | ManuscriptSourceError::NotFound)
                ),
                "{column}"
            );
        }
        let legacy = f.copy_anchor_with("source_version", &f.revision.id.to_string());
        assert!(f
            .manager
            .get_manuscript_source(ManuscriptSourceRequest {
                evidence_anchor_id: Some(legacy),
                ..f.request()
            })
            .is_ok());
    }

    #[test]
    fn rejects_missing_duplicate_blocks_and_corrupted_revision_hash() {
        let mut f = Fixture::new();
        let missing = ManuscriptSourceRequest {
            revision_id: Some(f.revision.id),
            block_id: Some("missing".into()),
            ..Default::default()
        };
        assert!(matches!(
            f.manager.get_manuscript_source(missing),
            Err(ManuscriptSourceError::Mismatch)
        ));
        let duplicate = f.manager.save_manuscript(f.chapter_id, serde_json::json!({
            "type": "doc", "content": [
                {"type":"paragraph","attrs":{"blockId":"same"},"content":[{"type":"text","text":"甲"}]},
                {"type":"paragraph","attrs":{"blockId":"same"},"content":[{"type":"text","text":"乙"}]}
            ]
        }).to_string(), "TEST".into()).unwrap();
        assert!(matches!(
            f.manager.get_manuscript_source(ManuscriptSourceRequest {
                revision_id: Some(duplicate.id),
                block_id: Some("same".into()),
                ..Default::default()
            }),
            Err(ManuscriptSourceError::Mismatch)
        ));
        let corrupted = Uuid::new_v4();
        f.database().connection.execute(
            "INSERT INTO manuscript_revisions (id, chapter_id, parent_revision_id, document_json, content_hash,
                creation_reason, document_schema_version, created_at)
             SELECT ?1, chapter_id, parent_revision_id, document_json, 'wrong', creation_reason,
                document_schema_version, created_at FROM manuscript_revisions WHERE id = ?2",
            rusqlite::params![corrupted.to_string(), f.revision.id.to_string()]).unwrap();
        assert!(matches!(
            f.manager.get_manuscript_source(ManuscriptSourceRequest {
                revision_id: Some(corrupted),
                ..Default::default()
            }),
            Err(ManuscriptSourceError::Mismatch)
        ));
    }

    #[test]
    fn archived_chapters_remain_readable_and_anchor_revision_cannot_be_replaced() {
        let mut f = Fixture::new();
        let newer = f
            .manager
            .save_manuscript(f.chapter_id, f.revision.document_json.clone(), "NEW".into())
            .unwrap();
        assert!(matches!(
            f.manager.get_manuscript_source(ManuscriptSourceRequest {
                revision_id: Some(newer.id),
                ..f.request()
            }),
            Err(ManuscriptSourceError::Mismatch)
        ));
        f.manager
            .update_plan_node(f.chapter_id, "原章".into(), true)
            .unwrap();
        let source = f.manager.get_manuscript_source(f.request()).unwrap();
        assert!(source.chapter_archived);
        assert_eq!(source.revision.id, f.revision.id);
    }
}
