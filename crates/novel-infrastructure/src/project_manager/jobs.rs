use super::*;

fn job_type_str(value: JobType) -> &'static str {
    match value {
        JobType::Backup => "BACKUP",
        JobType::RestoreVerify => "RESTORE_VERIFY",
        JobType::HealthScan => "HEALTH_SCAN",
        JobType::RebuildSearchIndex => "REBUILD_SEARCH_INDEX",
        JobType::AiPlanningGenerate => "AI_PLANNING_GENERATE",
        JobType::AiPlanningExtract => "AI_PLANNING_EXTRACT",
    }
}

fn parse_job_type(value: &str) -> JobType {
    match value {
        "RESTORE_VERIFY" => JobType::RestoreVerify,
        "HEALTH_SCAN" => JobType::HealthScan,
        "REBUILD_SEARCH_INDEX" => JobType::RebuildSearchIndex,
        "AI_PLANNING_GENERATE" => JobType::AiPlanningGenerate,
        "AI_PLANNING_EXTRACT" => JobType::AiPlanningExtract,
        _ => JobType::Backup,
    }
}

fn job_status_str(value: JobStatus) -> &'static str {
    match value {
        JobStatus::Queued => "QUEUED",
        JobStatus::Running => "RUNNING",
        JobStatus::Succeeded => "SUCCEEDED",
        JobStatus::Failed => "FAILED",
        JobStatus::Cancelled => "CANCELLED",
    }
}

fn parse_job_status(value: &str) -> JobStatus {
    match value {
        "RUNNING" => JobStatus::Running,
        "SUCCEEDED" => JobStatus::Succeeded,
        "FAILED" => JobStatus::Failed,
        "CANCELLED" => JobStatus::Cancelled,
        _ => JobStatus::Queued,
    }
}

fn valid_job_transition(from: JobStatus, to: JobStatus) -> bool {
    matches!(
        (from, to),
        (JobStatus::Queued, JobStatus::Running | JobStatus::Cancelled)
            | (
                JobStatus::Running,
                JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
            )
            | (JobStatus::Failed, JobStatus::Queued)
    )
}

fn read_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        job_type: parse_job_type(&row.get::<_, String>(1)?),
        payload: row.get(2)?,
        status: parse_job_status(&row.get::<_, String>(3)?),
        progress: row.get::<_, i64>(4)?.clamp(0, 100) as u8,
        attempt_count: row.get::<_, i64>(5)?.max(0) as u32,
        cancel_requested: row.get::<_, i64>(6)? == 1,
        error_summary: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        acknowledged_at: row.get(10)?,
    })
}

