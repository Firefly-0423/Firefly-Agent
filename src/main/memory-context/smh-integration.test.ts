import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {createSmhFixture} from "./smh-fixture.test-support";
import {createMainSRuntimePort} from "./main-s-runtime-port";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainResponsesBinding,createMainResponsesLimits,type ResponsesSdkClient} from "./main-responses-binding";
import {createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import {createMainFactSelector} from "../memory-recall/main-fact-selector";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createTranscriptSink} from "../orchestrator/transcript-sink";
import {classifySAssistantSettlement} from "../orchestrator/conversation-transcript-settlement";
import {setVendorRuntimeSettingsGetter} from "../orchestrator/vendors/runtime-settings";
import {createMainHistoryProvider,validateHistoryEvidence} from "../memory-history/main-history";
import type {HistoryDocument} from "../memory-history/history-contracts";
import {parseFireflyHistoryBytes} from "../memory-history/firefly-history-reader";

vi.mock('../rag/index',()=>({searchHistoryEntries:vi.fn(()=>{throw Error('LEGACY_FALLBACK_FORBIDDEN')}),addMemory:vi.fn(()=>{throw Error('LEGACY_FALLBACK_FORBIDDEN')}),isUserMemoryVectorStoreReady:()=>true}));
vi.mock('../orchestrator/tools/registry/tool-registry',()=>({toolRegistry:{register:vi.fn()}}));
vi.mock('../orchestrator/tools/built-in-tools',()=>({currentUserTimezone:()=> 'Etc/UTC'}));
vi.mock('../locale-context',()=>({getDateLocale:()=> 'en'}));
vi.mock("electron",()=>({app:{getPath:()=>{throw Error("PRODUCT_DATA_FORBIDDEN")}}}));
const roots:string[]=[],fixtures:ReturnType<typeof createSmhFixture>[]=[];
let preparedFixture:{root:string;fixture:ReturnType<typeof createSmhFixture>;clock:{now:number}};
beforeEach(()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"firefly-smh-integrate-"));roots.push(root);
 const clock={now:1700000000000},fixture=createSmhFixture(root,{clock:()=>clock.now});
 fixtures.push(fixture);preparedFixture={root,fixture,clock};
});
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0))f.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});setVendorRuntimeSettingsGetter(()=>({}))});
async function fixture(options:{queryText?:string;unknownTime?:boolean;trust?:"history"|"imported"|"model";history?:"source"|"tool"}={}){
 const {root,fixture:f,clock}=preparedFixture,now=clock.now;setVendorRuntimeSettingsGetter(()=>({}));
 const coordinator=createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy}),selector=createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall});
 const prior=await f.source("I prefer PowerShell",{sessionId:"session-b",occurredAt:now}),actorB=f.actorAuthority.bindActor(f.access,f.adapter,prior.id);
 await coordinator.onCommittedUserSource(actorB,prior.ref);
 const queryText=options.queryText??"Give me a terminal command",query=await f.source(queryText,{messageId:"u1",...(options.unknownTime?{}:{occurredAt:now}),...(options.trust?{trust:options.trust}:{})});
 const store=new ConversationTranscriptStore(path.join(root,"canonical"));await store.append("session-a",{kind:"user",id:"u1",turnId:"u1",revision:1,at:now,payload:{text:queryText}});
 const observerRegistration=vi.spyOn(store,"observeMutations"),counts:any[]=[],sends:any[]=[],events:any[]=[];let hook:undefined|(()=>Promise<void>),onStream:undefined|(()=>Promise<void>),onMutation:undefined|(()=>Promise<void>);
 const historySource=options.history?await f.source("terminal quartz command history",{sessionId:"session-b",trust:"history"}):undefined;
 let historyDocument:HistoryDocument|undefined,historyCapture:Awaited<ReturnType<typeof f.history.captureTranscript>>|undefined;
 if(historySource){
  if(options.history==="tool"){
   historyDocument={id:"history-tools",incarnation:"synthetic-history",revision:1,origin:"canonical",vector:null,sourceDeps:[{sourceRef:historySource.ref,subjectKeys:null,derivedRefs:null}],messages:[
    {id:"history-user",role:"user",text:"terminal quartz command history",occurredAt:null,timeZone:null,sourceRef:historySource.ref},
    {id:"history-assistant",role:"assistant",text:"terminal quartz tool call",occurredAt:1700000000000,timeZone:"Etc/UTC",toolCallIds:["history-call"],toolCalls:[{id:"history-call",name:"run_command",arguments:'{"command":"Get-ChildItem","path":"E:/synthetic"}'}]},
    {id:"history-tool",role:"tool",text:"quartz tool result: synthetic.txt",occurredAt:1700000000001,timeZone:"Etc/UTC",toolCallId:"history-call",name:"run_command"}
   ]};
   const provider=createMainHistoryProvider(f.actorAuthority,actorB,{withLease:async(_locator,run)=>run(async()=>structuredClone(historyDocument!))});
   historyCapture=await f.history.captureTranscript(actorB,provider,"history-tools");
  }else await f.history.captureSource(actorB,historySource.ref,{documentId:"history-source",incarnation:"synthetic-history",revision:1});
 }
 const historyScope=historySource?f.history.grantSessions(f.actor,[actorB]):undefined;
 let historyQuery=async(capture:{userTurnId:string;userRevision:number;userText:string},signal?:AbortSignal)=>[(await f.history.query(f.actor,{query:capture.userText,scope:historyScope,signal})).evidence];
 const item={id:"out",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"ok",annotations:[]}]};
 const wire=[{type:"response.created",response:{id:"r",status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},{type:"response.content_part.added",item_id:"out",output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",item_id:"out",output_index:0,content_index:0,delta:"ok"},{type:"response.output_text.done",item_id:"out",output_index:0,content_index:0,text:"ok"},{type:"response.content_part.done",item_id:"out",output_index:0,content_index:0,part:item.content[0]},{type:"response.output_item.done",output_index:0,item},{type:"response.completed",response:{id:"r",status:"completed",output:[item]}}].map((event,sequence_number)=>({...event,sequence_number}));
 const client={baseURL:"https://api.openai.com/v1",maxRetries:0,logLevel:"off",logger:{},fetch:()=>{throw Error("NETWORK_FORBIDDEN")},responses:{inputTokens:{count:async(body:any)=>{counts.push(body);await hook?.();return {object:"response.input_tokens",input_tokens:40}}},create:async(body:any)=>{sends.push(body);return {controller:new AbortController(),async *[Symbol.asyncIterator](){await onStream?.();yield* wire}}}}} as unknown as ResponsesSdkClient;
 Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 const binding=createMainResponsesBinding({enabled:true,client,limits:createMainResponsesLimits({model:"fixture-model",limitsSource:"fixture://sm",modelMaxOutputTokens:512,budget:{maxContextTokens:20000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}),configuration:()=>({revision:1,config:{provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",explicitTransport:"responses"}})})!;
 const sink=createTranscriptSink({store,conversationId:"session-a",runId:"run",assistantTurnId:"a1"});
 const port=createMainSRuntimePort({enabled:true,clock:()=>clock.now,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding,
  facts:{currentUserSource:async()=>query.ref,coordinator,selector,limits:{maxFacts:8}},
  ...(historySource?{history:{query:(capture:{userTurnId:string;userRevision:number;userText:string},signal?:AbortSignal)=>historyQuery(capture,signal)}}:{}),
  createTranscript:context=>createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor,beforeMutation:async()=>{await onMutation?.()}})!})!;
 const input={request:{model:"fixture-model",messages:[{role:"system" as const,content:"fixed"}],stream:true,maxTokens:128},stream:{conversationId:"session-a",runId:"run",assistantTurnId:"a1",userTurnId:"u1",sink,isCurrent:()=>true,onEvent:(event:unknown)=>events.push(event)}};
 return {...f,port,store,input,counts,sends,events,prior,query,actorB,observerRegistration,historySource,historyCapture,setHistoryDocument:(value:HistoryDocument)=>{historyDocument=value},setHistoryQuery:(value:typeof historyQuery)=>{historyQuery=value},beforeMutation:(value:typeof onMutation)=>{onMutation=value},setCountHook:(value:typeof hook)=>{hook=value},onStream:(value:typeof onStream)=>{onStream=value},advance:(ms:number)=>{clock.now+=ms}};
}
it("cross-session M selection is included in the exact counted request and S durably settles once",async()=>{
 const f=await fixture();expect(await f.policy.recall(f.actor)).toHaveLength(1);
 await f.port.run(f.input);expect(f.sends).toHaveLength(1);
 const instructions=f.sends[0].instructions,memory=f.sends[0].input.find((message:any)=>message.role==="user"&&JSON.stringify(message).includes("User-stated memory with source and time metadata"));
 expect(memory).toBeDefined();for(const value of ["PowerShell","user-statement","session-b","validFrom"])expect(JSON.stringify(memory)).toContain(value);
 expect(instructions).not.toContain("PowerShell");expect(instructions).toContain("untrusted historical user data");
 expect(f.counts.findLast(body=>body.instructions===instructions)?.input).toBe(f.sends[0].input);
 const raw=(await f.store.read("session-a")).entries;expect(classifySAssistantSettlement(raw,raw.find(e=>e.kind==="assistant")!.id)).toBe("success");
 const metadata=await f.recall.metadata(f.actor,[{factId:(await f.policy.recall(f.actor))[0].factId,revision:1}]);expect(metadata.targets[0].accessCount).toBe(1);
});
it("forget while the exact request is counted blocks the sole sender",async()=>{
 const f=await fixture(),fact=(await f.policy.recall(f.actor))[0];let changed=false;
 f.setCountHook(async()=>{if(changed)return;changed=true;await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:"forget-sm",factId:fact.factId,revision:fact.revision}))});
 await expect(f.port.run(f.input)).rejects.toThrow();expect(f.sends).toHaveLength(0);
});
it("archiving selected M during the response cannot cross the success guard",async()=>{
 const f=await fixture(),fact=(await f.policy.recall(f.actor))[0];
 let archived=false;f.onStream(async()=>{await f.recall.apply(f.actor,await f.recall.preview(f.actor,[{factId:fact.factId,revision:fact.revision}],"archive"));archived=true});
 await expect(f.port.run(f.input)).rejects.toThrow();expect(archived).toBe(true);expect(f.sends).toHaveLength(1);expect((await f.store.read("session-a")).entries.some(e=>e.kind==="assistant")).toBe(false);
});
it("external edits to a historical support during counting are reread without widening current-session ingress",async()=>{
 const f=await fixture();let edited=false;
 f.setCountHook(async()=>{if(edited)return;edited=true;f.write(f.prior.id,{text:"I prefer cmd",role:"user",trust:"direct-user-event",occurredAt:1700000000000})});
 await expect(f.port.run(f.input)).rejects.toThrow("MEMORY_SOURCE_STALE");expect(f.sends).toHaveLength(0);
});
it("archived M queued during pending S append produces interrupted audit and no success",async()=>{
 const f=await fixture(),fact=(await f.policy.recall(f.actor))[0];
 let started!:()=>void,release!:()=>void;const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r}),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}return (append as any)(...args)});
 const run=f.port.run(f.input),failed=expect(run).rejects.toThrow();await start;
 const archive=f.recall.preview(f.actor,[{factId:fact.factId,revision:fact.revision}],"archive").then(preview=>f.recall.apply(f.actor,preview));release();await Promise.all([archive,failed]);
 const raw=(await f.store.read("session-a")).entries;expect(classifySAssistantSettlement(raw,raw.find(e=>e.kind==="assistant")!.id)).toBe("interrupted");
 expect(f.events.some((event:any)=>event.type==="text_message_end")).toBe(false);
});
it.each(["history","imported","model"] as const)("%s current source never becomes M ingress even when raw user text matches",async trust=>{
 const f=await fixture({trust});await expect(f.port.run(f.input)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");
 expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0);expect(await f.policy.recall(f.actor)).toHaveLength(1);
});
it("unknown source event time remains a candidate instead of borrowing the S transcript clock",async()=>{
 const f=await fixture({queryText:"I prefer Bash",unknownTime:true});await f.port.run(f.input);
 const facts=await f.policy.recall(f.actor);expect(facts).toHaveLength(1);expect(facts[0].assertion).toContain("PowerShell");
 const memory=f.sends[0].input.find((message:any)=>message.role==="user"&&JSON.stringify(message).includes("User-stated memory with source and time metadata"));
 expect(memory).toBeDefined();expect(JSON.stringify(memory)).not.toContain("I prefer Bash");
});
it("explicit synthetic H evidence and complete tool quotes share the exact M/S counted frame",async()=>{
 const f=await fixture({history:"tool"});await f.port.run(f.input);
 const sent=f.sends[0],quoted=sent.input.find((message:any)=>JSON.stringify(message).includes("quoted historical evidence"));
 expect(quoted).toBeDefined();const text=JSON.stringify(quoted);
 for(const value of ["originalRole","history-user","history-assistant","history-tool","history-call","run_command","Get-ChildItem","synthetic.txt","session-b",'eventTime\\":null'])expect(text).toContain(value);
 const memory=sent.input.find((message:any)=>message.role==="user"&&JSON.stringify(message).includes("User-stated memory with source and time metadata"));
 expect(memory).toBeDefined();expect(JSON.stringify(memory)).toContain("PowerShell");expect(sent.instructions).not.toContain("PowerShell");
 expect(f.counts.some(body=>body.input===sent.input&&body.instructions===sent.instructions)).toBe(true);expect(f.sends).toHaveLength(1);
 const facts=await f.policy.recall(f.actor);expect(facts).toHaveLength(1);expect((await f.recall.metadata(f.actor,[{factId:facts[0].factId,revision:facts[0].revision}])).targets[0].accessCount).toBe(1);
});
it("history default scope excludes other sessions and copied evidence cannot supply authority",async()=>{
 const f=await fixture({history:"source"});expect((await f.history.query(f.actor,{query:"quartz"})).hits).toEqual([]);
 f.setHistoryQuery(async()=>[{}]);await expect(f.port.run(f.input)).rejects.toThrow("MEMORY_HISTORY_EVIDENCE_DENIED");expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0);
});
it("an external H source edit during counting blocks claim and sender",async()=>{
 const f=await fixture({history:"source"});let changed=false;
 f.setCountHook(async()=>{if(changed)return;changed=true;f.write(f.historySource!.id,{text:"changed terminal history",role:"user",trust:"history"})});
 await expect(f.port.run(f.input)).rejects.toThrow("MEMORY_SOURCE_STALE");expect(f.sends).toHaveLength(0);
});
it("removing selected H during the response prevents a successful assistant write",async()=>{
 const f=await fixture({history:"source"});f.onStream(async()=>{await f.history.remove(f.actorB,{documentId:"history-source",revision:1})});
 await expect(f.port.run(f.input)).rejects.toThrow();expect(f.sends).toHaveLength(1);expect((await f.store.read("session-a")).entries.some(e=>e.kind==="assistant")).toBe(false);
});
it("the single controlled mutation fanout invalidates H before pending S can settle success",async()=>{
 const f=await fixture({history:"tool"});let fanout=0;
 f.beforeMutation(async()=>{if(fanout++===0)await f.history.prepareTranscriptChange(f.actorB,f.historyCapture!.transcriptToken)});
 await expect(f.port.run(f.input)).rejects.toThrow();expect(fanout).toBeGreaterThan(0);
 expect(f.observerRegistration).toHaveBeenCalledTimes(1);
 const raw=(await f.store.read("session-a")).entries;expect(raw.some(e=>e.kind==="assistant_settlement"&&e.payload.result==="success")).toBe(false);expect(f.events.some((e:any)=>e.type==="text_message_end")).toBe(false);
});
it("external synthetic H transcript digest changes invalidate old opaque evidence",async()=>{
 const f=await fixture({history:"tool"}),scope=f.history.grantSessions(f.actor,[f.actorB]),evidence=(await f.history.query(f.actor,{query:"quartz",scope})).evidence;
 f.setHistoryDocument({id:"history-tools",incarnation:"synthetic-history",revision:2,origin:"canonical",vector:null,sourceDeps:[{sourceRef:f.historySource!.ref,subjectKeys:null,derivedRefs:null}],messages:[{id:"history-user",role:"user",text:"replaced terminal quartz history",occurredAt:null,timeZone:null,sourceRef:f.historySource!.ref}]});
 await expect(validateHistoryEvidence(f.actorAuthority,f.actor,evidence)).rejects.toThrow("MEMORY_HISTORY_STALE");
 f.setHistoryQuery(async()=>[evidence]);
 await expect(f.port.run(f.input)).rejects.toThrow();expect(f.sends).toHaveLength(0);
});
it("H removal queued during pending S append preserves raw text as interrupted audit",async()=>{
 const f=await fixture({history:"source"});let started!:()=>void,release!:()=>void;
 const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r}),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}return (append as any)(...args)});
 const run=f.port.run(f.input),failed=expect(run).rejects.toThrow();await start;
 const removal=f.history.remove(f.actorB,{documentId:"history-source",revision:1});release();await Promise.all([removal,failed]);
 const raw=(await f.store.read("session-a")).entries,assistant=raw.find(e=>e.kind==="assistant")!;expect(assistant.payload.content).toBe("ok");expect(classifySAssistantSettlement(raw,assistant.id)).toBe("interrupted");
 expect(f.events.some((e:any)=>e.type==="text_message_end")).toBe(false);
});
it("forget blocks selected H derived from the same fact source and cannot revive it by query",async()=>{
 const f=await fixture({history:"source"}),fact=(await f.policy.recall(f.actor))[0],scope=f.history.grantSessions(f.actor,[f.actorB]);
 await f.history.captureSource(f.actorB,f.prior.ref,{documentId:"m-root-history",incarnation:"synthetic-history",revision:1});
 const old=(await f.history.query(f.actor,{query:"PowerShell",scope})).evidence;f.setHistoryQuery(async()=>[old]);let forgotten=false;
 f.setCountHook(async()=>{if(forgotten)return;forgotten=true;await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:"forget-smh",factId:fact.factId,revision:fact.revision}))});
 await expect(f.port.run(f.input)).rejects.toThrow();expect(f.sends).toHaveLength(0);expect((await f.history.query(f.actor,{query:"PowerShell",scope})).hits).toEqual([]);expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("supplied-byte S pending text remains diagnostic and never enters H evidence or M",async()=>{
 const f=await fixture({history:"source"}),a=f.actorAuthority.requireActor(f.actorB),entries=[
  {id:"history-user",seq:1,at:1700000000000,turnId:"history-user",revision:1,kind:"user",payload:{text:"terminal quartz command history"}},
  {id:"history-run:assistant:s-response",seq:2,at:1700000000001,turnId:"history-assistant",runId:"history-run",roundId:"s-response",kind:"assistant",sSettlement:{version:1,userTurnId:"history-user",userRevision:1},payload:{role:"assistant",content:"PENDING_AUDIT_ONLY"}}
 ];
 const parsed=parseFireflyHistoryBytes({root:f.root,actorKey:a.actorKey,scopeKey:a.scopeKey,sessions:[{providerId:a.providerId,sessionId:a.sessionId}]},[{providerId:a.providerId,sessionId:a.sessionId,incarnation:"synthetic-bytes",transcript:Buffer.from(entries.map(e=>JSON.stringify(e)).join("\n")+"\n"),snapshot:null,chat:null}]);
 expect(parsed.diagnostics).toContain("MEMORY_HISTORY_S_UNSETTLED");expect(parsed.documents.find(r=>r.classification==="unverified")!.document.messages[0].text).toBe("PENDING_AUDIT_ONLY");
 const boundSource=await f.source("terminal quartz command history",{sessionId:a.sessionId,messageId:"history-user",trust:"history",occurredAt:1700000000000});
 for(const record of parsed.documents.filter(r=>r.classification==="raw-history")){
  const doc:HistoryDocument={...record.document,sourceDeps:[{sourceRef:boundSource.ref,subjectKeys:null,derivedRefs:null}],messages:record.document.messages.map(m=>({...m,sourceRef:boundSource.ref}))};
  const provider=createMainHistoryProvider(f.actorAuthority,f.actorB,{withLease:async(_locator,run)=>run(async()=>structuredClone(doc))});await f.history.captureTranscript(f.actorB,provider,doc.id);
 }
 await f.port.run(f.input);const sent=JSON.stringify(f.sends[0]);expect(sent).toContain("history-user");expect(sent).not.toContain("PENDING_AUDIT_ONLY");expect(await f.policy.recall(f.actor)).toHaveLength(1);
});

