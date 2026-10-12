import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function until(read, predicate, label, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export function invoke(instance, command, args = {}) {
  return instance.page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}

export async function createDesktopHarness(prefix, app) {
  if (process.platform !== "win32") throw new Error("This harness requires Windows/WebView2.");
  const executable = resolve(app ?? join(workspace, "target/debug/ainoveltools-desktop.exe"));
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  await mkdir(join(workspace, ".tmp"), { recursive: true });
  const artifacts = await mkdtemp(join(workspace, `.tmp/${prefix}-`));
  const instances = [];
  const events = [];

  async function launch(name) {
    const state = join(artifacts, name);
    await mkdir(state, { recursive: true });
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((done) => server.close(done));
    const child = spawn(executable, [], {
      cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LOCALAPPDATA: state, APPDATA: state,
        WEBVIEW2_USER_DATA_FOLDER: join(state, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
    });
    const instance = { child, state, log: "", pageErrors: [], browser: null, acceptConfirm: true, confirmations: [] };
    instances.push(instance);
    child.on("error", (error) => { instance.log += error.stack; });
    child.stdout.on("data", (data) => { instance.log += data; });
    child.stderr.on("data", (data) => { instance.log += data; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Desktop exited: ${instance.log}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        return response.ok;
      } catch { return false; }
    }, Boolean, "WebView2 debugging endpoint");
    instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    instance.page = await until(() => Promise.resolve(instance.browser.contexts().flatMap((c) => c.pages())[0]), Boolean, "Tauri page");
    instance.page.on("pageerror", (error) => { instance.pageErrors.push(error.message); });
    instance.page.on("dialog", (dialog) => {
      if (dialog.type() === "confirm") {
        instance.confirmations.push(dialog.message());
        return instance.acceptConfirm ? dialog.accept() : dialog.dismiss();
      }
      return dialog.accept();
    });
    await instance.page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
    instance.origin = new URL(instance.page.url()).origin;
    assert.match(instance.origin, /tauri\.localhost|^tauri:\/\//, "must use built Tauri, not browser mocks");
    events.push({ stage: "desktop-launched", actor: name, pid: child.pid, origin: instance.origin });
    console.log(`Desktop launched: ${name}`);
    return instance;
  }

  async function stop(instance) {
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      const exited = once(instance.child, "exit");
      instance.child.kill();
      await Promise.race([exited, sleep(10_000).then(() => { throw new Error("Desktop process did not exit"); })]);
    }
    await instance.browser?.close().catch(() => {});
  }

  async function cleanup() {
    const errors = [];
    for (const instance of instances) {
      try {
        await stop(instance);
      } catch (error) {
        errors.push(error);
      }
      await writeFile(join(artifacts, `desktop-${instance.child.pid}.log`), instance.log);
    }
    if (errors.length) throw new AggregateError(errors, "Desktop cleanup failed");
  }

  return { artifacts, instances, events, launch, stop, cleanup };
}
