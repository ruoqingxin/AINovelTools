import type { PlanNodeKind } from "../lib/tauri-client";

export const kindLabels: Record<PlanNodeKind, string> = {
  WORK_DESIGN: "作品设定",
  OUTLINE: "故事大纲",
  VOLUME_MANAGER: "分卷管理",
  VOLUME: "分卷",
  CHAPTER: "章节",
  SCENE: "场景",
};

export const rootDefinitions: Array<{ kind: PlanNodeKind; label: string }> = [
  { kind: "WORK_DESIGN", label: "作品设定" },
  { kind: "OUTLINE", label: "故事大纲" },
  { kind: "VOLUME_MANAGER", label: "分卷管理" },
];

export function isRootKind(kind: PlanNodeKind) {
  return kind === "WORK_DESIGN" || kind === "OUTLINE" || kind === "VOLUME_MANAGER";
}

export function nodePlanId(nodeId: string) {
  return `plan-node:${nodeId}`;
}


export function nodePlanPrompt(kind: PlanNodeKind) {
  if (kind === "OUTLINE") return "写清整部小说的主线因果：起点、关键转折、高潮和结局，不展开章节细节。";
  if (kind === "VOLUME_MANAGER") return "根据正式故事主线规划整部作品的分卷结构。每卷必须独占一行，严禁把多卷写在同一行。每行只输出“第X卷·标题｜阶段目标｜主要矛盾｜卷末转折”，不要输出说明、标题、编号或空行。";
  if (kind === "VOLUME") return "写清本分卷要完成的阶段任务、主要矛盾、人物变化和卷末转折。";
  if (kind === "CHAPTER") return "写清本章的目标、冲突、关键行动、情感变化和结尾钩子，作为正文写作执行卡。";
  return "写清本场景中谁要什么、发生什么阻碍、局面如何改变，以及场景结束时留下什么结果。";
}

export function parsePlanCandidates(value: string, unit: "卷" | "章") {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/```(?:\w+)?/g, "\n");
  const headingPattern = new RegExp(`(第[一二三四五六七八九十百零〇两\\d]+${unit})\\s*[·:：\\-—]?\\s*([^｜|\\n]*?)(?=\\s*[｜|]|\\n|$)`, "g");
  const headings = [...normalized.matchAll(headingPattern)];
  const candidates = headings.map((match, index) => {
    const nextIndex = headings[index + 1]?.index ?? normalized.length;
    const content = normalized
      .slice((match.index ?? 0) + match[0].length, nextIndex)
      .replace(/^[\s｜|]+/, "")
      .replace(/[\s｜|]+$/, "")
      .replace(/(?:\n\s*)?(?:[-*•]\s*|\d+[.、)]\s*|#{1,6}\s*)$/, "")
      .trim();
    return {
      title: `${match[1]}${match[2]?.trim() ? `·${match[2].trim()}` : ""}`,
      content,
    };
  });
  return candidates.filter((candidate, index) => candidates.findIndex((item) => item.title === candidate.title) === index);
}

export function parseVolumePlanCandidates(value: string) {
  return parsePlanCandidates(value, "卷");
}

export function parseChapterPlanCandidates(value: string) {
  return parsePlanCandidates(value, "章");
}

export function buildVolumePlanTargetGuidance(targets: { wordCount: string; volumeCount: string; chapterCount: string }) {
  return [
    targets.wordCount.trim() ? `本书预计总字数：${targets.wordCount.trim()} 万字` : "",
    targets.volumeCount.trim() ? `计划分卷数：${targets.volumeCount.trim()} 卷` : "",
    targets.chapterCount.trim() ? `预计章节数：${targets.chapterCount.trim()} 章` : "",
  ].filter(Boolean).join("\n");
}

export function resolveDefaultWritingChapter<T extends { id: string }>(chapters: T[], requestedId: string, rememberedId: string) {
  return chapters.find((chapter) => chapter.id === requestedId)
    ?? chapters.find((chapter) => chapter.id === rememberedId)
    ?? chapters[0]
    ?? null;
}

export function lastWritingChapterKey(projectId: string) {
  return `ainoveltools:last-writing-chapter:${projectId}`;
}

export const writingCandidateTransferKey = "ainoveltools:writing-candidate-transfer";
export const candidateReviewTransferKey = "ainoveltools:candidate-review-transfer";

export function rootSectionLabel(kind: PlanNodeKind) {
  if (kind === "WORK_DESIGN") return "作品设定";
  if (kind === "VOLUME_MANAGER") return "分卷规划";
  return "故事结构";
}

export function isValidParentKind(parent: PlanNodeKind, child: PlanNodeKind) {
  return (
    (parent === "VOLUME_MANAGER" && child === "VOLUME")
    || (parent === "VOLUME" && child === "CHAPTER")
    || (parent === "CHAPTER" && child === "SCENE")
  );
}

export function documentToJson(value: string) {
  try {
    const parsed = JSON.parse(value) as { type?: string };
    if (parsed && parsed.type === "doc") return parsed;
  } catch {
    // Existing revisions may contain plain text from the first editor.
  }
  return {
    type: "doc",
    content: value.split(/\r?\n/).map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : undefined,
    })),
  };
}

export function documentToText(value: string) {
  try {
    const document = JSON.parse(value) as { content?: Array<{ content?: Array<{ text?: string }> }> };
    return (document.content ?? []).map((block) => (block.content ?? []).map((item) => item.text ?? "").join("" )).join("\n");
  } catch {
    return value;
  }
}

export function documentCharacterCount(value: string) {
  return documentToText(value).replace(/\s/g, "").length;
}

export function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "保存时间未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function revisionReasonLabel(reason: string) {
  return reason === "RESTORE_REVISION" ? "由历史版本恢复" : "手动保存";
}

export function diffLines(left: string, right: string) {
  try {
    const parse = (value: string) => {
      const doc = JSON.parse(value) as { content?: Array<{ attrs?: { blockId?: string }; content?: Array<{ text?: string }> }> };
      return (doc.content ?? []).map((block, index) => ({ id: block.attrs?.blockId ?? `legacy-${index}`, text: (block.content ?? []).map((item) => item.text ?? "").join("") }));
    };
    const aBlocks = parse(left); const bBlocks = parse(right);
    const rows: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
    const ids = [...new Set([...aBlocks.map((x) => x.id), ...bBlocks.map((x) => x.id)])];
    for (const id of ids) {
      const a = aBlocks.find((x) => x.id === id)?.text; const b = bBlocks.find((x) => x.id === id)?.text;
      if (a === b) rows.push({ kind: "same", text: a ?? "" }); else { if (a !== undefined) rows.push({ kind: "removed", text: a }); if (b !== undefined) rows.push({ kind: "added", text: b }); }
    }
    return rows;
  } catch { /* fall back to legacy line diff */ }
  const a = left.split("\n");
  const b = right.split("\n");
  const rows: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) rows.push({ kind: "same", text: a[index] ?? "" });
    else {
      if (a[index] !== undefined) rows.push({ kind: "removed", text: a[index] });
      if (b[index] !== undefined) rows.push({ kind: "added", text: b[index] });
    }
  }
  return rows;
}
