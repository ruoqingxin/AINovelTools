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
