import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatSession, ToolFileChange } from "../../../../../../shared/chat-types";
import type { FireflyTerminalStatus } from "../../../../../../shared/run-terminal";
import type { AguiApi, AguiEvent, ChatStoreApi } from "../chat-page-bridge";
import type { TodoStateBySession } from "../session-runtime-state";
import { AgentRunController, type AgentRunHost, type AgentRunInput, type AgentRunRegistries } from "./AgentRunController";
import { t } from "../../../../i18n";

type Acknowledgement = { success: boolean; runId: string; error?: string; mainOwnsTerminal?: boolean };
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const successfulAck = (runId = "run-1"): Acknowledgement => ({ success: true, runId });
const terminalResult = (status: FireflyTerminalStatus) => ({ status, externalEffectsMayContinue: status !== "success" });
function inputFor(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const sessionId = overrides.sessionId ?? "session-1";
  return { targetMode: "chat", sessionId, userMessageId: "user-1", assistantId: "assistant-1", attachments: [], session: { id: sessionId, messages: [{ id: "user-1", role: "user", content: "Review the public document", at: 1 }] } as ChatSession, ...overrides };
}
function registries(): AgentRunRegistries {
  return { checkpointTriggers: { current: {} }, activeRuns: { current: {} }, eventUnsubscribers: { current: new Set() }, cancelRequestedSessions: { current: new Set() } };
}
function memory() {
  return { upsert: vi.fn(async (_sessionId: string, message: any) => ({ id: "session-1", messages: [message] }) as unknown as ChatSession | null), append: vi.fn(async () => null), pendingCompleteDispatch: vi.fn(async () => ({ ok: true })) };
}
function observer() {
  let todos: TodoStateBySession = {};
  return {
    patchMessage: vi.fn<AgentRunHost["patchMessage"]>(), clearInteraction: vi.fn(), setInteraction: vi.fn(), dismissAskIfMatched: vi.fn(),
    setModeBusy: vi.fn(), clearTakeover: vi.fn(), requestTakeover: vi.fn<AgentRunHost["requestTakeover"]>(), onRunFinished: vi.fn(),
    updateContextUsage: vi.fn(), setCompressingContext: vi.fn(),
    updateTodos: vi.fn((_id: string, apply: (state: TodoStateBySession) => TodoStateBySession) => { todos = apply(todos); }),
  } satisfies AgentRunHost;
}
type Observer = ReturnType<typeof observer>;
type Memory = ReturnType<typeof memory>;
function runScenario(options: { ack?: Acknowledgement; acknowledge?: () => Promise<Acknowledgement>; input?: Partial<AgentRunInput>; host?: Observer; disk?: Memory; refs?: AgentRunRegistries; unavailable?: boolean } = {}) {
  const callbacks = new Set<(event: AguiEvent) => void>();
  const bridge = {
    run: vi.fn<AguiApi["run"]>(async () => options.acknowledge ? options.acknowledge() : options.ack ?? successfulAck()), cancel: vi.fn(async () => {}), reportRunPersisted: vi.fn(),
    onEvent: vi.fn((callback: (event: AguiEvent) => void) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; }),
  } satisfies AguiApi;
  const disk = options.disk ?? memory(); const host = options.host ?? observer(); const refs = options.refs ?? registries();
  const request = inputFor(options.input); const restart = vi.fn(async (_input: AgentRunInput) => {});
  const completed = new AgentRunController(request, { host, registries: refs, store: disk as unknown as ChatStoreApi, api: options.unavailable ? undefined : bridge, startRun: restart }).start();
  const send = (event: AguiEvent) => { for (const callback of callbacks) callback(event); };
  const runId = options.ack?.runId || "run-1";
  return {
    bridge, disk, host, refs, request, restart, completed, send,
    async ready() { await nextTurn(); send({ runId, type: "RUN_STARTED" }); },
    custom(name: string, value: unknown) { send({ type: "CUSTOM", runId, name, value }); },
    round(roundId = "round-0", action = "start") { send({ type: "CUSTOM", name: "firefly.round", runId, value: { roundId, action } }); },
    candidate(delta: string, roundId = "round-0") { send({ type: "CUSTOM", name: "firefly.candidate_text", runId, value: { roundId, action: "delta", delta } }); },
    text(...deltas: string[]) {
      send({ type: "TEXT_MESSAGE_START", runId, messageId: "answer-stream" });
      for (const delta of deltas) send({ type: "TEXT_MESSAGE_CONTENT", runId, delta });
      send({ type: "TEXT_MESSAGE_END", runId, messageId: "answer-stream" });
    },
    async finish(status: FireflyTerminalStatus = "success") { send({ type: "RUN_FINISHED", runId, result: terminalResult(status) }); await completed; },
    async fail(message = "transport disconnected", extra: Record<string, unknown> = {}) { send({ type: "RUN_ERROR", runId, message, ...extra } as AguiEvent); await completed; },
    patches: () => host.patchMessage.mock.calls.map(args => args[2]),
    saved: () => disk.upsert.mock.calls.map(args => args[1] as any),
    lastSaved: () => disk.upsert.mock.calls.at(-1)?.[1] as any,
    expectPatch(fields: Record<string, unknown>) { expect(host.patchMessage).toHaveBeenCalledWith(request.sessionId, request.assistantId, expect.objectContaining(fields)); },
  };
}
function frames() {
  const queue = new Map<number, FrameRequestCallback>(); let clock = performance.now(); let serial = 0;
  Object.assign(window, { requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { queue.set(++serial, callback); return serial; }), cancelAnimationFrame: vi.fn((id: number) => { queue.delete(id); }) });
  function tick() {
    clock = Math.max(clock + 40, performance.now() + 50);
    const batch = Array.from(queue.values()); queue.clear(); for (const callback of batch) callback(clock);
  }
  return { tick, async drain() { for (let guard = 0; queue.size && guard < 200; guard++) { tick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } } };
}
beforeEach(() => { vi.stubGlobal("window", { chat: undefined, setTimeout, clearTimeout }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Dispatch acknowledgement and checkpoint ownership", () => {
  test("an unavailable bridge persists the error without entering busy state", async () => {
    const s = runScenario({ unavailable: true }); await s.completed;
    s.expectPatch({ loading: false, streaming: false });
    expect(s.disk.append).toHaveBeenCalled();
    expect(s.host.onRunFinished.mock.calls).toEqual([[{ mode: "chat", sessionId: "session-1", queuePaused: true }]]);
    expect(s.host.setModeBusy).not.toHaveBeenCalled();
  });
  test.each([true, false])("a claimed dispatch with accepted=%s clears its ledger only after acceptance", async accepted => {
    const s = runScenario({ ack: accepted ? successfulAck() : { success: false, runId: "", error: "AGUI_NOT_READY" }, input: { claimedPendingMessageId: "queued-dispatch" } });
    if (accepted) { await s.ready(); await s.finish(); } else await s.completed;
    if (accepted) expect(s.disk.pendingCompleteDispatch.mock.calls).toEqual([["session-1", "queued-dispatch"]]);
    else expect(s.disk.pendingCompleteDispatch).not.toHaveBeenCalled();
    expect(s.host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: !accepted });
  });
  test("failure to clear an accepted claim does not turn a successful answer into a model failure", async () => {
    const disk = memory(); disk.pendingCompleteDispatch.mockRejectedValueOnce(new Error("dispatch receipt lost"));
    const s = runScenario({ disk, input: { claimedPendingMessageId: "queued-dispatch" } }); await s.ready();
    s.text("The review is complete."); await s.finish();
    expect(disk.pendingCompleteDispatch).toHaveBeenCalledTimes(1);
    expect(s.lastSaved()).toMatchObject({ content: "The review is complete.", runSnapshot: { terminalStatus: "success" } });
    expect(s.host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: false });
  });
  test("successful streaming checkpoints retain the user anchor and settle in lifecycle order", async () => {
    const s = runScenario(); await s.ready(); s.text("Doc", " checked"); await s.finish();
    expect(s.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", userTurnId: "user-1", assistantTurnId: "assistant-1" }));
    const records = s.saved();
    expect(records.map(record => record.runSnapshot?.runId)).toContain("run-1");
    expect(records.every(record => record.answersUserMessageId === "user-1")).toEqual(true);
    s.expectPatch({ content: "Doc", streaming: true });
    s.expectPatch({ content: "Doc checked", streaming: false, responseStarted: true, loading: false });
    expect(records[0].runSnapshot.status).toEqual("running");
    expect(s.lastSaved()).toMatchObject({ content: "Doc checked", runSnapshot: { status: "terminal", terminalStatus: "success" } });
    expect(s.bridge.reportRunPersisted).toHaveBeenCalledWith({ finalMessageId: "assistant-1", runId: "run-1" });
    expect(s.host.setModeBusy).toHaveBeenCalledWith("chat", false);
    expect(s.refs.activeRuns.current["session-1"]).toBeUndefined();
    expect(s.refs.checkpointTriggers.current["session-1"]).toBeUndefined();
    expect(s.refs.eventUnsubscribers.current.size).toEqual(0);
    expect(s.host.onRunFinished).toHaveBeenCalledWith({ mode: "chat", sessionId: "session-1", queuePaused: false });
  });
  test("checkpoint triggers exist during a run and are removed when it settles", async () => {
    const s = runScenario(); await nextTurn();
    expect(s.refs.checkpointTriggers.current["session-1"]).toBeTypeOf("function");
    s.send({ type: "RUN_STARTED", runId: "run-1" }); await s.finish(); expect(s.refs.checkpointTriggers.current["session-1"]).toBeUndefined();
  });
  test("a choice event displays one card and permits a waiting-user checkpoint", async () => {
    const s = runScenario(); await s.ready();
    s.custom("firefly.choice", { interactionId: "review-choice", runId: "run-1", revision: 1, questions: [{ id: "scope", prompt: "Choose the review scope", customInput: { enabled: true } }] });
    const checkpoint = s.refs.checkpointTriggers.current["session-1"]; expect(checkpoint).toBeTypeOf("function"); await checkpoint?.("waiting_user");
    await s.finish();
    expect(s.host.setInteraction).toHaveBeenCalledTimes(1);
    expect(s.saved().map(record => record.runSnapshot?.status)).toContain("waiting_user");
    expect(s.host.clearInteraction).toHaveBeenCalledWith("session-1");
  });
  test("a cancellation requested before acknowledgement targets the newly assigned run id", async () => {
    const refs = registries(); refs.cancelRequestedSessions.current.add("session-1");
    const s = runScenario({ refs }); await s.ready(); await s.finish();
    expect(s.bridge.cancel).toHaveBeenCalledWith("run-1");
    expect(refs.cancelRequestedSessions.current.has("session-1")).toEqual(false);
  });
});

