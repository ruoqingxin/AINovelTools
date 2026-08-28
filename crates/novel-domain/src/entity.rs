use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntityType {
    Character,
    Location,
    Faction,
    Item,
    Concept,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntityLifecycleStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: Uuid,
    pub project_id: Uuid,
    pub entity_type: EntityType,
    pub lifecycle_status: EntityLifecycleStatus,
    pub current_revision_id: Uuid,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntityRevision {
    pub id: Uuid,
    pub entity_id: Uuid,
    pub revision: i64,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub fixed_attributes_json: String,
    pub tags: Vec<String>,
    pub base_revision_id: Option<Uuid>,
    pub source_version: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntityInput {
    pub id: Option<Uuid>,
    pub entity_type: EntityType,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub fixed_attributes_json: String,
    pub tags: Vec<String>,
    pub base_revision_id: Option<Uuid>,
    pub source_version: Option<String>,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EntityError {
    #[error("entity name cannot be empty")]
    EmptyName,
    #[error("entity fixed attributes must be a JSON object")]
    InvalidFixedAttributes,
    #[error("entity version conflict: expected {expected}, actual {actual}")]
    Conflict { expected: i64, actual: i64 },
}

impl EntityInput {
    pub fn validate(&self) -> Result<(), EntityError> {
        if self.name.trim().is_empty() {
            return Err(EntityError::EmptyName);
        }
        let parsed: serde_json::Value = serde_json::from_str(&self.fixed_attributes_json)
            .map_err(|_| EntityError::InvalidFixedAttributes)?;
        if !parsed.is_object() {
            return Err(EntityError::InvalidFixedAttributes);
        }
        Ok(())
    }
}
