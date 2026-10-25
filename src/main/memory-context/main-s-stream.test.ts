import path from "node:path";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {Responses} from "openai/resources/responses/responses";
import {Stream} from "openai/core/streaming";
import fs from "node:fs";
import {buildAgentRunOptions} from "../orchestrator/build-options";
import {afterEach,expect,it,vi} from "vitest";
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createTranscriptSink} from "../orchestrator/transcript-sink";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainSRuntimePort} from "./main-s-runtime-port";
import {createMainResponsesBinding,createMainResponsesLimits,type ResponsesSdkClient} from "./main-responses-binding";
import {setVendorRuntimeSettingsGetter} from "../orchestrator/vendors/runtime-settings";
import {createAgentRuntime} from "../orchestrator/agent-runtime";
import {FireflyAgent} from "../orchestrator/firefly-agent";
import {classifySAssistantSettlement} from "../orchestrator/conversation-transcript-settlement";
import {materializeTranscript} from "../orchestrator/conversation-transcript-context";
import {createMainUserFactCoordinator} from '../memory-policy/main-user-fact-coordinator';
import {createMainFactSelector} from '../memory-recall/main-fact-selector';
import {createMainRecall} from '../memory-recall/main-recall';
import {historyOriginEvent} from '../memory-history/history-origins';

