import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:1436" },
  playwright: { type: "string" },
  artifacts: { type: "string", default: ".tmp/content-workspace" },
  "outline-only": { type: "boolean", default: false },
  "include-mobile": { type: "boolean", default: false },
  "layout-only": { type: "boolean", default: false },
} });
const { chromium } = await import(values.playwright ? pathToFileURL(values.playwright).href : "playwright");
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const reports = [];
const errors = [];
let activePage;

// Browser-only transport fixture: only the explicit reference-copy save is allowed; no provider is called.
const transport = `
  const project={projectId:"p1",name:"雾城来信"};
  const nodes=[
    {id:"outline",kind:"OUTLINE",title:"主线大纲",parentId:null,revision:1,sortOrder:0,archived:false},
    {id:"preferences",kind:"WORK_DESIGN",title:"旧准备目录",parentId:null,revision:1,sortOrder:1,archived:false},
    {id:"manager",kind:"VOLUME_MANAGER",title:"分卷与章节",parentId:null,revision:1,sortOrder:2,archived:false},
    {id:"volume",kind:"VOLUME",title:"第一卷",parentId:"manager",revision:1,sortOrder:3,archived:false},
    {id:"chapter",kind:"CHAPTER",title:"第一章 入城",parentId:"volume",revision:1,sortOrder:4,archived:false},
    {id:"scene",kind:"SCENE",title:"城门收信",parentId:"chapter",revision:1,sortOrder:5,archived:false}
  ];
  const sections=[
    {id:"plan-node:outline",content:"正式大纲：邮差入城调查来信。",pendingContent:"候选：邮差离城。",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""},
    {id:"plan-node:chapter",content:"章节计划：在城门收到来信。",pendingContent:"",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""},
    {id:"seed-premise",content:"准备笔记：邮差收到未来来信。",pendingContent:"尚未采用的准备候选。",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""},
    {id:"seed-tone",content:"约二十万字，第三人称，节奏克制。",pendingContent:"",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""}
  ];
  const entity={entity:{id:"person",projectId:"p1",entityType:"CHARACTER",lifecycleStatus:"ACTIVE",
    currentRevisionId:"er1",version:1},revision:{id:"er1",entityId:"person",revision:1,name:"沈砚",
    aliases:[],description:"正式人物设定：城中邮差。",fixedAttributesJson:"{}",tags:[]}};
  const summary={id:"memory",projectId:"p1",kind:"CHAPTER",precision:"L1",sourceId:"chapter",
    content:"辅助摘要：邮差在城门收到来信。",generationMode:"EXTRACTIVE_AUTO",
    lifecycleStatus:"ACTIVE",sourceVersion:null,createdAt:"",updatedAt:""};
  const copies=JSON.parse(sessionStorage.getItem("content-workspace-copies")??"[]");
  const manuscript={id:"mr1",chapterId:"chapter",documentJson:JSON.stringify({type:"doc",content:[
    {type:"paragraph",content:[{type:"text",text:"正式正文：沈砚在城门前停下脚步。"}]}
  ]}),createdAt:"",contentHash:"hash"};
  export async function listen(){return ()=>{}}
  export async function waitForPendingCommands(){}
  export async function invoke(command,args={}){
    window.__contentCalls??=[];window.__contentCalls.push(command);
    if(command==="current_project")return project;
    if(command==="health_query")return {schemaVersion:66};
    if(command==="bootstrap_status"||command==="get_project_ai_task_overrides"||command==="get_ai_task_preferences")return {};
    if(command==="list_author_todos")return {projectId:"p1",pendingCount:2,items:[
      {kind:"FACT_REVIEW",targetId:"chapter",targetTitle:"第一章 入城",count:2,highRisk:true}
    ]};
    if(command==="list_ai_runs")return [{id:"writing-run",source:"WRITING",taskKey:"writing",action:"DRAFT",
      chapterId:"chapter",chapterTitle:"第一章 入城",status:"COMPLETED",profileName:"测试写作模型",
      estimatedInputTokens:1200,estimatedOutputTokens:2400,estimatedCostMicros:3500,priceCurrency:"USD",
      promptVersion:"test-v1",attemptCount:1,createdAt:"2026-10-28T00:00:00Z",finishedAt:"2026-10-28T00:00:12Z"}];
    if(command==="list_plan_nodes")return sessionStorage.getItem("content-workspace-no-outline")==="1"
      ? nodes.filter(node=>node.kind!=="OUTLINE") : nodes;
    if(command==="list_planning_sections")return sessionStorage.getItem("content-workspace-volume-plan")==="1"
      ? [...sections,{id:"plan-node:volume",content:"正式分卷规划：沈砚在雾城寻找来信的寄件人。\\n卷末，他发现寄件人正是未来的自己。",
        pendingContent:"未采用的分卷候选",storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""}]
      : sections;
    if(command==="list_entity_cards")return [entity];
    if(command==="list_entity_revisions")return [entity.revision];
    if(command==="list_author_settings")return [{id:"secret",entityId:"person",entityName:"沈砚",
      content:"作者保留设定：来信来自十年后的自己。",visibility:"AUTHOR_ONLY",sessionId:"s1",
      entityRevisionId:"er1",sourceProposalId:"proposal1"}];
    if(command==="list_current_facts")return [
      {knowledgeId:"fact1",subject:"沈砚",predicate:"任职",object:"邮差"},
      {knowledgeId:"fact2",subject:"城门",predicate:"位于",object:"雾城"}
    ];
    if(command==="list_relations")return [{id:"relation1",projectId:"p1",relationVersion:1,
      fromKnowledgeId:"fact1",toKnowledgeId:"fact2",relationType:"守护",
      evidenceAnchorIds:["anchor1"],lifecycleStatus:"ACTIVE",createdBy:"desktop-user",createdAt:"",updatedAt:""}];
    if(command==="list_evidence_anchors")return [{id:"anchor1",chapterId:"chapter",blockId:"block1"}];
    if(command==="list_summary_materials")return [summary,...copies];
    if(command==="get_summary_material"){
      const item=[summary,...copies].find(item=>item.id===args.id&&item.projectId===args.projectId);
      if(!item)throw new Error("Unknown summary target");
      return item;
    }
    if(command==="upsert_summary_material"){
      const item=args.material;
      if(item.projectId!=="p1"||item.id==="memory"||item.generationMode!=="MANUAL_REFERENCE")
        throw new Error("Unexpected summary write");
      copies.push(item);sessionStorage.setItem("content-workspace-copies",JSON.stringify(copies));
      return item;
    }
    if(command==="current_manuscript")return sessionStorage.getItem("content-workspace-empty-manuscript")==="1" ? null : manuscript;
    if(command==="current_manuscript_draft")return {
      chapterId:"chapter",version:1,documentJson:null,baseRevisionId:"mr1",baseDocumentJson:"",updatedAt:""};
    if(command==="get_audit_flow_settings")return {admission:true,manuscript:true,knowledge:true};
    if(command==="get_coauthor_state")return {
      document:{sessionId:"s1",kind:"UNCLASSIFIED",version:0,title:"未命名工作稿",content:"",
        targetKey:null,targetRevision:null,narrativePosition:""},runs:[],decisions:[]};
    if(command==="list_discussion_sessions")return [{id:"s1",projectId:"p1",title:"自由构思",scopeKind:"PROJECT"}];
    if(command==="list_coauthor_runs")return {runs:[],hasMore:false};
    if(command==="list_coauthor_decisions")return {memories:[],hasMore:false,offset:0};
    if(command.startsWith("list_"))return [];
    throw new Error("Unexpected command: "+command);
  }
`;

