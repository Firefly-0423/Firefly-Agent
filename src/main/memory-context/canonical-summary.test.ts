import fs from "node:fs";
import path from "node:path";
import {beforeEach,expect,it,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {RecordCodec} from "../memory-core/record-codec";
import {DatabaseSync} from "node:sqlite";
let preparedFixture:Awaited<ReturnType<typeof contextFixture>>;
beforeEach(async()=>{preparedFixture=await contextFixture()});
async function fixture(){
 const f=preparedFixture,store=new ConversationTranscriptStore(path.join(f.root,"conversation"));
 const user=(id:string,text:string)=>store.append("session-a",{id,at:1000+Number(id.slice(1)),kind:"user",turnId:id,revision:1,payload:{text}});
 await user("u1","first user 🌱");
 await store.append("session-a",{id:"a1",at:1100,kind:"assistant",payload:{role:"assistant",content:"checking",toolCalls:[{id:"call",name:"read_file",arguments:'{"path":"fixture.txt"}'}]}});
 await store.append("session-a",{id:"t1",at:1101,kind:"tool_result",payload:{assistantEntryId:"a1",toolCallId:"call",outcome:"success",message:{role:"tool",toolCallId:"call",name:"read_file",content:"RESULT_CANARY"}}});
 await user("u2","redundant earlier turn ".repeat(100));
 const adapter=createConversationTranscriptAdapter({enabled:true,store,context:f.context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
 const turns=await adapter.captureTurns();
 const prepare=(transcriptTokens=turns,summaryIds:string[]=[])=>f.context.prepareSummary(f.actor,{sessionId:"session-a",transcriptTokens,summaryIds,leaseMs:60000});
 const input=async(lease:object)=>f.context.readSummaryInput(f.actor,lease);
 const commit=async(lease:object,indexes=[0])=>{const units=await input(lease);return f.context.commitSummary(f.actor,lease,{segments:indexes.map(i=>({transcriptRef:units[i].transcriptRef}))})};
 const assemble=(transcriptTokens:object[],summaryIds:string[]=[])=>f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens,summaryIds});
 return {...f,store,user,adapter,turns,prepare,input,commit,assemble};
}
it("extracts full canonical turns including tool calls and results, with all omitted dependencies",async()=>{
 const f=await fixture(),lease=await f.prepare(),input=await f.input(lease);
 expect(input.map(u=>u.messages.map(m=>m.role))).toEqual([["user","assistant","tool"],["user"]]);
 const receipt=await f.commit(lease);expect(receipt.status).toBe("committed");
 const snapshot=await f.assemble([], [receipt.summaryId!]);
 expect(snapshot.request.body.messages).toEqual(input[0].messages);
 expect(snapshot.request.body.messages[1]).toMatchObject({toolCalls:[{id:"call",name:"read_file",arguments:'{"path":"fixture.txt"}'}]});
 expect(await f.policy.recall(f.actor)).toEqual([]);
 const db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(receipt.summaryId!);const stored=new RecordCodec(f.key).open<any>("context-summary","scope-a",receipt.summaryId!,row!.payload);expect(stored.transcriptRefs).toHaveLength(2);expect(JSON.stringify(stored)).not.toContain("RESULT_CANARY");
  const rows=db.prepare("SELECT id,payload FROM context_records WHERE kind='transcript'").all();
  const heads=rows.map(r=>new RecordCodec(f.key).open<any>("context-transcript","scope-a",r.id as string,r.payload));
  const head=heads.find(h=>h.provenance?.length===3);expect(head.provenance[0]).toMatchObject({entryId:"u1",turnId:"u1",revision:1,seq:1,occurredAt:1001,role:"user"});expect(head.provenance[2]).toMatchObject({entryId:"t1",seq:3,occurredAt:1101,role:"tool"});expect(head.generation).toBe(0);
 }finally{db.close()}
});
it("continues the old summary before new complete recent turns without duplicating summarized inputs",async()=>{
 const f=await fixture(),first=await f.commit(await f.prepare());await f.user("u3","new recent");
 const fresh=await f.adapter.captureTurns(),snapshot=await f.assemble(fresh,[first.summaryId!]);
 expect((snapshot.request.body.messages as any[]).map(m=>m.text)).toEqual(["first user 🌱","checking","RESULT_CANARY","new recent"]);
 const lease=await f.prepare([fresh[2]],[first.summaryId!]),input=await f.input(lease);
 expect(input.map(u=>u.messages[0].text)).toEqual(["first user 🌱","new recent"]);
 const second=await f.commit(lease,[1]);expect(second.status).toBe("committed");
 expect((await f.assemble([],[second.summaryId!])).request.body.messages).toEqual([{role:"user",text:"new recent"}]);
});
it("reports no benefit for a full canonical extraction and refuses partial or unordered proposals",async()=>{
 const f=await fixture(),lease=await f.prepare(),input=await f.input(lease);
 await expect(f.context.commitSummary(f.actor,lease,{segments:[{transcriptRef:input[0].transcriptRef,span:{start:1,end:2}}]})).rejects.toThrow();
 await expect(f.commit(lease,[1,0])).rejects.toThrow("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");
 expect(await f.commit(lease,[0,1])).toEqual({status:"no-benefit",summaryId:null});
});
it.each(["append","edit","regenerate","delete","forget"] as const)("%s during exact summary counting prevents commit",async kind=>{
 const f=await fixture(),active=kind==="forget"?await f.active():null,lease=await f.prepare();let changed=false;
 f.setCountHook(async()=>{if(changed)return;changed=true;
  if(kind==="append")await f.user("u3","late user");
  else if(kind==="delete")await f.store.deleteConversation("session-a");
  else if(kind==="forget")await f.forget(active!.factId!);
  else await f.store.append("session-a",{id:"rewind",at:2000,kind:"turn_rewind",...(kind==="edit"?{turnId:"u1",revision:2}:{}),payload:{anchorUserTurnId:"u1",disposition:kind==="edit"?"replace_user":"keep_user",reason:kind==="edit"?"edit":"regenerate",...(kind==="edit"?{replacementUser:{text:"edited"}}:{})}});
 });await expect(f.commit(lease)).rejects.toThrow();
});
it("a summary stays unavailable when its omitted input is edited after continuation",async()=>{
 const f=await fixture(),receipt=await f.commit(await f.prepare());
 await f.store.append("session-a",{id:"edit-u2",at:2000,kind:"turn_rewind",turnId:"u2",revision:2,payload:{anchorUserTurnId:"u2",disposition:"replace_user",reason:"edit",replacementUser:{text:"changed omitted input"}}});
 const fresh=await f.adapter.captureTurns();
 expect((await f.assemble(fresh,[receipt.summaryId!])).excluded).toContainEqual(expect.objectContaining({sourceId:receipt.summaryId}));
});
it("reopen cannot revive an old canonical snapshot or a retired summary",async()=>{
 const f=await fixture(),receipt=await f.commit(await f.prepare()),snapshot=await f.assemble([], [receipt.summaryId!]);
 f.reopen();expect((await f.assemble([],[receipt.summaryId!])).request.body.messages).toEqual(snapshot.request.body.messages);
 await f.adapter.close();
 const next=createConversationTranscriptAdapter({enabled:true,store:f.store,context:f.context,actorAuthority:f.actorAuthority,actorToken:f.actor})!;
 const fresh=await next.captureTurns();
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow();
 expect((await f.assemble(fresh,[receipt.summaryId!])).excluded).toContainEqual(expect.objectContaining({sourceId:receipt.summaryId}));
});
it("forget and recapture keep unknown historical tool derivations unavailable",async()=>{
 const f=await fixture(),active=await f.active(),receipt=await f.commit(await f.prepare());await f.forget(active.factId!);
 const fresh=await f.adapter.captureTurns(),snapshot=await f.assemble(fresh,[receipt.summaryId!]);
 expect(JSON.stringify(snapshot.request)).not.toContain("RESULT_CANARY");
 expect(snapshot.excluded.some(e=>e.reason==="untraceable-derived")).toBe(true);
});
it("rejects mixed raw recent refs and canonical summary continuation",async()=>{
 const f=await fixture(),receipt=await f.commit(await f.prepare()),raw=await f.source("raw");
 await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[raw.ref],summaryIds:[receipt.summaryId!]})).rejects.toThrow("MEMORY_CONTEXT_ORDER_REQUIRED");
});

