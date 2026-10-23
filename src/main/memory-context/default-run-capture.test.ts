import path from "node:path";
import fs from "node:fs";
import {historyOriginEvent} from '../memory-history/history-origins';
import { expect, it, vi } from "vitest";
import { contextFixture } from "../../../scripts/verify/memory-context/context-fixture";
import { createMainUserFactCoordinator } from "../memory-policy/main-user-fact-coordinator";
import { createMainFactSelector } from "../memory-recall/main-fact-selector";
import { createMainRecall } from "../memory-recall/main-recall";
import { createMainHistory } from "../memory-history/main-history";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createTranscriptSink, requireTranscriptSinkBinding } from "../orchestrator/transcript-sink";
import type { ChatMessage, ChatRequest } from "../orchestrator/vendors/types";
import type { MainMemoryRunLifecycle } from "./main-memory-runtime";
import { createDefaultRunCapture } from "./default-run-capture";
import {createMainAttachmentProjectionAuthority,prepareMainAttachmentProjection} from "./main-attachment-projection";
import { bindRunAdjustmentPoller, createRunAdjustmentPoller } from "../chats/pending-adjustment";

async function fixture(options: { attachmentBody?: string; facts?: boolean; userText?: string; historyTexts?: string[]; maxSTokens?: number; summary?: { protectedRecentTurns: number; leaseMs?: number }; beforeMutation?: NonNullable<Parameters<typeof import("./default-run-capture").createDefaultRunCapture>[0]>["beforeMutation"] } = {}) {
  const { createDefaultRunCapture } = await import("./default-run-capture");
  const f = await contextFixture();
  const store = new ConversationTranscriptStore(path.join(f.root, "conversation"));
  const userText = options.userText ?? "synthetic question";
  if(options.maxSTokens!==undefined)f.options.budget.maxSTokens=options.maxSTokens;
  for(const [index,text] of (options.historyTexts??[]).entries())await store.append("session-a",{id:`history-${index}`,kind:"user",turnId:`history-${index}`,revision:1,at:500+index,payload:{text}});
  const attachmentAuthority=createMainAttachmentProjectionAuthority(),attachments=options.attachmentBody?[{kind:"document" as const,name:"synthetic.txt",filePath:"/synthetic/not-read.txt"}]:undefined;
  if(attachments){const grant=attachmentAuthority.issue({sessionId:"session-a",userTurnId:"u1",userRevision:1,userText,attachments,assertCurrent(){}});await prepareMainAttachmentProjection(grant,async()=>[{type:"text",text:options.attachmentBody!}]);}
  await store.append("session-a", { id: "u1", kind: "user", turnId: "u1", revision: 1, at: 1000, payload: { text: userText, ...(attachments?{attachments}:{}) } });
  const controller = new AbortController();
  let tracked = 0, settled = 0;
  const lifecycle: MainMemoryRunLifecycle = {
    signal: controller.signal,
    assertCurrent() { if (controller.signal.aborted) throw Error("MEMORY_CONTEXT_CANCELLED"); },
    track(operation) { tracked++; const result = operation(); void result.finally(() => { settled++; }).catch(() => {}); return result; },
  };
  const target = { store, conversationId: "session-a", runId: "run-a", assistantTurnId: "assistant-turn" };
  const factOptions = options.facts ? {
    currentUserSource: async ({ userTurnId }: { userTurnId: string; userRevision: number }) => {
      const identity = { ...f.identity, messageId: userTurnId };
      f.provider.write(identity, { text: userText, role: "user", trust: "direct-user-event", occurredAt: 1000 });
      return f.registry.capture(f.access, f.provider.adapter, identity);
    },
    coordinator: createMainUserFactCoordinator({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy }),
    selector: createMainFactSelector({ actorAuthority: f.actorAuthority, registry: f.registry, policy: f.policy, recall: createMainRecall({ actorAuthority: f.actorAuthority, transport: { ...f.transport, recallCommand: async (command: unknown) => f.repo.recallCommand(command) } }) }),
    limits: { maxFacts: 20 },
  } : undefined;
  const captureOptions = { ...target, attachmentProjection:attachmentAuthority.token, context: f.context, actorAuthority: f.actorAuthority, actorToken: f.actor, registry: f.registry, ...(factOptions ? { facts: factOptions } : {}), ...(options.beforeMutation ? { beforeMutation: options.beforeMutation } : {}), ...(options.summary ? { summary: options.summary } : {}) };
  const capture = createDefaultRunCapture(captureOptions);
  const original = createTranscriptSink(target), sink = capture.bindSink!(original, lifecycle);
  const request: ChatRequest = { model: "synthetic-model", stream: false, messages: [{ role: "system", content: "I prefer zsh" }, { role: "user", content: "forged request history" }] };
  async function response() {
    const sources = await capture.capture(request, controller.signal);
    const snapshot = await f.context.assemble(f.actor, { ...sources, sessionId: "session-a", signal: controller.signal });
    const permit = await f.context.validateForDispatch(f.actor, snapshot, controller.signal);
    await f.context.dispatch(f.actor, permit, () => ({ text: "synthetic reply" }), controller.signal);
    await capture.onResponse!({ snapshot, signal: controller.signal });
    return { sources, snapshot };
  }
  return { ...f, store, capture, captureOptions, original, sink, target, request, response, controller, lifecycle, get tracked() { return tracked; }, get settled() { return settled; } };
}