describe("Candidate presentation drains before classification", () => {
  test("the first preview is immediate and subsequent text appears on the next frame without checkpoint content", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("甲乙丙");
    s.expectPatch({ transientText: "甲乙丙" }); s.candidate("丁戊"); animation.tick();
    s.text("甲乙丙丁戊"); await s.finish();
    expect(s.patches().map(patch => patch.transientText).filter(Boolean)).toEqual(["甲乙丙", "甲乙丙丁戊"]);
    expect(s.saved().slice(0, -1).every(record => record.content === "")).toEqual(true);
  });
  test("separate arrival frames extend the same preview in small visible increments", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round();
    s.candidate("先检查文件，"); s.expectPatch({ transientText: "先检查" }); await animation.drain();
    s.candidate("然后确认相关调用入口，"); animation.tick();
    const partial = s.patches().map(patch => patch.transientText as string).filter(Boolean).at(-1)!;
    expect(partial.startsWith("先检查文件，")).toEqual(true);
    expect(partial.length).toBeLessThan("先检查文件，然后确认相关调用入口，".length);
    await animation.drain(); s.candidate("最后运行验证。 "); await animation.drain();
    const published = s.patches().map(patch => patch.transientText).filter(Boolean);
    expect(published.at(-1)).toEqual("先检查文件，然后确认相关调用入口，最后运行验证。 ");
    expect(published.length).toBeGreaterThan(3); await s.finish("cancelled");
  });
  test.each(["process", "discard"])("%s classification waits for the preview queue before moving text into process history", async kind => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round();
    const content = kind === "process" ? "现在读取公开文档。" : "先核对目录中的相关文件。";
    s.candidate(content);
    if (kind === "process") s.custom("firefly.process_text", { content });
    else s.custom("firefly.candidate_text", { action: "discard", roundId: "round-0" });
    expect(s.patches().some(patch => patch.processMessages?.some(record => record.content === content))).toEqual(false);
    await animation.drain(); await Promise.resolve();
    expect(s.patches().at(-1)).toMatchObject({ transientText: undefined, processMessages: [expect.objectContaining({ content, roundId: "round-0" })] });
    if (kind === "process") s.round("round-0", "end"); await s.finish("cancelled");
  });
  test("a stale round cannot inject preview text while the active discard preserves its process record", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round("round-1");
    s.candidate("obsolete candidate", "round-0"); s.candidate("current candidate", "round-1"); await animation.drain();
    s.custom("firefly.candidate_text", { roundId: "round-1", action: "discard" }); await s.finish("cancelled");
    expect(s.host.patchMessage).not.toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({ transientText: expect.stringContaining("obsolete candidate") }));
    s.expectPatch({ transientText: undefined, processMessages: [expect.objectContaining({ content: "current candidate", roundId: "round-1" })] });
  });
  test("starting another round closes an unclassified preview from the preceding round", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("previous round draft"); await animation.drain();
    s.round("round-1"); await s.finish("cancelled");
    s.expectPatch({ transientText: undefined, processMessages: [expect.objectContaining({ content: "previous round draft", roundId: "round-0" })] });
  });
  test("reasoning, process text, a tool and later reasoning receive increasing timeline positions", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round();
    const reason = (id: string, delta: string) => {
      s.send({ type: "REASONING_MESSAGE_START", runId: "run-1", messageId: id });
      s.send({ type: "REASONING_MESSAGE_CONTENT", runId: "run-1", messageId: id, delta });
    };
    reason("reason-first", "inspect the directory"); s.candidate("Opening the index."); animation.tick(); s.custom("firefly.process_text", { content: "Opening the index." });
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "directory-call", toolCallName: "list_dir" });
    s.send({ type: "TOOL_CALL_END", runId: "run-1", toolCallId: "directory-call" });
    s.round("round-0", "end"); s.round("round-1"); reason("reason-next", "locate the public API"); await s.finish("cancelled");
    const saved = s.lastSaved();
    const ordered = [saved.reasoningBlocks?.find((x: any) => x.content === "inspect the directory"), saved.processMessages?.find((x: any) => x.content === "Opening the index."), saved.toolExecutions?.find((x: any) => x.name === "list_dir"), saved.reasoningBlocks?.find((x: any) => x.content === "locate the public API")];
    expect(ordered.every(Boolean)).toEqual(true);
    for (const record of ordered) expect(record.seq).toBeDefined();
    for (let index = 1; index < ordered.length; index++) expect(ordered[index - 1].seq).toBeLessThan(ordered[index].seq);
  });
  test("closing a long candidate after a tool round retains exactly one full process record", async () => {
    const animation = frames(); const s = runScenario(); await s.ready();
    const content = "A complete preliminary analysis of the document. ".repeat(24);
    s.round(); s.candidate(content); animation.tick(); s.custom("firefly.process_text", { content }); s.round("round-0", "end"); await s.finish("cancelled");
    expect(s.lastSaved().processMessages?.filter((record: any) => record.content === content) ?? []).toHaveLength(1);
  });
});