it("regeneration produces a fresh shorter complete turn without rolling back its content version",async()=>{
 const f=await fixture(),old=await f.assemble(f.turns);
 await f.store.append("session-a",{id:"regenerate",at:2000,kind:"turn_rewind",payload:{anchorUserTurnId:"u1",disposition:"keep_user",reason:"regenerate"}});
 const fresh=await f.adapter.captureTurns();
 expect((await f.assemble(fresh)).request.body.messages).toEqual([{role:"user",text:"first user 🌱"}]);
 await expect(f.context.validateForDispatch(f.actor,old)).rejects.toThrow();
});
it("an observed post-forget new turn keeps its event epoch while old derived turns remain denied",async()=>{
 const f=await fixture(),active=await f.active();await f.forget(active.factId!);await f.user("u3","new post-forget user");
 await f.store.append("session-a",{id:"a3",at:2001,kind:"assistant",payload:{role:"assistant",content:"new post-forget assistant"}});
 const fresh=await f.adapter.captureTurns(),snapshot=await f.assemble(fresh);
 expect(snapshot.request.body.messages).toEqual([{role:"user",text:"new post-forget user"},{role:"assistant",text:"new post-forget assistant"}]);
 expect(JSON.stringify(snapshot.request)).not.toContain("RESULT_CANARY");
});
it("append then recapture cannot revive a permit bound to the older session view",async()=>{
 const f=await fixture(),snapshot=await f.assemble([f.turns[0]]),permit=await f.context.validateForDispatch(f.actor,snapshot);
 await f.user("u3","new turn");await f.adapter.captureTurns();let sends=0;
 await expect(f.context.dispatch(f.actor,permit,()=>{sends++})).rejects.toThrow();expect(sends).toBe(0);
});
it("mutating an omitted summary dependency during dispatch counting prevents the sender",async()=>{
 const f=await fixture(),receipt=await f.commit(await f.prepare()),snapshot=await f.assemble([], [receipt.summaryId!]),permit=await f.context.validateForDispatch(f.actor,snapshot);let changed=false,sends=0;
 f.setCountHook(async()=>{if(changed)return;changed=true;await f.store.append("session-a",{id:"edit-u2",at:2000,kind:"turn_rewind",turnId:"u2",revision:2,payload:{anchorUserTurnId:"u2",disposition:"replace_user",reason:"edit",replacementUser:{text:"count race"}}})});
 await expect(f.context.dispatch(f.actor,permit,()=>{sends++})).rejects.toThrow();expect(sends).toBe(0);
});

