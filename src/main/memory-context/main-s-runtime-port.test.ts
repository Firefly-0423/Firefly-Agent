import path from "node:path";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainResponsesBinding,createMainResponsesLimits,type ResponsesSdkClient} from "./main-responses-binding";
import {setVendorRuntimeSettingsGetter} from "../orchestrator/vendors/runtime-settings";
import type {ChatRequest} from "../orchestrator/vendors/types";

vi.mock("electron",()=>({app:{getPath:()=>{throw Error("PRODUCT_DATA_READ_FORBIDDEN")}}}));

afterEach(()=>{vi.unstubAllGlobals();setVendorRuntimeSettingsGetter(()=>({}))});
let preparedFixture:Awaited<ReturnType<typeof createFixture>>;
beforeEach(async()=>{preparedFixture=await createFixture()});
async function fixture(){return preparedFixture}
async function createFixture(){
 const {createMainSRuntimePort}=await import("./main-s-runtime-port");
 const f=await contextFixture();setVendorRuntimeSettingsGetter(()=>({}));vi.stubGlobal("fetch",()=>{throw Error("NETWORK_FORBIDDEN")});
 let revision=1,hook:undefined|(()=>Promise<void>),claimHook:undefined|(()=>void),configHook:undefined|(()=>void),sendHook:undefined|(()=>Promise<void>),failure=false;
 const counts:Array<{body:any;options:any}>=[],sends:Array<{body:any;options:any}>=[];
 const client={baseURL:"https://api.openai.com/v1",maxRetries:0,logLevel:"off",logger:{},fetch:()=>{throw Error("NETWORK_FORBIDDEN")},responses:{inputTokens:{count:async(body:any,options:any)=>{counts.push({body,options});await hook?.();return {object:"response.input_tokens",input_tokens:40}}},create:async(body:any,options:any)=>{sends.push({body,options});await sendHook?.();if(failure)throw Error("SYNTHETIC_SEND_FAILURE");return {id:"synthetic-response",object:"response",status:"completed",output:[]}}}} as unknown as ResponsesSdkClient;
 Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 const binding=createMainResponsesBinding({enabled:true,client,limits:createMainResponsesLimits({model:"fixture-model",limitsSource:"fixture://explicit",modelMaxOutputTokens:512,budget:{maxContextTokens:20000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}),configuration:()=>(configHook?.(),{revision,config:{provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",explicitTransport:"responses"}})})!;
 const store=new ConversationTranscriptStore(path.join(f.root,"conversation"));
 await store.append("session-a",{id:"u1",at:1000,kind:"user",turnId:"u1",revision:1,payload:{text:"synthetic user"}});
 let captures=0,empty=false;
 const contextCommand=f.transport.contextCommand;
 const transport={...f.transport,contextCommand:async(c:any)=>{const result=await contextCommand(c);if(c.kind==="claim")claimHook?.();return result}};
 const port=createMainSRuntimePort({enabled:true,clock:f.options.clock,registry:f.registry,transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding,createTranscript:context=>{
  const adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
  return {captureTurns:()=>{captures++;return empty?Promise.resolve([]):adapter.captureTurns()}};
 }})!;
 const request:ChatRequest={model:"fixture-model",messages:[{role:"system",content:"fixed synthetic instructions"}],maxTokens:128,stream:false,tools:[{name:"lookup",description:"fixture lookup",parameters:{type:"object",properties:{item:{type:"string"}}}}]};
 return {...f,port,store,request,counts,sends,get captures(){return captures},emptyCapture:()=>{empty=true},setHook:(value:typeof hook)=>{hook=value},onConfiguration:(value:typeof configHook)=>{configHook=value},onSend:(value:typeof sendHook)=>{sendHook=value},onClaim:(value:typeof claimHook)=>{claimHook=value},drift:()=>{revision++},failSend:()=>{failure=true}};
}
it("default-off port reads no Main dependency",async()=>{
 const {createMainSRuntimePort}=await import("./main-s-runtime-port");let touched=false;
 const options=new Proxy({},{get:(_target,key)=>{if(key==="enabled")return undefined;touched=true;throw Error("FORBIDDEN")}});
 expect(createMainSRuntimePort(options as any)).toBeNull();expect(touched).toBe(false);
});
it("sends canonical complete turns directly with frozen stream/tools/output and the counted input",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:[{id:"t1",name:"lookup",arguments:'{"item":"synthetic"}'}]}});
 await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"t1",outcome:"success",message:{role:"tool",content:"synthetic result",toolCallId:"t1",name:"lookup"}}});
 const result=await f.port.run({request:f.request});expect(result).toMatchObject({status:"sent",result:{id:"synthetic-response"}});
 expect(f.sends).toHaveLength(1);const sent=f.sends[0];expect(Object.isFrozen(sent.body)).toBe(true);
 expect(sent.body).toMatchObject({stream:false,store:false,max_output_tokens:128,instructions:"fixed synthetic instructions"});
 expect(JSON.stringify(sent.body.input)).toContain("function_call_output");expect(JSON.stringify(sent.body.input)).toContain("synthetic result");
 const final=f.counts.findLast(c=>c.body.instructions==="fixed synthetic instructions")!;expect(sent.body.input).toBe(final.body.input);expect(sent.body.tools).toBe(final.body.tools);
 expect(sent.options).toEqual({maxRetries:0});expect(await f.policy.recall(f.actor)).toEqual([]);
});
it.each(["stream","raw-user","wrong-cap","accessor"])("refuses unsupported %s before capture/count/send",async kind=>{
 const f=await fixture();if(kind==="stream")f.request.stream=true;if(kind==="raw-user")f.request.messages.push({role:"user",content:"untrusted"});if(kind==="wrong-cap")f.request.maxTokens=129;
 if(kind==="accessor")Object.defineProperty(f.request,"tools",{get:()=>{throw Error("GETTER_FORBIDDEN")},enumerable:true});
 await expect(f.port.run({request:f.request})).rejects.toThrow();expect(f.captures).toBe(0);expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0);
});
it("detaches schema and system inputs before asynchronous source/count work",async()=>{
 const f=await fixture();f.setHook(async()=>{f.request.messages[0].content="mutated";f.request.tools![0].parameters={type:"string"};f.request.stream=true});
 await f.port.run({request:f.request});expect(f.sends).toHaveLength(1);expect(f.sends[0].body.instructions).toBe("fixed synthetic instructions");expect(f.sends[0].body.tools[0].parameters.type).toBe("object");expect(f.sends[0].body.stream).toBe(false);
});
it.each(["before","count","claim"])("abort at %s never invokes sender",async phase=>{
 const f=await fixture(),abort=new AbortController();if(phase==="before")abort.abort();if(phase==="count")f.setHook(async()=>{abort.abort();throw Error("SDK_ABORT")});if(phase==="claim")f.onClaim(()=>abort.abort());
 await expect(f.port.run({request:f.request,signal:abort.signal})).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");expect(f.sends).toHaveLength(0);
 if(phase==="before"){expect(f.captures).toBe(0);expect(f.counts).toHaveLength(0)}else expect(f.counts.every(c=>c.options.signal===abort.signal)).toBe(true);
});
it("passes cancellation through to the sole SDK send",async()=>{
 const f=await fixture(),abort=new AbortController();await f.port.run({request:f.request,signal:abort.signal});expect(f.sends).toHaveLength(1);expect(f.sends[0].options.signal).toBe(abort.signal);
});
it.each(["append","configuration","count-error"])("%s during counting blocks sender without fallback",async kind=>{
 const f=await fixture();let changed=false;f.setHook(async()=>{if(changed)return;changed=true;if(kind==="append")await f.store.append("session-a",{id:"u2",at:1003,kind:"user",turnId:"u2",revision:1,payload:{text:"new synthetic"}});if(kind==="configuration")f.drift();if(kind==="count-error")throw Error("SYNTHETIC_COUNT_FAILURE")});
 await expect(f.port.run({request:f.request})).rejects.toThrow();expect(f.sends).toHaveLength(0);
});
it("serializes concurrent runs so frozen configuration cannot bleed across counts",async()=>{
 const f=await fixture();await Promise.all([f.port.run({request:f.request}),f.port.run({request:{...f.request,messages:[{role:"system",content:"second fixed"}]}})]);
 expect(f.sends).toHaveLength(2);expect(f.sends.map(s=>s.body.instructions)).toEqual(["fixed synthetic instructions","second fixed"]);
});
it("keeps ambiguous send failure explicit without retrying",async()=>{
 const f=await fixture();f.failSend();await expect(f.port.run({request:f.request})).resolves.toMatchObject({status:"result-unknown"});expect(f.sends).toHaveLength(1);
});


