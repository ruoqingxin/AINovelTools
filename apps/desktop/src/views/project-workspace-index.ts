import type { PlanNode, PlanNodeKind } from "../lib/tauri-client";

export function groupNodesByParent(nodes: PlanNode[]) {
  const childrenByParent = new Map<string | null, PlanNode[]>();
  for (const node of nodes) {
    const children = childrenByParent.get(node.parentId);
    if (children) children.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  return childrenByParent;
}

export function buildWorkspaceNodeIndex(nodes: PlanNode[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const activeNodes = nodes.filter((node) => !node.archived);
  const rootsByKind = new Map<PlanNodeKind, PlanNode>();
  const nodesByKind: Record<PlanNodeKind, PlanNode[]> = {
    WORK_DESIGN: [], OUTLINE: [], VOLUME_MANAGER: [], VOLUME: [], CHAPTER: [], SCENE: [],
  };
  for (const node of activeNodes) {
    nodesByKind[node.kind].push(node);
    if (node.parentId === null && !rootsByKind.has(node.kind)) rootsByKind.set(node.kind, node);
  }
  const chaptersByVolume = groupNodesByParent(nodesByKind.CHAPTER);
  return { nodesById, activeNodes, rootsByKind, nodesByKind, chaptersByVolume };
}
