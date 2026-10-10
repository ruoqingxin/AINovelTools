import type {
  AiBudgetSettings, AiProposalStatus, AiTaskPreference, AiTaskPreferences, AuditFlowSettings, Belief,
  DiscussionDesignEntity, DiscussionWorkspace, EntityType, Event, EvidenceAnchor, Foreshadowing,
  InputPlanningSection, IpcRequests, IpcResponses, JobType, KnowledgeCandidate, Relation, SummaryMaterial,
  VersionedPlanningSection, WritingCard, WritingReviewPolicy,
} from "./ipc-types.generated";
import { invoke } from "./ipc-transport";

export type * from "./ipc-types.generated";
export type DatabaseHealth = IpcResponses["health_query"];
export type EntityInput = IpcRequests["upsert_entity"]["input"];
export type ModelProfileInput = IpcRequests["upsert_model_profile"]["input"];
export type ManuscriptSourceRequest = IpcRequests["get_manuscript_source"]["request"];
export type DiscussionSourceRequest = IpcRequests["get_discussion_source"]["request"];
export type ExtractionItemTarget = IpcRequests["adopt_extraction_item"]["target"];
export type PlanBatchInput = IpcRequests["adopt_plan_batch"]["input"];
export type PlanningAiJobInput = IpcRequests["enqueue_planning_ai_job"]["input"];
// Unsaved forms have no stored version; raw IPC responses use VersionedPlanningSection.
export type PlanningSection = InputPlanningSection & { version?: VersionedPlanningSection["version"] };
// UI-only object selection is passed as a separate command argument.
export type AssembleContextInput = IpcRequests["assemble_context_with_project_knowledge"]["input"] & {
  knowledgeObjectIds?: IpcRequests["assemble_context_with_project_knowledge"]["objectIds"];
};

