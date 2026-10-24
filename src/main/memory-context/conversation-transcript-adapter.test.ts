import fs from "node:fs";
import path from "node:path";
import {expect,it,vi} from "vitest";
vi.mock("electron",()=>({app:{getPath:()=>""},shell:{openPath:vi.fn()}}));
import {createRunAdjustmentPoller,bindRunAdjustmentPoller} from "../chats/pending-adjustment";
import type {PendingChatMessage} from "../../shared/chat-types";
import os from "node:os";
import {randomBytes} from "node:crypto";
import {afterEach} from "vitest";
import {openMemoryRepository} from "../memory-core/repository";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {createMainPolicy} from "../memory-policy/main-policy";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import {createMainContext} from "./main-context";
import {SyntheticSourceProvider} from "../../../scripts/verify/memory-sources/synthetic-provider";

import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainAttachmentProjectionAuthority,prepareMainAttachmentProjection} from "./main-attachment-projection";
import type {TranscriptAppendInput} from "../orchestrator/conversation-transcript-types";


const owned:Array<{root:string;repo:ReturnType<typeof openMemoryRepository>}>=[];
afterEach(()=>{
 for(const resource of owned.splice(0)){resource.repo.close();fs.rmSync(resource.root,{recursive:true,force:true})}
});
async function contextFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"s-transcript-adapter-"));
 const repo=openMemoryRepository({databasePath:path.join(root,"memory.sqlite"),key:randomBytes(32)});
 owned.push({root,repo});let writes=0;
 const actorAuthority=createMainActorAuthority({resolveActor:()=>"actor-a"});
 const transport={
  sourceCommand:async(command:unknown)=>{writes++;return repo.sourceCommand(command)},
  policyCommand:async(command:unknown)=>repo.policyCommand(command),
  contextCommand:async(command:unknown)=>{writes++;return repo.contextCommand(command)}
 };
 const registry=createMainSourceRegistry(transport,{coordinate:actorAuthority.coordinate});
 const provider=new SyntheticSourceProvider(path.join(root,"provider.json"),"scope-a");
 const access=registry.authority.access("scope-a"),identity={providerId:"synthetic",sessionId:"session-a",messageId:"binding"};
 const policy=createMainPolicy({registry,transport,resolveActor:()=>"actor-a",actorAuthority});
 const actor=policy.bindActor(access,provider.adapter,identity);
 const requestIdentity={providerId:"synthetic",model:"fixture-only",transport:"synthetic",framingVersion:"v1"};
 const prepare:Parameters<typeof createMainContext>[0]["prepare"]=units=>({
  ...requestIdentity,inputTypes:["text"],body:{messages:JSON.parse(JSON.stringify(units.flatMap(unit=>unit.messages)))}
 });
 const context=createMainContext({
  registry,transport,actorAuthority,prepare,prepareS:units=>prepare(units,[]),
  counter:{capability:{...requestIdentity,mode:"exact",inputTypes:["text"]},count:async request=>JSON.stringify(request.body).length},
  budget:{maxContextTokens:100000,reservedOutputTokens:64,safetyMarginTokens:16,maxSTokens:10000,minRecentCompleteTurns:1}
 });
 return {root,repo,actorAuthority,access,identity,provider,policy,actor,context,transport,registry,get writes(){return writes}};
}

