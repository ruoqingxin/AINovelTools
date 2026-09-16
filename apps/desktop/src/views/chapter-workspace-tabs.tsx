import { ClipboardCheck, ClipboardList, Sparkles } from "lucide-react";
import type { KeyboardEvent } from "react";

export type ChapterWorkspaceTab = "plan" | "readiness" | "ai";

const tabs = [
  { value: "plan", label: "章节执行卡", icon: ClipboardList },
  { value: "readiness", label: "创作准备", icon: ClipboardCheck },
  { value: "ai", label: "AI 创作", icon: Sparkles },
] as const;

export function ChapterWorkspaceTabs(props: { value: ChapterWorkspaceTab; onChange: (value: ChapterWorkspaceTab) => void }) {
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    props.onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`chapter-tab-${next.value}`)?.focus());
  }

  return <div className="chapter-tabs" role="tablist" aria-label="章节工作区页签">
    {tabs.map(({ value, label, icon: Icon }, index) => <button
      type="button"
      role="tab"
      id={`chapter-tab-${value}`}
      aria-controls={`chapter-panel-${value}`}
      aria-selected={props.value === value}
      tabIndex={props.value === value ? 0 : -1}
      data-active={props.value === value || undefined}
      key={value}
      onClick={() => props.onChange(value)}
      onKeyDown={(event) => moveFocus(event, index)}
    >
      <Icon size={14} strokeWidth={1.8} />
      <span>{label}</span>
    </button>)}
  </div>;
}