it("captures canonical S, commits both tool results, and refreshes the next response snapshot", async () => {
  const f = await fixture();
  requireTranscriptSinkBinding(f.sink, f.target, f.store);
  const first = await f.response();
  const message: ChatMessage = { role: "assistant", content: "checking", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }, { id: "t2", name: "lookup", arguments: "{}" }] };
  const assistantEntryId = await f.sink.appendAssistant({ message, roundId: "r1" });
  await Promise.all(["t1", "t2"].map(toolCallId => f.sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId, name: "lookup", content: `result ${toolCallId}` }, outcome: "success", roundId: "r1" })));
  const second = await f.response();
  expect(second.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
  await f.sink.appendAssistant({ message: { role: "assistant", content: "done" }, roundId: "r2" });
  const entries = (await f.store.read("session-a")).entries;
  expect(entries.map(entry => entry.kind)).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
  expect(entries.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  const snapshots = (f.commands as Array<{ kind: string; body: unknown }>).filter(command => command.kind === "snapshot");
  expect(JSON.stringify(snapshots)).not.toContain("forged request history");
  expect(await f.policy.recall(f.actor)).toEqual([]);
  expect(f.tracked).toBe(4); expect(f.settled).toBe(4);
});
it('persists the actual current user and guarded response origins for native history',async()=>{
 const f=await fixture({facts:true});await f.response();await f.sink.appendAssistant({message:{role:'assistant',content:'safe response'},roundId:'r1'});
 for(const entry of (await f.store.read('session-a')).entries){
  expect(f.repo.historyCommand({kind:'originStatus',scopeKey:'scope-a',body:{actorKey:'actor-a',providerId:'synthetic',sessionId:'session-a',event:historyOriginEvent(entry)}})).toEqual({valid:true});
 }
});

it("denies a canonical write before a successful model response", async () => {
  const f = await fixture();
  await expect(f.sink.appendAssistant({ message: { role: "assistant", content: "unsent" } })).rejects.toThrow("MEMORY_CONTEXT_RESPONSE_UNSENT");
  expect((await f.store.read("session-a")).throughSeq).toBe(1);
});

