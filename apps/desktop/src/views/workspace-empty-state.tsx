import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import "./workspace-empty-state.css";

type WorkspaceEmptyStateProps = {
  icon: LucideIcon;
  title: string;
  headingLevel?: 2 | 3;
  children?: ReactNode;
};

export function WorkspaceEmptyState({ icon: Icon, title, headingLevel = 3, children }: WorkspaceEmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return <div className="workspace-empty-state">
    <span className="workspace-empty-mark" aria-hidden="true"><Icon size={28} strokeWidth={1.5} /></span>
    <div className="workspace-empty-copy"><Heading>{title}</Heading></div>
    {children ? <div className="workspace-empty-actions">{children}</div> : null}
  </div>;
}
