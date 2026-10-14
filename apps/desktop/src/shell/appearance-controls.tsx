import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef } from "react";
import { updateWorkspacePreferences, useWorkspacePreferences, type WorkspacePreferences } from "../lib/workspace-preferences";
import "./appearance-controls.css";

const themes = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

export function AppearanceControls() {
  const { theme } = useWorkspacePreferences();
  const menu = useRef<HTMLDetailsElement>(null);
  const Icon = themes.find((item) => item.value === theme)!.icon;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current?.open) return;
      event.preventDefault(); event.stopPropagation();
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, []);
  function choose(value: WorkspacePreferences["theme"]) {
    updateWorkspacePreferences({ theme: value });
    if (menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); }
  }
  return <details ref={menu} className="appearance-controls">
    <summary className="shell-icon" aria-label="外观" title="外观"><Icon size={19} /></summary>
    <div className="appearance-menu" role="group" aria-label="界面主题">
      {themes.map(({ value, label, icon: ThemeIcon }) => <button key={value} type="button"
        aria-pressed={theme === value} onClick={() => choose(value)}>
        <ThemeIcon size={16} /><span>{label}</span>{theme === value ? <Check size={15} /> : null}
      </button>)}
    </div>
  </details>;
}
