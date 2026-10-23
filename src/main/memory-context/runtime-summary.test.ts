import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainContext} from "./main-context";
import {RecordCodec} from "../memory-core/record-codec";
import {prepareRuntimeSummary} from "./runtime-summary";
import {createDefaultRunCapture} from "./default-run-capture";
import {createTranscriptSink} from "../orchestrator/transcript-sink";
import {createMainMemoryRuntime} from "./main-memory-runtime";
import {createMemoryRunAuthority} from "./main-memory-contracts";
import {createMemorySessionModes} from "./memory-session-modes";
import {resolveMemoryCounter} from "./model-counting";
import {OpenAICompatAdapter} from "../orchestrator/vendors/openai-adapter";
import type {VendorConfig,ProviderCapability} from "../orchestrator/vendors/types";

vi.mock("electron",()=>({app:{getPath:()=>{throw Error("PRODUCT_DATA_READ_FORBIDDEN")}}}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
let preparedFixture:Awaited<ReturnType<typeof contextFixture>>;
beforeEach(async()=>{preparedFixture=await contextFixture()});

async function fixture(estimated=false){
 const f=preparedFixture,store=new ConversationTranscriptStore(path.join(f.root,"conversation"));
 const options:any=f.options;
 options.budget.maxSTokens=1500;
 if(estimated){
  const identity={providerId:"openrouter",model:"openai/gpt-6-luna",transport:"responses",framingVersion:"bounded-fixture-v1"};
  options.counter.capability={...identity,mode:"estimate",inputTypes:["text"]};options.budget.admissionMode="bounded";
  for(const name of ["prepare","prepareS"]){const prepare=options[name];options[name]=(...args:any[])=>({...prepare(...args),...identity})}
 }
 const context=createMainContext(options),user=(id:string,text:string)=>store.append("session-a",{id,at:1000+Number(id.slice(1)),kind:"user",turnId:id,revision:1,payload:{text}});
 await user("u1","OLD_TRANSCRIPT_CANARY ".repeat(150));
 await user("u2","current complete turn 🌱");
 await store.append("session-a",{id:"a2",at:1100,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:[{id:"call",name:"read_file",arguments:'{"path":"fixture.txt"}'}]}});
 await store.append("session-a",{id:"t2",at:1101,kind:"tool_result",payload:{assistantEntryId:"a2",toolCallId:"call",outcome:"success",message:{role:"tool",toolCallId:"call",name:"read_file",content:"RESULT_CANARY"}}});
 const adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
 const turns=await adapter.captureTurns();
 const summarize=(signal?:AbortSignal)=>prepareRuntimeSummary(context,f.actor,{sessionId:"session-a",transcriptTokens:turns,summaryIds:[],leaseMs:60000},signal);
 const assemble=(tokens:object[]=turns,summaryIds:string[]=[])=>context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:tokens,summaryIds});
 const summaries=()=>{const db=new DatabaseSync(f.databasePath,{readOnly:true});try{return Number(db.prepare("SELECT count(*) n FROM context_records WHERE kind='summary'").get()!.n)}finally{db.close()}};
 return {...f,context,store,user,adapter,turns,summarize,assemble,summaries};
}
it("summary_is_used_by_next_request without splitting the canonical tool pair or promoting model text",async()=>{
 const f=await fixture(),receipt=await f.summarize();expect(receipt.status).toBe("committed");
 expect(receipt.counting).toMatchObject({mode:"exact",framingVersion:"v1"});
 const snapshot=await f.assemble(f.turns,[receipt.summaryId!]);
 expect((snapshot.request.body.messages as any[]).map(m=>m.role)).toEqual(["user","assistant","tool"]);
 expect(snapshot.request.body.messages[2]).toMatchObject({text:"RESULT_CANARY",toolCallId:"call"});
 expect(JSON.stringify(snapshot.request)).not.toContain("OLD_TRANSCRIPT_CANARY");expect(await f.policy.recall(f.actor)).toEqual([]);
 const db=new DatabaseSync(f.databasePath,{readOnly:true});try{
  const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(receipt.summaryId!)!;
  expect(Buffer.from(row.payload as Uint8Array).toString()).not.toContain("RESULT_CANARY");
  const saved=new RecordCodec(f.key).open<any>("context-summary","scope-a",receipt.summaryId!,row.payload);
  expect(saved.transcriptRefs).toHaveLength(2);expect(saved.transcriptSegments).toHaveLength(1);expect(saved.counting).toEqual(receipt.counting);
  expect(JSON.stringify(saved)).not.toContain("RESULT_CANARY");
 }finally{db.close()}
});
it("estimated_summary_stays_estimated in the Worker receipt, stored record, and next assembled request",async()=>{
 const f=await fixture(true),receipt=await f.summarize();expect(receipt.status).toBe("committed");
 expect(receipt.counting).toMatchObject({mode:"estimate",framingVersion:"bounded-fixture-v1"});
 expect(receipt.counting).not.toHaveProperty("beforeTokens");expect(receipt.counting).not.toHaveProperty("afterTokens");
 if(receipt.counting?.mode!=="estimate")throw new Error("Expected an estimate receipt");
 expect(receipt.counting.estimatedBeforeTokens).toBeGreaterThan(receipt.counting.estimatedAfterTokens);
 const command=(f.commands as any[]).find(c=>c.kind==="summaryCommit");expect(command.body).not.toHaveProperty("beforeTokens");expect(command.body).not.toHaveProperty("afterTokens");
 const snapshot=await f.assemble(f.turns,[receipt.summaryId!]);expect(snapshot.admissionMode).toBe("bounded");expect(snapshot).not.toHaveProperty("sTokens");
 const db=new DatabaseSync(f.databasePath,{readOnly:true});try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(receipt.summaryId!)!;const saved=new RecordCodec(f.key).open<any>("context-summary","scope-a",receipt.summaryId!,row.payload);expect(saved.counting).toEqual(receipt.counting);expect(saved.counting).not.toHaveProperty("beforeTokens");expect(saved.counting).not.toHaveProperty("afterTokens")}finally{db.close()}
});
it("no_benefit_keeps_original_units and leaves the canonical store unchanged",async()=>{
 const f=await fixture();f.options.budget.maxSTokens=20000;const before=await f.store.read("session-a"),snapshot=await f.assemble();
 expect(await f.summarize()).toMatchObject({status:"no-benefit",summaryId:null,counting:{mode:"exact"}});
 expect(f.summaries()).toBe(0);expect(await f.store.read("session-a")).toEqual(before);expect((await f.assemble()).request.body.messages).toEqual(snapshot.request.body.messages);
});
it.each(["edit","delete","cancel"] as const)("%s during runtime summary counting rejects the lease with zero summary writes",async kind=>{
 const f=await fixture(),controller=new AbortController();let changed=false;
 f.setCountHook(async()=>{if(changed)return;changed=true;
  if(kind==="cancel")controller.abort();
  else if(kind==="delete")await f.store.deleteConversation("session-a");
  else await f.store.append("session-a",{id:"edit-u1",at:2000,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited"}}});
 });
 await expect(f.summarize(controller.signal)).rejects.toThrow(kind==="cancel"?"MEMORY_CONTEXT_CANCELLED":/MEMORY_CONTEXT_TRANSCRIPT_(PENDING|STALE|READ_FAILED|DELETED)/);
 expect(f.summaries()).toBe(0);
});
it("cancel before preparing writes no summary lease",async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();const before=f.commands.length;
 await expect(f.summarize(controller.signal)).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");expect(f.commands.slice(before)).toEqual([]);
});
it("a temporary actor cannot persist a runtime summary",async()=>{
 const f=await fixture(),actor=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),before=f.commands.length;
 await expect(prepareRuntimeSummary(f.context,actor,{sessionId:"session-a",transcriptTokens:f.turns,summaryIds:[],leaseMs:60000})).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 expect(f.commands.slice(before)).toEqual([]);expect(f.summaries()).toBe(0);
});
it("restart requires fresh canonical source verification before using a persisted summary",async()=>{
 const f=await fixture(),receipt=await f.summarize();f.reopen();
 const fresh=createMainContext(f.options),withoutSources=await fresh.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],summaryIds:[receipt.summaryId!]});
 expect(withoutSources.excluded).toContainEqual({sourceId:receipt.summaryId,reason:"MEMORY_CONTEXT_TRANSCRIPT_DENIED"});
 const reopenedStore=new ConversationTranscriptStore(path.join(f.root,"conversation"));
 const adapter=createConversationTranscriptAdapter({enabled:true,store:reopenedStore,context:fresh,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
 const turns=await adapter.captureTurns(),verified=await fresh.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:turns,summaryIds:[receipt.summaryId!]});
 expect(verified.excluded).toContainEqual({sourceId:receipt.summaryId,reason:"MEMORY_CONTEXT_TRANSCRIPT_STALE"});
 const renewed=await prepareRuntimeSummary(fresh,f.actor,{sessionId:"session-a",transcriptTokens:turns,summaryIds:[],leaseMs:60000});
 expect(renewed.status).toBe("committed");expect(renewed.summaryId).not.toBe(receipt.summaryId);
 expect((await fresh.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:turns,summaryIds:[renewed.summaryId!]})).excluded).toEqual([]);
 await reopenedStore.append("session-a",{id:"edit-u1",at:2000,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited old input"}}});
 const changed=await adapter.captureTurns(),stale=await fresh.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:changed,summaryIds:[receipt.summaryId!]});
 expect(stale.excluded).toContainEqual(expect.objectContaining({sourceId:receipt.summaryId}));
});

