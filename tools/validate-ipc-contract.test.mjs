import assert from "node:assert/strict";
import { test } from "node:test";
import { findClientCommands, findRegisteredCommands } from "./validate-ipc-contract.mjs";

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