const user=(id="u1",text="synthetic user"):TranscriptAppendInput=>({id,at:1000,kind:"user",turnId:id,revision:1,payload:{text}});
async function fixture(beforeMutation?:Parameters<typeof createConversationTranscriptAdapter>[0]["beforeMutation"],attachmentProjection?:object){
 const f=await contextFixture(),store=new ConversationTranscriptStore(path.join(f.root,"conversation"));
 await store.append("session-a",user());
 const adapter=createConversationTranscriptAdapter({enabled:true,store,context:f.context,actorAuthority:f.actorAuthority,actorToken:f.actor,beforeMutation,attachmentProjection})!;
 const capture=()=>adapter.capture();
 const assemble=async()=>f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[await capture()]});
 return {...f,store,adapter,capture,assemble};
}
it("is disabled by default before touching its dependencies",()=>{
 let touched=false;
 const options=new Proxy({},{get:(_target,key)=>{if(key==="enabled")return undefined;touched=true;throw new Error("must not access")}});
 expect(createConversationTranscriptAdapter(options as Parameters<typeof createConversationTranscriptAdapter>[0])).toBeNull();
 expect(touched).toBe(false);
});
it("denies a temporary actor before store or worker access",async()=>{
 const f=await contextFixture(),root=path.join(f.root,"never-created"),store=new ConversationTranscriptStore(root);
 const actor=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),before=f.writes;
 expect(()=>createConversationTranscriptAdapter({enabled:true,store,context:f.context,actorAuthority:f.actorAuthority,actorToken:actor})).toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
 expect(f.writes).toBe(before);expect(fs.existsSync(root)).toBe(false);
});
it("preserves ordered roles and complete canonical tool calls without promoting M",async()=>{
 const f=await fixture(),calls=[{id:"call-a",name:"read_file",arguments:'{"path":"synthetic.txt"}'}];
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:calls}});
 await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"synthetic result",toolCallId:"call-a",name:"read_file"}}});
 await f.store.append("session-a",{id:"a2",at:1003,kind:"assistant",payload:{role:"assistant",content:"done"}});
 const snapshot=await f.assemble();
 expect(snapshot.request.body.messages).toEqual([
  {role:"user",text:"synthetic user"},
  {role:"assistant",text:"checking",toolCallIds:["call-a"],toolCalls:calls},
  {role:"tool",text:"synthetic result",toolCallId:"call-a",name:"read_file"},
  {role:"assistant",text:"done"}
 ]);
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("refuses missing tool results instead of inventing executed results",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"",toolCalls:[{id:"call-a",name:"read_file",arguments:"{}"}]}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("preserves actual provider reasoning and local metadata without promoting M",async()=>{
 const f=await fixture(),rawAssistant=[{type:"thinking",thinking:"opaque",signature:"synthetic-signature"},{type:"text",text:"text"}],internal={kind:"state_delta" as const,revision:1,digest:"synthetic-digest",id:"internal-1",runId:"run-a",createdAt:1001};
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"text",thinking:"opaque",rawAssistant,visibility:"internal",internal}});
 const snapshot=await f.assemble();
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"synthetic user"},{role:"assistant",text:"text",thinking:"opaque",rawAssistant,visibility:"internal",internal}]);
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("binds the adapter to the Main actor session",async()=>{
 const f=await fixture();
 await f.store.append("session-b",user("foreign","FOREIGN_SESSION_CANARY"));
 expect(JSON.stringify((await f.assemble()).request)).not.toContain("FOREIGN_SESSION_CANARY");
});
it.each(["append","edit","regenerate","delete"] as const)("%s invalidates an old snapshot and permit before any sender invocation",async kind=>{
 const f=await fixture(),snapshot=await f.assemble(),permit=await f.context.validateForDispatch(f.actor,snapshot);
 if(kind==="append")await f.store.append("session-a",user("u2","second"));
 else if(kind==="delete")await f.store.deleteConversation("session-a");
 else await f.store.append("session-a",kind==="edit"
  ?{id:"rewind",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited"}}}
  :{id:"rewind",at:1001,kind:"turn_rewind",payload:{anchorUserTurnId:"u1",disposition:"keep_user",reason:"regenerate"}});
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow();
 let sent=0;await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"})).rejects.toThrow();
 expect(sent).toBe(0);
 if(kind!=="delete"){
  const fresh=await f.assemble();
  const messages=fresh.request.body.messages as Array<{text:string}>;
  expect(messages[0].text).toBe(kind==="edit"?"edited":"synthetic user");
 }
});
it("recreation cannot revive a pre-deletion capability",async()=>{
 const f=await fixture(),old=await f.assemble();
 await f.store.deleteConversation("session-a");await f.store.append("session-a",user());
 const fresh=await f.assemble();
 expect(fresh.requestDigest).toBe(old.requestDigest);
 await expect(f.context.validateForDispatch(f.actor,old)).rejects.toThrow();
 expect(await f.context.validateForDispatch(f.actor,fresh)).toBeTypeOf("object");
});
it("invalidates the latest dependency recaptured by permit validation",async()=>{
 const f=await fixture(),snapshot=await f.assemble();
 await f.context.validateForDispatch(f.actor,snapshot);
 await f.store.append("session-a",user("u2","changed after recount"));
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow();
});
it("disposal revokes captured dependencies before releasing its observer",async()=>{
 const f=await fixture(),snapshot=await f.assemble();
 await f.adapter.close();
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_ADAPTER_CLOSED");
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow();
 await f.store.append("session-a",user("u2","ordinary store remains usable"));
});
it("tool argument secrets cannot enter an S snapshot",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"",toolCalls:[{id:"call-a",name:"read_file",arguments:"api_key=SECRET_CANARY_1234567890"}]}});
 await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a"}}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
});

