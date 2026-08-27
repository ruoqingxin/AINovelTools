import { readFile } from "node:fs/promises";

const rust = await readFile("apps/desktop/src-tauri/src/lib.rs", "utf8");
const ts = await readFile("apps/desktop/src/lib/tauri-client.ts", "utf8");
const commands = [...rust.matchAll(/fn\s+([a-z][a-z0-9_]*)\s*\(/g)].map((m) => m[1]);
const clientCommands = [...ts.matchAll(/invoke<[^>]*>\("([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
const missing = clientCommands.filter((name) => !commands.includes(name));
if (missing.length) {
  console.error(`IPC contract mismatch: ${missing.join(", ")}`);
  process.exit(1);
}
for (const field of ["documentSchemaVersion", "baseRevisionId", "createdAt"]) {
  if (!ts.includes(field)) throw new Error(`Missing generated contract field: ${field}`);
}
console.log(`IPC contract validated (${clientCommands.length} client calls)`);
