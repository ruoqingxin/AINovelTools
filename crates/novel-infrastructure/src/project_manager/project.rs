use super::*;

impl ProjectManager {
    /// Creates a manager without an opened project.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            current: None,
            recent_projects_path: None,
        }
    }

    /// Creates a manager that persists recently opened projects at the given path.
    #[must_use]
    pub fn new_with_recent_projects(path: impl Into<PathBuf>) -> Self {
        Self {
            current: None,
            recent_projects_path: Some(path.into()),
        }
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
            self.record_recent_project(&root, &manifest)?;
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
            root: root.clone(),
            manifest,
            database,
        });
        self.recover_unfinished_jobs()?;
        self.prune_jobs()?;
        self.prune_ai_request_snapshots()?;
        self.record_recent_project(&root, &result)?;
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

    /// Lists recently created or opened projects, newest first.
    pub fn recent_projects(&self) -> Result<Vec<RecentProject>, ProjectError> {
        let Some(path) = self.recent_projects_path.as_ref() else {
            return Ok(Vec::new());
        };
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let content = std::fs::read(path)?;
        Ok(serde_json::from_slice(&content).unwrap_or_default())
    }

    /// Opens the most recently used project when it is still available.
    pub fn restore_last_project(&mut self) -> Result<Option<ProjectManifest>, ProjectError> {
        let Some(recent) = self.recent_projects()?.into_iter().next() else {
            return Ok(None);
        };
        match self.open(&recent.root) {
            Ok(manifest) => Ok(Some(manifest)),
            Err(
                ProjectError::NotInitialized(_)
                | ProjectError::Manifest(_)
                | ProjectError::Database(_),
            ) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn record_recent_project(
        &self,
        root: &Path,
        manifest: &ProjectManifest,
    ) -> Result<(), ProjectError> {
        let Some(path) = self.recent_projects_path.as_ref() else {
            return Ok(());
        };
        let mut projects = self.recent_projects()?;
        projects.retain(|project| project.root != root);
        projects.insert(
            0,
            RecentProject {
                root: root.to_path_buf(),
                name: manifest.name.clone(),
                last_opened_at: now_timestamp(),
            },
        );
        projects.truncate(10);

        let parent = path
            .parent()
            .ok_or_else(|| ProjectError::InvalidPath(path.clone()))?;
        std::fs::create_dir_all(parent)?;
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&projects)?)?;
        std::fs::rename(temporary, path)?;
        Ok(())
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

    pub fn get_writing_review_policy(&self) -> Result<WritingReviewPolicy, ProjectError> {
        let session = self.current.as_ref().ok_or(ProjectError::NoProject)?;
        let metadata = session.database.project_metadata()?;
        Ok(metadata
            .get("writingReviewPolicy")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default())
    }

    pub fn save_writing_review_policy(
        &mut self,
        policy: WritingReviewPolicy,
    ) -> Result<WritingReviewPolicy, ProjectError> {
        let session = self.current.as_mut().ok_or(ProjectError::NoProject)?;
        let mut metadata = session.database.project_metadata()?;
        if !metadata.is_object() {
            metadata = serde_json::json!({});
        }
        if let Some(object) = metadata.as_object_mut() {
            object.insert(
                "writingReviewPolicy".to_owned(),
                serde_json::to_value(policy)?,
            );
        }
        session.database.save_project_metadata(&metadata)?;
        Ok(policy)
    }

    pub fn get_audit_flow_settings(&self) -> Result<AuditFlowSettings, ProjectError> {
        let session = self.current.as_ref().ok_or(ProjectError::NoProject)?;
        let metadata = session.database.project_metadata()?;
        Ok(metadata
            .get("auditFlowSettings")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default())
    }

    pub fn save_audit_flow_settings(
        &mut self,
        settings: AuditFlowSettings,
    ) -> Result<AuditFlowSettings, ProjectError> {
        let session = self.current.as_mut().ok_or(ProjectError::NoProject)?;
        let mut metadata = session.database.project_metadata()?;
        if !metadata.is_object() {
            metadata = serde_json::json!({});
        }
        if let Some(object) = metadata.as_object_mut() {
            object.insert(
                "auditFlowSettings".to_owned(),
                serde_json::to_value(&settings)?,
            );
        }
        session.database.save_project_metadata(&metadata)?;
        Ok(settings)
    }
}
