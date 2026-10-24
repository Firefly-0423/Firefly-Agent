import {Responses} from "openai/resources/responses/responses";
import {loggerFor} from "../../../node_modules/openai/internal/utils/log.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {createMainResponsesBinding,createMainResponsesLimits,type ResponsesLimitsInput,type ResponsesSdkClient} from "./main-responses-binding";
import {createMainContext} from "./main-context";
import {openMemoryRepository} from "../memory-core/repository";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {createMainPolicy} from "../memory-policy/main-policy";
import {SyntheticSourceProvider} from "../../../scripts/verify/memory-sources/synthetic-provider";
import {getAdapterForConfig} from "../orchestrator/vendors";
import {setVendorRuntimeSettingsGetter} from "../orchestrator/vendors/runtime-settings";
import type {ChatRequest,VendorConfig} from "../orchestrator/vendors/types";

const validationParent=path.resolve(os.tmpdir(),"firefly-s-responses");
const owned:Array<{root:string;repo?:ReturnType<typeof openMemoryRepository>}>=[];
afterEach(()=>{
 vi.unstubAllGlobals();setVendorRuntimeSettingsGetter(()=>({}));
 for(const f of owned.splice(0)){
  try{f.repo?.close()}
  finally{
   if(path.dirname(f.root)!==validationParent||!path.basename(f.root).startsWith("validation-"))throw Error("SYNTHETIC_ROOT_MISMATCH");
   fs.rmSync(f.root,{recursive:true,force:true});
  }
 }
});
function limits():ResponsesLimitsInput{return {model:"fixture-model",limitsSource:"fixture://explicit-limits",modelMaxOutputTokens:512,budget:{maxContextTokens:20000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}}
function fixture(){
 setVendorRuntimeSettingsGetter(()=>({}));
 vi.stubGlobal("fetch",()=>{throw Error("NETWORK_FORBIDDEN")});
 let revision=1,config:Omit<VendorConfig,"apiKey">={provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",explicitTransport:"responses"};
 const counted:Array<{body:any;options:any}>=[],sent:Array<{body:any;options:any}>=[];
 let countHook:undefined|(()=>Promise<void>),countValue=50,sendFailure=false;
 const client={baseURL:"https://api.openai.com/v1",maxRetries:0,responses:{inputTokens:{count:async(body:any,options:any)=>{counted.push({body,options});await countHook?.();return {object:"response.input_tokens",input_tokens:countValue}}},create:(body:any,options:any)=>{sent.push({body,options});return sendFailure?Promise.reject(Error("SYNTHETIC_SEND_FAILURE")):Promise.resolve("synthetic-sent")}}} as unknown as ResponsesSdkClient;
 Object.assign(client,{logLevel:"off",logger:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},fetch:()=>{throw Error("NETWORK_FORBIDDEN")}});
 Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 const profile=createMainResponsesLimits(limits());
 const options={enabled:true,limits:profile,configuration:()=>({revision,config}),client};
 const binding=createMainResponsesBinding(options)!;
 const request:ChatRequest={model:"fixture-model",messages:[{role:"system",content:"fixed synthetic instructions"},{role:"user",content:"synthetic user"}],maxTokens:128,stream:true};
 return {binding,client,request,counted,sent,options,get config(){return config},setConfig:(value:typeof config)=>{config=value;revision++},bump:()=>{revision++},setCountHook:(hook:typeof countHook)=>{countHook=hook},setCount:(value:number)=>{countValue=value},failSend:()=>{sendFailure=true}};
}
async function contextFixture(f:ReturnType<typeof fixture>){
 fs.mkdirSync(validationParent,{recursive:true});
 const root=fs.mkdtempSync(path.join(validationParent,"validation-"));
 const resource:typeof owned[number]={root};owned.push(resource);
 const repo=resource.repo=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key:randomBytes(32)});
 const authority=createMainActorAuthority({resolveActor:()=>"actor-a"});
 const transport={sourceCommand:async(c:unknown)=>repo.sourceCommand(c),policyCommand:async(c:unknown)=>repo.policyCommand(c),contextCommand:async(c:unknown)=>repo.contextCommand(c)};
 const registry=createMainSourceRegistry(transport,{coordinate:authority.coordinate}),provider=new SyntheticSourceProvider(path.join(root,"source.json"),"scope-a"),access=registry.authority.access("scope-a"),identity={providerId:"synthetic",sessionId:"session-a",messageId:"u1"};
 const policy=createMainPolicy({registry,transport,actorAuthority:authority,resolveActor:()=>"actor-a"}),actor=policy.bindActor(access,provider.adapter,identity);
 provider.write(identity,{text:"synthetic user",role:"user",trust:"direct-user-event"});const source=await registry.capture(access,provider.adapter,identity);
 const prepare:Parameters<typeof createMainContext>[0]["prepare"]=units=>f.binding.prepare({...f.request,messages:[{role:"system",content:"fixed synthetic instructions"},...units.flatMap(u=>u.messages.map(m=>({role:m.role,content:m.text,...(m.toolCalls?{toolCalls:m.toolCalls}:{}),...(m.toolCallId?{toolCallId:m.toolCallId}:{}),...(m.name?{name:m.name}:{})})))]});
 const context=createMainContext({registry,transport,actorAuthority:authority,counter:f.binding.counter,budget:f.binding.budget,prepare,prepareS:units=>prepare(units,[])});
 const assemble=()=>context.assemble(actor,{sessionId:"session-a",sourceRefs:[source]});
 return {root,repo,context,actor,authority,assemble};
}
it("is disabled by default before touching any configuration, limits or SDK dependency",()=>{
 let touched=false;const options=new Proxy({},{get:(_target,key)=>{if(key==="enabled")return undefined;touched=true;throw Error("UNEXPECTED_ACCESS")}});
 expect(createMainResponsesBinding(options as Parameters<typeof createMainResponsesBinding>[0])).toBeNull();expect(touched).toBe(false);
});
it("requires a Main-issued limits capability rather than JSON or a clone",()=>{
 const f=fixture();expect(()=>createMainResponsesBinding({...f.options,limits:limits()})).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
});
it.each(["unknown-window","missing-output","excess-output","no-evidence","fixed-overflow"])("refuses invalid caller-provisioned limits: %s",kind=>{
 const input=limits();if(kind==="unknown-window")delete (input.budget as any).maxContextTokens;
 if(kind==="missing-output")delete (input.budget as any).reservedOutputTokens;
 if(kind==="excess-output")input.budget.reservedOutputTokens=513;
 if(kind==="no-evidence")input.limitsSource="";
 if(kind==="fixed-overflow")input.budget.maxContextTokens=130;
 expect(()=>createMainResponsesLimits(input)).toThrow();
});
it.each(["https://api.deepseek.com","http://api.openai.com/v1","https://api.openai.com/v1?route=other","https://user@api.openai.com/v1"])("refuses an unverified endpoint before any SDK call: %s",baseUrl=>{
 const f=fixture();f.setConfig({...f.config,baseUrl});expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("keeps ordinary DeepSeek serialization available while strict counting is unverified",()=>{
 const f=fixture(),cfg:VendorConfig={provider:"DeepSeek（深度求索）",model:"fixture-model",baseUrl:"https://api.deepseek.com",apiKey:"",explicitTransport:"responses"};
 expect(JSON.parse(getAdapterForConfig(cfg).buildRequest(f.request,cfg).body).model).toBe("fixture-model");
 f.setConfig({provider:cfg.provider,model:cfg.model,baseUrl:cfg.baseUrl,explicitTransport:cfg.explicitTransport});
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["endpoint","retry"])("refuses an SDK %s mismatch",kind=>{
 const f=fixture();if(kind==="endpoint")f.client.baseURL="https://api.deepseek.com";else (f.client as any).maxRetries=2;
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");
});
it("freezes the fully serialized body with role framing, tool schemas and complete arguments",async()=>{
 const f=fixture();f.request.messages.push({role:"assistant",content:"checking",toolCalls:[{id:"t1",name:"lookup",arguments:'{"item":"synthetic"}'}]},{role:"tool",content:"result",toolCallId:"t1",name:"lookup"});
 f.request.tools=[{name:"lookup",description:"fixture lookup",parameters:{type:"object",properties:{item:{type:"string"}},required:["item"]}}];
 const prepared=f.binding.prepare(f.request);f.request.messages[1].content="mutated original";
 expect(Object.isFrozen(prepared.body)).toBe(true);expect(prepared.body.max_output_tokens).toBe(128);
 expect(JSON.stringify(prepared.body)).toContain('"type":"function_call"');expect(JSON.stringify(prepared.body)).toContain('"type":"function_call_output"');
 expect(JSON.stringify(prepared.body)).not.toContain("mutated original");await f.binding.counter.count(prepared);
 expect(f.counted[0].body).toMatchObject({model:"fixture-model",instructions:"fixed synthetic instructions",input:prepared.body.input,tools:prepared.body.tools});
 expect(f.counted[0].body.max_output_tokens).toBeUndefined();expect(f.counted[0].options.maxRetries).toBe(0);
});
it.each(["unknown-extra","trusted-override","missing-cap","wrong-cap","rich-content","unknown-request"])("refuses an unsupported request before counting: %s",kind=>{
 const f=fixture();if(kind==="unknown-extra")f.request.extraBody={unverified_cache:{mode:"magic"}};
 if(kind==="trusted-override")f.request.extraBody={input:"untrusted override"};
 if(kind==="missing-cap")delete f.request.maxTokens;
 if(kind==="wrong-cap")f.request.maxTokens=129;
 if(kind==="rich-content")f.request.messages[1].content=[{type:"image_url",image_url:{url:"synthetic-only"}}];
 if(kind==="unknown-request")(f.request as any).unverifiedExtension="canary";
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("refuses a modified or unissued prepared body before SDK counting",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request),changed=structuredClone(prepared);changed.body.instructions="tampered";
 await expect(f.binding.counter.count(changed)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.counted).toHaveLength(0);
});
it("refuses configuration drift across an asynchronous count",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);f.setCountHook(async()=>{f.bump()});
 await expect(f.binding.counter.count(prepared)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.sent).toHaveLength(0);
});
it.each(["error","negative","nan","overflow"])("a %s count cannot invoke any sender or ordinary fallback",async kind=>{
 const f=fixture();if(kind==="error")f.setCountHook(async()=>{throw Error("SYNTHETIC_COUNT_FAILURE")});
 if(kind==="negative")f.setCount(-1);if(kind==="nan")f.setCount(NaN);if(kind==="overflow")f.setCount(50000);
 const ctx=await contextFixture(f);await expect(ctx.assemble()).rejects.toThrow();expect(f.sent).toHaveLength(0);
});
it("dispatches the same frozen wire body through the existing one-use Main permit",async()=>{
 const f=fixture(),ctx=await contextFixture(f),snapshot=await ctx.assemble(),permit=await ctx.context.validateForDispatch(ctx.actor,snapshot);
 const result=await f.binding.dispatch(ctx.context,ctx.actor,permit);expect(result.status).toBe("sent");expect(f.sent).toHaveLength(1);
 expect(f.counted.some(c=>c.body.input===f.sent[0].body.input)).toBe(true);
 expect(f.sent[0].body).toEqual(snapshot.request.body);expect(Object.isFrozen(f.sent[0].body)).toBe(true);expect(f.sent[0].options.maxRetries).toBe(0);
 await expect(f.binding.dispatch(ctx.context,ctx.actor,permit)).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(f.sent).toHaveLength(1);
});
it("a tool-schema change after assembly prevents sending an old permit",async()=>{
 const f=fixture(),ctx=await contextFixture(f),snapshot=await ctx.assemble(),permit=await ctx.context.validateForDispatch(ctx.actor,snapshot);
 f.request.tools=[{name:"new_tool",description:"changed",parameters:{type:"object"}}];
 await expect(f.binding.dispatch(ctx.context,ctx.actor,permit)).rejects.toThrow();expect(f.sent).toHaveLength(0);
});
it("an SDK invocation failure is result-unknown and is never automatically retried",async()=>{
 const f=fixture(),ctx=await contextFixture(f),snapshot=await ctx.assemble(),permit=await ctx.context.validateForDispatch(ctx.actor,snapshot);f.failSend();
 expect((await f.binding.dispatch(ctx.context,ctx.actor,permit)).status).toBe("result-unknown");expect(f.sent).toHaveLength(1);
 await expect(f.binding.dispatch(ctx.context,ctx.actor,permit)).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(f.sent).toHaveLength(1);
});
it.each(["endpoint","model","reasoning","revision","runtime","sdk-endpoint","sdk-retry","sdk-method"])("configuration drift blocks counting before SDK access: %s",async kind=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);
 if(kind==="endpoint")f.setConfig({...f.config,baseUrl:"https://api.deepseek.com"});
 if(kind==="model")f.setConfig({...f.config,model:"other-fixture"});
 if(kind==="reasoning")f.setConfig({...f.config,reasoning:{mode:"off"}});
 if(kind==="revision")f.bump();
 if(kind==="runtime")setVendorRuntimeSettingsGetter(()=>({disableMaxToken:true}));
 if(kind==="sdk-endpoint")f.client.baseURL="https://api.deepseek.com";
 if(kind==="sdk-retry")(f.client as any).maxRetries=1;
 if(kind==="sdk-method")(f.client.responses.inputTokens as any).count=()=>{throw Error("REPLACED_COUNTER")};
 await expect(f.binding.counter.count(prepared)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["endpoint","model","revision","runtime"])("configuration drift blocks an existing permit before sending: %s",async kind=>{
 const f=fixture(),ctx=await contextFixture(f),snapshot=await ctx.assemble(),permit=await ctx.context.validateForDispatch(ctx.actor,snapshot);
 if(kind==="endpoint")f.setConfig({...f.config,baseUrl:"https://api.deepseek.com"});
 if(kind==="model")f.setConfig({...f.config,model:"other-fixture"});
 if(kind==="revision")f.bump();
 if(kind==="runtime")setVendorRuntimeSettingsGetter(()=>({disableMaxToken:true}));
 await expect(f.binding.dispatch(ctx.context,ctx.actor,permit)).rejects.toThrow();expect(f.sent).toHaveLength(0);
});
it.each(["counter","sender"])("refuses a missing SDK %s capability before use",kind=>{
 const f=fixture();if(kind==="counter")(f.client.responses as any).inputTokens=undefined;else (f.client.responses as any).create=undefined;
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["rawAssistant","unknown-message","unknown-tool","incomplete-tool","unknown-config","output-disabled"])("refuses unproven nested framing: %s",kind=>{
 const f=fixture();
 if(kind==="rawAssistant")f.request.messages.push({role:"assistant",content:"x",rawAssistant:[]});
 if(kind==="unknown-message")(f.request.messages[1] as any).unverified="x";
 if(kind==="unknown-tool")f.request.tools=[{name:"t",description:"x",parameters:{},unverified:"x"} as any];
 if(kind==="incomplete-tool")f.request.messages.push({role:"assistant",content:"",toolCalls:[{id:"t",name:"t",arguments:"{}"}]});
 if(kind==="unknown-config")(f.config as any).unverified="x";
 if(kind==="output-disabled")setVendorRuntimeSettingsGetter(()=>({disableMaxToken:true}));
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("rejects malformed count receipts without leaking provider errors or prompt text",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);
 f.setCountHook(async()=>{throw Error("SECRET_PROVIDER_ERROR_AND_PROMPT")});
 await expect(f.binding.counter.count(prepared)).rejects.toThrow(/^MEMORY_CONTEXT_COUNT_FAILED$/);expect(f.sent).toHaveLength(0);
});
it("projects the frozen input without rebuilding and never sends request credentials",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);await f.binding.counter.count(prepared);
 expect(f.counted[0].body.input).toBe(prepared.body.input);expect(Object.isFrozen(f.counted[0].body)).toBe(true);
 expect(Object.keys(prepared.body)).not.toContain("headers");expect(JSON.stringify(prepared)).not.toContain("apiKey");
});
it("refuses a mutable same-value clone before counting any fields",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request),clone=structuredClone(prepared);
 await expect(f.binding.counter.count(clone)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.counted).toHaveLength(0);
});
it("refuses top-level frozen frames with mutable nested input",async()=>{
 const f=fixture(),prepared=f.binding.prepare(f.request),clone=structuredClone(prepared);Object.freeze(clone);Object.freeze(clone.body);
 await expect(f.binding.counter.count(clone)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.counted).toHaveLength(0);
});
it("refuses accessor input without invoking the accessor",()=>{
 const f=fixture();let touched=false;Object.defineProperty(f.request.messages[1],"content",{enumerable:true,get(){touched=true;throw Error("SYNTHETIC_DATA_READER")}});
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(touched).toBe(false);
});
it("refuses a misplaced tool-result anchor rather than silently dropping it",()=>{
 const f=fixture();f.request.messages[1].toolCallId="ignored-anchor";
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["responses","inputTokens"])("refuses foreign SDK resource ownership before invocation: %s",kind=>{
 const f=fixture(),foreign={baseURL:"https://foreign.invalid/v1",maxRetries:0};
 if(kind==="responses")(f.client.responses as any)._client=foreign;else (f.client.responses.inputTokens as any)._client=foreign;
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["responses","inputTokens","fetch","post","buildURL"])("rejects real SDK transport identity drift before count: %s",async kind=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);
 if(kind==="responses")(f.client.responses as any)._client={baseURL:"https://foreign.invalid/v1"};
 else if(kind==="inputTokens")(f.client.responses.inputTokens as any)._client={baseURL:"https://foreign.invalid/v1"};
 else (f.client as any)[kind]=()=>{throw Error("FOREIGN_TRANSPORT")};
 await expect(f.binding.counter.count(prepared)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it.each(["responses","inputTokens"])("actual SDK resource from another owner cannot cross the binding: %s",kind=>{
 const f=fixture(),foreignPost=vi.fn(),foreign={baseURL:"https://foreign.invalid/v1",maxRetries:0,post:foreignPost};
 if(kind==="responses")f.client.responses=new Responses(foreign as any);else f.client.responses.inputTokens=new Responses(foreign as any).inputTokens;
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(foreignPost).not.toHaveBeenCalled();
});
it.each(["debug","info","warn",undefined])("requires explicit SDK logging off before binding: %s",level=>{
 const f=fixture();(f.client as any).logLevel=level;
 expect(()=>createMainResponsesBinding(f.options)).toThrow("MEMORY_CONTEXT_COUNTER_UNSUPPORTED");expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("SDK debug cannot dump a frozen request even after an async continuation tries to enable it",async()=>{
 const f=fixture();let enabledDuringCount:boolean|undefined;
 (f.client.responses.inputTokens as any).count=async(body:unknown)=>{
  await Promise.resolve();enabledDuringCount=Reflect.set(f.client,"logLevel","debug");
  loggerFor(f.client as any).debug("synthetic SDK request",{options:{body}});
  return {object:"response.input_tokens",input_tokens:50};
 };
 const binding=createMainResponsesBinding(f.options)!,prepared=binding.prepare(f.request);
 expect(await binding.counter.count(prepared)).toBe(50);expect(enabledDuringCount).toBe(false);expect((f.client as any).logger.debug).not.toHaveBeenCalled();
});
it.each(["level","logger"])("SDK logging drift refuses count before invocation: %s",kind=>{
 const f=fixture(),prepared=f.binding.prepare(f.request);
 if(kind==="level")(f.client as any).logLevel="debug";else (f.client as any).logger={debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()};
 return expect(f.binding.counter.count(prepared)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED").then(()=>expect(f.counted).toHaveLength(0));
});
it("in-flight SDK ownership and transport cannot redirect an issued count",async()=>{
 const f=fixture();let attempts:boolean[]=[];
 (f.client.responses.inputTokens as any).count=async()=>{
  await Promise.resolve();attempts=[Reflect.set(f.client.responses.inputTokens,"_client",{baseURL:"https://foreign.invalid/v1"}),Reflect.set(f.client,"baseURL","https://foreign.invalid/v1"),Reflect.set(f.client,"fetch",()=>{throw Error("FOREIGN_FETCH")})];
  return {object:"response.input_tokens",input_tokens:50};
 };
 const binding=createMainResponsesBinding(f.options)!,prepared=binding.prepare(f.request);
 expect(await binding.counter.count(prepared)).toBe(50);expect(attempts).toEqual([false,false,false]);expect(f.sent).toHaveLength(0);
});
it.each(["nested-getter","toJSON-getter","toJSON-function","nested-toJSON","array-getter"])("schema validation refuses %s without executing caller code",kind=>{
 const f=fixture();let touched=0;const schema:any={type:"object",properties:{item:{type:"string"}}};
 if(kind==="nested-getter")Object.defineProperty(schema.properties,"item",{enumerable:true,get(){touched++;return {type:"string"}}});
 if(kind==="toJSON-getter")Object.defineProperty(schema,"toJSON",{get(){touched++;return ()=>({type:"object"})}});
 if(kind==="toJSON-function")Object.defineProperty(schema,"toJSON",{value:()=>{touched++;return {type:"object"}}});
 if(kind==="nested-toJSON")Object.defineProperty(schema.properties.item,"toJSON",{value:()=>{touched++;return {type:"string"}}});
 if(kind==="array-getter"){schema.required=["item"];Object.defineProperty(schema.required,"0",{enumerable:true,get(){touched++;return "item"}})}
 f.request.tools=[{name:"lookup",description:"synthetic lookup",parameters:schema}];
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(touched).toBe(0);expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("serializer consumes only the validated detached data copy",()=>{
 const f=fixture(),schema={type:"object",properties:{item:{type:"string"}}};f.request.tools=[{name:"lookup",description:"synthetic lookup",parameters:schema}];
 const adapter=getAdapterForConfig({...f.config,apiKey:""}),serialize=adapter.buildRequest.bind(adapter);let input:ChatRequest|undefined;
 const spy=vi.spyOn(adapter,"buildRequest").mockImplementation((request,cfg)=>{input=request;return serialize(request,cfg)});
 try{const prepared=f.binding.prepare(f.request);expect(input).not.toBe(f.request);expect(input?.tools?.[0].parameters).not.toBe(schema);expect(input?.tools?.[0].parameters).toEqual(schema);expect(prepared.body.tools).toBeDefined()}finally{spy.mockRestore()}
});
it("actual SDK count/create resources consume the frozen body only through the fixed official owner",async()=>{
 const f=fixture(),destinations:string[]=[];
 (f.client as any).post=(route:string,options:any)=>{
  destinations.push(f.client.baseURL+route);
  if(route==="/responses/input_tokens"){f.counted.push({body:options.body,options});return Promise.resolve({object:"response.input_tokens",input_tokens:50})}
  if(route==="/responses"){f.sent.push({body:options.body,options});const response=Promise.resolve({synthetic:true});return Object.assign(response,{_thenUnwrap:(transform:(value:unknown)=>unknown)=>response.then(transform)})}
  throw Error("UNVERIFIED_ROUTE");
 };
 f.client.responses=new Responses(f.client as any);f.binding=createMainResponsesBinding(f.options)!;
 const ctx=await contextFixture(f),snapshot=await ctx.assemble(),permit=await ctx.context.validateForDispatch(ctx.actor,snapshot);
 expect((await f.binding.dispatch(ctx.context,ctx.actor,permit)).status).toBe("sent");
 expect(destinations.every(url=>url==="https://api.openai.com/v1/responses/input_tokens"||url==="https://api.openai.com/v1/responses")).toBe(true);
 expect(f.sent).toHaveLength(1);expect(Object.isFrozen(f.sent[0].body)).toBe(true);expect(f.counted.some(c=>c.body.input===f.sent[0].body.input)).toBe(true);
 expect((f.client as any).logger.debug).not.toHaveBeenCalled();
 await expect(f.binding.dispatch(ctx.context,ctx.actor,permit)).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(f.sent).toHaveLength(1);
});
it.each(["tools","toolChoiceIntent","temperature","topP","stream"])("explicit undefined optional request field matches omission: %s",async key=>{
 const f=fixture(),request={...f.request};delete (request as any)[key];const omitted=f.binding.prepare(request);
 (request as any)[key]=undefined;const explicit=f.binding.prepare(request);
 expect(explicit).toEqual(omitted);await f.binding.counter.count(explicit);expect(f.counted).toHaveLength(1);expect(f.sent).toHaveLength(0);
});
it.each(["toolCalls","toolCallId","name"])("explicit undefined optional message field matches omission: %s",key=>{
 const f=fixture(),omitted=f.binding.prepare(f.request);(f.request.messages[1] as any)[key]=undefined;
 expect(f.binding.prepare(f.request)).toEqual(omitted);
});
it.each(["request","message","tool","schema","array","mandatory","output"])("undefined outside allowed optional fields still refuses before SDK access: %s",kind=>{
 const f=fixture();
 if(kind==="request")(f.request as any).unknown=undefined;
 if(kind==="message")(f.request.messages[1] as any).unknown=undefined;
 if(kind==="tool")f.request.tools=[{name:"lookup",description:"synthetic",parameters:{},unknown:undefined} as any];
 if(kind==="schema")f.request.tools=[{name:"lookup",description:"synthetic",parameters:{type:"object",properties:{temperature:undefined}}}];
 if(kind==="array")(f.request.messages as any)[1]=undefined;
 if(kind==="mandatory")(f.request as any).model=undefined;
 if(kind==="output")f.request.maxTokens=undefined;
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(f.counted).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it("an optional getter returning undefined is rejected without invoking it",()=>{
 const f=fixture();let touched=false;Object.defineProperty(f.request,"tools",{enumerable:true,get(){touched=true;return undefined}});
 expect(()=>f.binding.prepare(f.request)).toThrow();expect(touched).toBe(false);expect(f.counted).toHaveLength(0);
});
