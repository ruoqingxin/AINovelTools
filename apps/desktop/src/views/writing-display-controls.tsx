import { Maximize2, Minimize2, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import { updateWorkspacePreferences, useWorkspacePreferences } from "../lib/workspace-preferences";

export function WritingDisplayControls({ focused, onFocusChange }: { focused: boolean; onFocusChange: (value: boolean) => void }) {
  const preferences = useWorkspacePreferences();
  const menu = useRef<HTMLDetailsElement>(null);
  function constrainMenu() {
    const panel = menu.current?.querySelector<HTMLElement>(".writing-display-menu");
    if (panel && menu.current?.open) {
      const bottom = panel.closest(".creation-main")?.getBoundingClientRect().bottom ?? window.innerHeight;
      const available = window.innerHeight <= 560 ? window.innerHeight - 108 : bottom - panel.getBoundingClientRect().top - 12;
      panel.style.maxHeight = `${Math.max(40, available)}px`;
    }
  }
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const element = menu.current;
      if (element && event.target instanceof Node && !element.contains(event.target)) element.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", constrainMenu);
    document.addEventListener("scroll", constrainMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", constrainMenu);
      document.removeEventListener("scroll", constrainMenu, true);
    };
  }, []);
  if (focused) return <button type="button" className="icon-command" title="退出专注模式" aria-label="退出专注模式"
    onClick={() => onFocusChange(false)}><Minimize2 size={17} /></button>;
  return <details ref={menu} className="writing-display-controls" onToggle={constrainMenu}>
    <summary className="icon-command" title="写作显示设置" aria-label="写作显示设置"><SlidersHorizontal size={17} /></summary>
    <div className="writing-display-menu">
      <label>字号 <output>{preferences.fontSize}px</output><input aria-label="正文字号" type="range" min={14} max={24} step={1}
        value={preferences.fontSize} onChange={(event) => updateWorkspacePreferences({ fontSize: Number(event.target.value) })} /></label>
      <label>行距 <output>{preferences.lineHeight.toFixed(1)}</output><input aria-label="正文行距" type="range" min={1.4} max={2.4} step={0.1}
        value={preferences.lineHeight} onChange={(event) => updateWorkspacePreferences({ lineHeight: Number(event.target.value) })} /></label>
      <label>阅读宽度 <output>{preferences.readingWidth}px</output><input aria-label="正文阅读宽度" type="range" min={560} max={1200} step={40}
        value={preferences.readingWidth} onChange={(event) => updateWorkspacePreferences({ readingWidth: Number(event.target.value) })} /></label>
      <button type="button" className="secondary-action" onClick={() => { if (menu.current) menu.current.open = false; onFocusChange(true); }}>
        <Maximize2 size={15} />进入专注模式</button>
    </div>
  </details>;
}
