import { ChevronDown, ChevronRight, Eye, EyeOff, Plus } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import {
  planningSectionGroups,
  planningStoryStateLabels,
} from "./story-planning-workbench";
import { isRootKind, kindLabels, rootDefinitions } from "./project-workspace-utils";
import { groupNodesByParent } from "./project-workspace-index";
import { ChapterDirectory } from "./chapter-directory";

type ProjectPlanTreeProps = {
  chapterMode: boolean;
  expandedPlanningGroups: Set<string>;
  onCreateStarterNode: (kind: PlanNode["kind"], title: string) => Promise<void>;
  onSelectNode: (node: PlanNode) => void;
  onSelectPlanningSection: (node: PlanNode, sectionId: string) => void;
  onToggleArchived: () => void;
  onTogglePlanningGroup: (groupId: string) => void;
  planningSections: PlanningSection[];
  rootNodeFor: (kind: PlanNode["kind"]) => PlanNode | undefined;
  selectedId: string | null;
  selectedPlanningSectionId: string;
  showArchived: boolean;
  unorganizedRoots: PlanNode[];
  visibleNodes: PlanNode[];
  onCreateChapter?: () => void;
};

export function ProjectPlanTree(props: ProjectPlanTreeProps) {
  const childrenByParent = useMemo(() => groupNodesByParent(props.visibleNodes), [props.visibleNodes]);
  const sectionsById = useMemo(() => new Map(props.planningSections.map((section) => [section.id, section])), [props.planningSections]);
  function renderNode(node: PlanNode, depth = 0): ReactNode {
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row" data-kind={node.kind.toLowerCase()}
          data-selected={props.selectedId === node.id && (node.kind !== "WORK_DESIGN" || props.selectedPlanningSectionId === "seed-tone") || undefined}
          data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => props.onSelectNode(node)}>
          {!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.kind === "WORK_DESIGN" ? "本书偏好" : node.kind === "OUTLINE" ? "故事方向" : node.kind === "VOLUME_MANAGER" ? "分卷与章节" : node.title}</span>
        </button>
        {node.kind === "WORK_DESIGN" && !node.archived ? <details className="plan-reference-tree"
          open={props.selectedId === node.id && props.selectedPlanningSectionId !== "seed-tone"}>
          <summary>规划参考</summary>
          <div className="plan-design-tree">{planningSectionGroups.map((group) => {
            const expanded = props.expandedPlanningGroups.has(group.id);
            return <div className="plan-design-group" key={group.id}>
              <button type="button" className="plan-design-group-heading" aria-expanded={expanded}
                onClick={() => props.onTogglePlanningGroup(group.id)}>
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{group.label}</strong>
              </button>
              {expanded ? group.children.filter((item) => item.id !== "seed-tone").map((item) => {
                const section = sectionsById.get(item.id);
                return <button type="button" className="plan-design-item"
                  data-selected={props.selectedId === node.id && props.selectedPlanningSectionId === item.id || undefined}
                  key={item.id} onClick={() => props.onSelectPlanningSection(node, item.id)}>
                  <span>{item.label}</span>{section?.content.trim() || section?.pendingContent.trim()
                    ? <small>{planningStoryStateLabels[section.storyState]}</small> : null}
                </button>;
              }) : null}
            </div>;
          })}</div>
        </details> : null}
        {node.kind === "VOLUME_MANAGER" ? <ChapterDirectory nodes={props.visibleNodes.filter((item) => item.parentId === node.id || props.visibleNodes.some((volume) => volume.kind === "VOLUME" && volume.parentId === node.id && volume.id === item.parentId))}
          selectedId={props.selectedId} onSelect={props.onSelectNode} onCreate={() => props.onCreateChapter?.()} />
          : (childrenByParent.get(node.id) ?? []).filter((child) => props.chapterMode || child.kind !== "SCENE").map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return <div className="plan-tree" aria-label="规划树">
      <div className="section-heading"><div className="plan-tree-heading-actions"><button type="button" className="icon-command plan-archive-toggle" onClick={props.onToggleArchived} aria-label={props.showArchived ? "隐藏已删除节点" : "显示已删除节点"} title={props.showArchived ? "隐藏已删除节点" : "显示已删除节点"}>{props.showArchived ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></div>
      {props.chapterMode ? <ChapterDirectory showScenes nodes={props.visibleNodes} selectedId={props.selectedId} onSelect={props.onSelectNode} onCreate={() => props.onCreateChapter?.()} /> : <div className="plan-root-list">
        {rootDefinitions.map(({ kind: rootKind, label }) => {
          const root = props.rootNodeFor(rootKind);
          return (
            <section className="plan-root-section" key={rootKind}>
              {root ? renderNode(root) : <button type="button" className="plan-preset-row" onClick={() => void props.onCreateStarterNode(rootKind, label)}><Plus size={14} /><span>{rootKind === "WORK_DESIGN" ? "本书偏好" : rootKind === "OUTLINE" ? "故事方向" : "分卷与章节"}</span></button>}
            </section>
          );
        })}
        {props.unorganizedRoots.length ? (
          <section className="plan-root-section plan-root-unorganized">
            <div className="plan-root-heading"><strong>待整理</strong><span>{props.unorganizedRoots.length} 个节点</span></div>
            {props.unorganizedRoots.map((node) => renderNode(node))}
          </section>
        ) : null}
      </div>}</div>;
}
