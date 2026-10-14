import { useEffect, useLayoutEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspacePreferences } from "./workspace-preferences";
import "./workspace-theme.css";

export function useWorkspaceTheme() {
  const { theme } = useWorkspacePreferences();
  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWindow().setTheme(theme === "system" ? null : theme)
      .catch((cause: unknown) => { console.warn("Unable to update native window theme.", cause); });
  }, [theme]);
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? media?.matches ? "dark" : "light" : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [theme]);
}
