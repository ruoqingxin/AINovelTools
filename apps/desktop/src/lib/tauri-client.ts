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

export type PlanNodeKind = "WORK_DESIGN" | "OUTLINE" | "VOLUME" | "CHAPTER" | "SCENE";

export type PlanNode = {
  id: string;
  parentId: string | null;
  kind: PlanNodeKind;
  title: string;
  sortOrder: number;
  archived: boolean;
  revision: number;
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
export type AiAction = "CONTINUE" | "REWRITE" | "POLISH" | "SUMMARIZE";
export type AiProposalStatus = "PENDING" | "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED";
export type ModelProfile = {
  id: string; name: string; provider: ModelProvider; capability: ModelCapability; baseUrl: string; modelId: string;
  contextWindow: number; maxOutputTokens: number; privacyLevel: PrivacyLevel;
  timeoutSeconds: number; retryLimit: number; secretRef: string | null; hasSecret: boolean;
  createdAt: string; updatedAt: string;
};
export type ModelProfileInput = Omit<ModelProfile, "id" | "secretRef" | "hasSecret" | "createdAt" | "updatedAt"> & { id?: string };
export type AiProposal = {
  id: string; taskId: string; chapterId: string; action: AiAction; targetRevisionId: string | null;
  contextVersion: string; promptVersion: string; outputText: string; acceptedText: string | null;
  status: AiProposalStatus; createdAt: string; decidedAt: string | null;
};
export type JobType = "BACKUP" | "RESTORE_VERIFY" | "HEALTH_SCAN" | "REBUILD_SEARCH_INDEX";
export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type Job = {
  id: string; jobType: JobType; payload: string; status: JobStatus; progress: number;
  attemptCount: number; cancelRequested: boolean; errorSummary: string | null;
  createdAt: string; updatedAt: string;
};
export type HealthScanReport = { status: "HEALTHY" | "WARNING" | "ERROR"; schemaVersion: number; sqliteIntegrity: string; ftsRows: number; warnings: string[]; errors: string[] };
export type StartupRecoveryReport = { crashMarkerPresent: boolean; recoveryLogCount: number; unfinishedJobCount: number; walPresent: boolean; tempFileCount: number; migrationInterrupted: boolean; actions: string[] };
export type ModelConnectionResponse = { capability: ModelCapability; provider: ModelProvider; modelId: string; detail: string };

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
export function createEvent(event: Event) { return invoke<Event>("create_event", { event }); }
export function createBelief(belief: Belief) { return invoke<Belief>("create_belief", { belief }); }
export function createForeshadowing(foreshadowing: Foreshadowing) { return invoke<Foreshadowing>("create_foreshadowing", { foreshadowing }); }
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

export function listAiProposals(chapterId: string) {
  return invoke<AiProposal[]>("list_ai_proposals", { chapterId });
}

export function generateAiProposal(input: {
  profileId: string; chapterId: string; action: AiAction; chapterTitle: string; chapterPlan: string;
  documentJson: string; selection?: string; instruction?: string; stream: boolean;
}) {
  return invoke<AiProposal>("generate_ai_proposal", input);
}

export function cancelAiTask(taskId: string) {
  return invoke<void>("cancel_ai_task", { taskId });
}

export function listJobs() { return invoke<Job[]>("list_jobs"); }
export function enqueueJob(jobType: JobType, payload = "{}") {
  return invoke<Job>("enqueue_job", { jobType, payload });
}
export function cancelJob(id: string) { return invoke<Job>("cancel_job", { id }); }
export function retryJob(id: string) { return invoke<Job>("retry_job", { id }); }
export function claimNextJob() { return invoke<Job | null>("claim_next_job"); }
export function runNextJob() { return invoke<Job | null>("run_next_job"); }
export function healthScan() { return invoke<HealthScanReport>("health_scan"); }
export function startupRecoveryReport() { return invoke<StartupRecoveryReport>("startup_recovery_report"); }
export function createDiagnosticPackage() { return invoke<string>("create_diagnostic_package"); }

export function decideAiProposal(input: { id: string; status: Exclude<AiProposalStatus, "PENDING">; acceptedText?: string }) {
  return invoke<AiProposal>("decide_ai_proposal", input);
}

export function invalidateProjectQueries(queryClient: { invalidateQueries: (options: { queryKey: string[] }) => Promise<unknown> }) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["current-project"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
  ]);
}
