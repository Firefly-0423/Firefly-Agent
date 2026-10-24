import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {it,expect,vi} from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {createMainPolicy} from "../memory-policy/main-policy";
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
it("shared opaque Main actor assembles and dispatches one immutable request",async()=>{
 const f=await contextFixture(),s=await f.source("中文 English 🌱"),snapshot=await f.assemble([s.ref]);expect(snapshot.request.body.messages[0].text).toBe("中文 English 🌱");
 const permit=await f.context.validateForDispatch(f.actor,snapshot);let sent=0;const result=await f.context.dispatch(f.actor,permit,request=>{sent++;expect(Object.isFrozen(request.body)).toBe(true);return Promise.resolve("ok")});expect(result).toMatchObject({status:"sent",result:"ok"});expect(sent).toBe(1);
 await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"})).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(sent).toBe(1);
});
it("JSON, foreign authority and cross-session capabilities cannot create snapshots",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English");await expect(f.context.assemble({}, {sessionId:"session-a",sourceRefs:[s.ref]})).rejects.toThrow("MEMORY_ACTOR_DENIED");
 await expect(f.context.assemble(f.actor,{sessionId:"other",sourceRefs:[s.ref]})).rejects.toThrow("MEMORY_ACTOR_DENIED");
 const {createMainActorAuthority}=await import("../memory-core/main-actor-authority"),foreign=createMainActorAuthority({resolveActor:()=>"actor-a"}),token=foreign.bindActor(f.access,f.provider.adapter,f.identity);
 await expect(f.context.assemble(token,{sessionId:"session-a",sourceRefs:[]})).rejects.toThrow("MEMORY_ACTOR_DENIED");
});
it("temporary session refuses before any source or persistent context access",async()=>{
 const f=await contextFixture(),actor=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),before=f.writes;
 await expect(f.context.assemble(actor,{sessionId:"session-a",sourceRefs:[]})).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");expect(f.writes).toBe(before);
 const db=await import("node:sqlite"),raw=new db.DatabaseSync(f.databasePath,{readOnly:true});try{expect(raw.prepare("SELECT count(*) n FROM context_records").get()?.n).toBe(0);expect(raw.prepare("SELECT count(*) n FROM source_heads").get()?.n).toBe(0)}finally{raw.close()}
});
it("global generation invalidates snapshot but unrelated old original rebuilds",async()=>{
 const f=await contextFixture(),a=await f.active(),unrelated=await f.source("I prefer English"),snapshot=await f.assemble([unrelated.ref]);await f.forget(a.factId!);
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_STALE");const rebuilt=await f.assemble([unrelated.ref]);expect(rebuilt.request.body.messages[0].text).toBe("I prefer English");
});
it("related never-extracted and untracked assistant sources cannot reenter after forget",async()=>{
 const f=await contextFixture(),a=await f.active(),related=await f.source("I prefer bash"),derived=await f.source("User prefers bash","assistant","model");await f.forget(a.factId!);
 const rebuilt=await f.assemble([related.ref,derived.ref]);expect(rebuilt.request.body.messages).toEqual([]);expect(rebuilt.excluded.map(x=>x.reason)).toEqual(["suppressed-subject","untraceable-derived"]);
 const recaptured=await f.registry.capture(f.access,f.provider.adapter,related.id);expect(recaptured).toEqual(related.ref);expect((await f.assemble([recaptured])).request.body.messages).toEqual([]);
});
it("editing historical locator cannot reset its first event generation",async()=>{
 const f=await contextFixture(),a=await f.active(),old=await f.source("I prefer bash");await f.forget(a.factId!);await f.registry.prepareChange(f.access,f.provider.adapter,old.ref);f.provider.write(old.id,{text:"我默认用 Bash",role:"user",trust:"direct-user-event"});const ref=await f.registry.reconcile(f.access,f.provider.adapter,old.id);expect((await f.assemble([ref])).request.body.messages).toEqual([]);
});
it.each(["pending","edited","deleted","recreated"])("%s source invalidates prepared dispatch",async kind=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);
 await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);
 if(kind==="edited"){f.provider.write(s.id,{text:"I prefer Chinese",role:"user",trust:"direct-user-event"});await f.registry.reconcile(f.access,f.provider.adapter,s.id)}
 if(kind==="deleted"||kind==="recreated"){f.provider.remove(s.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,s.id)).rejects.toThrow();if(kind==="recreated"){f.provider.write(s.id,{text:"I prefer English",role:"user",trust:"direct-user-event"});await f.registry.capture(f.access,f.provider.adapter,s.id)}}
 let sent=0;await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"})).rejects.toThrow();expect(sent).toBe(0);
});
it("source edit during asynchronous token count prevents snapshot commit",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English");let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);f.setCountHook(async()=>{started();await gate});const p=f.assemble([s.ref]);await ready;await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);release();await expect(p).rejects.toThrow("MEMORY_SOURCE_PENDING");
});
it("queued forget wins before dispatch without claiming network cancellation",async()=>{
 const f=await contextFixture(),a=await f.active(),unrelated=await f.source("I prefer English"),snapshot=await f.assemble([unrelated.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);
 const event=await f.policy.event(f.actor,{kind:"forget",nonce:randomUUID(),factId:a.factId!,revision:1});let release!:()=>void;const gate=new Promise<void>(r=>release=r),blocked=f.actorAuthority.coordinate(()=>gate);
 const forgetting=f.policy.act(f.actor,event);let sent=0;const dispatch=f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"});release();await blocked;await forgetting;await expect(dispatch).rejects.toThrow("MEMORY_CONTEXT_STALE");expect(sent).toBe(0);
});
it("already invoked transport failure is result-unknown and is never retried",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);let sent=0;
 const result=await f.context.dispatch(f.actor,permit,()=>{sent++;return Promise.reject(new Error("SECRET_TRANSPORT_ERROR"))});expect(result).toEqual({status:"result-unknown",requestDigest:snapshot.requestDigest});expect(sent).toBe(1);expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("changed final cache/tools request requires a fresh prepare and permit",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]);f.setCache("v2");await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");const next=await f.assemble([s.ref]);expect(next.requestDigest).not.toBe(snapshot.requestDigest);
});
it("M support eligibility is checked without requiring all original supports",async()=>{
 const f=await contextFixture(),a=await f.active(),b=await f.active("我默认用 Bash"),fact={factId:a.factId!,revision:1},snapshot=await f.assemble([], [fact]);
 await f.registry.prepareChange(f.access,f.provider.adapter,a.ref);const permit=await f.context.validateForDispatch(f.actor,snapshot);expect((await f.context.dispatch(f.actor,permit,()=>"ok")).status).toBe("sent");
 const next=await f.assemble([], [fact]);await f.registry.prepareChange(f.access,f.provider.adapter,b.ref);await expect(f.context.validateForDispatch(f.actor,next)).rejects.toThrow("MEMORY_CONTEXT_FACT_STALE");
});
it("M denial and correction invalidate snapshots without granting S confirmation",async()=>{
 const f=await contextFixture(),a=await f.active(),snapshot=await f.assemble([], [{factId:a.factId!,revision:1}]),d=await f.source("This selected fact is incorrect");await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:"deny",nonce:randomUUID(),factId:a.factId!,revision:1,sourceRef:d.ref}));
 await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_FACT_STALE");expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("reopened Main rejects old snapshot capabilities",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]);f.reopen();const {createMainContext}=await import("./main-context"),fresh=createMainContext(f.options);await expect(fresh.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_SNAPSHOT_DENIED");
});
it("canonical transcript provider keeps tool roles and complete pairs without M promotion",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider"),origin=await f.source("I prefer English");
 const state={incarnation:"turn-v1",revision:1,throughSeq:3,sourceRefs:[origin.ref],unit:{id:"turn",kind:"recent",messages:[{role:"assistant",text:"",toolCallIds:["call"]},{role:"tool",text:"TOOL_BODY_CANARY",toolCallId:"call"}]}};
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>structuredClone(state))});
 const token=await f.context.captureTranscript(f.actor,provider,"turn"),snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[token]});
 expect(snapshot.request.body.messages.map((m:any)=>m.role)).toEqual(["assistant","tool"]);expect(await f.policy.recall(f.actor)).toEqual([]);
 for(const name of fs.readdirSync(f.root).filter(n=>n.startsWith("memory.sqlite")))expect(fs.readFileSync(path.join(f.root,name)).includes(Buffer.from("TOOL_BODY_CANARY"))).toBe(false);
});
it("canonical transcript JSON capability and cross-scope provider are denied",async()=>{
 const f=await contextFixture();await expect(f.context.captureTranscript(f.actor,{},"turn")).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
 const {createMainTranscriptProvider}=await import("./main-transcript-provider"),provider=createMainTranscriptProvider({scopeKey:"scope-b",providerId:"canonical",sessionId:"session-a",withLease:async()=>{throw new Error("must not read")}});
 await expect(f.context.captureTranscript(f.actor,provider,"turn")).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_DENIED");
});
it("pending canonical transcript invalidates permit before send",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider"),state={incarnation:"turn-v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:"工具输入"}]}};
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>structuredClone(state))});
 const token=await f.context.captureTranscript(f.actor,provider,"turn"),snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[token]}),permit=await f.context.validateForDispatch(f.actor,snapshot);
 await f.context.prepareTranscriptChange(f.actor,token);let sent=0;await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"})).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_PENDING");expect(sent).toBe(0);
});
it("old tool derivation without roots is excluded while unrelated sourced tool context can rebuild",async()=>{
 const f=await contextFixture(),a=await f.active(),origin=await f.source("I prefer English"),{createMainTranscriptProvider}=await import("./main-transcript-provider");let roots:any[]=[];
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(id:any,run:any)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:roots,unit:{id,kind:"recent",messages:[{role:"assistant",text:"derived tool context"}]}}))});
 const unknown=await f.context.captureTranscript(f.actor,provider,"unknown");roots=[origin.ref];const known=await f.context.captureTranscript(f.actor,provider,"known");await f.forget(a.factId!);
 const snapshot=await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[unknown,known]});expect(snapshot.request.body.messages).toHaveLength(1);expect(snapshot.excluded.some(x=>x.reason==="untraceable-derived")).toBe(true);
});
it("temporary canonical capture performs no provider read or worker write",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider"),actor=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"});let reads=0;
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async()=>{reads++;throw new Error("bad")}}),before=f.writes;
 await expect(f.context.captureTranscript(actor,provider,"turn")).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");expect(reads).toBe(0);expect(f.writes).toBe(before);
});
it("canonical edit/delete/recreate never validates an old transcript token",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider");let state={incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:"first"}]}};
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>structuredClone(state))});
 const old=await f.context.captureTranscript(f.actor,provider,"turn");await f.context.prepareTranscriptChange(f.actor,old);state={...state,revision:2,throughSeq:2,unit:{...state.unit,messages:[{role:"user",text:"edited"}]}};const edited=await f.context.captureTranscript(f.actor,provider,"turn");
 await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[old]})).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
 await f.context.deleteTranscript(f.actor,edited);await expect(f.context.captureTranscript(f.actor,provider,"turn")).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_REUSED");state={...state,incarnation:"v2",revision:1};const fresh=await f.context.captureTranscript(f.actor,provider,"turn");expect((await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[fresh]})).request.body.messages[0].text).toBe("edited");
});
it("pending or forgotten transcript root cannot be hidden by the tool role",async()=>{
 const f=await contextFixture(),a=await f.active(),{createMainTranscriptProvider}=await import("./main-transcript-provider"),s=await f.source("I prefer bash");
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[s.ref],unit:{id:"turn",kind:"recent",messages:[{role:"assistant",text:"bash paraphrase"}]}}))});
 const token=await f.context.captureTranscript(f.actor,provider,"turn");await f.forget(a.factId!);expect((await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[token]})).request.body.messages).toEqual([]);
 await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[token]})).rejects.toThrow("MEMORY_SOURCE_PENDING");
});
it("canonical provider rejects incomplete tool pairs and observation mutation",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider");let count=0;
 const incomplete=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"assistant",text:"",toolCallIds:["call"]}]}}))});
 await expect(f.context.captureTranscript(f.actor,incomplete,"turn")).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
 const changed=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"other",sessionId:"session-a",withLease:async(_id:any,run:any)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:String(++count)}]}}))});
 await expect(f.context.captureTranscript(f.actor,changed,"turn")).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_CHANGED");
});
it("stale snapshot is refused before invoking the token counter",async()=>{
 const f=await contextFixture(),a=await f.active(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]);await f.forget(a.factId!);let counts=0;f.setCountHook(async()=>{counts++;throw new Error("must not count stale body")});await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_STALE");expect(counts).toBe(0);
});
it("provider edit without an observed ledger update is caught by dispatch materialization",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]);f.provider.write(s.id,{text:"I prefer Chinese",role:"user",trust:"direct-user-event"});await expect(f.context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_SOURCE_STALE");
});
it("configuration changed at the last counter continuation cannot send old body",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);let counts=0,sent=0;f.setCountHook(async()=>{if(++counts===3)f.setCache("v2")});await expect(f.context.dispatch(f.actor,permit,()=>{sent++;return "bad"})).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");expect(sent).toBe(0);
});
it("durable snapshot stores count capability identity and metadata without prompt plaintext",async()=>{
 const f=await contextFixture(),s=await f.source("RAW_CONTEXT_BODY_CANARY"),snapshot=await f.assemble([s.ref]),{DatabaseSync}=await import("node:sqlite"),{RecordCodec}=await import("../memory-core/record-codec"),db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(snapshot.snapshotId),stored=new RecordCodec(f.key).open<any>("context-snapshot","scope-a",snapshot.snapshotId,row!.payload);expect(stored.counterIdentity).toEqual(f.options.counter.capability);expect(JSON.stringify(stored)).not.toContain("RAW_CONTEXT_BODY_CANARY");expect(stored.promptTokens).toBe(snapshot.promptTokens)}finally{db.close()}
});
const segment=(ref:any,text:string)=>({sourceRef:ref,span:{start:0,end:text.length}});
async function prepareSummary(f:Awaited<ReturnType<typeof contextFixture>>,refs:any[]){return f.context.prepareSummary(f.actor,{sessionId:"session-a",inputRefs:refs,leaseMs:60000})}
async function withSummary(f:Awaited<ReturnType<typeof contextFixture>>,id:string){return f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],summaryIds:[id]})}
it("extractive summary preserves whole negation, speaker, Unicode and input order without promoting M",async()=>{
 const f=await contextFixture(),text="I do not prefer bash. 我不偏好 Bash 🌱 e\u0301",a=await f.source(text),b=await f.source("OLD RAW CONTEXT ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);
 const receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});expect(receipt.status).toBe("committed");const snapshot=await withSummary(f,receipt.summaryId!);expect(snapshot.request.body.messages[0]).toMatchObject({role:"user",text});expect(await f.policy.recall(f.actor)).toEqual([]);
});
it.each(["pending","edited","deleted","recreated"])("summary loses all availability when an unselected input becomes %s",async kind=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("SECOND INPUT ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});
 await f.registry.prepareChange(f.access,f.provider.adapter,b.ref);
 if(kind==="edited"){f.provider.write(b.id,{text:"changed",role:"user",trust:"direct-user-event"});await f.registry.reconcile(f.access,f.provider.adapter,b.id)}
 if(kind==="deleted"||kind==="recreated"){f.provider.remove(b.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,b.id)).rejects.toThrow();if(kind==="recreated"){f.provider.write(b.id,{text:"SECOND INPUT ".repeat(100),role:"user",trust:"direct-user-event"});await f.registry.capture(f.access,f.provider.adapter,b.id)}}
 expect((await withSummary(f,receipt.summaryId!)).request.body.messages).toEqual([]);
});
it("forget invalidates old summary permit while precise unrelated summary sources can rebuild",async()=>{
 const f=await contextFixture(),active=await f.active(),text="I prefer English",a=await f.source(text),b=await f.source("I prefer detailed responses"),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]}),snapshot=await withSummary(f,receipt.summaryId!),permit=await f.context.validateForDispatch(f.actor,snapshot);await f.forget(active.factId!);
 await expect(f.context.dispatch(f.actor,permit,()=>"bad")).rejects.toThrow("MEMORY_CONTEXT_STALE");expect((await withSummary(f,receipt.summaryId!)).request.body.messages[0].text).toBe(text);
});
it("forgotten never-extracted unselected dependency cannot be omitted to reuse summary",async()=>{
 const f=await contextFixture(),active=await f.active(),text="I prefer English",a=await f.source(text),b=await f.source("I prefer bash"),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});await f.forget(active.factId!);expect((await withSummary(f,receipt.summaryId!)).request.body.messages).toEqual([]);
});
it("summary prepared before forget cannot commit, unrelated fresh lease can rebuild",async()=>{
 const f=await contextFixture(),active=await f.active(),text="I prefer English",a=await f.source(text),b=await f.source("I prefer detailed responses"),lease=await prepareSummary(f,[a.ref,b.ref]);await f.forget(active.factId!);
 await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_STALE");const fresh=await prepareSummary(f,[a.ref,b.ref]);expect((await f.context.commitSummary(f.actor,fresh,{segments:[segment(a.ref,text)]})).status).toBe("committed");
});
it("expired lease rejects before source reads or token counting",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);f.advanceClock(60001);let counts=0;f.setCountHook(async()=>{counts++});await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_LEASE_EXPIRED");expect(counts).toBe(0);
});
it("JSON and old Main lease capability fail closed",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);await expect(f.context.commitSummary(f.actor,{}, {segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_LEASE_DENIED");const {createMainContext}=await import("./main-context"),fresh=createMainContext(f.options);await expect(fresh.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_LEASE_DENIED");
});
it("partial negation, surrogate boundary, out-of-order and duplicate excerpts are refused",async()=>{
 const f=await contextFixture(),text="🌱 I do not prefer bash",a=await f.source(text),b=await f.source("second ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);
 await expect(f.context.commitSummary(f.actor,lease,{segments:[{sourceRef:a.ref,span:{start:2,end:text.length}}]})).rejects.toThrow("MEMORY_CONTEXT_SUMMARY_FULL_SOURCE_REQUIRED");
 await expect(f.context.commitSummary(f.actor,lease,{segments:[{sourceRef:a.ref,span:{start:0,end:1}}]})).rejects.toThrow("MEMORY_SOURCE_SPAN_INVALID");
 await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(b.ref,"second ".repeat(100)),segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");
 await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text),segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_SUMMARY_ORDER_INVALID");
});
it("labelled secret corpus is reason-only and creates no summary lease or payload command",async()=>{
 const f=await contextFixture(),s=await f.source("refresh_token=SUMMARY_SECRET_CANARY");await expect(prepareSummary(f,[s.ref])).rejects.toThrow("MEMORY_CONTEXT_SUMMARY_SECRET");expect(JSON.stringify(f.commands)).not.toContain("SUMMARY_SECRET_CANARY");const {DatabaseSync}=await import("node:sqlite"),db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare("SELECT count(*) n FROM context_records WHERE kind IN ('summary','summary-lease')").get()?.n).toBe(0)}finally{db.close()}
});
it("summary stores only encrypted complete input references and spans, no message copy",async()=>{
 const f=await contextFixture(),text="SUMMARY_BODY_CANARY",a=await f.source(text),b=await f.source("UNSELECTED_CANARY ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]}),{DatabaseSync}=await import("node:sqlite"),{RecordCodec}=await import("../memory-core/record-codec"),db=new DatabaseSync(f.databasePath,{readOnly:true});
 try{const row=db.prepare("SELECT payload FROM context_records WHERE id=?").get(receipt.summaryId),stored=new RecordCodec(f.key).open<any>("context-summary","scope-a",receipt.summaryId!,row!.payload);expect(stored.sourceDeps.map((d:any)=>d.sourceRef.sourceId)).toEqual([a.ref.sourceId,b.ref.sourceId]);expect(JSON.stringify(stored)).not.toMatch(/SUMMARY_BODY_CANARY|UNSELECTED_CANARY/);expect(stored.segments[0].span).toEqual({start:0,end:text.length})}finally{db.close()}
});
it("summary fault rolls back rows and receipt; exact retry and reopen replay one result",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),proposal={segments:[segment(a.ref,text)]};f.setFault(true);await expect(f.context.commitSummary(f.actor,lease,proposal)).rejects.toThrow("SUMMARY_INJECTED_FAULT");f.setFault(false);const receipt=await f.context.commitSummary(f.actor,lease,proposal);f.reopen();expect(await f.context.commitSummary(f.actor,lease,proposal)).toEqual(receipt);const {DatabaseSync}=await import("node:sqlite"),db=new DatabaseSync(f.databasePath,{readOnly:true});try{expect(db.prepare("SELECT count(*) n FROM context_records WHERE kind='summary'").get()?.n).toBe(1)}finally{db.close()}
});
it("completed receipt is diagnostic and cannot make deleted source summary available",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),proposal={segments:[segment(a.ref,text)]},receipt=await f.context.commitSummary(f.actor,lease,proposal);await f.registry.prepareChange(f.access,f.provider.adapter,a.ref);f.provider.remove(a.id);await expect(f.registry.reconcile(f.access,f.provider.adapter,a.id)).rejects.toThrow();expect(await f.context.commitSummary(f.actor,lease,proposal)).toEqual(receipt);expect((await withSummary(f,receipt.summaryId!)).request.body.messages).toEqual([]);
});
it("no-benefit summary consumes lease without adding summary or M",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),lease=await prepareSummary(f,[a.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});expect(receipt).toEqual({status:"no-benefit",summaryId:null});expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("temporary summary refuses before any source/worker access",async()=>{
 const f=await contextFixture(),a=f.actorAuthority.bindActor(f.access,f.provider.adapter,f.identity,{sessionMode:"temporary"}),before=f.writes;await expect(f.context.prepareSummary(a,{sessionId:"session-a",inputRefs:[],leaseMs:1000})).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");expect(f.writes).toBe(before);
});
it("committed summary rehydrates owned source refs in a fresh Main registry",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});f.reopen();const {createMainContext}=await import("./main-context"),registry=createMainSourceRegistry(f.transport,{coordinate:f.actorAuthority.coordinate}),access=registry.authority.access("scope-a"),actor=f.actorAuthority.bindActor(access,f.provider.adapter,f.identity),fresh=createMainContext({...f.options,registry});expect((await fresh.assemble(actor,{sessionId:"session-a",sourceRefs:[],summaryIds:[receipt.summaryId!]})).request.body.messages[0].text).toBe(text);
});
it("source mutation at a summary counter continuation prevents commit",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);let counts=0;f.setCountHook(async()=>{if(++counts===2)f.provider.write(b.id,{text:"edited without a ledger observation",role:"user",trust:"direct-user-event"})});await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_SOURCE_STALE");
});
it("summary configuration mutation during counting cannot persist a stale result",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);f.setCountHook(async()=>{f.options.budget.maxSTokens++});await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_REQUEST_CHANGED");
});
it("summary keeps the original assistant speaker",async()=>{
 const f=await contextFixture(),text="I do not prefer bash",a=await f.source(text,"assistant","model"),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]});expect((await withSummary(f,receipt.summaryId!)).request.body.messages[0].role).toBe("assistant");
});
it("summary provider read failure exposes only a typed reason",async()=>{
 const f=await contextFixture(),text="I prefer English",a=await f.source(text),b=await f.source("other ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]);f.provider.failReads=true;await expect(f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]})).rejects.toThrow("MEMORY_CONTEXT_SOURCE_READ_FAILED");
});
it("an explicit recent source remains selected when it was already visited as an origin",async()=>{
 const f=await contextFixture(),a=await f.source("I prefer concise responses"),b=await f.source("I prefer English"),{createMainContext}=await import("./main-context"),context=createMainContext({...f.options,resolveDerivedRefs:(ref:any)=>ref.sourceId===a.ref.sourceId?[b.ref]:null});expect((await context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[a.ref,b.ref]})).request.body.messages).toHaveLength(2);
});
it("canonical tool secret refuses before publishing body or token counting",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider");let counts=0;f.setCountHook(async()=>{counts++});const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id,run)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"assistant",text:"",toolCallIds:["call"]},{role:"tool",text:"refresh_token=REVIEW_SECRET_CANARY",toolCallId:"call"}]}}))});await expect(f.context.captureTranscript(f.actor,provider,"turn")).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");expect(counts).toBe(0);expect(JSON.stringify(f.commands)).not.toContain("REVIEW_SECRET_CANARY");
});
it("a secret canonical root excludes its derived tool unit even at generation zero",async()=>{
 const f=await contextFixture(),secret=await f.source("refresh_token=ROOT_SECRET_CANARY"),{createMainTranscriptProvider}=await import("./main-transcript-provider"),provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id,run)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[secret.ref],unit:{id:"turn",kind:"recent",messages:[{role:"assistant",text:"derived context"}]}}))}),token=await f.context.captureTranscript(f.actor,provider,"turn");expect((await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[],transcriptTokens:[token]})).request.body.messages).toEqual([]);
});
it("protected raw recent turns cannot trim user input while retaining its assistant",async()=>{
 const f=await contextFixture(),user=await f.source("U".repeat(300)),assistant=await f.source("ASSISTANT_REPLY","assistant","model");f.options.budget.maxSTokens=150;await expect(f.assemble([user.ref,assistant.ref])).rejects.toThrow("MEMORY_CONTEXT_RECENT_OVER_BUDGET");
});
it("an eligible leading raw assistant has no proved complete-turn boundary",async()=>{
 const f=await contextFixture(),assistant=await f.source("ORPHAN_REPLY","assistant","model");await expect(f.assemble([assistant.ref])).rejects.toThrow("MEMORY_CONTEXT_RECENT_INCOMPLETE");
});
it("older extractive summaries precede newer recent turns",async()=>{
 const f=await contextFixture(),text="EARLIER_USER",a=await f.source(text),b=await f.source("old omitted ".repeat(100)),lease=await prepareSummary(f,[a.ref,b.ref]),receipt=await f.context.commitSummary(f.actor,lease,{segments:[segment(a.ref,text)]}),recent=await f.source("LATER_USER");expect((await f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[recent.ref],summaryIds:[receipt.summaryId!]})).request.body.messages.map((m:any)=>m.text)).toEqual([text,"LATER_USER"]);
});
it("mixing raw refs and canonical units without an ordered transcript is refused",async()=>{
 const f=await contextFixture(),recent=await f.source("LATER_USER"),{createMainTranscriptProvider}=await import("./main-transcript-provider"),provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",withLease:async(_id,run)=>run(async()=>({incarnation:"v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:"EARLIER_USER"}]}}))}),token=await f.context.captureTranscript(f.actor,provider,"turn");await expect(f.context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[recent.ref],transcriptTokens:[token]})).rejects.toThrow("MEMORY_CONTEXT_ORDER_REQUIRED");
});