it("rejects forged or mismatched sink bindings", async () => {
  const f = await fixture();
  expect(() => f.capture.bindSink!({ ...f.original }, f.lifecycle)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  expect(() => f.capture.bindSink!(createTranscriptSink({ ...f.target, runId: "other-run" }), f.lifecycle)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  expect(() => f.capture.bindSink!(createTranscriptSink({ ...f.target, store: new ConversationTranscriptStore(path.join(f.root, "other")) }), f.lifecycle)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
});

it.each(["edit", "insert"])("rejects %s before response observers can reserve or write", async kind => {
  const f = await fixture(); await f.response();
  await f.store.append("session-a", kind === "edit"
    ? { id: "edit", at: 1001, kind: "turn_rewind", turnId: "u1", revision: 2, payload: { anchorUserTurnId: "u1", disposition: "replace_user", reason: "edit", replacementUser: { text: "changed" } } }
    : { id: "u2", at: 1001, kind: "user", turnId: "u2", revision: 1, payload: { text: "new" } });
  const reserves = f.commands.filter((command: any) => command.kind === "transcriptReserveBatch").length;
  await expect(f.sink.appendAssistant({ message: { role: "assistant", content: "stale" } })).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  expect(f.commands.filter((command: any) => command.kind === "transcriptReserveBatch")).toHaveLength(reserves);
  expect((await f.store.read("session-a")).entries.some(entry => entry.kind === "assistant")).toBe(false);
});

it("preserves both validation and commit guards supplied by the caller", async () => {
  const f = await fixture(); await f.response();
  let checked = 0, committed = 0;
  await f.sink.appendAssistant({ message: { role: "assistant", content: "guarded" }, guard: { throughSeq: 1, validate: async () => { checked++; }, commit: write => { committed++; return write(); } } });
  expect(checked).toBe(1); expect(committed).toBe(1);
  await expect(f.sink.appendAssistant({ message: { role: "assistant", content: "duplicate response" } })).rejects.toThrow("MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED");
});

it("allows deterministic cancellation closure but rejects late successful response writes", async () => {
  const f = await fixture(); await f.response();
  const assistantEntryId = await f.sink.appendAssistant({ message: { role: "assistant", content: "checking", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] } });
  f.controller.abort();
  await expect(f.sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "t1", content: "late success" }, outcome: "success" })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  await expect(f.sink.appendAssistant({ message: { role: "assistant", content: "late response" } })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  await f.sink.closeInterruption({ reason: "user_cancel", runSession: { conversationId: "session-a", runId: "run-a", toolCalls: [{ toolCallId: "t1", toolName: "lookup", status: "started" }] } as any });
  await f.sink.checkpoint();
  const entries = (await f.store.read("session-a")).entries;
  expect(entries.filter(entry => entry.kind === "tool_result").map(entry => entry.payload.outcome)).toEqual(["unknown"]);
  expect(JSON.stringify(entries)).not.toContain("late success");
  expect(entries.at(-1)?.kind).toBe("interruption");
  expect(f.tracked).toBe(f.settled);
});

it("admits M only from the matching trusted current-user body and revision", async () => {
  const f = await fixture({ facts: true, userText: "I prefer bash" });
  const { sources } = await f.response();
  expect(sources.currentUserSourceRef?.binding.messageId).toBe("u1");
  expect(sources.factRefs).toHaveLength(1);
  expect((await f.policy.recall(f.actor)).map(fact => fact.assertion)).toEqual(["I prefer bash"]);
});

it("fans out the canonical mutation ticket before writing and rejects a failed native invalidation", async () => {
  const observed: Array<{ kind: string; entryId?: string; ticket?: object; throughSeq: number }> = [];
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ beforeMutation: async (kind, entry, ticket) => {
    const entries = fs.readFileSync(path.join(f.root, "conversation", "transcripts", "session-a", "transcript.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    observed.push({ kind, entryId: entry?.id, ticket, throughSeq: entries.at(-1).seq });
    throw Error("MEMORY_HISTORY_NATIVE_INVALIDATION_FAILED");
  } });
  await f.response();
  await expect(f.sink.appendAssistant({ message: { role: "assistant", content: "must not persist" }, roundId: "r1" })).rejects.toThrow("MEMORY_HISTORY_NATIVE_INVALIDATION_FAILED");
  expect(observed).toEqual([{ kind: "append", entryId: "run-a:assistant:r1", ticket: expect.any(Object), throughSeq: 1 }]);
  expect((await f.store.read("session-a")).throughSeq).toBe(1);
});

it.each([false, true])("accepts only other-session H partitions (include current: %s)", async includeCurrent => {
  const f = await fixture();
  const history = createMainHistory({ actorAuthority: f.actorAuthority, registry: f.registry,
    transport: { ...f.transport, historyCommand: async command => f.repo.historyCommand(command) } });
  const identity = { ...f.identity, sessionId: "session-b", messageId: "historical-user" };
  f.provider.write(identity, { text: "cat historical note", role: "user", trust: "direct-user-event", occurredAt: 1000 });
  const source = await f.registry.capture(f.access, f.provider.adapter, identity);
  const sibling = f.actorAuthority.bindActor(f.access, f.provider.adapter, identity);
  await history.captureSource(sibling, source, { documentId: "historical-note", incarnation: "historical-incarnation", revision: 1 });
  const scope = history.grantSessions(f.actor, [sibling], { includeCurrent });
  const result = await history.query(f.actor, { query: "cat", scope }); expect(result.hits).toHaveLength(1);
  await f.capture.close!();
  const capture = createDefaultRunCapture({ ...f.captureOptions, history: { query: async () => [result.evidence] } });
  try {
    const operation = capture.capture(f.request, f.controller.signal);
    if (includeCurrent) await expect(operation).rejects.toThrow("MEMORY_CONTEXT_HISTORY_CURRENT_SESSION_DENIED");
    else expect((await operation).historyTokens).toEqual([result.evidence]);
  } finally { await capture.close!(); }
});

it("invalidates the synchronous capture fence before a mutation observer first awaits", async () => {
  const f = await fixture(), sources = await f.capture.capture(f.request, f.controller.signal);
  expect(() => sources.assertCurrent()).not.toThrow();
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const generation = f.context.transcriptGeneration.bind(f.context);
  const spy = vi.spyOn(f.context, "transcriptGeneration").mockImplementation(async token => { arrive(); await held; return generation(token); });
  const mutation = f.store.append("session-a", { id: "early-edit", at: 2000, kind: "turn_rewind", turnId: "u1", revision: 2,
    payload: { anchorUserTurnId: "u1", disposition: "replace_user", reason: "edit", replacementUser: { text: "changed" } } });
  await arrived;
  try { expect(() => sources.assertCurrent()).toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE"); }
  finally { release(); await mutation; spy.mockRestore(); }
});

function adjustment(f: Awaited<ReturnType<typeof fixture>>) {
  const queue = [{ id: "adjust-user", rawContent: "another trusted question", visibleContent: "another trusted question", enqueuedAt: 1001, adjustRunId: "run-a" }];
  const poller = createRunAdjustmentPoller("session-a", "run-a", {
    getPendingMessages: () => [...queue],
    commitPendingAdjust: () => { queue.splice(0); return { ok: true, userMessage: { id: "adjust-user" }, remainingQueue: [] }; },
  });
  const release = bindRunAdjustmentPoller(poller, { sessionId: "session-a", runId: "run-a" }, (permit, commit) => f.capture.commitRunAdjustment(permit, commit));
  return { poller, queue, release };
}

it.each(["before-first-round", "between-rounds"])("transfers a genuine Main poller adjustment %s to the next canonical capture", async boundary => {
  const f = await fixture(), a = adjustment(f);
  if (boundary === "between-rounds") { await f.response(); await f.sink.appendAssistant({ message: { role: "assistant", content: "first answer" }, roundId: "r1" }); }
  try {
    await expect(a.poller()).resolves.toEqual([{ id: "adjust-user", rawContent: "another trusted question" }]);
    expect(a.queue).toHaveLength(0);
    const { sources } = await f.response();
    expect(sources.currentTranscript?.user).toEqual({ turnId: "adjust-user", revision: 1 });
    await f.sink.appendAssistant({ message: { role: "assistant", content: "adjusted answer" }, roundId: "r2" });
    expect((await f.store.read("session-a")).entries.filter(entry => entry.kind === "user" && entry.turnId === "adjust-user")).toHaveLength(1);
  } finally { a.release(); }
});

it("rejects a poller adjustment while canonical tool results are pending", async () => {
  const f = await fixture(), a = adjustment(f); await f.response();
  await f.sink.appendAssistant({ message: { role: "assistant", content: "checking", toolCalls: [{ id: "t1", name: "lookup", arguments: "{}" }] }, roundId: "r1" });
  try {
    await expect(a.poller()).rejects.toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
    expect(a.queue).toHaveLength(1);
    expect((await f.store.read("session-a")).entries.filter(entry => entry.kind === "user")).toHaveLength(1);
  } finally { a.release(); }
});

it("returns the Main history query's evidence and coverage notice together", async () => {
  const f = await fixture(); await f.capture.close!();
  const notice = 'History coverage: {"status":"partial","covered":0,"selected":1}';
  const capture = createDefaultRunCapture({ ...f.captureOptions, history: { query: async () => ({ tokens: [], notice }) } });
  try {
    const sources = await capture.capture(f.request, f.controller.signal);
    expect(sources.historyTokens).toEqual([]); expect(sources.contextNotice).toBe(notice);
  } finally { await capture.close!(); }
});

it("rejects a cancelled poller adjustment before its canonical user write", async () => {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ beforeMutation: async (_kind, entry) => {
    if (entry?.kind === "user" && entry.turnId === "adjust-user") { arrive(); await held; }
  } }), a = adjustment(f);
  const pending = a.poller()!.then(() => "success", error => error.message);
  await arrived; f.controller.abort(); release();
  try {
    const result = await pending;
    expect((await f.store.read("session-a")).entries.filter(entry => entry.kind === "user")).toHaveLength(1);
    expect(result).toBe("MEMORY_CONTEXT_CANCELLED"); expect(a.queue).toHaveLength(1);
  } finally { a.release(); }
});


