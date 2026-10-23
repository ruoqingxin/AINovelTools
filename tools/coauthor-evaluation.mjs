import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { workspace } from "./desktop-smoke-runtime.mjs";
import { environment, loadFixture, nativeRows, summarizeBaseline, writeReport } from "./coauthor-evaluation-core.mjs";

export async function runNative(test, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", ["test", "-p", "novel-infrastructure",
      `coauthor_store::evaluation_tests::${test}`, "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"],
    { cwd: workspace, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Native evaluation failed (${code}):\n${stderr}\n${stdout}`));
      else {
        try { resolve({ stdout, stderr, rows: nativeRows(stdout) }); }
        catch (error) { reject(error); }
      }
    });
  });
}

export async function localBaseline() {
  const { values } = parseArgs({ options: { enforce: { type: "boolean", default: false } } });
  const { fixture, hash } = await loadFixture();
  await mkdir(join(workspace, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(workspace, ".tmp/coauthor-baseline-"));
  console.log("Measuring actual native retrieval; no provider calls. Run without concurrent builds.");
  let result;
  try {
    result = await runNative("measure_retrieval_baseline");
  } catch (error) {
    await writeFile(join(directory, "failure.txt"), String(error.stack ?? error));
    console.error(`Native baseline failed; details: ${join(directory, "failure.txt")}`);
    process.exitCode = 1;
    return;
  }
  assert(result.rows.length, "No measurement rows returned.");
  await writeFile(join(directory, "measurements.jsonl"), result.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const report = { ...summarizeBaseline(result.rows, fixture), environment: environment(hash) };
  await writeReport(directory, report);
  console.log(`Baseline saved: ${join(directory, "report.md")}`);
  console.log(`Local target gates: ${report.gatesPassed ? "PASS" : "FAIL"}; real-model quality NOT evaluated.`);
  if (values.enforce && !report.gatesPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await localBaseline();
}