describe("Formal answer commitment and failure reporting", () => {
  test.each([["Preliminary draft", "The verified final answer"], ["PREVIEW-extra", "PREVIEW"]])("preview %s is replaced in place only after authoritative success", async (preview, answer) => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate(preview); await animation.drain();
    s.text(answer); const appearedEarly = s.patches().some(patch => patch.content === answer); await s.finish();
    expect(appearedEarly).toEqual(false);
    s.expectPatch({ content: answer, transientText: undefined, responseStarted: true, streaming: false });
    expect(s.lastSaved().content).toEqual(answer);
  });
  test("a successful status without authoritative text leaves preview as interrupted process evidence", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("A preview without a final answer"); await animation.drain();
    s.text(); await s.finish();
    s.expectPatch({ content: "", processMessages: [expect.objectContaining({ content: "A preview without a final answer", interrupted: true })] });
    expect(s.lastSaved().content).toEqual("");
  });
  test.each(["cancelled", "timeout"] as const)("%s leaves unclassified preview as interrupted process text", async status => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("A partially completed review"); animation.tick(); await s.finish(status);
    s.expectPatch({ content: "", transientText: undefined, responseStarted: false, processMessages: [expect.objectContaining({ content: "A partially completed review", interrupted: true })] });
    expect(s.lastSaved().content).toEqual("");
  });
  test("runtime errors retain partial preview alongside the public failure message", async () => {
    const animation = frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("Inspecting the selected file"); animation.tick(); await s.fail("provider connection lost");
    expect(s.patches().at(-1)).toMatchObject({ content: "", transientText: undefined, responseStarted: false, processMessages: expect.arrayContaining([expect.objectContaining({ content: "Inspecting the selected file", interrupted: true }), expect.objectContaining({ content: expect.stringContaining("任务执行失败：E_HARNESS_FAILURE") })]) });
    expect(s.lastSaved().content).toEqual("");
  });
  test("a runtime error during pending classification keeps the candidate once", async () => {
    frames(); const s = runScenario(); await s.ready(); s.round(); s.candidate("Reading the important source."); s.custom("firefly.process_text", { content: "Reading the important source." }); await s.fail("provider connection lost");
    expect(s.lastSaved().processMessages?.filter((record: any) => record.content === "Reading the important source.")).toHaveLength(1);
  });
  test("foreign-run deltas cannot reach the message or its checkpoint", async () => {
    const s = runScenario(); await s.ready(); s.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-other", delta: "unrelated private answer" }); await s.finish();
    expect(s.lastSaved().content).toEqual("");
    expect(s.host.patchMessage).not.toHaveBeenCalledWith("session-1", "assistant-1", expect.objectContaining({ content: "unrelated private answer" }));
  });
  test("cancelling after partial authoritative output removes the formal answer", async () => {
    const s = runScenario(); await s.ready();
    s.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "An unfinished final response" });
    s.send({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "answer-stream" }); await s.finish("cancelled");
    s.expectPatch({ content: "", responseStarted: false, streaming: false });
    expect(s.lastSaved().runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "cancelled" });
    expect(s.host.onRunFinished).toHaveBeenCalled();
  });
  test("an error persists a runtime terminal snapshot, reports it, and releases busy state", async () => {
    const s = runScenario(); await s.ready(); await s.fail();
    s.expectPatch({ content: "", loading: false, streaming: false, responseStarted: false });
    expect(s.lastSaved().runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "runtime_error" });
    expect(s.bridge.reportRunPersisted).toHaveBeenCalledWith({ runId: "run-1", finalMessageId: "assistant-1" });
    expect(s.host.setModeBusy).toHaveBeenCalledWith("chat", false);
    expect(s.host.onRunFinished).toHaveBeenCalled();
  });
  test("context failures expose the public category and code while suppressing model and secret text", async () => {
    const s = runScenario(); await s.ready(); await s.fail("SYNTHETIC_SECRET_MUST_NOT_ESCAPE", { code: "MEMORY_CONTEXT_TRANSCRIPT_SECRET", errorSource: "context" });
    const serialized = JSON.stringify(s.disk.upsert.mock.calls.at(-1));
    for (const fragment of ["上下文处理失败", "MEMORY_CONTEXT_TRANSCRIPT_SECRET"]) expect(serialized).toContain(fragment);
    for (const forbidden of ["模型请求失败", "SYNTHETIC_SECRET_MUST_NOT_ESCAPE"]) expect(serialized).not.toContain(forbidden);
  });
  test.each([
    ["E_MODEL_CONNECTION_LOST", "model", "网络连接中断"],
    ["E_MODEL_REQUEST_TIMEOUT", "model", "太久没有回应"],
  ])("a %s failure tells the user it was the network, keeping the code for support", async (code, errorSource, plain) => {
    const s = runScenario(); await s.ready(); await s.fail("socket hang up", { code, errorSource });
    const serialized = JSON.stringify(s.disk.upsert.mock.calls.at(-1));
    expect(serialized).toContain(plain); expect(serialized).toContain(code);
    expect(serialized).not.toContain("上下文处理失败");
  });
  test.each([
    ["E_MODEL_REQUEST_FAILED", "model", "模型请求失败"],
    ["MEMORY_CONTEXT_SEND_UNKNOWN", "context", "上下文处理失败"],
  ])("a %s failure (an HTTP rejection lands here too) keeps the generic notice, not the network one", async (code, errorSource, generic) => {
    const s = runScenario(); await s.ready(); await s.fail("HTTP 401", { code, errorSource });
    const serialized = JSON.stringify(s.disk.upsert.mock.calls.at(-1));
    expect(serialized).toContain(generic); expect(serialized).toContain(code);
    expect(serialized).not.toContain("网络连接中断");
  });
});

