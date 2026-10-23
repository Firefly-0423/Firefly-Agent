import { expect, it } from "vitest";
import { createMainAttachmentProjectionAuthority, prepareMainAttachmentProjection, readMainAttachmentGrant, readMainAttachmentProjection } from "./main-attachment-projection";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
const attachment = { kind: "image" as const, name: "synthetic.png", filePath: "/synthetic/never-read.png", mime: "image/png" };
const source = { sessionId: "session-a", userTurnId: "u1", userRevision: 1, userText: "Please inspect", attachments: [attachment] };
const entry = (override: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ id: "u1", seq: 1, at: 1, kind: "user", turnId: "u1", revision: 1, payload: { text: source.userText, attachments: [attachment] }, ...override } as TranscriptEntry);
it("publishes only immutable attachment blocks bound to the exact canonical user", async () => {
 const authority = createMainAttachmentProjectionAuthority();
 const grant = authority.issue({ ...source, assertCurrent() {} });
 const blocks = [{ type: "text" as const, text: "I prefer attached-content-only" }, { type: "image_url" as const, image_url: { url: "data:image/png;base64,c3ludGhldGlj" } }];
 const message = await prepareMainAttachmentProjection(grant, async bound => { expect(bound.userText).toBe(source.userText); return blocks; });
 blocks[0].text = "tampered";
 expect(message.text).toBe(source.userText + "\nI prefer attached-content-only");
 const projection = readMainAttachmentProjection(authority.token, "session-a", entry())!;
 expect(projection.message).toEqual(message); projection.assertCurrent();
 expect(readMainAttachmentProjection(authority.token, "another", entry())).toBeNull();
 expect(readMainAttachmentProjection(authority.token, "session-a", entry({ revision: 2 }))).toBeNull();
 expect(() => readMainAttachmentProjection(authority.token, "session-a", entry({ payload: { text: "forged", attachments: [attachment] } } as any))).toThrow("MEMORY_ATTACHMENT_DENIED");
});
it.each(["forged", "cloned", "revoked", "cancelled", "source changed"])("rejects %s grants before attachment reads", async kind => {
 const authority = createMainAttachmentProjectionAuthority(), controller = new AbortController(); let changed = false, reads = 0;
 const original = authority.issue({ ...source, signal: controller.signal, assertCurrent() { if (changed) throw Error("MEMORY_ATTACHMENT_DENIED"); } });
 const grant = kind === "forged" ? {} : kind === "cloned" ? { ...original } : original;
 if (kind === "revoked") authority.revokeTurn("session-a", "u1");
 if (kind === "cancelled") controller.abort();
 if (kind === "source changed") changed = true;
 await expect(prepareMainAttachmentProjection(grant as any, async () => { reads++; return []; })).rejects.toThrow(kind === "cancelled" ? "MEMORY_CONTEXT_CANCELLED" : "MEMORY_ATTACHMENT_DENIED");
 expect(reads).toBe(0);
});
it("rejects revocation during preparation and prevents a late publication", async () => {
 const authority = createMainAttachmentProjectionAuthority(), grant = authority.issue({ ...source, assertCurrent() {} });
 await expect(prepareMainAttachmentProjection(grant, async () => { authority.revokeSession("session-a"); return [{ type: "text", text: "late" }]; })).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
 expect(readMainAttachmentProjection(authority.token, "session-a", entry())).toBeNull();
});
it("revokes captured projection guards and never invokes accessors", async () => {
 const authority = createMainAttachmentProjectionAuthority(), grant = authority.issue({ ...source, assertCurrent() {} });
 await prepareMainAttachmentProjection(grant, async () => [{ type: "text", text: "file" }]);
 const projection = readMainAttachmentProjection(authority.token, "session-a", entry())!;
 authority.close(); expect(projection.assertCurrent).toThrow("MEMORY_ATTACHMENT_DENIED");
 let getters = 0; const openAuthority = createMainAttachmentProjectionAuthority();
 expect(() => openAuthority.issue({ ...source, attachments: [{ ...attachment, get caption() { getters++; return "bad"; } }], assertCurrent() {} })).toThrow("MEMORY_ATTACHMENT_DENIED");
 expect(getters).toBe(0);
 expect(() => readMainAttachmentGrant({} as any)).toThrow("MEMORY_ATTACHMENT_DENIED");
});
it("screens prepared text before it can become an S projection", async () => {
 const authority = createMainAttachmentProjectionAuthority(), grant = authority.issue({ ...source, assertCurrent() {} });
 await expect(prepareMainAttachmentProjection(grant, async () => [{ type: "text", text: "api_key=SYNTHETIC_SECRET_1234567890" }])).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
 expect(() => readMainAttachmentProjection(authority.token, "session-a", entry())).toThrow("MEMORY_ATTACHMENT_DENIED");
});