fn read_job_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobEvent> {
    Ok(JobEvent {
        id: Uuid::parse_str(&row.get::<_, String>(0)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        job_id: Uuid::parse_str(&row.get::<_, String>(1)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        stage: row.get(2)?,
        message: row.get(3)?,
        progress: row.get::<_, i64>(4)?.clamp(0, 100) as u8,
        created_at: row.get(5)?,
    })
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectManager {
    pub fn project_id(&self) -> Result<Uuid, ProjectError> {
        self.current
            .as_ref()
            .map(|session| session.manifest.project_id)
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))
    }

    pub fn write_crash_marker(&self, marker: &CrashMarker) -> Result<(), ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        std::fs::write(
            session.root.join("crash-marker.json"),
            serde_json::to_vec_pretty(marker)?,
        )?;
        Ok(())
    }

    pub fn clear_crash_marker(&self) -> Result<(), ProjectError> {
        if let Some(session) = self.current.as_ref() {
            let path = session.root.join("crash-marker.json");
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub fn startup_recovery_report(&self) -> Result<StartupRecoveryReport, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        let marker = session.root.join("crash-marker.json").is_file();
        let recovery_log_count = self
            .list_all_recovery_logs()
            .map_err(|e| {
                ProjectError::Database(match e {
                    ManuscriptError::Database(d) => d,
                    _ => DatabaseError::Sqlite(rusqlite::Error::InvalidQuery),
                })
            })?
            .len();
        let unfinished_job_count: usize = session
            .database
            .connection
            .query_row(
                "SELECT count(*) FROM jobs WHERE status IN ('QUEUED','RUNNING')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            .max(0) as usize;
        let wal_present = session.root.join("project.sqlite-wal").is_file();
        let temp_file_count = walk_files(&session.root.join("temp"))
            .map(|v| v.len())
            .unwrap_or(0);
        let migration_interrupted = session
            .database
            .connection
            .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0)
            < 1;
        let mut actions = Vec::new();
        if marker {
            actions.push("检测到上次异常退出标记".into());
        }
        if unfinished_job_count > 0 {
            actions.push("恢复未完成后台任务".into());
        }
        if wal_present {
            actions.push("检测到 SQLite WAL，启动时由 SQLite 自动合并".into());
        }
        Ok(StartupRecoveryReport {
            crash_marker_present: marker,
            recovery_log_count,
            unfinished_job_count,
            wal_present,
            temp_file_count,
            migration_interrupted,
            actions,
        })
    }

    pub fn compact_recovery_logs(
        &mut self,
        retain_per_chapter: usize,
    ) -> Result<usize, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let retain = retain_per_chapter.max(1) as i64;
        let removed = session.database.connection.execute("DELETE FROM recovery_logs WHERE id IN (SELECT id FROM recovery_logs WHERE rowid NOT IN (SELECT rowid FROM recovery_logs r2 WHERE r2.chapter_id = recovery_logs.chapter_id ORDER BY created_at DESC, rowid DESC LIMIT ?1))", [retain])?;
        Ok(removed)
    }

    pub fn create_diagnostic_package(&self) -> Result<PathBuf, ProjectError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| ProjectError::NotInitialized(PathBuf::from("<none>")))?;
        let id = Uuid::new_v4();
        let path = session
            .root
            .join("exports")
            .join(format!("diagnostic-{id}.json"));
        let health = self.health_scan().map_err(ProjectError::Database)?;
        let report = self.startup_recovery_report()?;
        let payload = serde_json::json!({"diagnosticId": id, "generatedAt": now_timestamp(), "schemaVersion": CURRENT_SCHEMA_VERSION, "health": health, "startup": report, "privacy": {"databaseIncluded": false, "manuscriptIncluded": false, "promptIncluded": false, "apiKeyIncluded": false, "attachmentsIncluded": false, "fullPathsIncluded": false}});
        std::fs::write(&path, serde_json::to_vec_pretty(&payload)?)?;
        Ok(path)
    }

    /// Recovers jobs left in RUNNING state after an interrupted process.
    /// Cancelled work is finalized as CANCELLED; other work returns to QUEUED
    /// so a runner can safely claim it again.
    pub fn recover_unfinished_jobs(&mut self) -> Result<Vec<Job>, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET status=CASE WHEN cancel_requested=1 THEN 'CANCELLED' ELSE 'QUEUED' END, progress=CASE WHEN cancel_requested=1 THEN progress ELSE 0 END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='RUNNING'",
            [],
        )?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE status='QUEUED' OR status='CANCELLED' ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([], read_job)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    fn claim_next_job_by_category(&mut self, ai_job: bool) -> Result<Option<Job>, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let tx = session.database.connection.transaction()?;
        let category = i32::from(ai_job);
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs
                 WHERE status='QUEUED' AND cancel_requested=0
                   AND CASE WHEN job_type IN ('AI_PLANNING_GENERATE','AI_PLANNING_EXTRACT') THEN 1 ELSE 0 END = ?1
                 ORDER BY created_at, rowid LIMIT 1",
                [category],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            tx.commit()?;
            return Ok(None);
        };
        tx.execute(
            "UPDATE jobs SET status='RUNNING', attempt_count=attempt_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status='QUEUED' AND cancel_requested=0",
            [&id],
        )?;
        let job = tx.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [&id],
            read_job,
        )?;
        tx.commit()?;
        Ok(Some(job))
    }

    /// Atomically claims the oldest queued maintenance job.
    pub fn claim_next_job(&mut self) -> Result<Option<Job>, DatabaseError> {
        self.claim_next_job_by_category(false)
    }

    /// Atomically claims the oldest queued AI planning job.
    pub fn claim_next_ai_job(&mut self) -> Result<Option<Job>, DatabaseError> {
        self.claim_next_job_by_category(true)
    }

    /// Executes one queued job synchronously. The operation is restart-safe:
    /// claiming is atomic and every outcome is persisted as a terminal status.
    pub fn run_next_job(&mut self) -> Result<Option<Job>, DatabaseError> {
        let Some(job) = self.claim_next_job()? else {
            return Ok(None);
        };
        if self.is_job_cancel_requested(job.id)? {
            return self
                .update_job_status(job.id, JobStatus::Cancelled, job.progress, None)
                .map(Some);
        }
        let result: Result<(), String> = match job.job_type {
            JobType::RebuildSearchIndex => self.rebuild_search_index().map_err(|e| e.to_string()),
            JobType::HealthScan => self.health_scan().map(|_| ()).map_err(|e| e.to_string()),
            JobType::Backup => self.perform_backup(&job).map_err(|e| e.to_string()),
            JobType::RestoreVerify => self.perform_restore_verify(&job).map_err(|e| e.to_string()),
            JobType::AiPlanningGenerate | JobType::AiPlanningExtract => {
                Err("AI planning jobs require the asynchronous runner".to_owned())
            }
        };
        if self.is_job_cancel_requested(job.id)? {
            self.update_job_status(job.id, JobStatus::Cancelled, job.progress, None)
                .map(Some)
        } else {
            match result {
                Ok(()) => self
                    .update_job_status(job.id, JobStatus::Succeeded, 100, None)
                    .map(Some),
                Err(error) => self
                    .update_job_status(job.id, JobStatus::Failed, job.progress, Some(error))
                    .map(Some),
            }
        }
    }

    pub fn is_job_cancel_requested(&self, id: Uuid) -> Result<bool, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        Ok(session.database.connection.query_row(
            "SELECT cancel_requested FROM jobs WHERE id=?1",
            [id.to_string()],
            |row| row.get::<_, i64>(0),
        )? == 1)
    }

    pub fn health_scan(&self) -> Result<HealthScanReport, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let health = session.database.health()?;
        let integrity: String =
            session
                .database
                .connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let fts_rows: i64 = session
            .database
            .connection
            .query_row("SELECT count(*) FROM search_index", [], |row| row.get(0))
            .unwrap_or(0);
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        if integrity != "ok" {
            errors.push(format!("SQLite integrity check: {integrity}"));
        }
        for directory in ["attachments", "snapshots", "recovery", "exports", "temp"] {
            if !session.root.join(directory).is_dir() {
                warnings.push(format!("missing directory: {directory}"));
            }
        }
        let status = if errors.is_empty() {
            if warnings.is_empty() {
                "HEALTHY"
            } else {
                "WARNING"
            }
        } else {
            "ERROR"
        };
        Ok(HealthScanReport {
            status: status.into(),
            schema_version: health.schema_version,
            sqlite_integrity: integrity,
            fts_rows,
            warnings,
            errors,
        })
    }

    pub fn restore_backup_to_new_project(
        &self,
        source: impl AsRef<Path>,
        target: impl AsRef<Path>,
    ) -> Result<ProjectManifest, ProjectError> {
        let source = source.as_ref();
        let target = target.as_ref();
        if target.exists() {
            return Err(ProjectError::AlreadyExists(target.to_path_buf()));
        }
        let manifest: ProjectManifest =
            serde_json::from_slice(&std::fs::read(source.join("project.json"))?)?;
        let parent = target
            .parent()
            .ok_or_else(|| ProjectError::InvalidPath(target.to_path_buf()))?;
        std::fs::create_dir_all(parent)?;
        let temp = parent.join(format!(".restore-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp)?;
        let result = (|| {
            for directory in ["attachments", "snapshots", "recovery", "exports", "temp"] {
                std::fs::create_dir_all(temp.join(directory))?;
            }
            std::fs::copy(source.join("project.json"), temp.join("project.json"))?;
            std::fs::copy(source.join("project.sqlite"), temp.join("project.sqlite"))?;
            for directory in ["attachments", "recovery"] {
                let source_dir = source.join(directory);
                if source_dir.is_dir() {
                    for entry in walk_files(&source_dir)? {
                        let relative = entry.strip_prefix(source).unwrap_or(&entry);
                        let destination = temp.join(relative);
                        if let Some(parent) = destination.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::copy(entry, destination)?;
                    }
                }
            }
            let _ = Database::open(temp.join("project.sqlite"))?;
            std::fs::rename(&temp, target)?;
            Ok(manifest)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&temp);
        }
        result
    }

    fn perform_backup(&self, job: &Job) -> Result<(), std::io::Error> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| std::io::Error::other("no project is open"))?;
        let target = session.root.join("snapshots").join(job.id.to_string());
        std::fs::create_dir_all(&target)?;
        std::fs::copy(
            session.root.join("project.json"),
            target.join("project.json"),
        )?;
        std::fs::copy(
            session.root.join("project.sqlite"),
            target.join("project.sqlite"),
        )?;
        let mut files = serde_json::Map::new();
        for relative in ["project.json", "project.sqlite"] {
            let bytes = std::fs::read(target.join(relative))?;
            files.insert(
                relative.into(),
                serde_json::json!(format!("sha256:{:x}", Sha256::digest(bytes))),
            );
        }
        let attachments = session.root.join("attachments");
        if attachments.is_dir() {
            for entry in walk_files(&attachments)? {
                let relative = entry
                    .strip_prefix(&session.root)
                    .unwrap_or(&entry)
                    .to_path_buf();
                let destination = target.join(&relative);
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&entry, &destination)?;
                let bytes = std::fs::read(&destination)?;
                files.insert(
                    relative.to_string_lossy().replace('\\', "/"),
                    serde_json::json!(format!("sha256:{:x}", Sha256::digest(bytes))),
                );
            }
        }
        for directory in ["recovery"] {
            let source_dir = session.root.join(directory);
            if source_dir.is_dir() {
                for entry in walk_files(&source_dir)? {
                    let relative = entry
                        .strip_prefix(&session.root)
                        .unwrap_or(&entry)
                        .to_path_buf();
                    let destination = target.join(&relative);
                    if let Some(parent) = destination.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(&entry, &destination)?;
                }
            }
        }
        std::fs::write(target.join("manifest.json"), serde_json::to_vec_pretty(&serde_json::json!({"jobId": job.id, "projectId": session.manifest.project_id, "schemaVersion": CURRENT_SCHEMA_VERSION, "formatVersion": 1, "files": files})).unwrap_or_default())?;
        Ok(())
    }

    fn perform_restore_verify(&self, job: &Job) -> Result<(), std::io::Error> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| std::io::Error::other("no project is open"))?;
        let payload: serde_json::Value =
            serde_json::from_str(&job.payload).map_err(std::io::Error::other)?;
        let source = payload
            .get("source")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| session.root.join("snapshots").join(job.id.to_string()));
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(source.join("manifest.json"))?)
                .map_err(std::io::Error::other)?;
        if manifest.get("projectId").and_then(|v| v.as_str())
            != Some(&session.manifest.project_id.to_string())
        {
            return Err(std::io::Error::other("backup project id mismatch"));
        }
        let mut verify_files = vec!["project.json".to_owned(), "project.sqlite".to_owned()];
        if let Some(files) = manifest.get("files").and_then(|v| v.as_object()) {
            verify_files.extend(
                files
                    .keys()
                    .filter(|key| key.starts_with("attachments/"))
                    .cloned(),
            );
        }
        for relative in verify_files {
            let bytes = std::fs::read(source.join(&relative))?;
            let actual = format!("sha256:{:x}", Sha256::digest(bytes));
            let expected = manifest
                .get("files")
                .and_then(|v| v.get(&relative))
                .and_then(|v| v.as_str());
            if expected != Some(actual.as_str()) {
                return Err(std::io::Error::other(format!(
                    "backup hash mismatch: {relative}"
                )));
            }
        }
        if let Some(target) = payload.get("target").and_then(|v| v.as_str()) {
            self.restore_backup_to_new_project(&source, target)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
        }
        Ok(())
    }

    pub fn enqueue_job(
        &mut self,
        job_type: JobType,
        payload: String,
    ) -> Result<Job, DatabaseError> {
        let job = {
            let session = self
                .current
                .as_mut()
                .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
            let payload_value: serde_json::Value =
                serde_json::from_str(&payload).map_err(|_| {
                    rusqlite::Error::InvalidParameterName("job payload must be valid JSON".into())
                })?;
            if !payload_value.is_object() {
                return Err(DatabaseError::Sqlite(
                    rusqlite::Error::InvalidParameterName(
                        "job payload must be a JSON object".into(),
                    ),
                ));
            }
            let job = Job {
                id: Uuid::new_v4(),
                job_type,
                payload,
                status: JobStatus::Queued,
                progress: 0,
                attempt_count: 0,
                cancel_requested: false,
                error_summary: None,
                created_at: now_timestamp(),
                updated_at: now_timestamp(),
                acknowledged_at: None,
            };
            session.database.connection.execute(
                "INSERT INTO jobs (id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary) VALUES (?1, ?2, ?3, 'QUEUED', 0, 0, 0, NULL)",
                rusqlite::params![job.id.to_string(), job_type_str(job.job_type), job.payload],
            )?;
            job
        };
        self.prune_jobs()?;
        Ok(job)
    }

    pub(crate) fn prune_jobs(&self) -> Result<(), DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "DELETE FROM jobs
             WHERE status IN ('SUCCEEDED','FAILED','CANCELLED')
               AND id NOT IN (
                 SELECT id FROM jobs
                 WHERE status IN ('SUCCEEDED','FAILED','CANCELLED')
                 ORDER BY updated_at DESC, rowid DESC
                 LIMIT ?1
               )",
            [i64::try_from(JOB_HISTORY_RETENTION).unwrap_or(100)],
        )?;
        Ok(())
    }

    pub(crate) fn prune_ai_request_snapshots(&self) -> Result<(), DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE ai_run_records
             SET request_endpoint=NULL, request_body=NULL
             WHERE status <> 'RUNNING'
               AND (request_endpoint IS NOT NULL OR request_body IS NOT NULL)
               AND id NOT IN (
                 SELECT id FROM ai_run_records
                 WHERE status <> 'RUNNING'
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?1
               )",
            [i64::try_from(AI_REQUEST_SNAPSHOT_RETENTION).unwrap_or(100)],
        )?;
        Ok(())
    }

    pub fn list_jobs(&self) -> Result<Vec<Job>, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([], read_job)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub fn get_job(&self, id: Uuid) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn update_job_payload(&mut self, id: Uuid, payload: String) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let payload_value: serde_json::Value = serde_json::from_str(&payload).map_err(|_| {
            rusqlite::Error::InvalidParameterName("job payload must be valid JSON".into())
        })?;
        if !payload_value.is_object() {
            return Err(DatabaseError::Sqlite(
                rusqlite::Error::InvalidParameterName("job payload must be a JSON object".into()),
            ));
        }
        session.database.connection.execute(
            "UPDATE jobs SET payload=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",
            rusqlite::params![payload, id.to_string()],
        )?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn list_job_events(&self, job_id: Uuid) -> Result<Vec<JobEvent>, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, job_id, stage, message, progress, created_at
             FROM job_events WHERE job_id=?1 ORDER BY created_at, rowid",
        )?;
        let rows = statement.query_map([job_id.to_string()], read_job_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    pub fn append_job_event(
        &mut self,
        job_id: Uuid,
        stage: impl Into<String>,
        message: impl Into<String>,
        progress: u8,
    ) -> Result<JobEvent, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let event = JobEvent {
            id: Uuid::new_v4(),
            job_id,
            stage: stage.into(),
            message: message.into(),
            progress: progress.min(100),
            created_at: now_timestamp(),
        };
        session.database.connection.execute(
            "INSERT INTO job_events (id, job_id, stage, message, progress) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![event.id.to_string(), event.job_id.to_string(), &event.stage, &event.message, event.progress],
        )?;
        Ok(event)
    }

    pub fn update_job_progress(&mut self, id: Uuid, progress: u8) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET progress=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2 AND status='RUNNING'",
            rusqlite::params![progress.min(99), id.to_string()],
        )?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn update_job_status(
        &mut self,
        id: Uuid,
        status: JobStatus,
        progress: u8,
        error_summary: Option<String>,
    ) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let current = session.database.connection.query_row(
            "SELECT status FROM jobs WHERE id=?1",
            [id.to_string()],
            |row| row.get::<_, String>(0),
        )?;
        let current_status = parse_job_status(&current);
        if !valid_job_transition(current_status, status) {
            return Err(DatabaseError::Sqlite(
                rusqlite::Error::InvalidParameterName("invalid job status transition".into()),
            ));
        }
        let progress = progress.min(100);
        session.database.connection.execute(
            "UPDATE jobs SET status=?1, progress=?2, error_summary=?3, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?4",
            rusqlite::params![job_status_str(status), progress, error_summary, id.to_string()],
        )?;
        let job = session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)?;
        if matches!(
            status,
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
        ) {
            self.prune_jobs()?;
        }
        Ok(job)
    }

    /// Marks the current failed jobs as reviewed without changing their status.
    pub fn acknowledge_failed_jobs(&mut self) -> Result<u32, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let count = session.database.connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status='FAILED' AND acknowledged_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if count > 0 {
            session.database.connection.execute(
                "UPDATE jobs SET acknowledged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='FAILED' AND acknowledged_at IS NULL",
                [],
            )?;
        }
        Ok(count.max(0) as u32)
    }

    pub fn request_job_cancel(&mut self, id: Uuid) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET cancel_requested=1, status=CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE status END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status IN ('QUEUED','RUNNING')",
            [id.to_string()],
        )?;
        let job = session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)?;
        if job.status == JobStatus::Cancelled {
            self.prune_jobs()?;
        }
        Ok(job)
    }

    pub fn retry_job(&mut self, id: Uuid) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET status='QUEUED', progress=0, attempt_count=attempt_count+1, cancel_requested=0, error_summary=NULL, acknowledged_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status='FAILED'",
            [id.to_string()],
        )?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at, acknowledged_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut files = Vec::new();
    if !root.is_dir() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            files.extend(walk_files(&path)?);
        } else {
            files.push(path);
        }
    }
    Ok(files)
}
