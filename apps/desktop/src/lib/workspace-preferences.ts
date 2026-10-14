import { useState, useSyncExternalStore } from "react";

export type WorkspacePreferences = {
  theme: "light" | "dark" | "system";
  fontSize: number;
  lineHeight: number;
  readingWidth: number;
  layouts: Record<string, boolean>;
};
const key = "ainoveltools:workspace-preferences:v1";
const changed = "workspace-preferences-changed";
const defaults: WorkspacePreferences = { theme: "light", fontSize: 16, lineHeight: 1.9, readingWidth: 920, layouts: {} };
let cachedRaw: string | null | undefined;
let cached = defaults;

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const input = value && typeof value === "object" ? value as Partial<WorkspacePreferences> : {};
  return {
    theme: input.theme === "dark" || input.theme === "system" ? input.theme : "light",
    fontSize: bounded(input.fontSize, 16, 14, 24),
    lineHeight: bounded(input.lineHeight, 1.9, 1.4, 2.4),
    readingWidth: bounded(input.readingWidth, 920, 560, 1200),
    layouts: Object.fromEntries(Object.entries(input.layouts && typeof input.layouts === "object" ? input.layouts : {})
      .filter(([name, enabled]) => name.length < 200 && typeof enabled === "boolean")),
  };
}
function snapshot() {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      try { cached = normalizeWorkspacePreferences(raw ? JSON.parse(raw) : null); }
      catch { cached = defaults; }
    }
  } catch { /* Keep preferences in memory if browser storage is unavailable. */ }
  return cached;
}
function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener("storage", listener); };
}
export function updateWorkspacePreferences(update: Partial<WorkspacePreferences> | ((current: WorkspacePreferences) => Partial<WorkspacePreferences>)) {
  const current = snapshot();
  cached = normalizeWorkspacePreferences({ ...current, ...(typeof update === "function" ? update(current) : update) });
  try {
    const raw = JSON.stringify(cached);
    localStorage.setItem(key, raw);
    cachedRaw = raw;
  } catch { /* Preferences must never block manuscript edits. */ }
  window.dispatchEvent(new Event(changed));
}
export function useWorkspacePreferences() {
  return useSyncExternalStore(subscribe, snapshot, () => defaults);
}
export function useLayoutPreference(name: string, fallback: boolean, remember = true) {
  const preferences = useWorkspacePreferences();
  const [temporary, setTemporary] = useState(fallback);
  const value = remember ? preferences.layouts[name] ?? fallback : temporary;
  const setValue = (update: boolean | ((current: boolean) => boolean)) => {
    if (!remember) { setTemporary(update); return; }
    updateWorkspacePreferences((current) => ({
      layouts: { ...current.layouts, [name]: typeof update === "function" ? update(current.layouts[name] ?? fallback) : update },
    }));
  };
  return [value, setValue] as const;
}
