import { ArrowRight, FileCheck2, Sparkles, UsersRound } from "lucide-react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";

type PlanningDashboardProps = {
  chapterNodes: PlanNode[];
  chapterWithoutPlan: PlanNode | undefined;
  chaptersWithPlan: number;
  isChapterMode: boolean;
  onContinuePlanning: () => Promise<void>;
  onOpenChapterStructure: () => void;
  onOpenFirstChapter: () => void;
  onOpenOutline: () => void;
  onOpenWorkDesign: () => void;
  outlineNode: PlanNode | undefined;
  outlinePlan: PlanningSection | undefined;
  planningHeadline: string;
  volumeNodes: PlanNode[];
  volumePlanReady: boolean;
  workDesignNode: PlanNode | undefined;
  workDesignReady: boolean;
  workspaceMode: "planning" | "chapters" | "writing";
};

export function PlanningDashboard(props: PlanningDashboardProps) {
  const dashboardLabel = props.workspaceMode === "chapters" ? "章节工作台总览" : props.workspaceMode === "writing" ? "正文工作区总览" : "项目规划总览";
  return <main className={`planning-dashboard${props.isChapterMode ? " writing-mode" : ""}`} aria-label={dashboardLabel}>
    <div className="planning-overview">
      <div className="planning-overview-heading"><div><span className="planning-kicker">{props.workspaceMode === "chapters" ? "章节工作台" : props.workspaceMode === "writing" ? "正文工作区" : "建议下一步"}</span><h2>{props.isChapterMode ? (props.chapterNodes.length ? props.workspaceMode === "chapters" ? "选择章节开始准备" : "选择章节开始写作" : "还没有章节") : props.planningHeadline}</h2><p>{props.isChapterMode ? (props.chapterNodes.length ? props.workspaceMode === "chapters" ? "从执行卡开始，依次准备、检查创作条件并生成正文候选。" : "在候选区编辑，需要时审核，确认后同步正文，最后提取知识并集中确认事实。" : "请先在规划页创建章节，再进入后续工作。") : "按当前流程完成作品设定后，将依次开放故事大纲、分卷管理和章节规划。"}</p></div>{props.isChapterMode ? props.chapterNodes[0] ? <button type="button" className="primary-action" onClick={props.onOpenFirstChapter}><ArrowRight size={15} />打开第1章</button> : <a className="primary-action" href="/planning"><ArrowRight size={15} />前往规划页</a> : <button type="button" className="primary-action" onClick={() => void props.onContinuePlanning()}><ArrowRight size={15} />继续下一步</button>}</div>
      <div className="planning-stage-grid"><button type="button" className="planning-stage" data-state={props.workDesignReady ? "done" : props.workDesignNode ? "active" : "idle"} onClick={props.onOpenWorkDesign}><span className="planning-stage-index">01</span><div><strong>作品设定</strong><small>完成后开放故事大纲</small></div><span className="planning-stage-count">{props.workDesignReady ? "已完成" : "进行中"}</span></button><button type="button" className="planning-stage" data-state={props.outlinePlan?.content.trim() ? "done" : props.outlineNode ? props.workDesignReady ? "active" : "idle" : "idle"} onClick={props.onOpenOutline}><span className="planning-stage-index">02</span><div><strong>故事大纲</strong><small>{props.workDesignReady ? "开放主线规划" : "完成作品设定后开放"}</small></div><span className="planning-stage-count">{!props.workDesignReady ? "未开放" : props.outlinePlan?.content.trim() ? "已完成" : "进行中"}</span></button><button type="button" className="planning-stage" data-state={props.chapterNodes.length && props.chaptersWithPlan === props.chapterNodes.length ? "done" : props.volumePlanReady || props.chapterNodes.length ? "active" : "idle"} onClick={props.onOpenChapterStructure}><span className="planning-stage-index">03</span><div><strong>{props.volumePlanReady ? "拆章节" : "分卷与章节"}</strong><small>{!props.outlinePlan?.content.trim() ? "完成故事大纲后开放" : props.volumePlanReady ? "为各分卷建立章节结构" : "开放分卷管理和章节规划"}</small></div><span className="planning-stage-count">{!props.outlinePlan?.content.trim() ? "未开放" : props.volumePlanReady && !props.chapterNodes.length ? "待拆章节" : props.chapterNodes.length ? `${props.chaptersWithPlan}/${props.chapterNodes.length}` : "已开放"}</span></button></div>
      <div className="planning-overview-links"><span><UsersRound size={14} />人物、地点和规则放在知识库</span><span><FileCheck2 size={14} />章节完成后沉淀事实</span><span><Sparkles size={14} />AI 提供候选，由你定稿</span><span>{props.volumeNodes.length ? `已规划 ${props.volumeNodes.length} 卷` : "建议先规划分卷"}</span></div>
    </div>
  </main>;
}
