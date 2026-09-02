//! Adapters for persistence, files, model providers, and operating-system APIs.

#![allow(
    clippy::missing_errors_doc,
    clippy::items_after_statements,
    clippy::match_same_arms,
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::collapsible_if,
    clippy::if_same_then_else,
    clippy::wildcard_imports,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::map_unwrap_or
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
mod knowledge_store;
mod materials_store;
mod search_store;
pub use ai::{AiError, EmbeddingGateway, ModelGateway, ModelProfileStore, SecretStore};
pub use entity_store::EntityStoreError;
pub use knowledge_store::KnowledgeStoreError;
pub use materials_store::MaterialsStoreError;
pub use novel_domain::{
    AiAction, AiProposal, AiProposalStatus, AiTaskStatus, CandidateStatus, ChangeSet,
    ChangeSetStatus, ContextAuthority, Entity, EntityError, EntityInput, EntityLifecycleStatus,
    EntityRevision, EntityType, EvidenceAnchor, Fact, KnowledgeCandidate, KnowledgeChunk,
    KnowledgeConflict, KnowledgeConflictKind, KnowledgeContractError, KnowledgeLifecycleStatus,
    ModelCapability, ModelProfile, ModelProfileInput, ModelProvider, PrivacyLevel,
    RetrievalEvidence, RetrievalMethod, ReviewDecision, SummaryKind, SummaryMaterial,
    SummaryPrecision, WritingCard,
};
pub use search_store::{SearchResult, SearchStoreError};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobType {
    Backup,
    RestoreVerify,
    HealthScan,
    RebuildSearchIndex,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: Uuid,
    pub job_type: JobType,
    pub payload: String,
    pub status: JobStatus,
    pub progress: u8,
    pub attempt_count: u32,
    pub cancel_requested: bool,
    pub error_summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthScanReport {
    pub status: String,
    pub schema_version: i64,
    pub sqlite_integrity: String,
    pub fts_rows: i64,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrashMarker {
    pub process_type: String,
    pub session_id: Uuid,
    pub occurred_at: String,
    pub last_trace_id: Option<String>,
    pub active_project: Option<Uuid>,
    pub active_task: Option<Uuid>,
    pub build_version: String,
    pub crash_phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecoveryReport {
    pub crash_marker_present: bool,
    pub recovery_log_count: usize,
    pub unfinished_job_count: usize,
    pub wal_present: bool,
    pub temp_file_count: usize,
    pub migration_interrupted: bool,
    pub actions: Vec<String>,
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
pub const R4_SCHEMA_VERSION: i64 = 15;
/// Current database schema after the R5 persistence baseline migrations.
pub const CURRENT_SCHEMA_VERSION: i64 = 20;

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
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
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
        status: FeatureStatus::Partial,
        unavailable_reason: Some("已建立安全默认值和迁移基线，设置编辑界面待补齐"),
    },
    FeatureDescriptor {
        id: "story_bible",
        display_name: "Story Bible 实体库",
        stage: "R4",
        status: FeatureStatus::Partial,
        unavailable_reason: Some("实体、修订、归档和检索已实现，窄屏验收与候选来源字段待补齐"),
    },
    FeatureDescriptor {
        id: "r4_search",
        display_name: "SQLite FTS5 搜索",
        stage: "R4",
        status: FeatureStatus::Partial,
        unavailable_reason: Some("FTS5 投影和搜索已实现，正文块定位与完整章节入口待补齐"),
    },
    FeatureDescriptor {
        id: "r4_persistent_jobs",
        display_name: "R4 持久化任务",
        stage: "R4",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r4_reliability",
        display_name: "R4 备份恢复与诊断",
        stage: "R4",
        status: FeatureStatus::Partial,
        unavailable_reason: Some(
            "备份、恢复、健康扫描和诊断已实现，完整迁移中断恢复与窗口诊断待增强",
        ),
    },
    FeatureDescriptor {
        id: "r5_fact_governance",
        display_name: "R5 Fact 知识治理",
        stage: "R5",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("R5 首批设计已冻结，Fact/EvidenceAnchor 尚未实现"),
    },
    FeatureDescriptor {
        id: "r5_chapter_review",
        display_name: "R5 单章节审核与定稿",
        stage: "R5",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("等待候选、证据锚点和 ChangeSet 迁移落地"),
    },
    FeatureDescriptor {
        id: "r5_conflict_detection",
        display_name: "R5 确定性冲突检测",
        stage: "R5",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("首批仅规划确定性规则，高风险命中需人工确认"),
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

fn job_type_str(value: JobType) -> &'static str {
    match value {
        JobType::Backup => "BACKUP",
        JobType::RestoreVerify => "RESTORE_VERIFY",
        JobType::HealthScan => "HEALTH_SCAN",
        JobType::RebuildSearchIndex => "REBUILD_SEARCH_INDEX",
    }
}

fn parse_job_type(value: &str) -> JobType {
    match value {
        "RESTORE_VERIFY" => JobType::RestoreVerify,
        "HEALTH_SCAN" => JobType::HealthScan,
        "REBUILD_SEARCH_INDEX" => JobType::RebuildSearchIndex,
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
    })
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectManager {
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
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs WHERE status='QUEUED' OR status='CANCELLED' ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([], read_job)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
    }

    /// Atomically claims the oldest queued job for a runner.
    pub fn claim_next_job(&mut self) -> Result<Option<Job>, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let tx = session.database.connection.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs WHERE status='QUEUED' AND cancel_requested=0 ORDER BY created_at, rowid LIMIT 1",
                [],
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
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs WHERE id=?1",
            [&id],
            read_job,
        )?;
        tx.commit()?;
        Ok(Some(job))
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

    fn is_job_cancel_requested(&self, id: Uuid) -> Result<bool, DatabaseError> {
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
        };
        session.database.connection.execute(
            "INSERT INTO jobs (id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary) VALUES (?1, ?2, ?3, 'QUEUED', 0, 0, 0, NULL)",
            rusqlite::params![job.id.to_string(), job_type_str(job.job_type), job.payload],
        )?;
        Ok(job)
    }

    pub fn list_jobs(&self) -> Result<Vec<Job>, DatabaseError> {
        let session = self
            .current
            .as_ref()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        let mut statement = session.database.connection.prepare(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs ORDER BY updated_at DESC, rowid DESC",
        )?;
        let rows = statement.query_map([], read_job)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(DatabaseError::from)
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
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn request_job_cancel(&mut self, id: Uuid) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET cancel_requested=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status IN ('QUEUED','RUNNING')",
            [id.to_string()],
        )?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn retry_job(&mut self, id: Uuid) -> Result<Job, DatabaseError> {
        let session = self
            .current
            .as_mut()
            .ok_or_else(|| DatabaseError::Sqlite(rusqlite::Error::InvalidQuery))?;
        session.database.connection.execute(
            "UPDATE jobs SET status='QUEUED', progress=0, attempt_count=attempt_count+1, cancel_requested=0, error_summary=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status='FAILED'",
            [id.to_string()],
        )?;
        session.database.connection.query_row(
            "SELECT id, job_type, payload, status, progress, attempt_count, cancel_requested, error_summary, created_at, updated_at FROM jobs WHERE id=?1",
            [id.to_string()],
            read_job,
        ).map_err(DatabaseError::from)
    }

    pub fn assemble_context_with_project_knowledge(
        &self,
        input: &novel_application::AssembleContextInput,
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        self.assemble_context_with_project_knowledge_and_objects(input, &[])
    }

    pub fn assemble_context_with_project_knowledge_and_objects(
        &self,
        input: &novel_application::AssembleContextInput,
        object_ids: &[Uuid],
    ) -> Result<novel_application::ContextPackage, novel_application::ContextError> {
        let query = input
            .instruction
            .as_deref()
            .unwrap_or(input.chapter_title.as_str())
            .trim()
            .to_owned();
        let mut results = self.search_project_objects(object_ids).unwrap_or_default();
        results.extend(self.search_project(query, None, 8, 0).unwrap_or_default());
        let mut seen = std::collections::HashSet::new();
        results.retain(|item| seen.insert(item.object_id));
        let evidence = results
            .into_iter()
            .enumerate()
            .map(|(index, result)| {
                let source_hash = format!("{:x}", Sha256::digest(result.snippet.as_bytes()));
                RetrievalEvidence {
                    chunk: KnowledgeChunk {
                        id: Uuid::new_v4(),
                        source_id: result.object_id,
                        source_revision: result
                            .source_version
                            .unwrap_or_else(|| "search:current".to_owned()),
                        source_hash,
                        chunk_index: u32::try_from(index).unwrap_or(u32::MAX),
                        chunking_version: "r4-search-v1".to_owned(),
                        content: result.snippet,
                        embedding: None,
                    },
                    method: RetrievalMethod::Keyword,
                    authority: match result.object_type.as_str() {
                        "ENTITY" | "PLAN" | "MANUSCRIPT" => ContextAuthority::TaskMaterial,
                        _ => ContextAuthority::Reference,
                    },
                    relevance: 5_000,
                }
            })
            .collect::<Vec<_>>();
        novel_application::ContextAssembler::assemble_with_retrieval(input, &evidence)
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
        self.recover_unfinished_jobs()?;
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
        let node = session.database.create_plan_node(parent_id, kind, title)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
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
        let node = session.database.update_plan_node(id, title, archived)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
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
        let node =
            session
                .database
                .update_plan_node_checked(id, title, archived, expected_version)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
    }

    pub fn move_plan_node(
        &mut self,
        id: Uuid,
        parent_id: Option<Uuid>,
        expected_version: i64,
    ) -> Result<PlanNode, PlanError> {
        let session = self.current.as_mut().ok_or(PlanError::NoProject)?;
        let node = session
            .database
            .move_plan_node(id, parent_id, expected_version)?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(node)
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
        let revision = session.database.save_manuscript_checked(
            chapter_id,
            None,
            document_json,
            creation_reason,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(revision)
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
        let revision = session.database.save_manuscript_checked(
            chapter_id,
            base_revision_id,
            document_json,
            creation_reason,
        )?;
        session
            .database
            .rebuild_search_index(session.manifest.project_id)?;
        Ok(revision)
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
    use super::{
        CURRENT_SCHEMA_VERSION, Database, FEATURE_CATALOG, FeatureStatus, R4_CONTRACTS,
        R4_MIGRATION_PLAN, R4_SCHEMA_VERSION,
    };

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
        assert_eq!(health.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(R4_SCHEMA_VERSION, 15);
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
    fn r5_schema_baseline_creates_governance_tables() {
        let database = Database::in_memory().expect("in-memory database");
        for table in [
            "knowledge_candidates",
            "evidence_anchors",
            "facts",
            "change_sets",
            "change_set_items",
            "knowledge_audit_records",
            "knowledge_outbox_events",
        ] {
            let exists: i64 = database
                .connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("schema lookup");
            assert_eq!(exists, 1, "missing table {table}");
        }
    }

    #[test]
    fn feature_catalog_matches_r4_implemented_surfaces() {
        let jobs = FEATURE_CATALOG
            .iter()
            .find(|item| item.id == "r4_persistent_jobs")
            .expect("jobs feature");
        assert_eq!(jobs.status, FeatureStatus::Implemented);
        assert!(jobs.unavailable_reason.is_none());
        let reliability = FEATURE_CATALOG
            .iter()
            .find(|item| item.id == "r4_reliability")
            .expect("reliability feature");
        assert_eq!(reliability.status, FeatureStatus::Partial);
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
    fn search_handles_chinese_short_queries_and_archived_entities() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-search-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "搜索作品").expect("create project");
        let entity = manager
            .upsert_entity(super::EntityInput {
                id: None,
                entity_type: super::EntityType::Character,
                name: "林澈".into(),
                aliases: vec!["小林".into()],
                description: "北境的调查者".into(),
                fixed_attributes_json: "{}".into(),
                tags: vec!["北境".into()],
                base_revision_id: None,
                source_version: Some("test:1".into()),
                expected_version: None,
            })
            .expect("entity");
        assert_eq!(
            manager
                .search_project("林".into(), Some("ENTITY".into()), 50, 0)
                .expect("short search")
                .len(),
            1
        );
        assert_eq!(
            manager
                .search_project("调查者".into(), None, 50, 0)
                .expect("fts search")
                .len(),
            1
        );
        assert!(
            manager
                .search_project("林!".into(), None, 50, 0)
                .expect("special character search")
                .is_empty()
        );
        assert_eq!(
            manager
                .search_project("北境".into(), None, 50, 0)
                .expect("deduplicated search")
                .len(),
            1
        );
        manager
            .set_entity_archived(entity.id, true, entity.version)
            .expect("archive");
        assert!(
            manager
                .search_project("林".into(), None, 50, 0)
                .expect("archived search")
                .is_empty()
        );
        manager.rebuild_search_index().expect("rebuild");
        assert!(
            manager
                .search_project("林".into(), None, 50, 0)
                .expect("rebuilt search")
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn context_assembly_attaches_only_active_project_sources() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-context-search-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "上下文搜索").expect("create project");
        let chapter = manager
            .create_plan_node(None, super::PlanNodeKind::Chapter, "第一章".into())
            .expect("chapter");
        manager
            .upsert_entity(super::EntityInput {
                id: None,
                entity_type: super::EntityType::Character,
                name: "沈砚".into(),
                aliases: vec![],
                description: "负责调查失踪案".into(),
                fixed_attributes_json: "{}".into(),
                tags: vec![],
                base_revision_id: None,
                source_version: Some("entity:1".into()),
                expected_version: None,
            })
            .expect("entity");
        for action in [
            super::AiAction::Continue,
            super::AiAction::Rewrite,
            super::AiAction::Polish,
            super::AiAction::Summarize,
        ] {
            let package = manager
                .assemble_context_with_project_knowledge(
                    &novel_application::AssembleContextInput {
                        chapter_id: chapter.id,
                        target_revision_id: None,
                        action,
                        chapter_title: "第一章".into(),
                        chapter_plan: "调查失踪案".into(),
                        document_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"沈砚来到车站。"}]}]}"#.into(),
                        selection: action
                            .requires_selection()
                            .then(|| "沈砚来到车站。".to_owned()),
                        instruction: Some("调查失踪案".into()),
                        input_token_budget: 4096,
                    },
                )
                .expect("context package");
            assert!(
                package
                    .retrieval_evidence
                    .iter()
                    .any(|item| item.source_revision == "entity:1")
            );
            assert_eq!(package.entity_source_status, "RETRIEVAL_ATTACHED");
            assert_eq!(package.action, action);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_jobs_enforce_lifecycle_and_retry_failed_work() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-jobs-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "任务测试").expect("create");
        let job = manager
            .enqueue_job(super::JobType::RebuildSearchIndex, "{}".into())
            .expect("enqueue");
        assert_eq!(job.status, super::JobStatus::Queued);
        manager
            .update_job_status(job.id, super::JobStatus::Running, 10, None)
            .expect("running");
        let failed = manager
            .update_job_status(
                job.id,
                super::JobStatus::Failed,
                35,
                Some("索引不可用".into()),
            )
            .expect("failed");
        assert_eq!(failed.error_summary.as_deref(), Some("索引不可用"));
        let retried = manager.retry_job(job.id).expect("retry");
        assert_eq!(retried.status, super::JobStatus::Queued);
        assert_eq!(retried.attempt_count, 1);
        assert!(
            manager
                .update_job_status(job.id, super::JobStatus::Succeeded, 100, None)
                .is_err()
        );
        let cancelled = manager.request_job_cancel(job.id).expect("cancel");
        assert!(cancelled.cancel_requested);
        let cancelled = manager
            .update_job_status(job.id, super::JobStatus::Cancelled, 0, None)
            .expect("cancelled");
        assert_eq!(cancelled.status, super::JobStatus::Cancelled);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_project_recovers_running_jobs_and_claims_once() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-job-recovery-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "任务恢复").expect("create");
        let first = manager
            .enqueue_job(super::JobType::HealthScan, "{}".into())
            .expect("enqueue first");
        let second = manager
            .enqueue_job(super::JobType::Backup, "{}".into())
            .expect("enqueue second");
        let cancelled = manager
            .enqueue_job(super::JobType::RestoreVerify, "{}".into())
            .expect("enqueue cancelled");
        manager
            .update_job_status(first.id, super::JobStatus::Running, 42, None)
            .expect("running");
        manager
            .update_job_status(cancelled.id, super::JobStatus::Running, 18, None)
            .expect("running cancelled");
        manager
            .request_job_cancel(cancelled.id)
            .expect("request cancel");
        manager.close();
        manager.open(&root).expect("reopen");
        let recovered = manager.list_jobs().expect("list recovered");
        assert!(recovered.iter().any(|job| job.id == first.id
            && job.status == super::JobStatus::Queued
            && job.progress == 0));
        assert!(
            recovered
                .iter()
                .any(|job| job.id == cancelled.id && job.status == super::JobStatus::Cancelled)
        );
        let claimed = manager
            .claim_next_job()
            .expect("claim")
            .expect("job available");
        assert_eq!(claimed.id, first.id);
        assert_eq!(claimed.status, super::JobStatus::Running);
        assert_eq!(claimed.attempt_count, 1);
        assert!(manager.claim_next_job().expect("second claim").is_some());
        let _ = std::fs::remove_dir_all(root);
        let _ = second;
    }

    #[test]
    fn run_next_job_persists_success_and_backup_artifacts() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-job-run-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "任务执行").expect("create");
        std::fs::write(root.join("attachments").join("note.txt"), b"attachment")
            .expect("attachment");
        manager
            .enqueue_job(super::JobType::Backup, "{}".into())
            .expect("enqueue");
        let completed = manager.run_next_job().expect("run").expect("completed");
        assert_eq!(completed.status, super::JobStatus::Succeeded);
        let snapshot = root.join("snapshots").join(completed.id.to_string());
        assert!(snapshot.join("project.sqlite").is_file());
        assert_eq!(manager.health_scan().expect("health").status, "HEALTHY");
        let restored = root.with_file_name(format!(
            "{}-restored",
            root.file_name().unwrap().to_string_lossy()
        ));
        manager
            .restore_backup_to_new_project(&snapshot, &restored)
            .expect("restore");
        assert!(restored.join("project.sqlite").is_file());
        assert_eq!(
            std::fs::read(restored.join("attachments").join("note.txt"))
                .expect("restored attachment"),
            b"attachment"
        );
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(restored);
    }

    #[test]
    fn crash_marker_startup_report_and_diagnostics_are_privacy_safe() {
        let root = std::path::PathBuf::from("target")
            .join(format!("ainovel-diagnostics-{}", uuid::Uuid::new_v4()));
        let mut manager = super::ProjectManager::new();
        manager.create(&root, "诊断测试").expect("create");
        manager
            .write_crash_marker(&super::CrashMarker {
                process_type: "desktop".into(),
                session_id: uuid::Uuid::new_v4(),
                occurred_at: "now".into(),
                last_trace_id: Some("trace".into()),
                active_project: manager.current().map(|m| m.project_id),
                active_task: None,
                build_version: "test".into(),
                crash_phase: "RUNNING".into(),
            })
            .expect("marker");
        let report = manager.startup_recovery_report().expect("report");
        assert!(report.crash_marker_present);
        let path = manager.create_diagnostic_package().expect("diagnostics");
        let content = std::fs::read_to_string(path).expect("read diagnostics");
        assert!(!content.contains("project.sqlite"));
        manager.clear_crash_marker().expect("clear marker");
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