vi.mock("electron",()=>({app:{getPath:()=>{throw Error("PRODUCT_DATA_FORBIDDEN")}}}));
vi.mock("../settings/timeout-manager",()=>({getTimeoutSettings:()=>({chatRequestTimeout:0})}));
vi.mock("../orchestrator/build-options",()=>({buildAgentRunOptions:vi.fn(async()=>({options:{settings:{provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",apiKey:""},messages:[],conversationId:"session-a",executionMode:"chat",tools:[],timeoutMs:0,soulSystemBaseContent:"fixed",toolSystemContent:""},latestUserText:"synthetic user"})),onAgentRunFinished:vi.fn()}));
vi.mock("../orchestrator/chat-loop",()=>({runChatLoop:()=>{throw Error("LEGACY_CHAT_FORBIDDEN")}}));
vi.mock("../orchestrator/harness-adapter",()=>({runHarnessWithAdapter:()=>{throw Error("LEGACY_HARNESS_FORBIDDEN")}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();setVendorRuntimeSettingsGetter(()=>({}))});
const response=(text="hello world")=>({id:"resp-synthetic",status:"completed",output:[{id:"msg-synthetic",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]}]});
const normal=()=>{
 const part={type:"output_text",text:"",annotations:[]},completed=response().output[0];
 return [
 {type:"response.created",response:{id:"resp-synthetic",status:"in_progress",output:[]}},
 {type:"response.in_progress",response:{id:"resp-synthetic",status:"in_progress",output:[]}},
 {type:"response.output_item.added",output_index:0,item:{...completed,status:"in_progress",content:[]}},
 {type:"response.content_part.added",item_id:"msg-synthetic",output_index:0,content_index:0,part},
 {type:"response.output_text.delta",item_id:"msg-synthetic",output_index:0,content_index:0,delta:"hello "},
 {type:"response.output_text.delta",item_id:"msg-synthetic",output_index:0,content_index:0,delta:"world"},
 {type:"response.output_text.done",item_id:"msg-synthetic",output_index:0,content_index:0,text:"hello world"},
 {type:"response.content_part.done",item_id:"msg-synthetic",output_index:0,content_index:0,part:{...part,text:"hello world"}},
 {type:"response.output_item.done",output_index:0,item:completed},
 {type:"response.completed",response:response()}
 ].map((event,sequence_number)=>({...event,sequence_number}));
};
async function fixture(actualSdk=false,withFacts=false){
 const f=await contextFixture();setVendorRuntimeSettingsGetter(()=>({}));vi.stubGlobal("fetch",()=>{throw Error("NETWORK_FORBIDDEN")});
 let revision=1,events:any[]=normal(),hook:undefined|((index:number)=>Promise<void>),current=true,countHook:undefined|(()=>Promise<void>),closed=0;
 const counted:Array<{body:any;options:any}>=[],sent:Array<{body:any;options:any}>=[],display:any[]=[];
 const stream={controller:new AbortController(),async *[Symbol.asyncIterator](){try{for(let i=0;i<=events.length;i++){await hook?.(i);if(i<events.length)yield events[i]}}finally{closed++}}};
 const client={baseURL:"https://api.openai.com/v1",maxRetries:0,logLevel:"off",logger:{},fetch:()=>{throw Error("NETWORK_FORBIDDEN")},responses:{inputTokens:{count:async(body:any,options:any)=>{counted.push({body,options});await countHook?.();return {object:"response.input_tokens",input_tokens:40}}},create:async(body:any,options:any)=>{sent.push({body,options});return stream}}} as unknown as ResponsesSdkClient;
 Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 if(actualSdk){
  const count=client.responses.inputTokens.count,send=client.responses.create;
  (client as any).post=(route:string,options:any)=>{
   let pending:Promise<any>;
   if(route==="/responses/input_tokens")pending=Promise.resolve(count(options.body,options));
   else if(route==="/responses")pending=Promise.resolve(send(options.body,options)).then(()=>{
    let index=0;const body=new ReadableStream<Uint8Array>({async pull(controller){const i=index++;await hook?.(i);if(i<events.length)controller.enqueue(new TextEncoder().encode('event: '+events[i].type+'\ndata: '+JSON.stringify(events[i])+'\n\n'));else controller.close()}});
    return Stream.fromSSEResponse(new Response(body,{headers:{"content-type":"text/event-stream"}}),stream.controller,client as any);
   });else throw Error("UNEXPECTED_SDK_ROUTE");
   return Object.assign(pending,{_thenUnwrap:(run:(value:any)=>any)=>pending.then(run)});
  };
  client.responses=new Responses(client as any);
 }

 const binding=createMainResponsesBinding({enabled:true,client,limits:createMainResponsesLimits({model:"fixture-model",limitsSource:"fixture://stream-limits",modelMaxOutputTokens:512,budget:{maxContextTokens:20000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}),configuration:()=>({revision,config:{provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",explicitTransport:"responses"}})})!;
 const store=new ConversationTranscriptStore(path.join(f.root,"conversation"));await store.append("session-a",{id:"u1",at:1000,kind:"user",turnId:"u1",revision:1,payload:{text:"synthetic user"}});
 let adapter:NonNullable<ReturnType<typeof createConversationTranscriptAdapter>>;
 const facts=withFacts?{currentUserSource:async()=>{const id={...f.identity,messageId:'u1'};f.provider.write(id,{text:'synthetic user',role:'user' as const,trust:'direct-user-event' as const,occurredAt:1000});return f.registry.capture(f.access,f.provider.adapter,id)},coordinator:createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy}),selector:createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:createMainRecall({actorAuthority:f.actorAuthority,transport:{...f.transport,recallCommand:async c=>f.repo.recallCommand(c)}})}),limits:{maxFacts:20}}:undefined;
 const port=createMainSRuntimePort({enabled:true,clock:f.options.clock,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding,facts,createTranscript:context=>(adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor})!)})!;
 const sink=createTranscriptSink({store,conversationId:"session-a",runId:"run-s",assistantTurnId:"assistant-s"});
 const request={model:"fixture-model",messages:[{role:"system" as const,content:"fixed"}],maxTokens:128,stream:true};
 const target={conversationId:"session-a",runId:"run-s",userTurnId:"u1",assistantTurnId:"assistant-s",sink,onEvent:(event:any)=>{display.push(event)},isCurrent:()=>current};
 const input={request,stream:target};
 const runtime=createAgentRuntime({sContext:{enabled:true,createPort:()=>port,streamRequest:()=>request}} as any);
 const assistants=async()=>((await store.read("session-a")).entries.filter(e=>e.kind==="assistant"));
 return {...f,get repo(){return f.repo},store,port,binding,closeTranscript:()=>adapter.close(),runtime,request,target,input,sink,stream,counted,sent,display,assistants,get closed(){return closed},setEvents:(value:any[])=>{events=value},setHook:(value:typeof hook)=>{hook=value},setCountHook:(value:typeof countHook)=>{countHook=value},switchRun:()=>{current=false},drift:()=>{revision++}};
}
it('persists successful S user and assistant origins after settlement and restart',async()=>{
 const f=await fixture(false,true);await f.port.run(f.input);f.reopen();
 for(const entry of (await f.store.read('session-a')).entries.filter(e=>e.kind==='user'||e.kind==='assistant'))expect(f.repo.historyCommand({kind:'originStatus',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',event:historyOriginEvent(entry)}})).toEqual({valid:true});
});
it.each([false,true])('Chat waits for the writer checkpoint and preserves canonical settlement on checkpoint failure=%s',async fail=>{
 const f=await fixture(),built=await f.runtime.buildOptions({sessionId:'session-a',userTurnId:'u1',assistantTurnId:'assistant-s',mode:'chat',messages:[]});Object.assign(built.options,{runId:'run-s',transcriptSink:f.sink,isControlledRunCurrent:f.target.isCurrent});
 let arrived!:()=>void,release!:()=>void;const started=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r),original=f.store.checkpoint.bind(f.store);
 vi.spyOn(f.store,'checkpoint').mockImplementation(async id=>{arrived();await gate;if(fail)throw Error('SYNTHETIC_CHECKPOINT_FAILED');return original(id)});
 const events:any[]=[],agent=new FireflyAgent({threadId:'checkpoint',description:'synthetic'}),outcome=new Promise<unknown>(resolve=>agent.runWithEvents(built.options).subscribe({next:e=>events.push(e),error:resolve,complete:()=>resolve('complete')}));
 await started;expect(events.some(e=>e.type==='RUN_FINISHED')).toBe(false);const before=(await f.store.read('session-a')).entries;expect(classifySAssistantSettlement(before,'run-s:assistant:s-response')).toBe('success');release();const result=await outcome;
 expect((await f.store.read('session-a')).entries).toEqual(before);if(fail){expect(result).toBeInstanceOf(Error);expect(events.some(e=>e.type==='RUN_FINISHED'&&e.result?.status==='success')).toBe(false)}else expect(result).toBe('complete');
});
it("actual Runtime -> FireflyAgent streams standard chat events and writes the full bound canonical reply once",async()=>{
 const f=await fixture(),built=await f.runtime.buildOptions({sessionId:"session-a",userTurnId:"u1",assistantTurnId:"assistant-s",mode:"chat",messages:[]});
 expect(built.options.controlledResponses).toBeTypeOf("function");
 Object.assign(built.options,{runId:"run-s",transcriptSink:f.sink,isControlledRunCurrent:f.target.isCurrent});
 const agent=new FireflyAgent({threadId:"thread-s",description:"synthetic"}),events:any[]=[];
 await new Promise<void>((resolve,reject)=>agent.runWithEvents(built.options).subscribe({next:e=>events.push(e),error:reject,complete:resolve}));
 expect(events.filter(e=>e.type==="TEXT_MESSAGE_CONTENT").map(e=>e.delta)).toEqual(["hello ","world"]);
 expect(events.find(e=>e.type==="TEXT_MESSAGE_START")).toMatchObject({messageId:"assistant-s",role:"assistant"});
 expect(events.filter(e=>e.type==="TEXT_MESSAGE_END")).toHaveLength(1);expect(events.filter(e=>e.type==="RUN_FINISHED")).toHaveLength(1);
 expect(events.at(-1)).toMatchObject({type:"RUN_FINISHED",runId:"run-s",result:{status:"success"}});
 expect(fs.existsSync(path.join(f.root,'conversation','transcripts','session-a','snapshot.json'))).toBe(true);
 expect(await f.assistants()).toEqual([expect.objectContaining({turnId:"assistant-s",runId:"run-s",payload:{role:"assistant",content:"hello world"}})]);
 expect(f.sent).toHaveLength(1);expect(f.commands.filter((c:any)=>c.kind==="claim")).toHaveLength(1);
 expect(f.sent[0].body).toMatchObject({stream:true,store:false,max_output_tokens:128});expect(Object.isFrozen(f.sent[0].body)).toBe(true);
 const final=f.counted.findLast(c=>c.body.instructions==="fixed")!;expect(f.sent[0].body.input).toBe(final.body.input);
});
it("stream keeps canonical historical tool call/result framing intact",async()=>{
 const f=await fixture();await f.store.append("session-a",{id:"a0",at:1001,kind:"assistant",payload:{role:"assistant",content:"check",toolCalls:[{id:"t0",name:"lookup",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t0",at:1002,kind:"tool_result",payload:{assistantEntryId:"a0",toolCallId:"t0",outcome:"success",message:{role:"tool",content:"result",toolCallId:"t0",name:"lookup"}}});
 await f.store.append("session-a",{id:"u2",at:1003,kind:"user",turnId:"u2",revision:1,payload:{text:"new question"}});f.target.userTurnId="u2";
 await f.runtime.runSContext(f.input);expect(JSON.stringify(f.sent[0].body.input)).toContain("function_call_output");expect((await f.assistants()).at(-1)!.payload).toEqual({role:"assistant",content:"hello world"});
});
it.each(["failed","error","incomplete","duplicate-terminal","post-terminal-delta","wrong-sequence","no-terminal","text-mismatch","tool","reasoning","refusal","citation","transport"])("stream %s cannot append partial/fake completion or resend",async kind=>{
 const f=await fixture(),events=normal();
 if(["failed","error","incomplete"].includes(kind))events[9]={type:kind==="error"?"error":`response.${kind}`,sequence_number:9,response:{id:"resp-synthetic",status:kind,error:{message:"SECRET_PROVIDER_BODY"}}} as any;
 if(kind==="duplicate-terminal")events.push({...events[9],sequence_number:10});if(kind==="post-terminal-delta")events.push({...events[4],sequence_number:10});
 if(kind==="wrong-sequence")events[5].sequence_number=4;if(kind==="no-terminal")events.pop();if(kind==="text-mismatch")events[9].response=response("different");
 if(kind==="tool"||kind==="reasoning")events[2]={type:"response.output_item.added",sequence_number:2,output_index:0,item:{type:kind==="tool"?"function_call":"reasoning",id:"unsupported"}} as any;
 if(kind==="refusal")events[4]={type:"response.refusal.delta",sequence_number:4,delta:"refused"} as any;
 if(kind==="citation")(events[9].response!.output[0].content[0].annotations as any[]).push({type:"url_citation",url:"synthetic"});
 if(kind==="transport")f.setHook(async i=>{if(i===5)throw Error("SECRET_PROVIDER_BODY")});f.setEvents(events);
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow(kind==="failed"||kind==="error"?"MEMORY_CONTEXT_STREAM_SERVER_ERROR":kind==="incomplete"?"MEMORY_CONTEXT_STREAM_INCOMPLETE":kind==="transport"?"MEMORY_CONTEXT_STREAM_FAILED":["tool","reasoning","refusal","citation"].includes(kind)?"MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED":"MEMORY_CONTEXT_STREAM_INVALID");expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);
 expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});
it.each(["cancel","session-switch","append","edit","regenerate","delete","forget","configuration"])("%s while streaming blocks canonical writeback",async kind=>{
 const f=await fixture(),abort=new AbortController(),fact=kind==="forget"?await f.active("I prefer bash"):undefined;
 f.setHook(async i=>{if(i!==5)return;if(kind==="cancel")abort.abort();if(kind==="session-switch")f.switchRun();if(kind==="configuration")f.drift();
  if(kind==="append")await f.store.append("session-a",{id:"u2",at:1003,kind:"user",turnId:"u2",revision:1,payload:{text:"new"}});
  if(kind==="edit"||kind==="regenerate")await f.store.append("session-a",{id:"rw",at:1003,kind:"turn_rewind",...(kind==="edit"?{turnId:"u1",revision:2}:{}),payload:{anchorUserTurnId:"u1",disposition:kind==="edit"?"replace_user":"keep_user",reason:kind,...(kind==="edit"?{replacementUser:{text:"edited"}}:{})}} as any);
  if(kind==="delete")await f.store.deleteConversation("session-a");if(fact)await f.forget(fact.factId!);
 });
 await expect(f.runtime.runSContext({...f.input,signal:abort.signal})).rejects.toThrow();expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
 expect((await f.store.read("other-session")).entries).toEqual([]);
});
it("abort of an idle stream settles without awaiting another provider event",async()=>{
 const f=await fixture(),abort=new AbortController();let started!:()=>void,release!:()=>void;const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r});
 f.setHook(async i=>{if(i===5){started();await wait}});const run=f.runtime.runSContext({...f.input,signal:abort.signal});const failed=expect(run).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");await start;abort.abort();await failed;
 expect(f.stream.controller.signal.aborted).toBe(true);expect(await f.assistants()).toHaveLength(0);release();await Promise.resolve();expect(f.sent).toHaveLength(1);
});
it.each(["wrong-session","wrong-turn","foreign-sink","tools","reused-run"])("rejects %s before a new SDK request",async kind=>{
 const f=await fixture();if(kind==="wrong-session")f.target.conversationId="other-session";if(kind==="wrong-turn")f.target.userTurnId="wrong";
 if(kind==="foreign-sink")f.target.sink=createTranscriptSink({store:f.store,conversationId:"other-session",runId:"run-s",assistantTurnId:"assistant-s"});
 if(kind==="tools")(f.request as any).tools=[{name:"lookup",description:"synthetic",parameters:{}}];
 if(kind==="reused-run"){await f.runtime.runSContext(f.input);f.sent.length=0;}
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow();expect(f.sent).toHaveLength(0);
});
it.each(["abort","new-turn","forget"])("%s while final append is queued cannot persist the old reply",async kind=>{
 const f=await fixture(),abort=new AbortController(),fact=kind==="forget"?await f.active("I prefer bash"):undefined;
 let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r}),start=new Promise<void>(r=>{started=r});const original=f.store.append.bind(f.store);
 vi.spyOn(f.store,"append").mockImplementation(async(...args:any[])=>{if(args[1].kind==="assistant"){started();await wait}return (original as any)(...args)});
 const run=f.runtime.runSContext({...f.input,signal:abort.signal}),failed=expect(run).rejects.toThrow();await start;
 if(kind==="abort")abort.abort();if(kind==="new-turn")await original("session-a",{id:"u2",at:1003,kind:"user",turnId:"u2",revision:1,payload:{text:"new"}});if(fact)await f.forget(fact.factId!);release();await failed;
 expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});
it("default-off Runtime build does not read the stream builder or provision the port",async()=>{
 let touched=0;const injection:any={enabled:false};Object.defineProperty(injection,"streamRequest",{get(){touched++;throw Error("FORBIDDEN")}});Object.defineProperty(injection,"createPort",{get(){touched++;throw Error("FORBIDDEN")}});
 const runtime=createAgentRuntime({sContext:injection} as any);await runtime.buildOptions.prepareTranscript?.({messages:[],sessionId:"session-a",mode:"chat"});const built=await runtime.buildOptions({messages:[],sessionId:"session-a",mode:"chat"});expect(built.options.controlledResponses).toBeUndefined();expect(touched).toBe(0);
});

it("rejects a same-ID sink owned by a different canonical store before count/send",async()=>{
 const f=await fixture(),other=new ConversationTranscriptStore(path.join(f.root,"other"));
 await other.append("session-a",{id:"u1",at:1000,kind:"user",turnId:"u1",revision:1,payload:{text:"unrelated"}});
 f.target.sink=createTranscriptSink({store:other,conversationId:"session-a",runId:"run-s",assistantTurnId:"assistant-s"});
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
 expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);expect((await other.read("session-a")).entries.filter(e=>e.kind==="assistant")).toHaveLength(0);
});
it.each(["initial","count","claim"])("run takeover at %s prevents SDK send",async stage=>{
 const f=await fixture();
 if(stage==="initial")f.switchRun();if(stage==="count")f.setCountHook(async()=>{f.switchRun()});
 if(stage==="claim"){const command=f.transport.contextCommand.bind(f.transport);vi.spyOn(f.transport,"contextCommand").mockImplementation(async(c:any)=>{const result=await command(c);if(c.kind==="claim")f.switchRun();return result})}
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow();expect(f.sent).toHaveLength(0);
 if(stage==="initial")expect(f.counted).toHaveLength(0);
 expect(await f.assistants()).toHaveLength(0);
});
it.each(["abort","takeover","configuration"])("%s after append dispatch cannot emit fake success or move durable reply",async kind=>{
 const f=await fixture(),abort=new AbortController();let started!:()=>void,release!:()=>void;
 const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r}),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}return (append as any)(...args)});
 const run=f.runtime.runSContext({...f.input,signal:abort.signal}),failed=expect(run).rejects.toThrow();await start;
 if(kind==="abort")abort.abort();if(kind==="takeover")f.switchRun();if(kind==="configuration")f.drift();release();await failed;
 expect(await f.assistants()).toEqual([expect.objectContaining({turnId:"assistant-s",runId:"run-s",payload:{role:"assistant",content:"hello world"}})]);
 expect((await f.store.read("other-session")).entries).toEqual([]);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);expect(f.sent).toHaveLength(1);
});
it("Runtime fixes stream scope and builder before delayed options construction",async()=>{
 const f=await fixture(),original=vi.mocked(buildAgentRunOptions).getMockImplementation()!;let release!:()=>void,started!:()=>void;
 const wait=new Promise<void>(r=>{release=r}),start=new Promise<void>(r=>{started=r});
 vi.mocked(buildAgentRunOptions).mockImplementationOnce(async(...args)=>{started();await wait;return original(...args)});
 const injection:any={enabled:true,createPort:()=>f.port,streamRequest:()=>f.request},runtime=createAgentRuntime({sContext:injection} as any);
 const input:any={sessionId:"session-a",userTurnId:"u1",assistantTurnId:"assistant-s",mode:"chat",messages:[]};const pending=runtime.buildOptions(input);await start;
 input.sessionId="other-session";input.userTurnId="other-user";input.assistantTurnId="other-assistant";injection.streamRequest=()=>{throw Error("MUTATED_BUILDER")};release();
 const built=await pending;Object.assign(built.options,{runId:"run-s",transcriptSink:f.sink,isControlledRunCurrent:f.target.isCurrent});
 await built.options.controlledResponses!(built.options,new AbortController().signal,f.target.onEvent);expect(await f.assistants()).toHaveLength(1);
});
it("completion waits for stream EOF before canonical append",async()=>{
 const f=await fixture();let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r}),start=new Promise<void>(r=>{started=r});
 f.setHook(async i=>{if(i===normal().length){started();await wait}});const pending=f.runtime.runSContext(f.input);await start;
 expect(await f.assistants()).toHaveLength(0);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);release();await pending;expect(await f.assistants()).toHaveLength(1);
});

