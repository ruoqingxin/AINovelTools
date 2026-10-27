import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:1436" },
  playwright: { type: "string" },
  artifacts: { type: "string", default: ".tmp/coauthor-browser" },
  width: { type: "string" },
} });
const viewports = [{ width: 1440, height: 1000 }, { width: 960, height: 640 }, { width: 390, height: 844 }];
const selectedViewports = values.width ? viewports.filter(viewport => String(viewport.width) === values.width) : viewports;
if (!selectedViewports.length) throw new Error("--width must be 1440, 960 or 390");
const { chromium } = await import(values.playwright ? pathToFileURL(values.playwright).href : "playwright");
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const errors = [];
const reports = [];
try {
  for (const viewport of selectedViewports) {
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
        let deleted=false;
        let semanticStatus={settings:{version:0,profileId:null,fingerprint:"",kinds:[]},
          totalChunks:0,indexedChunks:0,pendingSourceUpdates:4};
        const receipt="检索操作回执（程序记录；计数为当次返回页，不是相关条数或全库总数）：\\n"
          +'- 关键词 "突破代价"（项目资料，offset=0）：实际返回 1 条。\\n'
          +"未检索到不等于不存在；未形成有效查询、未授权或索引不完整均不能证明查全。";
        const messages=[
          {id:"m1",sessionId:"s1",role:"USER",content:"我想在金丹后面增加一个新境界，突破的代价改为失去记忆。"},
          {id:"m2",sessionId:"s1",role:"ASSISTANT",content:"《修炼体系》里已有炼气、筑基、金丹三个阶段，原本的突破代价是寿元。\\n\\n可以沿着已有体系扩展，在金丹后加一层“照魂境”。你已选择失忆代价，我会把它作为当前分支的方向，原设定暂不替换。"},
          {id:"m-old",sessionId:"s1",role:"ASSISTANT",content:"早期试写仍使用寿元代价，保留作为历史对照。\\n\\n"+receipt,contextVersion:"coauthor:historical-run-00"},
          {id:"m3",sessionId:"s1",role:"USER",content:"先拿主角突破写一段。他忘了母亲的声音，压抑一点。"}
        ];
        const fact={key:"FACT:one",kind:"FACT",title:"陆沉 · 掌握 · 魂灯",revision:"fact1",
          content:"已审核事实记录，不是正文原句。",offset:0,totalChars:15,sessionId:null,
          knowledgeContext:{projectId:"p1",version:1,status:"CURRENT",facts:[],hasMoreAnchors:true,totalAnchors:17,
            anchors:Array.from({length:16},(_,index)=>({id:"anchor"+(index+1),chapterId:"chapter1",
              revisionId:"original1",blockId:"p"+(index+1),status:"CURRENT_REVISION"}))}};
        const relation={...fact,key:"RELATION:one",kind:"RELATION",title:"守护",revision:"relation1",
          content:"关系记录：守护。",totalChars:8,knowledgeContext:{...fact.knowledgeContext,facts:[
            {key:fact.key,revision:fact.revision,title:fact.title},
            {key:"FACT:two",revision:"fact2",title:"苏瑶 · 守在 · 门外"}]}};
        const secondFact={...fact,key:"FACT:two",title:"苏瑶 · 守在 · 门外",revision:"fact2",
          content:"已审核事实记录：苏瑶守在门外。",knowledgeContext:{...fact.knowledgeContext,
            hasMoreAnchors:false,totalAnchors:1,anchors:fact.knowledgeContext.anchors.slice(0,1)}};
        state.runs=Array.from({length:25},(_,index)=>({
          id:"historical-run-"+String(24-index).padStart(2,"0"),sessionId:"s1",userMessageId:"old-message-"+index,
          status:"COMPLETED",documentVersion:1,output:"历史试写 "+index,
          audit:index===24?[{kind:"initial_search",result:{hits:[fact],hasMore:false,pendingIndexUpdates:0,coverage:"仅关键词命中"}},
            {kind:"initial_decisions"},{kind:"context_assembly"},
            {kind:"tool",name:"search_sources",result:{error:"模拟检索失败"}},
            {kind:"retrieval_summary",displayText:receipt,receipts:[]},
            {kind:"draft_proposal",baseDocument:structuredClone(doc),
            document:{...doc,content:"旧建议：突破消耗寿元。"}}]:[]
        }));
        function lightState(){
          return {...structuredClone(state),runs:state.runs.slice(0,20).map(({audit,output,...summary})=>summary)};
        }
        let changes=null;
        let consumerHistory=[];
        let reversal=null;
        let branchMerge=null;
        let branchDecision=null;
        const sourceDecision={decision:{id:"branch-decision",topic:"突破例外",content:"用丹药免除突破代价",
          status:"REJECTED",sourceMessageId:"branch-author",version:4},aliases:["突破例外","丹药豁免"],quote:"不能靠丹药绕过代价"};
        const branch={sessionId:"branch1",title:"照魂境 · 另一结尾",relationship:"CHILD"};
        const branchDocument={...doc,sessionId:"branch1",version:2,content:"甲😀另一个结尾。\\n来源保留。"};
        let impacts=[];
        let sourceChecks=[{id:"check1",title:"突破代价 · 全部旧章",query:"失忆代价是否影响旧章",
          kinds:["MANUSCRIPT"],total:3,read:2,sent:1,reviewed:1,relevant:1,uncertain:0,
          stale:1,added:1,pendingIndexUpdates:0,needsReview:0,complete:false}];
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
        const knowledgeEntries=[
          {key:fact.key,revision:fact.revision,title:fact.title,totalChars:15,readChars:15,
            sentChars:15,sentComplete:true,nextOffset:15,stale:false,assessment:"RELEVANT",
            reason:"记录有关，仍须核对原文与适用时间。",quote:"已审核事实记录",lastError:null,knowledgeStatus:"CURRENT"},
          {key:relation.key,revision:relation.revision,title:relation.title,totalChars:8,readChars:8,
            sentChars:8,sentComplete:true,nextOffset:8,stale:false,assessment:"IRRELEVANT",
            reason:"原判断不能消除依据待核对状态。",quote:"",lastError:null,knowledgeStatus:"NEEDS_REVIEW"}
        ];
        function entriesFor(check){
          return [...checkEntries,...knowledgeEntries.filter(entry=>check.kinds.includes(entry.key.split(":")[0]))];
        }
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
            decisionDependencies:state.decisions.map((decision,index)=>({
              itemIds:index===0?["draft","realm"]:["opening"],
              decision:structuredClone(decision),current:structuredClone(decision)})),
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
          if(command==="health_query")return {schemaVersion:66};
          if(command==="get_coauthor_semantic_status")return structuredClone(semanticStatus);
          if(command==="save_coauthor_semantic_settings"){
            if(args.expectedVersion!==semanticStatus.settings.version)throw new Error("Semantic permission conflict");
            if(args.selection&&(args.selection.baseUrl!=="http://127.0.0.1:9/v1"||args.selection.modelId!=="embedding-test"))
              throw new Error("Unexpected embedding endpoint");
            semanticStatus={...semanticStatus,settings:{version:semanticStatus.settings.version+1,
              profileId:args.selection?.profileId??null,fingerprint:args.selection?"semantic-space":"",
              kinds:args.kinds}};
            return structuredClone(semanticStatus);
          }
          if(command==="build_coauthor_semantic_batch"){
            if(!semanticStatus.settings.profileId)throw new Error("Semantic permission required");
            if(args.expectedVersion!==semanticStatus.settings.version)throw new Error("Semantic permission changed");
            semanticStatus={...semanticStatus,totalChunks:17,indexedChunks:8,pendingSourceUpdates:0};
            return {status:structuredClone(semanticStatus),sentChars:9600,sentChunks:8};
          }
          if(command==="bootstrap_status")return {};
          if(command==="list_author_todos")return {pendingCount:0,items:[]};
          if(command==="list_discussion_sessions")return deleted?[]:[{id:"s1",projectId:"p1",title:"照魂境 · 失忆版本",scopeKind:"PROJECT"}];
          if(command==="delete_discussion_session"){
            if(args.scope.projectId!=="p1"||args.scope.sessionId!=="s1")throw new Error("Incorrect deletion scope");
            deleted=true;return null;
          }
          if(command==="get_coauthor_state")return lightState();
          if(command==="list_coauthor_branch_decisions")return {memories:[structuredClone(sourceDecision)],offset:args.offset,hasMore:false};
          if(command==="search_coauthor_decisions")return {memories:state.decisions.map(decision=>({
            decision:structuredClone(decision),aliases:[decision.topic],quote:null})),offset:args.offset,hasMore:false};
          if(command==="prepare_coauthor_branch_decision"){
            if(args.input.sourceDecisionId!=="branch-decision"||args.input.sourceVersion!==4
              ||args.input.targetDecisionId!==null||args.input.expectedVersion!==0)throw new Error("Unexpected decision selection");
            branchDecision={id:"branch-adopt1",status:"PENDING",branch:structuredClone(branch),
              source:structuredClone(sourceDecision),before:null,
              after:{...structuredClone(sourceDecision),decision:{...sourceDecision.decision,id:"d2",version:1,sourceMessageId:"branch-confirm"},
                quote:sourceDecision.decision.content}};
            return structuredClone(branchDecision);
          }
          if(command==="apply_coauthor_branch_decision"){
            if(args.id!==branchDecision?.id)throw new Error("Unknown decision receipt");
            if(branchDecision.status!=="APPLIED"){state.decisions.push(structuredClone(branchDecision.after.decision));branchDecision.status="APPLIED";}
            return structuredClone(branchDecision);
          }
          if(command==="get_coauthor_branch_decision")return structuredClone(branchDecision);
          if(command==="list_coauthor_branch_decision_adoptions")return {adoptions:branchDecision?[{
            id:branchDecision.id,status:branchDecision.status,sourceTitle:branch.title,topic:branchDecision.after.decision.topic,
            decisionStatus:branchDecision.after.decision.status,sourceVersion:4,afterVersion:1}]:[],hasMore:false};
          if(command==="list_coauthor_branches")return {branches:[branch],hasMore:false};
          if(command==="compare_coauthor_branch")return {
            branch:structuredClone(branch),baseDocument:structuredClone(doc),
            currentDocument:structuredClone(state.document),sourceDocument:structuredClone(branchDocument)};
          if(command==="prepare_coauthor_branch_merge"){
            const input=args.input;
            if(input.sourceSessionId!==branch.sessionId||input.expectedVersion!==state.document.version
              ||input.sourceVersion!==branchDocument.version)throw new Error("Branch snapshot changed");
            const before=structuredClone(state.document);
            const content=[...before.content].slice(0,input.targetStart).join("")
              +[...branchDocument.content].slice(input.sourceStart,input.sourceEnd).join("")
              +[...before.content].slice(input.targetEnd).join("");
            branchMerge={id:"merge1",status:"PENDING",branch:structuredClone(branch),before,source:structuredClone(branchDocument),
              after:{...before,version:before.version+1,content},sourceStart:input.sourceStart,sourceEnd:input.sourceEnd,
              targetStart:input.targetStart,targetEnd:input.targetEnd};
            return structuredClone(branchMerge);
          }
          if(command==="apply_coauthor_branch_merge"){
            if(!branchMerge||args.id!==branchMerge.id)throw new Error("Unknown merge receipt");
            if(branchMerge.status!=="APPLIED"){
              if(state.document.version!==branchMerge.before.version)throw new Error("Target changed");
              state.document=structuredClone(branchMerge.after);branchMerge.status="APPLIED";
            }
            return structuredClone(branchMerge);
          }
          if(command==="get_coauthor_branch_merge")return structuredClone(branchMerge);
          if(command==="list_coauthor_branch_merges")return {merges:branchMerge?[{
            id:branchMerge.id,status:branchMerge.status,sourceTitle:branch.title,beforeVersion:branchMerge.before.version,
            sourceVersion:branchDocument.version,afterVersion:branchMerge.after.version}]:[],hasMore:false};
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
            if(!["anchor1","anchor17"].includes(args.anchorId))throw new Error("Unknown evidence anchor");
            return {knowledgeKey:fact.key,knowledgeRevision:fact.revision,anchorId:args.anchorId,chapterId:"chapter1",
              revisionId:"original1",blockId:args.anchorId==="anchor1"?"p1":"p17",start:0,end:8,content:"陆沉😀掌握魂灯。",
              offset:0,nextOffset:8,totalChars:8,isCurrentRevision:true};
          }
          if(command==="list_coauthor_knowledge_anchors"){
            assertSource(args,fact);
            if(![0,16].includes(args.offset))throw new Error("Unexpected anchor cursor");
            return {knowledgeKey:fact.key,knowledgeRevision:fact.revision,offset:args.offset,totalAnchors:17,
              nextOffset:args.offset===0?16:17,anchors:args.offset===0?structuredClone(fact.knowledgeContext.anchors):
                [{id:"anchor17",chapterId:"chapter1",revisionId:"original1",blockId:"p17",status:"CURRENT_REVISION"}]};
          }
          if(command==="get_coauthor_evidence_progress"){
            assertSource(args,fact);
            if(![0,16].includes(args.offset))throw new Error("Unexpected evidence progress cursor");
            const anchors=[...fact.knowledgeContext.anchors,
              {id:"anchor17",chapterId:"chapter1",revisionId:"original1",blockId:"p17",status:"CURRENT_REVISION"}];
            return {id:"evidence-check1",knowledgeKey:fact.key,knowledgeRevision:fact.revision,title:fact.title,
              listedAnchors:17,totalAnchors:17,validatedAnchors:2,readAnchors:1,sentAnchors:0,
              stale:false,needsReview:false,allEvidenceSent:false,offset:args.offset,nextOffset:Math.min(17,args.offset+16),
              entries:anchors.slice(args.offset,args.offset+16).map(anchor=>({
                anchor,totalChars:["anchor1","anchor2"].includes(anchor.id)?8:null,
                readChars:anchor.id==="anchor1"?8:anchor.id==="anchor2"?3:0,
                sentChars:anchor.id==="anchor1"?2:0,nextOffset:anchor.id==="anchor1"?2:0,
                readComplete:anchor.id==="anchor1",sentComplete:false}))};
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
          if(command==="correct_coauthor_decision"){
            const decision=state.decisions.find(entry=>entry.id===args.id);
            if(!decision||decision.version!==args.expectedVersion)throw new Error("Decision version conflict");
            Object.assign(decision,{version:decision.version+1,content:args.content,status:args.status,sourceMessageId:"correction"});
            return structuredClone(decision);
          }
          if(command==="list_coauthor_source_checks")return {checks:structuredClone(sourceChecks),hasMore:false};
          if(command==="get_coauthor_source_check"){
            const check=sourceChecks.find(item=>item.id===args.id);
            return {check:structuredClone(check),entries:structuredClone(entriesFor(check)),offset:0,hasMore:false};
          }
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
            check.total=entriesFor(check).length;
            check.needsReview=check.kinds.includes("RELATION")?1:0;
            sourceChecks.unshift(check);
            return {check:structuredClone(check),entries:structuredClone(entriesFor(check)),offset:0,hasMore:false};
          }
          if(command==="list_model_profiles")return [{id:"model",name:"本地验收模型",capability:"CHAT",hasSecret:true},
            {id:"embedding",name:"本地向量验收模型",capability:"EMBEDDING",hasSecret:true,privacyLevel:"ALLOW_CLOUD",
              provider:"SILICON_FLOW",baseUrl:"http://127.0.0.1:9/v1",modelId:"embedding-test"}];
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
          if(command==="prepare_coauthor_changeset"){
            const request=args.request;
            if(request.expectedDocumentVersion!==state.document.version)throw new Error("Draft version conflict");
            changes={...preparedChanges(),id:"manual-rule-change",title:request.title,coverage:request.coverage,
              items:[{id:"draft",document:structuredClone(state.document),before:null,dependsOn:request.draftDependsOn},
                ...request.items.map(item=>({id:item.id,document:{...state.document,kind:item.kind,title:item.title,
                  content:item.content,targetKey:item.targetKey,targetRevision:item.targetRevision},
                  before:null,dependsOn:item.dependsOn}))],
              impacts:request.impacts,decisionDependencies:request.decisionDependencies.map(entry=>{
                const decision=state.decisions.find(decision=>decision.id===entry.decisionId);
                if(!decision||decision.version!==entry.version)throw new Error("Decision version conflict");
                return {itemIds:entry.itemIds,decision:structuredClone(decision),current:structuredClone(decision)};
              })};
            consumerHistory=Array.from({length:16},(_,index)=>({...structuredClone(changes),
              id:"historical-rule-change-"+index,title:"历史关联方案 "+(index+1)}));
            return structuredClone(changes);
          }
          if(command==="get_coauthor_changes"){
            changes??=preparedChanges();
            return {changeSets:[{id:changes.id,version:changes.version,title:changes.title,status:changes.status,itemCount:changes.items.length,reversedBy:changes.reversedBy}],
              impacts:structuredClone(impacts),hasMoreChanges:false,hasMoreImpacts:false};
          }
          if(command==="get_coauthor_changeset"){
            const selected=[changes,...consumerHistory].find(value=>value?.id===args.id);
            if(!selected)throw new Error("Unknown exact change set");
            return {...structuredClone(selected),
              decisionDependencies:selected.decisionDependencies.map(entry=>({...structuredClone(entry),
                current:structuredClone(state.decisions.find(decision=>decision.id===entry.decision.id)??null)}))};
          }
          if(command==="list_coauthor_decision_consumers"){
            if(args.scope.projectId!=="p1"||args.scope.sessionId!=="s1"
              ||![0,16].includes(args.offset)||typeof args.needsReviewOnly!=="boolean")throw new Error("Invalid consumer scope");
            const decision=state.decisions.find(value=>value.id===args.decisionId);
            if(!decision)throw new Error("Unknown exact decision");
            const entries=[changes,...consumerHistory].filter(Boolean).flatMap(plan=>
              plan.decisionDependencies.filter(dependency=>dependency.decision.id===decision.id).flatMap(dependency=>
                dependency.itemIds.map(itemId=>{
                  const item=plan.items.find(value=>value.id===itemId);
                  const published=plan.published.find(value=>value.itemId===itemId);
                  const state=plan.status==="PENDING"?"PENDING":plan.status==="DISCARDED"?"DISCARDED":
                    !published?"NOT_ADOPTED":plan.reversedBy?"REVERSED":"ADOPTED";
                  return {changeSetId:plan.id,changeSetTitle:plan.title,changeSetVersion:plan.version,
                    itemId,itemTitle:item.document.title,kind:item.document.kind,decisionVersion:dependency.decision.version,
                    state,needsReview:dependency.decision.version!==decision.version&&["PENDING","ADOPTED"].includes(state),
                    publishedKey:published?.sourceKey??null,publishedRevision:published?.revision??null};
                }))).filter(entry=>!args.needsReviewOnly||entry.needsReview);
            return {decision:structuredClone(decision),entries:entries.slice(args.offset,args.offset+16),
              unknownChangeSets:1,offset:args.offset,hasMore:args.offset+16<entries.length};
          }
          if(command==="commit_coauthor_changeset"){
            if(changes.status==="COMMITTED")return structuredClone(changes);
            if(args.selectedIds.includes("draft")&&!args.selectedIds.includes("realm"))throw new Error("missing dependency");
            if(changes.decisionDependencies.some(entry=>entry.itemIds.some(id=>args.selectedIds.includes(id))
              &&JSON.stringify(entry.decision)!==JSON.stringify(state.decisions.find(decision=>decision.id===entry.decision.id))))
              throw new Error("Decision dependency changed");
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
    await page.getByRole("heading", { name: "讨论区", exact: true }).waitFor();
    await page.getByRole("button", { name: "依据与运行记录", exact: true }).waitFor();
    assert.equal(await page.getByRole("group", { name: "讨论工具", exact: true }).getByRole("button").count(), 2);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-discussion.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `Horizontal overflow at ${viewport.width}px`);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.some((name) =>
      name === "get_coauthor_run" || name === "list_coauthor_runs")), false,
    "Opening the workspace must not load historical audits or the run directory");
    assert.equal(await page.getByLabel("允许改工作稿", { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel("工作稿内容", { exact: true }).isVisible(), false);
    const historicalReply = page.locator(".coauthor-message").filter({ hasText: "早期试写仍使用寿元代价" });
    assert.equal(await historicalReply.locator(":scope > div").first().innerText(), "早期试写仍使用寿元代价，保留作为历史对照。");
    assert.equal(await historicalReply.locator("details, footer").count(), 0);
    assert.equal(await historicalReply.getByRole("button", { name: "核对这条回复", exact: true }).count(), 0);
    await historicalReply.getByRole("button", { name: "查看本轮记录", exact: true }).click();
    const sourcesPanel = page.getByRole("dialog", { name: "依据与运行记录" });
    for (const recordTab of await sourcesPanel.getByRole("tablist", { name: "运行记录分类" }).getByRole("tab").all()) {
      assert.ok((await recordTab.boundingBox()).height <= 42, `Record tab label wrapped at ${viewport.width}px`);
    }
    await sourcesPanel.getByText("记录中没有可核实的内容复核结论。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("run_coauthor")), false);
    assert.equal(await historicalReply.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-reply-feedback.png`), fullPage: true });
    await sourcesPanel.getByRole("button", { name: "核对这条回复", exact: true }).click();
    assert.ok((await page.getByLabel("讨论输入", { exact: true }).inputValue()).includes('"messageId": "m-old"'));
    assert.equal(await page.getByLabel("讨论输入", { exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("run_coauthor")), false);
    await page.getByLabel("讨论输入", { exact: true }).fill("");
    await historicalReply.getByRole("button", { name: "查看本轮记录", exact: true }).click();
    await sourcesPanel.getByRole("tab", { name: "改稿建议", exact: true }).waitFor();
    assert.equal(await sourcesPanel.getByText(/实际返回 1 条/).count(), 0);
    await sourcesPanel.getByRole("tab", { name: "检索回执", exact: true }).click();
    await sourcesPanel.getByText(/实际返回 1 条/).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-retrieval-receipt.png`), fullPage: true });
    await sourcesPanel.getByRole("tab", { name: "运行步骤", exact: true }).click();
    await sourcesPanel.getByText("读取当前讨论的决定与约束", { exact: true }).waitFor();
    await sourcesPanel.getByText("按关键词检索资料 · 未成功执行", { exact: true }).waitFor();
    assert.equal(await sourcesPanel.getByText("initial_decisions", { exact: true }).count(), 0);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-retrieval-steps.png`), fullPage: true });
    await sourcesPanel.getByRole("tab", { name: "参考资料", exact: true }).click();
    await sourcesPanel.getByText("已审核事实记录 · v1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.some(name =>
      name === "read_coauthor_knowledge_evidence" || name === "list_coauthor_related_knowledge"
        || name === "list_coauthor_knowledge_anchors" || name === "get_coauthor_evidence_progress")), false,
    "Knowledge metadata must not eagerly load manuscript evidence or relationships");
    await sourcesPanel.getByText("正文证据 · p1", { exact: true }).click();
    await sourcesPanel.getByText("陆沉😀掌握魂灯。", { exact: true }).waitFor({ state: "visible" });
    const evidenceUrl = new URL(await sourcesPanel.getByRole("link", { name: "定位原修订" }).getAttribute("href"), values.url);
    assert.equal(evidenceUrl.searchParams.get("sourceEvidence"), "anchor1");
    assert.equal(evidenceUrl.searchParams.get("sourceRevision"), "original1");
    assert.equal(evidenceUrl.searchParams.get("sourceBlock"), "p1");
    await sourcesPanel.getByRole("button", { name: "下一页证据", exact: true }).click();
    await sourcesPanel.getByText("证据目录 · 17 至 17 / 17 条", { exact: true }).waitFor();
    assert.equal(await sourcesPanel.getByText("正文证据 · p1", { exact: true }).count(), 0);
    assert.equal(await sourcesPanel.getByRole("button", { name: "下一页证据", exact: true }).isDisabled(), true);
    await sourcesPanel.getByText("正文证据 · p17", { exact: true }).click();
    await sourcesPanel.getByText("原文身份与范围已核验 · 本段 0 至 8 / 8 字符", { exact: true }).waitFor();
    const lastEvidenceUrl = new URL(await sourcesPanel.getByRole("link", { name: "定位原修订" }).getAttribute("href"), values.url);
    assert.equal(lastEvidenceUrl.searchParams.get("sourceEvidence"), "anchor17");
    assert.equal(await sourcesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-knowledge-anchors.png`), fullPage: true });
    await sourcesPanel.getByRole("button", { name: "上一页证据", exact: true }).click();
    await sourcesPanel.getByText("证据目录 · 1 至 16 / 17 条", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("get_coauthor_evidence_progress")), false,
      "Author evidence reading must not automatically query or advance model progress");
    const progressPanel = sourcesPanel.locator("details.coauthor-evidence-progress");
    await progressPanel.locator(":scope > summary").click();
    await progressPanel.getByText("独立证据 17 条", { exact: true }).waitFor();
    await progressPanel.getByText("执行读取 8 / 8 字符 · 模型送达 2 / 8 字符 · 连续送达至 2", { exact: true }).waitFor();
    assert.equal(await progressPanel.locator("dd").allTextContents().then(values => values.join(",")), "2,1,0");
    const firstProgressEvidence = progressPanel.getByText("正文证据 · p1", { exact: true });
    await firstProgressEvidence.click();
    await progressPanel.getByText("陆沉😀掌握魂灯。", { exact: true }).waitFor();
    await progressPanel.getByRole("button", { name: "刷新证据进度", exact: true }).click();
    await progressPanel.getByText("执行读取 8 / 8 字符 · 模型送达 2 / 8 字符 · 连续送达至 2", { exact: true }).waitFor();
    assert.equal(await progressPanel.locator("dd").allTextContents().then(values => values.join(",")), "2,1,0",
      "Author quote inspection must not count as execution reading or successful model delivery");
    assert.equal(await progressPanel.getByText("本版本全部独立证据引句已送达过模型，语义及适用条件仍待核对。", { exact: true }).count(), 0);
    assert.equal(await progressPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await progressPanel.evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-evidence-progress.png`), fullPage: true });
    await progressPanel.getByRole("button", { name: "下一页证据进度", exact: true }).click();
    await progressPanel.getByRole("navigation", { name: "模型证据进度分页" }).getByText("第 2 页", { exact: true }).waitFor();
    await progressPanel.getByText("正文证据 · p17", { exact: true }).waitFor();
    assert.equal(await progressPanel.getByRole("button", { name: "下一页证据进度", exact: true }).isDisabled(), true);
    assert.equal(await progressPanel.getByText("正文证据 · p1", { exact: true }).count(), 0);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-evidence-progress-last.png`), fullPage: true });
    await progressPanel.getByRole("button", { name: "上一页证据进度", exact: true }).click();
    await progressPanel.getByText("正文证据 · p1", { exact: true }).waitFor();
    await progressPanel.locator(":scope > summary").click();
    await sourcesPanel.getByText("直接关联关系", { exact: true }).click();
    await sourcesPanel.getByRole("button", { name: "查看关系记录", exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-knowledge.png`), fullPage: true });
    await sourcesPanel.getByRole("button", { name: "查看关系记录", exact: true }).click();
    await sourcesPanel.getByText("关系记录 · v1", { exact: true }).waitFor();
    await sourcesPanel.getByRole("button", { name: "终点事实 · 苏瑶 · 守在 · 门外", exact: true }).click();
    await sourcesPanel.getByRole("heading", { name: "苏瑶 · 守在 · 门外", exact: true }).waitFor();
    assert.equal(await sourcesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await sourcesPanel.getByRole("tab", { name: "本轮概览", exact: true }).click();
    await sourcesPanel.getByText("保留的回复", { exact: true }).click();
    await sourcesPanel.getByText("历史试写 24", { exact: true }).waitFor({ state: "visible" });
    await sourcesPanel.getByRole("button", { name: "更早运行", exact: true }).click();
    await sourcesPanel.getByRole("navigation", { name: "运行目录分页" }).getByText("第 2 页", { exact: true }).waitFor();
    await sourcesPanel.getByLabel("查看运行", { exact: true }).selectOption("historical-run-01");
    await sourcesPanel.getByText("基础稿件", { exact: false }).waitFor();
    await sourcesPanel.getByLabel("查看运行", { exact: true }).selectOption("historical-run-00");
    await sourcesPanel.getByRole("tab", { name: "改稿建议", exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-run-directory.png`), fullPage: true });
    assert.equal(await sourcesPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await sourcesPanel.getByRole("button", { name: "较新运行", exact: true }).click();
    await sourcesPanel.getByRole("navigation", { name: "运行目录分页" }).getByText("第 1 页", { exact: true }).waitFor();
    await sourcesPanel.getByRole("tab", { name: "改稿建议", exact: true }).click();
    const oldProposal = sourcesPanel;
    await oldProposal.getByLabel("AI 建议稿", { exact: true }).waitFor();
    assert.equal(await oldProposal.getByLabel("AI 建议稿", { exact: true }).inputValue(), "旧建议：突破消耗寿元。");
    assert.equal(await oldProposal.getByRole("button", { name: "采用整份工作稿修改", exact: true }).isDisabled(), true);
    assert.equal(await oldProposal.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-historical-proposal.png`), fullPage: true });
    assert.equal(await oldProposal.getByRole("button", { name: "仅采用选中文字", exact: true }).isDisabled(), true);
    await oldProposal.getByRole("button", { name: "关闭依据与运行记录", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("run_coauthor")), false,
      "Historical comparison must not start a model");
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("get_coauthor_semantic_status")), false,
      "Closed semantic panel must not fetch configuration");
    await page.getByRole("button", { name: "依据与运行记录", exact: true }).click();
    const semanticPanel = sourcesPanel;
    await semanticPanel.getByRole("tab", { name: "检索设置", exact: true }).click();
    await semanticPanel.getByText("项目语义检索未启用", { exact: true }).waitFor();
    await semanticPanel.getByLabel("向量模型", { exact: true }).selectOption("embedding");
    await semanticPanel.getByRole("checkbox", { name: "正文", exact: true }).check();
    await semanticPanel.getByRole("button", { name: "保存授权", exact: true }).click();
    const permission = page.getByRole("alertdialog", { name: "授权项目语义检索" });
    await permission.waitFor();
    assert.ok((await permission.innerText()).includes("http://127.0.0.1:9/v1"));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-semantic-permission.png`), fullPage: true });
    await permission.getByRole("button", { name: "确认授权", exact: true }).click();
    await semanticPanel.getByText("项目语义检索已授权", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("build_coauthor_semantic_batch")), false);
    await semanticPanel.getByRole("button", { name: "建立下一批", exact: true }).click();
    await page.getByRole("alertdialog", { name: "建立一批语义索引" }).getByRole("button", { name: "建立本批" }).click();
    await semanticPanel.getByText("本批发送 8 块、9600 字。", { exact: true }).waitFor();
    await semanticPanel.getByText("向量分块 8 / 17 · 资料索引待更新 0 项", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-semantic-index.png`), fullPage: true });
    assert.equal(await semanticPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "build_coauthor_semantic_batch").length), 1);
    await semanticPanel.getByRole("button", { name: "撤销授权", exact: true }).click();
    await semanticPanel.getByText("项目语义检索未启用", { exact: true }).waitFor();
    await semanticPanel.getByRole("button", { name: "关闭依据与运行记录", exact: true }).click();
    await page.getByLabel("讨论输入", { exact: true }).fill("前半段保留，最后一句再克制一点。");
    await page.getByLabel("允许改工作稿", { exact: true }).check();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("我保留前半段，只推敲最后一句。", { exact: true }).first().waitFor();
    await page.waitForTimeout(450);
    await page.getByRole("tab", { name: "工作稿", exact: true }).click();
    const draft = page.getByLabel("工作稿内容", { exact: true });
    await draft.waitFor({ state: "visible" });
    await draft.fill(`${await draft.inputValue()}\n\n作者继续写下去。`);
    await page.getByText(/已保存 v2/).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-draft.png`), fullPage: true });
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("list_coauthor_branches")), false,
      "Opening a workspace must not load branch drafts or the branch directory");
    await page.getByRole("button", { name: "分支比较与合并", exact: true }).click();
    const branchPanel = page.getByRole("dialog", { name: "分支比较与合并", exact: true });
    await branchPanel.getByRole("option", { name: "子分支 · 照魂境 · 另一结尾", exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("compare_coauthor_branch")), false);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("list_coauthor_branch_merges")), false);
    await branchPanel.getByLabel("对照分支", { exact: true }).selectOption("branch1");
    await branchPanel.getByRole("button", { name: "比较分支", exact: true }).click();
    const branchSource = branchPanel.getByLabel("合并来源稿", { exact: true });
    await branchSource.waitFor();
    await branchPanel.getByText("继承起点 · v1", { exact: true }).click();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-comparison.png`), fullPage: true });
    await branchSource.focus();
    await branchSource.evaluate(el => el.setSelectionRange(1, 8));
    await branchSource.press("Shift");
    await branchPanel.getByText("来源字符 1 至 7", { exact: true }).waitFor();
    const draftBeforeMerge = await draft.inputValue();
    await branchPanel.getByRole("button", { name: "准备合并预览", exact: true }).click();
    await branchPanel.getByRole("button", { name: "确认合并到工作稿", exact: true }).waitFor();
    assert.equal(await branchPanel.getByLabel("分支合并后", { exact: true }).innerText(), `${draftBeforeMerge}😀另一个结尾`);
    assert.equal(await branchPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await branchPanel.getByRole("region", { name: "分支合并预览", exact: true }).evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-preview.png`), fullPage: true });
    await branchPanel.getByRole("button", { name: "确认合并到工作稿", exact: true }).click();
    const mergeConfirmation = page.getByRole("alertdialog", { name: "合并分支文字", exact: true });
    await mergeConfirmation.waitFor();
    assert.ok((await mergeConfirmation.innerText()).includes("讨论决定、正式设定与其他章节不合并"));
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("apply_coauthor_branch_merge")), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-confirmation.png`), fullPage: true });
    await mergeConfirmation.getByRole("button", { name: "确认合并文字", exact: true }).click();
    await branchPanel.getByText("已合并为工作稿 v3，当前稿件可能已有后续编辑。", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), `${draftBeforeMerge}😀另一个结尾`);
    await branchPanel.getByText("分支合并记录", { exact: true }).click();
    await branchPanel.getByRole("button", { name: "查看合并记录", exact: true }).click();
    await branchPanel.getByRole("heading", { name: "合并回执 · 照魂境 · 另一结尾", exact: true }).waitFor();
    assert.equal(await branchPanel.getByRole("button", { name: "确认合并到工作稿", exact: true }).count(), 0);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-receipt.png`), fullPage: true });
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "run_coauthor").length), 1,
      "Branch comparison and author merge must not run a model");
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("list_coauthor_branch_decisions")), false);
    const draftBeforeDecision = await draft.inputValue();
    await branchPanel.getByText("分支决定对照与采用", { exact: true }).click();
    const decisionRegion = branchPanel.getByRole("region", { name: "分支决定对照与采用", exact: true });
    await decisionRegion.getByRole("radio", { name: "突破例外 · 已否定 · v4", exact: true }).check();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("list_coauthor_branch_decision_adoptions")), false);
    await decisionRegion.getByRole("button", { name: "准备决定采用预览", exact: true }).click();
    await decisionRegion.getByRole("button", { name: "确认采用到当前讨论", exact: true }).waitFor();
    await decisionRegion.getByRole("region", { name: "决定采用预览", exact: true }).evaluate(el => el.scrollIntoView({ block: "start" }));
    assert.equal(await branchPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-decision-preview.png`), fullPage: true });
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("apply_coauthor_branch_decision")), false);
    await decisionRegion.getByRole("button", { name: "确认采用到当前讨论", exact: true }).click();
    const decisionConfirmation = page.getByRole("alertdialog", { name: "采用分支决定", exact: true });
    await decisionConfirmation.waitFor();
    assert.ok((await decisionConfirmation.innerText()).includes("从不存在变为已否定"));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-decision-confirmation.png`), fullPage: true });
    await decisionConfirmation.getByRole("button", { name: "确认采用决定", exact: true }).click();
    await decisionRegion.getByText(/已采用为决定 v1/).waitFor();
    assert.equal(await draft.inputValue(), draftBeforeDecision, "Decision adoption must not change the draft");
    await decisionRegion.getByText("分支决定采用记录", { exact: true }).click();
    await decisionRegion.getByRole("button", { name: "查看决定采用记录", exact: true }).click();
    await decisionRegion.getByRole("heading", { name: "决定采用回执 · 照魂境 · 另一结尾", exact: true }).waitFor();
    assert.equal(await decisionRegion.getByRole("button", { name: "确认采用到当前讨论", exact: true }).count(), 0);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-branch-decision-receipt.png`), fullPage: true });
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "run_coauthor").length), 1);
    await branchPanel.getByRole("button", { name: "关闭分支比较与合并", exact: true }).click();
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
      assert.ok(box.x >= 0 && box.right <= viewport.width + 1, `${box.selector} must fit ${viewport.width}px: ${JSON.stringify(box)}`);
      assert.ok(box.height > 0, `${box.selector} is not blank`);
    }
    await page.getByRole("button", { name: "关联变更", exact: true }).click();
    const changesPanel = page.getByRole("dialog", { name: "关联变更与影响" });
    await changesPanel.getByRole("button", { name: "核对差异" }).click();
    const decisionDependencies = changesPanel.getByRole("region", { name: "讨论决定依赖核对" });
    await decisionDependencies.getByText("准备时 · v2 · 已选择", { exact: true }).waitFor();
    await decisionDependencies.getByText("当前 · v2 · 已选择", { exact: true }).waitFor();
    await decisionDependencies.getByText("准备时 · v1 · 已否定", { exact: true }).waitFor();
    await decisionDependencies.getByText("当前 · v1 · 已否定", { exact: true }).waitFor();
    assert.equal(await decisionDependencies.getByText("用丹药免除突破代价", { exact: true }).count(), 2);
    await decisionDependencies.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-dependencies.png`), fullPage: true });
    assert.equal(await decisionDependencies.evaluate((el) => el.scrollWidth > el.clientWidth), false);
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
    assert.ok((await confirmation.innerText()).includes("核对 2 条明确声明的决定依赖"));
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
    await page.getByRole("button", { name: "依据与运行记录", exact: true }).click();
    const checksPanel = sourcesPanel;
    await checksPanel.getByRole("tab", { name: "查证清单", exact: true }).click();
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
    await checksPanel.getByRole("tab", { name: "本轮记录", exact: true }).click();
    await checksPanel.getByRole("tab", { name: "查证清单", exact: true }).click();
    assert.equal(await checksPanel.getByLabel("清单标题").inputValue(), "核对新范围");
    assert.equal(await checksPanel.getByLabel("查证问题").inputValue(), "核对全部突破情节和相关设定");
    await checksPanel.getByLabel("有效设定卡").check();
    await checksPanel.getByLabel("已审核事实", { exact: true }).check();
    await checksPanel.getByLabel("关系记录", { exact: true }).check();
    await checksPanel.getByRole("button", { name: "创建清单", exact: true }).click();
    await checksPanel.getByRole("heading", { name: "核对新范围", exact: true }).waitFor();
    await checksPanel.getByText("1 项事实或关系的依据待核对，不计为范围查证完成。", { exact: true }).waitFor();
    const factEntry = checksPanel.getByRole("article").filter({ hasText: "陆沉 · 掌握 · 魂灯" });
    await factEntry.getByText("记录与正文证据", { exact: true }).click();
    await factEntry.getByText("已审核事实记录，不是正文原句。", { exact: true }).waitFor();
    await factEntry.getByText("正文证据 · p1", { exact: true }).click();
    await factEntry.getByText("陆沉😀掌握魂灯。", { exact: true }).waitFor();
    await factEntry.getByRole("link", { name: "定位原修订" }).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-knowledge-checks.png`), fullPage: true });
    assert.equal(await checksPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await checksPanel.getByRole("button", { name: "核对范围变化", exact: true }).click();
    assert.ok((await page.getByLabel("讨论输入", { exact: true }).inputValue()).includes("继续查证清单 check2"));
    const runCount = await page.evaluate(() => window.__coauthorCalls.filter((name) => name === "run_coauthor").length);
    assert.equal(runCount, 1, "Viewing, creating and continuing a check must not auto-run a model");
    await page.getByRole("navigation", { name: "工作区", exact: true })
      .getByRole("button", { name: "决定", exact: false }).click();
    const decisionsPanel = page.getByRole("dialog", { name: "讨论决定" });
    await decisionsPanel.getByRole("article").filter({ has: page.getByText("突破代价", { exact: true }) }).getByText("决定来源与修订", { exact: true }).click();
    await decisionsPanel.getByText("v2 · 当前修订", { exact: true }).waitFor();
    await decisionsPanel.getByText("v1 · 已替代（历史）", { exact: true }).waitFor();
    await decisionsPanel.getByText("主题别名：突破代价、境界代偿", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-history.png`), fullPage: true });
    assert.equal(await decisionsPanel.evaluate((el) => el.scrollWidth > el.clientWidth), false);
    await decisionsPanel.getByRole("button", { name: "关闭讨论决定", exact: true }).click();
    await page.getByRole("tab", { name: "工作稿", exact: true }).click();
    await page.getByRole("button", { name: "关联变更", exact: true }).click();
    await changesPanel.getByText("准备新的变更集", { exact: true }).click();
    await changesPanel.getByRole("checkbox", { name: "同时新建设定", exact: true }).check();
    await changesPanel.getByLabel("关联设定标题", { exact: true }).fill("独立城门");
    await changesPanel.getByLabel("关联设定内容", { exact: true }).fill("城门向南。");
    const decisionSearches = await page.evaluate(() => window.__coauthorCalls.filter(name => name === "search_coauthor_decisions").length);
    await changesPanel.getByText("依赖的讨论决定 · 0 条", { exact: true }).click();
    await changesPanel.getByRole("checkbox", { name: "突破例外 → 当前工作稿", exact: true }).check();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "search_coauthor_decisions").length), decisionSearches + 1);
    await changesPanel.getByRole("button", { name: "从当前工作稿准备", exact: true }).click();
    await decisionDependencies.getByText("准备时 · v1 · 已否定", { exact: true }).waitFor();
    await changesPanel.getByRole("button", { name: "关闭关联变更与影响", exact: true }).click();
    await page.getByRole("navigation", { name: "工作区", exact: true })
      .getByRole("button", { name: "决定", exact: false }).click();
    await decisionsPanel.getByRole("article").filter({ has: page.getByText("突破例外", { exact: true }) })
      .getByRole("button", { name: "纠正", exact: true }).click();
    await decisionsPanel.getByLabel("决定状态", { exact: true }).selectOption("WITHDRAWN");
    await decisionsPanel.getByRole("button", { name: "保存纠正", exact: true }).click();
    await decisionsPanel.getByText("已撤回 · v2", { exact: true }).waitFor();
    await decisionsPanel.getByRole("button", { name: "关闭讨论决定", exact: true }).click();
    await page.getByRole("button", { name: "关联变更", exact: true }).click();
    await changesPanel.getByRole("button", { name: "核对差异", exact: true }).click();
    await decisionDependencies.getByText("当前 · v2 · 已撤回", { exact: true }).waitFor();
    await decisionDependencies.getByText("所选变更依赖的决定已变化，须重新核对并准备。", { exact: true }).waitFor();
    assert.equal(await changesPanel.getByRole("button", { name: "确认采用所选变更", exact: true }).isDisabled(), true);
    await changesPanel.getByRole("checkbox", { name: "第十二章 · 声音的代价 正文", exact: true }).uncheck();
    await decisionDependencies.getByText("决定已变化；当前未选其依赖项，不阻止其他独立项目。", { exact: true }).waitFor();
    assert.equal(await changesPanel.getByRole("button", { name: "确认采用所选变更", exact: true }).isEnabled(), true);
    await decisionDependencies.evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-stale-decision-dependencies.png`), fullPage: true });
    assert.equal(await changesPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await changesPanel.getByRole("button", { name: "确认采用所选变更", exact: true }).click();
    await confirmation.waitFor({ state: "visible" });
    assert.ok((await confirmation.innerText()).includes("核对 0 条明确声明的决定依赖"));
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "commit_coauthor_changeset").length), 1);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "run_coauthor").length), 1);
    await changesPanel.getByRole("button", { name: "关闭关联变更与影响", exact: true }).click();
    const draftBeforeConsumers = await draft.inputValue();
    await page.getByRole("navigation", { name: "工作区", exact: true })
      .getByRole("button", { name: "决定", exact: false }).click();
    const consumerQueries = await page.evaluate(() => window.__coauthorCalls.filter(name => name === "list_coauthor_decision_consumers").length);
    const exception = decisionsPanel.getByRole("article").filter({ has: page.getByText("突破例外", { exact: true }) });
    assert.equal(consumerQueries, 0, "Collapsed decision consumers must not query");
    await exception.getByText("决定关联与影响", { exact: true }).click();
    const consumers = exception.getByRole("region", { name: "决定关联项目", exact: true });
    await consumers.getByText("读取时当前决定 · v2 · 已撤回", { exact: true }).waitFor();
    await consumers.getByText("另有 1 份有效或待确认方案未记录依赖，无法判断是否相关。", { exact: true }).waitFor();
    assert.equal(await consumers.getByRole("article").count(), 16);
    assert.equal(await consumers.getByRole("button", { name: "上一页决定关联", exact: true }).isDisabled(), true);
    await consumers.getByRole("button", { name: "下一页决定关联", exact: true }).click();
    await consumers.getByText("原方案：历史关联方案 16 · v1", { exact: true }).waitFor();
    assert.equal(await consumers.getByRole("article").count(), 1);
    assert.equal(await consumers.getByRole("button", { name: "下一页决定关联", exact: true }).isDisabled(), true);
    await consumers.getByRole("checkbox", { name: "仅需复查", exact: true }).uncheck();
    await consumers.getByText("第 1 页", { exact: true }).waitFor();
    await consumers.getByRole("button", { name: "下一页决定关联", exact: true }).click();
    await consumers.getByText("原方案：历史关联方案 16 · v1", { exact: true }).waitFor();
    await consumers.getByRole("button", { name: "刷新决定关联", exact: true }).click();
    await consumers.getByText("读取时当前决定 · v2 · 已撤回", { exact: true }).waitFor();
    await consumers.evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-consumers.png`), fullPage: true });
    assert.equal(await decisionsPanel.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await consumers.getByRole("button", { name: "核对原方案", exact: true }).click();
    await changesPanel.getByRole("heading", { name: "历史关联方案 16", exact: true }).waitFor();
    assert.equal(await changesPanel.getByRole("article").filter({ hasText: "历史关联方案 16" }).count(), 0,
      "Exact target is not in the first directory page");
    await decisionDependencies.getByText("当前 · v2 · 已撤回", { exact: true }).waitFor();
    assert.equal(await changesPanel.getByRole("button", { name: "确认采用所选变更", exact: true }).isDisabled(), true);
    await decisionDependencies.evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-consumer-exact-plan.png`), fullPage: true });
    assert.equal(await draft.inputValue(), draftBeforeConsumers, "Reverse lookup must not change the draft");
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "commit_coauthor_changeset").length), 1);
    assert.equal(await page.evaluate(() => window.__coauthorCalls.filter(name => name === "run_coauthor").length), 1);
    await changesPanel.getByRole("button", { name: "关闭关联变更与影响", exact: true }).click();
    const inputBeforeReview = await page.getByLabel("讨论输入", { exact: true }).inputValue();
    await page.getByRole("navigation", { name: "工作区", exact: true })
      .getByRole("button", { name: "决定", exact: false }).click();
    await exception.getByText("决定关联与影响", { exact: true }).click();
    await consumers.getByText("读取时当前决定 · v2 · 已撤回", { exact: true }).waitFor();
    await consumers.getByRole("button", { name: "下一页决定关联", exact: true }).click();
    await consumers.getByText("原方案：历史关联方案 16 · v1", { exact: true }).waitFor();
    const writesBeforeReview = await page.evaluate(() => window.__coauthorCalls.filter(name =>
      /^(save_|run_coauthor|prepare_|commit_|apply_)/.test(name)));
    await consumers.getByRole("button", { name: "带回讨论核对", exact: true }).click();
    await decisionsPanel.waitFor({ state: "hidden" });
    const reviewInput = page.getByLabel("讨论输入", { exact: true });
    const reviewText = await reviewInput.inputValue();
    assert.ok(reviewText.startsWith(inputBeforeReview + "\n\n"), "Review continuation must preserve existing author input");
    assert.ok(reviewText.includes("决定 d2（目录读取时 v2）"));
    assert.ok(reviewText.includes("方案 historical-rule-change-15（v1）项目 draft"));
    assert.ok(reviewText.includes("read_change_item") && reviewText.includes("get_change_plan"));
    assert.ok(reviewText.includes("本次只讨论核对"));
    assert.equal(await reviewInput.evaluate(el => document.activeElement === el && el.selectionStart === el.value.length), true);
    assert.ok(await reviewInput.evaluate(el => el.scrollTop > 0), "The appended review must be visible at the end of the composer");
    assert.equal(await draft.inputValue(), draftBeforeConsumers);
    assert.deepEqual(await page.evaluate(() => window.__coauthorCalls.filter(name =>
      /^(save_|run_coauthor|prepare_|commit_|apply_)/.test(name))), writesBeforeReview,
    "Bringing a review back must not save, prepare, adopt, reverse, or start a model");
    await reviewInput.evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-decision-review-composer.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "删除当前讨论", exact: true }).click();
    const deletion = page.getByRole("alertdialog", { name: "删除当前讨论", exact: true });
    await deletion.getByText(/已正式采用的内容和其他分支不变/).waitFor();
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-delete-confirmation.png`), fullPage: true });
    await deletion.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__coauthorCalls.includes("delete_discussion_session")), false);
    assert.equal(await reviewInput.inputValue(), reviewText);
    await page.getByRole("button", { name: "删除当前讨论", exact: true }).click();
    await deletion.getByRole("button", { name: "删除讨论", exact: true }).click();
    await page.getByRole("heading", { name: "从一个想法开始", exact: true }).waitFor();
    assert.equal(await page.getByLabel("当前讨论", { exact: true }).inputValue(), "");
    assert.equal(await page.evaluate(() => localStorage.getItem("coauthor-input:p1:s1")), null);
    await page.screenshot({ path: resolve(artifacts, `${viewport.width}-deleted.png`), fullPage: true });
    reports.push({ viewport, overflow, panelOverflow, boxes, commands: await page.evaluate(() => window.__coauthorCalls) });
    await context.close();
  }
  assert.deepEqual(errors, [], "No browser application errors");
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify({ mode: "mock-ipc-no-cloud", reports, errors }, null, 2));
  console.log(`Coauthor browser smoke passed, widths: ${selectedViewports.map(viewport => viewport.width).join(", ")}. Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