it("uses an automatic historical summary across two tool rounds without reopening its lease",async()=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],maxSTokens:1500,summary:{protectedRecentTurns:1}});
 const first=await f.response();expect(first.sources.summaryIds).toHaveLength(1);
 expect(first.snapshot.request.body.messages.map((m:any)=>m.text)).toEqual(["retained historical user","synthetic question"]);
 for(const [index,callIds] of [["1",["t1","t2"]],["2",["t3"]]] as const){
  const assistantEntryId=await f.sink.appendAssistant({message:{role:"assistant",content:`round ${index}`,toolCalls:callIds.map(id=>({id,name:"lookup",arguments:"{}"}))},roundId:`r${index}`});
  for(const toolCallId of callIds)await f.sink.appendToolResult({assistantEntryId,message:{role:"tool",name:"lookup",toolCallId,content:`result ${toolCallId}`},outcome:"success",roundId:`r${index}`});
  const next=await f.response();expect(next.sources.summaryIds).toEqual(first.sources.summaryIds);expect(next.snapshot.excluded).toEqual([]);
  expect(JSON.stringify(next.snapshot.request)).toContain("retained historical user");expect(JSON.stringify(next.snapshot.request)).toContain(`result ${callIds.at(-1)}`);
 }
 expect(f.commands.filter((c:any)=>c.kind==="summaryLease")).toHaveLength(1);expect(f.commands.filter((c:any)=>c.kind==="summaryCommit")).toHaveLength(1);
 expect((await f.store.read("session-a")).entries[0].payload.text).toBe("old discard ".repeat(500));
});
it("does not retry an automatic no-benefit selection on every tool round",async()=>{
 const f=await fixture({historyTexts:["history one","history two"],maxSTokens:10000,summary:{protectedRecentTurns:1}}),first=await f.response();
 expect(first.sources.summaryIds??[]).toEqual([]);
 const assistantEntryId=await f.sink.appendAssistant({message:{role:"assistant",content:"checking",toolCalls:[{id:"t1",name:"lookup",arguments:"{}"}]},roundId:"r1"});
 await f.sink.appendToolResult({assistantEntryId,message:{role:"tool",toolCallId:"t1",content:"done"},outcome:"success",roundId:"r1"});
 const next=await f.response();expect(next.sources.summaryIds??[]).toEqual([]);expect(JSON.stringify(next.snapshot.request)).toContain("history one");
 expect(f.commands.filter((c:any)=>c.kind==="summaryLease")).toHaveLength(1);expect(f.commands.filter((c:any)=>c.kind==="summaryCommit")).toHaveLength(0);
});
it("retains an existing summary when a trusted adjustment introduces a new user turn with no further benefit",async()=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],maxSTokens:1500,summary:{protectedRecentTurns:1}}),first=await f.response();
 expect(first.sources.summaryIds).toHaveLength(1);await f.sink.appendAssistant({message:{role:"assistant",content:"first answer"},roundId:"r1"});
 const a=adjustment(f);try{
  await a.poller();const next=await f.response();expect(next.sources.summaryIds).toEqual(first.sources.summaryIds);
  expect(next.sources.currentTranscript?.user).toEqual({turnId:"adjust-user",revision:1});
  expect(JSON.stringify(next.snapshot.request)).toContain("retained historical user");expect(JSON.stringify(next.snapshot.request)).toContain("another trusted question");
  expect(f.commands.filter((c:any)=>c.kind==="summaryLease")).toHaveLength(2);expect(f.commands.filter((c:any)=>c.kind==="summaryCommit")).toHaveLength(1);
 }finally{a.release()}
});
it("invalidated summaries are discarded and never reused after suppression changes",async()=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],userText:"I prefer English",maxSTokens:1500,summary:{protectedRecentTurns:1}}),active=await f.active(),first=await f.response();
 expect(first.sources.summaryIds).toHaveLength(1);await f.forget(active.factId!);
 const next=await f.response();expect(next.sources.summaryIds??[]).toEqual([]);
 expect((f.commands.filter((c:any)=>c.kind==="snapshot").at(-1) as any).body.requiredSummaries).toEqual([]);
 expect(f.commands.filter((c:any)=>c.kind==="summaryLease")).toHaveLength(1);
});
it("summary configuration cannot include the active user turn or create an invalid lease",async()=>{
 const f=await fixture();await f.capture.close!();
 for(const summary of [{protectedRecentTurns:0},{protectedRecentTurns:1,leaseMs:0},{protectedRecentTurns:1.5}])expect(()=>createDefaultRunCapture({...f.captureOptions,summary})).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
});