const lifecycle=normal;
it.each(["append","forget"] as const)("external %s queued during pending append cannot be mistaken for own response progress",async kind=>{
 const f=await fixture(),fact=kind==="forget"?await f.active("I prefer bash"):undefined;
 let started!:()=>void,release!:()=>void;const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r}),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}return (append as any)(...args)});
 const run=f.runtime.runSContext(f.input),failed=expect(run).rejects.toThrow();await start;
 const changed=kind==="append"?f.store.append("session-a",{kind:"user",id:"u2",turnId:"u2",revision:1,at:1004,payload:{text:"external new user"}}):f.forget(fact!.factId!);
 release();await changed;await failed;const raw=(await f.store.read("session-a")).entries;
 expect(classifySAssistantSettlement(raw,raw.find(e=>e.kind==="assistant")!.id)).toBe("interrupted");
 expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});
it("failed interrupted settlement stays unknown through the actual FireflyAgent cancellation path",async()=>{
 const f=await fixture(),abort=new AbortController(),built=await f.runtime.buildOptions({sessionId:"session-a",userTurnId:"u1",assistantTurnId:"assistant-s",mode:"chat",messages:[]});
 let started!:()=>void,release!:()=>void;const start=new Promise<void>(r=>{started=r}),wait=new Promise<void>(r=>{release=r}),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}if(String(args[1]).includes('"kind":"assistant_settlement"'))throw Error("SYNTHETIC_IO_FAILURE");return (append as any)(...args)});
 Object.assign(built.options,{runId:"run-s",signal:abort.signal,transcriptSink:f.sink,isControlledRunCurrent:f.target.isCurrent});
 const agent=new FireflyAgent({threadId:"unknown-thread",description:"synthetic"}),events:any[]=[];
 const done=new Promise<void>((resolve,reject)=>agent.runWithEvents(built.options).subscribe({next:e=>events.push(e),error:reject,complete:resolve}));
 await start;abort.abort();release();await done;
 expect(events.filter(e=>e.type==="RUN_FINISHED")).toEqual([expect.objectContaining({result:expect.objectContaining({status:"runtime_error",reason:"MEMORY_CONTEXT_SETTLEMENT_UNKNOWN"})})]);
 expect(events.some(e=>e.type==="TEXT_MESSAGE_END")).toBe(false);
 const entries=(await f.store.read("session-a")).entries;expect(classifySAssistantSettlement(entries,entries.find(e=>e.kind==="assistant")!.id)).toBe("pending");
});
it("successful stream confirms one durable S settlement before exposing its terminal",async()=>{
 const f=await fixture();await f.runtime.runSContext(f.input);
 const entries=(await f.store.read("session-a")).entries,assistant=entries.find(e=>e.kind==="assistant")!;
 expect(classifySAssistantSettlement(entries,assistant.id)).toBe("success");
 expect(entries.filter(e=>e.kind==="assistant_settlement")).toHaveLength(1);
 expect(assistant).toMatchObject({sSettlement:{version:1,userTurnId:"u1",userRevision:1}});
});
it("cancel during dispatched pending append preserves an interrupted audit reply excluded from later context",async()=>{
 const f=await fixture(),abort=new AbortController();let started!:()=>void,release!:()=>void;
 const start=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant"')){started();await wait}return (append as any)(...args)});
 const run=f.runtime.runSContext({...f.input,signal:abort.signal}),failed=expect(run).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");await start;abort.abort();release();await failed;
 const entries=(await f.store.read("session-a")).entries,assistant=entries.find(e=>e.kind==="assistant")!;
 expect(classifySAssistantSettlement(entries,assistant.id)).toBe("interrupted");
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"synthetic user"}]);
});
it("late cancel after success settlement dispatch cannot abort durable confirmation or downgrade success",async()=>{
 const f=await fixture(),abort=new AbortController();let started!:()=>void,release!:()=>void;
 const start=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r),append=fs.promises.appendFile.bind(fs.promises);
 vi.spyOn(fs.promises,"appendFile").mockImplementation(async(...args:any[])=>{if(String(args[1]).includes('"kind":"assistant_settlement"')){started();await wait}return (append as any)(...args)});
 const run=f.runtime.runSContext({...f.input,signal:abort.signal});
 // Timeout guard also proves the pre-existing missing settlement behavior without hanging the suite.
 await Promise.race([start,run.then(()=>{throw Error("SETTLEMENT_NOT_DISPATCHED")})]);abort.abort();release();
 expect((await run).status).toBe("sent");const entries=(await f.store.read("session-a")).entries;
 expect(classifySAssistantSettlement(entries,entries.find(e=>e.kind==="assistant")!.id)).toBe("success");
 expect(f.display.filter(e=>e.type==="text_message_end")).toHaveLength(1);
});
it("accepts the installed SDK's complete plain-text event lifecycle",async()=>{const f=await fixture();f.setEvents(lifecycle());await f.runtime.runSContext(f.input);expect(await f.assistants()).toHaveLength(1)});
it.each(["duplicate-item","duplicate-part","duplicate-textdone","duplicate-partdone","duplicate-itemdone","early-partdone","early-itemdone","in-progress-tool","delta-before-part","logprobs"])("rejects %s event lifecycle before writeback",async kind=>{
 const f=await fixture(),events:any[]=lifecycle();
 if(kind==="duplicate-item")events.splice(3,0,events[2]);if(kind==="duplicate-part")events.splice(4,0,events[3]);
 if(kind==="duplicate-textdone")events.splice(7,0,events[6]);if(kind==="duplicate-partdone")events.splice(8,0,events[7]);if(kind==="duplicate-itemdone")events.splice(9,0,events[8]);
 if(kind==="early-partdone")[events[6],events[7]]=[events[7],events[6]];
 if(kind==="early-itemdone")events.splice(3,0,{...events[8],item:{...events[8].item,content:[]}});
 if(kind==="in-progress-tool")events[1].response.output=[{id:"tool",type:"function_call"}];
 if(kind==="delta-before-part")[events[3],events[4]]=[events[4],events[3]];
 if(kind==="logprobs")events[4].logprobs=[{token:"hello",logprob:-1}];
 f.setEvents(events.map((event,sequence_number)=>({...event,sequence_number})));
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_/);expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});