it("publishes the canonical dependency while its provider lease is still held",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider");
 let leased=false;const publicationStates:boolean[]=[];
 const original=f.transport.contextCommand;
 f.transport.contextCommand=async(command:any)=>{
  if(command.kind==="transcriptPublish")publicationStates.push(leased);
  return original(command);
 };
 const state={incarnation:"lease-v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:"synthetic lease"}]}};
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",
  withLease:async(_id,run)=>{leased=true;try{return await run(async()=>structuredClone(state))}finally{leased=false}}
 });
 await f.context.captureTranscript(f.actor,provider,"turn");
 expect(publicationStates).toEqual([true]);
 expect(leased).toBe(false);
});

it("notifies Main of the latest captured capability before releasing its lease",async()=>{
 const f=await contextFixture(),{createMainTranscriptProvider}=await import("./main-transcript-provider");
 let leased=false,observed:object|undefined;
 const state={incarnation:"notify-v1",revision:1,throughSeq:1,sourceRefs:[],unit:{id:"turn",kind:"recent",messages:[{role:"user",text:"synthetic notification"}]}};
 const provider=createMainTranscriptProvider({scopeKey:"scope-a",providerId:"canonical",sessionId:"session-a",
  onCaptured:cap=>{expect(leased).toBe(true);observed=cap},
  withLease:async(_id,run)=>{leased=true;try{return await run(async()=>structuredClone(state))}finally{leased=false}}
 });
 const captured=await f.context.captureTranscript(f.actor,provider,"turn");
 expect(observed).toBe(captured);expect(leased).toBe(false);
});

