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

const JOB_HISTORY_RETENTION: usize = 100;
const AI_REQUEST_SNAPSHOT_RETENTION: usize = 100;

mod ai;
mod context_store;
mod database;
mod discussion_store;
mod entity_store;
mod extraction_store;
mod knowledge_store;
mod materials_store;
mod review_contract;
mod review_rules;
mod review_store;
mod search_store;
pub use ai::{
    AiBudgetSettings, AiConsistencyFinding, AiConsistencyReport, AiConsistencySeverity,
    AiConsistencyVerdict, AiError, AiOutputValidation, AiProposalFeedback,
    AiProposalFeedbackRating, AiProposalReview, AiQualityGroup, AiQualitySummary, AiRun,
    AiRunRequest, AiRunSource, AiRunStart, AiTaskContextPreference, AiTaskKind, AiTaskPreference,
    AiTaskPreferences, AiTaskPromptPreference, AiUsageCurrencySummary, AiUsageDailySummary,
    AiUsageSummary, AiUsageTaskSummary, ConsistencyReviewFreshness, EmbeddingGateway,
    GenerationCompletion, GenerationOptions, GenerationOutput, GenerationUsage, ModelGateway,
    ModelProfileStore, ProjectAiTaskOverrides, SecretStore, WritingAdmission,
    apply_task_prompt_preferences, render_prompt_template,
};
pub use discussion_store::{
    DiscussionCandidate, DiscussionCandidateKind, DiscussionCandidateStatus, DiscussionMessage,
    DiscussionMessageRole, DiscussionScopeKind, DiscussionSession, DiscussionStoreError,
};
pub use entity_store::EntityStoreError;
pub use extraction_store::{
    ChapterExtractionItem, ChapterExtractionProposal, ChapterExtractionProposalStatus,
    ExtractionAdoption, ExtractionItemKind, ExtractionItemStatus, ExtractionStoreError,
};
pub use knowledge_store::KnowledgeStoreError;
pub use materials_store::MaterialsStoreError;
pub use novel_domain::{
    AiAction, AiProposal, AiProposalStatus, AiTaskStatus, AuditFlowSettings, Belief,
    CandidateStatus, ChangeSet, ChangeSetStatus, ChapterContract, ContextAuthority, Entity,
    EntityError, EntityInput, EntityLifecycleStatus, EntityRevision, EntityType, Event,
    EvidenceAnchor, EvidenceAuthority, Fact, FindingSource, Foreshadowing, KnowledgeCandidate,
    KnowledgeChunk, KnowledgeConflict, KnowledgeConflictKind, KnowledgeContractError,
    KnowledgeExpansionError, KnowledgeLifecycleStatus, KnowledgeVersion, ModelCapability,
    ModelProfile, ModelProfileInput, ModelProvider, PrivacyLevel, Relation, RetrievalEvidence,
    RetrievalMethod, ReviewClaim, ReviewClaimType, ReviewDecision, ReviewEvidence,
    ReviewEvidenceSource, ReviewFinding, ReviewOmittedItem, ReviewPurpose, ReviewStage,
    ReviewStageRequest, ReviewStatus, ReviewTrace, SummaryKind, SummaryMaterial, SummaryPrecision,
    WorldState, WorldStateEntry, WritingCard, WritingReviewPolicy,
};
pub use review_rules::{
    DeterministicReviewEvaluator, DeterministicReviewInput, FIXED_RULE_VERSION,
};
pub use review_store::ReviewStoreError;
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
    RefreshChapterSummary,
    RefreshProjectSettingSummary,
    AiPlanningGenerate,
    AiPlanningExtract,
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
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: Uuid,
    pub job_id: Uuid,
    pub stage: String,
    pub message: String,
    pub progress: u8,
    pub created_at: String,
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
pub const CURRENT_SCHEMA_VERSION: i64 = 47;

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
        id: "ai_task_routing",
        display_name: "六类 AI 任务路由与项目覆盖",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "ai_run_audit",
        display_name: "统一 AI 运行审计与主备回退",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "ai_usage_governance",
        display_name: "AI 用量估算与软预算",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "ai_quality_review",
        display_name: "AI 质量回顾与提示词版本对比",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "ai_efficiency_guardrails",
        display_name: "AI 任务预设、费用预算预检与故障恢复",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "ai_evaluation_baseline",
        display_name: "AI 脱敏评测样本与固定回归基线",
        stage: "AI",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
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
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_chapter_review",
        display_name: "R5 单章节审核与定稿",
        stage: "R5",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_conflict_detection",
        display_name: "R5 确定性冲突检测",
        stage: "R5",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_knowledge_version",
        display_name: "R5 KnowledgeVersion",
        stage: "R5",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_world_state",
        display_name: "R5 WorldState 投影",
        stage: "R5",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_knowledge_extensions",
        display_name: "R5 关系、事件、信念与伏笔",
        stage: "R5",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_progressive_writing",
        display_name: "R5.1 渐进式写作入口",
        stage: "R5.1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_planning_story_state",
        display_name: "R5.1 规划显式状态",
        stage: "R5.1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_chapter_extraction",
        display_name: "R5.1 正文提取候选",
        stage: "R5.1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_context_slice",
        display_name: "R5.1 相关上下文切片",
        stage: "R5.1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_project_discussion",
        display_name: "R5.1 作品级剧情讨论",
        stage: "R5.1",
        status: FeatureStatus::Implemented,
        unavailable_reason: None,
    },
    FeatureDescriptor {
        id: "r5_1_unified_metadata",
        display_name: "R5.1 统一候选元数据",
        stage: "R5.1",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("待真实使用验证后再决定是否扩展统一元数据"),
    },
    FeatureDescriptor {
        id: "r6_capability_admission",
        display_name: "R6 高级能力准入与评测基线",
        stage: "R6",
        status: FeatureStatus::Declared,
        unavailable_reason: Some("尚未有满足门槛的高级能力实现切片"),
    },
];

