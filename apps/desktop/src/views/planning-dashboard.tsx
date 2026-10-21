import { ArrowRight, BookOpen, CheckCircle2, Circle, ListTree, NotebookPen, Settings2 } from "lucide-react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { buildPreparationStages, preparationProgress, preparationStatus } from "./creation-preparation";

type PlanningDashboardProps = {
  chapterNodes: PlanNode[];
  isChapterMode: boolean;
  onOpenFirstChapter: () => void;
  onCreateChapter?: () => void;
  onOpenPreferences?: () => void;
  onOpenDirection?: () => void;
  onOpenStructure?: () => void;
  nodes?: PlanNode[];
  sections?: PlanningSection[];
};

export function PlanningDashboard(props: PlanningDashboardProps) {
  if (!props.isChapterMode) {
    const stages = buildPreparationStages(props.nodes ?? []);
    const progress = preparationProgress(stages, props.sections ?? []);
    return <main className="planning-overview" aria-label="规划总览">
      <h2>规划总览</h2>
      <div className="planning-overview-next"><span>{progress.ready ? "开篇关键准备已确认" : `${progress.missing.length} 项关键准备待确认`}</span>
        <a className="secondary-action" href={`/planning?mode=prepare&item=${progress.missing[0]?.id ?? "outline"}`}>
          {progress.ready ? "查看主线与准备" : "继续当前准备"}<ArrowRight size={14} /></a></div>
      <ol className="planning-stage-ledger">{stages.map((stage) => {
        const required = stage.items.filter((item) => item.required);
        const done = required.filter((item) => preparationStatus((props.sections ?? []).find((section) => section.id === item.sectionId), props.sections ?? []) === "confirmed").length;
        return <li key={stage.id}>{done === required.length ? <CheckCircle2 size={17} /> : <Circle size={17} />}
          <div><strong>{stage.title}</strong><p>{stage.outcome}</p></div><span>{done} / {required.length}</span>
          <a href={`/planning?mode=prepare&item=${stage.items[0].id}`} aria-label={`审阅${stage.title}`} title={`审阅${stage.title}`}><ArrowRight size={16} /></a></li>;
      })}</ol>
      <div className="planning-overview-actions">
        <button type="button" className="secondary-action" onClick={props.onOpenPreferences}><Settings2 size={15} />本书偏好</button>
        <button type="button" className="secondary-action" onClick={props.onOpenDirection}><NotebookPen size={15} />审阅主线大纲</button>
        <button type="button" className="primary-action" onClick={props.onOpenStructure}><ListTree size={15} />分卷与章节计划</button>
      </div>
    </main>;
  }
  return <main className="workspace-empty" aria-label={props.isChapterMode ? "正文工作区" : "大纲工作区"}>
    <BookOpen size={28} />
    <h2>{props.isChapterMode ? props.chapterNodes.length ? "选择章节" : "故事尚未开始" : "大纲"}</h2>
    {!props.chapterNodes.length ? <a href="/planning?mode=prepare" className="primary-action"><NotebookPen size={15} />开始创作准备</a> : null}
    {props.isChapterMode && props.chapterNodes.length ? <button type="button" className="primary-action" onClick={props.onOpenFirstChapter}>
      <BookOpen size={15} />打开章节</button> : null}
  </main>;
}