it("a failed multi-head invalidation rolls back every head and can be retried",async()=>{
 const f=await fixture(),before=await f.store.read("session-a"),snapshots=[];
 for(const turn of f.turns)snapshots.push(await f.assemble([turn]));
 f.setFault(true,"transcriptReserveBatch",2);
 await expect(f.user("u3","blocked mutation")).rejects.toThrow("SUMMARY_INJECTED_FAULT");
 expect(await f.store.read("session-a")).toEqual(before);
 f.setFault(false);
 for(const snapshot of snapshots)expect(await f.context.validateForDispatch(f.actor,snapshot)).toBeTypeOf("object");
 await f.user("u3","retried mutation");
 for(const snapshot of snapshots)await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow();
});
it("empty canonical capture cannot mint an unguarded session snapshot",async()=>{
 const f=await fixture();await f.store.deleteConversation("session-a");
 await expect(f.adapter.captureTurns()).rejects.toThrow("MEMORY_CONTEXT_RECENT_INCOMPLETE");
});

it("batch validation includes the view head alongside the maximum 1000 turn heads",async()=>{
 const f=await fixture(),baseline=(f.commands as any[]).find(c=>c.kind==="baseline").body;
 const {actorKey,providerId,sessionId,bootId}=baseline;
 const expectedRefs=Array.from({length:1001},(_,i)=>({headId:"missing-"+i,revision:1,digest:"0".repeat(64)}));
 await expect(f.transport.contextCommand({kind:"transcriptReserveBatch",scopeKey:"scope-a",commandId:"limit-check",body:{actorKey,providerId,sessionId,bootId,generation:0,operationId:"limit-operation",expectedRefs}})).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
});

it("counts the actual stored summary unit framing and the complete recent unit framing",async()=>{
 const f=await fixture(),requests:any[]=[],count=f.options.counter.count;
 f.options.counter.count=async(request:any)=>{requests.push(request);return count(request)};
 f.options.prepareS=(units:any[])=>({...f.options.counter.capability,inputTypes:["text"],body:{units:units.map(u=>({id:u.id,kind:u.kind,messages:u.messages}))}});
 const receipt=await f.commit(await f.prepare());expect(receipt.status).toBe("committed");
 expect(requests[0].body.units.map((u:any)=>u.kind)).toEqual(["recent","recent"]);
 expect(requests[1].body.units).toHaveLength(1);
 expect(requests[1].body.units[0]).toMatchObject({id:receipt.summaryId,kind:"summary"});
 const afterTokens=JSON.stringify(requests[1].body).length,snapshot=await f.assemble([], [receipt.summaryId!]);
 expect(snapshot.sTokens).toBe(afterTokens);
});

it("refuses reused tool-call IDs in the active transcript before summary preparation",async()=>{
 const f=await fixture();
 await f.store.append("session-a",{id:"a2",at:1200,kind:"assistant",payload:{role:"assistant",content:"second call",toolCalls:[{id:"call",name:"read_file",arguments:"{}"}]}});
 await f.store.append("session-a",{id:"t2",at:1201,kind:"tool_result",payload:{assistantEntryId:"a2",toolCallId:"call",outcome:"success",message:{role:"tool",toolCallId:"call",name:"read_file",content:"second result"}}});
 await expect(f.adapter.captureTurns()).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
