import { BookOpen, Plus } from "lucide-react";
import type { PlanNode } from "../lib/tauri-client";

type PlanningDashboardProps = {
  chapterNodes: PlanNode[];
  isChapterMode: boolean;
  onOpenFirstChapter: () => void;
  onCreateChapter?: () => void;
};

export function PlanningDashboard(props: PlanningDashboardProps) {
  return <main className="workspace-empty" aria-label={props.isChapterMode ? "正文工作区" : "大纲工作区"}>
    <BookOpen size={28} />
    <h2>{props.isChapterMode ? props.chapterNodes.length ? "选择章节" : "还没有章节" : "选择大纲内容"}</h2>
    {props.isChapterMode ? <button type="button" className="primary-action" onClick={props.chapterNodes.length ? props.onOpenFirstChapter : props.onCreateChapter}>
      <Plus size={15} />{props.chapterNodes.length ? "打开章节" : "创建第一章"}</button> : null}
  </main>;
}