describe("Chat attachment that needs Work mode", () => {
  test("a run refused with MEMORY_ATTACHMENT_NEEDS_WORK_MODE tells the user to switch to Work instead of a generic failure", async () => {
    const s = runScenario({ acknowledge: async () => { throw new Error("MEMORY_ATTACHMENT_NEEDS_WORK_MODE"); } });
    await nextTurn(); await s.completed;
    const shown = JSON.stringify([s.host.patchMessage.mock.calls, s.disk.upsert.mock.calls]);
    expect(shown).toContain(t("chatPage.errorAttachmentNeedsWorkMode", { code: "MEMORY_ATTACHMENT_NEEDS_WORK_MODE" }));
    expect(shown).not.toContain("E_HARNESS_FAILURE");
  });
});

describe("Session conflicts preserve the legitimate owner", () => {
  test("a conflict presents one takeover action and retries the same dispatch with its old run anchor", async () => {
    const s = runScenario({ ack: { success: false, runId: "", error: "SESSION_RUN_ACTIVE:previous-run" } }); await nextTurn(); await s.completed;
    expect(s.host.requestTakeover).toHaveBeenCalledTimes(1);
    const [sessionId, runId, retry] = s.host.requestTakeover.mock.calls[0];
    expect([sessionId, runId]).toEqual(["session-1", "previous-run"]);
    expect(s.lastSaved().runSnapshot).toMatchObject({ status: "interrupted", runId: undefined, terminalStatus: undefined });
    expect(s.host.onRunFinished).toHaveBeenCalled(); await retry();
    s.expectPatch({ loading: true, waitingForFirstEvent: true });
    expect(s.restart).toHaveBeenCalledWith(expect.objectContaining({ takeoverFromRunId: "previous-run" }));
  });
  test("a rejected contender preserves the active record, checkpoint trigger and subscription", async () => {
    const refs = registries(); const checkpoint = vi.fn(); const off = vi.fn();
    refs.activeRuns.current["session-1"] = { mode: "chat", assistantId: "assistant-active", runId: "run-1" };
    refs.checkpointTriggers.current["session-1"] = checkpoint; refs.eventUnsubscribers.current.add(off);
    const s = runScenario({ refs, ack: { success: false, runId: "", error: "SESSION_RUN_ACTIVE:run-1" }, input: { assistantId: "assistant-rejected" } }); await s.completed;
    expect(refs.activeRuns.current["session-1"]).toEqual({ assistantId: "assistant-active", runId: "run-1", mode: "chat" });
    expect(refs.checkpointTriggers.current["session-1"]).toBe(checkpoint);
    expect(refs.eventUnsubscribers.current).toContain(off);
    expect(s.host.setModeBusy).not.toHaveBeenCalledWith("chat", false);
    expect(s.host.onRunFinished).not.toHaveBeenCalled();
  });
  test("the first run can finish after a rejected contender and a later message can start", async () => {
    const refs = registries(); const host = observer(); const disk = memory();
    const first = runScenario({ refs, host, disk }); await nextTurn();
    const rejected = runScenario({ refs, host, disk, input: { assistantId: "assistant-rejected" }, ack: { success: false, runId: "", error: "SESSION_RUN_ACTIVE:run-1" } }); await rejected.completed;
    expect(first.bridge.run).toHaveBeenCalledTimes(1); expect(rejected.bridge.run).toHaveBeenCalledTimes(1);
    expect(refs.activeRuns.current["session-1"]).toMatchObject({ assistantId: "assistant-1", runId: "run-1" });
    expect(host.setModeBusy).not.toHaveBeenCalledWith("chat", false);
    first.send({ type: "RUN_STARTED", runId: "run-1" }); first.text("First review finished");
    first.send({ type: "RUN_FINISHED", runId: "run-1", result: terminalResult("success") });
    first.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "late ignored content" }); await first.completed;
    expect(refs.activeRuns.current["session-1"]).toBeUndefined();
    expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
    expect(first.lastSaved().runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "success" });
    expect(first.patches().at(-1)).toMatchObject({ runStage: { kind: "completed" }, content: "First review finished", loading: false, streaming: false });
    const next = runScenario({ refs, host, disk, input: { userMessageId: "user-2", assistantId: "assistant-2" }, ack: successfulAck("run-2") }); await next.ready();
    expect(next.bridge.run).toHaveBeenCalledTimes(1); next.text("Second review finished"); await next.finish();
    expect(next.lastSaved().runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "success" });
    expect(refs.activeRuns.current["session-1"]).toBeUndefined();
  });
  test("one session settling does not clear busy state for another run in the same mode", async () => {
    const refs = registries(); const host = observer(); const disk = memory();
    const first = runScenario({ refs, host, disk });
    const second = runScenario({ refs, host, disk, ack: successfulAck("run-2"), input: { sessionId: "session-2", userMessageId: "user-2", assistantId: "assistant-2" } }); await nextTurn();
    first.send({ type: "RUN_STARTED", runId: "run-1" }); await first.finish("cancelled");
    expect(refs.activeRuns.current["session-2"]).toMatchObject({ runId: "run-2" });
    expect(host.setModeBusy).not.toHaveBeenCalledWith("chat", false);
    expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", true);
    second.send({ type: "RUN_STARTED", runId: "run-2" }); await second.fail("provider request rejected");
    expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
    expect(refs.activeRuns.current).toEqual({});
  });
  test.each(["error", "cancelled"])("a session accepts another send after %s settlement", async kind => {
    const refs = registries(); const host = observer(); const disk = memory(); const first = runScenario({ refs, host, disk }); await first.ready();
    if (kind === "error") await first.fail("provider request rejected"); else await first.finish("cancelled");
    expect(refs.activeRuns.current["session-1"]).toBeUndefined(); expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
    const next = runScenario({ refs, host, disk, ack: successfulAck("run-2"), input: { userMessageId: "user-2", assistantId: "assistant-2" } }); await next.ready();
    expect(next.bridge.run).toHaveBeenCalledTimes(1); await next.finish();
    expect(next.lastSaved().runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "success" });
  });
});