it("actual FireflyAgent cancellation ends once without a partial canonical assistant",async()=>{
 const f=await fixture(),abort=new AbortController(),built=await f.runtime.buildOptions({sessionId:"session-a",userTurnId:"u1",assistantTurnId:"assistant-s",mode:"chat",messages:[]});
 Object.assign(built.options,{runId:"run-s",transcriptSink:f.sink,isControlledRunCurrent:f.target.isCurrent,signal:abort.signal});
 const events:any[]=[];f.setHook(async i=>{if(i===5)abort.abort()});
 await new Promise<void>((resolve,reject)=>new FireflyAgent({threadId:"thread-s",description:"synthetic"}).runWithEvents(built.options).subscribe({next:e=>events.push(e),error:reject,complete:resolve}));
 expect(events.filter(e=>e.type==="TEXT_MESSAGE_CONTENT")).toHaveLength(1);expect(events.filter(e=>e.type==="TEXT_MESSAGE_END")).toHaveLength(0);
 expect(events.filter(e=>e.type==="RUN_FINISHED")).toEqual([expect.objectContaining({runId:"run-s",result:expect.objectContaining({status:"cancelled"})})]);
 expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);expect((await f.store.read("session-a")).entries.filter(e=>e.kind==="interruption")).toHaveLength(1);
});
it("repository reopen during stream preserves the claimed snapshot's bound write",async()=>{
 const f=await fixture();f.setHook(async i=>{if(i===5)f.reopen()});await f.runtime.runSContext(f.input);expect(await f.assistants()).toHaveLength(1);expect(f.sent).toHaveLength(1);
});

