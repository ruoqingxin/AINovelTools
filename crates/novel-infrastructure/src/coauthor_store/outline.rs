use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorOutlineEdit {
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorOutlinePage {
    pub key: String,
    pub revision: String,
    pub title: String,
    pub story_state: PlanningStoryState,
    pub offset: usize,
    pub total_chars: usize,
    pub content: String,
    pub next_offset: Option<usize>,
}

fn invalid_outline() -> CoauthorError {
    CoauthorError::Invalid(
        "大纲修改范围或原文无效，请读取准确内容后重新准备；不修改候选稿、标题或层级。".into(),
    )
}

fn apply_outline_edits(
    content: &str,
    edits: &[CoauthorOutlineEdit],
) -> Result<String, CoauthorError> {
    if edits.is_empty() || edits.len() > 80 {
        return Err(invalid_outline());
    }
    let text: Vec<char> = content.chars().collect();
    let mut ordered: Vec<_> = edits.iter().collect();
    ordered.sort_by_key(|edit| (edit.start, edit.end));
    if ordered
        .windows(2)
        .any(|pair| pair[0].end > pair[1].start || pair[0].start == pair[1].start)
    {
        return Err(invalid_outline());
    }
    for edit in &ordered {
        if edit.start >= edit.end
            || edit.end > text.len()
            || edit.before == edit.after
            || edit.after.chars().count() > 12_000
            || text[edit.start..edit.end].iter().collect::<String>() != edit.before
        {
            return Err(invalid_outline());
        }
    }
    let mut result = String::new();
    let mut cursor = 0;
    for edit in ordered {
        result.extend(text[cursor..edit.start].iter());
        result.push_str(&edit.after);
        cursor = edit.end;
    }
    result.extend(text[cursor..].iter());
    if result.trim().is_empty() || result.chars().count() > 500_000 {
        return Err(invalid_outline());
    }
    Ok(result)
}

impl ProjectManager {
    pub fn read_coauthor_outline(
        &self,
        scope: &CoauthorScope,
        key: &str,
        revision: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CoauthorOutlinePage, CoauthorError> {
        self.validate_coauthor_scope(scope)?;
        let db = &self
            .current
            .as_ref()
            .ok_or(CoauthorError::WrongProject)?
            .database;
        let tx = rusqlite::Transaction::new_unchecked(
            &db.connection,
            rusqlite::TransactionBehavior::Deferred,
        )?;
        let (source, section) = db.coauthor_outline(key, revision)?;
        let total_chars = section.section.content.chars().count();
        if offset > total_chars {
            return Err(invalid_outline());
        }
        let end = offset
            .saturating_add(limit.clamp(1, 12_000))
            .min(total_chars);
        let page = CoauthorOutlinePage {
            key: source.key,
            revision: source.revision,
            title: source.title,
            story_state: section.section.story_state,
            offset,
            total_chars,
            content: section
                .section
                .content
                .chars()
                .skip(offset)
                .take(end - offset)
                .collect(),
            next_offset: (end < total_chars).then_some(end),
        };
        tx.commit()?;
        Ok(page)
    }
}

impl Database {
    fn coauthor_outline(
        &self,
        key: &str,
        revision: &str,
    ) -> Result<(CoauthorSource, VersionedPlanningSection), CoauthorError> {
        let source = self.coauthor_source(key)?.ok_or(CoauthorError::NotFound)?;
        if source.kind != "PLAN" || source.revision != revision {
            return Err(CoauthorError::Conflict);
        }
        let node_id = key
            .strip_prefix("PLAN:plan-node:")
            .ok_or_else(invalid_outline)?;
        let outline: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM plan_nodes WHERE id=?1 AND kind='OUTLINE' AND archived=0)",
            [node_id],
            |row| row.get(0),
        )?;
        if !outline {
            return Err(invalid_outline());
        }
        let section_id = key.strip_prefix("PLAN:").ok_or_else(invalid_outline)?;
        let section = self.connection.query_row(
            "SELECT id,content,pending_content,story_state,rationale,consequence,references_json,updated_at,version
             FROM planning_sections WHERE id=?1", [section_id], |row| {
                Ok((PlanningSection {
                    id: row.get(0)?, content: row.get(1)?, pending_content: row.get(2)?,
                    story_state: PlanningStoryState::parse(&row.get::<_,String>(3)?),
                    rationale: row.get(4)?, consequence: row.get(5)?, references: vec![], updated_at: row.get(7)?,
                }, row.get::<_,String>(6)?, row.get::<_,i64>(8)?))
            })?;
        let (mut section, references, version) = section;
        section.references = decode(references)?;
        Ok((source, VersionedPlanningSection { section, version }))
    }

    pub(super) fn prepare_outline_item(
        &self,
        item: &mut CoauthorChangeItem,
    ) -> Result<(), CoauthorError> {
        if item.document.kind != CoauthorDocumentKind::Outline || !item.manuscript_edits.is_empty()
        {
            return Err(invalid_outline());
        }
        let key = item
            .document
            .target_key
            .as_deref()
            .ok_or_else(invalid_outline)?;
        let revision = item
            .document
            .target_revision
            .as_deref()
            .ok_or_else(invalid_outline)?;
        let (source, before) = self.coauthor_outline(key, revision)?;
        if before.section.story_state != PlanningStoryState::Confirmed
            || item.document.title != source.title
        {
            return Err(CoauthorError::Invalid(
                "仅可修改已确认且未锁定的大纲正式内容；不同时改名或改变状态。".into(),
            ));
        }
        item.document.content = apply_outline_edits(&before.section.content, &item.outline_edits)?;
        item.before = Some(source);
        item.outline_before = Some(before);
        item.outline_fingerprint = Some(self.coauthor_native_fingerprint(key)?);
        Ok(())
    }

    pub(super) fn validate_outline_item(
        &self,
        item: &CoauthorChangeItem,
    ) -> Result<(), CoauthorError> {
        let mut actual = item.clone();
        self.prepare_outline_item(&mut actual)?;
        if actual.outline_before != item.outline_before
            || actual.outline_fingerprint != item.outline_fingerprint
            || actual.document.content != item.document.content
        {
            return Err(CoauthorError::Conflict);
        }
        Ok(())
    }

    pub(super) fn publish_outline_item(
        &self,
        tx: &rusqlite::Transaction<'_>,
        item: &CoauthorChangeItem,
    ) -> Result<String, CoauthorError> {
        self.validate_outline_item(item)?;
        let before = item.outline_before.as_ref().ok_or_else(invalid_outline)?;
        let mut section = before.section.clone();
        section.content.clone_from(&item.document.content);
        Self::save_coauthor_outline_in_tx(tx, section, before.version)?;
        item.document.target_key.clone().ok_or_else(invalid_outline)
    }

    pub(super) fn save_coauthor_outline_in_tx(
        tx: &rusqlite::Transaction<'_>,
        section: PlanningSection,
        expected_version: i64,
    ) -> Result<(), CoauthorError> {
        let id = section.id.clone();
        Self::save_planning_section_in_tx(tx, section, Some(expected_version))
            .map_err(|error| CoauthorError::Invalid(error.to_string()))?;
        tx.execute("UPDATE summary_materials SET lifecycle_status='STALE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE lifecycle_status='ACTIVE' AND (source_id=?1 OR source_id=?2
                OR generation_mode IN ('EXTRACTIVE_AUTO_PROJECT','EXTRACTIVE_AUTO_SETTINGS'))",
            rusqlite::params![id,id.strip_prefix("plan-node:").unwrap_or(&id)])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