describe("Public dispatch metadata and Main-owned evidence", () => {
  test("bound channel messages use their hidden model context in the complete history", async () => {
    const messages = [{ id: "channel-user", role: "user", content: "Channel greeting", modelContext: "[channel sender: Reader]\nChannel greeting", channelSource: { channel: "qq", senderName: "Reader" }, at: 1 }, { id: "channel-model", role: "model", content: "Channel reply", channelSource: { channel: "qq" }, at: 2 }, { id: "user-1", role: "user", content: "Continue the review", at: 3 }];
    const s = runScenario({ input: { session: { id: "session-1", messages } as ChatSession } }); await nextTurn();
    expect(s.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ role: "user", content: "[channel sender: Reader]\nChannel greeting" }), expect.objectContaining({ role: "model", content: "Channel reply" }), expect.objectContaining({ role: "user", content: "Continue the review" })] }));
    s.send({ type: "RUN_STARTED", runId: "run-1" }); await s.finish();
  });
  test("rewind anchors reach the dispatch request unchanged", async () => {
    const transcriptRewind = { anchorUserTurnId: "user-1", disposition: "replace_user" as const };
    const s = runScenario({ input: { transcriptRewind } }); await s.ready();
    expect(s.bridge.run).toHaveBeenCalledWith(expect.objectContaining({ userTurnId: "user-1", transcriptRewind })); await s.finish();
  });
  test("twenty history messages reach Main without the legacy sixteen-message cutoff", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? "model" as const : "user" as const, content: `historical turn ${index}`, at: index + 1 }));
    const s = runScenario({ input: { session: { id: "session-1", messages } as ChatSession } }); await s.ready();
    const forwarded = (s.bridge.run.mock.calls[0][0] as any).messages;
    expect(forwarded).toHaveLength(20);
    expect(JSON.stringify(forwarded)).toContain("historical turn 0"); expect(JSON.stringify(forwarded)).toContain("historical turn 19"); await s.finish();
  });
  test("Main document-read evidence is included in the Work terminal checkpoint", async () => {
    const s = runScenario({ input: { targetMode: "work", session: { id: "session-1", messages: [{ id: "user-1", role: "user", content: "read the public note", at: 1, attachments: [{ kind: "document", name: "review-note.txt", filePath: "C:/review/review-note.txt", status: "pending", readScope: { name: "review-note.txt", path: "C:/review/review-note.txt", sha256: "revision-hash", totalLines: 4, endLine: 4, partialAccepted: false } }] }] } as ChatSession } }); await s.ready();
    const report = { status: "partial", files: [{ name: "review-note.txt", status: "partial", coveredLines: 2, requiredLines: 4, totalLines: 4 }] };
    s.custom("firefly.workRead", report); await s.finish();
    expect(s.disk.upsert).toHaveBeenCalledWith("session-1", expect.objectContaining({ workReadReport: report, runSnapshot: expect.objectContaining({ status: "terminal" }) }));
  });
  test("terminal S settlement is refreshed from Main after local cache persistence", async () => {
    const animation = frames(); const disk = memory(); const settlement = { state: "unknown", runId: "run-1", assistantEntryId: "main-ledger-entry", originalText: "original settlement text" };
    Object.assign(disk, { get: vi.fn(async () => ({ id: "session-1", messages: [{ id: "assistant-1", role: "model", at: 1, content: "cached answer", sSettlement: settlement }] })) });
    const s = runScenario({ disk }); await s.ready(); s.custom("firefly.sResponse", { pending: true });
    s.send({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "assistant-1" });
    s.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", messageId: "assistant-1", delta: "tentative answer" }); await animation.drain();
    s.expectPatch({ content: "tentative answer" });
    s.send({ type: "TEXT_MESSAGE_END", runId: "run-1", messageId: "assistant-1" }); await s.finish();
    expect(s.host.patchMessage).toHaveBeenLastCalledWith("session-1", "assistant-1", expect.objectContaining({ content: "", sSettlement: settlement }));
    expect(s.saved().every(record => record.sSettlement === undefined)).toEqual(true);
  });
});

describe("Delegated result evidence survives owning checkpoints", () => {
  test("a child result keeps its full text while foreign results are ignored", async () => {
    const s = runScenario(); await s.ready();
    const taskResult = { agentId: "document-reviewer", sessionId: "child-review", status: "completed" as const, text: "Full document review: " + "r".repeat(1200) };
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "delegation-first", toolCallName: "delegate_agent" });
    s.send({ type: "TOOL_CALL_RESULT", runId: "foreign-run", toolCallId: "delegation-first", status: "success", content: "unrelated summary", taskResult: { ...taskResult, text: "unrelated full result" } });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "delegation-first", status: "success", content: "short result preview", taskResult }); await s.finish();
    expect(s.lastSaved().toolExecutions).toEqual([expect.objectContaining({ id: "delegation-first", result: "short result preview", taskResult })]);
    expect(s.patches().some(patch => patch.toolExecutions?.some(tool => tool.taskResult?.text === "unrelated full result"))).toEqual(false);
  });
  test("owning events cannot attach foreign execution evidence or malformed result text", async () => {
    const s = runScenario(); await s.ready();
    const invalid = { agentId: "document-reviewer", sessionId: "child-review", status: "failed" as const, text: "foreign execution facts", executionEvents: [{ id: "foreign-event", seq: 1, monotonicMs: 0, clockDomainId: "synthetic-clock", parentRunId: "other-run", agentId: "document-reviewer", childRunId: "child-run", executionId: "child-execution", phase: "start" as const }] };
    for (const [id, taskResult] of [["delegation-first", invalid], ["delegation-second", { ...invalid, executionEvents: undefined, text: 3 }]] as const) {
      s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: id, toolCallName: "delegate_agent" });
      s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: id, status: "failed", taskResult: taskResult as never });
    }
    await s.finish(); expect(s.lastSaved().toolExecutions.map((tool: any) => tool.taskResult)).toEqual([undefined, undefined]);
  });
  test("cancelled child text is capped at 64000 characters without truncating a thousand-write ledger", async () => {
    const s = runScenario(); await s.ready();
    const writes = Array.from({ length: 1000 }, (_, index) => ({ path: `note-${index}.md`, canonicalPath: `/review-output/note-${index}.md`, agentId: "document-reviewer", childRunId: "child-run", toolCallId: "child-file-write", state: "applied" as const, eventIds: ["confirmed-file-write"] }));
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "delegation-first", toolCallName: "delegate_agent" });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "delegation-first", status: "failed", taskResult: { agentId: "document-reviewer", sessionId: "child-review", status: "cancelled", text: "r".repeat(64001), writes } });
    await s.finish("cancelled"); expect(s.lastSaved().toolExecutions[0].taskResult).toMatchObject({ writes, text: "r".repeat(64000), truncated: true });
  });
});

// ChatPage regression package A (docs/superpowers/plans/chatpage-regression.md).
const MODES = ["chat", "work", "code"] as const;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
/** Every patch and checkpoint in a scenario stays with its own session and assistant message. */
function expectOwnSessionOnly(s: ReturnType<typeof runScenario>) {
  expect(new Set(s.host.patchMessage.mock.calls.map(([sessionId, messageId]) => `${sessionId}/${messageId}`))).toEqual(new Set([`${s.request.sessionId}/${s.request.assistantId}`]));
  expect(new Set(s.disk.upsert.mock.calls.map(([sessionId]) => sessionId))).toEqual(new Set([s.request.sessionId]));
  expect(s.disk.append).not.toHaveBeenCalled();
}
function reason(s: ReturnType<typeof runScenario>, id: string, delta: string, runId = "run-1") {
  s.send({ type: "REASONING_MESSAGE_START", runId, messageId: id });
  s.send({ type: "REASONING_MESSAGE_CONTENT", runId, messageId: id, delta });
  s.send({ type: "REASONING_MESSAGE_END", runId, messageId: id });
}
function usage(phase: "preRequest" | "terminal", totalTokens: number, runId = "run-1") {
  return { phase, totalTokens, contextWindowTokens: 128000, messageCount: 3, updatedAt: 500 + totalTokens, runId, categories: [{ key: "conversation", tokens: totalTokens }] };
}

