import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recommendedTaskPreference } from "../lib/ai-task-preferences";
import type { ModelProfile, PlanNode, PlanningSection } from "../lib/tauri-client";
import { emptyPlanningSection, usePlanningDraft } from "./use-planning-draft";
import { useWorkspacePlanningOperations } from "./use-workspace-planning-operations";

const mocks = vi.hoisted(() => ({
  enqueuePlanningAiJob: vi.fn(), savePlanningSection: vi.fn(), adoptPlanBatch: vi.fn(),
}));
vi.mock("../lib/tauri-client", async () => ({
  ...await vi.importActual<typeof import("../lib/tauri-client")>("../lib/tauri-client"), ...mocks,
}));

const manager: PlanNode = { id: "manager", kind: "VOLUME_MANAGER", parentId: null, title: "分卷管理", archived: false, revision: 4, sortOrder: 0 };
const volume: PlanNode = { ...manager, id: "volume", parentId: manager.id, kind: "VOLUME", title: "第一卷" };
const source: PlanningSection = { ...emptyPlanningSection("plan-node:manager"), content: "正式规划", pendingContent: "第1卷·入城｜阶段目标", version: 7 };
const split: PlanningSection = { ...emptyPlanningSection("chapter-split-volume"), pendingContent: "第2章·重逢｜新冲突", version: 3 };
const profile = { id: "profile", hasSecret: true } as ModelProfile;

function setup(selected: PlanNode = manager) {
  const stored = { ...source, id: `plan-node:${selected.id}` };
  const sections = [stored, split, { ...source, id: "plan-node:volume", content: "本卷目标", pendingContent: "" }];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["planning-sections"], sections);
  const onError = vi.fn();
  const onVolumesAdopted = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => {
    const nodeDraft = usePlanningDraft(stored.id, stored, true);
    const splitDraft = usePlanningDraft(split.id, split, true);
    const operations = useWorkspacePlanningOperations({
      projectId: "project", selected, planningSections: sections, sectionsById: new Map(sections.map((item) => [item.id, item])),
      volumeNodes: [volume], chapterNodes: [{ ...volume, id: "chapter", kind: "CHAPTER", parentId: volume.id }],
      nodeDraft, splitDraft, nodePlanTab: "formal",
      nodeGeneration: { profile, preference: recommendedTaskPreference("volumePlanning"), guidance: "保留冲突", targets: { wordCount: "80000", volumeCount: "4", chapterCount: "40" } },
      splitGeneration: { volume, profile, preference: recommendedTaskPreference("chapterSplit"),
        guidance: "节奏紧凑", busy: false, sectionId: split.id, targetCount: 10, existingCount: 1, batchSize: 3 },
      onError, onVolumesAdopted,
    });
    return { operations, nodeDraft, splitDraft };
  }, { wrapper });
  return { ...hook, client, onError, onVolumesAdopted, stored };
}

describe("workspace planning operation boundary", () => {
  afterEach(() => cleanup());
  beforeEach(() => vi.resetAllMocks());

  it("keeps generation context and task settings separate from pending candidates", async () => {
    mocks.enqueuePlanningAiJob.mockResolvedValue({});
    const { result } = setup();
    await act(async () => result.current.operations.generateNodePlan());
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "profile", sectionId: source.id, taskKey: "volumePlanning",
      allowRewrite: false, temperature: 0.55, maxOutputTokens: 6144,
      existingContext: "plan-node:manager: 正式规划\nplan-node:volume: 本卷目标",
      userGuidance: expect.stringContaining("保留冲突"),
    }));
    expect(mocks.enqueuePlanningAiJob.mock.calls[0][0].userGuidance).toContain("计划分卷数：4 卷");
    expect(result.current.operations.generatingNodePlan).toBe(false);
  });

  it("keeps split generation locked until enqueue finishes and retains exact batch guidance", async () => {
    let finish!: () => void;
    mocks.enqueuePlanningAiJob.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = setup();
    let running!: Promise<void>;
    act(() => { running = result.current.operations.generateChapterSplit(); });
    await waitFor(() => expect(result.current.operations.generatingChapterSplit).toBe(true));
    await act(async () => result.current.operations.generateChapterSplit());
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledOnce();
    expect(mocks.enqueuePlanningAiJob).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: split.id, taskKey: "chapterSplit", temperature: 0.3, maxOutputTokens: 4096,
      userGuidance: "节奏紧凑\n本卷预计共 10 章；当前本卷已拆 1 章；本次最多生成 3 章，从第 2 章开始连续编号\n本卷正式规划：本卷目标",
    }));
    await act(async () => { finish(); await running; });
    expect(result.current.operations.generatingChapterSplit).toBe(false);
  });

  it("acknowledges only the submitted plan and preserves newer edits and unrelated cache entries", async () => {
    let finish!: (saved: PlanningSection) => void;
    mocks.savePlanningSection.mockReturnValue(new Promise<PlanningSection>((resolve) => { finish = resolve; }));
    const { result, stored, client } = setup({ ...manager, id: "scene", kind: "SCENE" });
    act(() => result.current.nodeDraft.setForm((form) => ({ ...form, content: "提交的规划" })));
    let running!: Promise<void>;
    act(() => { running = result.current.operations.saveNodePlan(); });
    await waitFor(() => expect(result.current.operations.savingNodePlan).toBe(true));
    act(() => result.current.nodeDraft.setForm((form) => ({ ...form, content: "保存期间的新输入" })));
    const saved = { ...stored, content: "提交的规划", storyState: "CONFIRMED" as const, version: 8 };
    await act(async () => { finish(saved); await running; });
    expect(mocks.savePlanningSection).toHaveBeenCalledWith(expect.objectContaining({ version: 7, content: "提交的规划" }));
    expect(result.current.nodeDraft.form.content).toBe("保存期间的新输入");
    expect(result.current.nodeDraft.baseline.version).toBe(8);
    expect(result.current.nodeDraft.dirty).toBe(true);
    expect(client.getQueryData<PlanningSection[]>(["planning-sections"])).toEqual(expect.arrayContaining([saved, split]));
    expect(result.current.operations.savingNodePlan).toBe(false);
  });
});
