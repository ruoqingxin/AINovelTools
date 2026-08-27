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
pub use ai::{AiError, EmbeddingGateway, ModelGateway, SecretStore};
pub use novel_domain::{
    AiAction, AiProposal, AiProposalStatus, AiTaskStatus, ModelCapability, ModelProfile,
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

impl Database {
    /// Opens or creates a SQLite database at `path` and applies the schema.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when the directory, SQLite connection, or
    /// migration cannot be initialized.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| DatabaseError::MissingParent(path.to_path_buf()))?;
        } else {
            return Err(DatabaseError::MissingParent(path.to_path_buf()));
        }
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    /// Creates an isolated in-memory SQLite database for app bootstrap and tests.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when SQLite cannot initialize or migrate the
    /// connection.
    pub fn in_memory() -> Result<Self, DatabaseError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, DatabaseError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5000)?;
        let database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> Result<(), DatabaseError> {
        self.connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
            )
            .map_err(DatabaseError::from)?;
        let applied: Option<i64> =
            self.connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })?;
        if applied.unwrap_or(0) < 1 {
            self.connection.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_core')",
                [],
            )?;
        }
        if applied.unwrap_or(0) < 2 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_nodes (
                    id TEXT PRIMARY KEY NOT NULL,
                    parent_id TEXT REFERENCES plan_nodes(id),
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_plan_nodes_parent_order
                    ON plan_nodes(parent_id, sort_order, created_at);
                INSERT INTO schema_migrations (version, name) VALUES (2, 'plan_nodes');",
            )?;
        }
        if applied.unwrap_or(0) < 3 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_node_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    node_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    revision INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(node_id, revision)
                );
                INSERT INTO schema_migrations (version, name) VALUES (3, 'plan_node_revisions');",
            )?;
        }
        if applied.unwrap_or(0) < 4 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS manuscript_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    parent_revision_id TEXT REFERENCES manuscript_revisions(id),
                    document_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    creation_reason TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    document_schema_version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_manuscript_revisions_chapter
                    ON manuscript_revisions(chapter_id, created_at);
                INSERT INTO schema_migrations (version, name) VALUES (4, 'manuscript_revisions');",
            )?;
        }
        if applied.unwrap_or(0) < 5 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS plan_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    node_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    revision INTEGER NOT NULL,
                    parent_revision_id TEXT REFERENCES plan_revisions(id),
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(node_id, revision)
                );
                CREATE TABLE IF NOT EXISTS recovery_logs (
                    id TEXT PRIMARY KEY NOT NULL,
                    chapter_id TEXT NOT NULL REFERENCES plan_nodes(id),
                    document_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TRIGGER IF NOT EXISTS prevent_manuscript_revision_update
                    BEFORE UPDATE ON manuscript_revisions BEGIN SELECT RAISE(ABORT, 'immutable manuscript revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_manuscript_revision_delete
                    BEFORE DELETE ON manuscript_revisions BEGIN SELECT RAISE(ABORT, 'immutable manuscript revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_plan_revision_update
                    BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'immutable plan revision'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_plan_revision_delete
                    BEFORE DELETE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'immutable plan revision'); END;
                INSERT INTO schema_migrations (version, name) VALUES (5, 'immutable_revisions_and_recovery');",
            )?;
        }
        if applied.unwrap_or(0) < 6 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS chapters (
                    id TEXT PRIMARY KEY NOT NULL,
                    plan_node_id TEXT NOT NULL UNIQUE REFERENCES plan_nodes(id),
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                INSERT OR IGNORE INTO chapters (id, plan_node_id, title)
                    SELECT id, id, title FROM plan_nodes WHERE kind = 'CHAPTER';
                INSERT INTO schema_migrations (version, name) VALUES (6, 'separate_chapter_entities');",
            )?;
        }
        if applied.unwrap_or(0) < 7 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS model_profiles (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    context_window INTEGER NOT NULL,
                    max_output_tokens INTEGER NOT NULL,
                    privacy_level TEXT NOT NULL,
                    timeout_seconds INTEGER NOT NULL,
                    retry_limit INTEGER NOT NULL,
                    secret_ref TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE TABLE IF NOT EXISTS ai_tasks (
                    id TEXT PRIMARY KEY NOT NULL,
                    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    action TEXT NOT NULL,
                    target_revision_id TEXT REFERENCES manuscript_revisions(id),
                    context_version TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    finished_at TEXT
                );
                CREATE TABLE IF NOT EXISTS ai_proposals (
                    id TEXT PRIMARY KEY NOT NULL,
                    task_id TEXT NOT NULL UNIQUE REFERENCES ai_tasks(id),
                    chapter_id TEXT NOT NULL REFERENCES chapters(id),
                    action TEXT NOT NULL,
                    target_revision_id TEXT REFERENCES manuscript_revisions(id),
                    context_version TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    output_text TEXT NOT NULL,
                    accepted_text TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    decided_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_ai_proposals_chapter_created
                    ON ai_proposals(chapter_id, created_at DESC);
                CREATE TRIGGER IF NOT EXISTS prevent_ai_proposal_identity_update
                    BEFORE UPDATE OF task_id, chapter_id, action, target_revision_id, context_version, prompt_version, output_text, created_at
                    ON ai_proposals BEGIN SELECT RAISE(ABORT, 'immutable ai proposal identity'); END;
                CREATE TRIGGER IF NOT EXISTS prevent_ai_proposal_delete
                    BEFORE DELETE ON ai_proposals BEGIN SELECT RAISE(ABORT, 'immutable ai proposal'); END;
                INSERT INTO schema_migrations (version, name) VALUES (7, 'r3_ai_creation_loop');",
            )?;
        }
        if applied.unwrap_or(0) < 8 {
            self.connection.execute_batch(
                "ALTER TABLE model_profiles ADD COLUMN capability TEXT NOT NULL DEFAULT 'CHAT';
                UPDATE model_profiles SET capability = 'EMBEDDING' WHERE provider = 'SILICON_FLOW';
                INSERT INTO schema_migrations (version, name) VALUES (8, 'model_capabilities');",
            )?;
        }
        if applied.unwrap_or(0) < 9 {
            self.connection.execute_batch(
                "ALTER TABLE ai_tasks ADD COLUMN task_contract_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(task_contract_json));
                ALTER TABLE ai_tasks ADD COLUMN context_section_audit_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context_section_audit_json));
                INSERT INTO schema_migrations (version, name) VALUES (9, 'ai_task_contract_audit');",
            )?;
        }
        Ok(())
    }

    fn list_plan_nodes(&self) -> Result<Vec<PlanNode>, DatabaseError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, parent_id, kind, title, sort_order, archived, revision
             FROM plan_nodes ORDER BY COALESCE(parent_id, ''), sort_order, created_at",
            )
            .map_err(DatabaseError::from)?;
        let rows = statement.query_map([], |row| {
            let kind = match row.get::<_, String>(2)?.as_str() {
                "WORK_DESIGN" => PlanNodeKind::WorkDesign,
                "OUTLINE" => PlanNodeKind::Outline,
                "VOLUME" => PlanNodeKind::Volume,
                "CHAPTER" => PlanNodeKind::Chapter,
                "SCENE" => PlanNodeKind::Scene,
                _ => PlanNodeKind::Outline,
            };
            let id = Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let parent_id = row
                .get::<_, Option<String>>(1)?
                .map(|value| {
                    Uuid::parse_str(&value).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            Ok(PlanNode {
                id,
                parent_id,
                kind,
                title: row.get(3)?,
                sort_order: row.get(4)?,
                archived: row.get::<_, i64>(5)? == 1,
                revision: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    fn create_plan_node(
        &mut self,
        parent_id: Option<Uuid>,
        kind: PlanNodeKind,
        title: String,
    ) -> Result<PlanNode, PlanError> {
        if let Some(parent) = parent_id {
            let parent_kind: Option<String> = self
                .connection
                .query_row(
                    "SELECT kind FROM plan_nodes WHERE id = ?1 AND archived = 0",
                    [parent.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DatabaseError::from)?;
            let parent_kind = parent_kind.ok_or(PlanError::MissingParent(parent))?;
            let valid = matches!(
                (parent_kind.as_str(), kind),
                ("WORK_DESIGN", PlanNodeKind::Outline)
                    | ("OUTLINE", PlanNodeKind::Volume | PlanNodeKind::Chapter)
                    | ("VOLUME", PlanNodeKind::Chapter)
                    | ("CHAPTER", PlanNodeKind::Scene)
            );
            if !valid {
                return Err(PlanError::InvalidParentKind);
            }
        }
        let sort_order: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE parent_id IS ?1",
                rusqlite::params![parent_id.map(|id| id.to_string())],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        let node = PlanNode {
            id: Uuid::new_v4(),
            parent_id,
            kind,
            title,
            sort_order,
            archived: false,
            revision: 1,
        };
        self.connection
            .execute(
                "INSERT INTO plan_nodes (id, parent_id, kind, title, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    node.id.to_string(),
                    node.parent_id.map(|id| id.to_string()),
                    node.kind.as_str(),
                    node.title,
                    node.sort_order
                ],
            )
            .map_err(DatabaseError::from)?;
        if node.kind == PlanNodeKind::Chapter {
            self.connection
                .execute(
                    "INSERT INTO chapters (id, plan_node_id, title) VALUES (?1, ?1, ?2)",
                    rusqlite::params![node.id.to_string(), node.title],
                )
                .map_err(DatabaseError::from)?;
        }
        self.connection.execute(
            "INSERT INTO plan_revisions (id, node_id, revision, title, archived) VALUES (?1, ?2, 1, ?3, 0)",
            rusqlite::params![Uuid::new_v4().to_string(), node.id.to_string(), node.title],
        ).map_err(DatabaseError::from)?;
        self.connection
            .execute(
                "INSERT INTO plan_node_revisions (id, node_id, revision, title, archived)
             VALUES (?1, ?2, 1, ?3, 0)",
                rusqlite::params![Uuid::new_v4().to_string(), node.id.to_string(), node.title],
            )
            .map_err(DatabaseError::from)?;
        Ok(node)
    }

    fn update_plan_node(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        let revision = current.revision + 1;
        self.connection
            .execute(
                "UPDATE plan_nodes SET title = ?1, archived = ?2, revision = ?3 WHERE id = ?4",
                rusqlite::params![title, i64::from(archived), revision, id.to_string()],
            )
            .map_err(DatabaseError::from)?;
        if archived {
            self.connection
                .execute(
                    "UPDATE plan_nodes SET archived = 1 WHERE parent_id = ?1",
                    [id.to_string()],
                )
                .map_err(DatabaseError::from)?;
        }
        self.connection
            .execute(
                "INSERT INTO plan_node_revisions (id, node_id, revision, title, archived)
             VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    id.to_string(),
                    revision,
                    title,
                    i64::from(archived)
                ],
            )
            .map_err(DatabaseError::from)?;
        self.connection.execute(
            "INSERT INTO plan_revisions (id, node_id, revision, parent_revision_id, title, archived) SELECT ?1, ?2, ?3, id, ?4, ?5 FROM plan_revisions WHERE node_id = ?2 ORDER BY revision DESC LIMIT 1",
            rusqlite::params![Uuid::new_v4().to_string(), id.to_string(), revision, title, i64::from(archived)],
        ).map_err(DatabaseError::from)?;
        Ok(PlanNode {
            title,
            archived,
            revision,
            ..current
        })
    }

    fn update_plan_node_checked(
        &mut self,
        id: Uuid,
        title: String,
        archived: bool,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        if current.revision != expected_version {
            return Err(PlanError::Conflict {
                expected: expected_version,
                actual: current.revision,
            });
        }
        self.update_plan_node(id, title, archived)
    }

    fn move_plan_node(
        &mut self,
        id: Uuid,
        parent_id: Option<Uuid>,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let current = self
            .list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))?;
        if current.revision != expected_version {
            return Err(PlanError::Conflict {
                expected: expected_version,
                actual: current.revision,
            });
        }
        if parent_id == Some(id) {
            return Err(PlanError::Cycle);
        }
        if let Some(parent) = parent_id {
            let parent_node = self
                .list_plan_nodes()?
                .into_iter()
                .find(|node| node.id == parent)
                .ok_or(PlanError::MissingParent(parent))?;
            let valid = matches!(
                (parent_node.kind, current.kind),
                (PlanNodeKind::WorkDesign, PlanNodeKind::Outline)
                    | (
                        PlanNodeKind::Outline,
                        PlanNodeKind::Volume | PlanNodeKind::Chapter
                    )
                    | (PlanNodeKind::Volume, PlanNodeKind::Chapter)
                    | (PlanNodeKind::Chapter, PlanNodeKind::Scene)
            );
            if !valid {
                return Err(PlanError::InvalidParentKind);
            }
            let mut cursor = Some(parent);
            while let Some(candidate) = cursor {
                if candidate == id {
                    return Err(PlanError::Cycle);
                }
                cursor = self
                    .list_plan_nodes()?
                    .into_iter()
                    .find(|node| node.id == candidate)
                    .and_then(|node| node.parent_id);
            }
        }
        let sort_order: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM plan_nodes WHERE parent_id IS ?1",
                rusqlite::params![parent_id.map(|id| id.to_string())],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        self.connection.execute("UPDATE plan_nodes SET parent_id = ?1, sort_order = ?2, revision = revision + 1 WHERE id = ?3", rusqlite::params![parent_id.map(|id| id.to_string()), sort_order, id.to_string()]).map_err(DatabaseError::from)?;
        self.list_plan_nodes()?
            .into_iter()
            .find(|node| node.id == id)
            .ok_or(PlanError::MissingNode(id))
    }

    fn current_manuscript(
        &self,
        chapter_id: Uuid,
    ) -> Result<Option<ManuscriptRevision>, DatabaseError> {
        self.connection
            .query_row(
                "SELECT id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version, created_at
                 FROM manuscript_revisions WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [chapter_id.to_string()],
                |row| {
                    Ok(ManuscriptRevision {
                        id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        chapter_id,
                        parent_revision_id: row
                            .get::<_, Option<String>>(1)?
                            .map(|value| {
                                Uuid::parse_str(&value).map_err(|error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        1,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                })
                            })
                            .transpose()?,
                        base_revision_id: row
                            .get::<_, Option<String>>(1)?
                            .map(|value| Uuid::parse_str(&value).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))))
                            .transpose()?,
                        document_json: row.get(2)?,
                        content_hash: row.get(3)?,
                        creation_reason: row.get(4)?,
                        document_schema_version: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(DatabaseError::from)
    }

    fn list_manuscript_revisions(
        &self,
        chapter_id: Uuid,
    ) -> Result<Vec<ManuscriptRevision>, DatabaseError> {
        let mut statement = self.connection.prepare(
            "SELECT id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version, created_at
             FROM manuscript_revisions WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([chapter_id.to_string()], |row| {
            Ok(ManuscriptRevision {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                chapter_id,
                parent_revision_id: row
                    .get::<_, Option<String>>(1)?
                    .map(|value| {
                        Uuid::parse_str(&value).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?,
                base_revision_id: row
                    .get::<_, Option<String>>(1)?
                    .map(|value| {
                        Uuid::parse_str(&value).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                1,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?,
                document_json: row.get(2)?,
                content_hash: row.get(3)?,
                creation_reason: row.get(4)?,
                document_schema_version: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    fn save_manuscript_checked(
        &mut self,
        chapter_id: Uuid,
        base_revision_id: Option<Uuid>,
        mut document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        document_json = normalize_document(&document_json)?;
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chapters WHERE id = ?1)",
                [chapter_id.to_string()],
                |row| row.get(0),
            )
            .map_err(DatabaseError::from)?;
        if !exists {
            return Err(ManuscriptError::MissingChapter(chapter_id));
        }
        let parent_revision_id = self
            .current_manuscript(chapter_id)?
            .map(|revision| revision.id);
        if let Some(expected) = base_revision_id {
            if Some(expected) != parent_revision_id {
                return Err(ManuscriptError::Conflict {
                    expected: Some(expected),
                    actual: parent_revision_id,
                });
            }
        }
        let mut hasher = Sha256::new();
        hasher.update(document_json.as_bytes());
        let revision = ManuscriptRevision {
            id: Uuid::new_v4(),
            chapter_id,
            parent_revision_id,
            base_revision_id: parent_revision_id,
            content_hash: format!("{:x}", hasher.finalize()),
            document_json,
            creation_reason,
            document_schema_version: 1,
            created_at: now_timestamp(),
        };
        self.connection.execute(
            "INSERT INTO manuscript_revisions (id, chapter_id, parent_revision_id, document_json, content_hash, creation_reason, document_schema_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![revision.id.to_string(), revision.chapter_id.to_string(), revision.parent_revision_id.map(|id| id.to_string()), revision.document_json, revision.content_hash, revision.creation_reason, revision.document_schema_version],
        ).map_err(DatabaseError::from)?;
        Ok(revision)
    }

    fn save_recovery_log(
        &mut self,
        chapter_id: Uuid,
        document_json: String,
    ) -> Result<(), DatabaseError> {
        validate_document(&document_json).map_err(|e| {
            DatabaseError::Sqlite(rusqlite::Error::InvalidParameterName(e.to_string()))
        })?;
        self.connection.execute(
            "INSERT INTO recovery_logs (id, chapter_id, document_json) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                chapter_id.to_string(),
                document_json
            ],
        )?;
        Ok(())
    }

    fn list_recovery_logs(&self, chapter_id: Uuid) -> Result<Vec<RecoveryLog>, DatabaseError> {
        let mut statement = self.connection.prepare("SELECT id, chapter_id, document_json, created_at FROM recovery_logs WHERE chapter_id = ?1 ORDER BY created_at DESC, rowid DESC")?;
        let rows = statement.query_map([chapter_id.to_string()], |row| {
            Ok(RecoveryLog {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                chapter_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                document_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    fn list_all_recovery_logs(&self) -> Result<Vec<RecoveryLog>, DatabaseError> {
        let mut statement = self.connection.prepare("SELECT id, chapter_id, document_json, created_at FROM recovery_logs ORDER BY created_at DESC, rowid DESC")?;
        let rows = statement.query_map([], |row| {
            Ok(RecoveryLog {
                id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                chapter_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                document_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    fn clear_recovery_logs(&mut self, chapter_id: Uuid) -> Result<(), DatabaseError> {
        self.connection.execute(
            "DELETE FROM recovery_logs WHERE chapter_id = ?1",
            [chapter_id.to_string()],
        )?;
        Ok(())
    }

    /// Reads the SQLite and migration state used by the desktop health query.
    ///
    /// # Errors
    ///
    /// Returns [`DatabaseError`] when a health query cannot be executed.
    pub fn health(&self) -> Result<DatabaseHealth, DatabaseError> {
        let sqlite_version = self
            .connection
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let schema_version = self.connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        let journal_mode = self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        let foreign_keys_enabled = self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?
            == 1;
        Ok(DatabaseHealth {
            sqlite_version,
            schema_version,
            journal_mode,
            foreign_keys_enabled,
        })
    }
}

/// Returns the ordered layers linked into the infrastructure boundary.
#[must_use]
pub fn linked_layers() -> [&'static str; 3] {
    let [domain, application] = novel_application::linked_layers();
    [domain, application, "infrastructure"]
}

#[cfg(test)]
mod tests {
    use super::Database;

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
        assert_eq!(health.schema_version, 9);
        assert_eq!(health.journal_mode, "memory");
        assert!(health.foreign_keys_enabled);
        assert!(!health.sqlite_version.is_empty());
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