it("actual owned SDK Responses resources and SSE parser preserve the counted body and plain-text lifecycle",async()=>{
 const f=await fixture(true);await f.runtime.runSContext(f.input);
 expect(await f.assistants()).toEqual([expect.objectContaining({runId:"run-s",turnId:"assistant-s",payload:{role:"assistant",content:"hello world"}})]);
 expect(f.sent).toHaveLength(1);expect(f.sent[0].options).toMatchObject({stream:true,maxRetries:0});expect(f.sent[0].body.input).toBe(f.counted.findLast(c=>c.body.instructions==="fixed")!.body.input);
 expect(f.display.filter(e=>e.type==="text_message_content").map(e=>e.delta)).toEqual(["hello ","world"]);
});
it("actual owned SDK SSE failure closes without partial write or a second request",async()=>{
 const f=await fixture(true),events=normal();events[9]={type:"response.failed",sequence_number:9,response:{id:"resp-synthetic",status:"failed",error:{message:"SECRET_PROVIDER_BODY"}}} as any;f.setEvents(events);
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow("MEMORY_CONTEXT_STREAM_SERVER_ERROR");expect(await f.assistants()).toHaveLength(0);expect(f.sent).toHaveLength(1);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});

it("uncertain durable send confirmation aborts the owned stream request without consuming or retrying it",async()=>{
 const f=await fixture(),command=f.transport.contextCommand.bind(f.transport);
 vi.spyOn(f.transport,"contextCommand").mockImplementation(async(c:any)=>{if(c.kind==="confirmUse")throw Error("SYNTHETIC_CONFIRM_FAILURE");return command(c)});
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow("MEMORY_CONTEXT_SEND_UNKNOWN");
 expect(f.sent).toHaveLength(1);expect(f.sent[0].options.signal.aborted).toBe(true);expect(f.display).toEqual([]);expect(await f.assistants()).toHaveLength(0);
});