describe("ChatPage package A: run and persistence baseline", () => {
  test.each(MODES)("A1 %s: reasoning, answer and success settle once with the right anchors", async mode => {
    const s = runScenario({ input: { targetMode: mode } }); await s.ready();
    reason(s, "reason-a1", "Check the public document first.");
    s.text("The document", " is consistent."); await s.finish();
    const patches = s.patches();
    const firstReasoning = patches.findIndex(patch => patch.reasoning === "Check the public document first.");
    const firstAnswer = patches.findIndex(patch => typeof patch.content === "string" && patch.content.length > 0);
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstAnswer);
    expect(patches.at(-1)).toMatchObject({ content: "The document is consistent.", loading: false, waitingForFirstEvent: false, streaming: false, reasoningStreaming: false, responseStarted: true, runStage: { kind: "completed" } });
    const saved = s.lastSaved();
    expect(saved).toMatchObject({ id: "assistant-1", role: "model", content: "The document is consistent.", reasoning: "Check the public document first.", answersUserMessageId: "user-1" });
    expect(saved.runSnapshot).toMatchObject({ runId: "run-1", status: "terminal", terminalStatus: "success" });
    expect(s.saved().slice(0, -1).map(record => record.runSnapshot.status)).toEqual(s.saved().slice(0, -1).map(() => "running"));
    expect(s.bridge.reportRunPersisted.mock.calls).toEqual([[{ runId: "run-1", finalMessageId: "assistant-1" }]]);
    expect(s.bridge.run).toHaveBeenCalledTimes(1);
    expect(s.bridge.cancel).not.toHaveBeenCalled();
    expect(s.host.onRunFinished.mock.calls).toEqual([[{ mode, sessionId: "session-1", queuePaused: false }]]);
    expectOwnSessionOnly(s);
  });

  test.each(["work", "code"] as const)("A2 %s: a tool round stays process evidence and the answer is saved once", async mode => {
    const s = runScenario({ input: { targetMode: mode } }); await s.ready(); s.round();
    const changes: ToolFileChange[] = [{ file: "notes/summary.md", kind: "modified", insertions: 2, deletions: 1 }];
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "edit-call", toolCallName: "edit_file" });
    s.send({ type: "TOOL_CALL_ARGS", runId: "run-1", toolCallId: "edit-call", delta: "{\"path\":\"notes/summary.md\"}" });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "edit-call", status: "success", content: "Updated notes/summary.md", changes } as AguiEvent);
    s.send({ type: "TOOL_CALL_END", runId: "run-1", toolCallId: "edit-call" });
    s.round("round-0", "end"); s.round("round-1");
    s.text("The summary is updated."); await s.finish();
    const saved = s.lastSaved();
    expect(saved.toolExecutions).toEqual([expect.objectContaining({ id: "edit-call", name: "edit_file", status: "success", result: "Updated notes/summary.md", argsText: "{\"path\":\"notes/summary.md\"}", changes, roundId: "round-0" })]);
    expect(saved.content).toEqual("The summary is updated.");
    expect(saved.runSnapshot).toMatchObject({ status: "terminal", terminalStatus: "success" });
    expect(JSON.stringify(saved.processMessages ?? [])).not.toContain("The summary is updated.");
    expect(saved.content).not.toContain("Updated notes/summary.md");
    expect(s.saved().filter(record => record.runSnapshot.status === "terminal")).toHaveLength(1);
    expect(s.patches().some(patch => patch.runStage?.kind === "executing" && patch.runStage.detail === "edit_file")).toEqual(true);
    expect(s.bridge.reportRunPersisted).toHaveBeenCalledTimes(1);
    expectOwnSessionOnly(s);
  });

  test("A3: cancelling after partial output keeps the process, drops the answer and ignores late text", async () => {
    const refs = registries(); const host = observer(); const disk = memory();
    const s = runScenario({ refs, host, disk, input: { targetMode: "work" } });
    const other = runScenario({ refs, host, disk, ack: successfulAck("run-2"), input: { targetMode: "work", sessionId: "session-2", userMessageId: "user-2", assistantId: "assistant-2" } });
    await nextTurn(); s.send({ type: "RUN_STARTED", runId: "run-1" }); other.send({ type: "RUN_STARTED", runId: "run-2" });
    reason(s, "reason-a3", "Compare the two files.");
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "read-call", toolCallName: "read_file" });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "read-call", status: "success", content: "first file" });
    s.send({ type: "TEXT_MESSAGE_START", runId: "run-1", messageId: "answer-stream" });
    s.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: "The files differ in" });
    await s.finish("cancelled");
    const patchCount = host.patchMessage.mock.calls.length; const saveCount = disk.upsert.mock.calls.length;
    s.send({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", delta: " three places." });
    expect(host.patchMessage.mock.calls.length).toEqual(patchCount);
    expect(disk.upsert.mock.calls.length).toEqual(saveCount);
    const saved = disk.upsert.mock.calls.filter(([sessionId]) => sessionId === "session-1").at(-1)![1] as any;
    expect(saved.content).toEqual("");
    expect(saved.reasoning).toEqual("Compare the two files.");
    expect(saved.toolExecutions).toEqual([expect.objectContaining({ id: "read-call", status: "success", result: "first file" })]);
    expect(saved.runSnapshot).toMatchObject({ runId: "run-1", status: "terminal", terminalStatus: "cancelled" });
    expect(s.bridge.reportRunPersisted.mock.calls).toEqual([[{ runId: "run-1", finalMessageId: "assistant-1" }]]);
    expect(refs.activeRuns.current["session-2"]).toMatchObject({ runId: "run-2", assistantId: "assistant-2" });
    expect(host.patchMessage).not.toHaveBeenCalledWith("session-2", expect.anything(), expect.objectContaining({ content: expect.stringContaining("files differ") }));
    expect(host.setModeBusy).toHaveBeenLastCalledWith("work", true);
    other.text("Second session answer."); await other.finish();
    expect(other.lastSaved()).toMatchObject({ content: "Second session answer.", runSnapshot: { runId: "run-2", terminalStatus: "success" } });
  });

  test("A4: a cancel requested before the acknowledgement cancels only the assigned run", async () => {
    const refs = registries(); const host = observer(); const disk = memory();
    const other = runScenario({ refs, host, disk, ack: successfulAck("run-2"), input: { sessionId: "session-2", userMessageId: "user-2", assistantId: "assistant-2" } });
    await other.ready();
    const ack = deferred<Acknowledgement>();
    const s = runScenario({ refs, host, disk, acknowledge: () => ack.promise }); await nextTurn();
    expect(s.bridge.run).toHaveBeenCalledTimes(1);
    expect(refs.activeRuns.current["session-1"]).toEqual({ assistantId: "assistant-1", mode: "chat" });
    refs.cancelRequestedSessions.current.add("session-1");
    expect(s.bridge.cancel).not.toHaveBeenCalled();
    ack.resolve(successfulAck("run-1")); await nextTurn();
    expect(s.bridge.cancel.mock.calls).toEqual([["run-1"]]);
    expect(other.bridge.cancel).not.toHaveBeenCalled();
    expect(refs.cancelRequestedSessions.current.has("session-1")).toEqual(false);
    s.send({ type: "RUN_STARTED", runId: "run-1" }); await s.finish("cancelled");
    expect(s.lastSaved().runSnapshot).toMatchObject({ runId: "run-1", status: "terminal", terminalStatus: "cancelled" });
    expect(refs.activeRuns.current).toEqual({ "session-2": { assistantId: "assistant-2", mode: "chat", runId: "run-2" } });
    expect(refs.checkpointTriggers.current["session-1"]).toBeUndefined();
    expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", true);
    expect(host.onRunFinished.mock.calls).toEqual([[{ mode: "chat", sessionId: "session-1", queuePaused: false }]]);
    await other.finish();
    expect(refs.activeRuns.current).toEqual({});
    expect(host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
    expect(refs.eventUnsubscribers.current.size).toEqual(0);
  });

  test.each([
    ["E_MODEL_CONNECTION_LOST", "model", "chatPage.errorNetworkInterrupted"],
    ["E_MODEL_REQUEST_TIMEOUT", "model", "chatPage.errorModelTimedOut"],
    ["E_HARNESS_FAILURE", "runtime", "chatPage.errorRuntimeFailedWith"],
  ] as const)("A5 %s: the public notice is exact and the private message never reaches the page or disk", async (code, errorSource, key) => {
    const secret = "upstream said: Authorization Bearer SYNTHETIC-PRIVATE-TOKEN";
    const s = runScenario({ input: { targetMode: "code" } }); await s.ready();
    reason(s, "reason-a5", "Run the checks.");
    await s.fail(secret, { code, errorSource });
    const notice = key === "chatPage.errorRuntimeFailedWith" ? t(key, { message: code }) : t(key, { code });
    const saved = s.lastSaved();
    expect(saved.runSnapshot).toMatchObject({ runId: "run-1", status: "terminal", terminalStatus: "runtime_error" });
    expect(saved.content).toEqual("");
    expect(saved.reasoning).toEqual("Run the checks.");
    expect(saved.processMessages.map((record: any) => record.content)).toEqual([notice]);
    expect(s.patches().at(-1)).toMatchObject({ content: "", runStage: { kind: "failed" }, loading: false, streaming: false, responseStarted: false });
    for (const evidence of [JSON.stringify(s.disk.upsert.mock.calls), JSON.stringify(s.host.patchMessage.mock.calls)]) {
      expect(evidence).not.toContain("SYNTHETIC-PRIVATE-TOKEN");
      expect(evidence).not.toContain("upstream said");
    }
    expect(s.bridge.reportRunPersisted).toHaveBeenCalledTimes(1);
    expectOwnSessionOnly(s);
  });

  test("A6: a delayed running checkpoint cannot overwrite the terminal record or release persistence early", async () => {
    // Hold the checkpoint a tool result triggers: the controller does not await it, so only the save chain keeps
    // the later terminal write behind it. "stored" applies writes in the order they resolve, like a disk would.
    const disk = memory(); const stored = new Map<string, any>(); const held = deferred<void>(); let holding = true;
    disk.upsert.mockImplementation(async (_sessionId: string, message: any) => {
      if (holding && message.runSnapshot.status === "running" && message.toolExecutions.some((tool: any) => tool.status === "success")) { holding = false; await held.promise; }
      stored.set(message.id, structuredClone(message));
      return { id: "session-1", messages: [...stored.values()] } as unknown as ChatSession;
    });
    const s = runScenario({ disk }); await s.ready();
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "lookup-call", toolCallName: "read_file" });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "lookup-call", status: "success", content: "lookup result" });
    s.text("Final checked answer.");
    s.send({ type: "RUN_FINISHED", runId: "run-1", result: terminalResult("success") });
    let settled = false; void s.completed.then(() => { settled = true; });
    for (let turn = 0; turn < 5; turn++) await nextTurn();
    expect(holding).toEqual(false);
    expect(settled).toEqual(false);
    expect(s.bridge.reportRunPersisted).not.toHaveBeenCalled();
    expect(stored.get("assistant-1")?.runSnapshot.status).not.toEqual("terminal");
    held.resolve(); await s.completed;
    expect(stored.get("assistant-1")).toMatchObject({ content: "Final checked answer.", runSnapshot: { runId: "run-1", status: "terminal", terminalStatus: "success" } });
    expect((disk.upsert.mock.calls.at(-1)![1] as any).runSnapshot.status).toEqual("terminal");
    expect(s.bridge.reportRunPersisted.mock.calls).toEqual([[{ runId: "run-1", finalMessageId: "assistant-1" }]]);
  });

  test("A9: context usage stays with its session, keeps the terminal value and a new run clears compression", async () => {
    const refs = registries(); const host = observer(); const disk = memory();
    const s = runScenario({ refs, host, disk }); await s.ready();
    s.custom("firefly.compressingContext", true);
    expect(host.setCompressingContext).toHaveBeenLastCalledWith("session-1", true);
    s.custom("firefly.context.usage", usage("preRequest", 1200));
    s.send({ type: "CUSTOM", runId: "run-foreign", name: "firefly.context.usage", value: usage("preRequest", 9999, "run-foreign") });
    s.custom("firefly.context.usage", usage("terminal", 1800));
    s.custom("firefly.context.usage", { phase: "terminal", totalTokens: -1 });
    await s.finish();
    expect(host.updateContextUsage.mock.calls).toEqual([["session-1", usage("preRequest", 1200)], ["session-1", usage("terminal", 1800)]]);
    expect(s.lastSaved().contextUsage).toEqual(usage("terminal", 1800));
    expect(s.patches().some(patch => patch.contextUsage?.totalTokens === 9999)).toEqual(false);
    const next = runScenario({ refs, host, disk, ack: successfulAck("run-2"), input: { userMessageId: "user-2", assistantId: "assistant-2" } });
    host.setCompressingContext.mockClear(); await next.ready();
    expect(host.setCompressingContext.mock.calls).toEqual([["session-1", false]]);
    await next.finish();
    expect(next.lastSaved().contextUsage).toBeUndefined();
    expect(host.updateContextUsage).toHaveBeenCalledTimes(2);
  });

  test("A10: a terminal write that keeps failing keeps the answer on screen and is never reported as persisted", async () => {
    const disk = memory();
    disk.upsert.mockImplementation(async (_sessionId: string, message: any) => {
      if (message.runSnapshot.status === "terminal") throw new Error("CHAT_HISTORY_WRITE_FAILED synthetic");
      return { id: "session-1", messages: [message] } as unknown as ChatSession;
    });
    const s = runScenario({ disk }); await s.ready(); s.text("An answer that cannot be saved.");
    s.send({ type: "RUN_FINISHED", runId: "run-1", result: terminalResult("success") });
    await s.completed;
    const terminalWrites = s.saved().filter(record => record.runSnapshot.status === "terminal");
    expect(terminalWrites).toHaveLength(3);
    expect(terminalWrites.every(record => JSON.stringify(record) === JSON.stringify(terminalWrites[0]))).toEqual(true);
    expect(terminalWrites[0]).toMatchObject({ content: "An answer that cannot be saved.", runSnapshot: { runId: "run-1", terminalStatus: "success" } });
    expect(s.patches().filter(patch => "content" in patch).at(-1)).toMatchObject({ content: "An answer that cannot be saved.", responseStarted: true, loading: false, streaming: false });
    expect(s.patches().at(-1)?.processMessages?.map(record => record.content)).toEqual([t("chatPage.terminalSaveFailed")]);
    expect(s.bridge.reportRunPersisted).not.toHaveBeenCalled();
    expect(s.refs.activeRuns.current).toEqual({});
    expect(s.host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
    expect(s.host.onRunFinished.mock.calls).toEqual([[{ mode: "chat", sessionId: "session-1", queuePaused: false }]]);
    expect(s.bridge.run).toHaveBeenCalledTimes(1);
    expect(s.bridge.cancel).not.toHaveBeenCalled();
    expectOwnSessionOnly(s);
  });
});

