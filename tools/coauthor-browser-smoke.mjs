import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:1436" },
  playwright: { type: "string" },
  artifacts: { type: "string", default: ".tmp/coauthor-browser" },
} });
const { chromium } = await import(values.playwright ? pathToFileURL(values.playwright).href : "playwright");
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const errors = [];
const reports = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    // This replaces the transport only in this browser context. No fixture code
    // is bundled into production, and no request can reach a paid provider.
    await page.route("**/src/lib/ipc-transport.ts*", (route) => route.fulfill({
      contentType: "application/javascript",
      body: `
        const scope={projectId:"p1",sessionId:"s1"};
        const doc={sessionId:"s1",version:1,kind:"MANUSCRIPT",title:"第十二章 · 声音的代价",
          content:"他将最后一缕灵气压进魂灯。\\n\\n母亲曾在雨夜唤过他的名字。他记得那扇门，却再也记不起门后的人声。",
          targetKey:null,targetRevision:null,narrativePosition:"金丹突破之夜 · 陆沉限知视角"};
        let state={document:doc,decisions:[{id:"d1",topic:"突破代价",content:"金丹之后的突破，以失去一段记忆为代价。",
          status:"CHOSEN",sourceMessageId:"m1",version:1}],runs:[]};
        const messages=[
          {id:"m1",sessionId:"s1",role:"USER",content:"我想在金丹后面增加一个新境界，突破的代价改为失去记忆。"},
          {id:"m2",sessionId:"s1",role:"ASSISTANT",content:"《修炼体系》里已有炼气、筑基、金丹三个阶段，原本的突破代价是寿元。\\n\\n可以沿着已有体系扩展，在金丹后加一层“照魂境”。你已选择失忆代价，我会把它作为当前分支的方向，原设定暂不替换。"},
          {id:"m3",sessionId:"s1",role:"USER",content:"先拿主角突破写一段。他忘了母亲的声音，压抑一点。"}
        ];
        const listeners=new Set();
        export async function listen(event,handler){listeners.add(handler);return()=>listeners.delete(handler);}
        export async function waitForPendingCommands(){}
        export async function invoke(command,args={}){
          window.__coauthorCalls??=[];window.__coauthorCalls.push(command);
          if(command==="current_project")return {projectId:"p1",name:"照夜行",root:"fixture",formatVersion:1};
          if(command==="health_query")return {schemaVersion:52};
          if(command==="bootstrap_status")return {};
          if(command==="list_author_todos")return {pendingCount:0,items:[]};
          if(command==="list_discussion_sessions")return [{id:"s1",projectId:"p1",title:"照魂境 · 失忆版本",scopeKind:"PROJECT"}];
          if(command==="get_coauthor_state")return structuredClone(state);
          if(command==="list_model_profiles")return [{id:"model",name:"本地验收模型",capability:"CHAT",hasSecret:true}];
          if(command==="get_ai_task_preferences")return {};
          if(command==="get_project_ai_task_overrides")return {};
          if(command==="list_discussion_messages")return structuredClone(messages);
          if(command==="save_coauthor_document"){state.document={...args.document,version:args.document.version+1};return structuredClone(state.document);}
          if(command==="run_coauthor"){
            const input=args.input;messages.push({id:input.runId,sessionId:"s1",role:"USER",content:input.message});
            setTimeout(()=>listeners.forEach(handler=>handler({payload:{runId:input.runId,sessionId:"s1",kind:"text",content:"我保留前半段，只推敲最后一句。"}})),60);
            await new Promise(done=>setTimeout(done,350));
            const run={id:input.runId,sessionId:"s1",userMessageId:input.runId,status:"COMPLETED",
              documentVersion:input.expectedDocumentVersion,output:"我保留前半段，只推敲最后一句。",
              audit:[]};
            state.runs.unshift(run);
            messages.push({id:crypto.randomUUID(),sessionId:"s1",role:"ASSISTANT",content:run.output,contextVersion:"coauthor:"+run.id});
            return {state:structuredClone(state),runId:input.runId};
          }
          if(command==="cancel_coauthor_run")return;
          if(command==="list_coauthor_document_history")return [doc];
          if(command.startsWith("list_"))return [];
          throw new Error("Unimplemented browser fixture command: "+command);
        }`,
    }));
    await page.goto(`${values.url}/discussion`);
    await page.getByLabel("讨论输入", { exact: true }).waitFor();
    await page.getByText("照夜行", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-discussion.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `Horizontal overflow at ${viewport.width}px`);
    await page.getByLabel("讨论输入", { exact: true }).fill("前半段保留，最后一句再克制一点。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("我保留前半段，只推敲最后一句。", { exact: true }).first().waitFor();
    await page.waitForTimeout(450);
    if (viewport.width < 981) await page.getByRole("tab", { name: "工作稿" }).click();
    const draft = page.getByLabel("工作稿内容", { exact: true });
    await draft.waitFor({ state: "visible" });
    await draft.fill(`${await draft.inputValue()}\n\n作者继续写下去。`);
    await page.getByText(/已保存 v2/).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-draft.png`), fullPage: true });
    const boxes = await page.evaluate(() => {
      const selectors = [".coauthor-heading", ".coauthor-toolbar", ".coauthor-composer", ".coauthor-manuscript"];
      return selectors.map((selector) => {
        const el = document.querySelector(selector), box = el.getBoundingClientRect();
        const visible = Boolean(el.offsetWidth && el.offsetHeight);
        return { selector, visible, x: box.x, y: box.y, width: box.width, height: box.height,
          right: box.right, bottom: box.bottom };
      });
    });
    for (const box of boxes.filter((box) => box.visible)) {
      assert.ok(box.x >= 0 && box.right <= viewport.width + 1, `${box.selector} must fit ${viewport.width}px`);
      assert.ok(box.height > 0, `${box.selector} is not blank`);
    }
    reports.push({ viewport, overflow, boxes, commands: await page.evaluate(() => window.__coauthorCalls) });
    await context.close();
  }
  assert.deepEqual(errors, [], "No browser application errors");
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify({ mode: "mock-ipc-no-cloud", reports, errors }, null, 2));
  console.log(`Coauthor browser smoke passed, desktop and mobile. Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