it("actual AgentRuntime reaches canonical Main counts/permit and direct SDK sender",async()=>{
 const f=await fixture(),{createAgentRuntime}=await import("../orchestrator/agent-runtime");
 const legacy=vi.fn(()=>{throw Error("LEGACY_MODEL_FORBIDDEN")}),provision=vi.fn(()=>f.port);
 const runtime=createAgentRuntime({sContext:{enabled:true,createPort:provision},loadModelSettings:legacy,llmClient:{chat:legacy}} as any);
 await expect(runtime.runSContext({request:f.request})).resolves.toMatchObject({status:"sent",result:{id:"synthetic-response"}});
 expect(provision).toHaveBeenCalledTimes(1);expect(legacy).not.toHaveBeenCalled();expect(f.sends).toHaveLength(1);
 expect(f.commands.some((c:any)=>c.kind==="permit")).toBe(true);expect(f.commands.filter((c:any)=>c.kind==="claim")).toHaveLength(1);
});
it.each([1,3,5])("append during complete request count phase %s cannot send a stale snapshot",async phase=>{
 const f=await fixture();let full=0;f.setHook(async()=>{if(f.counts.at(-1)!.body.instructions&&++full===phase)await f.store.append("session-a",{id:"u2",at:1003,kind:"user",turnId:"u2",revision:1,payload:{text:"new synthetic"}})});
 await expect(f.port.run({request:f.request})).rejects.toThrow();expect(full).toBeGreaterThanOrEqual(phase);if(phase===5)expect(f.commands.some((c:any)=>c.kind==="permit")).toBe(true);expect(f.sends).toHaveLength(0);
});
it("forget during counting cannot revive old canonical derived content",async()=>{
 const f=await fixture(),fact=await f.active("I prefer bash");await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"old synthetic derivation"}});
 let changed=false;f.setHook(async()=>{if(changed)return;changed=true;await f.forget(fact.factId!)});
 await expect(f.port.run({request:f.request})).rejects.toThrow();expect(f.sends).toHaveLength(0);
});
it("an aborted queued run does not capture or send and leaves the next run usable",async()=>{
 const f=await fixture(),abort=new AbortController();let release!:()=>void,started!:()=>void;
 const waiting=new Promise<void>(r=>{release=r}),start=new Promise<void>(r=>{started=r});let held=false;
 f.setHook(async()=>{if(held)return;held=true;started();await waiting});
 const first=f.port.run({request:f.request});await start;
 const queued=f.port.run({request:f.request,signal:abort.signal});const caught=expect(queued).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");abort.abort();release();
 await first;await caught;expect(f.captures).toBe(1);expect(f.sends).toHaveLength(1);
 f.setHook(undefined);await f.port.run({request:f.request});expect(f.sends).toHaveLength(2);
});