it("cancellation during preparation prevents creating a summary lease",async()=>{
 const f=await fixture(),controller=new AbortController(),command=f.transport.contextCommand;
 f.transport.contextCommand=async input=>{const result=await command(input);if(input.kind==="baseline")controller.abort();return result};
 const before=f.commands.length;await expect(f.summarize(controller.signal)).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
 expect(f.commands.slice(before).some((c:any)=>c.kind==="summaryLease")).toBe(false);expect(f.summaries()).toBe(0);
});
it.each(["edit","delete","cancel"] as const)("%s during final runtime summary commit counting rejects the lease",async kind=>{
 const f=await fixture(),controller=new AbortController();let counts=0;
 f.setCountHook(async()=>{if(++counts!==3)return;
  if(kind==="cancel")controller.abort();
  else if(kind==="delete")await f.store.deleteConversation("session-a");
  else await f.store.append("session-a",{id:"edit-u1",at:2000,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited at commit"}}});
 });
 await expect(f.summarize(controller.signal)).rejects.toThrow(kind==="cancel"?"MEMORY_CONTEXT_CANCELLED":/^MEMORY_CONTEXT_/);
 expect(counts).toBeGreaterThanOrEqual(3);expect(f.summaries()).toBe(0);
});
it("a summary cannot discard the configured minimum complete recent turns",async()=>{
 const f=await fixture();f.options.budget.minRecentCompleteTurns=2;
 expect(await f.summarize()).toMatchObject({status:"no-benefit",summaryId:null});expect(f.summaries()).toBe(0);
});
it("a continued summary deduplicates covered canonical tokens and preserves omitted dependencies",async()=>{
 const f=await fixture(),first=await f.summarize();await f.user("u3","new turn ".repeat(200));await f.user("u4","latest complete turn");
 const tokens=await f.adapter.captureTurns(),second=await prepareRuntimeSummary(f.context,f.actor,{sessionId:"session-a",transcriptTokens:tokens,summaryIds:[first.summaryId!],leaseMs:60000});
 expect(second.status).toBe("committed");const snapshot=await f.assemble(tokens,[second.summaryId!]);
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"latest complete turn"}]);
 const db=new DatabaseSync(f.databasePath,{readOnly:true});try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(second.summaryId!)!;const saved=new RecordCodec(f.key).open<any>("context-summary","scope-a",second.summaryId!,row.payload);expect(saved.transcriptRefs).toHaveLength(4)}finally{db.close()}
});