it("a fresh controlled port cannot replay an already persisted run or claim another reply as its write",async()=>{
 const f=await fixture();await f.runtime.runSContext(f.input);await f.closeTranscript();f.sent.length=0;f.counted.length=0;
 const registry=createMainSourceRegistry(f.transport,{coordinate:f.actorAuthority.coordinate}),access=registry.authority.access("scope-a"),actor=f.actorAuthority.bindActor(access,f.provider.adapter,f.identity);
 const port=createMainSRuntimePort({enabled:true,clock:f.options.clock,registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:actor,binding:f.binding,createTranscript:context=>createConversationTranscriptAdapter({enabled:true,store:f.store,context,actorAuthority:f.actorAuthority,actorToken:actor})!})!;
 await expect(port.run(f.input)).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");expect(f.sent).toHaveLength(0);expect(f.counted).toHaveLength(0);expect(await f.assistants()).toHaveLength(1);
});

it("guarded duplicate assistant ID cannot acknowledge an older reply as the newly streamed text",async()=>{
 const f=await fixture();await f.store.append("session-a",{id:"run-s:assistant:s-response",at:1001,kind:"assistant",runId:"earlier-run",turnId:"earlier-assistant",payload:{role:"assistant",content:"previous canonical reply"}});
 await expect(f.runtime.runSContext(f.input)).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
 expect(await f.assistants()).toEqual([expect.objectContaining({runId:"earlier-run",payload:{role:"assistant",content:"previous canonical reply"}})]);
 expect(f.sent).toHaveLength(1);expect(f.display.some(e=>e.type==="text_message_end")).toBe(false);
});

