import { BookOpenText, FileClock, FilePlus2, PenLine, ShieldCheck } from "lucide-react";
import type { KeyboardEvent } from "react";

export type ManuscriptWorkspaceTab = "manuscript" | "candidate" | "review" | "versions" | "extraction";

const tabs = [
  { value: "manuscript", label: "正文浏览", icon: BookOpenText },
  { value: "candidate", label: "候选区", icon: PenLine },
  { value: "review", label: "正文审核", icon: ShieldCheck },
  { value: "versions", label: "草稿与版本", icon: FileClock },
  { value: "extraction", label: "知识提取", icon: FilePlus2 },
] as const;

export function ManuscriptWorkspaceTabs(props: { value: ManuscriptWorkspaceTab; onChange: (value: ManuscriptWorkspaceTab) => void; recoveryCount: number; candidateDirty: boolean }) {
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
    requestAnimationFrame(() => document.getElementById(`manuscript-tab-${next.value}`)?.focus());
  }

  return <div className="chapter-tabs" role="tablist" aria-label="正文工作区页签">
    {tabs.map(({ value, label, icon: Icon }, index) => <button
      type="button"
      role="tab"
      aria-label={label}
      id={`manuscript-tab-${value}`}
      aria-controls={`manuscript-panel-${value}`}
      aria-selected={props.value === value}
      tabIndex={props.value === value ? 0 : -1}
      data-active={props.value === value || undefined}
      key={value}
      onClick={() => props.onChange(value)}
      onKeyDown={(event) => moveFocus(event, index)}
    >
      <Icon size={14} strokeWidth={1.8} />
      <span>{label}</span>
      {value === "candidate" && props.candidateDirty ? <span className="tab-count tab-count-info">待同步</span> : null}
      {value === "versions" && props.recoveryCount > 0 ? <span className="tab-count" aria-label={`${props.recoveryCount} 次自动保护待处理`}>待处理</span> : null}
    </button>)}
  </div>;
}
