import { BookOpen, NotebookPen, Plus, Settings2 } from "lucide-react";
import type { PlanNode } from "../lib/tauri-client";

type PlanningDashboardProps = {
  chapterNodes: PlanNode[];
  isChapterMode: boolean;
  onOpenFirstChapter: () => void;
  onCreateChapter?: () => void;
  onOpenPreferences?: () => void;
  onOpenDirection?: () => void;
};

export function PlanningDashboard(props: PlanningDashboardProps) {
  return <main className="workspace-empty" aria-label={props.isChapterMode ? "正文工作区" : "大纲工作区"}>
    <BookOpen size={28} />
    <h2>{props.isChapterMode ? props.chapterNodes.length ? "选择章节" : "故事尚未开始" : "大纲"}</h2>
    {!props.chapterNodes.length ? <a href="/preparation" className="primary-action"><NotebookPen size={15} />开始创作准备</a> : null}
    {!props.isChapterMode ? <div className="planning-start-actions">
      <button type="button" className="secondary-action" onClick={props.onOpenPreferences}><Settings2 size={15} />本书偏好</button>
      <button type="button" className="secondary-action" onClick={props.onOpenDirection}><NotebookPen size={15} />故事方向</button>
      <button type="button" className="primary-action" onClick={props.onCreateChapter}><Plus size={15} />新建章节</button>
    </div> : null}
    {props.isChapterMode && props.chapterNodes.length ? <button type="button" className="primary-action" onClick={props.onOpenFirstChapter}>
      <BookOpen size={15} />打开章节</button> : null}
  </main>;
}