it("keeps close pending until an already started materializer settles even when it ignores cancellation", async () => {
 const authority=createMainAttachmentProjectionAuthority();let finish!:()=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve}),blocked=new Promise<void>(resolve=>{finish=resolve});
 const grant=authority.issue({...source,assertCurrent(){}});
 const preparation=prepareMainAttachmentProjection(grant,async()=>{entered();await blocked;return [{type:"text",text:"must never publish"}];});
 const rejected=expect(preparation).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");await started;
 let closed=false;const first=authority.close(),second=authority.close();expect(second).toBe(first);
 const drained=Promise.resolve(first).then(()=>{closed=true});await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
 let reads=0;await expect(prepareMainAttachmentProjection(grant,async()=>{reads++;return []})).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");expect(reads).toBe(0);
 finish();await rejected;await drained;expect(closed).toBe(true);
 expect(()=>readMainAttachmentProjection(authority.token,"session-a",entry())).toThrow("MEMORY_ATTACHMENT_DENIED");
});
it("quiesce denies queued preparations and close drains a rejected materializer",async()=>{
 const authority=createMainAttachmentProjectionAuthority();let finish!:(error:Error)=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve}),blocked=new Promise<never>((_resolve,reject)=>{finish=reject});
 const grant=authority.issue({...source,assertCurrent(){}}),pending=prepareMainAttachmentProjection(grant,async()=>{entered();return blocked});
 const rejected=expect(pending).rejects.toThrow("synthetic-failure");await started;authority.quiesce();
 expect(()=>authority.issue({...source,assertCurrent(){}})).toThrow("MEMORY_ATTACHMENT_DENIED");
 const closing=authority.close();finish(Error("synthetic-failure"));await rejected;await expect(closing).resolves.toBeUndefined();
});

it("rejects malformed materializer blocks with a reason code",async()=>{
 const authority=createMainAttachmentProjectionAuthority(),grant=authority.issue({...source,assertCurrent(){}});
 await expect(prepareMainAttachmentProjection(grant,async()=>[null] as any)).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
});

it("reprepares one authorized image as caption, invalidating the old frame before callbacks run",async()=>{
 const {reprepareMainAttachmentProjection,observeMainAttachmentProjection}=await import("./main-attachment-projection");
 const authority=createMainAttachmentProjectionAuthority(),grant=authority.issue({...source,assertCurrent(){}});
 await prepareMainAttachmentProjection(grant,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);
 const before=readMainAttachmentProjection(authority.token,"session-a",entry())!;let changes=0,reads=0;
 const unobserve=observeMainAttachmentProjection(authority.token,"session-a",async changed=>{changes++;expect(changed.userRevision).toBe(1);expect(before.assertCurrent).toThrow("MEMORY_ATTACHMENT_DENIED")});
 const after=await reprepareMainAttachmentProjection(grant,async bound=>{reads++;expect(bound.userText).toBe(source.userText);return [{type:"text",text:"authorized caption"}]});
 expect(before.assertCurrent).toThrow("MEMORY_ATTACHMENT_DENIED");expect(changes).toBe(1);expect(reads).toBe(1);expect(after.text).toBe(source.userText+"\nauthorized caption");
 expect(readMainAttachmentProjection(authority.token,"session-a",entry())!.message).toEqual(after);
 expect(await reprepareMainAttachmentProjection(grant,async()=>{reads++;return []})).toEqual(after);expect(reads).toBe(1);unobserve();
});
it("does not start caption reads without a successfully prepared direct image",async()=>{
 const {reprepareMainAttachmentProjection}=await import("./main-attachment-projection"),authority=createMainAttachmentProjectionAuthority(),grant=authority.issue({...source,assertCurrent(){}});let reads=0;
 await expect(reprepareMainAttachmentProjection(grant,async()=>{reads++;return []})).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
 await prepareMainAttachmentProjection(grant,async()=>[{type:"text",text:"already captioned"}]);
 await expect(reprepareMainAttachmentProjection(grant,async()=>{reads++;return []})).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");expect(reads).toBe(0);
});
it("drains caption reprepare after close and never publishes late caption bytes",async()=>{
 const {reprepareMainAttachmentProjection}=await import("./main-attachment-projection"),authority=createMainAttachmentProjectionAuthority(),grant=authority.issue({...source,assertCurrent(){}});
 await prepareMainAttachmentProjection(grant,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);
 let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(done=>{release=done}),started=new Promise<void>(done=>{entered=done});
 const pending=reprepareMainAttachmentProjection(grant,async()=>{entered();await blocked;return [{type:"text",text:"late caption"}]});const rejected=expect(pending).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");await started;
 let closed=false;const closing=authority.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);release();await rejected;await closing;
 expect(()=>readMainAttachmentProjection(authority.token,"session-a",entry())).toThrow("MEMORY_ATTACHMENT_DENIED");
});