pub struct Database {
    connection: Connection,
}

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("no project is open")]
    NoProject,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub root: PathBuf,
    pub name: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanNodeKind {
    WorkDesign,
    Outline,
    VolumeManager,
    Volume,
    Chapter,
    Scene,
}
impl PlanNodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::WorkDesign => "WORK_DESIGN",
            Self::Outline => "OUTLINE",
            Self::VolumeManager => "VOLUME_MANAGER",
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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanningStoryState {
    #[default]
    Unset,
    Unknown,
    Deferred,
    AuthorReserved,
    AiSuggested,
    Confirmed,
    Locked,
    Retired,
}

impl PlanningStoryState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unset => "UNSET",
            Self::Unknown => "UNKNOWN",
            Self::Deferred => "DEFERRED",
            Self::AuthorReserved => "AUTHOR_RESERVED",
            Self::AiSuggested => "AI_SUGGESTED",
            Self::Confirmed => "CONFIRMED",
            Self::Locked => "LOCKED",
            Self::Retired => "RETIRED",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value {
            "UNKNOWN" => Self::Unknown,
            "DEFERRED" => Self::Deferred,
            "AUTHOR_RESERVED" => Self::AuthorReserved,
            "AI_SUGGESTED" => Self::AiSuggested,
            "CONFIRMED" => Self::Confirmed,
            "LOCKED" => Self::Locked,
            "RETIRED" => Self::Retired,
            _ => Self::Unset,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningSection {
    pub id: String,
    pub content: String,
    pub pending_content: String,
    pub story_state: PlanningStoryState,
    pub rationale: String,
    pub consequence: String,
    pub references: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningEmbedding {
    pub section_id: String,
    pub profile_id: Uuid,
    pub model_id: String,
    pub dimensions: i64,
    pub content_hash: String,
    pub vector: Vec<f32>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningChunkEmbedding {
    pub chunk_id: String,
    pub section_id: String,
    pub chunk_index: i64,
    pub profile_id: Uuid,
    pub model_id: String,
    pub dimensions: i64,
    pub content_hash: String,
    pub vector: Vec<f32>,
    pub updated_at: String,
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
    recent_projects_path: Option<PathBuf>,
}

mod document;
mod project_manager;
#[cfg(test)]
mod tests;

pub(crate) use document::*;

/// Returns the ordered layers linked into the infrastructure boundary.
#[must_use]
pub fn linked_layers() -> [&'static str; 3] {
    let [domain, application] = novel_application::linked_layers();
    [domain, application, "infrastructure"]
}
