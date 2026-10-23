import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {createSmhFixture} from "./smh-fixture.test-support";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createTranscriptSink} from "../orchestrator/transcript-sink";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainSRuntimePort} from "./main-s-runtime-port";
import {createMainResponsesBinding,createMainResponsesLimits,type ResponsesSdkClient} from "./main-responses-binding";
import {createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import {createMainFactSelector} from "../memory-recall/main-fact-selector";

vi.mock("electron",()=>({app:{getPath:()=>{throw Error("PRODUCT_DATA_FORBIDDEN")}}}));
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllGlobals()});
async function fixture(facts=false,captureOnly=false,revisionOffset=0){
 const root=path.join(os.tmpdir(),`s1-synthetic-${randomUUID()}`),f=createSmhFixture(root);
 vi.stubGlobal("fetch",()=>{throw Error("NETWORK_FORBIDDEN")});
 let adapter:NonNullable<ReturnType<typeof createConversationTranscriptAdapter>>;
 cleanups.push(async()=>{await adapter?.close();f.close();fs.rmSync(root,{recursive:true,force:true})});
 const sent:unknown[]=[],counted:unknown[]=[];
 const client={baseURL:"https://api.openai.com/v1",maxRetries:0,logLevel:"off",logger:{},fetch:()=>{throw Error("NETWORK_FORBIDDEN")},responses:{inputTokens:{count:async(body:unknown)=>{counted.push(body);return {object:"response.input_tokens",input_tokens:40}}},create:async(body:unknown)=>{sent.push(body);return {status:"completed"}}}} as unknown as ResponsesSdkClient;
 Object.assign(client.responses,{_client:client});Object.assign(client.responses.inputTokens,{_client:client});
 const binding=createMainResponsesBinding({enabled:true,client,limits:createMainResponsesLimits({model:"fixture-model",limitsSource:"fixture://current-turn",modelMaxOutputTokens:512,budget:{maxContextTokens:20000,reservedOutputTokens:128,safetyMarginTokens:16,maxSTokens:4000,minRecentCompleteTurns:1}}),configuration:()=>({revision:1,config:{provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"fixture-model",explicitTransport:"responses"}})})!;
 const store=new ConversationTranscriptStore(path.join(root,"conversation"));
 const port=createMainSRuntimePort({enabled:true,clock:()=>1700000000000,registry:f.registry,transport:f.transport,actorAuthority:f.actorAuthority,actorToken:f.actor,binding,
  ...(facts?{facts:{currentUserSource:async({userTurnId})=>f.registry.capture(f.access,f.adapter,{...f.identity,messageId:userTurnId}),coordinator:createMainUserFactCoordinator({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy}),selector:createMainFactSelector({actorAuthority:f.actorAuthority,registry:f.registry,policy:f.policy,recall:f.recall}),limits:{maxFacts:8}}}:{}),
  createTranscript:context=>{adapter=createConversationTranscriptAdapter({enabled:true,store,context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;return captureOnly?{captureTurns:adapter.captureTurns}:{...adapter,captureRun:async(runId?:string)=>{const capture=await adapter.captureRun(runId);return {...capture,userRevision:capture.userRevision+revisionOffset}}}}
 })!;
 async function user(id:string,text:string,at:number){await store.append("session-a",{id,turnId:id,revision:1,kind:"user",at,payload:{text}});return f.source(text,{messageId:id,occurredAt:at})}
 const first=await user("u1","I prefer English",1000);await f.policy.integrate(f.actor,first.ref);
 const current=await user("u2","I prefer bash",2000),result=await f.policy.integrate(f.actor,current.ref),factId=result.items[0].factId!;
 async function forget(){const event=await f.policy.event(f.actor,{kind:"forget",nonce:randomUUID(),factId,revision:1});await f.policy.act(f.actor,event)}
 const request={model:"fixture-model",messages:[{role:"system" as const,content:"fixed"}],maxTokens:128,stream:false};
 function stream(){const sink=createTranscriptSink({store,conversationId:"session-a",runId:"run-current",assistantTurnId:"assistant-current"});return {request:{...request,stream:true},stream:{conversationId:"session-a",runId:"run-current",userTurnId:"u2",assistantTurnId:"assistant-current",sink,onEvent:()=>{},isCurrent:()=>true}}}
 return {...f,store,port,sent,counted,user,forget,request,stream};
}
it("controlled context keeps persisted memory values out of system authority",async()=>{
 const f=await fixture(true);expect((await f.port.run({request:f.request})).status).toBe("sent");
 const body=f.sent[0] as {input:Array<{role:string;content:unknown}>};
 const memory=body.input.find(message=>JSON.stringify(message.content).includes("User-stated memory"));
 expect(memory?.role).toBe("user");
 expect(body.input.filter(message=>["system","developer"].includes(message.role)).every(message=>!JSON.stringify(message.content).includes("I prefer bash"))).toBe(true);
});
it.each([false,true])("normal policy forget denies current-turn dispatch with facts=%s",async facts=>{
 const f=await fixture(facts);await f.forget();
 await expect(f.port.run(f.stream())).rejects.toThrow("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");
 expect(f.sent).toHaveLength(0);expect((await f.store.read("session-a")).entries.filter(e=>e.kind==="assistant"||e.kind==="assistant_settlement")).toEqual([]);
 expect((await f.policy.recall(f.actor)).map(fact=>fact.assertion)).toEqual(["I prefer English"]);
});
it("captureTurns-only nonstream boundary cannot answer the remaining older turn after forget",async()=>{
 const f=await fixture(false,true);await f.forget();await expect(f.port.run({request:f.request})).rejects.toThrow("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");expect(f.sent).toHaveLength(0);
});
it.each([false,true])("captured current user revision must match canonical provenance with facts=%s",async facts=>{
 const f=await fixture(facts,false,1);await expect(f.port.run(f.stream())).rejects.toThrow("MEMORY_CONTEXT_STREAM_TURN_STALE");expect(f.sent).toHaveLength(0);
});
it.each([false,true])("new turn after forget sends current text without reviving suppressed history with facts=%s",async facts=>{
 const f=await fixture(facts);await f.forget();await f.user("u3","Explain the next command",3000);
 expect((await f.port.run({request:f.request})).status).toBe("sent");expect(f.sent).toHaveLength(1);
 const body=JSON.stringify(f.sent[0]);expect(body).toContain("Explain the next command");expect(body).not.toContain("I prefer bash");
});
it("a suppressed current unit rewritten at a new revision remains excluded",async()=>{
 const f=await fixture();await f.forget();await f.store.append("session-a",{id:"edit-current",at:3000,kind:"turn_rewind",turnId:"u2",revision:2,payload:{anchorUserTurnId:"u2",disposition:"replace_user",reason:"edit",replacementUser:{text:"I prefer bash"}}});
 await expect(f.port.run(f.stream())).rejects.toThrow("MEMORY_CONTEXT_SOURCE_UNAVAILABLE");expect(f.sent).toHaveLength(0);
});
it.each([false,true])("a safe revised current user unit is sent at its canonical revision with facts=%s",async facts=>{
 const f=await fixture(facts);await f.store.append("session-a",{id:"edit-current",at:3000,kind:"turn_rewind",turnId:"u2",revision:2,payload:{anchorUserTurnId:"u2",disposition:"replace_user",reason:"edit",replacementUser:{text:"Explain the revised command"}}});
 f.write({...f.identity,messageId:"u2"},{text:"Explain the revised command",role:"user",trust:"direct-user-event",occurredAt:3000});
 expect((await f.port.run({request:f.request})).status).toBe("sent");expect(f.sent).toHaveLength(1);expect(JSON.stringify(f.sent[0])).toContain("Explain the revised command");expect(JSON.stringify(f.sent[0])).not.toContain("I prefer bash");
});
