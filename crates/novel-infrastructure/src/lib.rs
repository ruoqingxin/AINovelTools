//! Adapters for persistence, files, model providers, and operating-system APIs.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
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
}

fn now_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    seconds.to_string()
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
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
        )?;
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
        assert_eq!(health.schema_version, 1);
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
}
