import { ClipboardCheck, ClipboardList, Sparkles } from "lucide-react";
import { WorkspaceTabs } from "./workspace-tabs";

export type ChapterWorkspaceTab = "plan" | "readiness" | "ai";

const tabs = [
  { value: "plan", label: "章节执行卡", icon: ClipboardList },
  { value: "readiness", label: "创作准备", icon: ClipboardCheck },
  { value: "ai", label: "AI 创作", icon: Sparkles },
] as const;

export function ChapterWorkspaceTabs(props: { value: ChapterWorkspaceTab; onChange: (value: ChapterWorkspaceTab) => void }) {
  return <WorkspaceTabs prefix="chapter" label="章节工作区页签" tabs={tabs} value={props.value} onChange={props.onChange} />;
}
