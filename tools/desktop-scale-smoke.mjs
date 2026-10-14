import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDesktopHarness, invoke, until } from "./desktop-smoke-runtime.mjs";

const { values } = parseArgs({ options: { app: { type: "string" } } });
const { artifacts, instances, events, launch, stop, cleanup } = await createDesktopHarness("desktop-scale", values.app);

async function check(instance, stage, scale) {
  const geometry = await instance.page.evaluate(() => ({
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    workspaceOverflow: document.querySelector(".workspace").scrollWidth - document.querySelector(".workspace").clientWidth,
    dialogs: [...document.querySelectorAll('dialog[open]:not([data-docked="true"])')].map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: element.scrollWidth - element.clientWidth };
    }),
  }));
  assert(Math.abs(geometry.dpr - scale) < .05, `WebView2 did not apply the requested display scale: ${JSON.stringify(geometry)}`);
  assert(geometry.pageOverflow <= 1 && geometry.workspaceOverflow <= 1, `${stage}: ${JSON.stringify(geometry)}`);
  for (const box of geometry.dialogs) assert(box.left >= -1 && box.top >= -1 && box.right <= geometry.width + 1
    && box.bottom <= geometry.height + 1 && box.overflow <= 1, `${stage}: ${JSON.stringify(box)}`);
  await instance.page.screenshot({ path: join(artifacts, `${scale}-${stage}.png`) });
  events.push({ stage, scale, ...geometry });
}

async function reachable(locator) {
  await locator.scrollIntoViewIfNeeded();
  assert(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.top >= 0 && box.bottom <= innerHeight + 1 && hit && element.contains(hit);
  }), `Critical control is obscured: ${await locator.innerText()}`);
}

try {
  for (const scale of [1.5, 2]) {
    const instance = await launch(`scale-${scale}`, { deviceScaleFactor: scale });
    assert.equal(await invoke(instance, "current_project"), null);
    const root = join(artifacts, `project-${scale}`);
    const manifest = await invoke(instance, "create_project", { root, name: "Display scale acceptance" });
    await invoke(instance, "open_project", { root });
    const manager = await invoke(instance, "create_plan_node", { kind: "VOLUME_MANAGER", title: "Volumes", parentId: null });
    const volume = await invoke(instance, "create_plan_node", { kind: "VOLUME", title: "Volume 1", parentId: manager.id });
    const chapter = await invoke(instance, "create_plan_node", { kind: "CHAPTER", title: "Chapter 1", parentId: volume.id });
    await instance.page.goto(`${instance.origin}/writing#${chapter.id}`);
    const editor = instance.page.locator(".tiptap-editor");
    await editor.waitFor();
    await instance.page.getByLabel("外观", { exact: true }).click();
    await instance.page.getByRole("button", { name: "深色", exact: true }).click();
    await editor.fill("Native scaled writing acceptance. 中文正文。");
    await reachable(instance.page.getByRole("button", { name: "保存正文", exact: true }));
    await instance.page.getByRole("button", { name: "保存正文", exact: true }).click();
    await until(() => invoke(instance, "current_manuscript", { chapterId: chapter.id }),
      (revision) => revision?.documentJson.includes("Native scaled writing"), "scaled editor save");
    await check(instance, "writing", scale);
    if (!await instance.page.getByRole("button", { name: "新建章节", exact: true }).isVisible())
      await instance.page.getByRole("button", { name: "章节目录", exact: true }).click();
    await instance.page.getByRole("button", { name: "新建章节", exact: true }).click();
    const create = instance.page.getByRole("dialog", { name: "新建章节", exact: true });
    await reachable(create.getByRole("button", { name: "创建章节", exact: true }));
    await create.getByRole("textbox", { name: "章节名称", exact: true }).fill("Unsaved chapter");
    await create.getByRole("button", { name: "关闭新建章节", exact: true }).click();
    const confirm = instance.page.getByRole("alertdialog");
    await check(instance, "nested-confirmation", scale);
    await reachable(confirm.getByRole("button", { name: "取消", exact: true }));
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await create.getByRole("textbox", { name: "章节名称", exact: true }).inputValue(), "Unsaved chapter");
    await create.getByRole("button", { name: "关闭新建章节", exact: true }).click();
    await instance.page.getByRole("button", { name: "放弃章节信息", exact: true }).click();
    await create.waitFor({ state: "detached" });
    for (const route of ["/planning", "/knowledge/materials", "/discussion", "/review", "/jobs", "/settings"]) {
      await instance.page.goto(`${instance.origin}${route}`);
      await instance.page.locator(".global-toolbar").waitFor();
      await instance.page.waitForTimeout(350);
      await check(instance, route.slice(1).replaceAll("/", "-"), scale);
    }
    await instance.page.getByRole("textbox", { name: "配置名称", exact: true }).fill("Unsaved model name");
    await instance.page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "AI 任务模型", exact: true }).click();
    await check(instance, "settings-confirmation", scale);
    await instance.page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
    await instance.page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(await instance.page.getByRole("textbox", { name: "配置名称", exact: true }).inputValue(), "Unsaved model name");
    await instance.page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: "AI 任务模型", exact: true }).click();
    await instance.page.getByRole("button", { name: "放弃修改并切换", exact: true }).click();
    for (const [label, stage] of [["AI 任务模型", "task-settings"], ["审核流程", "audit-settings"], ["AI 用量与预算", "budget-settings"], ["数据管理", "data-settings"]]) {
      await instance.page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: label, exact: true }).click();
      await instance.page.waitForTimeout(150);
      if (stage === "data-settings") await reachable(instance.page.getByRole("button", { name: "创建备份", exact: true }));
      await check(instance, stage, scale);
    }
    assert.deepEqual(instance.pageErrors, []);
    assert.deepEqual(instance.confirmations, [], "migrated actions must not invoke browser confirmation");
    assert.equal((await invoke(instance, "current_project")).projectId, manifest.projectId);
    await invoke(instance, "close_project");
    await stop(instance);
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, events }, null, 2));
  console.log(`Native scaled acceptance passed: ${artifacts}`);
} catch (error) {
  for (const instance of instances) {
    await instance.page?.screenshot({ path: join(artifacts, `failure-${instance.child.pid}.png`) }).catch(() => {});
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: false, error: String(error), events }, null, 2));
  console.error(`Acceptance artifacts: ${artifacts}`);
  throw error;
} finally { await cleanup(); }
