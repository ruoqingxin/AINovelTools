import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

type WorkspaceTab<T extends string> = {
  value: T;
  label: string;
  icon: LucideIcon;
  badge?: ReactNode;
};

export function WorkspaceTabs<T extends string>({
  prefix,
  label,
  value,
  tabs,
  onChange,
}: {
  prefix: string;
  label: string;
  value: T;
  tabs: readonly WorkspaceTab<T>[];
  onChange: (value: T) => void;
}) {
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
      case "ArrowLeft": nextIndex = (index - 1 + tabs.length) % tabs.length; break;
      case "Home": nextIndex = 0; break;
      case "End": nextIndex = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${prefix}-tab-${next.value}`)?.focus());
  }

  return <div className="chapter-tabs" role="tablist" aria-label={label}>
    {tabs.map(({ value: tabValue, label: tabLabel, icon: Icon, badge }, index) => <button
      type="button"
      role="tab"
      aria-label={tabLabel}
      id={`${prefix}-tab-${tabValue}`}
      aria-controls={`${prefix}-panel-${tabValue}`}
      aria-selected={value === tabValue}
      tabIndex={value === tabValue ? 0 : -1}
      data-active={value === tabValue || undefined}
      key={tabValue}
      onClick={() => onChange(tabValue)}
      onKeyDown={(event) => moveFocus(event, index)}
    >
      <Icon size={14} strokeWidth={1.8} />
      <span>{tabLabel}</span>
      {badge}
    </button>)}
  </div>;
}
