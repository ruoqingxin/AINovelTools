import { invoke, listen } from "./ipc-transport";
import type { AiTaskAttempt, IpcRequests, IpcResponses, MergeConflict, VersionedPlanningSection } from "./ipc-types.generated";

// Compile-only examples: tsc must reject each unsafe contract below.
export function verifyIpcTypeContracts() {
  void invoke("bootstrap_status");
  void invoke("save_ai_budget_settings", { settings: {} });
  void invoke("save_project_ai_task_override", { task: "writing", preference: null });
  void invoke("save_project_ai_task_override", { task: "writing", preference: "legacy-profile-id" });
  const target: IpcRequests["adopt_extraction_item"]["target"] = {
    id: "item", projectId: "project", chapterId: "chapter", expectedStatus: "PENDING_REVIEW", expectedVersion: 1,
  };
  void invoke("adopt_extraction_item", { target });
  const nodes: Promise<IpcResponses["list_plan_nodes"]> = invoke("list_plan_nodes");
  void nodes;
  // @ts-expect-error Command names come only from the Rust registration.
  void invoke("missing_command");
  // @ts-expect-error Required top-level arguments cannot be omitted.
  void invoke("adopt_extraction_item");
  // @ts-expect-error No-argument commands do not accept arbitrary payloads.
  void invoke("bootstrap_status", { extra: true });
  // @ts-expect-error Nested CAS version is mandatory.
  void invoke("adopt_extraction_item", { target: { id: "item", projectId: "project", chapterId: "chapter", expectedStatus: "PENDING_REVIEW" } });
  // @ts-expect-error Project and chapter scope cannot be omitted.
  void invoke("adopt_extraction_item", { target: { id: "item", expectedStatus: "PENDING_REVIEW", expectedVersion: 1 } });
  // @ts-expect-error Serde enums use the serialized spelling.
  void invoke("adopt_extraction_item", { target: { ...target, expectedStatus: "PendingReview" } });
  // @ts-expect-error DTO fields cannot be added by a handwritten caller.
  void invoke("adopt_extraction_item", { target, unexpected: true });
  // @ts-expect-error Result types are inferred from the command, not selected by callers.
  const result: Promise<number> = invoke("list_plan_nodes");
  void result;
  const section = {} as Omit<VersionedPlanningSection, "version">;
  // @ts-expect-error Stored planning responses always carry their version.
  const stored: VersionedPlanningSection = section;
  void stored;
  // @ts-expect-error Serialized Option fields are present and nullable, not optional.
  const conflict: MergeConflict = { blockId: "block" };
  void conflict;
  // @ts-expect-error Unvalidated JSON is not guaranteed to be an object.
  const name = ({} as IpcResponses["adopt_extraction_item"]).payload.name;
  void name;
  void listen("ai-task-attempt", ({ payload }) => {
    const attempt: AiTaskAttempt = payload;
    void attempt;
    // @ts-expect-error Event payloads also come from the Rust DTO.
    void payload.unknownField;
  });
  // @ts-expect-error Arbitrary event names cannot bypass the generated event map.
  void listen("missing-event", () => {});
}
