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
          status:"CHOSEN",sourceMessageId:"m1",version:2}],runs:[]};
        const messages=[
          {id:"m1",sessionId:"s1",role:"USER",content:"我想在金丹后面增加一个新境界，突破的代价改为失去记忆。"},
          {id:"m2",sessionId:"s1",role:"ASSISTANT",content:"《修炼体系》里已有炼气、筑基、金丹三个阶段，原本的突破代价是寿元。\\n\\n可以沿着已有体系扩展，在金丹后加一层“照魂境”。你已选择失忆代价，我会把它作为当前分支的方向，原设定暂不替换。"},
          {id:"m-old",sessionId:"s1",role:"ASSISTANT",content:"早期试写仍使用寿元代价，保留作为历史对照。",contextVersion:"coauthor:historical-run-00"},
          {id:"m3",sessionId:"s1",role:"USER",content:"先拿主角突破写一段。他忘了母亲的声音，压抑一点。"}
        ];
        const fact={key:"FACT:one",kind:"FACT",title:"陆沉 · 掌握 · 魂灯",revision:"fact1",
          content:"已审核事实记录，不是正文原句。",offset:0,totalChars:17,sessionId:null,
          knowledgeContext:{projectId:"p1",version:1,status:"CURRENT",facts:[],hasMoreAnchors:false,
            anchors:[{id:"anchor1",chapterId:"chapter1",revisionId:"original1",blockId:"p1",status:"CURRENT_REVISION"}]}};
        const relation={...fact,key:"RELATION:one",kind:"RELATION",title:"守护",revision:"relation1",
          content:"关系记录：守护。",totalChars:8,knowledgeContext:{...fact.knowledgeContext,facts:[
            {key:fact.key,revision:fact.revision,title:fact.title},
            {key:"FACT:two",revision:"fact2",title:"苏瑶 · 守在 · 门外"}]}};
        const secondFact={...fact,key:"FACT:two",title:"苏瑶 · 守在 · 门外",revision:"fact2",
          content:"已审核事实记录：苏瑶守在门外。"};
        state.runs=Array.from({length:25},(_,index)=>({
          id:"historical-run-"+String(24-index).padStart(2,"0"),sessionId:"s1",userMessageId:"old-message-"+index,
          status:"COMPLETED",documentVersion:1,output:"历史试写 "+index,
          audit:index===24?[{kind:"initial_search",result:{hits:[fact],hasMore:false,pendingIndexUpdates:0,coverage:"仅关键词命中"}},
            {kind:"draft_proposal",baseDocument:structuredClone(doc),
            document:{...doc,content:"旧建议：突破消耗寿元。"}}]:[]
        }));
        function lightState(){
          return {...structuredClone(state),runs:state.runs.slice(0,20).map(({audit,output,...summary})=>summary)};
        }
        let changes=null;
        let reversal=null;
        let impacts=[];
        let sourceChecks=[{id:"check1",title:"突破代价 · 全部旧章",query:"失忆代价是否影响旧章",
          kinds:["MANUSCRIPT"],total:3,read:2,sent:1,reviewed:1,relevant:1,uncertain:0,
          stale:1,added:1,pendingIndexUpdates:0,complete:false}];
        const checkEntries=[
          {key:"MANUSCRIPT:rain",revision:"rain1",title:"第九章 · 雨夜",totalChars:8000,readChars:8000,
            sentChars:8000,sentComplete:true,nextOffset:8000,stale:false,assessment:"RELEVANT",
            reason:"本章的记忆描写可能依赖旧代价，需核对突破前后的叙事位置。",quote:"他仍记得母亲唤他的声音。",lastError:null},
          {key:"MANUSCRIPT:door",revision:"door1",title:"第十章 · 门后",totalChars:6000,readChars:2000,
            sentChars:0,sentComplete:false,nextOffset:0,stale:false,assessment:null,reason:"",quote:"",lastError:null},
          {key:"MANUSCRIPT:old",revision:"old1",title:"第十一章 · 魂灯",totalChars:5000,readChars:5000,
            sentChars:5000,sentComplete:true,nextOffset:5000,stale:true,assessment:"IRRELEVANT",
            reason:"原判断基于旧稿，作者随后改写了突破经过。",quote:"",lastError:"原依据已变化，请重新建立范围清单。"}
        ];
        function richManuscript(cost){
          return JSON.stringify({type:"doc",content:[
            {type:"heading",attrs:{blockId:"h",level:2},content:[{type:"text",text:"入城前夜"}]},
            {type:"blockquote",attrs:{blockId:"q"},content:[
              {type:"paragraph",attrs:{blockId:"p"},content:cost==="寿元"?[
                {type:"text",text:"甲😀失去寿元",marks:[{type:"bold"}]},
                {type:"text",text:"，母亲的声音仍在雨里。",marks:[{type:"italic"}]}
              ]:[
                {type:"text",text:"甲😀失去",marks:[{type:"bold"}]},
                {type:"text",text:"记忆",marks:[{type:"bold"}]},
                {type:"text",text:"，旧日",marks:[{type:"italic"}]},
                {type:"text",text:"的声音仍在雨里。",marks:[{type:"italic"}]}
              ]}
            ]},
            {type:"paragraph",attrs:{blockId:"end"},content:[{type:"text",text:"他把魂灯放回窗边。窗外的雨没有停。"}]}
          ]});
        }
        function preparedChanges(){
          return {id:"change1",version:1,title:"采用突破正文并更新修炼体系",status:"PENDING",
            baseDocument:structuredClone(state.document),runId:null,coverage:"已核对修炼体系与旧章片段；其余正文和伏笔尚未检查。",
            selectedIds:[],published:[],undo:[],reversedBy:null,readDependencies:[],
            items:[{id:"draft",document:structuredClone(state.document),before:null,dependsOn:["realm"]},
              {id:"realm",document:{...state.document,kind:"SETTING",title:"修炼体系",content:"炼气、筑基、金丹、照魂。突破照魂境需要失去一段记忆。",
                targetKey:"ENTITY:realm",targetRevision:"r1"},
                before:{key:"ENTITY:realm",kind:"ENTITY",title:"修炼体系",revision:"r1",content:"炼气、筑基、金丹。突破消耗寿元。",
                  totalChars:20,offset:0,sessionId:null},dependsOn:[]},
              {id:"opening",document:{...state.document,title:"第一章 · 入城前夜",content:"甲😀失去记忆，旧日的声音仍在雨里。",
                targetKey:"MANUSCRIPT:opening",targetRevision:"opening1"},
                before:{key:"MANUSCRIPT:opening",kind:"MANUSCRIPT",title:"第一章 · 入城前夜",revision:"opening1",
                  content:"甲😀失去寿元，母亲的声音仍在雨里。",totalChars:20,offset:0,sessionId:null},dependsOn:["realm"],
                manuscriptEdits:[{blockId:"p",start:4,end:9,before:"寿元，母亲",after:"记忆，旧日",
                  afterRuns:[{text:"记忆",marksFrom:4},{text:"，旧日",marksFrom:6}]}],manuscriptDraftVersion:0,
                manuscriptBeforeJson:richManuscript("寿元"),manuscriptAfterJson:richManuscript("记忆")},
              {id:"outline",document:{...state.document,kind:"OUTLINE",title:"突破大纲",content:"甲😀突破消耗记忆。结尾保留。",
                targetKey:"PLAN:plan-node:outline",targetRevision:"outline1"},
                before:{key:"PLAN:plan-node:outline",kind:"PLAN",title:"突破大纲",revision:"outline1",
                  content:"甲😀突破消耗寿元。结尾保留。",totalChars:15,offset:0,sessionId:null},dependsOn:["realm"],
                outlineEdits:[{start:6,end:8,before:"寿元",after:"记忆"}],outlineFingerprint:"outline-fingerprint",
                outlineBefore:{id:"plan-node:outline",version:1,content:"甲😀突破消耗寿元。结尾保留。",
                  pendingContent:"未采用候选：保留寿元代价",storyState:"CONFIRMED",rationale:"保留作者备注",
                  consequence:"复查后续情节",references:["原始引用"],updatedAt:"now"}}],
            impacts:[{itemIds:["realm"],key:"MANUSCRIPT:old",revision:"old1",
              quote:"他仍记得母亲唤他的声音。",reason:"旧章描写可能依赖原有突破代价，需要核对叙事位置。"}]};
        }
        const listeners=new Set();
        export async function listen(event,handler){listeners.add(handler);return()=>listeners.delete(handler);}
        export async function waitForPendingCommands(){}
        export async function invoke(command,args={}){
          window.__coauthorCalls??=[];window.__coauthorCalls.push(command);
          if(command==="current_project")return {projectId:"p1",name:"照夜行",root:"fixture",formatVersion:1};
          if(command==="health_query")return {schemaVersion:58};
          if(command==="bootstrap_status")return {};
          if(command==="list_author_todos")return {pendingCount:0,items:[]};
          if(command==="list_discussion_sessions")return [{id:"s1",projectId:"p1",title:"照魂境 · 失忆版本",scopeKind:"PROJECT"}];
          if(command==="get_coauthor_state")return lightState();
          if(command==="list_coauthor_runs"){
            const start=args.beforeRunId?state.runs.findIndex(run=>run.id===args.beforeRunId)+1:0;
            if(args.beforeRunId&&start===0)throw new Error("Unknown run cursor");
            return {runs:state.runs.slice(start,start+20).map(({audit,output,...summary})=>structuredClone(summary)),
              hasMore:start+20<state.runs.length};
          }
          if(command==="get_coauthor_run"){
            const run=state.runs.find(run=>run.id===args.id);
            if(!run)throw new Error("Unknown historical run");
            return structuredClone(run);
          }
          if(command==="list_coauthor_related_knowledge"){
            assertSource(args,fact);
            return {hits:[structuredClone(relation)],hasMore:false,pendingIndexUpdates:0,coverage:"仅直接关系"};
          }
          if(command==="read_coauthor_knowledge_evidence"){
            assertSource(args,fact);
            if(args.anchorId!=="anchor1")throw new Error("Unknown evidence anchor");
            return {knowledgeKey:fact.key,knowledgeRevision:fact.revision,anchorId:"anchor1",chapterId:"chapter1",
              revisionId:"original1",blockId:"p1",start:0,end:8,content:"陆沉😀掌握魂灯。",
              offset:0,nextOffset:8,totalChars:8,isCurrentRevision:true};
          }
          if(command==="read_coauthor_source"){
            const source=[fact,relation,secondFact].find(source=>source.key===args.key);
            if(!source)throw new Error("Unknown knowledge source");
            assertSource(args,source);
            return structuredClone(source);
          }
          if(command==="list_coauthor_decision_history")return {
            current:{decision:structuredClone(state.decisions[0]),aliases:["突破代价","境界代偿"],quote:"代价改为失去记忆"},
            revisions:[{decision:structuredClone(state.decisions[0]),quote:"代价改为失去记忆"},
              {decision:{...state.decisions[0],version:1,content:"突破消耗寿元。",sourceMessageId:"earlier-message"},
                quote:null}],hasMore:false};
          if(command==="list_coauthor_source_checks")return {checks:structuredClone(sourceChecks),hasMore:false};
          if(command==="get_coauthor_source_check")return {check:structuredClone(sourceChecks.find(item=>item.id===args.id)),
            entries:structuredClone(checkEntries),offset:0,hasMore:false};
          if(command==="get_coauthor_check_notes")return {checkId:args.id,key:args.key,
            revision:args.key==="MANUSCRIPT:old"?"old1":"rain1",stale:args.key==="MANUSCRIPT:old",
            totalNotes:6,notedChars:6000,offset:args.offset,hasMore:args.offset===0,
            notes:Array.from({length:args.offset===0?5:1},(_,index)=>({
              id:"note-"+args.key+"-"+args.offset+"-"+index,runId:"earlier-run",start:(args.offset+index)*1000,
              end:(args.offset+index+1)*1000,version:2,analysis:args.offset===0?
                "这段只确认主角仍记得声音，是否矛盾取决于叙事时间。":"后段仍未明确突破前后的时间。",
              questions:"需核对与突破之夜的先后关系，不能只凭已读游标下结论。",
              quote:"他仍记得母亲唤他的声音。"}))};
          if(command==="create_coauthor_source_check"){
            const check={...sourceChecks[0],id:"check2",...args.input};
            sourceChecks.unshift(check);
            return {check:structuredClone(check),entries:structuredClone(checkEntries),offset:0,hasMore:false};
          }
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
            return {state:lightState(),runId:input.runId,run:structuredClone(run)};
          }
          if(command==="cancel_coauthor_run")return;
          if(command==="list_coauthor_document_history")return [doc];
          if(command==="get_coauthor_changes"){
            changes??=preparedChanges();
            return {changeSets:[{id:changes.id,version:changes.version,title:changes.title,status:changes.status,itemCount:changes.items.length,reversedBy:changes.reversedBy}],
              impacts:structuredClone(impacts),hasMoreChanges:false,hasMoreImpacts:false};
          }
          if(command==="get_coauthor_changeset")return structuredClone(changes);
          if(command==="commit_coauthor_changeset"){
            if(changes.status==="COMMITTED")return structuredClone(changes);
            if(args.selectedIds.includes("draft")&&!args.selectedIds.includes("realm"))throw new Error("missing dependency");
            changes={...changes,status:"COMMITTED",version:2,selectedIds:args.selectedIds,
              published:args.selectedIds.map(id=>({itemId:id,sourceKey:id==="draft"?"MANUSCRIPT:new":id==="opening"?"MANUSCRIPT:opening":id==="outline"?"PLAN:plan-node:outline":"ENTITY:realm",revision:"v2"}))};
            if(args.selectedIds.includes("draft"))state.document={...state.document,version:state.document.version+1,
              targetKey:"MANUSCRIPT:new",targetRevision:"v2"};
            impacts=[{id:"impact1",changeSetId:changes.id,version:1,title:"第九章 · 雨夜",evidence:changes.impacts[0],
              status:"PENDING",resolution:"",sourceChanged:false,originReversed:false}];
            return structuredClone(changes);
          }
          if(command==="get_coauthor_reversal")return structuredClone(reversal);
          if(command==="prepare_coauthor_reversal"){
            reversal={id:"reversal1",changeSetId:changes.id,version:(reversal?.version??0)+1,status:"PENDING",
              baseDocument:structuredClone(state.document),blockers:[],impactCount:impacts.length,linkedDraft:true,
              items:changes.published.map(published=>{
                const item=changes.items.find(item=>item.id===published.itemId);
                return {itemId:item.id,title:item.document.title,sourceKey:published.sourceKey,
                  action:item.before?"RESTORE":"ARCHIVE",
                  before:{key:published.sourceKey,kind:item.before?.kind??"MANUSCRIPT",title:item.document.title,
                    revision:published.revision,content:item.document.content,totalChars:item.document.content.length,offset:0,sessionId:null},
                  after:item.before??null,beforeDocumentJson:item.manuscriptAfterJson??null,
                  afterDocumentJson:item.manuscriptBeforeJson??null,resultRevision:null};
              })};
            return structuredClone(reversal);
          }
          if(command==="commit_coauthor_reversal"){
            reversal={...reversal,status:"COMMITTED",version:reversal.version+1,
              items:reversal.items.map(item=>({...item,resultRevision:item.action==="RESTORE"?"restored3":null}))};
            changes={...changes,reversedBy:reversal.id};
            impacts=impacts.map(item=>({...item,originReversed:true}));
            state.document={...changes.baseDocument,version:state.document.version+1};
            return structuredClone(reversal);
          }
          if(command==="update_coauthor_impact"){
            impacts=impacts.map(item=>item.id===args.id?{...item,version:item.version+1,status:args.status,resolution:args.resolution}:item);
            return structuredClone(impacts.find(item=>item.id===args.id));
          }
          if(command.startsWith("list_"))return [];
          throw new Error("Unimplemented browser fixture command: "+command);
        }
        function assertSource(args,source){
          if(args.scope.projectId!=="p1"||args.scope.sessionId!=="s1"||
            args.key!==source.key||args.revision!==source.revision)throw new Error("Incorrect knowledge identity");
        }`,
    }));
    await page.goto(`${values.url}/discussion`);
    await page.getByLabel("讨论输入", { exact: true }).waitFor();
    await page.getByText("照夜行", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-discussion.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `Horizontal overflow at ${viewport.width}px`);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.some((name) =>
      name === "get_coauthor_run" || name === "list_coauthor_runs")), false,
    "Opening the workspace must not load historical audits or the run directory");
    await page.getByRole("button", { name: "依据与记录", exact: true }).click();
    const sourcesPanel = page.getByRole("dialog", { name: "依据与运行记录" });
    await sourcesPanel.getByRole("button", { name: "查看改稿差异", exact: true }).waitFor();
    await sourcesPanel.getByText("已审核事实记录 · v1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.some(name =>
      name === "read_coauthor_knowledge_evidence" || name === "list_coauthor_related_knowledge")), false,
    "Knowledge metadata must not eagerly load manuscript evidence or relationships");
    await sourcesPanel.getByText("正文证据 · p1", { exact: true }).click();
    await sourcesPanel.getByText("陆沉😀掌握魂灯。", { exact: true }).waitFor({ state: "visible" });
    const evidenceUrl = new URL(await sourcesPanel.getByRole("link", { name: "定位原修订" }).getAttribute("href"), values.url);
    assert.equal(evidenceUrl.searchParams.get("sourceEvidence"), "anchor1");
    assert.equal(evidenceUrl.searchParams.get("sourceRevision"), "original1");
    assert.equal(evidenceUrl.searchParams.get("sourceBlock"), "p1");
    await sourcesPanel.getByText("直接关联关系", { exact: true }).click();
    await sourcesPanel.getByRole("button", { name: "查看关系记录", exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-knowledge.png`), fullPage: true });
    await sourcesPanel.getByRole("button", { name: "查看关系记录", exact: true }).click();
    await sourcesPanel.getByText("关系记录 · v1", { exact: true }).waitFor();
    await sourcesPanel.getByRole("button", { name: "终点事实 · 苏瑶 · 守在 · 门外", exact: true }).click();
    await sourcesPanel.getByRole("heading", { name: "苏瑶 · 守在 · 门外", exact: true }).waitFor();
    assert.equal(await sourcesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await sourcesPanel.getByText("保留的回复", { exact: true }).click();
    await sourcesPanel.getByText("历史试写 24", { exact: true }).waitFor({ state: "visible" });
    await sourcesPanel.getByRole("button", { name: "更早运行", exact: true }).click();
    await sourcesPanel.getByText("第 2 页", { exact: true }).waitFor();
    await sourcesPanel.getByLabel("查看运行", { exact: true }).selectOption("historical-run-01");
    await sourcesPanel.getByText("基础稿件", { exact: false }).waitFor();
    await sourcesPanel.getByLabel("查看运行", { exact: true }).selectOption("historical-run-00");
    await sourcesPanel.getByRole("button", { name: "查看改稿差异", exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-run-directory.png`), fullPage: true });
    assert.equal(await sourcesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await sourcesPanel.getByRole("button", { name: "较新运行", exact: true }).click();
    await sourcesPanel.getByText("第 1 页", { exact: true }).waitFor();
    await sourcesPanel.getByRole("button", { name: "查看改稿差异", exact: true }).click();
    const oldProposal = page.getByRole("dialog", { name: "改稿差异", exact: true });
    await oldProposal.getByLabel("AI 建议稿", { exact: true }).waitFor();
    assert.equal(await oldProposal.getByLabel("AI 建议稿", { exact: true }).inputValue(), "旧建议：突破消耗寿元。");
    assert.equal(await oldProposal.getByRole("button", { name: "采用整份工作稿修改", exact: true }).isDisabled(), true);
    assert.equal(await oldProposal.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-historical-proposal.png`), fullPage: true });
    await oldProposal.getByRole("button", { name: "关闭改稿差异", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("run_coauthor")), false,
      "Historical comparison must not start a model");
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
    await page.getByRole("button", { name: "关联变更", exact: true }).click();
    const changesPanel = page.getByRole("dialog", { name: "关联变更与影响" });
    await changesPanel.getByRole("button", { name: "核对差异" }).click();
    const setting = changesPanel.getByRole("checkbox", { name: "修炼体系 设定" });
    await setting.uncheck();
    await page.waitForTimeout(50);
    assert.equal(await changesPanel.getByRole("button", { name: "确认采用所选变更" }).isDisabled(), true);
    await setting.check();
    const beforeManuscript = changesPanel.getByLabel("局部修改前正文", { exact: true });
    const afterManuscript = changesPanel.getByLabel("局部修改后正文", { exact: true });
    await afterManuscript.waitFor();
    assert.equal(await beforeManuscript.locator("strong").innerText(), "甲😀失去寿元");
    assert.equal((await afterManuscript.locator("strong").allTextContents()).join(""), "甲😀失去记忆");
    assert.equal((await afterManuscript.locator("em").allTextContents()).join(""), "，旧日的声音仍在雨里。");
    assert.equal(await afterManuscript.getAttribute("contenteditable"), "false");
    const manuscriptRanges = changesPanel.getByRole("region", { name: "正文局部修改范围" });
    await manuscriptRanges.getByText("替换文字格式来源", { exact: true }).click();
    await manuscriptRanges.getByText("原文字符 4", { exact: true }).waitFor({ state: "visible" });
    await manuscriptRanges.getByText("原文字符 6", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await changesPanel.locator(".coauthor-format-mapping").evaluate((el) => el.scrollWidth > el.clientWidth), false);
    const outlineRanges = changesPanel.getByRole("region", { name: "大纲局部修改范围" });
    await outlineRanges.waitFor();
    assert.ok((await outlineRanges.innerText()).includes("字符 6 至 8"));
    assert.equal(await changesPanel.getByLabel("局部修改前大纲").innerText(), "甲😀突破消耗寿元。结尾保留。");
    assert.equal(await changesPanel.getByLabel("局部修改后大纲").innerText(), "甲😀突破消耗记忆。结尾保留。");
    await outlineRanges.getByText("保留的大纲记录 · v1", { exact: true }).click();
    await outlineRanges.getByText("未采用候选：保留寿元代价", { exact: true }).waitFor({ state: "visible" });
    await outlineRanges.locator("..").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-outline.png`), fullPage: true });
    await changesPanel.getByRole("region", { name: "正文局部修改范围" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-rich-manuscript.png`), fullPage: true });
    await changesPanel.locator(".coauthor-change-review").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-changes.png`), fullPage: true });
    const panelOverflow = await changesPanel.evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(panelOverflow, false, `Changes panel overflow at ${viewport.width}px`);
    await changesPanel.getByRole("button", { name: "确认采用所选变更" }).click();
    const confirmation = page.getByRole("alertdialog", { name: "正式采用关联变更" });
    await confirmation.waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-confirmation.png`), fullPage: true });
    await confirmation.getByRole("button", { name: "采用所选变更", exact: true }).click();
    await changesPanel.getByText("已正式采用 4 项；其他内容未同步。", { exact: true }).waitFor();
    await changesPanel.getByRole("button", { name: "处理待办" }).click();
    await changesPanel.getByLabel("待办状态").selectOption("ACCEPTED_DIFFERENCE");
    await changesPanel.getByLabel("待办处理依据").fill("保留为突破之前的回忆，不修改旧章。");
    await changesPanel.getByRole("button", { name: "保存处理", exact: true }).click();
    await changesPanel.getByText("处理依据：保留为突破之前的回忆，不修改旧章。", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-impacts.png`), fullPage: true });
    await changesPanel.getByRole("button", { name: "核对整组撤销" }).click();
    const reversalPanel = changesPanel.getByRole("region", { name: "关联撤销" });
    await reversalPanel.getByRole("button", { name: "确认撤销本次全部采用" }).waitFor();
    assert.equal((await reversalPanel.getByLabel("撤销前正文").locator("strong").allTextContents()).join(""), "甲😀失去记忆");
    assert.equal((await reversalPanel.getByLabel("撤销前正文").locator("em").allTextContents()).join(""), "，旧日的声音仍在雨里。");
    assert.equal(await reversalPanel.getByLabel("撤销后正文").locator("strong").innerText(), "甲😀失去寿元");
    assert.equal(await reversalPanel.getByLabel("撤销后正文").locator("em").innerText(), "，母亲的声音仍在雨里。");
    await reversalPanel.getByLabel("撤销后正文").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-reversal-preview.png`), fullPage: true });
    assert.equal(await changesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await reversalPanel.getByRole("button", { name: "确认撤销本次全部采用" }).click();
    const reversalConfirmation = page.getByRole("alertdialog", { name: "撤销已采用的关联变更" });
    await reversalConfirmation.waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-reversal-confirmation.png`), fullPage: true });
    await reversalConfirmation.getByRole("button", { name: "确认整组撤销", exact: true }).click();
    await reversalPanel.getByText("本次采用已整组撤销，原采用回执与历史内容保留。", { exact: true }).waitFor();
    await changesPanel.getByText("引发此待办的采用已撤销，请复查处理依据；原处理记录保留。", { exact: true }).waitFor();
    await changesPanel.getByText("处理依据：保留为突破之前的回忆，不修改旧章。", { exact: true }).waitFor();
    await reversalPanel.getByRole("heading", { name: "撤销采用", exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-reversal-receipt.png`), fullPage: true });
    await changesPanel.getByRole("button", { name: "关闭关联变更与影响", exact: true }).click();
    await page.getByRole("button", { name: "查证范围", exact: true }).click();
    const checksPanel = page.getByRole("dialog", { name: "查证范围与进度" });
    await checksPanel.getByText("范围查证尚未完成。", { exact: true }).waitFor();
    await checksPanel.getByText("1 项原依据失效 · 1 项新增资料 · 0 项索引待更新", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-checks.png`), fullPage: true });
    assert.equal(await checksPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await checksPanel.getByText("分段分析笔记", { exact: true }).first().click();
    await checksPanel.getByText("阶段分析，未经作者确认为正式事实。", { exact: true }).waitFor();
    await checksPanel.getByText("字符 0 至 1000 · v2", { exact: true }).waitFor();
    await checksPanel.getByText("字符 0 至 1000 · v2", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-check-notes.png`), fullPage: true });
    await checksPanel.getByRole("button", { name: "下一页笔记", exact: true }).click();
    await checksPanel.getByText("后段仍未明确突破前后的时间。", { exact: true }).waitFor();
    await checksPanel.getByText("分段分析笔记", { exact: true }).last().click();
    await checksPanel.getByText("原依据失效，以下分析仅作历史记录。", { exact: true }).waitFor();
    await checksPanel.getByText("原依据失效，以下分析仅作历史记录。", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-check-notes-stale.png`), fullPage: true });
    assert.equal(await checksPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await checksPanel.getByText("新建查证清单", { exact: true }).click();
    await checksPanel.getByLabel("清单标题").fill("核对新范围");
    await checksPanel.getByLabel("查证问题").fill("核对全部突破情节和相关设定");
    await checksPanel.getByLabel("有效设定卡").check();
    await checksPanel.getByRole("button", { name: "创建清单", exact: true }).click();
    await checksPanel.getByRole("heading", { name: "核对新范围", exact: true }).waitFor();
    await checksPanel.getByRole("button", { name: "核对范围变化", exact: true }).click();
    assert.ok((await page.getByLabel("讨论输入", { exact: true }).inputValue()).includes("继续查证清单 check2"));
    const runCount = await page.evaluate(() => window.__coauthorCalls.filter((name) => name === "run_coauthor").length);
    assert.equal(runCount, 1, "Viewing, creating and continuing a check must not auto-run a model");
    await page.getByRole("button", { name: "决定", exact: false }).click();
    const decisionsPanel = page.getByRole("dialog", { name: "讨论决定" });
    await decisionsPanel.getByText("决定来源与修订", { exact: true }).click();
    await decisionsPanel.getByText("v2 · 当前修订", { exact: true }).waitFor();
    await decisionsPanel.getByText("v1 · 已替代（历史）", { exact: true }).waitFor();
    await decisionsPanel.getByText("主题别名：突破代价、境界代偿", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-history.png`), fullPage: true });
    assert.equal(await decisionsPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await decisionsPanel.getByRole("button", { name: "关闭讨论决定", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    reports.push({ viewport, overflow, panelOverflow, boxes, commands: await page.evaluate(() => window.__coauthorCalls) });
    await context.close();
  }
  assert.deepEqual(errors, [], "No browser application errors");
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify({ mode: "mock-ipc-no-cloud", reports, errors }, null, 2));
  console.log(`Coauthor browser smoke passed, desktop and mobile. Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
