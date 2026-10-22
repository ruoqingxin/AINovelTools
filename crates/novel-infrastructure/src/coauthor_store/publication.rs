use super::*;
use serde_json::json;

impl ProjectManager {
    /// Publishes exactly one reviewed document. Composite changes remain outside
    /// this endpoint so a text proposal can never silently rewrite other objects.
    pub fn publish_coauthor_document(
        &mut self,
        scope: &CoauthorScope,
        expected_version: i64,
    ) -> Result<String, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let document = db.coauthor_document(scope.session_id)?;
        let already:Option<String>=db.connection.query_row(
            "SELECT source_key FROM coauthor_publications WHERE session_id=?1 AND document_version=?2",
            rusqlite::params![scope.session_id.to_string(),expected_version],|row|row.get(0),
        ).optional()?;
        if let Some(key) = already {
            return Ok(key);
        }
        if document.version != expected_version {
            return Err(CoauthorError::Conflict);
        }
        if document.content.trim().is_empty() {
            return Err(CoauthorError::Invalid("工作稿为空。".into()));
        }
        let source = match &document.target_key {
            Some(key) => {
                let source = db.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
                if Some(&source.revision) != document.target_revision.as_ref() {
                    return Err(CoauthorError::Conflict);
                }
                Some(source)
            }
            None => None,
        };
        let tx = db.connection.unchecked_transaction()?;
        let source_version = format!("coauthor:{}:v{}", scope.session_id, document.version);
        let key = match document.kind {
            CoauthorDocumentKind::Setting => {
                if source.as_ref().is_some_and(|s| s.kind != "ENTITY") {
                    return Err(CoauthorError::Invalid("设定稿只能关联概念资料。".into()));
                }
                let target = source.as_ref().and_then(|s| s.key.strip_prefix("ENTITY:"));
                let old: Option<(String, i64, String, String, String)> =
                    if let Some(id) = target {
                        tx.query_row(
                        "SELECT e.current_revision_id,r.revision,r.aliases_json,r.tags_json,r.name
                         FROM entities e JOIN entity_revisions r ON r.id=e.current_revision_id
                         WHERE e.id=?1 AND e.entity_type='CONCEPT' AND e.lifecycle_status='ACTIVE'",
                        [id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
                    ).optional()?
                    } else {
                        None
                    };
                if target.is_some() && old.is_none() {
                    return Err(CoauthorError::NotFound);
                }
                let entity_id = target.map_or_else(|| Uuid::new_v4().to_string(), str::to_owned);
                let revision_id = Uuid::new_v4().to_string();
                let (base, revision, mut aliases, tags, old_name) = old.map_or(
                    (None, 1, "[]".into(), "[]".into(), String::new()),
                    |(base, v, aliases, tags, name)| (Some(base), v + 1, aliases, tags, name),
                );
                if !old_name.is_empty() && old_name != document.title {
                    let mut values: Vec<String> = decode(aliases)?;
                    if !values.contains(&old_name) {
                        values.push(old_name);
                    }
                    aliases = encode(&values)?;
                }
                if base.is_none() {
                    tx.execute(
                        "INSERT INTO entities(id,project_id,entity_type,current_revision_id)
                        VALUES (?1,?2,'CONCEPT',?3)",
                        rusqlite::params![entity_id, scope.project_id.to_string(), revision_id],
                    )?;
                }
                tx.execute(
                    "INSERT INTO entity_revisions(id,entity_id,revision,name,aliases_json,description,
                        fixed_attributes_json,tags_json,base_revision_id,source_version)
                     VALUES (?1,?2,?3,?4,?5,?6,'{\"settingScope\":\"PROJECT\"}',?7,?8,?9)",
                    rusqlite::params![revision_id,entity_id,revision,document.title,aliases,document.content,tags,base,source_version],
                )?;
                if base.is_some() {
                    tx.execute(
                        "UPDATE entities SET current_revision_id=?2,version=version+1,
                        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                        rusqlite::params![entity_id, revision_id],
                    )?;
                }
                format!("ENTITY:{entity_id}")
            }
            CoauthorDocumentKind::Outline | CoauthorDocumentKind::Manuscript => {
                if source.is_some() {
                    return Err(CoauthorError::Invalid(
                        "此版本仅支持将正文或大纲发布为新条目；已有条目不会被纯文本工作稿覆盖。"
                            .into(),
                    ));
                }
                let id = Uuid::new_v4().to_string();
                let kind = if document.kind == CoauthorDocumentKind::Outline {
                    "OUTLINE"
                } else {
                    "CHAPTER"
                };
                tx.execute("INSERT INTO plan_nodes(id,kind,title,sort_order)
                    VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM plan_nodes WHERE parent_id IS NULL))",
                    rusqlite::params![id,kind,document.title])?;
                for table in ["plan_node_revisions", "plan_revisions"] {
                    tx.execute(&format!("INSERT INTO {table}(id,node_id,revision,title,archived) VALUES (?1,?2,1,?3,0)"),
                        rusqlite::params![Uuid::new_v4().to_string(),id,document.title])?;
                }
                if document.kind == CoauthorDocumentKind::Outline {
                    let section = format!("plan-node:{id}");
                    tx.execute(
                        "INSERT INTO planning_sections(id,content,story_state,references_json)
                        VALUES (?1,?2,'CONFIRMED',?3)",
                        rusqlite::params![
                            section,
                            document.content,
                            encode(&vec![source_version])?
                        ],
                    )?;
                    format!("PLAN:{section}")
                } else {
                    tx.execute(
                        "INSERT INTO chapters(id,plan_node_id,title) VALUES (?1,?1,?2)",
                        rusqlite::params![id, document.title],
                    )?;
                    let json = encode(
                        &json!({"type":"doc","content":document.content.split('\n').map(|line|{
                        if line.is_empty(){json!({"type":"paragraph","attrs":{"blockId":Uuid::new_v4().to_string()}})}
                        else{json!({"type":"paragraph","attrs":{"blockId":Uuid::new_v4().to_string()},
                            "content":[{"type":"text","text":line}]})}
                    }).collect::<Vec<_>>()}),
                    )?;
                    tx.execute("INSERT INTO manuscript_revisions(id,chapter_id,document_json,content_hash,creation_reason)
                        VALUES (?1,?2,?3,?4,?5)",
                        rusqlite::params![Uuid::new_v4().to_string(),id,json,format!("{:x}",Sha256::digest(json.as_bytes())),source_version])?;
                    format!("MANUSCRIPT:{id}")
                }
            }
        };
        match document.kind {
            CoauthorDocumentKind::Setting => {
                let id = key.strip_prefix("ENTITY:").ok_or(CoauthorError::NotFound)?;
                tx.execute(
                    "DELETE FROM search_index WHERE object_type='ENTITY' AND object_id=?1",
                    [id],
                )?;
                tx.execute(
                    "INSERT INTO search_index SELECT 'ENTITY',e.id,e.project_id,r.source_version,
                    r.name || char(10) || r.description || char(10) || r.tags_json FROM entities e
                    JOIN entity_revisions r ON r.id=e.current_revision_id WHERE e.id=?1",
                    [id],
                )?;
            }
            CoauthorDocumentKind::Outline => {
                let id = key
                    .strip_prefix("PLAN:plan-node:")
                    .ok_or(CoauthorError::NotFound)?;
                tx.execute(
                    "INSERT INTO search_index SELECT 'PLAN',id,?2,CAST(revision AS TEXT),title
                    FROM plan_nodes WHERE id=?1",
                    rusqlite::params![id, scope.project_id.to_string()],
                )?;
            }
            CoauthorDocumentKind::Manuscript => {
                let id = key
                    .strip_prefix("MANUSCRIPT:")
                    .ok_or(CoauthorError::NotFound)?;
                tx.execute(
                    "INSERT INTO search_index SELECT 'PLAN',id,?2,CAST(revision AS TEXT),title
                    FROM plan_nodes WHERE id=?1",
                    rusqlite::params![id, scope.project_id.to_string()],
                )?;
                tx.execute("INSERT INTO search_index SELECT 'MANUSCRIPT',id,?2,'manuscript:' || id,document_json
                    FROM manuscript_revisions WHERE chapter_id=?1",rusqlite::params![id,scope.project_id.to_string()])?;
            }
        }
        tx.execute(
            "INSERT INTO coauthor_publications VALUES (?1,?2,?3)",
            rusqlite::params![scope.session_id.to_string(), expected_version, key],
        )?;
        let source = db.coauthor_source(&key)?.ok_or(CoauthorError::NotFound)?;
        let linked = CoauthorDocument {
            version: document.version + 1,
            target_key: Some(key.clone()),
            target_revision: Some(source.revision),
            ..document
        };
        let payload = encode(&linked)?;
        tx.execute(
            "UPDATE coauthor_documents SET version=?2,payload=?3 WHERE session_id=?1",
            rusqlite::params![scope.session_id.to_string(), linked.version, payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_document_revisions VALUES (?1,?2,?3)",
            rusqlite::params![scope.session_id.to_string(), linked.version, payload],
        )?;
        tx.execute(
            "INSERT INTO coauthor_publications VALUES (?1,?2,?3)",
            rusqlite::params![scope.session_id.to_string(), linked.version, key],
        )?;
        tx.commit()?;
        Ok(key)
    }
}
