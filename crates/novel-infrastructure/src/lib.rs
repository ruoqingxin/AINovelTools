//! Adapters for persistence, files, model providers, and operating-system APIs.

#![allow(clippy::missing_errors_doc, clippy::items_after_statements, clippy::match_same_arms, clippy::needless_pass_by_value)]

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

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
pub enum FeatureStatus { Implemented, Partial, Declared, Disabled }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDescriptor { pub id: &'static str, pub status: FeatureStatus }

pub const FEATURE_CATALOG: &[FeatureDescriptor] = &[
    FeatureDescriptor { id: "project_management", status: FeatureStatus::Implemented },
    FeatureDescriptor { id: "plan_revisions", status: FeatureStatus::Partial },
    FeatureDescriptor { id: "manuscript_revisions", status: FeatureStatus::Partial },
    FeatureDescriptor { id: "recovery_log", status: FeatureStatus::Partial },
    FeatureDescriptor { id: "conflict_merge", status: FeatureStatus::Declared },
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
    #[error("plan database operation failed: {0}")]
    Database(#[from] DatabaseError),
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
    Conflict { expected: Option<Uuid>, actual: Option<Uuid> },
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

    pub fn update_plan_node_checked(&mut self, id: Uuid, title: String, archived: bool, expected_version: i64) -> Result<PlanNode, PlanError> {
        if title.trim().is_empty() { return Err(PlanError::EmptyTitle); }
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        session.database.update_plan_node_checked(id, title, archived, expected_version)
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
            .save_manuscript(chapter_id, document_json, creation_reason)
    }

    pub fn save_recovery_log(&mut self, chapter_id: Uuid, document_json: String) -> Result<(), ManuscriptError> {
        let session = self.current.as_mut().ok_or(ManuscriptError::NoProject)?;
        session.database.save_recovery_log(chapter_id, document_json).map_err(ManuscriptError::Database)
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
        return Err(ManuscriptError::InvalidDocument("root type must be doc".to_owned()));
    }
    let mut counter = 0_u64;
    fn visit(node: &mut serde_json::Value, counter: &mut u64) {
        if let Some(object) = node.as_object_mut() {
            if object.get("type").and_then(serde_json::Value::as_str) != Some("doc") {
                let attrs = object.entry("attrs").or_insert_with(|| serde_json::json!({}));
                if let Some(attrs) = attrs.as_object_mut() {
                    attrs.entry("blockId").or_insert_with(|| {
                        *counter += 1;
                        serde_json::Value::String(format!("block-{counter}"))
                    });
                }
            }
            if let Some(children) = object.get_mut("content").and_then(serde_json::Value::as_array_mut) {
                for child in children { visit(child, counter); }
            }
        }
    }
    visit(&mut value, &mut counter);
    serde_json::to_string(&value).map_err(|error| ManuscriptError::InvalidDocument(error.to_string()))
}

fn validate_document(document_json: &str) -> Result<(), ManuscriptError> {
    let _ = normalize_document(document_json)?;
    Ok(())
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
                INSERT INTO schema_migrations (version, name) VALUES (5, 'immutable_revisions_and_recovery');",
            )?;
        }
        Ok(())
    }

    fn list_plan_nodes(&self) -> Result<Vec<PlanNode>, DatabaseError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, parent_id, kind, title, sort_order, archived, revision
             FROM plan_nodes ORDER BY sort_order, created_at",
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
            let exists: bool = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM plan_nodes WHERE id = ?1 AND archived = 0)",
                    [parent.to_string()],
                    |row| row.get(0),
                )
                .map_err(DatabaseError::from)?;
            if !exists {
                return Err(PlanError::MissingParent(parent));
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
        Ok(PlanNode {
            title,
            archived,
            revision,
            ..current
        })
    }

    fn update_plan_node_checked(&mut self, id: Uuid, title: String, archived: bool, expected_version: i64) -> Result<PlanNode, PlanError> {
        let current = self.list_plan_nodes()?.into_iter().find(|node| node.id == id).ok_or(PlanError::MissingNode(id))?;
        if current.revision != expected_version { return Err(PlanError::Conflict { expected: expected_version, actual: current.revision }); }
        self.update_plan_node(id, title, archived)
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
                    .map(|value| Uuid::parse_str(&value).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(error))))
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

    fn save_manuscript(
        &mut self,
        chapter_id: Uuid,
        mut document_json: String,
        creation_reason: String,
    ) -> Result<ManuscriptRevision, ManuscriptError> {
        document_json = normalize_document(&document_json)?;
        let exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plan_nodes WHERE id = ?1 AND kind = 'CHAPTER')",
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

    fn save_recovery_log(&mut self, chapter_id: Uuid, document_json: String) -> Result<(), DatabaseError> {
        validate_document(&document_json).map_err(|e| DatabaseError::Sqlite(rusqlite::Error::InvalidParameterName(e.to_string())))?;
        self.connection.execute("INSERT INTO recovery_logs (id, chapter_id, document_json) VALUES (?1, ?2, ?3)", rusqlite::params![Uuid::new_v4().to_string(), chapter_id.to_string(), document_json])?;
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
        assert_eq!(health.schema_version, 5);
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
        let root = std::path::PathBuf::from("target").join(format!("ainovel-manuscript-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "测试作品").expect("create project");
        let chapter = manager.create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into()).expect("chapter");
        let revision = manager.save_manuscript(chapter.id, r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"你好"}]}]}"#.into(), "test".into()).expect("save");
        assert_eq!(revision.document_schema_version, 1);
        assert!(revision.document_json.contains("blockId"));
        assert_eq!(revision.content_hash.len(), 64);
        assert!(manager.save_manuscript(chapter.id, "not-json".into(), "test".into()).is_err());
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
}