it("response validation requires claimed dispatch and never restores a one-use permit",async()=>{
 const f=await contextFixture(),source=await f.source("synthetic response input"),snapshot=await f.assemble([source.ref]);
 await expect(f.context.validateResponse(f.actor,snapshot)).rejects.toThrow("MEMORY_CONTEXT_RESPONSE_UNSENT");
 const permit=await f.context.validateForDispatch(f.actor,snapshot),send=vi.fn(()=>"synthetic response");
 await f.context.dispatch(f.actor,permit,send);await f.context.validateResponse(f.actor,snapshot);
 await expect(f.context.dispatch(f.actor,permit,send)).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");expect(send).toHaveBeenCalledTimes(1);
 await f.registry.prepareChange(f.access,f.provider.adapter,source.ref);
 await expect(f.context.validateResponse(f.actor,snapshot)).rejects.toThrow();
});
it("run-scoped source authorization rejects cross-session M support before source I/O",async()=>{
 const f=await contextFixture(),active=await f.active(),{createMainContext}=await import("./main-context");
 const other=f.actorAuthority.bindActor(f.access,f.provider.adapter,{...f.identity,sessionId:"session-b"});
 const read=vi.spyOn(f.registry,"readEvidence");
 const authorizeSourceRead=vi.fn((actor:any,ref:any)=>{
  if(ref.binding.sessionId!==actor.sessionId)throw new Error("MEMORY_RUN_READ_DENIED");
 });
 const context=createMainContext({...f.options,includeFactSupportMetadata:true,authorizeSourceRead});
 await expect(context.assemble(other,{sessionId:"session-b",sourceRefs:[],factRefs:[{factId:active.factId!,revision:1}]})).rejects.toThrow("MEMORY_RUN_READ_DENIED");
 expect(authorizeSourceRead).toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
});
it("run-scoped source authorization is rechecked before dispatch evidence reads",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),{createMainContext}=await import("./main-context");let allowed=true;
 const context=createMainContext({...f.options,authorizeSourceRead:()=>{if(!allowed)throw new Error("MEMORY_RUN_READ_DENIED")}});
 const snapshot=await context.assemble(f.actor,{sessionId:"session-a",sourceRefs:[s.ref]});
 const read=vi.spyOn(f.registry,"readEvidence");allowed=false;
 await expect(context.validateForDispatch(f.actor,snapshot)).rejects.toThrow("MEMORY_RUN_READ_DENIED");expect(read).not.toHaveBeenCalled();
});
it("source context may discuss credential field names without promoting them into facts",async()=>{
 const f=await contextFixture(),s=await f.source("Explain api_key and password field validation");
 expect((await f.assemble([s.ref])).request.body.messages).toContainEqual({role:"user",text:"Explain api_key and password field validation"});
 await f.policy.ingest(f.actor,s.ref);expect(await f.policy.recall(f.actor)).toEqual([]);
});
it("revalidates the claimed request at the final network boundary and releases the queue before response settlement",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);
 let release!:()=>void,started!:()=>void;const pending=new Promise<string>(resolve=>release=()=>resolve("ok")),ready=new Promise<void>(resolve=>started=resolve);
 const request=f.context.dispatch(f.actor,permit,()=>f.context.invokeClaimedRequest(f.actor,snapshot,()=>{started();return pending},undefined,()=>{}));
 await ready;await f.actorAuthority.coordinate(()=>undefined);release();expect(await request).toMatchObject({status:"sent",result:"ok"});
 await expect(f.context.invokeClaimedRequest(f.actor,snapshot,()=>Promise.resolve("again"),undefined,()=>{})).rejects.toThrow("MEMORY_CONTEXT_PERMIT_USED");
});
it("an edit after SDK admission but before actual fetch causes zero network sends",async()=>{
 const f=await contextFixture(),s=await f.source("I prefer English"),snapshot=await f.assemble([s.ref]),permit=await f.context.validateForDispatch(f.actor,snapshot);
 let proceed!:()=>void;const ready=new Promise<void>(resolve=>proceed=resolve);let sends=0;
 const request=f.context.dispatch(f.actor,permit,async()=>{await ready;return f.context.invokeClaimedRequest(f.actor,snapshot,()=>{sends++;return Promise.resolve("bad")},undefined,()=>{})});
 await f.registry.prepareChange(f.access,f.provider.adapter,s.ref);proceed();await request.catch(()=>{});expect(sends).toBe(0);
});
