//! Adapters for persistence, files, model providers, and operating-system APIs.

#![allow(
    clippy::missing_errors_doc,
    clippy::items_after_statements,
    clippy::match_same_arms,
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::collapsible_if,
    clippy::if_same_then_else
)]

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

mod ai;
mod database;
mod entity_store;
pub use ai::{AiError, EmbeddingGateway, ModelGateway, SecretStore};
pub use entity_store::EntityStoreError;
pub use novel_domain::{
    AiAction, AiProposal, AiProposalStatus, AiTaskStatus, Entity, EntityError, EntityInput,
    EntityLifecycleStatus, EntityRevision, EntityType, ModelCapability, ModelProfile,
    ModelProfileInput, ModelProvider, PrivacyLevel,
};

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database path has no parent directory: {0}")]
    MissingParent(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseHealth {
    pub sqlite_version: String,
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FeatureStatus {
    Implemented,
    Partial,
    Declared,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub stage: &'static str,
    pub status: FeatureStatus,
    pub unavailable_reason: Option<&'static str>,
}

/// R4 schema and contract planning metadata shared by migration checks and
/// diagnostics. The actual feature tables are introduced by later R4 slices.
pub const R4_SCHEMA_VERSION: i64 = 11;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct R4MigrationDescriptor {
    pub version: i64,
    pub name: &'static str,
    pub purpose: &'static str,
    pub depends_on: &'static [i64],
}

pub const R4_MIGRATION_PLAN: &[R4MigrationDescriptor] = &[
    R4MigrationDescriptor {
        version: 10,
        name: "r4_project_settings_baseline",
        purpose: "统一项目级写作风格、隐私设置和扩展元数据",
        depends_on: &[9],
    },
    R4MigrationDescriptor {
        version: 11,
        name: "r4_story_bible_entities",
        purpose: "Character、Location、Faction、Item、Concept 和实体修订",
        depends_on: &[10],
    },
    R4MigrationDescriptor {
        version: 12,
        name: "r4_summary_and_writing_cards",
        purpose: "多精度摘要、风格规则卡和写作技巧卡",
        depends_on: &[11],
    },
    R4MigrationDescriptor {
        version: 13,
        name: "r4_fts5_projection",
        purpose: "SQLite FTS5 trigram 搜索投影和重建状态",
        depends_on: &[11, 12],
    },
    R4MigrationDescriptor {
        version: 14,
        name: "r4_persistent_jobs",
        purpose: "备份、恢复验证、健康扫描和 FTS 重建任务",
        depends_on: &[10],
    },
    R4MigrationDescriptor {
        version: 15,
        name: "r4_backup_health_diagnostics",
        purpose: "备份清单、健康扫描和启动诊断元数据",
        depends_on: &[10, 14],
    },
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct R4ContractDescriptor {
    pub id: &'static str,
    pub layer: &'static str,
    pub purpose: &'static str,
    pub introduced_by: i64,
}

pub const R4_CONTRACTS: &[R4ContractDescriptor] = &[
    R4ContractDescriptor {
        id: "project_settings",
        layer: "persistence",
        purpose: "项目级写作风格、隐私设置和扩展元数据",
        introduced_by: 10,
    },
    R4ContractDescriptor {
        id: "story_bible_entities",
        layer: "domain-ipc",
        purpose: "实体、实体修订、别名、标签和归档",
        introduced_by: 11,
    },
    R4ContractDescriptor {
        id: "summary_materials",
        layer: "domain-ipc",
        purpose: "章节、人物和设定的多精度摘要材料",
        introduced_by: 12,
    },
    R4ContractDescriptor {
        id: "search",
        layer: "application-ipc",
        purpose: "结构化查询、关键词查询和 FTS 重建",
        introduced_by: 13,
    },
    R4ContractDescriptor {
        id: "persistent_jobs",
        layer: "application-ipc",
        purpose: "可取消、可重试、可恢复的本地后台任务",
        introduced_by: 14,
    },
    R4ContractDescriptor {
        id: "reliability",
        layer: "infrastructure-ipc",
        purpose: "备份、恢复、健康扫描、CrashMarker 和诊断包",
        introduced_by: 15,
    },
];

pub const FEATURE_CATALOG: &[FeatureDescriptor] = &[
    FeatureDescriptor {
        id: "project_management",
        display_name: "项目管理",
        stage: "R0",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "plan_revisions",
        display_name: "规划不可变修订",
        stage: "R1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "manuscript_revisions",
        display_name: "正文不可变修订",
        stage: "R2",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "recovery_log",
        display_name: "编辑恢复",
        stage: "R2",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "conflict_merge",
        display_name: "正文冲突合并",
        stage: "R2",
        status: FeatureStatus::Partial,
        unavailable_reason: Some("逐块选择工具延后实现"),
    },
    FeatureDescriptor {
        id: "ai_model_profiles",
        display_name: "AI 模型配置与系统密钥",
        stage: "R3",
        status: FeatureStatus::Partial,
        unavailable_reason: Some("等待桌面闭环验收"),
    },
    FeatureDescriptor {
        id: "ai_writing",
        display_name: "AI 创作闭环",
        stage: "R3",
        status: FeatureStatus::Partial,
        unavailable_reason: Some("正在实现 Proposal 交互"),
    },
    FeatureDescriptor {
        id: "r4_project_settings",
        display_name: "R4 项目设置基线",
        stage: "R4",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("R4 阶段 A 已建立迁移基线，设置读写待后续切片实现"),
    },
    FeatureDescriptor {
        id: "story_bible",
        display_name: "Story Bible 实体库",
        stage: "R4",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("等待 R4 阶段 B/C 实现实体和实体修订"),
    },
    FeatureDescriptor {
        id: "r4_search",
        display_name: "SQLite FTS5 搜索",
        stage: "R4",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("等待 R4 阶段 E 实现索引投影和搜索"),
    },
    FeatureDescriptor {
        id: "r4_persistent_jobs",
        display_name: "R4 持久化任务",
        stage: "R4",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("等待 R4 阶段 G 实现 Job Runner"),
    },
    FeatureDescriptor {
        id: "r4_reliability",
        display_name: "R4 备份恢复与诊断",
        stage: "R4",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("等待 R4 阶段 H/I 实现可靠性能力"),
    },
];

pub struct Database {
    connection: Connection,
}

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project path is invalid: {0}")]
    InvalidPath(PathBuf),
    #[error("project already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("project is not initialized: {0}")]
    NotInitialized(PathBuf),
    #[error("project file operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("project manifest is invalid: {0}")]
    Manifest(#[from] serde_json::Error),
    #[error("project database failed: {0}")]
    Database(#[from] DatabaseError),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub project_id: Uuid,
    pub format_version: u32,
    pub name: String,
    pub created_at: String,
}

pub struct ProjectSession {
    pub root: PathBuf,
    pub manifest: ProjectManifest,
    pub database: Database,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanNodeKind {
    WorkDesign,
    Outline,
    Volume,
    Chapter,
    Scene,
}
impl PlanNodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::WorkDesign => "WORK_DESIGN",
            Self::Outline => "OUTLINE",
            Self::Volume => "VOLUME",
            Self::Chapter => "CHAPTER",
            Self::Scene => "SCENE",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub kind: PlanNodeKind,
    pub title: String,
    pub sort_order: i64,
    pub archived: bool,
    pub revision: i64,
}
#[derive(Debug, Error)]
pub enum PlanError {
    #[error("no project is open")]
    NoProject,
    #[error("plan title cannot be empty")]
    EmptyTitle,
    #[error("parent plan node does not exist: {0}")]
    MissingParent(Uuid),
    #[error("plan node does not exist: {0}")]
    MissingNode(Uuid),
    #[error("plan revision conflict: expected {expected}, actual {actual}")]
    Conflict { expected: i64, actual: i64 },
    #[error("invalid parent kind for plan node")]
    InvalidParentKind,
    #[error("moving a plan node would create a cycle")]
    Cycle,
    #[error("plan database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NoProjectOpen,
    InvalidInput,
    NotFound,
    VersionConflict,
    InvalidDocument,
    Database,
    FeatureNotAvailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryLog {
    pub id: Uuid,
    pub chapter_id: Uuid,
    pub document_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub block_id: String,
    pub base: Option<String>,
    pub current: Option<String>,
    pub draft: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub document_json: String,
    pub conflicts: Vec<MergeConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptRevision {
    pub id: Uuid,
    pub chapter_id: Uuid,
    pub parent_revision_id: Option<Uuid>,
    pub base_revision_id: Option<Uuid>,
    pub document_json: String,
    pub content_hash: String,
    pub creation_reason: String,
    pub document_schema_version: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: Uuid,
    pub plan_node_id: Uuid,
    pub title: String,
}

#[derive(Debug, Error)]
pub enum ManuscriptError {
    #[error("no project is open")]
    NoProject,
    #[error("chapter does not exist: {0}")]
    MissingChapter(Uuid),
    #[error("document cannot be empty")]
    EmptyDocument,
    #[error("document schema is invalid: {0}")]
    InvalidDocument(String),
    #[error("manuscript base revision conflict: expected {expected:?}, actual {actual:?}")]
    Conflict {
        expected: Option<Uuid>,
        actual: Option<Uuid>,
    },
    #[error("manuscript database operation failed: {0}")]
    Database(#[from] DatabaseError),
}

pub struct ProjectManager {
    current: Option<ProjectSession>,
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectManager {
    /// Creates a manager without an opened project.
    #[must_use]
    pub const fn new() -> Self {
        Self { current: None }
    }

    /// Creates a project using a temporary directory and atomically completes it.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError`] if the path is invalid, already exists, or any
    /// manifest/database operation fails. Failed creation removes its temporary
    /// directory and leaves no valid project at the requested path.
    pub fn create(
        &mut self,
        root: impl AsRef<Path>,
        name: impl Into<String>,
    ) -> Result<ProjectManifest, ProjectError> {
        let root = root.as_ref().to_path_buf();
        let parent = root
            .parent()
            .ok_or_else(|| ProjectError::InvalidPath(root.clone()))?;
        let file_name = root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ProjectError::InvalidPath(root.clone()))?;
        if root.as_os_str().is_empty() {
            return Err(ProjectError::InvalidPath(root));
        }
        if root.exists() {
            return Err(ProjectError::AlreadyExists(root));
        }
        std::fs::create_dir_all(parent)?;
        let temp_root = parent.join(format!(".{file_name}.creating-{}", Uuid::new_v4()));
        if temp_root.exists() {
            return Err(ProjectError::AlreadyExists(temp_root));
        }
        let result = (|| {
            std::fs::create_dir(&temp_root)?;
            for directory in ["attachments", "snapshots", "recovery", "exports", "temp"] {
                std::fs::create_dir(temp_root.join(directory))?;
            }
            let manifest = ProjectManifest {
                project_id: Uuid::new_v4(),
                format_version: 1,
                name: name.into(),
                created_at: now_timestamp(),
            };
            std::fs::write(
                temp_root.join("project.json"),
                serde_json::to_vec_pretty(&manifest)?,
            )?;
            {
                let _database = Database::open(temp_root.join("project.sqlite"))?;
            }
            std::fs::rename(&temp_root, &root)?;
            let database = Database::open(root.join("project.sqlite"))?;
            let session = ProjectSession {
                root: root.clone(),
                manifest: manifest.clone(),
                database,
            };
            self.current = Some(session);
            Ok(manifest)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&temp_root);
        }
        result
    }

    /// Opens an existing project after validating its manifest and database.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError`] if the project is missing, malformed, or its
    /// database cannot be opened.
    pub fn open(&mut self, root: impl AsRef<Path>) -> Result<ProjectManifest, ProjectError> {
        let root = root.as_ref().to_path_buf();
        let manifest_path = root.join("project.json");
        if !manifest_path.is_file() {
            return Err(ProjectError::NotInitialized(root));
        }
        let manifest: ProjectManifest = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
        let database = Database::open(root.join("project.sqlite"))?;
        let result = manifest.clone();
        self.current = Some(ProjectSession {
            root,
            manifest,
            database,
        });
        Ok(result)
    }

    /// Closes the current project and returns its manifest, if any.
    pub fn close(&mut self) -> Option<ProjectManifest> {
        self.current.take().map(|session| session.manifest)
    }

    /// Returns the currently opened project manifest.
    #[must_use]
    pub fn current(&self) -> Option<&ProjectManifest> {
        self.current.as_ref().map(|session| &session.manifest)
    }

    /// Returns health for the current project database.
    ///
    /// # Errors
    ///
    /// Returns [`ProjectError::NotInitialized`] when no project is open or
    /// [`ProjectError::Database`] when SQLite health cannot be queried.
    pub fn health(&self) -> Result<DatabaseHealth, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        Ok(session.database.health()?)
    }

    pub fn list_plan_nodes(&self) -> Result<Vec<PlanNode>, PlanError> {
        let session = self.current.as_ref().ok_or(PlanError::NoProject)?;
        Ok(session.database.list_plan_nodes()?)
    }

    pub fn create_plan_node(
        &mut self,
        parent_id: Option<Uuid>,
        kind: PlanNodeKind,
        title: String,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        session.database.create_plan_node(parent_id, kind, title)
    }

    pub fn update_plan_node(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        session.database.update_plan_node(id, title, archived)
    }

    pub fn update_plan_node_checked(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() {
            return Err(PlanError::EmptyTitle);
        }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        session
            .database
            .update_plan_node_checked(id, title, archived, expected_version)
    }

    pub fn move_plan_node(
        &mut self,
        id: Uuid,
        parent_id: Option<Uuid>,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        session
            .database
            .move_plan_node(id, parent_id, expected_version)
    }

    pub fn current_manuscript(
        &self,
        chapter_id: Uuid,
    ) -> Result<Option<ManuscriptRevision>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        Ok(session.database.current_manuscript(chapter_id)?)
    }

    pub fn list_manuscript_revisions(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<ManuscriptRevision>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        Ok(session.database.list_manuscript_revisions(chapter_id)?)
    }

    pub fn save_manuscript(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        if document_json.trim().is_empty() {
            return Err(ManuscriptError::EmptyDocument);
        }
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .save_manuscript_checked(chapter_id, None, document_json, creation_reason)
    }

    pub fn save_manuscript_checked(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        if document_json.trim().is_empty() {
            return Err(ManuscriptError::EmptyDocument);
        }
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session.database.save_manuscript_checked(
            chapter_id,
            base_revision_id,
            document_json,
            creation_reason,
        )
    }

    pub fn save_recovery_log(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
    ) -> Result<(), ManuscriptError> {
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .save_recovery_log(chapter_id, document_json)
            .map_err(ManuscriptError::Database)
    }

    pub fn list_recovery_logs(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<RecoveryLog>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .list_recovery_logs(chapter_id)
            .map_err(ManuscriptError::Database)
    }

    pub fn list_all_recovery_logs(&self) -> Result<Vec<RecoveryLog>, ManuscriptError> {
        let session = self.current.as_ref().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .list_all_recovery_logs()
            .map_err(ManuscriptError::Database)
    }

    pub fn clear_recovery_logs(&mut self, chapter_id: Uuid) -> Result<(), ManuscriptError> {
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session
            .database
            .clear_recovery_logs(chapter_id)
            .map_err(ManuscriptError::Database)
    }

    pub fn merge_manuscript(
        &self,
        base: &str,
        current: &str,
        draft: &str,
    ) -> Result<MergeResult, ManuscriptError> {
        merge_documents(base, current, draft)
    }
}

fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    seconds.to_string()
}

fn normalize_document(document_json: &str) -> Result<String, ManuscriptError> {
    let mut value: serde_json::Value = serde_json::from_str(document_json)
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
        return Err(ManuscriptError::InvalidDocument(
            "root type must be doc".to_owned(),
        ));
    }
    let mut counter = 0_u64;
    fn visit(node: &mut serde_json::Value, counter: &mut u64) {
        if let Some(object) = node.as_object_mut() {
            if object.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
                let attrs = object
                    .entry("attrs")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(attrs) = attrs.as_object_mut() {
                    attrs.entry("blockId").or_insert_with(|| {
                        *counter += 1;
                        serde_json::Value::String(format!("block-{counter}"))
                    });
                }
            }
            if let Some(children) = object
                .get_mut("content")
                .and_then(serde_json::Value::as_array_mut)
            {
                for child in children {
                    visit(child, counter);
                }
            }
        }
    }
    visit(&mut value, &mut counter);
    serde_json::to_string(&value)
        .map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))
}