it("refuses tool result names that disagree with their canonical call",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"",toolCalls:[{id:"call-a",name:"read_file",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a",name:"different_tool"}}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("refuses unknown tool-call fields instead of copying them into S",async()=>{
 const f=await fixture(),call={id:"call-a",name:"read_file",arguments:"{}",apiKey:"EXTRA_TOOL_CANARY"};
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"",toolCalls:[call]}});
 await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a"}}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});

it.each([
 ["original","image"],["original","document"],
 ["replacement","image"],["replacement","document"]
] as const)("refuses %s user %s attachments before materialization",async(origin,kind)=>{
 const f=await fixture(),payload={text:"edited synthetic text",attachments:[{kind,name:"synthetic attachment",filePath:path.join(f.root,"never-read-attachment")}]};
 await f.store.append("session-a",origin==="original"
  ?{...user("u2"),payload}
  :{id:"rewind-rich",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:payload}});
 await expect(f.capture()).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
 await expect(f.assemble()).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
 expect(fs.existsSync(payload.attachments[0].filePath)).toBe(false);
});
it("preserves replacement text with an explicitly empty attachment list",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"rewind-empty",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited synthetic text",attachments:[]}}});
 expect((await f.assemble()).request.body.messages).toEqual([{role:"user",text:"edited synthetic text"}]);
});
it("refuses replacement text containing unsupported content blocks",async()=>{
 const f=await fixture();
 const malformed={text:[{type:"image",url:"synthetic-only"}]} as unknown as {text:string};
 await f.store.append("session-a",{id:"rewind-blocks",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:malformed}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_FORMAT_UNSUPPORTED");
});

it("captures each active complete turn separately under the store lease",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"first answer"}});
 await f.store.append("session-a",user("u2","second user"));
 const turns=await f.adapter.captureTurns();
 expect(turns).toHaveLength(2);
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:turns});
 expect(snapshot.selectedIds).toHaveLength(2);
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"synthetic user"},{role:"assistant",text:"first answer"},{role:"user",text:"second user"}]);
});
it("invalidates every published turn and view after recapture and a mutation",async()=>{
 const f=await fixture();await f.store.append("session-a",user("u2","second"));
 const turns=await f.adapter.captureTurns(),snapshots=[];
 for(const turn of turns)snapshots.push(await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[turn]}));
 const permits=[];for(const snapshot of snapshots)permits.push(await f.context.validateForDispatch(f.actor,snapshot));
 await f.adapter.captureTurns();await f.store.append("session-a",user("u3","third"));
 let sends=0;for(const permit of permits)await expect(f.context.dispatch(f.actor,permit,()=>{sends++})).rejects.toThrow();
 expect(sends).toBe(0);
});
it("selects the latest complete turn with an exact budget instead of retaining the entire conversation",async()=>{
 const f=await fixture();await f.store.append("session-a",{id:"long",at:1001,kind:"assistant",payload:{role:"assistant",content:"large history ".repeat(900)}});
 await f.store.append("session-a",user("u2","latest"));
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:await f.adapter.captureTurns()});
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"latest"}]);
 expect(snapshot.selectedIds).toHaveLength(1);
});

