import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = require("typescript");

export function findClientCommands(source) {
  const file = ts.createSourceFile("tauri-client.ts", source, ts.ScriptTarget.Latest, true);
  const commands = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "invoke") {
      const command = node.arguments[0];
      if (!command || !ts.isStringLiteral(command)) {
        throw new Error("IPC command names must be string literals");
      }
      commands.add(command.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return commands;
}

export function findRegisteredCommands(source) {
  const handler = source.match(/tauri::generate_handler!\s*\[([\s\S]*?)\]/);
  if (!handler) throw new Error("Missing Tauri command registration");
  return new Set(handler[1].split(",").map((name) => name.trim()).filter(Boolean));
}

export async function validateIpcContract() {
  const [rust, client] = await Promise.all([
    readFile(new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../apps/desktop/src/lib/tauri-client.ts", import.meta.url), "utf8"),
  ]);
  const registered = findRegisteredCommands(rust);
  const commands = findClientCommands(client);
  const missing = [...commands].filter((name) => !registered.has(name));
  if (missing.length) throw new Error(`IPC contract mismatch: ${missing.join(", ")}`);
  for (const field of ["documentSchemaVersion", "baseRevisionId", "createdAt"]) {
    if (!client.includes(field)) throw new Error(`Missing generated contract field: ${field}`);
  }
  console.log(`IPC contract validated (${commands.size} client commands)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateIpcContract();
}
