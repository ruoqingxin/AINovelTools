import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoRetiredCommands, findClientCommands, findRegisteredCommands, validateIpcContract } from "./validate-ipc-contract.mjs";

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
