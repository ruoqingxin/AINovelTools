use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SummaryKind {
    Chapter,
    Character,
    Setting,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SummaryPrecision {
    L0,
    L1,
    L2,
    L3,
    L4,
    L5,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryMaterial {
    pub id: Uuid,
    pub project_id: Uuid,
    pub kind: SummaryKind,
    pub precision: SummaryPrecision,
    pub source_id: Option<Uuid>,
    pub source_version: Option<String>,
    pub content: String,
    pub generation_mode: String,
    pub lifecycle_status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritingCard {
    pub id: Uuid,
    pub project_id: Uuid,
    pub card_type: String,
    pub title: String,
    pub content: String,
    pub source_version: Option<String>,
    pub scope: String,
    pub enabled: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}
