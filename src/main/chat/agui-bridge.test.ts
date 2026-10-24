import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observable } from "rxjs";
import { IPC } from "../../shared/ipc-channels";
const wire = vi.hoisted(() => ({
    root: "", handlers: new Map<string, any>(), notifications: new Map<string, any>(), sessions: new Map<string, any>(),
    run: vi.fn(), ask: vi.fn(), pending: vi.fn(), mark: vi.fn(), reset: vi.fn(), reads: [] as unknown[], events: [] as any[],
    terminal: undefined as any, duplicate: false, failure: null as Error | null, lateFailure: false, omitTerminal: false, keepOpen: false, finishOnAbort: false, subscriptions: [] as any[],
}));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, readFileSync: (...args: any[]) => { wire.reads.push(args[0]); return (actual.readFileSync as any)(...args); } };
});
vi.mock("electron", () => ({ app: { getPath: () => wire.root }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (channel: string, callback: any) => wire.handlers.set(channel, callback), on: (channel: string, callback: any) => wire.notifications.set(channel, callback), removeListener: vi.fn() } }));
vi.mock("../chats/chats-store", () => ({ getSession: (id: string) => wire.sessions.get(id) ?? null, getPendingMessages: wire.pending, markPendingAdjust: wire.mark, resetPendingAdjustByRun: wire.reset }));
vi.mock("./user-choice", () => ({ requestUserClarification: wire.ask, cancelPendingChoicesForRun: vi.fn() }));
vi.mock("../permission/permission", () => ({ cancelPendingApprovalsForRun: vi.fn(), checkPermission: vi.fn(), getCurrentLevel: () => "read-only" }));
vi.mock("../orchestrator/tools/history-tools", () => ({ indexConversationTurn: vi.fn() }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {
        lastResult = { reply: "A helpful response", toolResults: [] };
        runWithEvents(options: any) {
            wire.run(options);
            return new Observable(subscriber => {
                wire.subscriptions.push(subscriber);
                subscriber.next({ type: "RUN_STARTED", runId: options.runId });
                wire.events.forEach(event => subscriber.next(event));
                if (wire.failure) {
                    subscriber.error(wire.failure);
                    return;
                }
                if (!wire.omitTerminal) {
                    const event = { type: "RUN_FINISHED", runId: options.runId, ...(wire.terminal === undefined ? {} : { result: wire.terminal }) };
                    subscriber.next(event);
                    if (wire.duplicate)
                        subscriber.next(event);
                    if (wire.lateFailure) {
                        subscriber.error(new Error("Late upstream failure"));
                        return;
                    }
                }
                if (wire.finishOnAbort)
                    options.signal.addEventListener("abort", () => { subscriber.next({ type: "RUN_FINISHED", runId: options.runId, result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } }); subscriber.complete(); }, { once: true });
                if (!wire.keepOpen)
                    subscriber.complete();
            });
        }
    } }));
beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    wire.handlers.clear();
    wire.notifications.clear();
    wire.sessions.clear();
    wire.root = fs.mkdtempSync(join(tmpdir(), "agui-contract-"));
    wire.events = [];
    wire.reads = [];
    wire.subscriptions = [];
    wire.terminal = undefined;
    wire.duplicate = false;
    wire.failure = null;
    wire.lateFailure = false;
    wire.omitTerminal = false;
    wire.keepOpen = false;
    wire.finishOnAbort = false;
    wire.pending.mockReturnValue([]);
    wire.reset.mockReturnValue({ ok: true, reset: 0 });
});
afterEach(async () => {
    wire.subscriptions.forEach(subscriber => subscriber.unsubscribe());
    vi.useRealTimers();
    await new Promise<void>(resolve => setImmediate(resolve));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(wire.root, { recursive: true, force: true });
});
const question = "Plan a coastal trip";
function session(id = "conversation", mode = "chat", messages: any[] = []) { const value = { id, mode, messages, ...(mode === "chat" ? {} : { workspaceBinding: { workspaceRoot: wire.root, displayName: "fixture-project", boundAt: 23 } }) }; wire.sessions.set(id, value); return value; }
const user = (id: string, content = question, at = 1) => ({ id, role: "user", content, at });
const answer = (id: string, content: string, at = 2) => ({ id, role: "model", content, at });
const built = (patch: any = {}, text = question) => ({ options: { settings: { provider: "fixture-vendor", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 }, messages: [], timeoutMs: 2000, toolSystemContent: "Fixture tools", soulSystemBaseContent: "Fixture persona", ...patch }, latestUserText: text });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function bridge(options: {
    build?: any;
    effects?: any;
    pendingTurns?: any;
    memory?: any;
} = {}) {
    const module = await import("./agui-bridge");
    const build = options.build ?? vi.fn(async () => built()), effects = options.effects ?? vi.fn(async () => ({})), sent: any[] = [];
    const sender = { isDestroyed: () => false, send: vi.fn((_channel: string, event: any) => { sent.push(event); }), once: vi.fn(), removeListener: vi.fn() };
    module.registerAgUiIpc(build, effects, () => null, undefined, undefined, options.pendingTurns, options.memory);
    const run = (id = "conversation", patch: any = {}) => wire.handlers.get(IPC.AGUI_RUN)({ sender }, { messages: [{ role: "user", content: question }], sessionId: id, ...patch });
    return { module, build, effects, sent, sender, run, cancel: (id?: string) => wire.handlers.get(IPC.AGUI_CANCEL)({}, id), adjust: (payload: any) => wire.handlers.get(IPC.CHATS_PENDING_ADJUST)({ sender }, payload), idle: async () => vi.waitFor(() => expect(module.hasActiveConversationRun()).toEqual(false)) };
}
function running(cooperative = false) { wire.omitTerminal = true; wire.keepOpen = true; wire.finishOnAbort = cooperative; }
const agentOptions = () => wire.run.mock.calls.at(-1)![0];
const terminals = (events: any[]) => events.filter(event => ["RUN_FINISHED", "RUN_ERROR"].includes(event.type));
describe("run identity and terminal presentation", () => {
    it("uses canonical identity for acknowledgement, options, events and successful effects", async () => {
        session();
        const f = await bridge();
        const ack = await f.run("conversation", { modelProfileId: "pending-profile" });
        await f.idle();
        expect(ack.runId).toBeTruthy();
        expect(wire.run).toHaveBeenCalledWith(expect.objectContaining({ runId: ack.runId }));
        expect(f.sent.find(event => event.type === "RUN_STARTED").runId).toEqual(ack.runId);
        expect(f.sent.find(event => event.type === "RUN_FINISHED").runId).toEqual(ack.runId);
        expect(f.effects).toHaveBeenCalledWith(expect.objectContaining({ reply: "A helpful response" }), question, { source: "desktop", mode: "chat", conversationId: "conversation", runId: ack.runId, modelProfileId: "pending-profile" });
    });
    it("sends sticker effects before the sole terminal event", async () => {
        session();
        const f = await bridge({ effects: vi.fn(async () => ({ sticker: "smile" })) });
        await f.run();
        await f.idle();
        expect(f.sent.map(event => event.name ?? event.type)).toEqual(["RUN_STARTED", "firefly.sticker", "RUN_FINISHED"]);
    });
    it.each(["duplicate", "late-error", "bare-complete"])("settles once for %s upstream behavior", async (mode) => {
        session();
        wire.duplicate = mode === "duplicate";
        wire.lateFailure = mode === "late-error";
        wire.omitTerminal = mode === "bare-complete";
        const f = await bridge();
        const ack = await f.run();
        await f.idle();
        expect(terminals(f.sent)).toHaveLength(1);
        expect(terminals(f.sent)[0]).toMatchObject({ type: "RUN_FINISHED", runId: ack.runId });
        expect(f.sent.some(event => event.type === "RUN_ERROR")).toEqual(false);
        if (mode === "bare-complete")
            expect(terminals(f.sent)[0].result).toEqual({ status: "success", externalEffectsMayContinue: false });
    });
    it("does not emit success effects for a cancelled terminal", async () => {
        session();
        wire.terminal = { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
        const f = await bridge({ effects: vi.fn(async () => ({ sticker: "must-be-absent" })) });
        await f.run();
        await f.idle();
        expect(f.effects).not.toHaveBeenCalled();
        expect(f.sent.some(event => event.name === "firefly.sticker")).toEqual(false);
        expect(f.sent.some(event => event.type === "RUN_FINISHED")).toEqual(true);
    });
    it("does not keep a synchronously settled run cancellable", async () => {
        session();
        const f = await bridge();
        const ack = await f.run();
        await f.idle();
        const signal = agentOptions().signal;
        await f.cancel(ack.runId);
        expect(signal.aborted).toEqual(false);
        expect(f.module.isActiveConversationRun("conversation", ack.runId)).toEqual(false);
    });
    it.each([
        ["E_HARNESS_FAILURE", "E_HARNESS_FAILURE", "runtime", false], ["MEMORY_CONTEXT_TRANSCRIPT_SECRET", "MEMORY_CONTEXT_TRANSCRIPT_SECRET", "context", false], ["E_MODEL_REQUEST_FAILED", "E_MODEL_REQUEST_FAILED", "model", false], ["PRIVATE_PROVIDER_DETAIL_51", "E_HARNESS_FAILURE", "runtime", false], ["E_MODEL_HTTP_ERROR", "E_MODEL_HTTP_ERROR", "model", true], ["MEMORY_CONTEXT_TRANSCRIPT_SECRET", "MEMORY_CONTEXT_TRANSCRIPT_SECRET", "context", true], ["PRIVATE_PROVIDER_DETAIL_51", "E_HARNESS_FAILURE", "runtime", true],
    ])("exposes safe failure metadata for %s observable-error=%s", async (reason, code, source, direct) => {
        session();
        wire.terminal = { status: "runtime_error", reason, externalEffectsMayContinue: true };
        if (direct)
            wire.failure = Object.assign(new Error("PRIVATE_PROVIDER_DETAIL_51"), { code: reason });
        const f = await bridge({ effects: vi.fn(async () => ({ sticker: "must-be-absent" })) });
        await f.run();
        await f.idle();
        expect(f.sent.find(event => event.type === "RUN_ERROR")).toMatchObject({ message: code, code, errorSource: source });
        expect(JSON.stringify(f.sent)).not.toContain("PRIVATE_PROVIDER_DETAIL_51");
        expect(f.sent.some(event => event.type === "RUN_FINISHED")).toEqual(false);
        expect(f.effects).not.toHaveBeenCalled();
        expect(f.sent.some(event => event.name === "firefly.sticker")).toEqual(false);
    });
    it("separates overlapping completion timings until the callbacks actually finish", async () => {
        vi.stubEnv("FIREFLY_DEBUG_LOGS", "1");
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined), gates = [deferred(), deferred()];
        let next = 0;
        const { perf } = await import("../logging/perf-trace");
        const effects = vi.fn(async (_result, text) => { await perf.track(`finish-${text}`, () => gates[text === "north" ? 0 : 1].promise); return { sticker: null }; });
        session("north-session");
        session("south-session");
        const f = await bridge({ build: async () => built({}, next++ === 0 ? "north" : "south"), effects });
        const north = await f.run("north-session"), south = await f.run("south-session");
        await vi.waitFor(() => expect(effects).toHaveBeenCalledTimes(2));
        const output = () => log.mock.calls.flat().join("\n");
        expect(output()).not.toContain("TURN SUMMARY");
        log.mockClear();
        gates[1].resolve();
        await vi.waitFor(() => expect(output()).toContain("TURN SUMMARY"));
        expect(output()).toContain(south.runId);
        expect(output()).toContain("finish-south");
        expect(output()).not.toContain("finish-north");
        log.mockClear();
        gates[0].resolve();
        await f.idle();
        expect(output()).toContain(north.runId);
        expect(output()).toContain("finish-north");
        expect(output()).not.toContain("finish-south");
    });
});
describe("stream content and interactions", () => {
    it("delivers reasoning before assistant text boundaries with one shared identity", async () => {
        session();
        wire.events = [{ type: "TEXT_MESSAGE_START", messageId: "reasoned-answer", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "reasoned-answer", delta: "<think>Map" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "reasoned-answer", delta: " it</think>Route" }, { type: "TEXT_MESSAGE_END", messageId: "reasoned-answer" }];
        const f = await bridge();
        await f.run();
        await f.idle();
        expect(f.sent.map(event => event.type)).toEqual(["RUN_STARTED", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
        expect(f.sent.find(event => event.type === "REASONING_MESSAGE_CONTENT").delta).toEqual("Map it");
        expect(f.sent.find(event => event.type === "TEXT_MESSAGE_CONTENT").delta).toEqual("Route");
        const runId = f.sent[0].runId;
        expect(runId).toEqual(expect.any(String));
        expect(f.sent.filter(event => event.type.startsWith("TEXT_MESSAGE")).every(event => event.runId === runId)).toEqual(true);
    });
    it.each(["chat", "work", "code"])("strips repeated leading timestamps in %s mode", async (mode) => {
        session("conversation", mode);
        wire.events = [{ type: "TEXT_MESSAGE_START", messageId: "dated-answer", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "dated-answer", delta: "[2027-03-11 09:12, Europe/Paris]\n" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "dated-answer", delta: "[2027-03-11 09:12, Europe/Paris]A visible answer" }, { type: "TEXT_MESSAGE_END", messageId: "dated-answer" }];
        const f = await bridge();
        await f.run();
        await f.idle();
        expect(f.sent.filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join("")).toEqual("A visible answer");
    });
    it("routes live choice cards and settlements to the invoking renderer", async () => {
        session("conversation", "work");
        wire.ask.mockImplementation(async (_card, send, settle, identity) => { send({ interactionId: "format-choice", ...identity, mode: "semantic_clarification", questions: [] }); settle({ id: "format-choice", ...identity, reason: "timeout" }); return { requestId: "format-choice", answers: [] }; });
        const f = await bridge();
        await f.run();
        await agentOptions().requestUserClarification({ intro: "Choose a format", questions: [], deferredFields: [] });
        expect(wire.ask).toHaveBeenCalledTimes(1);
        expect(f.sent).toContainEqual(expect.objectContaining({ type: "CUSTOM", name: "firefly.choice", value: expect.objectContaining({ interactionId: "format-choice", runId: expect.any(String), revision: 1 }) }));
        expect(f.sent).toContainEqual(expect.objectContaining({ type: "CUSTOM", name: "firefly.choice.dismiss", value: expect.objectContaining({ id: "format-choice", runId: expect.any(String), revision: 1, reason: "timeout" }) }));
    });
    it.each([false, true])("tags post-run plan cards and their timeout dismissal=%s", async (dismiss) => {
        session("plan-session", "code");
        const plan = await import("../orchestrator/plan-mode");
        plan.enterPlanDiscussing("plan-session", wire.root);
        plan.markPlanWritten("plan-session");
        const file = plan.getPlanPath("plan-session");
        fs.mkdirSync(dirname(file), { recursive: true });
        fs.writeFileSync(file, "# Coastal route plan\n");
        wire.ask.mockImplementation(async (_card, send, settled, identity) => { send({ interactionId: "plan-approval", ...identity, mode: "semantic_clarification", questions: [] }); if (dismiss)
            settled({ id: "plan-approval", ...identity, reason: "timeout" }); return { requestId: "plan-approval", answers: [] }; });
        const f = await bridge();
        await f.run("plan-session");
        await vi.waitFor(() => expect(f.sent.some(event => event.name === (dismiss ? "firefly.choice.dismiss" : "firefly.choice"))).toEqual(true));
        const card = f.sent.findIndex(event => event.name === "firefly.choice"), end = f.sent.findIndex(event => event.type === "RUN_FINISHED");
        expect(card).toBeGreaterThan(end);
        expect(f.sent[card].value).toMatchObject({ sessionId: "plan-session", interactionId: "plan-approval" });
        if (dismiss)
            expect(f.sent.find(event => event.name === "firefly.choice.dismiss").value).toMatchObject({ id: "plan-approval", runId: f.sent.find(event => event.type === "RUN_STARTED").runId, revision: 1, reason: "timeout" });
    });
    it("requires terminal settlement plus renderer persistence before publishing completion", async () => {
        session("conversation", "chat", [user("input"), { ...answer("output", ""), answersUserMessageId: "input" }]);
        const { createPendingTurnLifecycle } = await import("../plugin-host/pending-turn-lifecycle");
        const publisher = { publishTurnStarted: vi.fn(), publishTurnFinished: vi.fn(), publishSchedulerFinished: vi.fn() }, pendingTurns = createPendingTurnLifecycle({ publisher: publisher as any, now: () => 0 });
        const f = await bridge({ pendingTurns });
        const ack = await f.run("conversation", { userTurnId: "input", assistantTurnId: "output" });
        await f.idle();
        expect(publisher.publishTurnStarted).toHaveBeenCalledExactlyOnceWith({ source: "desktop", runId: ack.runId, mode: "chat", conversationId: "conversation", inputMessageId: "input" });
        expect(pendingTurns.pendingCount()).toEqual(1);
        expect(publisher.publishTurnFinished).not.toHaveBeenCalled();
        wire.notifications.get(IPC.AGUI_RUN_PERSISTED)({}, { runId: ack.runId, finalMessageId: "output" });
        await vi.waitFor(() => expect(publisher.publishTurnFinished).toHaveBeenCalledTimes(1));
        expect(publisher.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ source: "desktop", runId: ack.runId, mode: "chat", conversationId: "conversation", inputMessageId: "input", finalMessageId: "output", status: "success" }));
        expect(pendingTurns.pendingCount()).toEqual(0);
    });
});
describe("session ownership, cancellation and takeover", () => {
    it.each(["chat", "work"])("uses the stored %s mode instead of renderer hints", async (mode) => {
        session("conversation", mode);
        const f = await bridge();
        await f.run("conversation", { executionMode: mode === "chat" ? "work" : "chat" });
        await f.idle();
        expect(f.build).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "conversation", executionMode: mode }));
        expect(wire.run).toHaveBeenCalledTimes(1);
        expect(wire.run).toHaveBeenCalledWith(expect.objectContaining({ executionMode: mode }));
    });
    it("rejects retired modes and project conversations lacking a trusted workspace", async () => {
        const value = session("conversation", "work");
        delete (value as any).workspaceBinding;
        const f = await bridge();
        await expect(f.run("conversation", { mode: "learn" })).rejects.toThrow("INVALID_CONVERSATION_MODE");
        expect(wire.run).not.toHaveBeenCalled();
        await expect(f.run()).rejects.toThrow("需要先绑定项目工作区");
        expect(wire.run).not.toHaveBeenCalled();
    });
    it("gives active runs separate signals and supports targeted cancellation and cancel-all", async () => {
        session("one");
        session("two");
        running();
        const f = await bridge();
        const first = await f.run("one"), signalA = agentOptions().signal;
        await f.run("two");
        const signalB = agentOptions().signal;
        expect(signalA).toBeDefined();
        expect(signalB).toBeDefined();
        expect(signalA).not.toBe(signalB);
        expect(signalA.aborted).toEqual(false);
        expect(signalB.aborted).toEqual(false);
        await f.cancel(first.runId);
        expect(signalA.aborted).toEqual(true);
        expect(signalB.aborted).toEqual(false);
        await f.cancel();
        expect(signalA.aborted).toEqual(true);
        expect(signalB.aborted).toEqual(true);
    });
    it("rejects overlapping and stale-takeover requests without releasing the owner", async () => {
        session();
        running();
        const f = await bridge();
        const first = await f.run();
        expect(f.module.isActiveConversationRun).toBeTypeOf("function");
        expect(f.module.isActiveConversationRun("conversation", first.runId)).toEqual(true);
        expect(f.module.isActiveConversationRun("another-session", first.runId)).toEqual(false);
        expect(f.module.isActiveConversationRun("conversation", "obsolete-run")).toEqual(false);
        for (const patch of [{}, { takeoverFromRunId: "obsolete-run" }])
            await expect(f.run("conversation", patch)).rejects.toThrow(`SESSION_RUN_ACTIVE:${first.runId}`);
        expect(f.module.isActiveConversationRun("conversation", first.runId)).toEqual(true);
    });
    it("allows later runs after build failure or normal settlement", async () => {
        session();
        const build = vi.fn().mockRejectedValueOnce(new Error("Options could not be prepared")).mockResolvedValue(built());
        const f = await bridge({ build });
        await expect(f.run()).rejects.toThrow("Options could not be prepared");
        expect(f.module.hasActiveConversationRun()).toEqual(false);
        expect(wire.reset).toHaveBeenCalled();
        await f.run();
        await f.idle();
        running();
        const next = await f.run();
        expect(next.runId).toBeTruthy();
        expect(f.module.isActiveConversationRun("conversation", next.runId)).toEqual(true);
    });
    it("waits for old settlement and preserves the replacement against stale cancellation", async () => {
        session();
        running(true);
        const f = await bridge();
        const first = await f.run(), original = agentOptions();
        const second = await f.run("conversation", { takeoverFromRunId: first.runId }), replacement = agentOptions();
        expect(wire.run).toHaveBeenCalledTimes(2);
        expect(original.signal.aborted).toEqual(true);
        expect(replacement.signal.aborted).toEqual(false);
        expect(f.module.isActiveConversationRun("conversation", second.runId)).toEqual(true);
        await f.cancel(first.runId);
        expect(f.module.isActiveConversationRun("conversation", second.runId)).toEqual(true);
        await f.cancel(second.runId);
        await f.idle();
        expect(f.module.isActiveConversationRun("conversation", second.runId)).toEqual(false);
    });
    it("bounds takeover waits for an aborted run that never settles", async () => {
        session();
        running();
        const f = await bridge();
        vi.useFakeTimers();
        const first = await f.run();
        const checked = expect(f.run("conversation", { takeoverFromRunId: first.runId })).rejects.toThrow(`SESSION_RUN_TAKEOVER_STUCK:${first.runId}`);
        await vi.advanceTimersByTimeAsync(10001);
        await checked;
    });
    it("admits one same-tick run and one concurrent takeover", async () => {
        session();
        running(true);
        const f = await bridge();
        const initial = await Promise.allSettled([f.run(), f.run()]);
        expect(initial.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
        expect((initial[1] as PromiseRejectedResult).reason.message).toMatch(/^SESSION_RUN_ACTIVE:/);
        const first = (initial[0] as PromiseFulfilledResult<any>).value;
        const results = await Promise.allSettled([f.run("conversation", { takeoverFromRunId: first.runId }), f.run("conversation", { takeoverFromRunId: first.runId })]);
        expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/^SESSION_RUN_ACTIVE:/);
        const winner = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<any>).value;
        expect(f.module.isActiveConversationRun("conversation", winner.runId)).toEqual(true);
    });
    it("binds controlled sinks and currentness to the owning run through takeover and cancel", async () => {
        session("conversation", "chat", [user("input"), { ...answer("output", ""), answersUserMessageId: "input" }]);
        running(true);
        const f = await bridge({ build: async () => built({ conversationId: "conversation", controlledResponses: vi.fn() }) });
        const patch = { userTurnId: "input", assistantTurnId: "output" };
        const first = await f.run("conversation", patch), original = agentOptions();
        const { requireTranscriptSinkBinding } = await import("../orchestrator/transcript-sink");
        expect(() => requireTranscriptSinkBinding(original.transcriptSink, { conversationId: "conversation", runId: first.runId, assistantTurnId: "output" })).not.toThrow();
        expect(original.isControlledRunCurrent()).toEqual(true);
        const second = await f.run("conversation", { ...patch, takeoverFromRunId: first.runId }), replacement = agentOptions();
        expect(original.isControlledRunCurrent()).toEqual(false);
        expect(replacement.isControlledRunCurrent()).toEqual(true);
        expect(original.signal.aborted).toEqual(true);
        expect(replacement.runId).toEqual(second.runId);
        await f.cancel(second.runId);
        await f.idle();
        expect(replacement.isControlledRunCurrent()).toEqual(false);
    });
    it("fails a controlled bare completion without durable S confirmation", async () => {
        session("conversation", "chat", [user("input"), { ...answer("output", ""), answersUserMessageId: "input" }]);
        wire.omitTerminal = true;
        const f = await bridge({ build: async () => built({ conversationId: "conversation", controlledResponses: vi.fn() }) });
        await f.run("conversation", { userTurnId: "input", assistantTurnId: "output" });
        await f.idle();
        expect(f.sender.send).toHaveBeenCalledWith(IPC.AGUI_EVENT, expect.objectContaining({ type: "RUN_ERROR", code: "MEMORY_CONTEXT_SETTLEMENT_UNKNOWN" }));
        expect(f.effects).not.toHaveBeenCalled();
        expect(f.sent.some(event => event.type === "RUN_FINISHED")).toEqual(false);
    });
});
describe("live pending adjustments", () => {
    it("rejects malformed, missing, idle and Chat targets without marking messages", async () => {
        const f = await bridge();
        for (const payload of [null, { sessionId: "", messageId: "pending" }])
            expect(await f.adjust(payload)).toEqual({ ok: false, error: "invalid-payload" });
        expect(await f.adjust({ sessionId: "missing-session", messageId: "pending" })).toEqual({ ok: false, error: "session-not-found" });
        session("project", "work");
        wire.pending.mockReturnValue([{ id: "pending", rawContent: "Queued", visibleContent: "Queued", enqueuedAt: 12 }]);
        expect(await f.adjust({ sessionId: "project", messageId: "pending" })).toEqual({ ok: false, error: "no-active-run", queue: [expect.objectContaining({ id: "pending" })] });
        session();
        wire.pending.mockReturnValue([]);
        running();
        await f.run();
        expect(await f.adjust({ sessionId: "conversation", messageId: "pending" })).toEqual({ ok: false, error: "no-safe-next-step", queue: [] });
        expect(wire.mark).not.toHaveBeenCalled();
    });
    it("marks the trusted Work run and resets its remaining marks at settlement", async () => {
        session("project", "work");
        running(true);
        const f = await bridge();
        const ack = await f.run("project");
        wire.mark.mockReturnValue({ ok: true, queue: [{ id: "pending", adjustRunId: ack.runId }] });
        expect(await f.adjust({ sessionId: "project", messageId: "pending" })).toEqual({ ok: true, queue: [expect.objectContaining({ id: "pending", adjustRunId: ack.runId })] });
        expect(wire.mark).toHaveBeenCalledWith("project", "pending", ack.runId);
        await f.cancel(ack.runId);
        await f.idle();
        expect(wire.reset).toHaveBeenCalledWith("project", ack.runId);
    });
});
it("resets Work adjustment marks on both natural settlement and failed construction", async () => {
    session("project", "work");
    const build = vi.fn().mockResolvedValueOnce(built()).mockRejectedValueOnce(new Error("Work options unavailable"));
    const f = await bridge({ build });
    const completed = await f.run("project");
    await f.idle();
    expect(wire.reset).toHaveBeenCalledWith("project", completed.runId);
    wire.reset.mockClear();
    await expect(f.run("project")).rejects.toThrow("Work options unavailable");
    expect(wire.reset).toHaveBeenCalled();
    expect(f.module.hasActiveConversationRun()).toEqual(false);
});
describe("transcript ownership and Work read evidence", () => {
    it.each(["transcript", "renderer"])("commits users while honoring the %s context source", async (source) => {
        vi.stubEnv("FIREFLY_TRANSCRIPT_CONTEXT_SOURCE", source);
        session("conversation", "chat", [user("old-user", "Earlier question"), answer("old-answer", "Earlier response"), user("input", question, 3)]);
        const f = await bridge();
        await f.run("conversation", { userTurnId: "input", useTranscriptContext: true });
        await f.idle();
        expect(f.build.mock.calls[0][0].useTranscriptContext).toEqual(source === "transcript");
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const entries = (await getConversationTranscriptStore(wire.root).read("conversation")).entries;
        expect(entries.some(entry => entry.kind === "backfill_boundary")).toEqual(true);
        expect(entries.some(entry => entry.kind === "user" && entry.turnId === "input")).toEqual(true);
        if (source === "transcript")
            expect(entries.some(entry => entry.kind === "assistant" && entry.payload.content === "Earlier response")).toEqual(true);
    });
    it("does not inject transcript context or sinks for calls without userTurnId", async () => {
        session();
        const f = await bridge();
        await f.run("conversation", { useTranscriptContext: true });
        await f.idle();
        expect(f.build.mock.calls[0][0].useTranscriptContext).toEqual(false);
        expect(wire.run).toHaveBeenCalled();
        expect(agentOptions().transcriptSink).toBeUndefined();
    });
    it("blocks model construction if the requested user cannot be committed", async () => {
        session("conversation", "chat", [user("known-user", "Earlier question")]);
        const f = await bridge();
        await expect(f.run("conversation", { userTurnId: "absent-turn" })).rejects.toThrow("TRANSCRIPT_USER_TURN_NOT_FOUND");
        expect(f.build).not.toHaveBeenCalled();
        expect(wire.run).not.toHaveBeenCalled();
    });
    it("retains both transcript and dispatch recovery context", async () => {
        session("conversation", "chat", [user("input")]);
        const f = await bridge({ build: async () => built({ recoveryContext: "Transcript: unconfirmed external effect" }) });
        await f.run("conversation", { userTurnId: "input", recoveryContext: "Dispatch: resumed channel state" });
        await f.idle();
        expect(agentOptions().recoveryContext).toContain("Transcript: unconfirmed external effect");
        expect(agentOptions().recoveryContext).toContain("Dispatch: resumed channel state");
    });
    it.each(["chat", "work", "code"])("materializes the next %s request from canonical history", async (mode) => {
        session("conversation", mode, [user("turn-alpha", "First question")]);
        let materialize = async (): Promise<any[]> => [];
        const f = await bridge({ build: async () => built({ messages: await materialize() }) });
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const { buildModelContext, resolveTranscriptRetainTokens } = await import("../orchestrator/conversation-transcript-context");
        materialize = async () => (await buildModelContext({ store: getConversationTranscriptStore(wire.root), conversationId: "conversation", retainTokens: resolveTranscriptRetainTokens(256000), runReader: { get: () => null } })).messages;
        await f.run("conversation", { userTurnId: "turn-alpha" });
        await f.idle();
        const sink = agentOptions().transcriptSink;
        expect(sink).toBeDefined();
        const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "First response", ...(mode === "chat" ? {} : { toolCalls: [{ id: "read-route", name: "read_file", arguments: '{"path":"routes.md"}' }] }) } });
        if (mode !== "chat")
            await sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "read-route", name: "read_file", content: "Route file contents" }, outcome: "success" });
        session("conversation", mode, [user("turn-alpha", "First question"), answer("cached-alpha", "First response"), user("turn-beta", "Second question", 3)]);
        await f.run("conversation", { userTurnId: "turn-beta" });
        await f.idle();
        const messages = agentOptions().messages;
        expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "First question" }), expect.objectContaining({ role: "assistant", content: "First response" }), expect.objectContaining({ role: "user", content: "Second question" })]));
        if (mode !== "chat")
            expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "read-route", content: "Route file contents" })]));
        expect(agentOptions().executionMode).toEqual(mode === "chat" ? "chat" : "work");
    });
    it("keeps Chat history continuous across plain, tool-using and plain rounds", async () => {
        session("conversation", "chat", [user("turn-one", "Question one")]);
        let materialize = async (): Promise<any[]> => [];
        const f = await bridge({ build: async () => built({ messages: await materialize() }) });
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const { buildModelContext, resolveTranscriptRetainTokens } = await import("../orchestrator/conversation-transcript-context");
        materialize = async () => (await buildModelContext({ store: getConversationTranscriptStore(wire.root), conversationId: "conversation", retainTokens: resolveTranscriptRetainTokens(256000), runReader: { get: () => null } })).messages;
        await f.run("conversation", { userTurnId: "turn-one" });
        await f.idle();
        expect(agentOptions().transcriptSink).toBeDefined();
        await agentOptions().transcriptSink.appendAssistant({ message: { role: "assistant", content: "Answer one" } });
        session("conversation", "chat", [user("turn-one", "Question one"), answer("cached-one", "Answer one"), user("turn-two", "Question two", 3)]);
        await f.run("conversation", { userTurnId: "turn-two" });
        await f.idle();
        const sink = agentOptions().transcriptSink;
        expect(sink).toBeDefined();
        const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "Answer two", toolCalls: [{ id: "route-call", name: "read_file", arguments: '{"path":"routes.md"}' }] } });
        await sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "route-call", name: "read_file", content: "A route result" }, outcome: "success" });
        session("conversation", "chat", [user("turn-one", "Question one"), answer("cached-one", "Answer one"), user("turn-two", "Question two", 3), answer("cached-two", "Answer two", 4), user("turn-three", "Question three", 5)]);
        await f.run("conversation", { userTurnId: "turn-three" });
        await f.idle();
        expect(agentOptions().messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Question one" }), expect.objectContaining({ role: "assistant", content: "Answer one" }), expect.objectContaining({ role: "user", content: "Question two" }), expect.objectContaining({ role: "assistant", content: "Answer two" }), expect.objectContaining({ role: "tool", toolCallId: "route-call", content: "A route result" }), expect.objectContaining({ role: "user", content: "Question three" })]));
    });
    it.each([false, true])("validates the Main-owned file version changed=%s", async (changed) => {
        const file = join(wire.root, "required.txt");
        fs.writeFileSync(file, "Original document");
        const { inspectWorkReadFile } = await import("../chats/work-read-scope");
        const scope = inspectWorkReadFile(file);
        if (changed)
            fs.writeFileSync(file, "New document version");
        session("conversation", "work", [{ ...user("input"), attachments: [{ kind: "document", name: "required.txt", filePath: file, status: "pending", readScope: scope }] }]);
        const f = await bridge();
        if (changed) {
            await expect(f.run("conversation", { userTurnId: "input" })).rejects.toThrow("WORK_READ_SCOPE_CHANGED");
            expect(f.build).not.toHaveBeenCalled();
            expect(wire.run).not.toHaveBeenCalled();
        }
        else {
            await f.run("conversation", { userTurnId: "input" });
            await f.idle();
            expect(f.build).toHaveBeenCalledWith(expect.objectContaining({ workDocuments: [expect.objectContaining({ path: scope.path, requiredEndLine: scope.endLine })] }));
            expect(wire.run).toHaveBeenCalledWith(expect.objectContaining({ workReadScopes: [scope] }));
            const evidence = f.sent.find(event => event.name === "firefly.workRead");
            expect(evidence.value.status).toEqual("missing");
            expect(f.sent.indexOf(evidence)).toBeLessThan(f.sent.findIndex(event => event.type === "RUN_FINISHED"));
        }
    });
    it("installs the controlled observer before the canonical user append", async () => {
        session("conversation", "chat", [user("fresh-user", "A fresh request", 100), { ...answer("fresh-answer", "", 101), answersUserMessageId: "fresh-user" }]);
        const { getConversationTranscriptStore } = await import("../orchestrator/conversation-transcript-store");
        const store = getConversationTranscriptStore(wire.root), observed: string[] = [];
        let close: (() => void) | undefined;
        const build = Object.assign(async () => built(), { prepareTranscript: async () => { close = store.observeMutations("conversation", async (kind, entry) => { if (kind === "append" && entry?.kind === "user")
                observed.push(entry.payload.text); }); } });
        const f = await bridge({ build });
        try {
            await f.run("conversation", { userTurnId: "fresh-user", assistantTurnId: "fresh-answer" });
            await f.idle();
            expect(observed).toEqual(["A fresh request"]);
        }
        finally {
            close?.();
        }
    });
    it("denies unauthorized Main admission before preparation or canonical writes", async () => {
        session("conversation", "chat", [user("input")]);
        const prepareTranscript = vi.fn(), build = Object.assign(vi.fn(), { prepareTranscript });
        const f = await bridge({ build, memory: { authorizeRun: () => { throw new Error("MEMORY_DESKTOP_SESSION_DENIED"); }, afterTranscript: vi.fn() } });
        await expect(f.run("conversation", { userTurnId: "input", assistantTurnId: "output" })).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
        expect(prepareTranscript).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
        expect(f.module.hasActiveConversationRun()).toEqual(false);
    });
    it.each(["denied", "revoked"])("does not read Work bytes for a %s attachment grant", async (state) => {
        const file = join(wire.root, "private-document.txt");
        fs.writeFileSync(file, "Original document");
        const { inspectWorkReadFile } = await import("../chats/work-read-scope");
        const scope = inspectWorkReadFile(file);
        fs.writeFileSync(file, "Changed document");
        const current = session("conversation", "work", [{ ...user("input", "Read this document"), attachments: [{ kind: "document", name: "private-document.txt", filePath: file, status: "pending", readScope: scope }] }, { ...answer("output", ""), answersUserMessageId: "input" }]);
        const { createMainAttachmentProjectionAuthority } = await import("../memory-context/main-attachment-projection");
        const authority = createMainAttachmentProjectionAuthority();
        const grant = authority.issue({ sessionId: "conversation", userTurnId: "input", userRevision: 1, userText: "Read this document", attachments: current.messages[0].attachments, assertCurrent() { } });
        const f = await bridge({ memory: { usesCanonicalUserContent: true, authorizeRun: () => ({ signal: new AbortController().signal, release() { } }), afterTranscript: async () => undefined, prepareAttachmentGrant: async () => { if (state === "denied")
                    throw new Error("MEMORY_ATTACHMENT_DENIED"); authority.revokeTurn("conversation", "input"); return grant; } } });
        expect(wire.reads.filter(value => value === file)).toHaveLength(1);
        wire.reads = [];
        await expect(f.run("conversation", { userTurnId: "input", assistantTurnId: "output" })).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
        expect(wire.reads.filter(value => value === file)).toHaveLength(0);
        expect(f.build).not.toHaveBeenCalled();
        expect(wire.run).not.toHaveBeenCalled();
    });
    it.each([[undefined, "transcript"], ["renderer", "renderer"], ["unknown-setting", "transcript"]])("selects a safe context source for %s", async (input, expected) => {
        const { resolveTranscriptContextSource } = await import("./agui-bridge");
        expect(resolveTranscriptContextSource(input)).toEqual(expected);
    });
});
describe("history index ownership", () => {
    it.each([false, true].flatMap(controlled => [[controlled, "success", false], [controlled, "success", true], [controlled, "cancelled", false], [controlled, "timeout", false], [controlled, "runtime_error", false]]))("indexes ordinary success only: controlled=%s status=%s bare=%s", async (controlled, status, bare) => {
        session("conversation", "chat", [user("input"), { ...answer("output", ""), answersUserMessageId: "input" }]);
        wire.omitTerminal = Boolean(bare);
        wire.terminal = { status, externalEffectsMayContinue: status !== "success" };
        const { controlledSettlement } = await import("../orchestrator/controlled-responses");
        wire.run.mockImplementationOnce(options => { if (controlled) {
            const settlement = controlledSettlement(options.transcriptSink), result = status === "success" ? "success" : "interrupted";
            expect(settlement.reserve(result)).toEqual(true);
            expect(settlement.confirm(result)).toEqual(true);
        } });
        const f = await bridge({ build: async () => built(controlled ? { controlledResponses: vi.fn() } : {}) });
        await f.run("conversation", { userTurnId: "input", assistantTurnId: "output" });
        await f.idle();
        const { indexConversationTurn } = await import("../orchestrator/tools/history-tools");
        if (status === "success") {
            expect(f.effects).toHaveBeenCalledTimes(1);
            expect(f.sender.send).toHaveBeenCalledWith(IPC.AGUI_EVENT, expect.objectContaining({ type: "RUN_FINISHED", result: { status: "success", externalEffectsMayContinue: false } }));
        }
        else
            expect(f.effects).not.toHaveBeenCalled();
        if (!controlled && status === "success")
            expect(indexConversationTurn).toHaveBeenCalledExactlyOnceWith("conversation", question, "A helpful response");
        else
            expect(indexConversationTurn).not.toHaveBeenCalled();
    });
    it.each([true, false])("honors the memory owner's retirement decision %s", async (retires) => {
        session("conversation", "chat", [user("input"), { ...answer("output", ""), answersUserMessageId: "input" }]);
        wire.terminal = { status: "success", externalEffectsMayContinue: false };
        const f = await bridge({ memory: { authorizeRun: () => undefined, afterTranscript: async () => undefined, ...(retires ? { retiresLegacyHistoryIndex: true } : {}) } });
        await f.run("conversation", { userTurnId: "input", assistantTurnId: "output" });
        await f.idle();
        const { indexConversationTurn } = await import("../orchestrator/tools/history-tools");
        if (retires)
            expect(indexConversationTurn).not.toHaveBeenCalled();
        else
            expect(indexConversationTurn).toHaveBeenCalledExactlyOnceWith("conversation", question, "A helpful response");
    });
});
