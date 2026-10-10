import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { compile } from "json-schema-to-typescript";

const run = promisify(execFile);
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = require("typescript");
const root = fileURLToPath(new URL("../", import.meta.url));
const generatedPath = resolve(root, "apps/desktop/src/lib/ipc-types.generated.ts");
const banner = "// Generated from Rust/Serde. Run `pnpm generate:ipc`; do not edit.\n";

export function transformSchema(schema, transform) {
  function visit(value) {
    if (!value || typeof value !== "object") return;
    transform(value);
    for (const key of ["properties", "definitions", "$defs", "patternProperties"]) {
      for (const child of Object.values(value[key] ?? {})) visit(child);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      for (const child of value[key] ?? []) visit(child);
    }
    for (const key of ["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains"]) {
      if (Array.isArray(value[key])) value[key].forEach(visit);
      else visit(value[key]);
    }
  }
  const copy = structuredClone(schema);
  visit(copy);
  return copy;
}

export function prefixDefinitions(schema, prefix) {
  const copy = transformSchema(schema, (value) => {
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/definitions/")) {
      value.$ref = value.$ref.replace("#/definitions/", `#/definitions/${prefix}`);
    }
  });
  copy.definitions = Object.fromEntries(
    Object.entries(copy.definitions).map(([name, value]) => [`${prefix}${name}`, value]),
  );
  return copy;
}

export function contractSchema(contract) {
  contract = Object.fromEntries(Object.entries(contract).map(([key, schema]) => [
    key,
    transformSchema(schema, (value) => {
      // Defaults affect requiredness in Rust, but do not change a TS field's type.
      delete value.default;
      delete value.title;
    }),
  ]));
  const requests = prefixDefinitions(contract.requests, "Input");
  const definitions = { ...contract.responses.definitions, ...requests.definitions };
  const properties = {};
  for (const [key, document] of Object.entries({ ...contract, requests })) {
    const name = `Ipc${key[0].toUpperCase()}${key.slice(1)}`;
    const schema = structuredClone(document);
    delete schema.$schema;
    delete schema.definitions;
    delete schema.title;
    definitions[name] = schema;
    properties[key] = { $ref: `#/definitions/${name}` };
  }
  return {
    title: "IpcContracts",
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    definitions,
  };
}

export async function renderTypes(contract) {
  const result = await compile(contractSchema(contract), "IpcContracts", {
    bannerComment: banner.trimEnd(),
    additionalProperties: false,
    unknownAny: true,
    unreachableDefinitions: true,
    enableConstEnums: false,
    maxItems: 64,
    style: { printWidth: 120, tabWidth: 2 },
  });
  // Preserve the client's existing structural type-alias convention.
  const file = ts.createSourceFile("ipc-types.generated.ts", result, ts.ScriptTarget.Latest, true);
  const statements = file.statements.map((node) => ts.isInterfaceDeclaration(node)
    ? ts.factory.createTypeAliasDeclaration(node.modifiers, node.name, node.typeParameters, ts.factory.createTypeLiteralNode(node.members))
    : node);
  return banner + ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true })
    .printFile(ts.factory.updateSourceFile(file, statements));
}

export function assertNoDrift(actual, expected) {
  if (actual !== expected) {
    throw new Error("Rust/TypeScript IPC types have drifted. Run `pnpm generate:ipc` and review the diff.");
  }
}

export async function generateIpcTypes({ check = false } = {}) {
  const { stdout, stderr } = await run("cargo", [
    "run", "--quiet", "-p", "ainoveltools-desktop", "--features", "ipc-contract", "--bin", "ipc-schema",
  ], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  if (stderr) process.stderr.write(stderr);
  // Windows linkers may write build notices before the binary's single JSON line.
  const contract = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const types = await renderTypes(contract);
  if (check) {
    const actual = await readFile(generatedPath, "utf8").catch((cause) => {
      if (cause.code === "ENOENT") return "";
      throw cause;
    });
    assertNoDrift(actual, types);
  } else {
    await writeFile(generatedPath, types);
  }
  console.log(`IPC types ${check ? "verified" : "generated"} (${Object.keys(contract.requests.properties).length} commands, ${Object.keys(contract.events.properties).length} events)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: node tools/generate-ipc-types.mjs [--check]");
  await generateIpcTypes({ check: args.includes("--check") });
}
