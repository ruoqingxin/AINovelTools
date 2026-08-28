import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const rustRoot = "apps/desktop/src-tauri/src";
const rustFiles = ["lib.rs"];
for (const entry of await readdir(rustRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".rs") && entry.name !== "lib.rs") {
    rustFiles.push(entry.name);
  }
  if (entry.isDirectory() && entry.name === "commands") {
    for (const command of await readdir(join(rustRoot, entry.name))) {
      if (command.endsWith(".rs")) rustFiles.push(join(entry.name, command));
    }
  }
}
const rust = (await Promise.all(rustFiles.map((file) => readFile(join(rustRoot, file), "utf8")))).join("\n");
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