export function errorMessage(cause: unknown) {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
export const DISCUSSION_LIMITS = {
  messageChars: 20_000, draftChars: 50_000, proposalChars: 100_000,
  pageSize: 100, proposalEntities: 20,
} as const;

export function getBootstrapStatus() {
  return invoke("bootstrap_status");
}

export function getFeatureCatalog() {
  return invoke("feature_catalog");
}

export function getHealth() {
  return invoke("health_query");
}

export function listEntities(includeArchived = false) {
  return invoke("list_entities", { includeArchived });
}

export function upsertEntity(input: EntityInput) {
  return invoke("upsert_entity", { input });
}

export function importEntities(input: IpcRequests["import_entities"]["input"]) {
  return invoke("import_entities", { input });
}

export function listEntityRevisions(entityId: string) {
  return invoke("list_entity_revisions", { entityId });
}

export function setEntityArchived(input: IpcRequests["set_entity_archived"]) {
  return invoke("set_entity_archived", input);
}
export function listSummaryMaterials() { return invoke("list_summary_materials"); }
export function getSummaryMaterial(id: string, projectId: string) { return invoke("get_summary_material", { id, projectId }); }
export function upsertSummaryMaterial(material: SummaryMaterial) { return invoke("upsert_summary_material", { material }); }
export function listWritingCards(cardType?: string) { return invoke("list_writing_cards", { cardType }); }
export function getWritingCard(id: string, projectId: string) { return invoke("get_writing_card", { id, projectId }); }
export function upsertWritingCard(card: WritingCard) { return invoke("upsert_writing_card", { card }); }
export function setWritingCardEnabled(id: string, enabled: boolean) { return invoke("set_writing_card_enabled", { id, enabled }); }
export function setSummaryMaterialLifecycle(id: string, lifecycleStatus: string) { return invoke("set_summary_material_lifecycle", { id, lifecycleStatus }); }
export function rebuildSummaryMaterial(id: string) { return invoke("rebuild_summary_material", { id }); }
export function rebuildSearchIndex() { return invoke("rebuild_search_index"); }
export function searchProject(query: string, objectType?: string, limit = 50, offset = 0) { return invoke("search_project", { query, objectType, limit, offset }); }
export function createEvidenceAnchor(anchor: EvidenceAnchor) { return invoke("create_evidence_anchor", { anchor }); }
export function listEvidenceAnchors() { return invoke("list_evidence_anchors"); }
export function listCurrentFacts() { return invoke("list_current_facts"); }
export function createKnowledgeCandidate(candidate: KnowledgeCandidate) { return invoke("create_knowledge_candidate", { candidate }); }
export function listKnowledgeCandidates(chapterId: string) { return invoke("list_knowledge_candidates", { chapterId }); }
export function extractChapterCandidates(input: IpcRequests["extract_chapter_candidates"]["input"]) {
  return invoke("extract_chapter_candidates", { input });
}
export function listChapterExtractions(chapterId: string) {
  return invoke("list_chapter_extractions", { chapterId });
}
export function updateExtractionItem(input: IpcRequests["update_extraction_item"]) {
  return invoke("update_extraction_item", input);
}
export function decideExtractionItem(input: IpcRequests["decide_extraction_item"] & { decision: "DEFERRED" | "REJECTED" }) {
  return invoke("decide_extraction_item", input);
}
export function adoptExtractionItem(input: IpcRequests["adopt_extraction_item"]) {
  return invoke("adopt_extraction_item", input);
}

export function listDiscussionSessions() {
  return invoke("list_discussion_sessions");
}

export function createDiscussionSession(input: IpcRequests["create_discussion_session"]) {
  return invoke("create_discussion_session", input);
}

export function listDiscussionMessages(sessionId: string, limit = 100, beforeMessageId?: string) {
  return invoke("list_discussion_messages", { sessionId, limit, beforeMessageId });
}

export function getDiscussionWorkspace(sessionId: string) {
  return invoke("get_discussion_workspace", { sessionId });
}
export function saveDiscussionWorkspace(workspace: DiscussionWorkspace) {
  return invoke("save_discussion_workspace", { workspace });
}
export function listDiscussionDraftRevisions(sessionId: string, beforeVersion?: number) {
  return invoke("list_discussion_draft_revisions", { sessionId, beforeVersion });
}
export function listDiscussionDesignProposals(sessionId: string, beforeId?: string) {
  return invoke("list_discussion_design_proposals", { sessionId, beforeId });
}
export function summarizeDiscussionDesign(input: IpcRequests["summarize_discussion_design"]["input"]) {
  return invoke("summarize_discussion_design", { input });
}
export function confirmDiscussionDesign(id: string, entities: DiscussionDesignEntity[]) {
  return invoke("confirm_discussion_design", { id, entities });
}
export function listAuthorSettings() {
  return invoke("list_author_settings");
}

export function listDiscussionCandidates(sessionId: string) {
  return invoke("list_discussion_candidates", { sessionId });
}

export function createDiscussionCandidate(input: IpcRequests["create_discussion_candidate"]) {
  return invoke("create_discussion_candidate", input);
}

export function dismissDiscussionCandidate(input: IpcRequests["dismiss_discussion_candidate"]) {
  return invoke("dismiss_discussion_candidate", input);
}

export function promoteDiscussionCandidate(input: IpcRequests["promote_discussion_candidate"]) {
  return invoke("promote_discussion_candidate", input);
}

export function promoteDiscussionCandidateToForeshadowingReview(input: IpcRequests["promote_discussion_candidate_to_foreshadowing_review"]) {
  return invoke("promote_discussion_candidate_to_foreshadowing_review", input);
}

export function askProjectDiscussion(input: IpcRequests["ask_project_discussion"]["input"]) {
  return invoke("ask_project_discussion", { input });
}
export function reviewKnowledgeCandidate(input: IpcRequests["review_knowledge_candidate"]) {
  return invoke("review_knowledge_candidate", input);
}
export function detectCandidateConflicts(chapterId: string) { return invoke("detect_candidate_conflicts", { chapterId }); }
export function finalizeKnowledgeCandidates(input: IpcRequests["finalize_knowledge_candidates"]) {
  return invoke("finalize_knowledge_candidates", input);
}
export function rebuildWorldState(actor: string) { return invoke("rebuild_world_state", { actor }); }
export function createRelation(relation: Relation) { return invoke("create_relation", { relation }); }
export function updateRelation(relation: Relation, expectedVersion: number) { return invoke("update_relation", { relation, expectedVersion }); }
export function createEvent(event: Event) { return invoke("create_event", { event }); }
export function updateEvent(event: Event, expectedVersion: number) { return invoke("update_event", { event, expectedVersion }); }
export function createBelief(belief: Belief) { return invoke("create_belief", { belief }); }
export function updateBelief(belief: Belief, expectedVersion: number) { return invoke("update_belief", { belief, expectedVersion }); }
export function createForeshadowing(foreshadowing: Foreshadowing) { return invoke("create_foreshadowing", { foreshadowing }); }
export function updateForeshadowing(foreshadowing: Foreshadowing, expectedVersion: number) { return invoke("update_foreshadowing", { foreshadowing, expectedVersion }); }
export function listRelations() { return invoke("list_relations"); }
export function listEvents() { return invoke("list_events"); }
export function listBeliefs() { return invoke("list_beliefs"); }
export function listForeshadowings() { return invoke("list_foreshadowings"); }
export function assembleContextWithProjectKnowledge(input: AssembleContextInput) {
  const { knowledgeObjectIds, ...request } = input;
  return invoke("assemble_context_with_project_knowledge", { input: request, objectIds: knowledgeObjectIds });
}

export function getCurrentProject() {
  return invoke("current_project");
}

export function listRecentProjects() {
  return invoke("list_recent_projects");
}

export function createProject(root: string, name: string) {
  return invoke("create_project", { root, name });
}

export function openProject(root: string) {
  return invoke("open_project", { root });
}

export function closeProject() {
  return invoke("close_project");
}

export function listPlanNodes() {
  return invoke("list_plan_nodes");
}

export function listPlanningSections() {
  return invoke("list_planning_sections");
}

export function savePlanningSection(section: PlanningSection) {
  return invoke("save_planning_section_checked", { section, expectedVersion: section.version ?? 0 });
}

export function currentManuscriptDraft(chapterId: string) {
  return invoke("current_manuscript_draft", { chapterId });
}

export function saveManuscriptDraft(input: IpcRequests["save_manuscript_draft"]) {
  return invoke("save_manuscript_draft", input);
}

export function discardManuscriptDraft(input: IpcRequests["discard_manuscript_draft"]) {
  return invoke("discard_manuscript_draft", input);
}

export function commitManuscriptDraft(input: IpcRequests["commit_manuscript_draft"]) {
  return invoke("commit_manuscript_draft", input);
}
export function listPlanningEmbeddings() {
  return invoke("list_planning_embeddings");
}
export function generatePlanningEmbedding(profileId: string, sectionId: string) {
  return invoke("generate_planning_embedding", { profileId, sectionId });
}
export function clearPlanningEmbedding(sectionId: string) {
  return invoke("clear_planning_embedding", { sectionId });
}

export function createPlanNode(input: IpcRequests["create_plan_node"]) {
  return invoke("create_plan_node", input);
}

export function updatePlanNodeChecked(input: IpcRequests["update_plan_node_checked"]) {
  return invoke("update_plan_node_checked", input);
}

export function movePlanNode(input: IpcRequests["move_plan_node"]) {
  return invoke("move_plan_node", input);
}

export function currentManuscript(chapterId: string) {
  return invoke("current_manuscript", { chapterId });
}

export function listManuscriptRevisions(chapterId: string) {
  return invoke("list_manuscript_revisions", { chapterId });
}

export function adoptPlanBatch(input: PlanBatchInput) {
  return invoke("adopt_plan_batch", { input });
}
export function getDiscussionSource(request: DiscussionSourceRequest) {
  return invoke("get_discussion_source", { request });
}
export function listPlanningDiscussionSources(sectionId: string, projectId: string, limit = 20, offset = 0) {
  return invoke("list_planning_discussion_sources", { sectionId, projectId, limit, offset });
}
export function listEntityCards(includeArchived = false) {
  return invoke("list_entity_cards", { includeArchived });
}
export function getChapterEntityReferences(projectId: string, chapterId: string) {
  return invoke("get_chapter_entity_references", { projectId, chapterId });
}
export function saveChapterEntityReferences(input: IpcRequests["save_chapter_entity_references"]["input"]) {
  return invoke("save_chapter_entity_references", { input });
}
export function listEntityChapters(projectId: string, entityId: string) {
  return invoke("list_entity_chapters", { projectId, entityId });
}

export function getManuscriptSource(request: ManuscriptSourceRequest) {
  return invoke("get_manuscript_source", { request });
}

export function saveRecoveryLog(input: IpcRequests["save_recovery_log"]) {
  return invoke("save_recovery_log", input);
}

export function listRecoveryLogs(chapterId: string) {
  return invoke("list_recovery_logs", { chapterId });
}

export function listAllRecoveryLogs() {
  return invoke("list_all_recovery_logs");
}

export function clearRecoveryLogs(chapterId: string) {
  return invoke("clear_recovery_logs", { chapterId });
}

export function enqueueChapterSummaryRefresh(chapterId: string) {
  return invoke("enqueue_chapter_summary_refresh", { chapterId });
}
export function enqueueProjectSettingSummaryRefresh() {
  return invoke("enqueue_project_setting_summary_refresh");
}

export function mergeManuscript(input: IpcRequests["merge_manuscript"]) {
  return invoke("merge_manuscript", input);
}

export function listModelProfiles() {
  return invoke("list_model_profiles");
}

export function getAiTaskPreferences() {
  return invoke("get_ai_task_preferences");
}

export function saveAiTaskPreferences(preferences: AiTaskPreferences) {
  return invoke("save_ai_task_preferences", { preferences });
}
export function getAiBudgetSettings() {
  return invoke("get_ai_budget_settings");
}
export function saveAiBudgetSettings(settings: AiBudgetSettings) {
  return invoke("save_ai_budget_settings", { settings });
}
export function getWritingReviewPolicy() {
  return invoke("get_writing_review_policy");
}
export function saveWritingReviewPolicy(policy: WritingReviewPolicy) {
  return invoke("save_writing_review_policy", { policy });
}
export function getAuditFlowSettings() {
  return invoke("get_audit_flow_settings");
}
export function saveAuditFlowSettings(settings: AuditFlowSettings) {
  return invoke("save_audit_flow_settings", { settings });
}
export function getProjectAiTaskOverrides() {
  return invoke("get_project_ai_task_overrides");
}
export function saveProjectAiTaskOverride(task: keyof AiTaskPreferences, preference: AiTaskPreference) {
  return invoke("save_project_ai_task_override", { task, preference });
}
export function saveProjectAiTaskOverrides(preferences: AiTaskPreferences) {
  return invoke("save_project_ai_task_overrides", { preferences });
}
export function removeProjectAiTaskOverride(task: keyof AiTaskPreferences) {
  return invoke("remove_project_ai_task_override", { task });
}

export function upsertModelProfile(input: ModelProfileInput) {
  return invoke("upsert_model_profile", { input });
}

export function saveModelSecret(profileId: string, secret: string) {
  return invoke("save_model_secret", { profileId, secret });
}

export function deleteModelSecret(profileId: string) {
  return invoke("delete_model_secret", { profileId });
}

export function testModelProfile(profileId: string) {
  return invoke("test_model_profile", { profileId });
}

export function extractEntitiesFromText(profileId: string, entityType: EntityType, entityName: string, briefSummary: string, applicabilityScope: string, sourceText: string, userGuidance?: string, temperature?: number, maxOutputTokens?: number) {
  return invoke("extract_entities_from_text", { input: { profileId, entityType, entityName, briefSummary, applicabilityScope, sourceText, userGuidance, temperature, maxOutputTokens } });
}

export function listAiProposals(input: IpcRequests["list_ai_proposals"]) {
  return invoke("list_ai_proposals", input);
}
export function getConsistencyReviewTrace(proposalId: string) {
  return invoke("get_consistency_review_trace", { proposalId });
}
export function listAiRuns(limit?: number) {
  return invoke("list_ai_runs", { limit });
}
export function getAiRunRequest(runId: string) {
  return invoke("get_ai_run_request", { runId });
}
export function getAiUsageSummary(days = 30) {
  return invoke("get_ai_usage_summary", { days });
}
export function getAiQualitySummary(limit = 20, days = 90) {
  return invoke("get_ai_quality_summary", { limit, days });
}
export function rateAiProposal(id: string, rating: "HELPFUL" | "NOT_HELPFUL", note?: string) {
  return invoke("rate_ai_proposal", { id, rating, note });
}

export function generateAiProposal(input: IpcRequests["generate_ai_proposal"]) {
  return invoke("generate_ai_proposal", input);
}

export function generatePlanningContent(input: IpcRequests["generate_planning_content"]) {
  return invoke("generate_planning_content", input);
}

export function enqueuePlanningAiJob(input: PlanningAiJobInput) {
  return invoke("enqueue_planning_ai_job", { input });
}
export function getPlanningAiJobRequest(jobId: string) {
  return invoke("get_planning_ai_job_request", { jobId });
}

export function cancelAiTask(taskId: string) {
  return invoke("cancel_ai_task", { taskId });
}

export function listJobs() { return invoke("list_jobs"); }
export function listJobEvents(jobId: string) { return invoke("list_job_events", { jobId }); }
export function enqueueJob(jobType: JobType, payload = "{}") {
  return invoke("enqueue_job", { jobType, payload });
}
export function cancelJob(id: string) { return invoke("cancel_job", { id }); }
export function retryJob(id: string) { return invoke("retry_job", { id }); }
export function acknowledgeFailedJobs() { return invoke("acknowledge_failed_jobs"); }
export function claimNextJob() { return invoke("claim_next_job"); }
export function runNextJob() { return invoke("run_next_job"); }
export function healthScan() { return invoke("health_scan"); }
export function startupRecoveryReport() { return invoke("startup_recovery_report"); }
export function createDiagnosticPackage() { return invoke("create_diagnostic_package"); }

export function decideAiProposal(input: IpcRequests["decide_ai_proposal"] & { status: Exclude<AiProposalStatus, "PENDING"> }) {
  return invoke("decide_ai_proposal", input);
}

export function invalidateProjectQueries(queryClient: { invalidateQueries: (options: { queryKey: string[] }) => Promise<unknown> }) {
  const projectKeys = [
    ["current-project"], ["health"], ["entities"], ["entity-revisions"], ["summary-materials"],
    ["writing-cards"], ["plan-nodes"], ["planning-sections"], ["current-facts"], ["evidence-anchors"],
    ["relations"], ["events"], ["beliefs"], ["foreshadowings"], ["knowledge-candidates"],
    ["knowledge-conflicts"], ["project-search"], ["jobs"], ["recovery-all"], ["manuscript"],
    ["manuscript-draft"], ["manuscript-history"], ["manuscript-source"], ["recovery-logs"], ["ai-proposals"], ["ai-runs"],
    ["planning-discussion-sources"], ["discussion-source"], ["entity-cards"],
    ["chapter-entity-references"], ["entity-chapters"],
    ["project-ai-task-overrides"], ["writing-review-policy"],
  ];
  return Promise.all([
    ...projectKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    queryClient.invalidateQueries({ queryKey: ["recent-projects"] }),
  ]);
}
