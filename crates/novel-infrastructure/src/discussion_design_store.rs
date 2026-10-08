use super::*;

pub const DISCUSSION_MESSAGE_MAX_CHARS: usize = 20_000;
pub const DISCUSSION_DRAFT_MAX_CHARS: usize = 50_000;
const MAX_PROPOSAL_ENTITIES: usize = 20;
const MAX_PROPOSAL_CHARS: usize = 100_000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscussionTopicKind {
    #[default]
    Free,
    Character,
    Item,
    Location,
    Plot,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (ProjectManager, PathBuf, Uuid) {
        let root = std::env::temp_dir().join(format!("ainovel-idea-{}", Uuid::new_v4()));
        let mut manager = ProjectManager::new();
        manager.create(&root, "Idea tests").expect("create");
        let session = manager
            .create_discussion_session("吞声灯".into(), DiscussionScopeKind::Project, None, None)
            .expect("session");
        (manager, root, session.id)
    }

    fn design(name: &str) -> DiscussionDesignEntity {
        DiscussionDesignEntity {
            entity_type: EntityType::Item,
            name: name.into(),
            description: "一盏储存声音的灯。".into(),
            aliases: vec![],
            tags: vec![],
            attributes: serde_json::json!({"capacity": 3}),
            settings: vec!["只能储存三句话。".into()],
            visibility: "AUTHOR_ONLY".into(),
            target_entity_id: None,
            expected_entity_version: None,
        }
    }

    fn proposal(manager: &mut ProjectManager, session_id: Uuid) -> DiscussionDesignProposal {
        let message = manager
            .append_discussion_message(
                session_id,
                DiscussionMessageRole::User,
                "选定只能储存三句话。".into(),
                None,
                None,
                None,
            )
            .expect("message");
        let version = manager
            .get_discussion_workspace(session_id)
            .expect("workspace")
            .version;
        manager
            .create_discussion_design_proposal(DiscussionDesignProposal {
                id: Uuid::new_v4(),
                session_id,
                workspace_version: version,
                entities: vec![design("吞声灯")],
                source_message_ids: vec![message.id],
                context_version: "design-context".into(),
                omitted_message_count: 0,
                status: "PENDING".into(),
                promoted_entity_ids: vec![],
                created_at: String::new(),
            })
            .expect("proposal")
    }

    #[test]
    fn draft_revisions_survive_reopen_and_limits_do_not_truncate() {
        let (mut manager, root, session_id) = project();
        let mut workspace = manager
            .get_discussion_workspace(session_id)
            .expect("default");
        workspace.topic_kind = DiscussionTopicKind::Item;
        workspace.draft.chosen = "只能储存三句话。".into();
        let first = manager.save_discussion_workspace(workspace).expect("save");
        assert_eq!(first.version, 1);
        assert_eq!(
            manager
                .save_discussion_workspace(first.clone())
                .expect("no-op")
                .version,
            1
        );
        let mut second = first.clone();
        second.draft.questions = "代价暂不决定。".into();
        let second = manager.save_discussion_workspace(second).expect("second");
        assert_eq!(second.version, 2);
        assert!(matches!(
            manager.save_discussion_workspace(first.clone()),
            Err(DiscussionStoreError::Conflict)
        ));
        let mut oversized = second.clone();
        oversized.draft.chosen = "字".repeat(50_001);
        assert!(matches!(
            manager.save_discussion_workspace(oversized),
            Err(DiscussionStoreError::LimitExceeded(_))
        ));
        assert_eq!(
            manager
                .get_discussion_workspace(session_id)
                .expect("unchanged"),
            second
        );
        drop(manager);
        let mut manager = ProjectManager::new();
        manager.open(&root).expect("reopen");
        let revisions = manager
            .list_discussion_draft_revisions(session_id, None)
            .expect("history");
        assert_eq!(revisions, vec![second.clone(), first.clone()]);
        let restored = manager
            .save_discussion_workspace(DiscussionWorkspace {
                version: second.version,
                ..first
            })
            .expect("restore");
        assert_eq!(restored.version, 3);
        assert!(restored.draft.questions.is_empty());
        assert_eq!(
            manager
                .list_discussion_draft_revisions(session_id, None)
                .expect("retained")
                .len(),
            3
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn message_pages_preserve_all_history_and_unicode_boundaries() {
        let (mut manager, root, session_id) = project();
        for index in 0..205 {
            manager
                .append_discussion_message(
                    session_id,
                    DiscussionMessageRole::User,
                    format!("灵感{index}"),
                    None,
                    None,
                    None,
                )
                .expect("message");
        }
        let newest = manager
            .list_discussion_messages_before(session_id, 100, None)
            .expect("newest");
        assert_eq!(newest[0].content, "灵感105");
        let older = manager
            .list_discussion_messages_before(session_id, 100, Some(newest[0].id))
            .expect("older");
        assert_eq!(older[0].content, "灵感5");
        let earliest = manager
            .list_discussion_messages_before(session_id, 100, Some(older[0].id))
            .expect("earliest");
        assert_eq!(earliest.len(), 5);
        assert_eq!(
            manager.discussion_message_count(session_id).expect("count"),
            205
        );
        manager
            .append_discussion_message(
                session_id,
                DiscussionMessageRole::User,
                "文".repeat(20_000),
                None,
                None,
                None,
            )
            .expect("at limit");
        assert!(matches!(
            manager.append_discussion_message(
                session_id,
                DiscussionMessageRole::User,
                "文".repeat(20_001),
                None,
                None,
                None
            ),
            Err(DiscussionStoreError::LimitExceeded(_))
        ));
        assert_eq!(
            manager
                .discussion_message_count(session_id)
                .expect("unchanged count"),
            206
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn author_confirmation_is_atomic_and_separate_from_manuscript_facts() {
        let (mut manager, root, session_id) = project();
        let proposal = proposal(&mut manager, session_id);
        assert!(
            manager
                .list_entities(false)
                .expect("no entities yet")
                .is_empty()
        );
        assert!(
            manager
                .list_author_settings()
                .expect("no settings yet")
                .is_empty()
        );
        let mut invalid = design("第二盏灯");
        invalid.target_entity_id = Some(Uuid::new_v4());
        invalid.expected_entity_version = Some(1);
        assert!(
            manager
                .confirm_discussion_design(proposal.id, vec![proposal.entities[0].clone(), invalid])
                .is_err()
        );
        assert!(
            manager
                .list_entities(false)
                .expect("rollback entities")
                .is_empty()
        );
        assert!(
            manager
                .list_author_settings()
                .expect("rollback rules")
                .is_empty()
        );
        let ids = manager
            .confirm_discussion_design(proposal.id, proposal.entities.clone())
            .expect("confirm");
        assert_eq!(ids.len(), 1);
        let settings = manager.list_author_settings().expect("settings");
        assert_eq!(settings.len(), 1);
        assert_eq!(settings[0].content, "只能储存三句话。");
        assert_eq!(settings[0].source_proposal_id, proposal.id);
        assert!(manager.list_current_facts().expect("facts").is_empty());
        assert!(manager.latest_world_state().expect("world state").is_none());
        assert!(matches!(
            manager.confirm_discussion_design(proposal.id, proposal.entities.clone()),
            Err(DiscussionStoreError::Conflict)
        ));
        let context = manager
            .assemble_context_with_project_knowledge(&novel_application::AssembleContextInput {
                chapter_id: Uuid::nil(),
                target_revision_id: None,
                action: AiAction::Continue,
                chapter_title: "吞声灯".into(),
                chapter_plan: String::new(),
                volume_plan: String::new(),
                document_json: r#"{"type":"doc","content":[]}"#.into(),
                selection: None,
                instruction: Some("描写吞声灯。".into()),
                input_token_budget: 20_000,
            })
            .expect("context");
        assert!(context.user_prompt.contains("只能储存三句话"));
        assert!(context.user_prompt.contains("不代表已在正文发生"));
        assert!(context.user_prompt.contains("作者保留"));
        let entity = manager.list_entities(false).expect("entities").remove(0);
        manager
            .upsert_entity(EntityInput {
                id: Some(entity.id),
                entity_type: EntityType::Item,
                name: "静语灯".into(),
                aliases: vec![],
                description: "更改外观描述。".into(),
                fixed_attributes_json: "{}".into(),
                tags: vec![],
                base_revision_id: Some(entity.current_revision_id),
                source_version: None,
                expected_version: Some(entity.version),
            })
            .expect("ordinary entity edit");
        assert_eq!(
            manager.list_author_settings().expect("retained rules")[0].entity_name,
            "静语灯"
        );
        assert_eq!(
            manager.list_author_settings().expect("retained rules")[0].content,
            "只能储存三句话。"
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_workspace_and_entity_versions_cannot_overwrite_confirmed_data() {
        let (mut manager, root, session_id) = project();
        let initial = proposal(&mut manager, session_id);
        let ids = manager
            .confirm_discussion_design(initial.id, initial.entities)
            .expect("initial");
        let mut workspace = manager
            .get_discussion_workspace(session_id)
            .expect("workspace");
        workspace.linked_entity_id = Some(ids[0]);
        workspace.draft.chosen = "改为储存五句话。".into();
        let workspace = manager.save_discussion_workspace(workspace).expect("link");
        let update = proposal(&mut manager, session_id);
        assert_eq!(update.entities[0].target_entity_id, Some(ids[0]));
        let old = manager.list_entities(false).expect("entity").remove(0);
        manager
            .upsert_entity(EntityInput {
                id: Some(old.id),
                entity_type: EntityType::Item,
                name: "吞声灯".into(),
                aliases: vec![],
                description: "作者在别处修改了外貌。".into(),
                fixed_attributes_json: "{}".into(),
                tags: vec![],
                base_revision_id: Some(old.current_revision_id),
                source_version: None,
                expected_version: Some(old.version),
            })
            .expect("concurrent update");
        assert!(matches!(
            manager.confirm_discussion_design(update.id, update.entities.clone()),
            Err(DiscussionStoreError::Entity(EntityStoreError::Contract(
                EntityError::Conflict { .. }
            )))
        ));
        let mut changed_workspace = workspace;
        changed_workspace.draft.questions = "另一问题".into();
        manager
            .save_discussion_workspace(changed_workspace)
            .expect("change draft");
        assert!(matches!(
            manager.confirm_discussion_design(update.id, update.entities),
            Err(DiscussionStoreError::Conflict)
        ));
        assert_eq!(
            manager
                .list_entity_revisions(old.id)
                .expect("history")
                .len(),
            2
        );
        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}

impl DiscussionTopicKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Free => "FREE",
            Self::Character => "CHARACTER",
            Self::Item => "ITEM",
            Self::Location => "LOCATION",
            Self::Plot => "PLOT",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDraft {
    pub chosen: String,
    pub alternatives: String,
    pub questions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionWorkspace {
    pub session_id: Uuid,
    pub topic_kind: DiscussionTopicKind,
    pub linked_entity_id: Option<Uuid>,
    pub draft: DiscussionDraft,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDesignEntity {
    pub entity_type: EntityType,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "empty_attributes")]
    pub attributes: serde_json::Value,
    #[serde(default)]
    pub settings: Vec<String>,
    #[serde(default = "author_only")]
    pub visibility: String,
    #[serde(default)]
    pub target_entity_id: Option<Uuid>,
    #[serde(default)]
    pub expected_entity_version: Option<i64>,
}

fn empty_attributes() -> serde_json::Value {
    serde_json::json!({})
}

fn author_only() -> String {
    "AUTHOR_ONLY".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDesignProposal {
    pub id: Uuid,
    pub session_id: Uuid,
    pub workspace_version: i64,
    pub entities: Vec<DiscussionDesignEntity>,
    pub source_message_ids: Vec<Uuid>,
    pub context_version: String,
    pub omitted_message_count: usize,
    pub status: String,
    pub promoted_entity_ids: Vec<Uuid>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorSetting {
    pub id: Uuid,
    pub entity_id: Uuid,
    pub entity_revision_id: Uuid,
    pub entity_name: String,
    pub content: String,
    pub visibility: String,
    pub source_proposal_id: Uuid,
    pub session_id: Uuid,
    pub created_at: String,
}

pub(crate) fn validate_discussion_text(
    content: &str,
    max_chars: usize,
) -> Result<(), DiscussionStoreError> {
    if content.chars().count() > max_chars {
        return Err(DiscussionStoreError::LimitExceeded(format!(
            "内容超过 {max_chars} 字上限，请拆分保存；原有数据不会被删除。"
        )));
    }
    Ok(())
}

fn json_string(value: &impl Serialize) -> Result<String, DiscussionStoreError> {
    serde_json::to_string(value).map_err(|error| {
        DiscussionStoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
    })
}

fn from_json<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn uuid_column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    let text: String = row.get(index)?;
    Uuid::parse_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiscussionDesignProposal> {
    Ok(DiscussionDesignProposal {
        id: uuid_column(row, 0)?,
        session_id: uuid_column(row, 1)?,
        workspace_version: row.get(2)?,
        entities: from_json(row, 3)?,
        source_message_ids: from_json(row, 4)?,
        context_version: row.get(5)?,
        omitted_message_count: row.get::<_, i64>(6)? as usize,
        status: row.get(7)?,
        promoted_entity_ids: from_json(row, 8)?,
        created_at: row.get(9)?,
    })
}

fn validate_entities(entities: &[DiscussionDesignEntity]) -> Result<(), DiscussionStoreError> {
    if entities.is_empty() || entities.len() > MAX_PROPOSAL_ENTITIES {
        return Err(DiscussionStoreError::LimitExceeded(
            "每次整理应包含 1 到 20 个实体。".into(),
        ));
    }
    let mut targets = std::collections::HashSet::new();
    for entity in entities {
        if entity.name.trim().is_empty()
            || !entity.attributes.is_object()
            || !matches!(entity.visibility.as_str(), "AUTHOR_ONLY" | "PUBLIC")
            || entity.target_entity_id.is_some() != entity.expected_entity_version.is_some()
        {
            return Err(DiscussionStoreError::InvalidPromotion);
        }
        validate_discussion_text(&entity.name, 200)?;
        validate_discussion_text(&entity.description, DISCUSSION_DRAFT_MAX_CHARS)?;
        if entity.settings.len() > 100
            || entity.aliases.len() > 100
            || entity.tags.len() > 100
            || entity.settings.iter().any(|item| item.trim().is_empty())
        {
            return Err(DiscussionStoreError::InvalidPromotion);
        }
        for setting in &entity.settings {
            validate_discussion_text(setting, 5_000)?;
        }
        if let Some(id) = entity.target_entity_id
            && !targets.insert(id)
        {
            return Err(DiscussionStoreError::InvalidPromotion);
        }
    }
    validate_discussion_text(&json_string(&entities)?, MAX_PROPOSAL_CHARS)
}

impl ProjectManager {
    pub fn discussion_message_count(
        &self,
        session_id: Uuid,
    ) -> Result<usize, DiscussionStoreError> {
        self.get_discussion_session(session_id)?;
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        let count: i64 = session.database.connection.query_row(
            "SELECT count(*) FROM discussion_messages WHERE session_id=?1",
            [session_id.to_string()],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn get_discussion_workspace(
        &self,
        session_id: Uuid,
    ) -> Result<DiscussionWorkspace, DiscussionStoreError> {
        self.get_discussion_session(session_id)?;
        let database = &self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?
            .database;
        database
            .connection
            .query_row(
                "SELECT topic_kind, linked_entity_id, draft_json, version
             FROM discussion_workspaces WHERE session_id=?1",
                [session_id.to_string()],
                |row| {
                    let kind: String = row.get(0)?;
                    let linked: Option<String> = row.get(1)?;
                    Ok(DiscussionWorkspace {
                        session_id,
                        topic_kind: serde_json::from_value(serde_json::Value::String(kind))
                            .map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    0,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                        linked_entity_id: linked
                            .map(|value| Uuid::parse_str(&value))
                            .transpose()
                            .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        draft: from_json(row, 2)?,
                        version: row.get(3)?,
                    })
                },
            )
            .optional()?
            .map_or_else(
                || {
                    Ok(DiscussionWorkspace {
                        session_id,
                        topic_kind: DiscussionTopicKind::Free,
                        linked_entity_id: None,
                        draft: DiscussionDraft::default(),
                        version: 0,
                    })
                },
                Ok,
            )
    }

    pub fn save_discussion_workspace(
        &mut self,
        workspace: DiscussionWorkspace,
    ) -> Result<DiscussionWorkspace, DiscussionStoreError> {
        let current = self.get_discussion_workspace(workspace.session_id)?;
        if current.version != workspace.version {
            return Err(DiscussionStoreError::Conflict);
        }
        if current == workspace {
            return Ok(current);
        }
        let total = workspace.draft.chosen.chars().count()
            + workspace.draft.alternatives.chars().count()
            + workspace.draft.questions.chars().count();
        if total > DISCUSSION_DRAFT_MAX_CHARS {
            return Err(DiscussionStoreError::LimitExceeded(
                "构思草稿合计最多 50000 字。".into(),
            ));
        }
        if let Some(id) = workspace.linked_entity_id {
            let exists = self
                .list_entities(false)?
                .iter()
                .any(|entity| entity.id == id);
            if !exists {
                return Err(DiscussionStoreError::InvalidPromotion);
            }
        }
        let mut next = workspace;
        next.version += 1;
        let draft_json = json_string(&next.draft)?;
        let session = self
            .current
            .as_mut()
            .ok_or(DiscussionStoreError::NoProject)?;
        let tx = session.database.connection.transaction()?;
        let changed = tx.execute(
            "INSERT INTO discussion_workspaces (session_id, topic_kind, linked_entity_id, draft_json, version)
             VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(session_id) DO UPDATE SET topic_kind=excluded.topic_kind,
                 linked_entity_id=excluded.linked_entity_id, draft_json=excluded.draft_json,
                 version=excluded.version, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE discussion_workspaces.version=?6",
            rusqlite::params![next.session_id.to_string(), next.topic_kind.as_str(),
                next.linked_entity_id.map(|id| id.to_string()), draft_json, next.version, current.version],
        )?;
        if changed != 1 {
            return Err(DiscussionStoreError::Conflict);
        }
        tx.execute(
            "INSERT INTO discussion_draft_revisions (session_id, version, topic_kind, linked_entity_id, draft_json)
             VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![next.session_id.to_string(), next.version, next.topic_kind.as_str(),
                next.linked_entity_id.map(|id| id.to_string()), draft_json],
        )?;
        tx.commit()?;
        Ok(next)
    }

    pub fn list_discussion_draft_revisions(
        &self,
        session_id: Uuid,
        before_version: Option<i64>,
    ) -> Result<Vec<DiscussionWorkspace>, DiscussionStoreError> {
        self.get_discussion_session(session_id)?;
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT topic_kind, linked_entity_id, draft_json, version FROM discussion_draft_revisions
             WHERE session_id=?1 AND (?2 IS NULL OR version < ?2)
             ORDER BY version DESC LIMIT 50",
        )?;
        let rows = statement.query_map(
            rusqlite::params![session_id.to_string(), before_version],
            |row| {
                let kind: String = row.get(0)?;
                let linked: Option<String> = row.get(1)?;
                Ok(DiscussionWorkspace {
                    session_id,
                    topic_kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(
                        |error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        },
                    )?,
                    linked_entity_id: linked
                        .map(|value| Uuid::parse_str(&value))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                    draft: from_json(row, 2)?,
                    version: row.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn create_discussion_design_proposal(
        &mut self,
        mut proposal: DiscussionDesignProposal,
    ) -> Result<DiscussionDesignProposal, DiscussionStoreError> {
        if self.get_discussion_workspace(proposal.session_id)?.version != proposal.workspace_version
        {
            return Err(DiscussionStoreError::Conflict);
        }
        validate_entities(&proposal.entities)?;
        let source = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        for message_id in &proposal.source_message_ids {
            let belongs: bool = source.database.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM discussion_messages WHERE id=?1 AND session_id=?2)",
                rusqlite::params![message_id.to_string(), proposal.session_id.to_string()],
                |row| row.get(0),
            )?;
            if !belongs {
                return Err(DiscussionStoreError::MissingMessage(*message_id));
            }
        }
        // The model cannot choose update targets or versions.
        for entity in &mut proposal.entities {
            entity.target_entity_id = None;
            entity.expected_entity_version = None;
        }
        let workspace = self.get_discussion_workspace(proposal.session_id)?;
        if let Some(id) = workspace.linked_entity_id
            && let Some((existing, revision)) = self
                .list_current_entity_revisions()?
                .into_iter()
                .find(|(entity, _)| entity.id == id)
        {
            let same_type = proposal
                .entities
                .iter()
                .filter(|entity| entity.entity_type == existing.entity_type)
                .count();
            if let Some(entity) = proposal.entities.iter_mut().find(|entity| {
                entity.entity_type == existing.entity_type
                    && (entity.name.trim() == revision.name.trim() || same_type == 1)
            }) {
                entity.target_entity_id = Some(id);
                entity.expected_entity_version = Some(existing.version);
                if let Ok(serde_json::Value::Object(mut previous)) =
                    serde_json::from_str(&revision.fixed_attributes_json)
                    && let Some(changes) = entity.attributes.as_object()
                {
                    previous.extend(changes.clone());
                    entity.attributes = serde_json::Value::Object(previous);
                }
            }
        }
        proposal.status = "PENDING".into();
        proposal.promoted_entity_ids.clear();
        validate_entities(&proposal.entities)?;
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        session.database.connection.execute(
            "INSERT INTO discussion_design_proposals
             (id, session_id, workspace_version, entities_json, source_message_ids_json,
              context_version, omitted_message_count, status, promoted_entity_ids_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'PENDING','[]')",
            rusqlite::params![
                proposal.id.to_string(),
                proposal.session_id.to_string(),
                proposal.workspace_version,
                json_string(&proposal.entities)?,
                json_string(&proposal.source_message_ids)?,
                proposal.context_version,
                proposal.omitted_message_count as i64
            ],
        )?;
        proposal.created_at = session.database.connection.query_row(
            "SELECT created_at FROM discussion_design_proposals WHERE id=?1",
            [proposal.id.to_string()],
            |row| row.get(0),
        )?;
        Ok(proposal)
    }

    pub fn list_discussion_design_proposals(
        &self,
        session_id: Uuid,
        before_id: Option<Uuid>,
    ) -> Result<Vec<DiscussionDesignProposal>, DiscussionStoreError> {
        self.get_discussion_session(session_id)?;
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, session_id, workspace_version, entities_json, source_message_ids_json,
                    context_version, omitted_message_count, status, promoted_entity_ids_json, created_at
             FROM discussion_design_proposals
             WHERE session_id=?1 AND (?2 IS NULL OR rowid <
                 (SELECT rowid FROM discussion_design_proposals WHERE id=?2 AND session_id=?1))
             ORDER BY rowid DESC LIMIT 20",
        )?;
        let rows = statement.query_map(
            rusqlite::params![session_id.to_string(), before_id.map(|id| id.to_string())],
            map_proposal,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn confirm_discussion_design(
        &mut self,
        id: Uuid,
        entities: Vec<DiscussionDesignEntity>,
    ) -> Result<Vec<Uuid>, DiscussionStoreError> {
        validate_entities(&entities)?;
        let session = self
            .current
            .as_mut()
            .ok_or(DiscussionStoreError::NoProject)?;
        let project_id = session.manifest.project_id;
        let tx = session.database.connection.transaction()?;
        let proposal = tx.query_row(
            "SELECT p.id, p.session_id, p.workspace_version, p.entities_json, p.source_message_ids_json,
                    p.context_version, p.omitted_message_count, p.status, p.promoted_entity_ids_json, p.created_at
             FROM discussion_design_proposals p JOIN discussion_sessions s ON s.id=p.session_id
             WHERE p.id=?1 AND s.project_id=?2",
            rusqlite::params![id.to_string(), project_id.to_string()],
            map_proposal,
        ).optional()?.ok_or(DiscussionStoreError::MissingCandidate(id))?;
        if proposal.status != "PENDING" {
            return Err(DiscussionStoreError::Conflict);
        }
        let current_version: i64 = tx.query_row(
            "SELECT COALESCE((SELECT version FROM discussion_workspaces WHERE session_id=?1),0)",
            [proposal.session_id.to_string()],
            |row| row.get(0),
        )?;
        if current_version != proposal.workspace_version {
            return Err(DiscussionStoreError::Conflict);
        }
        let mut promoted = Vec::new();
        for entity in &entities {
            if let Some(target) = entity.target_entity_id {
                let allowed = proposal.entities.iter().any(|original| {
                    original.target_entity_id == Some(target)
                        && original.expected_entity_version == entity.expected_entity_version
                });
                if !allowed {
                    return Err(DiscussionStoreError::InvalidPromotion);
                }
            }
            let base_revision: Option<String> = if let Some(target) = entity.target_entity_id {
                tx.query_row(
                    "SELECT current_revision_id FROM entities WHERE id=?1 AND project_id=?2 AND lifecycle_status='ACTIVE'",
                    rusqlite::params![target.to_string(), project_id.to_string()],
                    |row| row.get(0),
                ).optional()?
            } else {
                None
            };
            if entity.target_entity_id.is_some() && base_revision.is_none() {
                return Err(DiscussionStoreError::InvalidPromotion);
            }
            let base_revision_id = base_revision
                .map(|value| Uuid::parse_str(&value))
                .transpose()
                .map_err(|_| DiscussionStoreError::InvalidPromotion)?;
            let input = EntityInput {
                id: entity.target_entity_id,
                entity_type: entity.entity_type,
                name: entity.name.clone(),
                aliases: entity.aliases.clone(),
                description: entity.description.clone(),
                fixed_attributes_json: json_string(&entity.attributes)?,
                tags: entity.tags.clone(),
                base_revision_id,
                source_version: Some(format!(
                    "discussion:{}:proposal:{id}:draft:v{}",
                    proposal.session_id, proposal.workspace_version
                )),
                expected_version: entity.expected_entity_version,
            };
            input.validate().map_err(EntityStoreError::from)?;
            let entity_id = Database::upsert_entity_in_tx(&tx, project_id, input)?;
            let revision_id: String = tx.query_row(
                "SELECT current_revision_id FROM entities WHERE id=?1",
                [entity_id.to_string()],
                |row| row.get(0),
            )?;
            for setting in &entity.settings {
                tx.execute(
                    "INSERT INTO author_settings (id,project_id,entity_id,entity_revision_id,content,visibility,source_proposal_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![Uuid::new_v4().to_string(), project_id.to_string(), entity_id.to_string(),
                        revision_id, setting.trim(), entity.visibility, id.to_string()],
                )?;
            }
            promoted.push(entity_id);
        }
        tx.execute(
            "UPDATE discussion_design_proposals SET status='CONFIRMED',
                 promoted_entity_ids_json=?1, confirmed_entities_json=?2 WHERE id=?3 AND status='PENDING'",
            rusqlite::params![json_string(&promoted)?, json_string(&entities)?, id.to_string()],
        )?;
        tx.commit()?;
        session.database.rebuild_search_index(project_id)?;
        Ok(promoted)
    }

    pub fn list_author_settings(&self) -> Result<Vec<AuthorSetting>, DiscussionStoreError> {
        let session = self
            .current
            .as_ref()
            .ok_or(DiscussionStoreError::NoProject)?;
        let mut statement = session.database.connection.prepare(
            "SELECT a.id,a.entity_id,a.entity_revision_id,r.name,a.content,a.visibility,
                    a.source_proposal_id,p.session_id,a.created_at
             FROM author_settings a JOIN entities e ON e.id=a.entity_id
             JOIN entity_revisions r ON r.id=a.entity_revision_id
             JOIN discussion_design_proposals p ON p.id=a.source_proposal_id
             WHERE a.project_id=?1 AND e.lifecycle_status='ACTIVE'
               AND e.current_revision_id=a.entity_revision_id
             ORDER BY a.created_at DESC,a.rowid DESC",
        )?;
        let rows = statement.query_map([session.manifest.project_id.to_string()], |row| {
            Ok(AuthorSetting {
                id: uuid_column(row, 0)?,
                entity_id: uuid_column(row, 1)?,
                entity_revision_id: uuid_column(row, 2)?,
                entity_name: row.get(3)?,
                content: row.get(4)?,
                visibility: row.get(5)?,
                source_proposal_id: uuid_column(row, 6)?,
                session_id: uuid_column(row, 7)?,
                created_at: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}
