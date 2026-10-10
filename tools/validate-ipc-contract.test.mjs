import assert from "node:assert/strict";
import { test } from "node:test";
import { assertContractCoverage, assertNoRetiredCommands, assertTypedTransport, findClientCommands, findContractKeys, findRegisteredCommands, validateIpcContract } from "./validate-ipc-contract.mjs";

test("client calls support nested generics, multiline calls, and untyped calls", () => {
  const commands = findClientCommands(`
    invoke<Array<Record<string, number>>>("nested");
    invoke<void>(
      'multiline',
    );
    invoke("untyped");
    invoke<void>("nested");
    // invoke<void>("comment");
    const text = 'invoke<void>("string")';
  `);
  assert.deepEqual([...commands], ["nested", "multiline", "untyped"]);
});

test("retired save paths cannot be registered or called again", () => {
  for (const name of ["save_manuscript", "save_manuscript_checked", "save_planning_section", "update_plan_node"]) {
    assert.throws(() => assertNoRetiredCommands(new Set([name])), /Retired IPC/);
  }
  assertNoRetiredCommands(new Set(["commit_manuscript_draft", "save_planning_section_checked", "update_plan_node_checked"]));
});

test("workspace IPC registration and calls keep audited paths retired", async () => {
  await validateIpcContract();
});

test("dynamic command names fail validation instead of being silently skipped", () => {
  assert.throws(() => findClientCommands("invoke(commandName)"), /string literals/);
});

test("only commands in the Tauri handler count as registered", () => {
  const registered = findRegisteredCommands(`
    fn private_helper() {}
    tauri::generate_handler![
      first_command,
      second_command,
    ]
  `);
  assert.deepEqual([...registered], ["first_command", "second_command"]);
  assert.throws(() => findRegisteredCommands("fn private_helper() {}"), /registration/);
});

test("generated requests, responses and errors must cover the exact registration", () => {
  const keys = findContractKeys("export type IpcRequests = { first: unknown; second: unknown };", "IpcRequests");
  assert.deepEqual([...keys], ["first", "second"]);
  assertContractCoverage(new Set(["first", "second"]), keys, "requests");
  assert.throws(() => assertContractCoverage(new Set(["first"]), keys, "requests"), /extra \[second\]/);
  assert.throws(() => assertContractCoverage(new Set(["first", "third"]), keys, "requests"), /missing \[third\]/);
  assert.throws(() => findContractKeys("export type Missing = string;", "IpcRequests"), /Missing generated/);
});

test("production clients cannot bypass the typed transport via imports or re-exports", () => {
  assert.throws(() => assertTypedTransport('import { invoke as raw } from "@tauri-apps/api/core";', "view.ts"), /Raw Tauri/);
  assert.throws(() => assertTypedTransport('export { listen } from "@tauri-apps/api/event";', "view.ts"), /Raw Tauri/);
  assert.throws(() => assertTypedTransport('await import("@tauri-apps/api/core");', "view.ts"), /Raw Tauri/);
  assertTypedTransport('import { invoke } from "./ipc-transport";', "view.ts");
});