describe("Terminal checkpoint saves are confirmed before they are reported", () => {
  test("a terminal write that fails once is retried with the same snapshot and reported once", async () => {
    const disk = memory(); let failures = 0;
    disk.upsert.mockImplementation(async (_sessionId: string, message: any) => {
      if (message.runSnapshot.status === "terminal" && failures === 0) { failures += 1; throw new Error("EBUSY synthetic"); }
      return { id: "session-1", messages: [message] } as unknown as ChatSession;
    });
    const s = runScenario({ disk }); await s.ready(); s.text("The verified answer."); await s.finish();
    const terminalWrites = s.saved().filter(record => record.runSnapshot.status === "terminal");
    expect(terminalWrites).toHaveLength(2);
    expect(terminalWrites[1]).toStrictEqual(terminalWrites[0]);
    expect(terminalWrites[1]).toMatchObject({ content: "The verified answer.", runSnapshot: { runId: "run-1", status: "terminal", terminalStatus: "success" } });
    expect(JSON.stringify(terminalWrites[1].processMessages)).not.toContain("E_HARNESS_FAILURE");
    expect(s.patches().at(-1)).toMatchObject({ content: "The verified answer.", runStage: { kind: "completed" }, responseStarted: true });
    expect(s.patches().some(patch => patch.runStage?.kind === "failed")).toEqual(false);
    expect(s.bridge.reportRunPersisted.mock.calls).toEqual([[{ runId: "run-1", finalMessageId: "assistant-1" }]]);
    expect(s.bridge.run).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["null", null],
    ["a session without the message", { id: "session-1", messages: [] }],
  ])("a terminal write that returns %s is not treated as saved and is not retried", async (_label, reply) => {
    const disk = memory();
    disk.upsert.mockImplementation(async (_sessionId: string, message: any) =>
      (message.runSnapshot.status === "terminal" ? reply : { id: "session-1", messages: [message] }) as unknown as ChatSession | null);
    const s = runScenario({ disk }); await s.ready(); s.text("An answer the store did not keep."); await s.finish();
    expect(s.saved().filter(record => record.runSnapshot.status === "terminal")).toHaveLength(1);
    expect(s.bridge.reportRunPersisted).not.toHaveBeenCalled();
    expect(s.patches().filter(patch => "content" in patch).at(-1)).toMatchObject({ content: "An answer the store did not keep.", responseStarted: true });
    expect(s.patches().at(-1)?.processMessages?.map(record => record.content)).toEqual([t("chatPage.terminalSaveFailed")]);
    expect(s.host.onRunFinished).toHaveBeenCalledTimes(1);
  });

  test("a failed run whose terminal write is rejected shows both notices and sends no receipt", async () => {
    const disk = memory();
    disk.upsert.mockImplementation(async (_sessionId: string, message: any) => {
      if (message.runSnapshot.status === "terminal") throw new Error("CHAT_HISTORY_WRITE_FAILED synthetic");
      return { id: "session-1", messages: [message] } as unknown as ChatSession;
    });
    const s = runScenario({ disk }); await s.ready(); await s.fail("socket hang up", { code: "E_MODEL_CONNECTION_LOST", errorSource: "model" });
    const terminalWrites = s.saved().filter(record => record.runSnapshot.status === "terminal");
    expect(terminalWrites).toHaveLength(3);
    expect(terminalWrites[0].runSnapshot.terminalStatus).toEqual("runtime_error");
    expect(s.patches().at(-1)?.processMessages?.map(record => record.content)).toEqual([
      t("chatPage.errorNetworkInterrupted", { code: "E_MODEL_CONNECTION_LOST" }), t("chatPage.terminalSaveFailed"),
    ]);
    expect(s.bridge.reportRunPersisted).not.toHaveBeenCalled();
    expect(s.host.setModeBusy).toHaveBeenLastCalledWith("chat", false);
  });
});

 describe("Main terminal ownership", () => {
  test.each(["success", "runtime_error"] as const)("accepted Main-managed %s does not write or acknowledge a terminal snapshot", async status => {
    const s = runScenario({ ack: { success: true, runId: "run-1", mainOwnsTerminal: true } });
    await s.ready(); s.text("visible answer");
    if (status === "runtime_error") await s.fail("E_HARNESS_FAILURE"); else await s.finish();
    expect(s.saved().filter(row => row.runSnapshot?.status === "terminal")).toEqual([]);
    expect(s.bridge.reportRunPersisted).not.toHaveBeenCalled();
  });

  test("a Main-managed run releases the queue only after Main stops reporting it as settling", async () => {
    const s = runScenario({ ack: { success: true, runId: "run-1", mainOwnsTerminal: true } });
    const phases = ["settling", "settling", "finished"] as const;
    let call = 0;
    const getRunStatus = vi.fn(async () => {
      const phase = phases[Math.min(call++, phases.length - 1)];
      if (phase !== "finished") expect(s.host.onRunFinished).not.toHaveBeenCalled();
      return [{ sessionId: "session-1", assistantTurnId: "assistant-1", runId: "run-1", seq: call, phase }];
    });
    (s.bridge as AguiApi).getRunStatus = getRunStatus as unknown as AguiApi["getRunStatus"];
    await s.ready(); s.text("visible answer");
    await s.finish();
    expect(getRunStatus).toHaveBeenCalledTimes(3);
    expect(getRunStatus).toHaveBeenCalledWith({ sessionId: "session-1", candidates: [{ assistantTurnId: "assistant-1", runId: "run-1" }] });
    expect(s.host.onRunFinished.mock.calls).toEqual([[{ mode: "chat", sessionId: "session-1", queuePaused: false }]]);
  });

  test("applies firefly.tool_progress to running tools without altering final tool result", async () => {
    const s = runScenario();
    await s.ready();
    s.send({ type: "TOOL_CALL_START", runId: "run-1", toolCallId: "call-p1", toolCallName: "demo_slow" });
    s.custom("firefly.tool_progress", { toolCallId: "call-p1", message: "Syncing step 1", percent: 50 });
    expect(s.patches().at(-1)?.toolExecutions?.[0]).toMatchObject({
      id: "call-p1",
      status: "running",
      progress: { message: "Syncing step 1", percent: 50 },
    });
    s.send({ type: "TOOL_CALL_RESULT", runId: "run-1", toolCallId: "call-p1", content: "actual tool output" });
    expect(s.patches().at(-1)?.toolExecutions?.[0]).toMatchObject({
      id: "call-p1",
      status: "success",
      result: "actual tool output",
      progress: undefined,
    });
    await s.finish();
  });
});
