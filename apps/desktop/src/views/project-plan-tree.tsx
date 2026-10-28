import { Plus } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { PlanNode, PlanningSection } from "../lib/tauri-client";
import { isRootKind, kindLabels, rootDefinitions } from "./project-workspace-utils";
import { groupNodesByParent } from "./project-workspace-index";
import { ChapterDirectory } from "./chapter-directory";
import { preparationStatus, preparationStatusLabels } from "./creation-preparation";
import { useInAiWorkspace } from "./content-identity";
import { WorkspaceLink } from "./workspace-link";
import { aiWorkspaceHref } from "../lib/content-taxonomy";

type ProjectPlanTreeProps = {
  chapterMode: boolean;
  onCreateStarterNode: (kind: PlanNode["kind"], title: string) => Promise<void>;
  onSelectNode: (node: PlanNode) => void;
  onToggleArchived: () => void;
  planningSections: PlanningSection[];
  projectId?: string;
  rootNodeFor: (kind: PlanNode["kind"]) => PlanNode | undefined;
  selectedId: string | null;
  showArchived: boolean;
  unorganizedRoots: PlanNode[];
  visibleNodes: PlanNode[];
  onCreateChapter?: () => void;
};

export function ProjectPlanTree(props: ProjectPlanTreeProps) {
  const aiWorkspace = useInAiWorkspace();
  const childrenByParent = useMemo(() => groupNodesByParent(props.visibleNodes), [props.visibleNodes]);
  const sectionsById = useMemo(() => new Map(props.planningSections.map((section) => [section.id, section])), [props.planningSections]);
  function renderNode(node: PlanNode, depth = 0): ReactNode {
    if (node.kind === "WORK_DESIGN") return null;
    const volumeIds = new Set((childrenByParent.get(node.id) ?? []).filter((item) => item.kind === "VOLUME").map((item) => item.id));
    const chapterIds = new Set(props.visibleNodes.filter((item) => item.kind === "CHAPTER" && volumeIds.has(item.parentId ?? "")).map((item) => item.id));
    const isTopLevelPlanningNode = node.parentId === null && isRootKind(node.kind);
    return (
      <div key={node.id}>
        <button type="button" className="plan-row" data-kind={node.kind.toLowerCase()}
          data-selected={props.selectedId === node.id || node.kind === "OUTLINE" && !props.selectedId || undefined}
          data-archived={node.archived || undefined} style={{ paddingLeft: `${10 + depth * 22}px` }} onClick={() => props.onSelectNode(node)}>
          {!isTopLevelPlanningNode ? <span className="plan-kind">{kindLabels[node.kind]}</span> : null}<span className="plan-title">{node.kind === "OUTLINE" ? "全书大纲" : node.kind === "VOLUME_MANAGER" ? "分卷与章节" : node.title}</span>
          {node.kind === "OUTLINE" || node.kind === "VOLUME" ? <small className="plan-confirmation-state">{preparationStatusLabels[preparationStatus(sectionsById.get(`plan-node:${node.id}`), props.planningSections)]}</small> : null}
        </button>
        {node.kind === "VOLUME_MANAGER" ? <ChapterDirectory showScenes nodes={props.visibleNodes.filter((item) => item.parentId === node.id || volumeIds.has(item.parentId ?? "") || chapterIds.has(item.parentId ?? ""))}
          selectedId={props.selectedId} onSelect={props.onSelectNode} onCreate={props.onCreateChapter} />
          : (childrenByParent.get(node.id) ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return <div className="plan-tree" aria-label="规划树">
      {props.chapterMode ? <ChapterDirectory showScenes nodes={props.visibleNodes} selectedId={props.selectedId} onSelect={props.onSelectNode} onCreate={props.onCreateChapter} /> : <div className="plan-root-list">
        {rootDefinitions.filter(({ kind }) => kind !== "WORK_DESIGN").map(({ kind: rootKind, label }) => {
          const root = props.rootNodeFor(rootKind);
          if (!root && rootKind !== "OUTLINE" && !aiWorkspace) return null;
          return (
            <section className="plan-root-section" key={rootKind}>
              {root ? renderNode(root) : rootKind === "OUTLINE" ? <WorkspaceLink className="plan-row"
                data-selected={!props.selectedId || undefined}
                href={aiWorkspace && props.projectId ? aiWorkspaceHref({ projectId: props.projectId, workflow: "planning" }) : "/planning?mode=structure"}>
                <span className="plan-title">全书大纲</span><small className="plan-confirmation-state">未编写</small>
              </WorkspaceLink> : <button type="button" className="plan-preset-row" onClick={() => void props.onCreateStarterNode(rootKind, label)}><Plus size={14} /><span>分卷与章节</span></button>}
            </section>
          );
        })}
        {props.unorganizedRoots.length ? (
          <section className="plan-root-section plan-root-unorganized">
            <div className="plan-root-heading"><strong>待整理</strong><span>{props.unorganizedRoots.length} 个节点</span></div>
            {props.unorganizedRoots.map((node) => renderNode(node))}
          </section>
        ) : null}
      </div>}
      {aiWorkspace && <details className="outline-directory-options"><summary>目录选项</summary><label>
        <input type="checkbox" checked={props.showArchived} onChange={props.onToggleArchived} />显示已删除节点
      </label></details>}
    </div>;
}