try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 820 },
    ...(values["include-mobile"] ? [{ width: 390, height: 844 }] : [])]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    activePage = page;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/src/lib/ipc-transport.ts*", route => route.fulfill({
      contentType: "application/javascript", body: transport,
    }));
    async function visit(path) {
      await page.goto(`${values.url}${path}`);
      await page.getByText("雾城来信", { exact: true }).first().waitFor();
    }
    async function capture(name) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `${name} has horizontal overflow at ${viewport.width}`);
      await page.screenshot({ path: resolve(artifacts, `${viewport.width}-${name}.png`), fullPage: true });
    }
    async function noButtons(pattern) {
      assert.equal(await page.getByRole("button", { name: pattern }).count(), 0);
    }

    if (values["layout-only"]) {
      await visit("/writing?planNode=chapter&targetProject=p1");
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      await page.locator(".workspace-directory").getByRole("button", { name: "第一卷", exact: true }).click();
      const volumeReader = page.getByRole("region", { name: "分卷概览", exact: true });
      await volumeReader.getByRole("heading", { name: "暂无分卷规划", exact: true }).waitFor();
      await volumeReader.getByText("分卷 · 1 章", { exact: true }).waitFor();
      assert.equal(await page.locator(".volume-focus-inspector").evaluate(element =>
        element.scrollHeight > element.clientHeight), false, "empty volume reader must not create an inner scrollbar");
      await capture("volume-reading-empty");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("volume-reading-empty-dark");
      await volumeReader.getByRole("link", { name: "编写分卷规划", exact: true }).click();
      await page.getByRole("textbox", { name: "正式规划", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("planNode"), "volume");
      assert.equal(new URL(page.url()).searchParams.get("targetProject"), "p1");
      assert.equal(await page.locator(".ai-category-nav [aria-current='page']").textContent(), "大纲");
      await page.evaluate(() => sessionStorage.setItem("content-workspace-volume-plan", "1"));
      await visit("/writing?planNode=chapter&targetProject=p1");
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      await page.locator(".workspace-directory").getByRole("button", { name: "第一卷", exact: true }).click();
      await volumeReader.getByText(/正式分卷规划：沈砚/).waitFor();
      assert.equal(await volumeReader.getByText("未采用的分卷候选", { exact: true }).count(), 0);
      await volumeReader.getByRole("link", { name: "编辑分卷规划", exact: true }).waitFor();
      await capture("volume-reading-saved");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("volume-reading-saved-dark");
      await volumeReader.getByRole("button", { name: "阅读本卷", exact: true }).click();
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("planNode"), "chapter");
      assert.equal(await page.getByRole("region", { name: "分卷概览", exact: true }).count(), 0);
      await page.evaluate(() => {
        sessionStorage.removeItem("content-workspace-volume-plan");
        document.documentElement.dataset.theme = "light";
      });
      assert.equal(await page.getByLabel("章节设置", { exact: true }).count(), 0);
      await page.getByText("导出正文", { exact: true }).waitFor();
      await capture("manuscript-reading");
      await page.getByLabel("更多操作", { exact: true }).click();
      await page.getByRole("link", { name: "检查正文", exact: true }).waitFor({ state: "visible" });
      const menu = await page.locator(".reader-more-menu").boundingBox();
      assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= viewport.width,
        "reader action menu must remain inside the desktop viewport");
      await capture("manuscript-reading-menu");
      await page.getByLabel("更多操作", { exact: true }).click();
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("manuscript-reading-dark");
      await page.evaluate(() => sessionStorage.setItem("content-workspace-empty-manuscript", "1"));
      await visit("/writing?planNode=chapter&targetProject=p1");
      await page.getByRole("heading", { name: "暂无正式正文", exact: true }).waitFor();
      await page.getByRole("link", { name: "去构思处理本章正文", exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "去构思处理本章正文", exact: true }).count(), 1);
      assert.equal(await page.locator(".chapter-focus-inspector").evaluate(element =>
        element.scrollHeight > element.clientHeight), false, "empty reader must not create an inner scrollbar");
      const empty = await page.locator(".chapter-reading-empty").boundingBox();
      const entry = await page.getByRole("link", { name: "去构思处理本章正文", exact: true }).boundingBox();
      assert.ok(empty && entry && Math.abs(entry.x + entry.width / 2 - empty.x - empty.width / 2) <= 2,
        "empty-state writing entry must be centered in the reading pane");
      await capture("manuscript-reading-empty");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("manuscript-reading-empty-dark");
      await page.evaluate(() => sessionStorage.removeItem("content-workspace-empty-manuscript"));
      await visit("/writing?planNode=chapter&targetProject=p1");
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      await page.getByRole("link", { name: "去构思处理本章正文", exact: true }).click();
      await page.getByRole("link", { name: "本章细纲", exact: true }).waitFor();
      assert.equal(await page.getByText("导出正文", { exact: true }).count(), 0);
      assert.equal(await page.locator(".project-workspace > .workspace-heading").count(), 0,
        "docked AI workspace must not retain an export-only toolbar");
      const toggle = page.getByRole("button", { name: "展开写作助手", exact: true });
      if (await toggle.isVisible()) await toggle.click();
      await page.getByRole("tab", { name: "本章计划", exact: true }).click();
      await page.getByText("章节计划：在城门收到来信。", { exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "本章计划", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "保存计划", exact: true }).count(), 0);
      await capture("writing-plan-preview");
      await page.getByRole("link", { name: "编辑本章细纲", exact: true }).click();
      await page.getByRole("region", { name: "章节细纲编辑", exact: true }).waitFor();
      assert.equal(await page.locator(".ai-category-nav [aria-current='page']").textContent(), "大纲");
      const plan = page.getByRole("textbox", { name: "本章计划", exact: true });
      await plan.fill("尚未保存的细纲修改");
      await page.getByRole("link", { name: "返回来源", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await plan.inputValue(), "尚未保存的细纲修改");
      await page.getByRole("link", { name: "返回来源", exact: true }).click();
      await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
      await page.getByRole("region", { name: "正文编辑", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("planNode"), "chapter");
      assert.equal(await page.locator(".ai-category-nav [aria-current='page']").textContent(), "正文");
      await capture("returned-writing-workspace");
      await visit("/jobs#ai-runs");
      await page.getByRole("link", { name: "打开处理工作区", exact: true }).waitFor();
      await capture("ai-run-record");
      await page.getByRole("link", { name: "打开处理工作区", exact: true }).click();
      await page.getByRole("region", { name: "正文编辑", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("planNode"), "chapter");
      assert.equal(new URL(page.url()).searchParams.get("targetProject"), "p1");
      await page.getByRole("link", { name: "返回来源", exact: true }).click();
      await page.getByRole("tab", { name: "AI 运行记录", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/jobs");
      assert.equal(new URL(page.url()).hash, "#ai-runs");
      assert.equal(await page.evaluate(() => window.__contentCalls.some(name =>
        /^(save_|run_coauthor|publish_|upsert_|enqueue_|create_)/.test(name))), false,
      "navigation must not write or start a model");
      reports.push({ viewport, passed: true });
      await context.close();
      continue;
    }

    await visit("/discussion?work=planning&targetProject=p1");
    const outlineReader = page.getByRole("main", { name: "全书大纲" });
    await outlineReader.getByText("正式大纲：邮差入城调查来信。", { exact: true }).waitFor();
    await outlineReader.getByRole("button", { name: "修改全书大纲", exact: true }).waitFor();
    assert.equal(await outlineReader.getByText("第一章 入城", { exact: true }).count(), 0,
      "reader must not repeat the directory");
    assert.equal(await page.getByText(/规划总览|大纲总览|关键准备待确认|继续当前准备|规划参考/).count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "创作准备内容" }).count(), 0);
    await noButtons(/导出正文/);
    await capture("outline-overview");
    if (viewport.width >= 900) {
      const chapterRect = await page.locator(".workspace-directory").getByRole("button", { name: "第一章 入城", exact: true }).boundingBox();
      const sceneRect = await page.locator(".workspace-directory").getByRole("button", { name: "城门收信", exact: true }).boundingBox();
      assert.ok(chapterRect && sceneRect && sceneRect.y >= chapterRect.y + chapterRect.height,
        "scene rows must appear below their chapter");
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await capture("outline-overview-dark");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    if (viewport.width < 900) await page.getByRole("button", { name: "大纲目录", exact: true }).click();
    await page.locator(".workspace-directory").getByRole("button", { name: "第一章 入城", exact: true }).click();
    await page.getByRole("region", { name: "章节细纲编辑", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "本章计划", exact: true }).inputValue(), "章节计划：在城门收到来信。");
    assert.equal(await page.evaluate(() => window.__contentCalls.includes("current_manuscript")
      || window.__contentCalls.includes("current_manuscript_draft")), false, "outline chapter editing must not read manuscript data");
    assert.equal(await page.locator(".ai-category-nav a[aria-current='page']").textContent(), "大纲");
    await noButtons(/保存正文|展开写作助手|导出正文/);
    await capture("outline-selected-chapter");
    await page.getByRole("link", { name: "全书大纲", exact: true }).click();
    await page.getByRole("button", { name: "规划分卷与章节", exact: true }).click();
    await page.getByText("规划依据", { exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "篇幅、风格与边界", exact: true }).count(), 0);
    await noButtons(/导出正文/);
    await page.getByRole("link", { name: "前往创作准备修改偏好", exact: true }).click();
    const preference = page.getByRole("textbox", { name: "篇幅、风格与边界", exact: true });
    await preference.waitFor();
    assert.equal(await page.getByRole("link", { name: "创作准备", exact: true }).getAttribute("aria-current"), "page");
    await capture("preparation-preferences");
    await preference.fill("正在修改的偏好");
    await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "大纲", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(await preference.inputValue(), "正在修改的偏好");
    await page.getByRole("link", { name: "返回来源", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await page.getByText("规划依据", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("planNode"), "manager");

    await page.evaluate(() => sessionStorage.setItem("content-workspace-no-outline", "1"));
    await visit("/discussion?work=planning&targetProject=p1");
    await page.getByRole("main", { name: "全书大纲" }).waitFor();
    await page.getByRole("button", { name: "编写全书大纲", exact: true }).waitFor();
    await capture("outline-before-first-outline");
    await visit("/planning");
    const missingReader = page.getByRole("main", { name: "全书大纲" });
    await missingReader.getByRole("link", { name: "编写全书大纲", exact: true }).waitFor();
    const structureLink = missingReader.getByRole("link", { name: "规划分卷与章节", exact: true });
    await structureLink.waitFor();
    const structureRect = await structureLink.boundingBox();
    assert.ok(structureRect && structureRect.y + structureRect.height < viewport.height - 24,
      "both primary outline tasks must be visible without scrolling");
    assert.equal(await missingReader.evaluate(element => element.scrollHeight > element.clientHeight), false,
      "an empty outline must not create an inner scrollbar");
    const outlineEmpty = await missingReader.locator(".outline-reader-empty").boundingBox();
    const outlineStart = await missingReader.getByRole("link", { name: "编写全书大纲", exact: true }).boundingBox();
    assert.ok(outlineEmpty && outlineStart
      && Math.abs(outlineStart.x + outlineStart.width / 2 - outlineEmpty.x - outlineEmpty.width / 2) <= 2,
      "the outline writing entry must be centered inside the reading pane");
    if (viewport.width >= 900) {
      assert.equal(await page.locator(".project-workspace > .workspace-heading").count(), 0,
        "desktop reader must not add an empty toolbar");
    }
    await capture("outline-reader-empty");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await capture("outline-reader-empty-dark");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await structureLink.click();
    await page.getByText("规划依据", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("planNode"), "manager");
    await visit("/planning?mode=prepare&item=outline");
    await page.getByRole("link", { name: "去构思处理主线大纲", exact: true }).waitFor();
    await noButtons(/发起讨论|建立主线大纲/);
    await page.evaluate(() => sessionStorage.removeItem("content-workspace-no-outline"));
    await visit("/planning");
    await page.getByRole("main", { name: "全书大纲" }).waitFor();
    await page.getByRole("link", { name: "修改全书大纲", exact: true }).waitFor();
    await noButtons(/新建章节|打开全书大纲|导出正文/);
    await capture("outline-overview-reader");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await capture("outline-overview-reader-dark");
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    for (const [id, title, content, expectedTab] of [
      ["manager", "分卷与章节", "暂无正式分卷与章节结构", null],
      ["scene", "城门收信", "暂无正式场景安排", null],
      ["chapter", "第一章 入城", "章节计划：在城门收到来信。", "plan"],
    ]) {
      await visit(`/planning?mode=structure&planNode=${id}&targetProject=p1`);
      const reader = page.getByRole("region", { name: `${title}正式内容`, exact: true });
      await reader.getByText(content, { exact: true }).waitFor();
      assert.equal(await page.locator(".plan-inspector").evaluate(element => element.scrollHeight > element.clientHeight),
        false, `${id} outline reader must not have unnecessary inner scrolling`);
      await capture(`outline-node-${id}`);
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture(`outline-node-${id}-dark`);
      await reader.getByRole("link", { name: `去构思处理${title}`, exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get("planNode"), id);
      assert.equal(new URL(page.url()).searchParams.get("targetProject"), "p1");
      assert.equal(new URL(page.url()).searchParams.get("tab"), expectedTab);
      if (id === "manager") await page.getByText("规划依据", { exact: true }).waitFor();
      else if (id === "chapter") await page.getByRole("region", { name: "章节细纲编辑", exact: true }).waitFor();
      else await page.getByRole("textbox", { name: "正式规划", exact: true }).waitFor();
      assert.equal(await page.locator(".ai-category-nav [aria-current='page']").textContent(), "大纲");
    }
    await visit("/planning?mode=structure&planNode=outline&targetProject=p1");
    await page.getByRole("main", { name: "全书大纲" }).getByText("正式大纲：邮差入城调查来信。", { exact: true }).waitFor();
    await page.getByRole("link", { name: "修改全书大纲", exact: true }).click();
    await page.getByText("大纲 · 全书大纲", { exact: true }).first().waitFor();
    if (values["outline-only"]) {
      reports.push({ viewport, passed: true, scope: "outline" });
      await context.close();
      continue;
    }

    await visit("/knowledge?entity=person&targetProject=p1");
    await page.evaluate(() => { window.__workspaceDocumentToken = "retained-document"; });
    await page.getByText("正式人物设定：城中邮差。", { exact: true }).waitFor();
    await noButtons(/新建实体|编辑实体|导入实体/);
    await capture("setting-reader");
    await page.getByRole("link", { name: "去构思处理人物设定" }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "知识资料分类" }).count(), 0);
    assert.equal(await page.locator("h1").count(), 1);
    await page.getByText("设定 · 人物", { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑实体", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__workspaceDocumentToken), "retained-document",
      "entering the AI workspace should keep the document mounted");
    await capture("setting-workspace");
    if (viewport.width < 851) {
      assert.equal(await page.getByRole("complementary", { name: "实体列表" }).isVisible(), false);
      assert.equal(await page.getByRole("textbox", { name: "搜索实体" }).isVisible(), false);
      await page.getByRole("button", { name: "返回设定列表", exact: true }).click();
      await page.getByRole("textbox", { name: "搜索实体" }).fill("邮差");
      await capture("setting-mobile-list");
      await page.getByRole("button", { name: /沈砚.*人物/ }).click();
      await page.getByRole("button", { name: "返回设定列表", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "搜索实体" }).inputValue(), "邮差");
      await page.getByRole("button", { name: /沈砚.*人物/ }).click();
      await page.getByRole("button", { name: "编辑实体", exact: true }).click();
      await page.getByRole("textbox", { name: "名称", exact: true }).fill("未保存的人物修改");
      page.once("dialog", dialog => dialog.dismiss());
      await page.getByRole("button", { name: "返回设定列表", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "未保存的人物修改");
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("heading", { name: "沈砚", exact: true }).waitFor();
    }
    const categories = page.getByRole("navigation", { name: "AI 内容分类" });
    await categories.getByRole("link", { name: "辅助参考", exact: true }).click();
    await page.getByRole("complementary", { name: "参考资料列表", exact: true }).waitFor();
    await categories.getByRole("link", { name: "设定", exact: true }).click();
    await page.getByRole("complementary", { name: "实体列表", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "沈砚", exact: true }).count(), 0,
      "a category landing page must not reuse the previous exact-object selection");
    await page.goBack();
    await page.getByRole("complementary", { name: "参考资料列表", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "编辑实体", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("entity"), "person");
    assert.equal(await page.evaluate(() => window.__workspaceDocumentToken), "retained-document",
      "category changes and browser history must not reload the workspace document");
    await page.getByRole("link", { name: "返回设定", exact: true }).click();
    await page.getByText("正式人物设定：城中邮差。", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("entity"), "person");
    assert.equal(await page.evaluate(() => window.__workspaceDocumentToken), "retained-document");

    await visit("/planning?mode=structure&planNode=outline&targetProject=p1");
    await page.getByText("正式大纲：邮差入城调查来信。", { exact: true }).waitFor();
    assert.equal(await page.getByText("候选：邮差离城。", { exact: true }).count(), 0);
    await noButtons(/AI 推敲|保存草稿|生成分卷方案/);
    await capture("outline-reader");
    await page.getByRole("link", { name: "修改全书大纲", exact: true }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    await page.getByText("大纲 · 全书大纲", { exact: true }).first().waitFor();
    await capture("outline-workspace");

    await visit("/writing?planNode=chapter&targetProject=p1");
    await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
    await noButtons(/保存正文|展开写作助手|检查正文/);
    await capture("manuscript-reader");
    assert.equal(await page.getByRole("link", { name: "检查正文", exact: true }).isVisible(), false);
    await page.getByLabel("更多操作", { exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "检查正文", exact: true }).isVisible(), true);
    await page.getByRole("link", { name: "大纲 · 本章计划", exact: true }).click();
    await page.getByRole("region", { name: "章节细纲编辑", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "本章计划", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "保存正文", exact: true }).count(), 0);
    assert.equal(await page.getByRole("tab", { name: "AI 写作", exact: true }).count(), 0);
    assert.equal(await page.locator(".ai-category-nav a[aria-current='page']").textContent(), "大纲");
    if (viewport.width >= 1280) {
      assert.equal(await page.getByRole("button", { name: "章节目录", exact: true }).count(), 0);
      await page.getByRole("button", { name: "关闭章节目录", exact: true }).click();
      await page.getByRole("button", { name: "章节目录", exact: true }).click();
      await page.getByRole("button", { name: "关闭章节目录", exact: true }).waitFor();
    }
    await capture("chapter-plan-workspace");
    await page.getByRole("link", { name: "返回大纲 · 章节细纲", exact: true }).click();
    await page.getByText("章节计划：在城门收到来信。", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("planNode"), "chapter");

    await visit("/knowledge/materials?summary=memory&targetProject=p1");
    await page.getByText("辅助摘要：邮差在城门收到来信。", { exact: true }).waitFor();
    await noButtons(/编辑参考副本|重新生成/);
    await capture("reference-reader");
    await page.getByRole("link", { name: "去构思处理此参考", exact: true }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑参考副本", exact: true }).waitFor();
    await capture("reference-workspace");
    const referenceList = page.getByRole("link", { name: "参考列表", exact: true });
    assert.equal(new URL(await referenceList.getAttribute("href"), values.url).pathname, "/discussion");
    await referenceList.click();
    await page.getByRole("complementary", { name: "参考资料列表", exact: true }).waitFor();
    await capture("reference-list-workspace");
    await visit("/discussion?work=materials&targetProject=p1&summary=memory&materialKind=SUMMARY");
    await page.getByRole("button", { name: "编辑参考副本", exact: true }).click();
    await page.getByRole("textbox", { name: "摘要内容", exact: true }).fill("作者整理的参考副本。");
    await page.getByRole("link", { name: "参考列表", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "摘要内容", exact: true }).inputValue(), "作者整理的参考副本。");
    const nativeWarning = page.waitForEvent("dialog");
    const nativeLeave = page.evaluate(() => { window.location.assign("/discussion"); });
    const warning = await nativeWarning;
    assert.equal(warning.type(), "beforeunload");
    await warning.dismiss();
    await nativeLeave;
    assert.equal(await page.getByRole("textbox", { name: "摘要内容", exact: true }).inputValue(), "作者整理的参考副本。");
    const dialogs = [];
    const onDialog = async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); };
    page.on("dialog", onDialog);
    await page.getByRole("button", { name: "另存为参考摘要", exact: true }).click();
    try {
      await page.waitForURL(url => url.pathname === "/discussion" && url.searchParams.get("summary") !== "memory", { timeout: 10_000 });
    } catch (error) {
      console.error(JSON.stringify({ url: page.url(), dialogs, text: await page.locator("body").innerText(),
        calls: await page.evaluate(() => window.__contentCalls), errors }, null, 2));
      await capture("reference-copy-failure");
      throw error;
    }
    await page.getByText("作者整理的参考副本。", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/discussion");
    assert.notEqual(new URL(page.url()).searchParams.get("summary"), "memory");
    assert.deepEqual(dialogs, [], "a successful copy save must not prompt about unsaved changes");
    page.off("dialog", onDialog);
    const copies = await page.evaluate(() => JSON.parse(sessionStorage.getItem("content-workspace-copies") ?? "[]"));
    assert.equal(copies.length, 1);
    assert.equal(copies[0].generationMode, "MANUAL_REFERENCE");
    await capture("saved-reference-copy");

    await visit("/discussion?work=materials&targetProject=p1&materialKind=SUMMARY&action=new");
    await page.getByRole("textbox", { name: "摘要内容", exact: true }).waitFor();
    await capture("new-reference");
    for (const [target, content] of [
      ["work=entity&entity=person", "正式人物设定：城中邮差。"],
      ["work=materials&summary=memory", "辅助摘要：邮差在城门收到来信。"],
      ["work=writing&planNode=chapter", "正式正文：沈砚在城门前停下脚步。"],
      ["work=planning&planNode=outline", "正式大纲：邮差入城调查来信。"],
    ]) {
      await visit(`/discussion?${target}&targetProject=p1&returnTo=%2Fsearch%3Fq%3Dtest`);
      await page.getByText(content, { exact: true }).first().waitFor({ state: "attached" });
      const back = page.getByRole("link", { name: "返回来源", exact: true });
      await back.waitFor();
      assert.equal(await back.count(), 1, `${target} should have only one source-return action`);
    }
    await visit("/discussion?work=writing&targetProject=foreign&planNode=chapter");
    await page.getByRole("alert").filter({ hasText: "未打开其他对象" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "工作稿内容" }).count(), 0);
    await capture("foreign-target");

    await visit("/knowledge/records");
    const recordItem = page.getByRole("button", { name: /守护/ });
    await recordItem.waitFor();
    await page.getByRole("textbox", { name: "搜索剧情记录", exact: true }).fill("守护");
    await capture("records-list");
    await recordItem.click();
    await page.getByRole("region", { name: "剧情记录详情", exact: true }).waitFor();
    await capture("records-detail");
    if (viewport.width < 851) {
      assert.equal(await page.getByRole("textbox", { name: "搜索剧情记录" }).isVisible(), false);
      await page.getByRole("button", { name: "返回记录列表" }).click();
      assert.equal(await page.getByRole("textbox", { name: "搜索剧情记录" }).inputValue(), "守护");
      await recordItem.click();
    }
    await page.getByRole("link", { name: "去构思处理此关系记录", exact: true }).click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).waitFor();
    const activeRecordCategory = await page.locator(".ai-category-nav a[aria-current='page']").boundingBox();
    const recordNav = await page.locator(".ai-category-nav").boundingBox();
    assert.ok(activeRecordCategory && recordNav && activeRecordCategory.x >= recordNav.x - 1
      && activeRecordCategory.x + activeRecordCategory.width <= recordNav.x + recordNav.width + 1,
    "the active AI category must be in view");
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    await page.getByRole("textbox", { name: "关系类型", exact: true }).fill("未保存的关系");
    if (viewport.width < 851) {
      page.once("dialog", dialog => dialog.dismiss());
      await page.getByRole("button", { name: "返回记录列表" }).click();
      assert.equal(await page.getByRole("textbox", { name: "关系类型", exact: true }).inputValue(), "未保存的关系");
    }
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).waitFor();

    await visit("/knowledge/settings");
    const libraryNav = page.getByRole("navigation", { name: "知识资料分类" });
    assert.deepEqual(await libraryNav.getByRole("link").allTextContents(), ["设定", "剧情记录", "辅助参考"]);
    assert.equal(await libraryNav.getByRole("link", { name: "设定", exact: true }).getAttribute("aria-current"), "location");
    await page.getByRole("button", { name: /沈砚/ }).click();
    await page.getByRole("region", { name: "设定揭示详情", exact: true }).waitFor();
    await capture("setting-reveal-detail");
    if (viewport.width < 851) {
      await page.getByRole("button", { name: "返回设定列表" }).click();
      await page.getByRole("textbox", { name: "搜索作者设定", exact: true }).waitFor();
      await capture("setting-reveal-list");
    }

    await visit("/review");
    await page.getByText("冲突阻断定稿", { exact: true }).waitFor();
    await capture("review");
    await page.getByRole("combobox", { name: "待办类型", exact: true }).selectOption("EXTRACTION");
    await page.getByText("此类暂无待办", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看全部待办", exact: true }).click();
    await page.getByText("冲突阻断定稿", { exact: true }).waitFor();

    await visit("/settings");
    await page.getByRole("navigation", { name: "设置分类", exact: true }).waitFor();
    await capture("settings-model");
    await page.getByRole("button", { name: "审核流程", exact: true }).click();
    await page.getByRole("button", { name: "审核流程", exact: true }).getAttribute("aria-current");
    await capture("settings-review");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await capture("settings-review-dark");
    reports.push({ viewport, passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify({ reports, errors }, null, 2));
  console.log(JSON.stringify({ reports, errors, artifacts }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    console.error(JSON.stringify({ url: activePage.url(), text: await activePage.locator("body").innerText(), errors }, null, 2));
    await activePage.screenshot({ path: resolve(artifacts, "workflow-failure.png"), fullPage: true });
  }
  throw error;
} finally { await browser.close(); }
