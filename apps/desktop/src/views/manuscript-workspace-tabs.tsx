import { BookOpenText, FileClock, FilePlus2, PenLine } from "lucide-react";
import { WorkspaceTabs } from "./workspace-tabs";

export type ManuscriptWorkspaceTab = "manuscript" | "candidate" | "versions" | "extraction";

const tabs = [
  { value: "manuscript", label: "正文浏览", icon: BookOpenText },
  { value: "candidate", label: "候选区", icon: PenLine },
  { value: "versions", label: "草稿与版本", icon: FileClock },
  { value: "extraction", label: "知识提取", icon: FilePlus2 },
] as const;

export function ManuscriptWorkspaceTabs(props: { value: ManuscriptWorkspaceTab; onChange: (value: ManuscriptWorkspaceTab) => void; recoveryCount: number; candidateDirty: boolean }) {
  const items = tabs.map((tab) => ({
    ...tab,
    badge: tab.value === "candidate" && props.candidateDirty
      ? <span className="tab-count tab-count-info">待同步</span>
      : tab.value === "versions" && props.recoveryCount > 0
        ? <span className="tab-count" aria-label={`${props.recoveryCount} 次自动保护待处理`}>待处理</span>
        : null,
  }));
  return <WorkspaceTabs prefix="manuscript" label="正文工作区页签" tabs={items} value={props.value} onChange={props.onChange} />;
}