it.each(["edit","regenerate","delete"])("%s during counting invalidates the canonical request",async kind=>{
 const f=await fixture();let changed=false;
 f.setHook(async()=>{if(changed)return;changed=true;if(kind==="delete")await f.store.deleteConversation("session-a");else await f.store.append("session-a",kind==="edit"
 ?{id:"rewind",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited"}}}
 :{id:"rewind",at:1001,kind:"turn_rewind",payload:{anchorUserTurnId:"u1",disposition:"keep_user",reason:"regenerate"}})});
 await expect(f.port.run({request:f.request})).rejects.toThrow();expect(f.sends).toHaveLength(0);
});
it("rejects a temporary actor before provisioning any transcript port",async()=>{
 const f=await fixture(),{createMainSRuntimePort}=await import("./main-s-runtime-port");
 const actor=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),createTranscript=vi.fn();
 const before=f.writes;expect(()=>createMainSRuntimePort({enabled:true,actorAuthority:f.actorAuthority,actorToken:actor,createTranscript} as any)).toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 expect(createTranscript).not.toHaveBeenCalled();expect(f.writes).toBe(before);
});

it("refuses empty canonical captures before any model count or sender",async()=>{const f=await fixture();f.emptyCapture();await expect(f.port.run({request:f.request})).rejects.toThrow("MEMORY_CONTEXT_RECENT_INCOMPLETE");expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0)});

