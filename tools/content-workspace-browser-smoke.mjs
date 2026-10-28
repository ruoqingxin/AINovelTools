import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:1436" },
  playwright: { type: "string" },
  artifacts: { type: "string", default: ".tmp/content-workspace" },
} });
const { chromium } = await import(values.playwright ? pathToFileURL(values.playwright).href : "playwright");
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const reports = [];
const errors = [];

// Browser-only transport fixture: unexpected writes fail and no provider is called.
const transport = `
  const project={projectId:"p1",name:"雾城来信"};
  const nodes=[
    {id:"outline",kind:"OUTLINE",title:"主线大纲",parentId:null,revision:1,sortOrder:0,archived:false},
    {id:"chapter",kind:"CHAPTER",title:"第一章 入城",parentId:null,revision:1,sortOrder:1,archived:false}
  ];
  const sections=[
    {id:"plan-node:outline",content:"正式大纲：邮差入城调查来信。",pendingContent:"候选：邮差离城。",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""},
    {id:"plan-node:chapter",content:"章节计划：在城门收到来信。",pendingContent:"",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""},
    {id:"seed-premise",content:"准备笔记：邮差收到未来来信。",pendingContent:"尚未采用的准备候选。",
      storyState:"CONFIRMED",rationale:"",consequence:"",references:[],version:1,updatedAt:""}
  ];
  const entity={entity:{id:"person",projectId:"p1",entityType:"CHARACTER",lifecycleStatus:"ACTIVE",
    currentRevisionId:"er1",version:1},revision:{id:"er1",entityId:"person",revision:1,name:"沈砚",
    aliases:[],description:"正式人物设定：城中邮差。",fixedAttributesJson:"{}",tags:[]}};
  const summary={id:"memory",projectId:"p1",kind:"CHAPTER",precision:"L1",sourceId:"chapter",
    content:"辅助摘要：邮差在城门收到来信。",generationMode:"EXTRACTIVE_AUTO",
    lifecycleStatus:"ACTIVE",sourceVersion:null,createdAt:"",updatedAt:""};
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
    if(command==="list_author_todos")return {pendingCount:0,items:[]};
    if(command==="list_plan_nodes")return nodes;
    if(command==="list_planning_sections")return sections;
    if(command==="list_entity_cards")return [entity];
    if(command==="list_entity_revisions")return [entity.revision];
    if(command==="list_summary_materials")return [summary];
    if(command==="get_summary_material")return summary;
    if(command==="current_manuscript")return manuscript;
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
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
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

    await visit("/knowledge?entity=person&targetProject=p1");
    await page.getByText("正式人物设定：城中邮差。", { exact: true }).waitFor();
    await noButtons(/新建实体|编辑实体|导入实体/);
    await capture("setting-reader");
    await page.getByRole("link", { name: "去构思处理人物设定" }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    await page.getByText("设定 · 人物", { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑实体", exact: true }).waitFor();
    await capture("setting-workspace");

    await visit("/planning?mode=structure&planNode=outline&targetProject=p1");
    await page.getByText("正式大纲：邮差入城调查来信。", { exact: true }).waitFor();
    assert.equal(await page.getByText("候选：邮差离城。", { exact: true }).count(), 0);
    await noButtons(/AI 推敲|保存草稿|生成分卷方案/);
    await capture("outline-reader");
    await page.getByRole("link", { name: "去构思处理主线大纲" }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    await page.getByText("大纲 · 全书大纲", { exact: true }).first().waitFor();
    await capture("outline-workspace");

    await visit("/writing?planNode=chapter&targetProject=p1");
    await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
    await noButtons(/保存正文|展开写作助手|检查正文/);
    await capture("manuscript-reader");
    await page.getByRole("link", { name: "大纲 · 本章计划", exact: true }).click();
    await page.getByRole("heading", { name: "大纲 · 章节细纲", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "本章计划", exact: true }).waitFor();
    await capture("chapter-plan-workspace");

    await visit("/knowledge/materials?summary=memory&targetProject=p1");
    await page.getByText("辅助摘要：邮差在城门收到来信。", { exact: true }).waitFor();
    await noButtons(/编辑参考副本|重新生成/);
    await capture("reference-reader");
    await page.getByRole("link", { name: "去构思处理此参考", exact: true }).click();
    await page.getByRole("heading", { name: "AI 工作区", exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑参考副本", exact: true }).waitFor();
    await capture("reference-workspace");

    await visit("/discussion?work=materials&targetProject=p1&materialKind=SUMMARY&action=new");
    await page.getByRole("textbox", { name: "摘要内容", exact: true }).waitFor();
    await capture("new-reference");
    await visit("/discussion?work=writing&targetProject=foreign&planNode=chapter");
    await page.getByRole("alert").filter({ hasText: "未打开其他对象" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "工作稿内容" }).count(), 0);
    await capture("foreign-target");
    reports.push({ viewport, passed: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify({ reports, errors }, null, 2));
  console.log(JSON.stringify({ reports, errors, artifacts }, null, 2));
} finally { await browser.close(); }
