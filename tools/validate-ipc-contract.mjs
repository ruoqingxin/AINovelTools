import { readFile, readdir } from "node:fs/promises";
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

export function assertNoRetiredCommands(commands) {
  const retired = ["save_manuscript", "save_manuscript_checked", "save_planning_section", "update_plan_node"];
  const found = retired.filter((name) => commands.has(name));
  if (found.length) throw new Error(`Retired IPC entry points: ${found.join(", ")}`);
}

export function findContractKeys(source, name) {
  const file = ts.createSourceFile("ipc-types.generated.ts", source, ts.ScriptTarget.Latest, true);
  const node = file.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  if (!node || !ts.isTypeLiteralNode(node.type)) throw new Error(`Missing generated ${name} contract`);
  return new Set(node.type.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.name) throw new Error(`Invalid ${name} member`);
    return member.name.text;
  }));
}

export function assertContractCoverage(registered, generated, label) {
  const missing = [...registered].filter((name) => !generated.has(name));
  const extra = [...generated].filter((name) => !registered.has(name));
  if (missing.length || extra.length) {
    throw new Error(`${label} contract coverage mismatch: missing [${missing}], extra [${extra}]`);
  }
}

export function assertTypedTransport(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier?.text;
      if (module === "@tauri-apps/api/core" || module === "@tauri-apps/api/event") {
        throw new Error(`Raw Tauri transport outside ipc-transport.ts: ${filename}`);
      }
    }
    if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require"
    )) {
      const module = node.arguments[0];
      if (module && ts.isStringLiteral(module) && ["@tauri-apps/api/core", "@tauri-apps/api/event"].includes(module.text)) {
        throw new Error(`Raw Tauri transport outside ipc-transport.ts: ${filename}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}

async function validateTransportDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await validateTransportDirectory(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|typecheck)\./.test(entry.name) && entry.name !== "ipc-transport.ts") {
      assertTypedTransport(await readFile(path, "utf8"), path);
    }
  }
}

export async function validateIpcContract() {
  const [rust, client, generated] = await Promise.all([
    readFile(new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../apps/desktop/src/lib/tauri-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/desktop/src/lib/ipc-types.generated.ts", import.meta.url), "utf8"),
  ]);
  const registered = findRegisteredCommands(rust);
  const commands = findClientCommands(client);
  assertNoRetiredCommands(registered);
  assertNoRetiredCommands(commands);
  const missing = [...commands].filter((name) => !registered.has(name));
  if (missing.length) throw new Error(`IPC contract mismatch: ${missing.join(", ")}`);
  for (const contract of ["IpcRequests", "IpcResponses", "IpcErrors"]) {
    assertContractCoverage(registered, findContractKeys(generated, contract), contract);
  }
  await validateTransportDirectory(fileURLToPath(new URL("../apps/desktop/src", import.meta.url)));
  console.log(`IPC contract validated (${commands.size} client commands)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateIpcContract();
}
