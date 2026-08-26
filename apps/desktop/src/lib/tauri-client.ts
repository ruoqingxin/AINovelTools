import { invoke } from "@tauri-apps/api/core";

export type BootstrapStatus = {
  appVersion: string;
  layers: ["domain", "application", "infrastructure"];
};

export type DatabaseHealth = {
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
  documentJson: string;
  contentHash: string;
  creationReason: string;
};

export function getBootstrapStatus() {
  return invoke<BootstrapStatus>("bootstrap_status");
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

export function currentManuscript(chapterId: string) {
  return invoke<ManuscriptRevision | null>("current_manuscript", { chapterId });
}

export function saveManuscript(input: { chapterId: string; documentJson: string; creationReason: string }) {
  return invoke<ManuscriptRevision>("save_manuscript", input);
}

export function invalidateProjectQueries(queryClient: { invalidateQueries: (options: { queryKey: string[] }) => Promise<unknown> }) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["current-project"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
  ]);
}