it("early observation never grants current epochs to historical backfill after forget",async()=>{
 const f=await contextFixture(),id={...f.identity,messageId:"old-preference"};f.provider.write(id,{text:"I prefer PowerShell",role:"user",trust:"direct-user-event"});
 const ref=await f.registry.capture(f.access,f.provider.adapter,id),fact=await f.policy.ingest(f.actor,ref);
 await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"forget",nonce:"forget-before-backfill",factId:fact.factId,revision:1}));
 const store=new ConversationTranscriptStore(path.join(f.root,"conversation")),adapter=createConversationTranscriptAdapter({enabled:true,store,context:f.context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
 await store.append("session-a",{...user("old-user","I prefer PowerShell"),id:"backfill:v1:old-user"});
 await store.append("session-a",{id:"backfill:v1:old-assistant",at:1001,kind:"assistant",payload:{role:"assistant",content:"OLD_BACKFILL_REPLY"}});
 await store.append("session-a",user("fresh-user","fresh ordinary question"));
 try{
  const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:await adapter.captureTurns()});
  expect(snapshot.request.body.messages).toEqual([{role:"user",text:"fresh ordinary question"}]);expect(await f.policy.recall(f.actor)).toEqual([]);
 }finally{await adapter.close()}
});


it("preserves supported content blocks and canonical call-result authority",async()=>{
 const f=await fixture(),content=[{type:"text" as const,text:"图像结果"},{type:"image_url" as const,image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}],calls=[{id:"call-a",name:"inspect_image",arguments:"{}"}];
 await f.store.append("session-a",{id:"a1",runId:"run-a",at:1001,kind:"assistant",payload:{role:"assistant",content,toolCalls:calls}});
 await f.store.append("session-a",{id:"t1",runId:"run-a",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content,toolCallId:"call-a",name:"inspect_image"}}});
 const snapshot=await f.assemble();
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"synthetic user"},{role:"assistant",text:"图像结果",content,toolCalls:calls,toolCallIds:["call-a"]},{role:"tool",text:"图像结果",content,toolCallId:"call-a",name:"inspect_image"}]);
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it.each([
 {thinking:"api_key=SECRET_CANARY_1234567890"},
 {rawAssistant:[{type:"thinking",thinking:"api_key=SECRET_CANARY_1234567890"}]},
 {rawAssistant:[{type:"tool_use",id:"call-a",name:"read_file",input:{password:"SECRET_CANARY_1234567890"}}],toolCalls:[{id:"call-a",name:"read_file",arguments:'{"password":"SECRET_CANARY_1234567890"}'}]},
 {content:[{type:"text",text:"api_key=SECRET_CANARY_1234567890"}]}
])("rejects secrets in all rich message fields: %j",async fields=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a1",at:1001,kind:"assistant",payload:{role:"assistant",content:"public text",...fields} as any});
 if(fields.toolCalls)await f.store.append("session-a",{id:"t1",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a"}}});
 await expect(f.capture()).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("does not treat code field names as persisted secrets or user facts",async()=>{
 const f=await fixture();
 await f.store.append("session-a",user("u2","Explain the api_key, password, and access_token fields."));
 expect(JSON.stringify((await f.assemble()).request.body)).toContain("access_token");
 expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("requires an explicitly opened same-run continuation and preserves old run reuse rejection",async()=>{
 const f=await fixture();
 await expect(f.adapter.captureRunRound("run-a")).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
 await f.adapter.captureRun("run-a");
 await f.store.append("session-a",{id:"a1",runId:"run-a",at:1001,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:[{id:"call-a",name:"read_file",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t1",runId:"run-a",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a"}}});
 await expect(f.adapter.captureRun("run-a")).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
 const second=await f.adapter.captureRunRound("run-a");
 expect(second.userTurnId).toBe("u1");expect(second.throughSeq).toBe(3);
 await f.store.append("session-a",{id:"a2",runId:"run-a",at:1003,kind:"assistant",payload:{role:"assistant",content:"checking again",toolCalls:[{id:"call-b",name:"read_file",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t2",runId:"run-a",at:1004,kind:"tool_result",payload:{assistantEntryId:"a2",toolCallId:"call-b",outcome:"success",message:{role:"tool",content:"second result",toolCallId:"call-b"}}});
 const third=await f.adapter.captureRunRound("run-a");
 expect(third.throughSeq).toBe(5);
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:third.transcriptTokens});
 expect((snapshot.request.body.messages as any[]).map(message=>message.role)).toEqual(["user","assistant","tool","assistant","tool"]);
});
it.each(["new-user","edit","delete","interruption"] as const)("rejects same-run continuation after %s",async kind=>{
 const f=await fixture();await f.adapter.captureRun("run-a");
 if(kind==="new-user")await f.store.append("session-a",user("u2"));
 else if(kind==="edit")await f.store.append("session-a",{id:"rewind-round",at:1001,kind:"turn_rewind",turnId:"u1",revision:2,payload:{anchorUserTurnId:"u1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited"}}});
 else if(kind==="delete"){await f.store.deleteConversation("session-a");await f.store.append("session-a",user())}
 else await f.store.append("session-a",{id:"interruption",at:1001,runId:"run-a",kind:"interruption",payload:{reason:"user_cancel"}});
 await expect(f.adapter.captureRunRound("run-a")).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
});


async function adjustmentFixture(beforeMutation?:Parameters<typeof createConversationTranscriptAdapter>[0]["beforeMutation"],assertCurrent?:()=>void) {
 const f=await fixture(beforeMutation);await f.adapter.captureRun("run-a");
 await f.store.append("session-a",{id:"a1",runId:"run-a",at:1001,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:[{id:"call-a",name:"read_file",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t1",runId:"run-a",at:1002,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call-a",outcome:"success",message:{role:"tool",content:"result",toolCallId:"call-a"}}});
 const boundary=await f.adapter.captureRunRound("run-a");
 let queue:PendingChatMessage[]=[{id:"adjust-1",rawContent:"also include detail",visibleContent:"also include detail",enqueuedAt:1003,adjustRunId:"run-a"}],failCommit=false,commits=0;
 const poll=createRunAdjustmentPoller("session-a","run-a",{
  getPendingMessages:()=>queue,
  commitPendingAdjust:(_session,id)=>{commits++;if(failCommit)return {ok:false,error:"write-failed"};queue=[];return {ok:true,userMessage:{id},remainingQueue:[]}},
 });
 bindRunAdjustmentPoller(poll,{sessionId:"session-a",runId:"run-a"},(permit,commit)=>f.adapter.commitRunAdjustment("run-a",permit,{throughSeq:boundary.throughSeq,mutationRevision:boundary.mutationRevision,...(assertCurrent?{assertCurrent}:{})},commit));
 return {...f,boundary,poll,get queue(){return queue},get commits(){return commits},failCommit:(value:boolean)=>{failCommit=value}};
}
it("transfers a complete run to a genuine marked adjustment without reviving its prior frame",async()=>{
 const f=await adjustmentFixture();
 expect(await f.poll()).toEqual([{id:"adjust-1",rawContent:"also include detail"}]);
 expect(f.queue).toEqual([]);expect(f.commits).toBe(1);
 const current=await f.adapter.captureRunRound("run-a");
 expect(current.userTurnId).toBe("adjust-1");expect(current.userRevision).toBe(1);
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:current.transcriptTokens});
 expect((snapshot.request.body.messages as any[]).map(message=>message.role)).toEqual(["user","assistant","tool","user"]);
 expect(()=>f.boundary.assertCurrent()).toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
 await f.store.append("session-a",user("untrusted-user"));
 await expect(f.adapter.captureRunRound("run-a")).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
});
it("retries only its exact partial canonical adjustment after a history commit failure",async()=>{
 const f=await adjustmentFixture();f.failCommit(true);
 await expect(f.poll()).rejects.toThrow("PENDING_ADJUST_COMMIT_FAILED");
 expect(f.queue).toHaveLength(1);
 expect((await f.store.read("session-a")).entries.filter(entry=>entry.turnId==="adjust-1")).toHaveLength(1);
 await expect(f.adapter.captureRunRound("run-a")).rejects.toThrow("MEMORY_CONTEXT_STREAM_RUN_REUSED");
 f.failCommit(false);expect(await f.poll()).toHaveLength(1);
 expect((await f.store.read("session-a")).entries.filter(entry=>entry.turnId==="adjust-1")).toHaveLength(1);
 expect((await f.adapter.captureRunRound("run-a")).userTurnId).toBe("adjust-1");
 expect(f.queue).toEqual([]);expect(f.commits).toBe(2);
});
it.each(["append","edit","delete"] as const)("rejects a partial adjustment retry after unrelated %s without consuming pending",async kind=>{
 const f=await adjustmentFixture();f.failCommit(true);await expect(f.poll()).rejects.toThrow("PENDING_ADJUST_COMMIT_FAILED");
 if(kind==="append")await f.store.append("session-a",user("external-user"));
 else if(kind==="delete")await f.store.deleteConversation("session-a");
 else await f.store.append("session-a",{id:"edit",at:1004,kind:"turn_rewind",turnId:"adjust-1",revision:2,payload:{anchorUserTurnId:"adjust-1",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited"}}});
 f.failCommit(false);await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_ADJUSTMENT_STALE");
 expect(f.queue).toHaveLength(1);expect(f.commits).toBe(1);
});
it("rejects forged adjustment permits before canonical or history writes",async()=>{
 const f=await adjustmentFixture(),before=await f.store.read("session-a"),commit=vi.fn();
 await expect(f.adapter.commitRunAdjustment("run-a",{} as never,f.boundary,commit)).rejects.toThrow("MEMORY_CONTEXT_ADJUSTMENT_DENIED");
 expect(await f.store.read("session-a")).toEqual(before);expect(commit).not.toHaveBeenCalled();
});
it("rejects an obsolete adjustment boundary before queue commit",async()=>{
 const f=await adjustmentFixture();await f.store.append("session-a",user("external-user"));
 await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_ADJUSTMENT_STALE");
 expect(f.queue).toHaveLength(1);expect(f.commits).toBe(0);
 expect((await f.store.read("session-a")).entries.some(entry=>entry.turnId==="adjust-1")).toBe(false);
});

it("revalidates Main lifecycle after async mutation work before writing an adjustment",async()=>{
 const controller=new AbortController();let armed=false;
 const f=await adjustmentFixture(async()=>{if(armed)controller.abort()},()=>{if(controller.signal.aborted)throw new Error("MEMORY_CONTEXT_CANCELLED")});
 const before=await f.store.read("session-a");armed=true;
 await expect(f.poll()).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
 expect(await f.store.read("session-a")).toEqual(before);expect(f.queue).toHaveLength(1);expect(f.commits).toBe(0);
});

it.each(["original","replacement"])("projects authorized %s attachment blocks while current user text stays original",async origin=>{
 const authority=createMainAttachmentProjectionAuthority(),f=await fixture(undefined,authority.token);
 const attachments=[{kind:"document" as const,name:"synthetic.txt",filePath:"/synthetic/not-read.txt"}],text="I prefer PowerShell",revision=origin==="original"?1:2,turnId=origin==="original"?"u2":"u1";
 const grant=authority.issue({sessionId:"session-a",userTurnId:turnId,userRevision:revision,userText:text,attachments,assertCurrent(){}});
 await prepareMainAttachmentProjection(grant,async()=>[{type:"text",text:"I prefer attachment-only-zsh"}]);
 await f.store.append("session-a",origin==="original"?{...user(turnId,text),payload:{text,attachments}}:{id:"authorized-edit",kind:"turn_rewind",at:1001,turnId,revision,payload:{anchorUserTurnId:turnId,disposition:"replace_user",reason:"edit",replacementUser:{text,attachments}}});
 const current=await f.adapter.captureRun("authorized-run");expect(current.userText).toBe(text);
 const snapshot=await f.assemble();expect(JSON.stringify(snapshot.request.body)).toContain("attachment-only-zsh");
 expect(await f.policy.recall(f.actor)).toEqual([]);authority.revokeTurn("session-a",turnId);expect(current.assertCurrent).toThrow("MEMORY_ATTACHMENT_DENIED");
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
});
it("retains an explicit unavailable historical attachment notice without reading any file",async()=>{
 const f=await fixture();await f.store.append("session-a",{...user("old","old human text"),payload:{text:"old human text",attachments:[{kind:"image",name:"unread.png",filePath:"/unread-history.png"}]}});
 await f.store.append("session-a",user("new","new question"));
 const snapshot=await f.assemble();expect(JSON.stringify(snapshot.request.body)).toContain("old human text");expect(JSON.stringify(snapshot.request.body)).toContain("MEMORY_ATTACHMENT_HISTORY_UNAVAILABLE");
 expect((await f.adapter.captureRun()).userText).toBe("new question");
});

it("retires only projected S versions for caption fallback while canonical user bytes and revisions stay unchanged",async()=>{
 const {reprepareMainAttachmentProjection}=await import("./main-attachment-projection");
 const authority=createMainAttachmentProjectionAuthority(),f=await fixture(undefined,authority.token),attachments=[{kind:"image" as const,name:"bound.png",filePath:"/synthetic/bound.png"}];
 const grant=authority.issue({sessionId:"session-a",userTurnId:"image-user",userRevision:1,userText:"human image question",attachments,assertCurrent(){}});
 await prepareMainAttachmentProjection(grant,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);
 await f.store.append("session-a",{...user("image-user","human image question"),payload:{text:"human image question",attachments}});
 const raw=JSON.stringify(await f.store.read("session-a")),current=await f.adapter.captureRun("image-run"),first=await f.assemble(),oldPermit=await f.context.validateForDispatch(f.actor,first);
 await reprepareMainAttachmentProjection(grant,async()=>[{type:"text",text:"authorized caption"}]);
 expect(current.assertCurrent).toThrow();const next=await f.adapter.captureRunRound("image-run");expect(next).toMatchObject({userRevision:1,userText:"human image question"});
 let sends=0;await expect(f.context.dispatch(f.actor,oldPermit,()=>{sends++;return "old image"})).rejects.toThrow();expect(sends).toBe(0);
 const fresh=await f.assemble();expect(JSON.stringify(fresh.request.body)).toContain("authorized caption");expect(JSON.stringify(fresh.request.body)).not.toContain("data:image");expect(fresh.snapshotId).not.toBe(first.snapshotId);
 expect(JSON.stringify(await f.store.read("session-a"))).toBe(raw);
 // A subsequent genuine edit advances physical user provenance, without confusing it with projection versions.
 const edited=authority.issue({sessionId:"session-a",userTurnId:"image-user",userRevision:2,userText:"edited human",attachments,assertCurrent(){}});
 await prepareMainAttachmentProjection(edited,async()=>[{type:"text",text:"new authorized attachment"}]);
 await f.store.append("session-a",{id:"image-edit",at:1002,kind:"turn_rewind",turnId:"image-user",revision:2,payload:{anchorUserTurnId:"image-user",disposition:"replace_user",reason:"edit",replacementUser:{text:"edited human",attachments}}});
 expect(JSON.stringify((await f.assemble()).request.body)).toContain("edited human");
});