it("native H joins S and M through one observer and coverage never invokes legacy RAG",async()=>{
 const {initializeStorageContext}=await import('../storage-context'),{resolveRuntimeProfile}=await import('../runtime-profile'),{createNativeHistoryProvider}=await import('../memory-sources/native-history-provider');
 const isolation=fs.mkdtempSync(path.join(os.tmpdir(),'smh-native-joint-'));roots.push(isolation);
 const storage=initializeStorageContext(resolveRuntimeProfile({argv:['--firefly-profile=test','--firefly-isolation-root='+isolation],env:{},isPackaged:false,productionAppData:path.join(os.tmpdir(),'synthetic-production-never-used')}));
 const f=createSmhFixture(path.join(isolation,'index'));fixtures.push(f);const store=new ConversationTranscriptStore(storage.dataRoot);
 await store.append('session-a',{id:'native-user',kind:'user',turnId:'native-turn',revision:1,at:1000,payload:{text:'harbor original coffee'}});await store.checkpoint('session-a');
 const nativeSource=await f.source('harbor original coffee',{messageId:'native-turn',occurredAt:1000});
 await f.context.recordHistoryUser(f.actor,nativeSource.ref,(await store.read('session-a')).entries[0]);
 let nativeReads=0;
 const native=createNativeHistoryProvider({actorAuthority:f.actorAuthority,actorToken:f.actor,store,history:f.history,deadlineMs:20000,endpointFactory:async()=>({rootIdentity:{volumeSerial:42,fileIndex:'1111111111111111'},async read(components,maxBytes){nativeReads++;const target=path.join(storage.dataRoot,'transcripts',...components);if(!fs.existsSync(target))throw Error('history-leaf-missing');const bytes=fs.readFileSync(target);if(bytes.length>maxBytes)throw Error('history-invalid-budget');return {identity:{volumeSerial:42,fileIndex:components[1]==='snapshot.json'?'bbbbbbbbbbbbbbbb':'aaaaaaaaaaaaaaaa'},bytes}},assertLive(){},async dispose(){}})});
 const observer=vi.spyOn(store,'observeMutations');const adapter=createConversationTranscriptAdapter({enabled:true,store,actorAuthority:f.actorAuthority,actorToken:f.actor,context:f.context,beforeMutation:(kind,entry)=>native.beforeMutation(kind,entry)})!;
 await native.capture();const query=await native.query({query:'harbor'});if(query.status!=='queried')throw Error('expected evidence');
 const direct=await f.source('I prefer PowerShell',{occurredAt:1700000000000}),coordinator=createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy});await coordinator.onCommittedUserSource(f.actor,direct.ref);
 const facts=await f.policy.recall(f.actor);expect(facts).toHaveLength(1);expect(facts[0].assertion).toContain('PowerShell');
 const current=await adapter.capture(),assembled=await f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[],transcriptTokens:[current],historyTokens:[query.result.evidence]});
 expect(JSON.stringify(assembled.request.body)).toContain('harbor original coffee');expect(observer).toHaveBeenCalledTimes(1);
 await store.append('session-a',{id:'native-next',kind:'user',turnId:'native-next',revision:1,payload:{text:'harbor next'},at:2000});
 const nextSource=await f.source('harbor next',{messageId:'native-next',occurredAt:2000});
 await f.context.recordHistoryUser(f.actor,nextSource.ref,(await store.read('session-a')).entries.at(-1)!);
 await expect(validateHistoryEvidence(f.actorAuthority,f.actor,query.result.evidence)).rejects.toThrow();expect(await native.query({query:'harbor'})).toMatchObject({reason:'not-acquired'});
 await store.checkpoint('session-a');await native.capture();fs.unlinkSync(path.join(storage.dataRoot,'transcripts','session-a','snapshot.json'));
 const legacy=await import('../orchestrator/tools/history-tools'),rag=await import('../rag/index'),{toolRegistry}=await import('../orchestrator/tools/registry/tool-registry');
 legacy.registerRecallHistoryTool();const recallTool=vi.mocked(toolRegistry.register).mock.calls.at(-1)![0];
 const fallback={recall_history:vi.spyOn(recallTool,'execute').mockImplementation(async()=>{throw Error('LEGACY_FALLBACK_FORBIDDEN')}),searchHistoryEntries:vi.mocked(rag.searchHistoryEntries),indexConversationTurn:vi.spyOn(legacy,'indexConversationTurn').mockImplementation(async()=>{throw Error('LEGACY_FALLBACK_FORBIDDEN')})};
 const outcome=await native.query({query:'harbor'});expect(outcome).toMatchObject({status:'coverage-insufficient',reason:'snapshot-missing'});expect(outcome).not.toHaveProperty('result');for(const spy of Object.values(fallback))expect(spy).not.toHaveBeenCalled();expect(await f.policy.recall(f.actor)).toHaveLength(1);
 await native.invalidate('forget');await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'forget',nonce:'native-forget',factId:facts[0].factId,revision:facts[0].revision}));
 const readsBeforeForgetCapture=nativeReads,missing=await native.capture();
 expect(missing).toMatchObject({status:'coverage-insufficient',reason:'snapshot-missing'});expect(missing).not.toHaveProperty('result');
 expect(nativeReads).toBeGreaterThan(readsBeforeForgetCapture);expect(await f.policy.recall(f.actor)).toEqual([]);
 await store.checkpoint('session-a');await native.capture();
 const recovered=await native.query({query:'harbor'});expect(recovered.status).toBe('queried');
 if(recovered.status==='queried')expect(JSON.stringify(recovered.result.hits)).toContain('harbor original coffee');
 for(const spy of Object.values(fallback))expect(spy).not.toHaveBeenCalled();
 await adapter.close();await native.close();
});