it("the next real controlled turn reads the preceding sink-written canonical reply with its original event ID",async()=>{
 const f=await fixture();await f.runtime.runSContext(f.input);
 await f.store.append("session-a",{id:"u2",at:1002,kind:"user",turnId:"u2",revision:1,payload:{text:"next synthetic user"}});
 const target={...f.target,runId:"run-next",userTurnId:"u2",assistantTurnId:"assistant-next",sink:createTranscriptSink({store:f.store,conversationId:"session-a",runId:"run-next",assistantTurnId:"assistant-next"})};
 await f.runtime.runSContext({request:f.request,stream:target});expect(f.sent).toHaveLength(2);expect(await f.assistants()).toHaveLength(2);
 expect(JSON.stringify(f.sent[1].body.input)).toContain("hello world");expect(JSON.stringify(f.sent[1].body.input)).toContain("next synthetic user");
 const provenance=f.commands.filter((c:any)=>c.kind==="transcriptPublish").flatMap((c:any)=>c.body.provenance??[]);
 expect(provenance).toContainEqual(expect.objectContaining({entryId:"run-s:assistant:s-response",turnId:"assistant-s",role:"assistant",seq:2}));
});

it.each(["", "bad\nentry", "bad\u0000entry", "bad\u007fentry", "x".repeat(1025)])("provenance rejects malformed event IDs without weakening private memory IDs: %j",async id=>{
 const {parseTranscriptProvenance}=await import("./main-transcript-provider"),{parseInternalId}=await import("../memory-core/command-validation");
 expect(()=>parseTranscriptProvenance([{entryId:id,turnId:"ui:u1",seq:1,occurredAt:1000,role:"user"}])).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
 expect(()=>parseInternalId("run-s:assistant:s-response")).toThrow("MEMORY_INPUT_INVALID");
});