it("abort from the last configuration check cannot invoke SDK create",async()=>{const f=await fixture(),abort=new AbortController();f.onConfiguration(()=>{if(f.commands.some((c:any)=>c.kind==="claim"))abort.abort()});await expect(f.port.run({request:f.request,signal:abort.signal})).resolves.toMatchObject({status:"result-unknown"});expect(f.sends).toHaveLength(0)});

it("abort after SDK invocation reports unknown without retry or legacy fallback",async()=>{const f=await fixture(),abort=new AbortController();f.onSend(async()=>{abort.abort();throw Error("SYNTHETIC_SDK_ABORT")});await expect(f.port.run({request:f.request,signal:abort.signal})).resolves.toMatchObject({status:"result-unknown"});expect(f.sends).toHaveLength(1)});

it("AgentRuntime snapshots request before a delayed lazy factory resolves",async()=>{
 const f=await fixture(),{createAgentRuntime}=await import("../orchestrator/agent-runtime");let release!:(port:typeof f.port)=>void,started!:()=>void;
 const pending=new Promise<typeof f.port>(resolve=>{release=resolve}),start=new Promise<void>(resolve=>{started=resolve});
 const createPort=vi.fn(()=>{started();return pending});
 const runtime=createAgentRuntime({sContext:{enabled:true,createPort}} as any);
 const input={request:f.request},run=runtime.runSContext(input);await start;
 f.request.messages[0].content="changed during factory";f.request.tools![0].parameters={type:"string"};
 input.request={...f.request,messages:[{role:"system",content:"replaced request during factory"}]};release(f.port);
 await expect(run).resolves.toMatchObject({status:"sent"});expect(f.sends).toHaveLength(1);
 expect(f.sends[0].body.instructions).toBe("fixed synthetic instructions");expect(f.sends[0].body.tools[0].parameters.type).toBe("object");
});
it("AgentRuntime fixes the original signal while a delayed factory is pending",async()=>{
 const f=await fixture(),{createAgentRuntime}=await import("../orchestrator/agent-runtime");let release!:(port:typeof f.port)=>void,started!:()=>void;
 const pending=new Promise<typeof f.port>(resolve=>{release=resolve}),start=new Promise<void>(resolve=>{started=resolve});
 const original=new AbortController(),replacement=new AbortController(),createPort=vi.fn(()=>{started();return pending});
 const runtime=createAgentRuntime({sContext:{enabled:true,createPort}} as any);
 const input={request:f.request,signal:original.signal},run=runtime.runSContext(input);const rejected=expect(run).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");await start;
 input.signal=replacement.signal;original.abort();release(f.port);await rejected;
 expect(f.captures).toBe(0);expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0);
});
it.each(["request-getter","signal-getter","message-getter","schema-getter","schema-toJSON"])("AgentRuntime refuses %s without executing it or provisioning",async kind=>{
 const f=await fixture(),{createAgentRuntime}=await import("../orchestrator/agent-runtime");let touched=0;const createPort=vi.fn(()=>f.port),input:any={request:f.request};
 const getter=()=>{touched++;return kind==="signal-getter"?undefined:f.request};
 if(kind==="request-getter"||kind==="signal-getter")Object.defineProperty(input,kind==="request-getter"?"request":"signal",{enumerable:true,get:getter});
 if(kind==="message-getter")Object.defineProperty(f.request.messages[0],"content",{enumerable:true,get:()=>{touched++;return "unexpected"}});
 if(kind==="schema-getter")Object.defineProperty(f.request.tools![0].parameters,"type",{enumerable:true,get:()=>{touched++;return "object"}});
 if(kind==="schema-toJSON")Object.defineProperty(f.request.tools![0].parameters,"toJSON",{value:()=>{touched++;return {type:"object"}}});
 const runtime=createAgentRuntime({sContext:{enabled:true,createPort}} as any);
 await expect(runtime.runSContext(input)).rejects.toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
 expect(touched).toBe(0);expect(createPort).not.toHaveBeenCalled();expect(f.captures).toBe(0);expect(f.counts).toHaveLength(0);expect(f.sends).toHaveLength(0);
});
