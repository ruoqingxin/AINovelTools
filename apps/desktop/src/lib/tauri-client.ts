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
export type RecoveryLog = { id: string; chapterId: string; documentJson: string; createdAt: string };
export type MergeConflict = { blockId: string; base?: string; current?: string; draft?: string };
export type MergeResult = { documentJson: string; conflicts: MergeConflict[] };
export type ModelProvider = "SILICON_FLOW" | "DEEPSEEK" | "OPEN_AI" | "OPEN_AI_COMPATIBLE";
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

export function decideAiProposal(input: { id: string; status: Exclude<AiProposalStatus, "PENDING">; acceptedText?: string }) {
  return invoke<AiProposal>("decide_ai_proposal", input);
}

export function invalidateProjectQueries(queryClient: { invalidateQueries: (options: { queryKey: string[] }) => Promise<unknown> }) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["current-project"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
  ]);
}