it("forget then reopen admits a freshly committed user before lazy controlled provisioning without reviving old text",async()=>{
 const f=await fixture(),fact=await f.active("I prefer PowerShell");await f.forget(fact.factId!);await f.closeTranscript();f.reopen();
 const store=new ConversationTranscriptStore(path.join(f.root,"conversation"));let adapter:ReturnType<typeof createConversationTranscriptAdapter>,provisions=0;
 const runtime=createAgentRuntime({sContext:{enabled:true,streamRequest:()=>f.request,createPort:()=>{
  provisions++;return createMainSRuntimePort({enabled:true,clock:f.options.clock,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding:f.binding,createTranscript:context=>(adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor})!)})!;
 }}} as any);
 const input={sessionId:"session-a",userTurnId:"fresh-u",assistantTurnId:"fresh-a",mode:"chat" as const,messages:[]};
 await runtime.buildOptions.prepareTranscript?.(input);
 await store.append("session-a",{id:"fresh-u",at:1002,kind:"user",turnId:"fresh-u",revision:1,payload:{text:"fresh ordinary question"}});
 const built=await runtime.buildOptions(input);Object.assign(built.options,{runId:"fresh-run",transcriptSink:createTranscriptSink({store,conversationId:"session-a",runId:"fresh-run",assistantTurnId:"fresh-a"}),isControlledRunCurrent:()=>true});
 try{
  const result=await built.options.controlledResponses!(built.options,new AbortController().signal,()=>{});expect(result.terminal?.status).toBe("success");
  expect(provisions).toBe(1);expect(f.sent).toHaveLength(1);expect(JSON.stringify(f.sent[0].body.input)).toContain("fresh ordinary question");expect(JSON.stringify(f.sent[0].body.input)).not.toContain("synthetic user");expect(JSON.stringify(f.sent[0].body)).not.toContain("PowerShell");expect(await f.policy.recall(f.actor)).toEqual([]);
 }finally{await adapter?.close()}
});

it("early controlled provisioning rejects temporary actors before context reads and retains its failed lifetime",async()=>{
 const f=await fixture(),temporary=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),before=f.commands.length;let provisions=0;
 const runtime=createAgentRuntime({sContext:{enabled:true,streamRequest:()=>f.request,createPort:()=>{
  provisions++;return createMainSRuntimePort({enabled:true,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:temporary,binding:f.binding,createTranscript:()=>{throw Error("TEMPORARY_TRANSCRIPT_FORBIDDEN")}})!;
 }}} as any);
 const input={sessionId:"session-a",userTurnId:"u1",assistantTurnId:"assistant-s",mode:"chat" as const,messages:[]};
 await expect(runtime.buildOptions.prepareTranscript!(input)).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 await expect(runtime.buildOptions.prepareTranscript!(input)).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 expect(provisions).toBe(1);expect(f.commands).toHaveLength(before);expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});

it('Main selection leaves unselected sessions on their ordinary path without provisioning memory',async()=>{
 const f=await fixture(),provision=vi.fn(()=>{throw Error('UNSELECTED_PROVISION_FORBIDDEN')});
 const runtime=createAgentRuntime({sContext:{enabled:true,isControlledSession:(id:string)=>id==='session-a',createPort:provision,streamRequest:()=>f.request}} as any);
 const input={sessionId:'session-b',userTurnId:'u-b',assistantTurnId:'a-b',mode:'chat',messages:[],memoryEnabled:true,actorKey:'renderer-claim',scopeKey:'renderer-claim'} as any;
 await runtime.buildOptions.prepareTranscript!(input);const built=await runtime.buildOptions(input);expect(built.options.controlledResponses).toBeUndefined();expect(provision).not.toHaveBeenCalled();
});
it('an unselected session does not inspect a controlled-only request builder accessor',async()=>{
 const f=await fixture();const injection={enabled:true,isControlledSession:()=>false,createPort:()=>f.port};Object.defineProperty(injection,'streamRequest',{get(){throw Error('UNSELECTED_BUILDER_READ_FORBIDDEN')}});
 const runtime=createAgentRuntime({sContext:injection} as any);const input={sessionId:'session-b',mode:'chat',messages:[]} as any;
 await expect(runtime.buildOptions.prepareTranscript!(input)).resolves.toBeUndefined();expect((await runtime.buildOptions(input)).options.controlledResponses).toBeUndefined();
});
