use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicBool};

pub(crate) struct ProjectState {
    pub(crate) manager: Mutex<novel_infrastructure::ProjectManager>,
    pub(crate) model_profiles: Mutex<novel_infrastructure::ModelProfileStore>,
    pub(crate) gateway: novel_infrastructure::ModelGateway,
    pub(crate) embedding_gateway: novel_infrastructure::EmbeddingGateway,
    pub(crate) ai_cancellations: Mutex<HashMap<uuid::Uuid, Arc<AtomicBool>>>,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiStreamChunk {
    pub(crate) task_id: uuid::Uuid,
    pub(crate) chunk: String,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTaskStarted {
    pub(crate) task_id: uuid::Uuid,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelConnectionResponse {
    pub(crate) capability: novel_infrastructure::ModelCapability,
    pub(crate) provider: novel_infrastructure::ModelProvider,
    pub(crate) model_id: String,
    pub(crate) detail: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapStatus {
    pub(crate) app_version: &'static str,
    pub(crate) layers: [&'static str; 3],
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseHealthResponse {
    pub(crate) status: &'static str,
    pub(crate) sqlite_version: String,
    pub(crate) schema_version: i64,
    pub(crate) journal_mode: String,
    pub(crate) foreign_keys_enabled: bool,
}
