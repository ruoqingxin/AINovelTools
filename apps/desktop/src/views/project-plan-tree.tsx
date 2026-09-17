import { BookOpen, ChevronDown, ChevronRight, Eye, EyeOff, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { isPlanningSectionSettled } from "../lib/writing-readiness";
import {
  essentialPlanningSectionIds,
  planningSectionGroups,
  planningStoryStateLabels,
} from "./story-planning-workbench";
import { isRootKind, kindLabels, rootDefinitions, rootSectionLabel } from "./project-workspace-utils";

type ProjectPlanTreeProps = {
  chapterMode: boolean;
  chapterListCollapsed: boolean;
  chapterNodes: PlanNode[];
  expandedPlanningGroups: Set<string>;
  onCollapseChapterList: () => void;
  onCreateStarterNode: (kind: PlanNode["kind"], title: string) => Promise<void>;
  onExpandChapterList: () => void;
  onSelectNode: (node: PlanNode) => void;
  onSelectOverview: () => void;
  onSelectPlanningSection: (node: PlanNode, sectionId: string) => void;
  onToggleArchived: () => void;
  onTogglePlanningGroup: (groupId: string) => void;
  onToggleWorkDesign: () => void;
  planningSections: PlanningSection[];
  rootNodeFor: (kind: PlanNode["kind"]) => PlanNode | undefined;
  selectedId: string | null;
  selectedPlanningSectionId: string;
  showArchived: boolean;
  unorganizedRoots: PlanNode[];
  visibleNodes: PlanNode[];
  workDesignExpanded: boolean;
};

export function ProjectPlanTree(props: ProjectPlanTreeProps) {
  function renderNode(node: PlanNode, depth = 0): ReactNode {
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row" data-kind={node.kind.toLowerCase()} data-selected={props.selectedId === node.id && node.kind !== "WORK_DESIGN" || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => { props.onSelectNode(node); if (node.kind === "WORK_DESIGN") props.onToggleWorkDesign(); }}>
          {node.kind === "WORK_DESIGN" ? props.workDesignExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}{!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.title}</span>
        </button>
        {node.kind === "WORK_DESIGN" && !node.archived && props.workDesignExpanded ? <div className="plan-design-tree">{planningSectionGroups.map((group) => { const expanded = props.expandedPlanningGroups.has(group.id); return <div className="plan-design-group" key={group.id}><button type="button" className="plan-design-group-heading" aria-expanded={expanded} onClick={() => props.onTogglePlanningGroup(group.id)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{group.label}</strong><span>{group.children.filter((item) => isPlanningSectionSettled(props.planningSections.find((section) => section.id === item.id))).length}/{group.children.length}</span></button>{expanded ? group.children.map((item) => { const section = props.planningSections.find((candidate) => candidate.id === item.id); const completed = isPlanningSectionSettled(section); const essential = essentialPlanningSectionIds.includes(item.id as (typeof essentialPlanningSectionIds)[number]); return <button type="button" className="plan-design-item" data-selected={props.selectedId === node.id && props.selectedPlanningSectionId === item.id || undefined} key={item.id} onClick={() => props.onSelectPlanningSection(node, item.id)}><span>{item.label}</span><small>{completed && section ? planningStoryStateLabels[section.storyState] : essential ? "核心" : "待明确"}</small></button>; }) : null}</div>; })}</div> : null}
        {props.visibleNodes.filter((child) => child.parentId === node.id && (props.chapterMode || child.kind !== "SCENE")).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  function renderWritingNode(node: PlanNode, depth = 0): ReactNode {
    if (node.archived && !props.showArchived) return null;
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row writing-tree-row" data-kind={node.kind.toLowerCase()} data-selected={props.selectedId === node.id || undefined} data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => props.onSelectNode(node)}>
          {!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.title}</span>
        </button>
        {props.visibleNodes.filter((child) => child.parentId === node.id && (child.kind === "VOLUME" || child.kind === "CHAPTER" || child.kind === "SCENE")).map((child) => renderWritingNode(child, depth + 1))}
      </div>
    );
  }

  return <div className="plan-tree" aria-label="规划树">
    {props.chapterMode && props.chapterListCollapsed ? <button type="button" className="chapter-list-expand" onClick={props.onExpandChapterList} aria-label="展开章节列表" title="展开章节列表"><PanelLeftOpen size={18} /></button> : <>
      <div className="section-heading"><div><h2>{props.chapterMode ? "章节列表" : "规划树"}</h2><p className="section-subtitle">{props.chapterMode ? "选择章节处理执行卡与创作任务" : "作品设定与故事结构分开管理"}</p></div><div className="plan-tree-heading-actions">{props.chapterMode ? <button type="button" className="icon-command" onClick={props.onCollapseChapterList} aria-label="收起章节列表" title="收起章节列表"><PanelLeftClose size={15} /></button> : null}<button type="button" className="icon-command plan-archive-toggle" onClick={props.onToggleArchived} aria-label={props.showArchived ? "隐藏已删除节点" : "显示已删除节点"} title={props.showArchived ? "隐藏已删除节点" : "显示已删除节点"}>{props.showArchived ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></div>
      <button type="button" className="plan-overview-row" data-selected={!props.selectedId || undefined} onClick={props.onSelectOverview}><BookOpen size={15} /><span>{props.chapterMode ? "章节总览" : "项目总览"}</span></button>
      {props.chapterMode ? <div className="plan-root-list writing-tree-list">{props.visibleNodes.filter((node) => node.parentId === null && node.kind === "VOLUME_MANAGER").map((node) => renderWritingNode(node))}{!props.chapterNodes.length ? <p className="plan-empty">暂无章节，请先在规划页建立章节结构。</p> : null}</div> : <div className="plan-root-list">
        {rootDefinitions.map(({ kind: rootKind, label }) => {
          const root = props.rootNodeFor(rootKind);
          return (
            <section className="plan-root-section" key={rootKind}>
              <div className="plan-root-heading"><div><strong>{rootSectionLabel(rootKind)}</strong><small>{rootKind === "WORK_DESIGN" ? "确定作品原则与创作约束" : rootKind === "VOLUME_MANAGER" ? "管理分卷阶段与卷内章节归属" : "安排完整故事的事件因果与推进顺序"}</small></div><span>{root ? "已创建" : "预设"}</span></div>
              {root ? renderNode(root) : <button type="button" className="plan-preset-row" onClick={() => void props.onCreateStarterNode(rootKind, label)}><Plus size={14} /><span>{label}</span><small>点击启用</small></button>}
            </section>
          );
        })}
        {props.unorganizedRoots.length ? (
          <section className="plan-root-section plan-root-unorganized">
            <div className="plan-root-heading"><strong>待整理</strong><span>{props.unorganizedRoots.length} 个节点</span></div>
            {props.unorganizedRoots.map((node) => renderNode(node))}
          </section>
        ) : null}
      </div>}</>
    }</div>;
}