it.each(["mixed-exact-fields","estimated-as-exact","counter-version-change"] as const)("the Worker rejects %s in a bounded summary commit",async corruption=>{
 const f=await fixture(true),command=f.transport.contextCommand;
 f.transport.contextCommand=async input=>{
  if(input.kind!=="summaryCommit")return command(input);
  const changed=structuredClone(input);
  if(corruption==="mixed-exact-fields")changed.body.beforeTokens=1;
  else if(corruption==="estimated-as-exact"){delete changed.body.admissionMode;delete changed.body.estimates;changed.body.beforeTokens=9999;changed.body.afterTokens=1}
  else changed.body.counterIdentity.framingVersion="bounded-fixture-v2";
  return command(changed);
 };
 await expect(f.summarize()).rejects.toThrow(corruption==="counter-version-change"?"MEMORY_CONTEXT_REQUEST_CHANGED":"MEMORY_CONTEXT_BUDGET_UNPROVEN");expect(f.summaries()).toBe(0);
});
it("the summary lease can expire during selection without a summary write",async()=>{
 const f=await fixture();f.setCountHook(async()=>{f.advanceClock(60001)});
 await expect(f.summarize()).rejects.toThrow("MEMORY_CONTEXT_LEASE_EXPIRED");expect(f.summaries()).toBe(0);
});
it("production runtime default capture keeps one estimated summary across two complete tool rounds",async()=>{
 const f=await contextFixture(),store=new ConversationTranscriptStore(path.join(f.root,"runtime-conversation"));
 for(const [id,text] of [["u1","old discarded history ".repeat(500)],["u2","retained historical user"],["u3","current active user"]])await store.append("session-a",{id,at:1000+Number(id.slice(1)),kind:"user",turnId:id,revision:1,payload:{text}});
 const modes=createMemorySessionModes();modes.bind("session-a","persistent");
 const authority=createMemoryRunAuthority({actors:f.actorAuthority,sessionModes:modes,resolveProfile:()=>({id:"saved-profile",revision:1}),resolveEntry:()=>({revision:1}),canRead:()=>true});
 const config:VendorConfig={provider:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",model:"openai/gpt-6-luna",apiKey:"synthetic-secret",explicitTransport:"openai"};
 const capability:ProviderCapability={id:"openrouter",displayName:"OpenRouter",baseUrl:config.baseUrl,transport:"openai",authStyle:"bearer",defaultModel:config.model,supportsTools:true,supportsThinking:true,thinkingField:"reasoning_content",cacheStrategy:"none",testStrategy:"text+tool"};
 const adapter=new OpenAICompatAdapter("openrouter",capability),baseCounter=resolveMemoryCounter(config,1),sent:string[]=[],events:string[]=[],counted:string[]=[];
 const counter={capability:baseCounter.capability,count:async(...args:Parameters<typeof baseCounter.count>)=>{counted.push(JSON.stringify(args[0].body));return baseCounter.count(...args)}};
 vi.stubGlobal("fetch",async(source:RequestInfo|URL,init?:RequestInit)=>{
  const request=new Request(source,init);sent.push(await request.text());events.push("send");
  const ids=sent.length===1?["t1","t2"]:sent.length===2?["t3"]:[];
  return Response.json({choices:[{message:{role:"assistant",content:ids.length?"checking":"offline result",...(ids.length?{tool_calls:ids.map(id=>({id,type:"function",function:{name:"lookup",arguments:"{}"}}))}:{})},finish_reason:ids.length?"tool_calls":"stop"}]});
 });
 const command=f.transport.contextCommand;f.transport.contextCommand=async input=>{events.push(input.kind);return command(input)};
 const runtime=createMainMemoryRuntime({actorAuthority:f.actorAuthority,registry:f.registry,transport:f.transport,runAuthority:authority,clock:f.options.clock,
  resolveModel:()=>({profileId:"saved-profile",revision:1,config,adapter,counter,budget:{admissionMode:"bounded",maxContextTokens:20000,reservedOutputTokens:8192,safetyMarginTokens:512,maxSTokens:1000,minRecentCompleteTurns:1},assertCurrent:()=>{}}),
  createCapture:({context,run})=>createDefaultRunCapture({context,store,actorAuthority:f.actorAuthority,actorToken:run.actorToken,registry:f.registry,
   conversationId:"session-a",runId:run.identity.runId,assistantTurnId:"assistant-turn",summary:{protectedRecentTurns:1}})});
 try{
  const grant=authority.issue({identity:{entry:"desktop",sessionId:"session-a",runId:"runtime-summary",modelProfileId:"saved-profile",sessionMode:"persistent"},actorToken:f.actor,sourceProvider:f.provider.adapter,readActorTokens:[],signal:new AbortController().signal});
  const run=await runtime.openRun(grant),sink=run.bindSink(createTranscriptSink({store,conversationId:"session-a",runId:"runtime-summary",assistantTurnId:"assistant-turn"}));
  const input=()=>({adapter,config,timeoutMs:1000,request:{model:config.model,stream:false,messages:[{role:"system" as const,content:"fixed instruction"}],tools:[{name:"lookup",description:"synthetic lookup",parameters:{type:"object",properties:{}}}]}});
  for(let index=1;index<=3;index++){
   const response=await run.call(input()),assistantEntryId=await sink.appendAssistant({message:response.assistantMessage,roundId:`r${index}`});
   for(const call of response.toolCalls)await sink.appendToolResult({assistantEntryId,message:{role:"tool",toolCallId:call.id,name:call.name,content:`result ${call.id}`},outcome:"success",roundId:`r${index}`});
  }
  expect(sent).toHaveLength(3);
  for(const body of sent){expect(body).toContain("retained historical user");expect(body).toContain("current active user");expect(body).not.toContain("old discarded history");expect(counted).toContain(body)}
  expect(sent[1]).toContain("result t1");expect(sent[1]).toContain("result t2");expect(sent[2]).toContain("result t3");
  expect(events.filter(event=>event==="summaryLease")).toHaveLength(1);expect(events.filter(event=>event==="summaryCommit")).toHaveLength(1);
  expect(events.indexOf("summaryCommit")).toBeLessThan(events.indexOf("snapshot"));expect(events.indexOf("snapshot")).toBeLessThan(events.indexOf("send"));
  const snapshots=(f.commands as any[]).filter(c=>c.kind==="snapshot");expect(snapshots).toHaveLength(3);
  const ids=snapshots.map(c=>c.body.requiredSummaries);expect(ids[0]).toHaveLength(1);expect(ids[1]).toEqual(ids[0]);expect(ids[2]).toEqual(ids[0]);
  const db=new DatabaseSync(f.databasePath,{readOnly:true});try{
   const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(ids[0][0])!,saved=new RecordCodec(f.key).open<any>("context-summary","scope-a",ids[0][0],row.payload);
   expect(saved.counting.mode).toBe("estimate");expect(saved.counting).not.toHaveProperty("beforeTokens");expect(saved.transcriptRefs).toHaveLength(2);
  }finally{db.close()}
 }finally{await runtime.close()}
});