it("optional summarization does not block a fresh allowed capture after older sources are suppressed",async()=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],userText:"I prefer English",maxSTokens:1500,summary:{protectedRecentTurns:1}}),active=await f.active();
 await f.forget(active.factId!);
 const next=await f.response();expect(next.sources.summaryIds??[]).toEqual([]);
 expect(next.snapshot.request.body.messages).toEqual([{role:"user",text:"I prefer English"}]);
 expect(f.commands.filter((c:any)=>c.kind==="summaryCommit")).toHaveLength(0);
 await f.sink.appendAssistant({message:{role:"assistant",content:"new allowed answer"},roundId:"r1"});
 const continued=await f.response();expect(continued.sources.summaryIds??[]).toEqual([]);
 expect(f.commands.filter((c:any)=>c.kind==="summaryLease")).toHaveLength(1);
 expect(JSON.stringify(continued.snapshot.request)).toContain("new allowed answer");
});

it.each(["MEMORY_ACTOR_DENIED","MEMORY_RUN_READ_DENIED","UNKNOWN_SUMMARY_FAILURE"])("does not downgrade %s to an optional summary miss",async code=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],maxSTokens:1500,summary:{protectedRecentTurns:1}}),command=f.transport.contextCommand;
 f.transport.contextCommand=async input=>{if(input.kind==="summaryLease")throw Error(code);return command(input)};
 await expect(f.response()).rejects.toThrow(code);
 expect(f.commands.filter((c:any)=>c.kind==="snapshot"||c.kind==="claim"||c.kind==="summaryCommit")).toHaveLength(0);
});
it("cancellation during automatic summary counting still rejects the complete capture",async()=>{
 const f=await fixture({historyTexts:["old discard ".repeat(500),"retained historical user"],maxSTokens:1500,summary:{protectedRecentTurns:1}});
 f.setCountHook(async()=>{f.controller.abort()});
 await expect(f.response()).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
 expect(f.commands.filter((c:any)=>c.kind==="snapshot"||c.kind==="claim"||c.kind==="summaryCommit")).toHaveLength(0);
});

it("counts authorized attachment body in S while only original human text supplies M",async()=>{
 const f=await fixture({facts:true,userText:"I prefer PowerShell",attachmentBody:"I prefer attachment-only-zsh"});
 const result=await f.response();expect(JSON.stringify(result.snapshot.request)).toContain("attachment-only-zsh");
 const facts=await f.policy.recall(f.actor);expect(JSON.stringify(facts)).toContain("PowerShell");expect(JSON.stringify(facts)).not.toContain("attachment-only-zsh");
});
