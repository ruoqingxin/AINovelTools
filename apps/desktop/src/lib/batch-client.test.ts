import { beforeEach, expect, it, vi } from "vitest";
import { adoptPlanBatch, importEntities, type EntityInput, type PlanBatchInput } from "./tauri-client";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

it("imports a whole new-only batch with mandatory project scope in one invocation", async () => {
  const items: EntityInput[] = [
    { entityType: "CHARACTER", name: "A", description: "", aliases: [], tags: [], fixedAttributesJson: "{}" },
    { entityType: "LOCATION", name: "B", description: "", aliases: [], tags: [], fixedAttributesJson: "{}" },
  ];
  invoke.mockResolvedValue([]);
  await importEntities({ expectedProjectId: "project", items });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("import_entities", { input: { expectedProjectId: "project", items } });
});

it("transmits original parent and source CAS versions and returns the batch receipt unchanged", async () => {
  const input: PlanBatchInput = {
    expectedProjectId: "project", parentId: "volume", expectedParentRevision: 3, expectedSourceVersion: 7,
    source: { id: "chapter-split-volume", content: "formal", pendingContent: "candidate", storyState: "LOCKED",
      rationale: "reason", consequence: "", references: ["source"], updatedAt: "", version: 7 },
    candidates: [{ title: "A", content: "card" }],
  };
  const receipt = { nodes: [], source: { ...input.source, version: 8, pendingContent: "" } };
  invoke.mockResolvedValue(receipt);
  expect(await adoptPlanBatch(input)).toBe(receipt);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("adopt_plan_batch", { input });
});
