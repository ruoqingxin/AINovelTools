import { invoke } from "@tauri-apps/api/core";

export type BootstrapStatus = {
  appVersion: string;
  layers: ["domain", "application", "infrastructure"];
};

export function getBootstrapStatus() {
  return invoke<BootstrapStatus>("bootstrap_status");
}
