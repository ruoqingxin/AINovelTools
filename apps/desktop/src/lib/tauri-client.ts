import { invoke } from "@tauri-apps/api/core";

export type BootstrapStatus = {
  appVersion: string;
  layers: ["domain", "application", "infrastructure"];
};

export type ApiError = { code: string; message: string };

export function errorMessage(cause: unknown) {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export type DatabaseHealth = {
  status: "PROJECT_HEALTHY" | "NO_PROJECT_OPEN";
  sqliteVersion: string;
  schemaVersion: number;
  journalMode: string;
  foreignKeysEnabled: boolean;
};

export type ProjectManifest = {
  projectId: string;
  formatVersion: number;
  name: string;
  createdAt: string;
};

export type RecentProject = {
  root: string;
  name: string;
  lastOpenedAt: string;
};

  export type PlanNodeKind = "WORK_DESIGN" | "OUTLINE" | "VOLUME_MANAGER" | "VOLUME" | "CHAPTER" | "SCENE";

export type PlanNode = {
  id: string;
  parentId: string | null;
  kind: PlanNodeKind;
  title: string;
  sortOrder: number;
  archived: boolean;
  revision: number;
};

export type PlanningSection = {
  id: string;
  content: string;
  pendingContent: string;
  rationale: string;
  consequence: string;
  references: string[];
  updatedAt: string;
};
export type PlanningEmbedding = {
  sectionId: string;
  profileId: string;
  modelId: string;
  dimensions: number;
  contentHash: string;
  vector?: number[];
  updatedAt: string;
};

export type ManuscriptRevision = {
  id: string;
  chapterId: string;
  parentRevisionId: string | null;
  baseRevisionId: string | null;
  documentJson: string;
  contentHash: string;
  creationReason: string;
  documentSchemaVersion: number;
  createdAt: string;
};

export type FeatureDescriptor = { id: string; displayName: string; stage: string; status: "IMPLEMENTED" | "PARTIAL" | "DECLARED" | "DISABLED"; unavailableReason: string | null };
export type R4MigrationDescriptor = { version: number; name: string; purpose: string; dependsOn: number[] };
export type R4ContractDescriptor = { id: string; layer: string; purpose: string; introducedBy: number };
export type EntityType = "CHARACTER" | "LOCATION" | "FACTION" | "ITEM" | "CONCEPT";
export type EntityLifecycleStatus = "ACTIVE" | "ARCHIVED";
export type Entity = {
  id: string; projectId: string; entityType: EntityType; lifecycleStatus: EntityLifecycleStatus;
  currentRevisionId: string; version: number; createdAt: string; updatedAt: string;
};
export type EntityRevision = {
  id: string; entityId: string; revision: number; name: string; aliases: string[];
  description: string; fixedAttributesJson: string; tags: string[]; baseRevisionId: string | null;
  sourceVersion: string | null; createdAt: string;
};
export type EntityInput = {
  id?: string; entityType: EntityType; name: string; aliases: string[]; description: string;
  fixedAttributesJson: string; tags: string[]; baseRevisionId?: string; sourceVersion?: string;
  expectedVersion?: number;
};
export type SummaryKind = "CHAPTER" | "CHARACTER" | "SETTING";
export type SummaryPrecision = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type SummaryMaterial = {
  id: string; projectId: string; kind: SummaryKind; precision: SummaryPrecision;
  sourceId: string | null; sourceVersion: string | null; content: string;
  generationMode: string; lifecycleStatus: string; createdAt: string; updatedAt: string;
};
export type WritingCard = {
  id: string; projectId: string; cardType: "STYLE_RULE" | "TECHNIQUE"; title: string;
  content: string; sourceVersion: string | null; scope: string; enabled: boolean;
  sortOrder: number; createdAt: string; updatedAt: string;
};
export type SearchResult = { objectType: string; objectId: string; blockId: string | null; sourceVersion: string | null; snippet: string };
export type KnowledgeLifecycleStatus = "ACTIVE" | "NEEDS_REVIEW" | "ARCHIVED";
export type CandidateStatus = "PENDING" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "FINALIZED";
export type ReviewDecision = "APPROVE" | "REJECT" | "NEEDS_REVIEW";
export type ChangeSetStatus = "DRAFT" | "IN_REVIEW" | "BLOCKED" | "FINALIZED" | "REJECTED";
export type EvidenceAnchor = {
  id: string; projectId: string; chapterId: string; sourceRevisionId: string;
  blockId: string; startOffset: number; endOffset: number; sourceVersion: string;
  sourceHash: string; lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string;
  createdAt: string; updatedAt: string;
};
export type Fact = {
  knowledgeId: string; projectId: string; knowledgeVersion: number; subject: string;
  predicate: string; object: string; sourceRevisionId: string; evidenceAnchorIds: string[];
  lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string; createdAt: string; updatedAt: string;
};
export type KnowledgeCandidate = {
  id: string; projectId: string; chapterId: string; proposalId: string | null;
  candidateStatus: CandidateStatus; reviewDecision: ReviewDecision | null;
  reviewer: string | null; reviewedAt: string | null; fact: Fact; createdAt: string; updatedAt: string;
};
export type KnowledgeConflict = {
  kind: "DUPLICATE_FACT" | "CONTRADICTORY_OBJECT"; candidateIds: string[];
  subject: string; predicate: string; objects: string[]; highRisk: boolean;
};
export type ChangeSet = {
  id: string; projectId: string; chapterId: string; sourceRevisionId: string;
  status: ChangeSetStatus; candidateIds: string[]; createdBy: string; createdAt: string; updatedAt: string;
};
export type WorldStateEntry = { subject: string; predicate: string; object: string; factKnowledgeId: string; factVersion: number };
export type WorldState = { id: string; projectId: string; knowledgeVersionId: string; entries: WorldStateEntry[]; createdAt: string };
export type Relation = { id: string; projectId: string; relationVersion: number; fromKnowledgeId: string; toKnowledgeId: string; relationType: string; evidenceAnchorIds: string[]; lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string; createdAt: string; updatedAt: string };
export type Event = { id: string; projectId: string; eventVersion: number; name: string; occurredAt: string; participantFactIds: string[]; evidenceAnchorIds: string[]; lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string; createdAt: string; updatedAt: string };
export type Belief = { id: string; projectId: string; beliefVersion: number; holderKnowledgeId: string; proposition: string; evidenceAnchorIds: string[]; lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string; createdAt: string; updatedAt: string };
export type Foreshadowing = { id: string; projectId: string; foreshadowingVersion: number; title: string; targetChapterId: string | null; status: string; evidenceAnchorIds: string[]; lifecycleStatus: KnowledgeLifecycleStatus; createdBy: string; createdAt: string; updatedAt: string };
export type AssembleContextInput = {
  chapterId: string; targetRevisionId: string | null; action: AiAction; chapterTitle: string;
  chapterPlan: string; documentJson: string; selection: string | null; instruction: string | null;
  inputTokenBudget: number;
  knowledgeObjectIds?: string[];
};
export type ContextPackage = {
  chapterId: string; targetRevisionId: string | null; action: AiAction; contextVersion: string;
  promptVersion: string; systemPrompt: string; userPrompt: string; estimatedInputTokens: number;
  truncated: boolean; entitySourceStatus: string; retrievalEvidence: unknown[];
  taskContract: unknown; sectionAudit: unknown[];
};
export type RecoveryLog = { id: string; chapterId: string; documentJson: string; createdAt: string };
export type MergeConflict = { blockId: string; base?: string; current?: string; draft?: string };
export type MergeResult = { documentJson: string; conflicts: MergeConflict[] };
export type ModelProvider = "SILICON_FLOW" | "DEEP_SEEK" | "OPEN_AI" | "OPEN_AI_COMPATIBLE";
export type ModelCapability = "CHAT" | "EMBEDDING";
export type PrivacyLevel = "LOCAL_ONLY" | "ALLOW_CLOUD";
export type AiAction = "DRAFT" | "CONTINUE" | "REWRITE" | "POLISH" | "SUMMARIZE";
export type AiProposalStatus = "PENDING" | "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED";
export type ModelProfile = {
  id: string; name: string; provider: ModelProvider; capability: ModelCapability; baseUrl: string; modelId: string;
  contextWindow: number; maxOutputTokens: number; privacyLevel: PrivacyLevel;
  timeoutSeconds: number; retryLimit: number;
  inputPriceMicrosPerMillion: number; outputPriceMicrosPerMillion: number; priceCurrency: string;
  secretRef: string | null; hasSecret: boolean;
  createdAt: string; updatedAt: string;
};
export type ModelProfileInput = Omit<ModelProfile, "id" | "secretRef" | "hasSecret" | "createdAt" | "updatedAt"> & { id?: string };
export type AiTaskPreference = {
  profileId: string | null;
  fallbackProfileId: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  prompt: AiTaskPromptPreference;
};
export type AiTaskPromptPreference = {
  systemPrompt: string | null;
  instructionTemplate: string | null;
  context: AiTaskContextPreference;
};
export type AiTaskContextPreference = {
  includeProjectContext: boolean | null;
  includeReferenceContent: boolean | null;
  includeProjectKnowledge: boolean | null;
  includeCurrentDraft: boolean | null;
  includeChapterPlan: boolean | null;
  inputTokenBudget: number | null;
};
export type AiTaskPreferences = {
  workDesign: AiTaskPreference;
  outline: AiTaskPreference;
  volumePlanning: AiTaskPreference;
  chapterSplit: AiTaskPreference;
  writing: AiTaskPreference;
  knowledgeExtraction: AiTaskPreference;
};
export type ProjectAiTaskOverrides = {
  available: boolean;
  workDesign: AiTaskPreference | null;
  outline: AiTaskPreference | null;
  volumePlanning: AiTaskPreference | null;
  chapterSplit: AiTaskPreference | null;
  writing: AiTaskPreference | null;
  knowledgeExtraction: AiTaskPreference | null;
};
export type AiProposal = {
  id: string; taskId: string; chapterId: string; action: AiAction; targetRevisionId: string | null;
  contextVersion: string; promptVersion: string; outputText: string; acceptedText: string | null;
  status: AiProposalStatus; createdAt: string; decidedAt: string | null;
};
export type AiRun = {
  id: string; taskKey: string; source: string; action: AiAction | string; status: string;
  chapterTitle: string; profileName: string;
  attemptCount: number; retryReason: string | null; errorCode: string | null;
  estimatedInputTokens: number; estimatedOutputTokens: number;
  estimatedCostMicros: number | null; priceCurrency: string;
  promptVersion: string; createdAt: string; finishedAt: string | null;
};
export type AiUsageCurrencySummary = {
  currency: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number | null;
};
export type AiUsageDailySummary = AiUsageCurrencySummary & { date: string };
export type AiUsageTaskSummary = AiUsageCurrencySummary & { taskKey: string };
export type AiUsageSummary = {
  days: number;
  total: AiUsageCurrencySummary[];
  daily: AiUsageDailySummary[];
  byTask: AiUsageTaskSummary[];
};
export type AiBudgetSettings = {
  currency: string;
  dailyLimitMicros: number | null;
  projectLimitMicros: number | null;
};
export type AiQualityGroup = {
  taskKey: string;
  action: string;
  promptVersion: string;
  profileName: string;
  proposalCount: number;
  acceptedCount: number;
  ratedCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  validCount: number;
  warningCount: number;
  needsInputCount: number;
  invalidCount: number;
};
export type AiQualitySummary = {
  totalProposals: number;
  totalRated: number;
  totalHelpful: number;
  totalWithIssues: number;
  groups: AiQualityGroup[];
};
export type AiProposalFeedback = {
  proposalId: string; rating: "HELPFUL" | "NOT_HELPFUL"; note: string | null;
  createdAt: string; updatedAt: string;
};
export type AiProposalReview = {
  proposal: AiProposal;
  validation: {
    status: "VALID" | "WARNING" | "INVALID" | "NEEDS_INPUT"; messages: string[]; characterCount: number;
    paragraphCount: number; estimatedOutputTokens: number;
  };
  feedback: AiProposalFeedback | null;
};
export type JobType = "BACKUP" | "RESTORE_VERIFY" | "HEALTH_SCAN" | "REBUILD_SEARCH_INDEX" | "AI_PLANNING_GENERATE" | "AI_PLANNING_EXTRACT";
export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type Job = {
  id: string; jobType: JobType; payload: string; status: JobStatus; progress: number;
  attemptCount: number; cancelRequested: boolean; errorSummary: string | null;
  createdAt: string; updatedAt: string; acknowledgedAt: string | null;
};
export type JobEvent = {
  id: string; jobId: string; stage: string; message: string; progress: number; createdAt: string;
};
export type PlanningAiJobInput = {
  profileId: string; mode: "GENERATE" | "EXTRACT"; sectionId: string; sectionTitle: string;
  sectionPrompt: string; existingContext: string; referenceContent: string; userGuidance: string;
  allowRewrite: boolean; taskKey?: "workDesign" | "outline" | "volumePlanning" | "chapterSplit"; temperature?: number; maxOutputTokens?: number;
  sourceName?: string[] | string; systemPromptSnapshot?: string; userPromptSnapshot?: string;
  finalRequestEndpoint?: string; finalRequestBody?: string; finalRequestEstimatedInputTokens?: number;
};
export type PlanningAiRequestPreview = {
  endpoint: string | null; requestBody: string | null; estimatedInputTokens: number | null;
};
export type HealthScanReport = { status: "HEALTHY" | "WARNING" | "ERROR"; schemaVersion: number; sqliteIntegrity: string; ftsRows: number; warnings: string[]; errors: string[] };
export type StartupRecoveryReport = { crashMarkerPresent: boolean; recoveryLogCount: number; unfinishedJobCount: number; walPresent: boolean; tempFileCount: number; migrationInterrupted: boolean; actions: string[] };
export type ModelConnectionResponse = { capability: ModelCapability; provider: ModelProvider; modelId: string; detail: string };
export type ExtractedEntity = { name: string; description: string; aliases: string[]; tags: string[] };

export function getBootstrapStatus() {
  return invoke<BootstrapStatus>("bootstrap_status");
}

export function getFeatureCatalog() {
  return invoke<FeatureDescriptor[]>("feature_catalog");
}

export function getHealth() {
  return invoke<DatabaseHealth>("health_query");
}

export function listEntities(includeArchived = false) {
  return invoke<Entity[]>("list_entities", { includeArchived });
}

export function upsertEntity(input: EntityInput) {
  return invoke<Entity>("upsert_entity", { input });
}

export function listEntityRevisions(entityId: string) {
  return invoke<EntityRevision[]>("list_entity_revisions", { entityId });
}

export function setEntityArchived(input: { id: string; archived: boolean; expectedVersion: number }) {
  return invoke<Entity>("set_entity_archived", input);
}
export function listSummaryMaterials() { return invoke<SummaryMaterial[]>("list_summary_materials"); }
export function upsertSummaryMaterial(material: SummaryMaterial) { return invoke<SummaryMaterial>("upsert_summary_material", { material }); }
export function listWritingCards(cardType?: string) { return invoke<WritingCard[]>("list_writing_cards", { cardType }); }
export function upsertWritingCard(card: WritingCard) { return invoke<WritingCard>("upsert_writing_card", { card }); }
export function setWritingCardEnabled(id: string, enabled: boolean) { return invoke<WritingCard>("set_writing_card_enabled", { id, enabled }); }
export function setSummaryMaterialLifecycle(id: string, lifecycleStatus: string) { return invoke<SummaryMaterial>("set_summary_material_lifecycle", { id, lifecycleStatus }); }
export function rebuildSummaryMaterial(id: string) { return invoke<SummaryMaterial>("rebuild_summary_material", { id }); }
export function rebuildSearchIndex() { return invoke<void>("rebuild_search_index"); }
export function searchProject(query: string, objectType?: string, limit = 50, offset = 0) { return invoke<SearchResult[]>("search_project", { query, objectType, limit, offset }); }
export function createEvidenceAnchor(anchor: EvidenceAnchor) { return invoke<EvidenceAnchor>("create_evidence_anchor", { anchor }); }
export function listEvidenceAnchors() { return invoke<EvidenceAnchor[]>("list_evidence_anchors"); }
export function listCurrentFacts() { return invoke<Fact[]>("list_current_facts"); }
export function createKnowledgeCandidate(candidate: KnowledgeCandidate) { return invoke<KnowledgeCandidate>("create_knowledge_candidate", { candidate }); }
export function listKnowledgeCandidates(chapterId: string) { return invoke<KnowledgeCandidate[]>("list_knowledge_candidates", { chapterId }); }
export function reviewKnowledgeCandidate(input: { id: string; expectedStatus: CandidateStatus; decision: ReviewDecision; reviewer: string }) {
  return invoke<KnowledgeCandidate>("review_knowledge_candidate", input);
}
export function detectCandidateConflicts(chapterId: string) { return invoke<KnowledgeConflict[]>("detect_candidate_conflicts", { chapterId }); }
export function finalizeKnowledgeCandidates(input: { chapterId: string; candidateIds: string[]; actor: string }) {
  return invoke<ChangeSet>("finalize_knowledge_candidates", input);
}
export function rebuildWorldState(actor: string) { return invoke<WorldState>("rebuild_world_state", { actor }); }
export function createRelation(relation: Relation) { return invoke<Relation>("create_relation", { relation }); }
export function updateRelation(relation: Relation, expectedVersion: number) { return invoke<Relation>("update_relation", { relation, expectedVersion }); }
export function createEvent(event: Event) { return invoke<Event>("create_event", { event }); }
export function updateEvent(event: Event, expectedVersion: number) { return invoke<Event>("update_event", { event, expectedVersion }); }
export function createBelief(belief: Belief) { return invoke<Belief>("create_belief", { belief }); }
export function updateBelief(belief: Belief, expectedVersion: number) { return invoke<Belief>("update_belief", { belief, expectedVersion }); }
export function createForeshadowing(foreshadowing: Foreshadowing) { return invoke<Foreshadowing>("create_foreshadowing", { foreshadowing }); }
export function updateForeshadowing(foreshadowing: Foreshadowing, expectedVersion: number) { return invoke<Foreshadowing>("update_foreshadowing", { foreshadowing, expectedVersion }); }
export function listRelations() { return invoke<Relation[]>("list_relations"); }
export function listEvents() { return invoke<Event[]>("list_events"); }
export function listBeliefs() { return invoke<Belief[]>("list_beliefs"); }
export function listForeshadowings() { return invoke<Foreshadowing[]>("list_foreshadowings"); }
export function assembleContextWithProjectKnowledge(input: AssembleContextInput) {
  return invoke<ContextPackage>("assemble_context_with_project_knowledge", { input, objectIds: input.knowledgeObjectIds });
}

export function getCurrentProject() {
  return invoke<ProjectManifest | null>("current_project");
}

export function listRecentProjects() {
  return invoke<RecentProject[]>("list_recent_projects");
}

export function createProject(root: string, name: string) {
  return invoke<ProjectManifest>("create_project", { root, name });
}

export function openProject(root: string) {
  return invoke<ProjectManifest>("open_project", { root });
}

export function closeProject() {
  return invoke<ProjectManifest | null>("close_project");
}

export function listPlanNodes() {
  return invoke<PlanNode[]>("list_plan_nodes");
}

export function listPlanningSections() {
  return invoke<PlanningSection[]>("list_planning_sections");
}

export function savePlanningSection(section: PlanningSection) {
  return invoke<PlanningSection>("save_planning_section", { section });
}
export function listPlanningEmbeddings() {
  return invoke<PlanningEmbedding[]>("list_planning_embeddings");
}
export function generatePlanningEmbedding(profileId: string, sectionId: string) {
  return invoke<PlanningEmbedding>("generate_planning_embedding", { profileId, sectionId });
}
export function clearPlanningEmbedding(sectionId: string) {
  return invoke<void>("clear_planning_embedding", { sectionId });
}

export function createPlanNode(input: {
  parentId?: string;
  kind: PlanNodeKind;
  title: string;
}) {
  return invoke<PlanNode>("create_plan_node", input);
}

export function updatePlanNode(input: { id: string; title: string; archived: boolean }) {
  return invoke<PlanNode>("update_plan_node", input);
}

export function updatePlanNodeChecked(input: { id: string; title: string; archived: boolean; expectedVersion: number }) {
  return invoke<PlanNode>("update_plan_node_checked", input);
}

export function movePlanNode(input: { id: string; parentId?: string; expectedVersion: number }) {
  return invoke<PlanNode>("move_plan_node", input);
}

export function currentManuscript(chapterId: string) {
  return invoke<ManuscriptRevision | null>("current_manuscript", { chapterId });
}

export function listManuscriptRevisions(chapterId: string) {
  return invoke<ManuscriptRevision[]>("list_manuscript_revisions", { chapterId });
}

export function saveRecoveryLog(input: { chapterId: string; documentJson: string }) {
  return invoke<void>("save_recovery_log", input);
}

export function listRecoveryLogs(chapterId: string) {
  return invoke<RecoveryLog[]>("list_recovery_logs", { chapterId });
}

export function listAllRecoveryLogs() {
  return invoke<RecoveryLog[]>("list_all_recovery_logs");
}

export function clearRecoveryLogs(chapterId: string) {
  return invoke<void>("clear_recovery_logs", { chapterId });
}

export function saveManuscript(input: { chapterId: string; documentJson: string; creationReason: string }) {
  return invoke<ManuscriptRevision>("save_manuscript", input);
}

export function saveManuscriptChecked(input: { chapterId: string; baseRevisionId?: string; documentJson: string; creationReason: string }) {
  return invoke<ManuscriptRevision>("save_manuscript_checked", input);
}

export function mergeManuscript(input: { base: string; current: string; draft: string }) {
  return invoke<MergeResult>("merge_manuscript", input);
}

export function listModelProfiles() {
  return invoke<ModelProfile[]>("list_model_profiles");
}

export function getAiTaskPreferences() {
  return invoke<AiTaskPreferences>("get_ai_task_preferences");
}

export function saveAiTaskPreferences(preferences: AiTaskPreferences) {
  return invoke<AiTaskPreferences>("save_ai_task_preferences", { preferences });
}
export function getAiBudgetSettings() {
  return invoke<AiBudgetSettings>("get_ai_budget_settings");
}
export function saveAiBudgetSettings(settings: AiBudgetSettings) {
  return invoke<AiBudgetSettings>("save_ai_budget_settings", { settings });
}
export function getProjectAiTaskOverrides() {
  return invoke<ProjectAiTaskOverrides>("get_project_ai_task_overrides");
}
export function saveProjectAiTaskOverride(task: keyof AiTaskPreferences, preference: AiTaskPreference) {
  return invoke<ProjectAiTaskOverrides>("save_project_ai_task_override", { task, preference });
}
export function saveProjectAiTaskOverrides(preferences: AiTaskPreferences) {
  return invoke<ProjectAiTaskOverrides>("save_project_ai_task_overrides", { preferences });
}
export function removeProjectAiTaskOverride(task: keyof AiTaskPreferences) {
  return invoke<ProjectAiTaskOverrides>("remove_project_ai_task_override", { task });
}

export function upsertModelProfile(input: ModelProfileInput) {
  return invoke<ModelProfile>("upsert_model_profile", { input });
}

export function saveModelSecret(profileId: string, secret: string) {
  return invoke<ModelProfile>("save_model_secret", { profileId, secret });
}

export function deleteModelSecret(profileId: string) {
  return invoke<ModelProfile>("delete_model_secret", { profileId });
}

export function testModelProfile(profileId: string) {
  return invoke<ModelConnectionResponse>("test_model_profile", { profileId });
}

export function extractEntitiesFromText(profileId: string, entityType: EntityType, entityName: string, briefSummary: string, applicabilityScope: string, sourceText: string, userGuidance?: string, temperature?: number, maxOutputTokens?: number) {
  return invoke<ExtractedEntity[]>("extract_entities_from_text", { input: { profileId, entityType, entityName, briefSummary, applicabilityScope, sourceText, userGuidance, temperature, maxOutputTokens } });
}

export function listAiProposals(chapterId: string) {
  return invoke<AiProposalReview[]>("list_ai_proposals", { chapterId });
}
export function listAiRuns(limit = 20) {
  return invoke<AiRun[]>("list_ai_runs", { limit });
}
export function getAiUsageSummary(days = 30) {
  return invoke<AiUsageSummary>("get_ai_usage_summary", { days });
}
export function getAiQualitySummary(limit = 20) {
  return invoke<AiQualitySummary>("get_ai_quality_summary", { limit });
}
export function rateAiProposal(id: string, rating: "HELPFUL" | "NOT_HELPFUL", note?: string) {
  return invoke<AiProposalFeedback>("rate_ai_proposal", { id, rating, note });
}

export function generateAiProposal(input: {
  profileId: string; chapterId: string; action: AiAction; chapterTitle: string; chapterPlan: string;
  documentJson: string; selection?: string; instruction?: string; stream: boolean;
  temperature?: number; maxOutputTokens?: number;
}) {
  return invoke<AiProposal>("generate_ai_proposal", input);
}

export function generatePlanningContent(input: { profileId: string; mode: "GENERATE" | "EXTRACT"; sectionTitle: string; sectionPrompt: string; existingContext: string; referenceContent: string; userGuidance: string; allowRewrite: boolean }) {
  return invoke<string>("generate_planning_content", input);
}

export function enqueuePlanningAiJob(input: PlanningAiJobInput) {
  return invoke<Job>("enqueue_planning_ai_job", { input });
}
export function getPlanningAiJobRequest(jobId: string) {
  return invoke<PlanningAiRequestPreview>("get_planning_ai_job_request", { jobId });
}

export function cancelAiTask(taskId: string) {
  return invoke<void>("cancel_ai_task", { taskId });
}

export function listJobs() { return invoke<Job[]>("list_jobs"); }
export function listJobEvents(jobId: string) { return invoke<JobEvent[]>("list_job_events", { jobId }); }
export function enqueueJob(jobType: JobType, payload = "{}") {
  return invoke<Job>("enqueue_job", { jobType, payload });
}
export function cancelJob(id: string) { return invoke<Job>("cancel_job", { id }); }
export function retryJob(id: string) { return invoke<Job>("retry_job", { id }); }
export function acknowledgeFailedJobs() { return invoke<number>("acknowledge_failed_jobs"); }
export function claimNextJob() { return invoke<Job | null>("claim_next_job"); }
export function runNextJob() { return invoke<Job | null>("run_next_job"); }
export function healthScan() { return invoke<HealthScanReport>("health_scan"); }
export function startupRecoveryReport() { return invoke<StartupRecoveryReport>("startup_recovery_report"); }
export function createDiagnosticPackage() { return invoke<string>("create_diagnostic_package"); }

export function decideAiProposal(input: { id: string; status: Exclude<AiProposalStatus, "PENDING">; acceptedText?: string }) {
  return invoke<AiProposal>("decide_ai_proposal", input);
}

export function invalidateProjectQueries(queryClient: { invalidateQueries: (options: { queryKey: string[] }) => Promise<unknown> }) {
  const projectKeys = [
    ["current-project"], ["health"], ["entities"], ["entity-revisions"], ["summary-materials"],
    ["writing-cards"], ["plan-nodes"], ["planning-sections"], ["current-facts"], ["evidence-anchors"],
    ["relations"], ["events"], ["beliefs"], ["foreshadowings"], ["knowledge-candidates"],
    ["knowledge-conflicts"], ["project-search"], ["jobs"], ["recovery-all"], ["manuscript"],
    ["manuscript-history"], ["recovery-logs"], ["ai-proposals"], ["ai-runs"],
  ];
  return Promise.all([
    ...projectKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    queryClient.invalidateQueries({ queryKey: ["recent-projects"] }),
  ]);
}
