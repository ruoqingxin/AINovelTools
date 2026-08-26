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

export function getBootstrapStatus() {
  return invoke<BootstrapStatus>("bootstrap_status");
}

export function getHealth() {
  return invoke<DatabaseHealth>("health_query");
}
