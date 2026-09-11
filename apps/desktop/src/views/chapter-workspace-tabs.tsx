import { BookOpenText, History, RotateCcw, Sparkles } from "lucide-react";
import type { KeyboardEvent } from "react";

export type ChapterWorkspaceTab = "editor" | "ai" | "revisions" | "recovery";

const tabs = [
  { value: "editor", label: "正文编辑", icon: BookOpenText },
  { value: "ai", label: "AI 创作", icon: Sparkles },
  { value: "revisions", label: "修订与冲突", icon: History },
  { value: "recovery", label: "恢复草稿", icon: RotateCcw },
] as const;

export function ChapterWorkspaceTabs(props: { value: ChapterWorkspaceTab; onChange: (value: ChapterWorkspaceTab) => void; recoveryCount: number }) {
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
      {value === "recovery" && props.recoveryCount > 0 ? <span className="tab-count" aria-label={`${props.recoveryCount} 条恢复草稿`}>{props.recoveryCount}</span> : null}
    </button>)}
  </div>;
}