fn validate_document(document_json: &str) -> Result<(), ManuscriptError> {
    let _ = normalize_document(document_json)?;
    Ok(())
}

fn merge_documents(base: &str, current: &str, draft: &str) -> Result<MergeResult, ManuscriptError> {
    let mut base_v: serde_json::Value =
        serde_json::from_str(base).map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let current_v: serde_json::Value = serde_json::from_str(current)
        .map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let draft_v: serde_json::Value =
        serde_json::from_str(draft).map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?;
    let b = base_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let c = current_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let d = draft_v
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let key = |v: &serde_json::Value| {
        v.get("attrs")
            .and_then(|a| a.get("blockId"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_owned()
    };
    let mut conflicts = Vec::new();
    let mut merged = Vec::new();
    for block in d.iter().chain(c.iter()) {
        let id = key(block);
        if merged.iter().any(|x: &serde_json::Value| key(x) == id) {
            continue;
        }
        let bv = b.iter().find(|x| key(x) == id);
        let cv = c.iter().find(|x| key(x) == id);
        let dv = d.iter().find(|x| key(x) == id);
        if cv == bv {
            if let Some(x) = dv {
                merged.push(x.clone());
            }
        } else if dv == bv {
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        } else if cv == dv {
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        } else {
            conflicts.push(MergeConflict {
                block_id: id,
                base: bv.map(ToString::to_string),
                current: cv.map(ToString::to_string),
                draft: dv.map(ToString::to_string),
            });
            if let Some(x) = cv {
                merged.push(x.clone());
            }
        }
    }
    if let Some(obj) = base_v.as_object_mut() {
        obj.insert("content".to_owned(), serde_json::Value::Array(merged));
    }
    Ok(MergeResult {
        document_json: serde_json::to_string(&base_v)
            .map_err(|e| ManuscriptError::InvalidDocument(e.to_string()))?,
        conflicts,
    })
}

/// Returns the ordered layers linked into the infrastructure boundary.
#[must_use]
pub fn linked_layers() -> [&'static str; 3] {
    let [domain, application] = novel_application::linked_layers();
    [domain, application, "infrastructure"]
}

#[cfg(test)]
mod tests {
    use super::{Database, R4_CONTRACTS, R4_MIGRATION_PLAN, R4_SCHEMA_VERSION};

    #[test]
    fn infrastructure_depends_inward() {
        assert_eq!(
            super::linked_layers(),
            ["domain", "application", "infrastructure"]
        );
    }

    #[test]
    fn sqlite_applies_pragmas_and_initial_migration() {
        let database = Database::in_memory().expect("in-memory database");
        let health = database.health().expect("database health");
        assert_eq!(health.schema_version, R4_SCHEMA_VERSION);
        assert_eq!(health.journal_mode, "memory");
        assert!(health.foreign_keys_enabled);
        assert!(!health.sqlite_version.is_empty());
    }

    #[test]
    fn r4_baseline_exposes_ordered_migration_and_contract_plans() {
        assert_eq!(R4_MIGRATION_PLAN.first().map(|item| item.version), Some(10));
        assert!(
            R4_MIGRATION_PLAN
                .windows(2)
                .all(|pair| pair[0].version < pair[1].version)
        );
        assert_eq!(R4_MIGRATION_PLAN.last().map(|item| item.version), Some(15));
        assert!(
            R4_CONTRACTS
                .iter()
                .any(|item| item.id == "story_bible_entities")
        );
        assert!(R4_CONTRACTS.iter().all(|item| item.introduced_by >= 10));
    }

    #[test]
    fn r4_project_settings_baseline_is_created_with_safe_defaults() {
        let database = Database::in_memory().expect("in-memory database");
        let settings: (String, String, String) = database
            .connection
            .query_row(
                "SELECT writing_style, privacy_level, metadata_json FROM project_settings WHERE project_id='current'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("project settings baseline");
        assert_eq!(settings.0, "");
        assert_eq!(settings.1, "LOCAL_ONLY");
        assert_eq!(settings.2, "{}");
    }

    #[test]
    fn story_bible_entities_are_versioned_and_archivable() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-entities-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        let manifest = manager.create(&root, "实体测试").expect("create project");
        let created = manager
            .upsert_entity(super::EntityInput {
                id: None,
                entity_type: super::EntityType::Character,
                name: "林澈".to_owned(),
                aliases: vec!["阿澈".to_owned()],
                description: "主角".to_owned(),
                fixed_attributes_json: "{\"age\":18}".to_owned(),
                tags: vec!["主角".to_owned()],
                base_revision_id: None,
                source_version: Some("manuscript:1".to_owned()),
                expected_version: None,
            })
            .expect("create entity");
        assert_eq!(created.project_id, manifest.project_id);
        assert_eq!(created.version, 1);
        let revisions = manager
            .list_entity_revisions(created.id)
            .expect("list revisions");
        assert_eq!(revisions.len(), 1);
        assert_eq!(revisions[0].aliases, vec!["阿澈"]);

        let updated = manager
            .upsert_entity(super::EntityInput {
                id: Some(created.id),
                entity_type: super::EntityType::Character,
                name: "林澈（修订）".to_owned(),
                aliases: vec![],
                description: "主角，已成长".to_owned(),
                fixed_attributes_json: "{}".to_owned(),
                tags: vec!["主角".to_owned(), "成长".to_owned()],
                base_revision_id: Some(created.current_revision_id),
                source_version: Some("manuscript:2".to_owned()),
                expected_version: Some(1),
            })
            .expect("update entity");
        assert_eq!(updated.version, 2);
        assert_eq!(
            manager
                .list_entity_revisions(created.id)
                .expect("revisions")
                .len(),
            2
        );
        assert!(matches!(
            manager.upsert_entity(super::EntityInput {
                id: Some(created.id),
                entity_type: super::EntityType::Character,
                name: "过期修改".to_owned(),
                aliases: vec![],
                description: String::new(),
                fixed_attributes_json: "{}".to_owned(),
                tags: vec![],
                base_revision_id: None,
                source_version: None,
                expected_version: Some(1),
            }),
            Err(super::EntityStoreError::Contract(
                super::EntityError::Conflict { actual: 2, .. }
            ))
        ));
        let archived = manager
            .set_entity_archived(created.id, true, 2)
            .expect("archive entity");
        assert_eq!(
            archived.lifecycle_status,
            super::EntityLifecycleStatus::Archived
        );
        assert!(
            manager
                .list_entities(false)
                .expect("active entities")
                .is_empty()
        );
        assert_eq!(manager.list_entities(true).expect("all entities").len(), 1);
        let session = manager.current.as_ref().expect("session");
        assert!(
            session
                .database
                .connection
                .execute(
                    "DELETE FROM entity_revisions WHERE id = ?1",
                    [created.current_revision_id.to_string()],
                )
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_creation_is_complete_and_reopenable() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-project-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        let manifest = manager.create(&root, "测试作品").expect("create project");
        assert_eq!(manifest.name, "测试作品");
        assert!(root.join("project.json").is_file());
        assert!(root.join("project.sqlite").is_file());
        assert!(root.join("attachments").is_dir());
        assert!(manager.health().is_ok());
        assert_eq!(manager.close(), Some(manifest.clone()));
        let reopened = manager.open(&root).expect("reopen project");
        assert_eq!(reopened, manifest);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manuscript_documents_are_validated_normalized_and_hashed() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-manuscript-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "测试作品").expect("create project");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let revision = manager.save_manuscript(chapter.id, r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"你好"}]}]}"#.into(), "test".into()).expect("save");
        assert_eq!(revision.document_schema_version, 1);
        assert!(revision.document_json.contains("blockId"));
        assert_eq!(revision.content_hash.len(), 64);
        assert!(
            manager
                .save_manuscript(chapter.id, "not-json".into(), "test".into())
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_creation_does_not_leave_project_directory() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-project-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        let _ = manager.create(&root, "测试作品").expect("first create");
        assert!(matches!(
            manager.create(&root, "重复作品"),
            Err(super::ProjectError::AlreadyExists(path)) if path == root
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plan_nodes_can_be_created_and_listed() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-plan-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "测试作品").expect("create project");
        let outline = manager
            .create_plan_node(None, super::PlanNodeKind::Outline, "故事总纲".to_owned())
            .expect("create outline");
        let chapter = manager
            .create_plan_node(
                Some(outline.id),
                super::PlanNodeKind::Chapter,
                "第一章".to_owned(),
            )
            .expect("create chapter");
        let nodes = manager.list_plan_nodes().expect("list plan nodes");
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().any(|node| node.parent_id == Some(outline.id)));
        assert_eq!(chapter.revision, 1);
        let updated = manager
            .update_plan_node(chapter.id, "第一章（修订）".to_owned(), true)
            .expect("archive chapter");
        assert_eq!(updated.revision, 2);
        assert!(updated.archived);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_plan_hierarchy_and_stale_updates_are_rejected() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-rules-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "规则测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        assert!(matches!(
            manager.create_plan_node(
                Some(chapter.id),
                super::PlanNodeKind::Volume,
                "非法分卷".into()
            ),
            Err(super::PlanError::InvalidParentKind)
        ));
        manager
            .update_plan_node_checked(chapter.id, "第一章修订".into(), false, 1)
            .expect("checked update");
        assert!(matches!(
            manager.update_plan_node_checked(chapter.id, "过期修改".into(), false, 1),
            Err(super::PlanError::Conflict { .. })
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manuscript_history_is_immutable_and_conflicts_are_detected() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-immutable-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "正文测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"p1"},"content":[{"type":"text","text":"正文"}]}]}"#;
        let first = manager
            .save_manuscript_checked(chapter.id, None, doc.into(), "FIRST".into())
            .expect("first");
        let second = manager
            .save_manuscript_checked(chapter.id, Some(first.id), doc.into(), "SECOND".into())
            .expect("second");
        assert!(
            matches!(manager.save_manuscript_checked(chapter.id, Some(first.id), doc.into(), "STALE".into()), Err(super::ManuscriptError::Conflict { actual: Some(actual), .. }) if actual == second.id)
        );
        let session = manager.current.as_ref().expect("session");
        assert!(
            session
                .database
                .connection
                .execute(
                    "UPDATE manuscript_revisions SET creation_reason = 'BAD' WHERE id = ?1",
                    [first.id.to_string()]
                )
                .is_err()
        );
        assert!(
            session
                .database
                .connection
                .execute(
                    "DELETE FROM manuscript_revisions WHERE id = ?1",
                    [first.id.to_string()]
                )
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_logs_survive_project_reopen() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-recovery-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "恢复测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let doc = r#"{"type":"doc","content":[]}"#;
        manager
            .save_recovery_log(chapter.id, doc.into())
            .expect("save recovery");
        manager.close();
        manager.open(&root).expect("reopen");
        assert_eq!(manager.list_all_recovery_logs().expect("logs").len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ai_proposals_are_audited_without_changing_manuscript_history() {
        let root =
            std::path::PathBuf::from("target").join(format!("ainovel-ai-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "AI 测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let profile = manager
            .upsert_model_profile(super::ModelProfileInput {
                id: None,
                name: "DeepSeek".into(),
                provider: super::ModelProvider::DeepSeek,
                capability: super::ModelCapability::Chat,
                base_url: "https://api.deepseek.com".into(),
                model_id: "deepseek-chat".into(),
                context_window: 8_192,
                max_output_tokens: 1_024,
                privacy_level: super::PrivacyLevel::AllowCloud,
                timeout_seconds: 30,
                retry_limit: 1,
            })
            .expect("profile");
        assert!(!profile.has_secret);
        let context = novel_application::ContextAssembler::assemble(
            &novel_application::AssembleContextInput {
                chapter_id: chapter.id,
                target_revision_id: None,
                action: super::AiAction::Continue,
                chapter_title: chapter.title,
                chapter_plan: "继续推进冲突".into(),
                document_json: r#"{"type":"doc","content":[]}"#.into(),
                selection: None,
                instruction: None,
                input_token_budget: 4_096,
            },
        )
        .expect("context");
        let task_id = manager.create_ai_task(profile.id, &context).expect("task");
        let session = manager.current.as_ref().expect("session");
        let (task_contract_json, context_section_audit_json): (String, String) = session
            .database
            .connection
            .query_row(
                "SELECT task_contract_json, context_section_audit_json FROM ai_tasks WHERE id=?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("task audit metadata");
        assert!(task_contract_json.contains("DRAFT_WRITER"));
        assert!(context_section_audit_json.contains("CURRENT_DRAFT"));
        assert!(!task_contract_json.contains("继续推进冲突"));
        assert!(!context_section_audit_json.contains("继续推进冲突"));
        let proposal = manager
            .complete_ai_task(task_id, &context, "新的段落。".into())
            .expect("proposal");
        assert_eq!(proposal.status, super::AiProposalStatus::Pending);
        manager
            .decide_ai_proposal(proposal.id, super::AiProposalStatus::Accepted, None)
            .expect("accept");
        assert!(
            manager
                .current_manuscript(chapter.id)
                .expect("manuscript")
                .is_none()
        );
        let session = manager.current.as_ref().expect("session");
        assert!(
            session
                .database
                .connection
                .execute(
                    "UPDATE ai_proposals SET output_text='tampered' WHERE id=?1",
                    [proposal.id.to_string()],
                )
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_ai_tasks_do_not_create_proposals() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-ai-fail-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "AI 失败测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let profile = manager
            .upsert_model_profile(super::ModelProfileInput {
                id: None,
                name: "云端".into(),
                provider: super::ModelProvider::OpenAiCompatible,
                capability: super::ModelCapability::Chat,
                base_url: "https://api.example.com/v1".into(),
                model_id: "model".into(),
                context_window: 4096,
                max_output_tokens: 512,
                privacy_level: super::PrivacyLevel::AllowCloud,
                timeout_seconds: 30,
                retry_limit: 0,
            })
            .expect("profile");
        let context = novel_application::ContextAssembler::assemble(
            &novel_application::AssembleContextInput {
                chapter_id: chapter.id,
                target_revision_id: None,
                action: super::AiAction::Summarize,
                chapter_title: "第一章".into(),
                chapter_plan: String::new(),
                document_json: r#"{"type":"doc","content":[]}"#.into(),
                selection: None,
                instruction: None,
                input_token_budget: 2048,
            },
        )
        .expect("context");
        let task_id = manager.create_ai_task(profile.id, &context).expect("task");
        manager
            .fail_ai_task(task_id, &super::AiError::Timeout)
            .expect("fail");
        assert!(
            manager
                .list_ai_proposals(chapter.id)
                .expect("proposals")
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn embedding_profiles_cannot_create_writing_tasks() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-embedding-role-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "Embedding 角色测试").expect("create");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        let profile = manager
            .upsert_model_profile(super::ModelProfileInput {
                id: None,
                name: "硅基流动 Embedding".into(),
                provider: super::ModelProvider::SiliconFlow,
                capability: super::ModelCapability::Embedding,
                base_url: "https://api.siliconflow.cn/v1".into(),
                model_id: "embedding-model".into(),
                context_window: 4096,
                max_output_tokens: 512,
                privacy_level: super::PrivacyLevel::AllowCloud,
                timeout_seconds: 30,
                retry_limit: 0,
            })
            .expect("profile");
        let context = novel_application::ContextAssembler::assemble(
            &novel_application::AssembleContextInput {
                chapter_id: chapter.id,
                target_revision_id: None,
                action: super::AiAction::Continue,
                chapter_title: "第一章".into(),
                chapter_plan: String::new(),
                document_json: r#"{"type":"doc","content":[]}"#.into(),
                selection: None,
                instruction: None,
                input_token_budget: 2048,
            },
        )
        .expect("context");
        assert!(matches!(
            manager.create_ai_task(profile.id, &context),
            Err(super::AiError::Contract(
                novel_domain::AiContractError::InvalidProviderCapability
            ))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_manifest_and_database_are_rejected() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("dir");
        std::fs::write(root.join("project.json"), b"not-json").expect("manifest");
        let mut manager = super::ProjectManager::new();
        assert!(matches!(
            manager.open(&root),
            Err(super::ProjectError::Manifest(_))
        ));
        std::fs::write(
            root.join("project.json"),
            serde_json::to_vec(&super::ProjectManifest {
                project_id: uuid::Uuid::new_v4(),
                format_version: 1,
                name: "损坏项目".into(),
                created_at: "0".into(),
            })
            .expect("json"),
        )
        .expect("manifest");
        std::fs::write(root.join("project.sqlite"), b"not-sqlite").expect("database");
        assert!(matches!(
            manager.open(&root),
            Err(super::ProjectError::Database(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
