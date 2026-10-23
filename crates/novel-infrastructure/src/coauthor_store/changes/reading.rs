use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangePlanRule {
    pub decision_id: Uuid,
    pub item_ids: Vec<String>,
    pub prepared_version: i64,
    pub prepared_status: String,
    pub current_version: Option<i64>,
    pub current_status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangePlanItem {
    pub item_id: String,
    pub title: String,
    pub kind: CoauthorDocumentKind,
    pub state: String,
    pub depends_on: Vec<String>,
    pub target_key: Option<String>,
    pub target_revision: Option<String>,
    pub published_key: Option<String>,
    pub published_revision: Option<String>,
    pub before_available: bool,
    pub before_chars: usize,
    pub after_chars: usize,
    pub has_structured_edits: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangePlan {
    pub id: Uuid,
    pub version: i64,
    pub title: String,
    pub status: String,
    pub reversed_by: Option<Uuid>,
    pub base_document_version: i64,
    pub coverage: String,
    pub items: Vec<CoauthorChangePlanItem>,
    pub decision_dependencies: Option<Vec<CoauthorChangePlanRule>>,
    pub snapshot_only: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoauthorChangeItemSide { Before, After }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoauthorChangeItemRead {
    pub change_set_id: Uuid,
    pub expected_version: i64,
    pub item_id: String,
    pub side: CoauthorChangeItemSide,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoauthorChangeItemPage {
    pub change_set_id: Uuid,
    pub change_set_version: i64,
    pub item_id: String,
    pub side: CoauthorChangeItemSide,
    pub available: bool,
    pub content: String,
    pub offset: usize,
    pub next_offset: usize,
    pub total_chars: usize,
    pub snapshot_only: bool,
}

impl ProjectManager {
    pub fn coauthor_change_plan(&self, scope: &CoauthorScope, id: Uuid) -> Result<CoauthorChangePlan, CoauthorError> {
        let changes = self.coauthor_changeset(scope, id)?;
        validate_snapshot_identity(&changes, scope, id)?;
        let items = changes.items.iter().map(|item| {
            let published = changes.published.iter().find(|entry| entry.item_id == item.id);
            let state = match changes.status.as_str() {
                "PENDING" => "PENDING",
                "DISCARDED" => "DISCARDED",
                _ if published.is_none() => "NOT_ADOPTED",
                _ if changes.reversed_by.is_some() => "REVERSED",
                _ => "ADOPTED",
            };
            CoauthorChangePlanItem {
                item_id: item.id.clone(), title: item.document.title.clone(), kind: item.document.kind,
                state: state.into(), depends_on: item.depends_on.clone(),
                target_key: item.document.target_key.clone(), target_revision: item.document.target_revision.clone(),
                published_key: published.map(|entry| entry.source_key.clone()),
                published_revision: published.map(|entry| entry.revision.clone()),
                before_available: item.before.is_some(),
                before_chars: item.before.as_ref().map_or(0, |before| before.content.chars().count()),
                after_chars: item.document.content.chars().count(),
                has_structured_edits: !item.manuscript_edits.is_empty() || !item.outline_edits.is_empty(),
            }
        }).collect();
        let dependencies = changes.decision_dependencies.map(|entries| entries.into_iter().map(|entry| CoauthorChangePlanRule {
            decision_id: entry.decision.id, item_ids: entry.item_ids,
            prepared_version: entry.decision.version, prepared_status: entry.decision.status,
            current_version: entry.current.as_ref().map(|current| current.version),
            current_status: entry.current.map(|current| current.status),
        }).collect());
        Ok(CoauthorChangePlan {
            id: changes.id, version: changes.version, title: changes.title, status: changes.status,
            reversed_by: changes.reversed_by, base_document_version: changes.base_document.version,
            coverage: changes.coverage, items, decision_dependencies: dependencies, snapshot_only: true,
        })
    }

    pub fn read_coauthor_change_item(
        &self, scope: &CoauthorScope, request: CoauthorChangeItemRead,
    ) -> Result<CoauthorChangeItemPage, CoauthorError> {
        let CoauthorChangeItemRead { change_set_id, expected_version, item_id, side, offset, limit } = request;
        if !(1..=12_000).contains(&limit) {
            return Err(CoauthorError::Invalid("方案快照每页读取范围须为1至12000字。".into()));
        }
        let changes = self.coauthor_changeset(scope, change_set_id)?;
        validate_snapshot_identity(&changes, scope, change_set_id)?;
        if changes.version != expected_version { return Err(CoauthorError::Conflict); }
        let item = changes.items.iter().find(|item| item.id == item_id).ok_or(CoauthorError::NotFound)?;
        let text = match side {
            CoauthorChangeItemSide::Before => item.before.as_ref().map(|before| before.content.as_str()),
            CoauthorChangeItemSide::After => Some(item.document.content.as_str()),
        };
        let total_chars = text.map_or(0, |text| text.chars().count());
        if offset > total_chars {
            return Err(CoauthorError::Invalid("方案快照读取位置越界，请按实际nextOffset续读。".into()));
        }
        Ok(CoauthorChangeItemPage {
            change_set_id: changes.id, change_set_version: changes.version, item_id: item.id.clone(), side,
            available: text.is_some(), content: text.unwrap_or_default().chars().skip(offset).take(limit).collect(),
            offset, next_offset: offset + limit.min(total_chars - offset), total_chars, snapshot_only: true,
        })
    }
}

fn validate_snapshot_identity(changes: &CoauthorChangeSet, scope: &CoauthorScope, id: Uuid) -> Result<(), CoauthorError> {
    if changes.id != id || changes.base_document.session_id != scope.session_id
        || !["PENDING", "COMMITTED", "DISCARDED"].contains(&changes.status.as_str())
    {
        return Err(CoauthorError::Invalid("方案快照身份或状态无效，未读取其他方案代替。".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
