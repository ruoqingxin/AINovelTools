import { createPlanNode, getCurrentProject, listPlanNodes, type PlanNode } from "../lib/tauri-client";

export async function createChapter(input: {
  projectId: string; title: string; volumeId?: string; newVolumeTitle?: string;
}): Promise<PlanNode> {
  async function verifyProject() {
    const project = await getCurrentProject();
    if (project?.projectId !== input.projectId) throw new Error("作品已切换，未创建章节。");
  }
  await verifyProject();
  // Re-read on every attempt so a successful parent creation survives a later failure.
  const nodes = (await listPlanNodes()).filter((node) => !node.archived);
  let volume = input.volumeId ? nodes.find((node) => node.id === input.volumeId && node.kind === "VOLUME") : undefined;
  if (input.volumeId && !volume) throw new Error("所选分卷已不可用，请重新选择。");
  if (!volume) {
    const volumeTitle = input.newVolumeTitle?.trim() || "第一卷";
    let manager = nodes.find((node) => node.kind === "VOLUME_MANAGER" && node.parentId === null);
    if (!manager) {
      await verifyProject();
      manager = await createPlanNode({ kind: "VOLUME_MANAGER", title: "分卷与章节" });
    }
    volume = nodes.find((node) => node.kind === "VOLUME" && node.parentId === manager.id && node.title === volumeTitle);
    if (!volume) {
      await verifyProject();
      volume = await createPlanNode({ kind: "VOLUME", title: volumeTitle, parentId: manager.id });
    }
  }
  await verifyProject();
  return createPlanNode({ kind: "CHAPTER", title: input.title.trim() || `第${nodes.filter((node) => node.kind === "CHAPTER").length + 1}章`, parentId: volume.id });
}
