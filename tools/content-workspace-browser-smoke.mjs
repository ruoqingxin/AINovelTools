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
  "structure-only": { type: "boolean", default: false },
  "writing-directory-only": { type: "boolean", default: false },
  "preparation-only": { type: "boolean", default: false },
  "navigation-only": { type: "boolean", default: false },
  "coauthor-only": { type: "boolean", default: false },
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

// Browser-only transport fixture: explicit reference copies and preparation smoke saves only; no provider is called.
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
    const structure=sessionStorage.getItem("content-workspace-structure");
    if(command==="save_planning_section_checked"&&${Boolean(values["preparation-only"])}){
      const previous=JSON.parse(sessionStorage.getItem("book-preparation-saved")??"null")??sections.find(item=>item.id==="seed-tone");
      if(args.section.id!=="seed-tone"||args.expectedVersion!==previous.version)throw new Error("Unexpected preparation write");
      const saved={...args.section,version:previous.version+1};
      sessionStorage.setItem("book-preparation-saved",JSON.stringify(saved));
      return saved;
    }
    if(command==="list_planning_sections"&&sessionStorage.getItem("book-preparation-saved"))
      return sections.map(item=>item.id==="seed-tone"?JSON.parse(sessionStorage.getItem("book-preparation-saved")):item);
    if(command==="list_plan_nodes"&&structure)return nodes.filter(node=>node.kind!=="SCENE");
    if(command==="list_plan_nodes")return sessionStorage.getItem("content-workspace-no-outline")==="1"
      ? nodes.filter(node=>node.kind!=="OUTLINE") : nodes;
    if(command==="list_planning_sections"&&structure){
      const section=(id,content,pendingContent="")=>({id,content,pendingContent,storyState:"CONFIRMED",
        rationale:"",consequence:"",references:[],version:1,updatedAt:""});
      return [
        ...sections.filter(item=>item.id==="seed-tone"),
        section("plan-node:outline","正式大纲：邮差入城调查来信。",structure==="empty"?"待作者审定的大纲候选":""),
        ...(structure==="candidate"?[section("plan-node:manager","","第1卷·雾城｜寻找寄件人\\n第2卷·来信｜揭开真相")]:[]),
        ...(["planned","review"].includes(structure)?[
          section("plan-node:manager","已采用的分卷方案"),
          section("plan-node:volume","沈砚在雾城寻找寄件人，卷末发现来信来自未来。",structure==="review"?"尚未采用的后续修改":""),
          section("chapter-split-volume","","第2章·问路｜追查寄件人\\n第3章·夜访｜发现未来来信")
        ]:[])
      ];
    }
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
      chapterId:"chapter",version:1,
      documentJson:sessionStorage.getItem("content-workspace-recovery-draft")==="1"?manuscript.documentJson:null,
      baseRevisionId:"mr1",baseDocumentJson:"",updatedAt:""};
    if(command==="get_audit_flow_settings")return {admission:true,manuscript:true,knowledge:true};
    if(${Boolean(values["coauthor-only"])}){
      if(command==="list_discussion_sessions")return [{id:"s1",projectId:"p1",title:"未来来信的悬念与伏笔",scopeKind:"PROJECT"}];
      if(command==="list_discussion_messages"){
        const offset=args.beforeMessageId?-20:0;
        return Array.from({length:args.beforeMessageId?20:100},(_,index)=>({
          id:"message-"+(index+offset),sessionId:"s1",role:index%2?"ASSISTANT":"USER",
          content: index%2 ? "第"+(index+offset)+"轮讨论：来信的日期与邮戳并不一致，沈砚应先核对城门记录，再判断来信的来源。\\n"
            +"可以保留三个线索：缺失的一页名册、旧邮局的钟声、信封上未干的墨迹。暂不揭示寄件人的身份。"
            : "第"+(index+offset)+"轮提问：这一章如何安排悬念，让主角的选择有充分动机？"
        }));
      }
      if(command==="get_coauthor_state")return {
        document:JSON.parse(sessionStorage.getItem("coauthor-layout-draft")??"null")??{
          sessionId:"s1",kind:"MANUSCRIPT",version:1,title:"城门来信",
          content:("沈砚在城门前停下脚步。信封上的字迹很熟悉，但邮戳却来自十年之后。\\n\\n").repeat(30),
          targetKey:null,targetRevision:null,narrativePosition:"第三人称 · 入城前"},runs:[],decisions:[]};
      if(command==="save_coauthor_document"){
        const saved={...args.document,version:args.document.version+1};
        sessionStorage.setItem("coauthor-layout-draft",JSON.stringify(saved));
        return saved;
      }
    }
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
    async function selectedWorkspace(label) {
      const navigation = page.locator("#primary-navigation");
      await navigation.getByRole("link", { name: label, exact: true }).waitFor();
      assert.deepEqual(await navigation.locator('a[aria-current="page"]').allTextContents(), [label]);
      assert.deepEqual(await navigation.locator('a[data-active="true"]').allTextContents(), [label]);
    }
    async function selectedCategory(label) {
      const navigation = page.getByRole("navigation", { name: "AI 内容分类" });
      await navigation.waitFor();
      assert.deepEqual(await navigation.locator('a[aria-current="page"]').allTextContents(), [label]);
    }

    if (values["coauthor-only"]) {
      await visit("/discussion");
      const input = page.getByRole("textbox", { name: "讨论输入", exact: true });
      const manuscript = page.getByRole("textbox", { name: "工作稿内容", exact: true, includeHidden: true });
      const log = page.getByRole("log", { name: "讨论记录" });
      const split = page.getByRole("button", { name: "并排显示讨论与工作稿", exact: true });
      await input.waitFor();
      await log.locator("article").last().waitFor();
      async function assertFits() {
        const metrics = await page.evaluate(() => {
          const box = selector => {
            const element = document.querySelector(selector);
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, height: rect.height };
          };
          const shell = document.querySelector('.unified-ai-workspace');
          const thread = document.querySelector(".coauthor-thread");
          return { composer: box(".coauthor-composer"), thread: box(".coauthor-thread"),
            shell: box(".unified-ai-workspace"), shellScroll: shell.scrollHeight-shell.clientHeight,
            bottom: innerHeight-26, remaining: thread.scrollHeight-thread.scrollTop-thread.clientHeight };
        });
        assert.ok(metrics.composer.bottom <= metrics.bottom, JSON.stringify(metrics));
        assert.ok(metrics.thread.height >= 120, JSON.stringify(metrics));
        assert.ok(metrics.thread.bottom <= metrics.composer.top, JSON.stringify(metrics));
        assert.ok(metrics.shellScroll <= 1, JSON.stringify(metrics));
      }
      await assertFits();
      assert.ok(await log.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight) < 5, "initial history opens at latest");
      await capture("coauthor-discussion");
      await input.fill("保留当前未发送的问题");
      await split.click();
      await manuscript.waitFor({ state: "visible" });
      assert.equal(await split.getAttribute("aria-pressed"), "true");
      await assertFits();
      await manuscript.fill("工作稿编辑保留，不能因布局切换丢失。");
      await capture("coauthor-split");
      const draftBounds = await manuscript.boundingBox();
      const inputBounds = await input.boundingBox();
      assert.ok(draftBounds.x > inputBounds.x + inputBounds.width, "editors are side by side");
      await log.evaluate(el=>{ el.scrollTop=120; });
      await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
      await page.getByRole("tab", { name: "工作稿", exact: true }).click();
      await page.getByRole("tab", { name: "讨论", exact: true }).click();
      assert.ok(Math.abs(await log.evaluate(el=>el.scrollTop)-120) < 2, "tabs preserve the reading position");
      await page.getByRole("button", { name: "更早的讨论", exact: true }).click();
      await page.getByText("第-20轮提问：这一章如何安排悬念，让主角的选择有充分动机？", { exact: true }).waitFor();
      assert.ok(await log.evaluate(el=>el.scrollTop) > 120, "prepending history preserves the viewport");
      await page.getByRole("button", { name: "回到最新", exact: true }).click();
      assert.ok(await log.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight) < 5);
      await split.click();
      await split.click();
      assert.equal(await input.inputValue(), "保留当前未发送的问题");
      await page.getByRole("tab", { name: "工作稿", exact: true }).click();
      assert.equal(await manuscript.inputValue(), "工作稿编辑保留，不能因布局切换丢失。");
      await capture("coauthor-draft");
      await split.click();
      await input.waitFor();
      await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem("coauthor-layout-draft")??"null")?.content==="工作稿编辑保留，不能因布局切换丢失。");
      await page.reload();
      await input.waitFor();
      await manuscript.waitFor({ state: "visible" });
      assert.equal(await split.getAttribute("aria-pressed"), "true");
      assert.equal(await input.inputValue(), "保留当前未发送的问题");
      assert.equal(await manuscript.inputValue(), "工作稿编辑保留，不能因布局切换丢失。");
      await page.getByRole("button", { name: "依据与运行记录", exact: true }).click();
      await page.getByRole("dialog", { name: "依据与运行记录", exact: true }).waitFor();
      await page.getByRole("button", { name: "关闭依据与运行记录", exact: true }).click();
      await page.setViewportSize({ width: viewport.width, height: 720 });
      await assertFits();
      await page.evaluate(() => { document.documentElement.dataset.theme="dark"; });
      await capture("coauthor-split-short-dark");
      await page.setViewportSize({ width: 1100, height: 720 });
      await split.waitFor({ state: "detached" });
      await input.waitFor();
      assert.equal(await manuscript.isVisible(), false);
      assert.equal(await input.inputValue(), "保留当前未发送的问题");
      await page.setViewportSize(viewport);
      await split.waitFor();
      await manuscript.waitFor({ state: "visible" });
      assert.equal(await manuscript.inputValue(), "工作稿编辑保留，不能因布局切换丢失。");
      assert.equal(await page.evaluate(()=>window.__contentCalls.some(name=>["run_coauthor","publish_coauthor_document"].includes(name))), false);
      reports.push({ viewport, workflow: "coauthor" });
      await context.close();
      continue;
    }

    if (values["navigation-only"]) {
      await visit("/planning?mode=prepare");
      await page.getByRole("heading", { name: "本书偏好", exact: true }).waitFor();
      await selectedWorkspace("筹备");
      await page.getByRole("link", { name: "编辑偏好", exact: true }).click();
      await page.getByRole("combobox", { name: "目标字数", exact: true }).waitFor();
      await selectedWorkspace("共创");
      await selectedCategory("筹备");
      await page.getByRole("heading", { name: "共创", exact: true }).waitFor();
      const preparationUrl = page.url();
      await page.getByRole("combobox", { name: "目标字数", exact: true }).selectOption("20");
      await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "筹备", exact: true }).click();
      await page.getByRole("link", { name: "本书偏好", exact: true }).click();
      assert.equal(page.url(), preparationUrl);
      assert.equal(await page.getByRole("alertdialog").count(), 0);
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "20");
      await capture("navigation-preparation");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("navigation-preparation-dark");
      await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "大纲", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(page.url(), preparationUrl);
      await selectedWorkspace("共创");
      await selectedCategory("筹备");
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "20");
      await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "大纲", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改并离开", exact: true }).click();
      await page.getByRole("link", { name: "返回大纲", exact: true }).waitFor();
      await selectedWorkspace("共创");
      await selectedCategory("大纲");
      await page.getByRole("link", { name: "返回大纲", exact: true }).click();
      await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
      await selectedWorkspace("大纲");
      assert.equal(await page.getByRole("navigation", { name: "AI 内容分类" }).count(), 0);
      await page.goBack();
      await page.getByRole("link", { name: "返回大纲", exact: true }).waitFor();
      await selectedWorkspace("共创");
      await selectedCategory("大纲");
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      for (const [path, category] of [
        ["/discussion?work=preparation&targetProject=p1&item=protagonist", "筹备"],
        ["/discussion?work=section&targetProject=p1&item=engine-theme", "筹备"],
        ["/discussion?work=planning&targetProject=p1&planNode=outline", "大纲"],
        ["/discussion?work=writing&targetProject=p1&planNode=chapter&tab=plan", "大纲"],
        ["/discussion?work=writing&targetProject=p1&planNode=chapter", "正文"],
        ["/discussion?work=entity&targetProject=p1&entity=person", "设定"],
        ["/discussion?work=materials&targetProject=p1&summary=memory&materialKind=SUMMARY", "辅助参考"],
        ["/discussion?work=records&targetProject=p1&tab=relations&objectId=relation1", "剧情记录"],
        ["/discussion?work=review&targetProject=p1", "待办核对"],
        ["/discussion?targetProject=p1&targetSession=s1", "自由讨论"],
      ]) {
        await visit(path);
        await selectedWorkspace("共创");
        await selectedCategory(category);
        const currentUrl = page.url();
        await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: category, exact: true }).click();
        assert.equal(page.url(), currentUrl, `active ${category} category reset its exact target`);
        if (path.includes("item=protagonist")) {
          await page.getByRole("heading", { name: "主角", exact: true }).waitFor();
          await page.getByRole("link", { name: "故事准备", exact: true }).click();
          assert.equal(page.url(), currentUrl);
          await capture("navigation-story");
        }
        if (path.includes("item=engine-theme")) {
          await page.getByRole("link", { name: "补充笔记", exact: true }).click();
          assert.equal(page.url(), currentUrl);
          await capture("navigation-notes");
        }
      }
      await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "筹备", exact: true }).click();
      await page.getByRole("combobox", { name: "目标字数", exact: true }).waitFor();
      await selectedCategory("筹备");
      await selectedWorkspace("共创");
      await page.goBack();
      await selectedCategory("自由讨论");
      await selectedWorkspace("共创");
      assert.equal(new URL(page.url()).searchParams.get("targetSession"), "s1");
      assert.equal(await page.evaluate(() => window.__contentCalls.some(name => /^(save_|create_|adopt_|enqueue_|run_)/.test(name))), false,
        "navigation smoke must not write data or invoke a model");
      reports.push({ viewport, passed: true, scope: "navigation" });
      await context.close();
      continue;
    }

    if (values["preparation-only"]) {
      await visit("/planning?mode=prepare");
      await page.getByRole("heading", { name: "本书偏好", exact: true }).waitFor();
      assert.equal(await page.getByRole("navigation", { name: "规划工作区" }).count(), 0);
      await capture("preparation-preferences");
      assert.match(await page.locator("#primary-navigation a").first().innerText(), /筹备/);
      assert.equal(await page.locator("#primary-navigation a").first().getAttribute("aria-current"), "page");
      assert.equal(await page.getByRole("combobox").count(), 0);
      await page.getByRole("link", { name: "编辑偏好", exact: true }).click();
      await page.getByRole("combobox", { name: "目标字数", exact: true }).waitFor();
      assert.match(await page.locator(".ai-category-nav a").first().innerText(), /自由讨论/);
      await selectedWorkspace("共创");
      await selectedCategory("筹备");
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "");
      assert.equal(await page.getByRole("combobox", { name: "节奏偏好", exact: true }).isVisible(), false);
      assert.equal(await page.getByRole("combobox", { name: "题材类型", exact: true }).count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "核心故事", exact: true }).count(), 0);
      await capture("preparation-choice-first");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("preparation-choice-first-dark");
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.getByRole("combobox", { name: "目标字数", exact: true }).selectOption("20");
      await page.getByRole("combobox", { name: "叙事视角", exact: true }).selectOption("第三人称 · 限定视角");
      await page.getByRole("combobox", { name: "语言风格", exact: true }).selectOption("简洁直白");
      await page.getByRole("combobox", { name: "整体基调", exact: true }).selectOption("悬疑");
      await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "大纲", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "20");
      await page.getByRole("link", { name: "补充笔记", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "20");
      await page.locator(".book-brief-supplement > summary").filter({ hasText: "节奏、读者与边界" }).click();
      await page.getByRole("checkbox", { name: "不靠误会拖剧情", exact: true }).check();
      await page.getByRole("checkbox", { name: "不写过度血腥", exact: true }).check();
      await capture("preparation-supplement");
      await page.locator(".book-brief-supplement > summary").filter({ hasText: "节奏、读者与边界" }).click();
      await page.getByRole("button", { name: "保存偏好", exact: true }).click();
      await page.getByText("偏好已保存", { exact: true }).waitFor();
      await page.reload();
      await page.getByRole("combobox", { name: "目标字数", exact: true }).waitFor();
      assert.equal(await page.getByRole("combobox", { name: "整体基调", exact: true }).inputValue(), "悬疑");
      assert.equal(await page.getByRole("combobox", { name: "目标字数", exact: true }).inputValue(), "20");
      assert.equal(await page.locator('textarea[aria-label="补充记录"]').inputValue(), "约二十万字，第三人称，节奏克制。");
      await capture("preparation-saved");
      await page.getByRole("combobox", { name: "叙事视角", exact: true }).selectOption("第一人称 · 固定主角");
      await page.getByRole("button", { name: "保存偏好", exact: true }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /已有正文和大纲保留/);
      await capture("preparation-direction-confirmation");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await page.getByRole("combobox", { name: "叙事视角", exact: true }).inputValue(), "第一人称 · 固定主角");
      await page.getByRole("button", { name: "保存偏好", exact: true }).click();
      await dialog.getByRole("button", { name: "保存新偏好", exact: true }).click();
      await page.getByText("偏好已保存", { exact: true }).waitFor();
      await visit("/planning?mode=prepare");
      await page.getByText("第一人称 · 固定主角", { exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox").count(), 0);
      await page.getByRole("link", { name: "故事准备", exact: true }).click();
      await page.getByRole("heading", { name: "故事核心", exact: true }).waitFor();
      await capture("preparation-story");
      await page.getByRole("link", { name: "补充笔记", exact: true }).click();
      await page.getByRole("heading", { name: "核心卖点与独特钩子", exact: true }).waitFor();
      const notes = page.getByRole("navigation", { name: "筹备内容" });
      for (const label of ["题材", "主角", "行动动机", "故事规则", "失败代价", "结局方向"]) {
        assert.equal(await notes.getByRole("link", { name: label, exact: true }).count(), 0);
      }
      await capture("preparation-notes");
      await visit("/planning?mode=structure");
      await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
      assert.equal(await page.getByRole("navigation", { name: "规划工作区" }).count(), 0);
      await capture("preparation-outline");
      assert.equal(await page.evaluate(() => window.__contentCalls.some(name => /^(create_|adopt_|enqueue_)/.test(name))), false,
        "preparation smoke must not create story nodes, rewrite manuscripts, or invoke a provider");
      reports.push({ viewport, passed: true, scope: "preparation" });
      await context.close();
      continue;
    }

    if (values["writing-directory-only"]) {
      await visit("/planning");
      await page.evaluate(() => {
        sessionStorage.setItem("content-workspace-structure", "empty");
        sessionStorage.setItem("content-workspace-empty-manuscript", "1");
        localStorage.setItem("ainoveltools:last-writing-chapter:p1", "chapter");
      });
      for (const [name, path] of [
        ["writing-unplanned", "/writing?targetProject=p1"],
        ["writing-ai-unplanned", "/discussion?work=writing&targetProject=p1"],
      ]) {
        await visit(path);
        await page.getByRole("heading", { name: "尚未规划分卷与章节", exact: true }).waitFor();
        const directory = page.locator(".workspace-directory");
        assert.equal(await directory.getByRole("button", { name: "第一卷", exact: true }).count(), 0);
        assert.equal(await directory.getByRole("button", { name: "第一章 入城", exact: true }).count(), 0);
        assert.equal(await directory.getByRole("textbox", { name: "搜索章节", exact: true }).count(), 0);
        assert.equal(await page.getByText("导出正文", { exact: true }).count(), 0);
        assert.equal(await page.getByRole("region", { name: "章节正文阅读", exact: true }).count(), 0);
        assert.equal(await page.getByRole("link", { name: "规划分卷与章节", exact: true }).getAttribute("href"),
          "/discussion?work=planning&targetProject=p1&planNode=manager");
        assert.ok(await page.getByRole("link", { name: "规划分卷与章节", exact: true }).evaluate(element => {
          const icon = element.querySelector("svg").getBoundingClientRect();
          const range = document.createRange();
          range.selectNode(element.lastChild);
          return range.getBoundingClientRect().left - icon.right >= 7;
        }), "empty-state action icon must not overlap its label");
        const workspace = page.getByRole("main", { name: "正文工作区", exact: true });
        assert.equal(await workspace.evaluate(element => element.scrollHeight > element.clientHeight), false,
          "empty writing workspace must fit the desktop pane");
        await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
        await capture(name);
        await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        await capture(`${name}-dark`);
      }
      await page.evaluate(() => {
        sessionStorage.setItem("content-workspace-structure", "planned");
        document.documentElement.dataset.theme = "light";
      });
      await visit("/writing?targetProject=p1");
      await page.getByRole("region", { name: "章节正文阅读", exact: true }).waitFor();
      await page.locator(".workspace-directory").getByRole("button", { name: "第一章 入城", exact: true }).waitFor();
      await capture("writing-planned-directory");
      await page.evaluate(() => {
        sessionStorage.setItem("content-workspace-structure", "empty");
        sessionStorage.removeItem("content-workspace-empty-manuscript");
      });
      await visit("/writing?targetProject=p1");
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      await page.locator(".workspace-directory").getByRole("button", { name: "第一章 入城", exact: true }).waitFor();
      await capture("writing-legacy-manuscript");
      await page.evaluate(() => {
        sessionStorage.setItem("content-workspace-empty-manuscript", "1");
        sessionStorage.setItem("content-workspace-recovery-draft", "1");
      });
      await visit("/writing?targetProject=p1");
      await page.getByRole("region", { name: "章节正文阅读", exact: true }).waitFor();
      await page.locator(".workspace-directory").getByRole("button", { name: "第一章 入城", exact: true }).waitFor();
      await page.getByRole("link", { name: "去共创处理本章正文", exact: true }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "尚未规划分卷与章节", exact: true }).count(), 0);
      await capture("writing-legacy-draft");
      assert.equal(await page.evaluate(() => window.__contentCalls.some(name =>
        /^(create_|save_|update_|adopt_|enqueue_)/.test(name))), false, "writing directory smoke must not write author data or invoke a provider");
      reports.push({ viewport, passed: true, scope: "writing-directory" });
      await context.close();
      continue;
    }

    if (values["structure-only"]) {
      await visit("/planning");
      await page.evaluate(() => sessionStorage.setItem("content-workspace-structure", "empty"));
      await visit("/discussion?work=planning&planNode=manager&targetProject=p1");
      await page.getByRole("heading", { name: "分卷与章节", exact: true }).waitFor();
      const directory = page.locator(".workspace-directory");
      const generate = page.getByRole("button", { name: "生成分卷方案", exact: true });
      await generate.waitFor({ state: "visible" });
      assert.equal(await directory.getByRole("button", { name: "第一卷", exact: true }).count(), 0);
      assert.equal(await directory.getByRole("button", { name: "第一章 入城", exact: true }).count(), 0);
      assert.equal(await directory.getByRole("textbox", { name: "搜索章节", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "本卷章节", exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel("拆章节目标分卷", { exact: true }).count(), 0);
      assert.equal(await page.getByText("1 卷 · 1 章", { exact: true }).count(), 0);
      assert.equal(await page.locator(".structure-focus-inspector").evaluate(element => element.scrollHeight > element.clientHeight), false,
        "unplanned structure form should fit the desktop pane");
      await page.getByRole("link", { name: "前往确认", exact: true }).waitFor();
      const action = await generate.boundingBox();
      assert.ok(action && action.y + action.height < viewport.height - 20, "generation action should remain in the first viewport");
      await capture("structure-before-planning");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("structure-before-planning-dark");
      await page.getByText("规划依据", { exact: true }).click();
      await page.getByRole("link", { name: "前往筹备修改偏好", exact: true }).waitFor({ state: "visible" });
      await page.getByText("规划依据", { exact: true }).click();
      await page.getByText("手动添加", { exact: true }).click();
      await page.getByRole("button", { name: "新建章节", exact: true }).waitFor({ state: "visible" });
      await page.getByText("手动添加", { exact: true }).click();

      for (const state of ["candidate", "planned", "review"]) {
        await page.evaluate(value => {
          sessionStorage.setItem("content-workspace-structure", value);
          document.documentElement.dataset.theme = "light";
        }, state);
        await visit("/discussion?work=planning&planNode=manager&targetProject=p1");
        if (state === "candidate") {
          await page.getByLabel("分卷候选", { exact: true }).waitFor({ state: "attached" });
          assert.equal(await directory.getByRole("button", { name: "第一卷", exact: true }).count(), 0);
          assert.equal(await page.getByRole("button", { name: "本卷章节", exact: true }).isDisabled(), true);
        } else {
          await page.getByLabel("拆章节目标分卷", { exact: true }).waitFor();
          await directory.getByRole("button", { name: "第一卷", exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: "本卷章节", exact: true }).getAttribute("aria-pressed"), "true");
          assert.equal(await page.getByLabel("章节拆分候选", { exact: true }).inputValue(), "第2章·问路｜追查寄件人\n第3章·夜访｜发现未来来信");
          if (state === "review") {
            await page.getByRole("link", { name: "审定本卷规划", exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: "拆分本卷章节", exact: true }).isDisabled(), true);
          }
        }
        await capture(`structure-${state}`);
        await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        await capture(`structure-${state}-dark`);
      }
      assert.equal(await page.evaluate(() => window.__contentCalls.some(name =>
        /^(create_|save_|update_|adopt_|enqueue_)/.test(name))), false, "structure smoke must not write author data or invoke a provider");
      reports.push({ viewport, passed: true, scope: "structure" });
      await context.close();
      continue;
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
      await page.getByRole("link", { name: "去共创处理本章正文", exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "去共创处理本章正文", exact: true }).count(), 1);
      assert.equal(await page.locator(".chapter-focus-inspector").evaluate(element =>
        element.scrollHeight > element.clientHeight), false, "empty reader must not create an inner scrollbar");
      const empty = await page.locator(".chapter-reading-empty").boundingBox();
      const entry = await page.getByRole("link", { name: "去共创处理本章正文", exact: true }).boundingBox();
      assert.ok(empty && entry && Math.abs(entry.x + entry.width / 2 - empty.x - empty.width / 2) <= 2,
        "empty-state writing entry must be centered in the reading pane");
      await capture("manuscript-reading-empty");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await capture("manuscript-reading-empty-dark");
      await page.evaluate(() => sessionStorage.removeItem("content-workspace-empty-manuscript"));
      await visit("/writing?planNode=chapter&targetProject=p1");
      await page.getByText("正式正文：沈砚在城门前停下脚步。", { exact: true }).waitFor();
      await page.getByRole("link", { name: "去共创处理本章正文", exact: true }).click();
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
    assert.equal(await page.getByRole("navigation", { name: "筹备内容" }).count(), 0);
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
    assert.equal(await page.getByRole("region", { name: "全书筹备", exact: true }).count(), 0);
    await noButtons(/导出正文/);
    await page.getByRole("link", { name: "前往筹备修改偏好", exact: true }).click();
    const preference = page.getByRole("combobox", { name: "语言风格", exact: true });
    await preference.waitFor();
    assert.equal(await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "筹备", exact: true }).getAttribute("aria-current"), "page");
    await capture("preparation-preferences");
    await preference.selectOption("细腻写实");
    await page.getByRole("navigation", { name: "AI 内容分类" }).getByRole("link", { name: "大纲", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(await preference.inputValue(), "细腻写实");
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
    await page.getByRole("link", { name: "去共创处理主线大纲", exact: true }).waitFor();
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
      await reader.getByRole("link", { name: `去共创处理${title}`, exact: true }).click();
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
    await page.getByRole("link", { name: "去共创处理人物设定" }).click();
    await page.getByRole("heading", { name: "共创", exact: true }).waitFor();
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
    await page.getByRole("heading", { name: "共创", exact: true }).waitFor();
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
    await page.getByRole("link", { name: "去共创处理此参考", exact: true }).click();
    await page.getByRole("heading", { name: "共创", exact: true }).waitFor();
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
    await page.getByRole("link", { name: "去共创处理此关系记录", exact: true }).click();
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
