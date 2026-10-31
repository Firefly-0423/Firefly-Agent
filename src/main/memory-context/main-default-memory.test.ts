import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { HarnessRunStore } from "../orchestrator/harness/run-store";
import { randomBytes } from "node:crypto";
import { openMemoryRepository } from "../memory-core/repository";
import { createActiveChatTargetRegistry } from "../plugin-host/active-chat-target";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { createTranscriptSink } from "../orchestrator/transcript-sink";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { initializeStorageContext } from "../storage/storage-context";
import { resolveRuntimeProfile } from "../startup/runtime-profile";
import type { FireflyRunOptions } from "../orchestrator/firefly-agent";
import type { ModelSettings } from "../settings/model-settings";
import { JSDOM } from "jsdom";
import { createMemoryEntriesPanel } from "../../renderer/settings/memory/entries-panel";
import { createMemorySettingsIpc } from "../memory-policy/memory-settings-ipc";
import { createMemoryAutomationSettingsIpc } from "../memory-policy/memory-automation-settings-ipc";
import { createMemoryAutomationPanel } from "../../renderer/settings/memory/automation-panel";
import type { MemoryPanelAction, MemoryPanelOutcome } from "../../shared/memory-panel-contracts";

const isolation = fs.mkdtempSync(path.join(os.tmpdir(), "default-memory-owner-"));
const storage = initializeStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", "--firefly-isolation-root=" + isolation], env: {}, isPackaged: false, productionAppData: path.join(os.tmpdir(), "synthetic-production-unopened") }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); fs.rmSync(path.join(storage.dataRoot, "transcripts"), { recursive: true, force: true }); });

async function fixture(mode: "chat" | "work" | "code" = "chat", options: { withoutRunReader?: boolean; withoutShadow?: boolean } = {}) {
  const { createMainDefaultMemory } = await import("./main-default-memory");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-sqlite-"));
  const repo = openMemoryRepository({ databasePath: path.join(root, "memory.sqlite"), key: randomBytes(32), clock: Date.now });
  const commands: any[] = []; let pauseNaturalOperation: string | undefined;
  const transport = { sourceCommand: async (command: unknown) => { commands.push(command); return repo.sourceCommand(command); },
    contextCommand: async (command: unknown) => { commands.push(command); return repo.contextCommand(command); },
    policyCommand: async (command: unknown) => { commands.push(command); const c = command as any; if (c.kind === "naturalJob" && c.body.operation === pauseNaturalOperation) throw Error("SYNTHETIC_CRASH_BEFORE_APPLY"); return repo.policyCommand(command); },
    ...(options.withoutShadow ? {} : { shadowCommand: async (command: unknown) => repo.shadowCommand(command) }) };
  const f = { root, repo, commands, transport };
  const sender = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => false });
  const settingsSender = Object.assign(new EventEmitter(), { id: 99, mainFrame: {}, isDestroyed: () => false });
  const settingsWindow = { webContents: settingsSender, isDestroyed: () => false };
  const settingsEvent = { sender: settingsSender, senderFrame: settingsSender.mainFrame } as any;
  const targets = createActiveChatTargetRegistry();
  const sessions = new Map<string, any>([["session-a", { id: "session-a", mode, messages: [], modelProfileId: "luna" }]]);
  const select = (id = "session-a") => targets.setActive({ sender: sender as any, sessionId: id, mode: sessions.get(id).mode, rendererTargetId: "renderer-" + id });
  select();
  const config = { provider: "OpenRouter", model: "openai/gpt-6-luna", baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-only", explicitTransport: "openai" as const };
  const settings = { ...config, contextWindowTokens: 128000, chatRequestTimeoutSec: 300, modelProfiles: [{ id: "luna", ...config }], defaultModelProfileId: "luna" } as ModelSettings;
  const store = new ConversationTranscriptStore(storage.dataRoot), runStore = new HarnessRunStore(root);
  let opened = 0, closed = 0, nativeStarts = 0;
  let unavailable = false, nativeError: string | undefined;
  const sent: string[] = [], sentSignals: AbortSignal[] = [];
  let respond = async () => Response.json({ choices: [{ message: { role: "assistant", content: "synthetic answer" }, finish_reason: "stop" }] });
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => { const request = new Request(url, init); sentSignals.push(request.signal); sent.push(await request.text()); return respond(); });
  const historyCommands: any[] = [];
  const makeMemory = () => createMainDefaultMemory({ getChatWindow: () => ({ webContents: sender, isDestroyed: () => false }) as any,
    getSettingsWindow: () => settingsWindow as any, targets, getSession: id => sessions.get(id), listSessionIds: () => [...sessions.keys()], store, ...(!options.withoutRunReader ? { runReader: runStore } : {}), settings: () => settings,
    openBackend: async () => { opened++; return { transport: { ...f.transport,
      recallCommand: async (command: unknown) => f.repo.recallCommand(command), historyCommand: async (command: unknown) => { historyCommands.push(command); return f.repo.historyCommand(command); } },
      close: async () => { closed++; }, endpointFactory: async () => {
        nativeStarts++; if (nativeError) throw Error(nativeError); if (unavailable) throw Error("MEMORY_HISTORY_NATIVE_UNAVAILABLE");
        let disposed = false;
        return { rootIdentity: { volumeSerial: 42, fileIndex: "1111111111111111" },
          assertLive() { if (disposed) throw Error("dead synthetic native"); },
          async dispose() { disposed = true; }, async read(components: readonly string[], maxBytes: number) {
            const file = path.join(storage.dataRoot, "transcripts", ...components);
            if (!fs.existsSync(file)) throw Error("history-leaf-missing"); const bytes = fs.readFileSync(file);
            if (bytes.length > maxBytes) throw Error("history-invalid-budget");
            return { bytes, identity: { volumeSerial: 42, fileIndex: components[1] === "snapshot.json" ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa" } };
          } };
      } }; } });
  let memory = makeMemory();
  cleanups.push(async () => { try { await memory.close(); } finally { repo.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  const event = { sender, senderFrame: sender.mainFrame } as any;
  async function user(id = "session-a", content = "I prefer PowerShell", messageId = "u1", at = 1000) {
    const message = { id: messageId, role: "user" as const, content };
    await memory.appendUser(event, id, message, () => { sessions.get(id).messages.push(message); });
    await store.append(id, { id: messageId, kind: "user", turnId: messageId, revision: 1, at, payload: { text: content } });
  }
  function input(id = "session-a", runId = "run-a"): FireflyRunOptions {
    return { settings: { ...config, contextWindowTokens: 128000 }, conversationId: id, conversationMode: sessions.get(id).mode, runId,
      transcriptSink: createTranscriptSink({ store, conversationId: id, runId, assistantTurnId: "assistant-" + runId }),
      messages: [{ role: "user", content: "caller history is not authority" }], timeoutMs: 5000, toolSystemContent: "", soulSystemBaseContent: "" };
  }
  const call = () => ({ adapter: getAdapterForConfig(config), config, request: { model: config.model, stream: false, messages: [{ role: "user" as const, content: "caller history is not authority" }] }, timeoutMs: 5000 });
  return { ...f, get memory() { return memory; }, runStore, sender, targets, event, settingsEvent, settingsWindow, sessions, settings, config, store, user, input, call, select, sent, sentSignals, historyCommands,
    pauseNatural: (operation?: string) => { pauseNaturalOperation = operation; }, restart: async () => { await memory.close(); memory = makeMemory(); },
    nativeFailure: (code: string) => { nativeError = code; }, unavailable: () => { unavailable = true; }, respond: (fn: typeof respond) => { respond = fn; },
    get opened() { return opened; }, get closed() { return closed; }, get nativeStarts() { return nativeStarts; } };
}

it("rejects forged desktop authority before opening storage or writing metadata", async () => {
  const f = await fixture(); let writes = 0;
  await expect(f.memory.appendUser({ ...f.event, senderFrame: {} }, "session-a", { id: "u", role: "user", content: "x" }, () => { writes++; })).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
  await expect(f.memory.openRun(f.input())).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
  expect(writes).toBe(0); expect(f.opened).toBe(0);
});

it.each(["chat", "work", "code"] as const)("runs ordinary %s through real SQLite S/M with the saved nondefault profile", async mode => {
  const f = await fixture(mode), before = JSON.stringify(f.settings); await f.user();
  const admission = f.memory.authorizeRun(f.event, "session-a")!;
  const input = f.input(), run = await f.memory.openRun(input);
  const sink = run.bindSink(input.transcriptSink!);
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  await sink.appendAssistant({ message: { role: "assistant", content: "synthetic answer" } });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toContain("I prefer PowerShell"); expect(f.sent[0]).toContain("openai/gpt-6-luna");
  expect(f.sent[0]).not.toContain("caller history is not authority");
  expect((await f.store.read("session-a")).entries.map(entry => entry.kind)).toEqual(["user", "assistant"]);
  expect(f.commands.some((command: any) => command.kind === "claim")).toBe(true);
  expect(f.nativeStarts).toBe(0); expect(JSON.stringify(f.settings)).toBe(before);
  await run.close(); admission.release(); await f.memory.close(); expect(f.opened).toBe(1); expect(f.closed).toBe(1);
});

it("rejects cloned or mismatched canonical sinks and missing saved profiles", async () => {
  const f = await fixture(); await f.user(); f.memory.authorizeRun(f.event, "session-a");
  const input = f.input();
  await expect(f.memory.openRun({ ...input, transcriptSink: { ...input.transcriptSink! } })).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  await expect(f.memory.openRun({ ...input, runId: "forged-run" })).rejects.toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  f.sessions.get("session-a").modelProfileId = "not-saved";
  await expect(f.memory.openRun(input)).rejects.toThrow("MEMORY_RUN_PROFILE_DENIED"); expect(f.sent).toHaveLength(0);
});

async function primeHistory(f:Awaited<ReturnType<typeof fixture>>,id='session-a'){
 f.select(id);const admission=f.memory.authorizeRun(f.event,id),run=await f.memory.openRun(f.input(id,'prime-'+crypto.randomUUID()));
 try{await run.call(f.call())}finally{await run.close();admission.release()}f.sent.length=0;
}
it("shares one backend between sessions and queries only other authorized history", async () => {
  const f = await fixture(); await f.user("session-a", "harbor prior discussion"); await f.store.checkpoint("session-a");
  await primeHistory(f);
  f.sessions.set("session-b", { id: "session-b", mode: "code", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "harbor current question"); f.memory.authorizeRun(f.event, "session-b");
  const input = f.input("session-b", "run-b"), run = await f.memory.openRun(input);
  await run.call(f.call()); await run.bindSink(input.transcriptSink!).appendAssistant({ message: { role: "assistant", content: "answer" } });
  expect(f.opened).toBe(1); expect(f.sent[0]).toContain("harbor prior discussion");
  const puts = f.historyCommands.filter(command => command.kind === "put");
  expect(puts.length).toBeGreaterThan(0); expect(JSON.stringify(puts)).not.toContain('"sessionId":"session-b"');
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "complete", selected: 1, covered: 1 });
});

it.each(["snapshot", "helper"])("reports missing %s with a counted coverage notice without repair or legacy fallback", async missing => {
  const f = await fixture(); await f.user("session-a", "harbor prior discussion");
  if (missing === "helper") { await f.store.checkpoint("session-a"); f.unavailable(); }
  const prior = fs.readFileSync(path.join(storage.dataRoot, "transcripts", "session-a", "transcript.jsonl"));
  f.sessions.set("session-b", { id: "session-b", mode: "work", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "harbor question"); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b"));
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  expect(f.sent[0]).toContain(missing === "snapshot" ? "MEMORY_HISTORY_COVERAGE_INSUFFICIENT" : "MEMORY_HISTORY_NATIVE_UNAVAILABLE");
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "insufficient", selected: 1, covered: 0 });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toContain("不能据此断言历史不存在"); expect(fs.readFileSync(path.join(storage.dataRoot, "transcripts", "session-a", "transcript.jsonl"))).toEqual(prior);
  if (missing === "snapshot") expect(fs.existsSync(path.join(storage.dataRoot, "transcripts", "session-a", "snapshot.json"))).toBe(false);
});

it("denies invalid attachment references before metadata commit", async () => {
  const f = await fixture(); let committed = false;
  await expect(f.memory.appendUser(f.event, "session-a", { id: "u", role: "user", content: "file", attachments: [{ id: "file" }] } as any, () => { committed = true; })).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
  expect(committed).toBe(false); expect(f.opened).toBe(0);
});

it("uses an existing saved default when legacy settings omit the default ID, without writing settings", async () => {
  const f = await fixture(); await f.user(); delete f.sessions.get("session-a").modelProfileId; delete f.settings.defaultModelProfileId;
  const before = JSON.stringify(f.settings); f.memory.authorizeRun(f.event, "session-a");
  const run = await f.memory.openRun(f.input()); expect(JSON.stringify(f.settings)).toBe(before); await run.close();
});

it("navigation and admission release revoke runs without accepting a replacement plain signal", async () => {
  const f = await fixture(); await f.user(); const admission = f.memory.authorizeRun(f.event, "session-a");
  const run = await f.memory.openRun(f.input()); f.targets.clearActive(f.sender as any); f.memory.refresh();
  expect(admission.signal.aborted).toBe(true);
  await expect(run.call(f.call())).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  await expect(f.memory.openRun({ ...f.input(), signal: new AbortController().signal })).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
  expect(f.sent).toHaveLength(0); await run.close(); admission.release();
  f.select(); const second = f.memory.authorizeRun(f.event, "session-a"); const next = await f.memory.openRun(f.input("session-a", "run-next"));
  second.release(); await expect(next.call(f.call())).rejects.toThrow("MEMORY_CONTEXT_CANCELLED"); await next.close();
});

it.each(["edit", "delete"])("%s invalidates the previous source and run before metadata mutation", async mutation => {
  const f = await fixture(); await f.user(); const admission = f.memory.authorizeRun(f.event, "session-a");
  const run = await f.memory.openRun(f.input()); let committed = false;
  await f.memory.mutate(f.event, "session-a", ["u1"], () => {
    expect(admission.signal.aborted).toBe(true);
    expect(f.commands.some(command => command.kind === "reserve")).toBe(true);
    committed = true;
    if (mutation === "edit") f.sessions.get("session-a").messages[0].content = "changed";
    else f.sessions.get("session-a").messages = [];
  });
  expect(committed).toBe(true); await expect(run.call(f.call())).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  expect(f.sent).toHaveLength(0);
});

it("fails closed while a second run would contend for the canonical session observer", async () => {
  const f = await fixture(); await f.user(); f.memory.authorizeRun(f.event, "session-a");
  const first = await f.memory.openRun(f.input());
  await expect(f.memory.openRun(f.input("session-a", "run-b"))).rejects.toThrow("MEMORY_CONTEXT_RUN_ACTIVE");
  await first.close(); const next = await f.memory.openRun(f.input("session-a", "run-c")); await next.close();
});

it("publishes one close promise before synchronous cancellation callbacks can reenter", async () => {
  const f = await fixture(); await f.user(); const admission = f.memory.authorizeRun(f.event, "session-a");
  let reentrant: Promise<void> | undefined;
  admission.signal.addEventListener("abort", () => { reentrant = f.memory.close(); }, { once: true });
  const closing = f.memory.close(); expect(reentrant).toBe(closing); await closing; expect(f.closed).toBe(1);
});

it("waits for the actual pending provider settlement before closing the backend", async () => {
  const f = await fixture(); await f.user(); f.memory.authorizeRun(f.event, "session-a");
  const input = f.input(), run = await f.memory.openRun(input), sink = run.bindSink(input.transcriptSink!);
  let arrived!: () => void, finish!: (response: Response) => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  f.respond(async () => { arrived(); return pending; });
  const call = run.call(f.call()); const rejection = expect(call).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  await started; let acknowledged = false;
  const closing = f.memory.close().then(() => { acknowledged = true; });
  await new Promise<void>(setImmediate); expect(f.closed).toBe(0); expect(acknowledged).toBe(false);
  await expect(sink.appendAssistant({ message: { role: "assistant", content: "late" } })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  finish(Response.json({ choices: [{ message: { role: "assistant", content: "late" }, finish_reason: "stop" }] }));
  await rejection; await closing; expect(f.closed).toBe(1);
  expect((await f.store.read("session-a")).entries.map(entry => entry.kind)).toEqual(["user"]);
});

it("reports an exhausted history excerpt budget as an incomplete result, not as complete coverage", async () => {
  const f = await fixture(); await f.user("session-a", "harbor " + "x".repeat(7000)); await f.store.checkpoint("session-a");
  await primeHistory(f);
  f.sessions.set("session-b", { id: "session-b", mode: "code", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "harbor current question"); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b"));
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "insufficient", selected: 1, covered: 1, retrieval: "excerpt-budget-exhausted" });
  expect(f.memory.getHistoryCoverage("session-b").diagnostics).toContain("MEMORY_HISTORY_EXCERPT_BUDGET_EXHAUSTED");
  expect(f.sent[0]).toContain("历史检索结果不完整"); expect(f.sent[0]).toContain("MEMORY_HISTORY_EXCERPT_BUDGET_EXHAUSTED"); expect(f.sent[0]).toContain("不能据此断言历史不存在");
  await run.close();
});

it("returns a labelled excerpt of an oversized earlier conversation instead of dropping it, and tells the model it is partial", async () => {
  const f = await fixture(); await f.user("session-a", "start of an old discussion", "ua");
  for (let i = 1; i < 20; i++) { const admission=f.memory.authorizeRun(f.event,"session-a"),input=f.input("session-a","old-run-"+i),run=await f.memory.openRun(input); await run.call(f.call()); await run.bindSink(input.transcriptSink!).appendAssistant({message:{role:"assistant",content:(i===9?"zebra passport ":"filler "+i+" ")+"y".repeat(700)}}); await run.close();admission.release(); } f.sent.length=0;
  await f.store.checkpoint("session-a");
  f.sessions.set("session-b", { id: "session-b", mode: "code", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "zebra passport question", "ub"); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b"));
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  const request = f.sent[0];
  expect(request).toContain("zebra passport");
  expect(request).toContain("totalMessages"); expect(request).toContain("firstMessage"); expect(request).toContain("zebra passport");
  expect(request).not.toContain("filler 2 "); expect(request).not.toContain("filler 17 ");
  expect(request).toContain("并非完整会话"); expect(request).toContain("不能据此断言片段之外没有相关内容");
  expect(request).not.toContain("历史检索结果不完整");
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "complete", selected: 1, covered: 1, retrieval: "complete", excerpted: 1 });
  await run.close();
});

async function twoDatedSessions(f: Awaited<ReturnType<typeof fixture>>, question: string) {
  const day = 86_400_000, now = Date.now();
  await f.user("session-a", "harbor recent plan", "ua", now - day); await f.store.checkpoint("session-a");
  await primeHistory(f);
  f.sessions.set("session-c", { id: "session-c", mode: "chat", messages: [], modelProfileId: "luna" }); f.select("session-c");
  await f.user("session-c", "harbor old plan", "uc", now - 10 * day); await f.store.checkpoint("session-c");
  await primeHistory(f,'session-c');
  f.sessions.set("session-b", { id: "session-b", mode: "code", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", question, "ub", now); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b")); await run.call(f.call()); await run.close();
  return f.sent[0];
}

it("limits history retrieval to the time window the user asked for and says so", async () => {
  const f = await fixture(), request = await twoDatedSessions(f, "最近3天 harbor current question");
  expect(request).toContain("harbor recent plan"); expect(request).not.toContain("harbor old plan");
  expect(request).toContain("已按时间限定检索历史"); expect(request).toContain("过去 3 天");
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "complete", temporal: "applied" });
});

it("retrieves across all time and sends no time notice when the question has no time intent", async () => {
  const f = await fixture(), request = await twoDatedSessions(f, "harbor current question");
  expect(request).toContain("harbor recent plan"); expect(request).toContain("harbor old plan");
  expect(request).not.toContain("已按时间限定检索历史");
  expect(f.memory.getHistoryCoverage("session-b").temporal).toBeUndefined();
});

it("does not guess when the question names two different time windows", async () => {
  const f = await fixture(), request = await twoDatedSessions(f, "昨天和上周 harbor current question");
  expect(request).toContain("harbor old plan"); expect(request).not.toContain("已按时间限定检索历史");
});

it("keeps complete coverage and sends no incomplete-result notice when the history fits its budgets", async () => {
  const f = await fixture(); await f.user("session-a", "harbor prior discussion"); await f.store.checkpoint("session-a");
  await primeHistory(f);
  f.sessions.set("session-b", { id: "session-b", mode: "code", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "harbor current question"); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b")); await run.call(f.call());
  expect(f.memory.getHistoryCoverage("session-b")).toMatchObject({ status: "complete", selected: 1, covered: 1, retrieval: "complete" });
  expect(f.sent[0]).not.toContain("历史检索结果不完整");
  await run.close();
});

it("refreshes coverage diagnostics when a retry fails for a different verified reason", async () => {
  const f = await fixture(); await f.user("session-a", "harbor prior discussion");
  f.sessions.set("session-b", { id: "session-b", mode: "work", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "harbor question"); f.memory.authorizeRun(f.event, "session-b");
  const run = await f.memory.openRun(f.input("session-b", "run-b"));
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  expect(f.memory.getHistoryCoverage("session-b").diagnostics).toContain("MEMORY_HISTORY_SNAPSHOT_MISSING");
  await f.store.checkpoint("session-a"); f.unavailable();
  await expect(run.call(f.call())).resolves.toMatchObject({ text: "synthetic answer" });
  expect(f.memory.getHistoryCoverage("session-b").diagnostics).toContain("MEMORY_HISTORY_NATIVE_UNAVAILABLE");
  expect(f.memory.getHistoryCoverage("session-b").diagnostics).not.toContain("MEMORY_HISTORY_SNAPSHOT_MISSING");
});

it.each(['false','throw'])('retries a definitely uncommitted synchronous append after %s without minting provenance',async outcome=>{
 const f=await fixture(),message={id:'retry-user',role:'user' as const,content:'I prefer bash'};
 const attempt=f.memory.appendUser(f.event,'session-a',message,()=>{if(outcome==='throw')throw Error('synthetic-write-failure');return false});
 if(outcome==='throw')await expect(attempt).rejects.toThrow('synthetic-write-failure');else await expect(attempt).resolves.toBe(false);
 expect(f.commands.filter(command=>command.kind==='finish')).toHaveLength(0);
 await expect(f.memory.appendUser(f.event,'session-a',message,()=>{f.sessions.get('session-a').messages.push(message);return true})).resolves.toBe(true);
 expect(f.sessions.get('session-a').messages).toEqual([message]);
});

async function adjustment(f: Awaited<ReturnType<typeof fixture>>, options: { sessionId?: string; runId?: string; failure?: 'false' | 'throw' } = {}) {
 const { createRunAdjustmentPoller } = await import('../chats/pending-adjustment');
 const sessionId=options.sessionId??'session-a', runId=options.runId??'run-a';
 let failure=options.failure;
 const queue=[{id:'adjust-user',rawContent:'I prefer fish',visibleContent:'I prefer fish',enqueuedAt:1001,adjustRunId:runId}];
 const poller=createRunAdjustmentPoller(sessionId,runId,{
  getPendingMessages:id=>id===sessionId?structuredClone(queue):null,
  commitPendingAdjust(id,messageId,currentRun){
   if(failure==='false')return {ok:false,error:'write-failed'};
   if(failure==='throw')throw Error('synthetic-adjust-write-failure');
   const item=queue.find(item=>item.id===messageId&&item.adjustRunId===currentRun);
   if(!item||id!==sessionId)return {ok:false,error:'not-found'};
   f.sessions.get(id).messages.push({id:messageId,role:'user',content:item.rawContent});queue.splice(queue.indexOf(item),1);
   return {ok:true,userMessage:{id:messageId},remainingQueue:structuredClone(queue)};
  },
 },{appendUser:async ({turnId,text})=>{await f.store.append(sessionId,{id:`user:v1:${turnId}:r1`,kind:'user',turnId,revision:1,at:1001,payload:{text}})}});
 return {poller,queue,recover(){failure=undefined}};
}
async function completeToolRound(f: Awaited<ReturnType<typeof fixture>>,run: Awaited<ReturnType<typeof f.memory.openRun>>,input:FireflyRunOptions){
 const sink=run.bindSink(input.transcriptSink!);await run.call(f.call());
 const assistantEntryId=await sink.appendAssistant({roundId:'r1',message:{role:'assistant',content:'checking',toolCalls:[{id:'tool-one',name:'lookup',arguments:'{}'}]}});
 await sink.appendToolResult({assistantEntryId,roundId:'r1',message:{role:'tool',toolCallId:'tool-one',content:'done'},outcome:'success'});
 return sink;
}
it.each(['work','code'] as const)('admits a genuine %s adjustment with committed direct-user provenance before the next counted round',async mode=>{
 const f=await fixture(mode);await f.user('session-a','baseline question');f.memory.authorizeRun(f.event,'session-a');
 const a=await adjustment(f),input={...f.input(),pollRunAdjustments:a.poller},run=await f.memory.openRun(input);
 const sink=await completeToolRound(f,run,input);
 await expect(a.poller()).resolves.toEqual([{id:'adjust-user',rawContent:'I prefer fish'}]);
 expect(a.queue).toHaveLength(0);
 await expect(run.call(f.call())).resolves.toMatchObject({text:'synthetic answer'});
 await sink.appendAssistant({roundId:'r2',message:{role:'assistant',content:'adjusted answer'}});
 expect(f.sent).toHaveLength(2);expect(f.sent[1]).toContain('I prefer fish');
 const observation=f.commands.filter(command=>command.kind==='finish').map(command=>command.body.observation).find(observation=>observation.messageId==='adjust-user');
 expect(observation).toMatchObject({role:'user',trust:'direct-user-event',contentRevision:1});
 expect((await f.store.read('session-a')).entries.filter(entry=>entry.kind==='user'&&entry.turnId==='adjust-user')).toHaveLength(1);
});
it.each(['false','throw'] as const)('retains the pending adjustment after history %s without rolling back its canonical user',async failure=>{
 const f=await fixture('work');await f.user('session-a','baseline question');f.memory.authorizeRun(f.event,'session-a');
 const a=await adjustment(f,{failure}),input={...f.input(),pollRunAdjustments:a.poller},run=await f.memory.openRun(input);await completeToolRound(f,run,input);
 await expect(a.poller()).rejects.toThrow();expect(a.queue).toHaveLength(1);
 expect(f.sessions.get('session-a').messages.some((message:any)=>message.id==='adjust-user')).toBe(false);
 expect((await f.store.read('session-a')).entries.filter(entry=>entry.kind==='user'&&entry.turnId==='adjust-user')).toHaveLength(1);
 a.recover();await expect(a.poller()).resolves.toEqual([{id:'adjust-user',rawContent:'I prefer fish'}]);
 await expect(run.call(f.call())).resolves.toMatchObject({text:'synthetic answer'});
 expect((await f.store.read('session-a')).entries.filter(entry=>entry.kind==='user'&&entry.turnId==='adjust-user')).toHaveLength(1);
});
it.each(['forged','session','run'])('rejects a %s adjustment poller before it can acquire a source transaction',async kind=>{
 const f=await fixture('work');await f.user();f.memory.authorizeRun(f.event,'session-a');
 const a=await adjustment(f,{...(kind==='session'?{sessionId:'other'}:{}),...(kind==='run'?{runId:'other'}:{})});
 const poller=kind==='forged'?()=>a.poller():a.poller;
 await expect(f.memory.openRun({...f.input(),pollRunAdjustments:poller})).rejects.toThrow(/MEMORY_.*ADJUSTMENT/);
 expect(a.queue).toHaveLength(1);expect(f.sent).toHaveLength(0);
});
it('does not promote an ordinary canonical append into a trusted same-run user adjustment',async()=>{
 const f=await fixture('work');await f.user('session-a','baseline question');f.memory.authorizeRun(f.event,'session-a');
 const a=await adjustment(f),input={...f.input(),pollRunAdjustments:a.poller},run=await f.memory.openRun(input);await completeToolRound(f,run,input);
 await f.store.append('session-a',{id:'untrusted-append',kind:'user',turnId:'untrusted-user',revision:1,payload:{text:'untrusted new user'}});
 await expect(a.poller()).rejects.toThrow(/MEMORY_CONTEXT_/);expect(a.queue).toHaveLength(1);
 await expect(run.call(f.call())).rejects.toThrow(/MEMORY_CONTEXT_/);expect(f.sent).toHaveLength(1);
});

it('keeps written metadata and refuses to reuse its source admission when the callback throws after writing',async()=>{
 const f=await fixture(),message={id:'written-user',role:'user' as const,content:'I prefer bash'};
 await expect(f.memory.appendUser(f.event,'session-a',message,()=>{f.sessions.get('session-a').messages.push(message);throw Error('after-write-failure')})).rejects.toThrow('after-write-failure');
 expect(f.sessions.get('session-a').messages).toEqual([message]);
 await expect(f.memory.appendUser(f.event,'session-a',message,()=>true)).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');
 expect(f.commands.filter(command=>command.kind==='finish')).toHaveLength(0);
});
it('a closed memory run never lets its enrolled poller fall back to unguarded queue consumption',async()=>{
 const f=await fixture('work');await f.user();f.memory.authorizeRun(f.event,'session-a');
 const a=await adjustment(f),run=await f.memory.openRun({...f.input(),pollRunAdjustments:a.poller});
 await run.close();await expect(Promise.resolve().then(a.poller)).rejects.toThrow(/MEMORY_.*ADJUSTMENT/);
 expect(a.queue).toHaveLength(1);expect(f.sessions.get('session-a').messages).toHaveLength(1);
 expect((await f.store.read('session-a')).entries).toHaveLength(1);
});

async function candidate(f:Awaited<ReturnType<typeof fixture>>,text='I prefer English'){
 const {createMainActorAuthority}=await import('../memory-core/main-actor-authority');
 const {createMainSourceRegistry}=await import('../memory-sources/source-registry');
 const {createMainSourceProvider}=await import('../memory-sources/main-source-provider');
 const {createMainPolicy}=await import('../memory-policy/main-policy');
 const actorAuthority=createMainActorAuthority({resolveActor:()=> 'desktop-local-user-v1'});
 const registry=createMainSourceRegistry(f.transport,{coordinate:actorAuthority.coordinate}),access=registry.authority.access('desktop-local-profile-v1');
 const identity={providerId:'desktop-chat-user-v1',sessionId:'historical-candidate-session',messageId:'history-user'};
 const source=createMainSourceProvider({providerId:identity.providerId,authorize:(scope,id)=>scope==='desktop-local-profile-v1'&&id.sessionId===identity.sessionId,
  withLease:async(_id,operation)=>operation(async()=>({...identity,role:'user',trust:'history',state:'live',text,generation:'history-generation',contentRevision:1,occurredAt:1000}))});
 const actor=actorAuthority.bindActor(access,source,identity),policy=createMainPolicy({actorAuthority,registry,transport:f.transport,resolveActor:()=> 'desktop-local-user-v1'});
 const ref=await registry.capture(access,source,identity),outcome=await policy.ingest(actor,ref);
 expect(outcome.status).toBe('candidate');return {ref,outcome,contentHash:(await policy.candidates(actor,{limit:10})).items[0].contentHash};
}
it('settings host refuses a foreign window before opening backend resources',async()=>{
 const f=await fixture();
 await expect(f.memory.settingsHost.getState(f.event)).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');
 await expect(f.memory.settingsHost.applyAction(f.event,{kind:'forget',id:'fact',expectedRevision:1})).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');
 expect(f.opened).toBe(0);
});
it('settings host refuses reference-only content before persisting a confirmation event',async()=>{
 const f=await fixture(),c=await candidate(f,'帮我检查这个函数');
 const state=await f.memory.settingsHost.getState(f.settingsEvent),item=state.candidates[0];
 expect(item).toMatchObject({reviewState:'reference-only',assertion:'',occurredAt:1000});
 const count=(await f.store.read('memory-settings-user-events-v1')).throughSeq;
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:1,contentHash:item.contentHash})).rejects.toThrow('MEMORY_POLICY_UNRESOLVED');
 expect((await f.store.read('memory-settings-user-events-v1')).throughSeq).toBe(count);
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toEqual([]);
});
it.each([undefined,'0'.repeat(64)])('settings host requires the matching displayed content hash before persisting a ready confirmation: %s',async contentHash=>{
 const f=await fixture(),c=await candidate(f),count=(await f.store.read('memory-settings-user-events-v1')).throughSeq;
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:1,contentHash})).rejects.toThrow('MEMORY_CONFIRMATION_STALE');
 expect((await f.store.read('memory-settings-user-events-v1')).throughSeq).toBe(count);
});
it.each(['', ' \n\t'])('settings host rejects blank ready projections without writing an event: %j',async assertion=>{
 const f=await fixture(),c=await candidate(f),original=f.transport.policyCommand;
 // Simulate a malformed boundary response; the host must not rely on renderer or worker readiness alone.
 f.transport.policyCommand=async command=>{
  const result=await original(command);
  return (command as any).kind==='candidates'?(result as any[]).map(item=>({...item,reviewState:'ready',assertion})):result;
 };
 const count=(await f.store.read('memory-settings-user-events-v1')).throughSeq;
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:1,contentHash:c.contentHash})).rejects.toThrow('MEMORY_POLICY_UNRESOLVED');
 expect((await f.store.read('memory-settings-user-events-v1')).throughSeq).toBe(count);
});
it('settings confirmation creates an independent canonical direct-user support and reuses the single backend',async()=>{
 const f=await fixture(),c=await candidate(f),before=await f.memory.settingsHost.getState(f.settingsEvent);
 expect(before.candidates).toHaveLength(1);expect(before.coverage.status).toBe('not-measured');
 const action={kind:'confirm' as const,id:c.outcome.candidateId!,expectedRevision:c.outcome.candidateRevision!,contentHash:c.contentHash};
 const [first,second]=await Promise.all([f.memory.settingsHost.applyAction(f.settingsEvent,action),f.memory.settingsHost.applyAction(f.settingsEvent,{...action})]);
 expect(first).toEqual(second);expect(first.status).toBe('active');
 const audit=await f.memory.settingsHost.auditSource(f.settingsEvent,first.factId!);
 expect(audit.sources).toHaveLength(1);expect(audit.sources[0]).toMatchObject({kind:'explicitUserConfirmed',validity:'valid'});
 expect(audit.sources[0].sourceId).not.toBe(c.ref.sourceId);
 const settingsSources=f.commands.filter(command=>command.kind==='finish'&&command.body.observation.sessionId==='memory-settings-user-events-v1');
 expect(new Set(settingsSources.map(command=>command.body.observation.messageId)).size).toBe(1);
 expect((await f.store.read('memory-settings-user-events-v1')).entries).toHaveLength(1);
 const after=await f.memory.settingsHost.getState(f.settingsEvent);expect(after.facts).toHaveLength(1);expect(after.candidates).toEqual([]);expect(f.opened).toBe(1);
 await f.user('session-a','Which language do I prefer?');f.memory.authorizeRun(f.event,'session-a');
 const run=await f.memory.openRun(f.input());await run.call(f.call());
 expect(f.sent[0]).toContain('I prefer English');expect(f.nativeStarts).toBe(0);expect(f.opened).toBe(1);
});
it('settings correction and forget update real policy revisions; stale submissions create no new source event',async()=>{
 const f=await fixture(),c=await candidate(f),confirmed=await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:1,contentHash:c.contentHash});
 const corrected=await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'correct',id:confirmed.factId!,expectedRevision:confirmed.factRevision!,text:'I prefer Chinese'});
 expect(corrected).toMatchObject({status:'active',factRevision:2});
 const count=(await f.store.read('memory-settings-user-events-v1')).throughSeq;
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'correct',id:confirmed.factId!,expectedRevision:1,text:'I prefer English'})).rejects.toThrow('MEMORY_REVISION_CONFLICT');
 expect((await f.store.read('memory-settings-user-events-v1')).throughSeq).toBe(count);
 const state=await f.memory.settingsHost.getState(f.settingsEvent);expect(state.facts[0]).toMatchObject({assertion:'I prefer Chinese',revision:2});
 expect(await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'forget',id:confirmed.factId!,expectedRevision:2})).toMatchObject({status:'forgotten'});
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toEqual([]);
 expect((await f.memory.settingsHost.auditSource(f.settingsEvent,confirmed.factId!)).status).toBe('forgotten');
});
it.each(['session-a','session-b'])('keeps authorized S and remaining M usable in %s after forget without reacquiring unbound history',async id=>{
 const f=await fixture();await f.user('session-a','I prefer PowerShell');
 const admission=f.memory.authorizeRun(f.event,'session-a'),first=await f.memory.openRun(f.input());
 await first.call(f.call());await first.close();admission.release();await f.store.checkpoint('session-a');
 const c=await candidate(f,'I prefer English');
 await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:c.outcome.candidateRevision!,contentHash:c.contentHash});
 const state=await f.memory.settingsHost.getState(f.settingsEvent),forgotten=state.facts.find(fact=>fact.assertion==='I prefer PowerShell')!;
 expect(forgotten).toBeDefined();
 await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'forget',id:forgotten.factId,expectedRevision:forgotten.revision});
 if(id==='session-b')f.sessions.set(id,{id,mode:'chat',messages:[],modelProfileId:'luna'});f.select(id);
 await f.user(id,'Which language do I prefer?','current-user');f.memory.authorizeRun(f.event,id);
 const reads=f.nativeStarts,puts=f.historyCommands.filter(command=>command.kind==='put').length;
 const input=f.input(id,'after-forget'),run=await f.memory.openRun(input);
 await expect(run.call(f.call())).resolves.toMatchObject({text:'synthetic answer'});
 const request=f.sent.at(-1)!;
 expect(request).toContain('Which language do I prefer?');expect(request).toContain('I prefer English');
 expect(request).not.toContain('I prefer PowerShell');if(id==='session-b')expect(request).toContain('MEMORY_HISTORY_ORIGIN_UNPROVEN');
 expect(f.nativeStarts).toBeGreaterThanOrEqual(reads);expect(f.historyCommands.filter(command=>command.kind==='put')).toHaveLength(puts);
 if(id==='session-b')expect(f.memory.getHistoryCoverage(id)).toMatchObject({status:'insufficient',selected:1,covered:0});
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts.map(fact=>fact.assertion)).toEqual(['I prefer English']);
 await run.bindSink(input.transcriptSink!).appendAssistant({message:{role:'assistant',content:'new permitted answer'}});await run.close();
 await f.user(id,'Continue our new conversation','next-user');
 const next=await f.memory.openRun(f.input(id,'next-after-forget'));await next.call(f.call());
 expect(f.sent.at(-1)).toContain('new permitted answer');expect(f.sent.at(-1)).not.toContain('I prefer PowerShell');await next.close();
});
it('settings reject retains historical source data and cannot accept injected actors or source references',async()=>{
 const f=await fixture(),c=await candidate(f);
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:1,sourceRef:c.ref} as any)).rejects.toThrow('MEMORY_INPUT_INVALID');
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'confirm',id:c.outcome.candidateId!,expectedRevision:2})).rejects.toThrow('MEMORY_REVISION_CONFLICT');
 expect((await f.store.read('memory-settings-user-events-v1')).entries).toEqual([]);
 expect(await f.memory.settingsHost.applyAction(f.settingsEvent,{kind:'reject',id:c.outcome.candidateId!,expectedRevision:1})).toMatchObject({status:'rejected'});
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).candidates).toEqual([]);
});

it('does not retain a failed settings submission or its correction text as a permanent idempotency key',async()=>{
 const f=await fixture(),c=await candidate(f),action={kind:'confirm' as const,id:c.outcome.candidateId!,expectedRevision:1,contentHash:c.contentHash};
 const pending=f.memory.settingsHost.applyAction(f.settingsEvent,action);f.settingsWindow.isDestroyed=()=>true;
 await expect(pending).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');f.settingsWindow.isDestroyed=()=>false;
 await expect(f.memory.settingsHost.applyAction(f.settingsEvent,action)).resolves.toMatchObject({status:'active'});
});

it.each(['MEMORY_ACTOR_DENIED','MEMORY_HISTORY_STALE','synthetic private native error'])('never downgrades %s into partial coverage or sends an unverified request',async error=>{
 const f=await fixture();await f.user('session-a','harbor prior discussion');await f.store.checkpoint('session-a');f.nativeFailure(error);
 f.sessions.set('session-b',{id:'session-b',mode:'work',messages:[],modelProfileId:'luna'});f.select('session-b');
 await f.user('session-b','harbor question');f.memory.authorizeRun(f.event,'session-b');
 const run=await f.memory.openRun(f.input('session-b','run-b'));
 await expect(run.call(f.call())).rejects.toThrow(/MEMORY_/);expect(f.sent).toHaveLength(0);
});
it('injects the actual saved model budget into the production summary path',async()=>{
 const f=await fixture();f.settings.contextWindowTokens=16000;
 await f.user('session-a','older statement '.repeat(5000),'old-user');
 await f.store.append('session-a',{id:'old-assistant',kind:'assistant',turnId:'old-assistant',runId:'old-run',payload:{role:'assistant',content:'older response '.repeat(5000)}});
 await f.user('session-a','retained historical question','middle-user');
 await f.store.append('session-a',{id:'middle-assistant',kind:'assistant',turnId:'middle-assistant',runId:'middle-run',payload:{role:'assistant',content:'retained historical answer'}});
 await f.user('session-a','current canonical question','new-user');f.memory.authorizeRun(f.event,'session-a');
 const run=await f.memory.openRun(f.input());await run.call(f.call());
 expect(f.commands.some(command=>command.kind==='summaryCommit')).toBe(true);
 expect(f.sent[0]).toContain('current canonical question');expect(f.sent[0].length).toBeLessThan(50000);
});

it('model settings refresh revokes a changed in-flight grant immediately and waits for real provider settlement',async()=>{
 const f=await fixture();await f.user();f.memory.authorizeRun(f.event,'session-a');
 const run=await f.memory.openRun(f.input());let arrive!:()=>void,release!:(response:Response)=>void;
 const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<Response>(resolve=>{release=resolve});
 f.respond(async()=>{arrive();return held});
 const pending=run.call(f.call()),outcome=pending.then(()=>null,error=>error);
 try{
  await arrived;expect(f.sentSignals[0].aborted).toBe(false);
  f.memory.refreshModels();expect(f.sentSignals[0].aborted).toBe(false);
  f.settings.modelProfiles!.push({id:'unrelated',...f.config,model:'other-model'});
  f.memory.refreshModels();expect(f.sentSignals[0].aborted).toBe(false);
  f.settings.modelProfiles![0].apiKey='rotated-synthetic-only';f.memory.refreshModels();
  expect(f.sentSignals[0].aborted).toBe(true);
  const closing=f.memory.close();await new Promise<void>(setImmediate);expect(f.closed).toBe(0);
  release(Response.json({choices:[{message:{role:'assistant',content:'late'},finish_reason:'stop'}]}));
  expect(await outcome).toMatchObject({message:'MEMORY_CONTEXT_CANCELLED'});await closing;expect(f.closed).toBe(1);
 }finally{release(Response.json({choices:[{message:{role:'assistant',content:'cleanup'},finish_reason:'stop'}]}));await pending.catch(()=>undefined)}
});

async function channelAccount(accountKey='qq:account-a'){
 const {ChannelManager}=await import('../channels/manager');
 const {createChannelMemoryAccountIdentity}=await import('../channels/adapters/base');
 const {markChannelTextTransform,requireChannelMemoryIngress}=await import('./channel-memory-ingress');
 const identity=createChannelMemoryAccountIdentity();identity.authenticate(accountKey);
 const adapter:import('../channels/adapters/base').ChannelAdapter={id:'qq',displayName:'synthetic',capability:{} as never,onMessage:null,
  start:async()=>{},stop:async()=>{},send:async()=>({ok:true}),getMemoryAccountIdentity:identity.read,getStatus:()=>({enabled:true,phase:'running'})};
 const manager=new ChannelManager();manager.register(adapter);let cap:import('./channel-memory-ingress').ChannelMemoryIngress|undefined;
 manager.setDispatcher(async(_message,ingress)=>{cap=ingress;return null});await manager.startOne('qq');
 cleanups.push(()=>manager.stopAll());
 return {manager,identity,async receive(patch:Partial<import('../channels/types').IncomingMessage>={},asr=false){
  const message:import('../channels/types').IncomingMessage={channel:'qq',senderId:'sender-one',chatId:'chat-one',text:'I prefer bash',at:new Date(1700000000000),...patch};
  if(asr)markChannelTextTransform(message,'asr');cap=undefined;await adapter.onMessage!(message);
  return {message,cap:cap!,context:requireChannelMemoryIngress(cap,message)};
 }};
}
async function preparedChannel(f:Awaited<ReturnType<typeof fixture>>,event:Awaited<ReturnType<Awaited<ReturnType<typeof channelAccount>>['receive']>>,suffix='channel-run'){
 const {formatChannelUserText}=await import('../channels/channel-context');
 const prepared=await f.memory.channelHost.prepareRun({ingress:event.cap,message:event.message,userText:formatChannelUserText(event.message),modelProfileId:'luna',runId:suffix,userTurnId:'user-'+suffix,assistantTurnId:'assistant-'+suffix});
 const input={...f.input(),conversationId:prepared.sessionId,runId:suffix,transcriptSink:prepared.transcriptSink,signal:prepared.signal,conversationMode:'work' as const};
 const run=await prepared.openMemoryRun(input);return {prepared,input,run,sink:run.bindSink(prepared.transcriptSink)};
}
it('channel host requires a genuine matching ingress before opening shared storage',async()=>{
 const f=await fixture(),account=await channelAccount(),event=await account.receive();
 const input={ingress:{...event.cap},message:event.message,userText:event.message.text,modelProfileId:'luna',runId:'channel-run',userTurnId:'channel-user',assistantTurnId:'channel-assistant'};
 await expect(f.memory.channelHost.prepareRun(input as any)).rejects.toThrow('MEMORY_CHANNEL_INGRESS_DENIED');
 await expect(f.memory.channelHost.prepareRun({...input,ingress:event.cap,message:{...event.message}} as any)).rejects.toThrow('MEMORY_CHANNEL_INGRESS_DENIED');
 expect(f.opened).toBe(0);expect(f.sent).toHaveLength(0);
});
it('shares desktop/settings/channel resources while real account, sender and group tuples retain separate M scopes',async()=>{
 const f=await fixture();await f.user('session-a','I prefer PowerShell');
 const a=await channelAccount(),b=await channelAccount('qq:account-b'),firstEvent=await a.receive(),first=await preparedChannel(f,firstEvent,'first');
 await first.run.call(f.call());await first.sink.appendAssistant({message:{role:'assistant',content:'first answer'},roundId:'r1'});await first.prepared.close();
 expect(f.repo.current(firstEvent.context.scopeKey).map(fact=>fact.assertion)).toEqual(['I prefer bash']);
 const cases=[await b.receive({text:'What is my shell?'}),await a.receive({senderId:'another-sender',text:'What is my shell?'}),await a.receive({chatType:'group',chatId:'group-two',text:'What is my shell?'})];
 for(const [index,event] of cases.entries()){
  const next=await preparedChannel(f,event,'isolated-'+index);await next.run.call(f.call());
  expect(f.sent.at(-1)).not.toContain('I prefer bash');expect(f.sent.at(-1)).not.toContain('I prefer PowerShell');
  expect(f.repo.current(event.context.scopeKey)).toEqual([]);await next.prepared.close();
 }
 expect(f.opened).toBe(1);expect(f.nativeStarts).toBe(0);
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toEqual([]);
});
it('channel canonical tool rounds retain one direct M statement and use the real guarded sink',async()=>{
 const f=await fixture(),a=await channelAccount(),event=await a.receive(),p=await preparedChannel(f,event);
 await p.run.call(f.call());
 const assistantEntryId=await p.sink.appendAssistant({roundId:'r1',message:{role:'assistant',content:'checking',toolCalls:[{id:'channel-tool',name:'lookup',arguments:'{}'}]}});
 await p.sink.appendToolResult({assistantEntryId,roundId:'r1',message:{role:'tool',toolCallId:'channel-tool',content:'canonical channel result'},outcome:'success'});
 await p.run.call(f.call());await p.sink.appendAssistant({roundId:'r2',message:{role:'assistant',content:'done'}});
 expect(f.sent).toHaveLength(2);expect(f.sent[1]).toContain('canonical channel result');
 expect(f.repo.current(event.context.scopeKey)).toMatchObject([{assertion:'I prefer bash',revision:1}]);
 expect((await f.store.read(event.context.sessionId)).entries.map(entry=>entry.kind)).toEqual(['user','assistant','tool_result','assistant']);
 await expect(p.prepared.openMemoryRun(p.input)).rejects.toThrow(/MEMORY_.*RUN/);await p.prepared.close();
});
it.each(['asr','quote'] as const)('keeps %s channel content in S with an explicit limited-memory notice and no M promotion',async kind=>{
 const f=await fixture(),a=await channelAccount(),event=await a.receive(kind==='quote'?{chatType:'group',reply:{messageId:'q',senderId:'other',text:'I prefer PowerShell'}}:{},kind==='asr');
 const p=await preparedChannel(f,event);await p.run.call(f.call());
 expect(f.sent[0]).toContain('I prefer bash');expect(f.sent[0]).toContain('MEMORY_CHANNEL_SOURCE_LIMITED');
 expect(f.repo.current(event.context.scopeKey)).toEqual([]);
 expect(f.commands.filter(command=>command.kind==='integrate'&&command.scopeKey===event.context.scopeKey)).toHaveLength(0);
});
it('channel stop aborts the actual pending model request and prepared.close awaits its settlement',async()=>{
 const f=await fixture(),a=await channelAccount(),event=await a.receive(),p=await preparedChannel(f,event);
 let arrive!:()=>void,release!:(value:Response)=>void;const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<Response>(resolve=>{release=resolve});
 f.respond(async()=>{arrive();return held});const calling=p.run.call(f.call()),outcome=calling.then(()=>null,error=>error);
 try{
  await arrived;await a.manager.stopAll();expect(p.prepared.signal.aborted).toBe(true);expect(f.sentSignals[0].aborted).toBe(true);
  let closed=false;const closing=p.prepared.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);
  release(Response.json({choices:[{message:{role:'assistant',content:'late'},finish_reason:'stop'}]}));
  expect(await outcome).toMatchObject({message:'MEMORY_CONTEXT_CANCELLED'});await closing;
  await expect(p.sink.appendAssistant({message:{role:'assistant',content:'late'}})).rejects.toThrow(/MEMORY_CONTEXT_/);
 }finally{release(Response.json({choices:[{message:{role:'assistant',content:'cleanup'},finish_reason:'stop'}]}));await calling.catch(()=>undefined)}
});
it('channel attachment and source-less input fail explicitly before committing canonical or opening a backend',async()=>{
 const f=await fixture(),a=await channelAccount();
 for(const patch of [{attachments:[{kind:'image' as const,url:'https://synthetic.invalid/unretrieved.png'}]},{text:''}]){
  const event=await a.receive(patch);await expect(preparedChannel(f,event)).rejects.toThrow(/MEMORY_CHANNEL_(ATTACHMENT_SOURCE_DENIED|SOURCE_DENIED)/);
  expect((await f.store.read(event.context.sessionId)).entries).toEqual([]);
 }
 expect(f.opened).toBe(0);
});

async function attachmentUser(f:Awaited<ReturnType<typeof fixture>>,text='I prefer English'){
 const attachment={kind:'image' as const,name:'synthetic.png',filePath:'/synthetic/never-read.png',mime:'image/png',status:'pending' as const};
 const message={id:'attachment-user',role:'user' as const,content:text,attachments:[attachment]};
 await f.memory.appendUser(f.event,'session-a',message,()=>{f.sessions.get('session-a').messages.push(message)});
 await f.store.append('session-a',{id:'attachment-user',kind:'user',turnId:'attachment-user',revision:1,payload:{text,attachments:[attachment]}});
 return {message,attachment};
}
it('admits an authorized attachment projection into S while only the original user text can become M',async()=>{
 const f=await fixture();await attachmentUser(f);f.memory.authorizeRun(f.event,'session-a');
 expect(f.memory.usesCanonicalUserContent).toBe(true);
 const grant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'});
 const {prepareMainAttachmentProjection,readMainAttachmentGrant}=await import('./main-attachment-projection');let reads=0;
 expect(readMainAttachmentGrant(grant!).userText).toBe('I prefer English');
 await prepareMainAttachmentProjection(grant!,async()=>{reads++;return [{type:'text',text:'I prefer bash'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]});
 const run=await f.memory.openRun(f.input());await run.call(f.call());
 expect(reads).toBe(1);expect(f.sent[0]).toContain('I prefer bash');expect(f.sent[0]).toContain('data:image/png;base64,c3ludGhldGlj');
 expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts.map(fact=>fact.assertion)).toEqual(['I prefer English']);
});
it('attachment authority rejects unproven historical metadata and foreign windows before materialization',async()=>{
 const f=await fixture(),attachment={kind:'image' as const,name:'synthetic.png',filePath:'/synthetic/no-read.png',mime:'image/png',status:'pending' as const};
 f.sessions.get('session-a').messages.push({id:'legacy-file',role:'user',content:'legacy',attachments:[attachment]});
 await f.store.append('session-a',{id:'legacy-file',kind:'user',turnId:'legacy-file',revision:1,payload:{text:'legacy',attachments:[attachment]}});
 f.memory.authorizeRun(f.event,'session-a');
 await expect(f.memory.prepareAttachmentGrant({...f.event,senderFrame:{}},'session-a',{userTurnId:'legacy-file'})).rejects.toThrow('MEMORY_DESKTOP_SESSION_DENIED');
 await expect(f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'legacy-file'})).rejects.toThrow('MEMORY_ATTACHMENT_DENIED');
 expect(f.sent).toHaveLength(0);
});
it.each(['metadata','canonical','cancel'] as const)('revokes %s-changed attachment grants before any materializer read',async change=>{
 const f=await fixture(),{message}=await attachmentUser(f),admission=f.memory.authorizeRun(f.event,'session-a');
 const grant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'});
 if(change==='metadata')message.attachments[0].filePath='/synthetic/changed.png';
 if(change==='canonical')await f.store.append('session-a',{id:'attachment-edit',kind:'turn_rewind',turnId:'attachment-user',revision:2,payload:{anchorUserTurnId:'attachment-user',disposition:'replace_user',reason:'edit',replacementUser:{text:'changed',attachments:message.attachments}}});
 if(change==='cancel')admission.release();
 const {prepareMainAttachmentProjection}=await import('./main-attachment-projection');let reads=0;
 await expect(prepareMainAttachmentProjection(grant!,async()=>{reads++;return [{type:'text',text:'body'}]})).rejects.toThrow(/MEMORY_/);
 expect(reads).toBe(0);expect(f.sent).toHaveLength(0);
});
it('attachment grants revalidate complete stored metadata after asynchronous materialization',async()=>{
 const f=await fixture(),{message}=await attachmentUser(f);f.memory.authorizeRun(f.event,'session-a');
 const grant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'}),{prepareMainAttachmentProjection}=await import('./main-attachment-projection');
 await expect(prepareMainAttachmentProjection(grant!,async()=>{message.attachments[0].filePath='/synthetic/changed.png';return [{type:'text',text:'late body'}]})).rejects.toThrow('MEMORY_ATTACHMENT_DENIED');
 expect(f.sent).toHaveLength(0);
});
it('authorized attachment edits issue a fresh revision grant while preserving the original files',async()=>{
 const f=await fixture(),{message}=await attachmentUser(f);f.memory.authorizeRun(f.event,'session-a');
 const original=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'});
 await f.memory.mutate(f.event,'session-a',['attachment-user'],()=>{message.content='I prefer Chinese';message.attachments[0].filePath='/synthetic/new.png'});
 await f.store.append('session-a',{id:'replacement',kind:'turn_rewind',turnId:'attachment-user',revision:2,payload:{anchorUserTurnId:'attachment-user',disposition:'replace_user',reason:'edit',replacementUser:{text:message.content,attachments:message.attachments}}});
 f.memory.authorizeRun(f.event,'session-a');await f.memory.afterTranscript('session-a',{userTurnId:'attachment-user',transcriptRewind:{disposition:'replace_user'}});
 const next=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'}),{readMainAttachmentGrant}=await import('./main-attachment-projection');
 expect(()=>readMainAttachmentGrant(original!)).toThrow(/MEMORY_/);expect(readMainAttachmentGrant(next!)).toMatchObject({userRevision:2,userText:'I prefer Chinese',attachments:[{filePath:'/synthetic/new.png'}]});
 expect((await f.store.read('session-a')).entries).toHaveLength(2);
});
it('the attachment bridge method returns undefined for an authenticated plain-text turn',async()=>{
 const f=await fixture();await f.user();f.memory.authorizeRun(f.event,'session-a');
 await expect(f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'u1'})).resolves.toBeUndefined();
});

it('owner shutdown retains attachment materialization until the actual operation settles',async()=>{
 const f=await fixture();await attachmentUser(f);f.memory.authorizeRun(f.event,'session-a');
 const grant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'}),{prepareMainAttachmentProjection}=await import('./main-attachment-projection');
 let arrive!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const pending=prepareMainAttachmentProjection(grant!,async()=>{arrive();await held;return [{type:'text',text:'late file body'}]}),outcome=pending.then(()=>null,error=>error);
 await arrived;const closing=f.memory.close();
 try{await new Promise<void>(setImmediate);expect(f.closed).toBe(0)}finally{release()}
 expect(await outcome).toMatchObject({message:expect.stringMatching(/MEMORY_/)});await closing;expect(f.closed).toBe(1);
});

async function backgroundIngress(entry:'scheduler'|'proactive'|'child',sessionId=entry+'-session',instructionText='I prefer bash'){
 const {createBackgroundMemoryIngressIssuer}=await import('./background-memory-ingress');const source={},controller=new AbortController();let current=true;
 const issuer=createBackgroundMemoryIngressIssuer({entry,isCurrent:value=>current&&value===source});
 const ingress=issuer.capture({source,sessionId,sourceKey:'source-'+sessionId,instructionText,signal:controller.signal});
 return {ingress,instructionText,sessionId,controller,retire(){current=false}};
}
async function preparedBackground(f:Awaited<ReturnType<typeof fixture>>,event:Awaited<ReturnType<typeof backgroundIngress>>,suffix='background-run',readParentGrant?:import('./main-memory-runtime').MainMemoryRun){
 const prepared=await f.memory.prepareBackgroundRun({ingress:event.ingress,instructionText:event.instructionText,modelProfileId:'luna',runId:suffix,userTurnId:'user-'+suffix,assistantTurnId:'assistant-'+suffix,...(readParentGrant?{readParentGrant}:{})});
 const input={...f.input(),conversationId:prepared.sessionId,runId:suffix,transcriptSink:prepared.transcriptSink,signal:prepared.signal};
 const run=await prepared.openMemoryRun(input);return {prepared,input,run,sink:run.bindSink(prepared.transcriptSink)};
}
it.each(['scheduler','proactive','child'] as const)('background %s uses the shared backend and system/model provenance without minting user memory',async entry=>{
 const f=await fixture(),event=await backgroundIngress(entry),p=await preparedBackground(f,event);
 await p.run.call(f.call());await p.sink.appendAssistant({message:{role:'assistant',content:'background complete'}});
 expect(f.sent[0]).toContain(event.instructionText);expect(f.sent[0]).toContain('MEMORY_BACKGROUND_SOURCE_LIMITED');
 const source=f.commands.find(command=>command.kind==='finish'&&command.body.observation.sessionId===event.sessionId);
 expect(source.body.observation).toMatchObject({role:entry==='child'?'assistant':'system',trust:entry==='child'?'model':'system'});
 expect(f.repo.current(source.scopeKey)).toEqual([]);expect(f.commands.some(command=>command.kind==='integrate'&&command.scopeKey===source.scopeKey)).toBe(false);
 expect((await f.store.read(event.sessionId)).entries.map(item=>item.kind)).toEqual(['user','assistant']);
 expect(f.opened).toBe(1);expect(f.nativeStarts).toBe(0);await p.prepared.close();
});
it('background source proofs and exact instruction text are required before any canonical write',async()=>{
 const f=await fixture(),event=await backgroundIngress('scheduler');
 const input={ingress:event.ingress,instructionText:event.instructionText,modelProfileId:'luna',runId:'bg-run',userTurnId:'bg-user',assistantTurnId:'bg-assistant'};
 await expect(f.memory.prepareBackgroundRun({...input,ingress:{...event.ingress}} as any)).rejects.toThrow('MEMORY_BACKGROUND_INGRESS_DENIED');
 await expect(f.memory.prepareBackgroundRun({...input,instructionText:'forged task'})).rejects.toThrow('MEMORY_BACKGROUND_INGRESS_DENIED');
 expect(f.opened).toBe(0);expect((await f.store.read(event.sessionId)).entries).toEqual([]);
});
it('a child can inherit only a genuine live parent run capability, and parent cancellation revokes the child',async()=>{
 const f=await fixture();await f.user('session-a','parent authorized historical note');await f.store.checkpoint('session-a');await primeHistory(f);f.memory.authorizeRun(f.event,'session-a');
 const parent=await f.memory.openRun(f.input()),event=await backgroundIngress('child','scoped-child','Read the authorized parent context');
 await expect(preparedBackground(f,event,'forged-child',{...parent})).rejects.toThrow('MEMORY_RUN_READ_DENIED');
 const child=await preparedBackground(f,event,'real-child',parent);await child.run.call(f.call());
 expect(f.sent[0]).toContain('parent authorized historical note');expect(f.sent[0]).toContain(event.instructionText);
 await parent.close();expect(child.prepared.signal.aborted).toBe(true);
 await expect(child.run.call(f.call())).rejects.toThrow('MEMORY_CONTEXT_CANCELLED');
 expect(f.sent).toHaveLength(1);await child.prepared.close();
});
it('children of one parent share one history capture, so siblings running together both read the parent context',async()=>{
 const f=await fixture();await f.user('session-a','parent authorized historical note');await f.store.checkpoint('session-a');await primeHistory(f);f.memory.authorizeRun(f.event,'session-a');
 const parent=await f.memory.openRun(f.input());
 const one=await preparedBackground(f,await backgroundIngress('child','child-one','Read the parent context'),'child-one',parent);
 const two=await preparedBackground(f,await backgroundIngress('child','child-two','Read the parent context'),'child-two',parent);
 await Promise.all([one.run.call(f.call()),two.run.call(f.call())]);
 expect(f.sent.filter(sent=>sent.includes('parent authorized historical note'))).toHaveLength(2);
 await one.prepared.close();await two.prepared.close();await parent.close();
});
it('background producer cancellation prevents late dispatch and preserves its canonical instruction',async()=>{
 const f=await fixture(),event=await backgroundIngress('proactive'),p=await preparedBackground(f,event);event.controller.abort();
 await expect(p.run.call(f.call())).rejects.toThrow('MEMORY_CONTEXT_CANCELLED');expect(f.sent).toHaveLength(0);
 expect((await f.store.read(event.sessionId)).entries).toHaveLength(1);await p.prepared.close();
});
it('background DTO session labels cannot seize the desktop or settings source routes',async()=>{
 const f=await fixture();
 for(const sessionId of ['session-a','memory-settings-user-events-v1']){
  const event=await backgroundIngress('child',sessionId);await expect(preparedBackground(f,event)).rejects.toThrow('MEMORY_ACTOR_DENIED');
 }
 expect(f.opened).toBe(0);
});

it('matching tampered stored and canonical attachment references do not replace the authenticated append proof',async()=>{
 const f=await fixture(),{message}=await attachmentUser(f);f.memory.authorizeRun(f.event,'session-a');
 message.attachments[0].filePath='/synthetic/unauthorized-replacement.png';
 const file=path.join(storage.dataRoot,'transcripts','session-a','transcript.jsonl');
 const entries=fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));entries[0].payload.attachments[0].filePath=message.attachments[0].filePath;
 fs.writeFileSync(file,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
 await expect(f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'})).rejects.toThrow('MEMORY_ATTACHMENT_DENIED');
 expect(f.sent).toHaveLength(0);
});
it('restart cannot infer attachment permission from a restored direct-text receipt alone',async()=>{
 const f=await fixture();await attachmentUser(f);await f.memory.close();
 const {createMainDefaultMemory}=await import('./main-default-memory');let reopened=0;
 const next=createMainDefaultMemory({getChatWindow:()=>({webContents:f.sender,isDestroyed:()=>false}) as any,targets:f.targets,getSession:id=>f.sessions.get(id),listSessionIds:()=>[...f.sessions.keys()],store:f.store,settings:()=>f.settings,
  openBackend:async()=>{reopened++;return {transport:{...f.transport,recallCommand:async command=>f.repo.recallCommand(command),historyCommand:async command=>f.repo.historyCommand(command)},endpointFactory:async()=>{throw Error('UNEXPECTED_NATIVE')},close:async()=>{}}}});
 try{next.authorizeRun(f.event,'session-a');await expect(next.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'})).rejects.toThrow('MEMORY_ATTACHMENT_DENIED');expect(reopened).toBe(0)}finally{await next.close()}
});

it('a desktop attachment round can close and continue in plain text without rereading or reviving the old grant',async()=>{
 const f=await fixture();await attachmentUser(f,'inspect the image');const admission=f.memory.authorizeRun(f.event,'session-a');
 const grant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'}),{prepareMainAttachmentProjection}=await import('./main-attachment-projection');let reads=0;
 await prepareMainAttachmentProjection(grant!,async()=>{reads++;return [{type:'text',text:'private attachment body'}]});
 const firstInput=f.input(),first=await f.memory.openRun(firstInput);await first.call(f.call());await first.bindSink(firstInput.transcriptSink!).appendAssistant({message:{role:'assistant',content:'first response'}});await first.close();admission.release();
 await f.user('session-a','follow-up text','next-user');f.memory.authorizeRun(f.event,'session-a');const next=await f.memory.openRun(f.input('session-a','next-run'));await next.call(f.call());
 expect(f.sent[1]).toContain('MEMORY_ATTACHMENT_HISTORY_UNAVAILABLE');expect(f.sent[1]).toContain('follow-up text');expect(f.sent[1]).not.toContain('private attachment body');expect(reads).toBe(1);
});
it('a genuine channel attachment is projected before counting and a later text turn reports expired attachment coverage',async()=>{
 const f=await fixture(),a=await channelAccount(),event=await a.receive({text:'inspect image',attachments:[{kind:'image',filePath:'/synthetic/channel.png',mime:'image/png'}]});
 const first=await preparedChannel(f,event,'channel-file-run'),{prepareMainAttachmentProjection}=await import('./main-attachment-projection');let reads=0;
 expect(first.prepared.attachmentGrant).toBeDefined();
 await prepareMainAttachmentProjection(first.prepared.attachmentGrant!,async()=>{reads++;return [{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}},{type:'text',text:'channel file body'}]});
 await first.run.call(f.call());await first.sink.appendAssistant({message:{role:'assistant',content:'file received'}});await first.prepared.close();
 expect(f.sent[0]).toContain('channel file body');expect(f.repo.current(event.context.scopeKey)).toEqual([]);
 const next=await preparedChannel(f,await a.receive({text:'follow-up channel text'}),'channel-followup');await next.run.call(f.call());
 expect(next.prepared.attachmentGrant).toBeUndefined();expect(f.sent[1]).toContain('MEMORY_ATTACHMENT_HISTORY_UNAVAILABLE');expect(f.sent[1]).toContain('follow-up channel text');expect(f.sent[1]).not.toContain('channel file body');expect(reads).toBe(1);
});

it('regenerating an authenticated attachment keeps the exact selection proof while issuing a fresh projection',async()=>{
 const f=await fixture();await attachmentUser(f,'inspect this image');const firstAdmission=f.memory.authorizeRun(f.event,'session-a');
 const firstGrant=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'});
 const {prepareMainAttachmentProjection,readMainAttachmentGrant}=await import('./main-attachment-projection');
 await prepareMainAttachmentProjection(firstGrant!,async()=>[{type:'text',text:'original attachment body'}]);
 const firstInput=f.input(),firstRun=await f.memory.openRun(firstInput);await firstRun.call(f.call());
 await firstRun.bindSink(firstInput.transcriptSink!).appendAssistant({message:{role:'assistant',content:'first response'}});await firstRun.close();firstAdmission.release();
 f.memory.authorizeRun(f.event,'session-a');
 const {prepareTranscriptDispatch}=await import('../orchestrator/conversation-transcript-coordinator');
 f.sessions.get('session-a').messages.push({id:'assistant-regenerated-run',role:'model',content:'',answersUserMessageId:'attachment-user'});
 await prepareTranscriptDispatch({store:f.store,session:f.sessions.get('session-a'),userTurnId:'attachment-user',assistantTurnId:'assistant-regenerated-run',runId:'regenerated-run',rewind:{anchorUserTurnId:'attachment-user',disposition:'keep_user'},forceUserContent:true});
 await f.memory.afterTranscript('session-a',{userTurnId:'attachment-user',transcriptRewind:{disposition:'keep_user'}});
 const fresh=await f.memory.prepareAttachmentGrant(f.event,'session-a',{userTurnId:'attachment-user'});
 expect(fresh).not.toBe(firstGrant);expect(()=>readMainAttachmentGrant(firstGrant!)).toThrow(/MEMORY_/);
 expect(readMainAttachmentGrant(fresh!)).toMatchObject({userRevision:1,userText:'inspect this image',attachments:[{filePath:'/synthetic/never-read.png'}]});
 await prepareMainAttachmentProjection(fresh!,async()=>[{type:'text',text:'regenerated attachment body'}]);
 const next=await f.memory.openRun(f.input('session-a','regenerated-run'));await next.call(f.call());
 expect(f.sent[1]).toContain('regenerated attachment body');expect(f.sent[1]).not.toContain('original attachment body');
});

it.each([['channel','read'],['channel','commit'],['task','read'],['task','commit']] as const)('shutdown revokes in-flight %s admission at the %s boundary before source persistence',async(kind,stage)=>{
 const f=await fixture();let sessionId:string,prepare:()=>Promise<import('./channel-memory-ingress').ChannelMemoryPreparedRun|import('./background-memory-ingress').BackgroundMemoryPreparedRun>;
 if(kind==='channel'){
  const a=await channelAccount(),event=await a.receive();sessionId=event.context.sessionId;
  prepare=()=>f.memory.channelHost.prepareRun({ingress:event.cap,message:event.message,userText:event.message.text,modelProfileId:'luna',runId:'closing-run',userTurnId:'closing-user',assistantTurnId:'closing-assistant'});
 }else{
  const event=await backgroundIngress('scheduler');sessionId=event.sessionId;
  prepare=()=>f.memory.prepareBackgroundRun({ingress:event.ingress,instructionText:event.instructionText,modelProfileId:'luna',runId:'closing-run',userTurnId:'closing-user',assistantTurnId:'closing-assistant'});
 }
 let arrive!:()=>void,release!:()=>void,blocked=false;const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const originalRead=f.store.read.bind(f.store),originalAppend=f.store.append.bind(f.store);
 const readSpy=stage==='read'?vi.spyOn(f.store,'read').mockImplementation(async id=>{if(id===sessionId&&!blocked){blocked=true;arrive();await held}return originalRead(id)}):undefined;
 const appendSpy=stage==='commit'?vi.spyOn(f.store,'append').mockImplementation(async(id,entry,guard)=>{
  if(id!==sessionId||entry.kind!=='user'||!guard||blocked)return originalAppend(id,entry,guard);
  blocked=true;return originalAppend(id,entry,{...guard,validate:async ticket=>{await guard.validate(ticket);arrive();await held}});
 }):undefined;
 const pending=prepare(),outcome=pending.then(value=>value,error=>error);let closing:Promise<void>|undefined;
 try{
  await arrived;closing=f.memory.close();await new Promise<void>(setImmediate);expect(f.closed).toBe(0);release();
  expect(await outcome).toBeInstanceOf(Error);await closing;
  expect((await originalRead(sessionId)).entries).toHaveLength(0);
  expect(f.commands.filter(command=>['reserve','finish'].includes(command.kind))).toHaveLength(0);
  expect(f.sent).toHaveLength(0);expect(f.closed).toBe(1);
 }finally{release();await pending.catch(()=>undefined);await closing;readSpy?.mockRestore();appendSpy?.mockRestore()}
});

it('passes the trusted background observer factory to exact prepared execution without changing source authority',async()=>{
 const f=await fixture(),event=await backgroundIngress('child','observed-child','synthetic observer instruction');
 const phases:Array<[string,string|undefined]>=[];let allocated=0;
 const prepared=await f.memory.prepareBackgroundRun({ingress:event.ingress,instructionText:event.instructionText,modelProfileId:'luna',runId:'observed-background-run',userTurnId:'observed-user',assistantTurnId:'observed-assistant',
  createModelExecutionObserver:()=>{allocated++;return(phase,terminal)=>phases.push([phase,terminal])}});
 const input={...f.input(),conversationId:prepared.sessionId,runId:'observed-background-run',transcriptSink:prepared.transcriptSink,signal:prepared.signal};
 const run=await prepared.openMemoryRun(input);await run.call(f.call());
 expect(allocated).toBe(1);expect(phases).toEqual([['start',undefined],['end','completed']]);expect(f.sent).toHaveLength(1);
 expect(f.sent[0]).not.toContain('createModelExecutionObserver');expect(f.sent[0]).not.toContain('observed-background-run');
 expect(f.commands.some(command=>command.kind==='integrate')).toBe(false);await prepared.close();
});


async function interruptedChild(f:Awaited<ReturnType<typeof fixture>>,sessionId='recover-child',foreignConversationId?:string){
 const runId='recover-old-run',instructionText='old synthetic child instruction',event=await backgroundIngress('child',sessionId,instructionText);
 const prepared=await f.memory.prepareBackgroundRun({ingress:event.ingress,instructionText,modelProfileId:'luna',runId,userTurnId:runId+'-instruction',assistantTurnId:runId+'-assistant'});
 const input={...f.input(),conversationId:sessionId,runId,transcriptSink:prepared.transcriptSink,signal:prepared.signal};
 const run=await prepared.openMemoryRun(input),sink=run.bindSink(prepared.transcriptSink);await run.call(f.call());
 const calls=[{id:'started-write',name:'write_file',arguments:'{"path":"unknown.txt","content":"fixture"}'},{id:'planned-write',name:'write_file',arguments:'{"path":"planned.txt","content":"fixture"}'},{id:'declared-untracked',name:'write_file',arguments:'{}'}];
 const message={role:'assistant' as const,content:'synthetic interrupted tool plan',toolCalls:calls};await sink.appendAssistant({message,roundId:'round-1'});
 f.runStore.create({conversationId:foreignConversationId??sessionId,runId,messages:[{role:'user',content:instructionText},message],state:{todoItems:[],uncertainEffects:[]},request:{provider:f.config.provider,model:f.config.model,contextWindowTokens:128000,promptFingerprint:'fixture',toolSchemaFingerprint:'fixture'}});
 for(const [index,call]of calls.slice(0,2).entries())f.runStore.recordTool(runId,{toolCallId:call.id,toolName:call.name,sideEffect:'idempotent_mutation',status:index===0?'started':'planned'});
 await prepared.close();
 const continuation=await backgroundIngress('child',sessionId,'new synthetic child continuation');
 const request={ingress:continuation.ingress,instructionText:continuation.instructionText,modelProfileId:'luna',runId:'recover-new-run',userTurnId:'recover-new-run-instruction',assistantTurnId:'recover-new-run-assistant',recoverRunId:runId};
 return{runId,sessionId,request,calls};
}
it('recovers only the authorized child continuation through existing canonical interruption closure',async()=>{
 const f=await fixture(),old=await interruptedChild(f),before=(await f.store.read(old.sessionId)).entries;
 const prepared=await f.memory.prepareBackgroundRun(old.request),entries=(await f.store.read(old.sessionId)).entries;
 for(const call of old.calls){const results=entries.filter(entry=>entry.kind==='tool_result'&&entry.payload.toolCallId===call.id);expect(results).toHaveLength(1);expect(results[0].kind==='tool_result'&&results[0].payload.outcome).toBe(call.id==='started-write'?'unknown':'not_executed')}
 expect(entries.slice(0,before.length)).toEqual(before);expect(entries.filter(entry=>entry.kind==='interruption'&&entry.runId===old.runId)).toHaveLength(1);
 const run=await prepared.openMemoryRun({...f.input(),conversationId:old.sessionId,runId:'recover-new-run',transcriptSink:prepared.transcriptSink,signal:prepared.signal});
 await expect(run.call(f.call())).resolves.toMatchObject({text:'synthetic answer'});expect(JSON.parse(f.sent.at(-1)!).messages.filter((message:any)=>message.role==='tool').map((message:any)=>JSON.parse(message.content).outcome)).toContain('unknown');await prepared.close();
});
it.each(['missing-reader','foreign-session'] as const)('refuses %s child recovery before writing a closure or new instruction',async reason=>{
 const f=await fixture('chat',{withoutRunReader:reason==='missing-reader'}),old=await interruptedChild(f,'recover-negative',reason==='foreign-session'?'foreign-child':undefined),before=await f.store.read(old.sessionId);
 await expect(f.memory.prepareBackgroundRun(old.request)).rejects.toThrow(/MEMORY_CHILD_RECOVERY_/);
 expect(await f.store.read(old.sessionId)).toEqual(before);
});
it('owner close during a pending child recovery read blocks every new closure write and drains the read',async()=>{
 const f=await fixture(),old=await interruptedChild(f,'recover-closing'),before=await f.store.read(old.sessionId);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const read=f.store.read.bind(f.store);let heldOnce=false;
 const spy=vi.spyOn(f.store,'read').mockImplementation(async id=>{if(id===old.sessionId&&!heldOnce){heldOnce=true;entered();await held}return read(id)});
 const pending=f.memory.prepareBackgroundRun(old.request),rejected=expect(pending).rejects.toThrow(/MEMORY_CONTEXT_(CANCELLED|RUNTIME_CLOSED)/);
 await started;const closing=f.memory.close();expect(f.closed).toBe(0);release();await rejected;await closing;spy.mockRestore();
 expect(await f.store.read(old.sessionId)).toEqual(before);expect(f.closed).toBe(1);
});

it('retries after completed old closure and failed new instruction without appending the old marker again',async()=>{
 const f=await fixture(),old=await interruptedChild(f,'recover-marker-retry');
 const append=f.store.append.bind(f.store);let failInstruction=true;
 const spy=vi.spyOn(f.store,'append').mockImplementation(async(id,draft,guard)=>{
  if(failInstruction&&draft.kind==='user'&&draft.turnId===old.request.userTurnId){failInstruction=false;throw Error('synthetic new instruction persistence failure after old closure')}
  return append(id,draft,guard);
 });
 await expect(f.memory.prepareBackgroundRun(old.request)).rejects.toThrow('synthetic new instruction persistence failure');
 const afterFailure=(await f.store.read(old.sessionId)).entries;
 expect(afterFailure.filter(entry=>entry.kind==='interruption'&&entry.runId===old.runId)).toHaveLength(1);
 expect(afterFailure.filter(entry=>entry.kind==='tool_result')).toHaveLength(3);spy.mockClear();
 await expect(f.memory.prepareBackgroundRun({...old.request,runId:'consumed-proof-retry',userTurnId:'consumed-proof-instruction',assistantTurnId:'consumed-proof-assistant'})).rejects.toThrow('MEMORY_TASK_SOURCE_DENIED');
 const next=await backgroundIngress('child',old.sessionId,old.request.instructionText);
 const prepared=await f.memory.prepareBackgroundRun({...old.request,ingress:next.ingress,runId:'marker-retry-new-run',userTurnId:'marker-retry-new-run-instruction',assistantTurnId:'marker-retry-new-run-assistant'});
 expect(spy.mock.calls.filter(([,draft])=>draft.kind==='interruption'&&draft.runId===old.runId)).toHaveLength(0);
 expect((await f.store.read(old.sessionId)).entries.filter(entry=>entry.kind==='interruption'&&entry.runId===old.runId)).toHaveLength(1);
 spy.mockRestore();await prepared.close();
});

// ---- Shadow extraction (M2b): default off, one extraction per successful desktop turn ----
const SHADOW_SCOPE = "desktop-local-profile-v1", SHADOW_ACTOR = "desktop-local-user-v1";
const shadowCmd = (f: Awaited<ReturnType<typeof fixture>>, kind: string, body: Record<string, unknown> = {}) =>
  (f.repo as any).shadowCommand({ kind, scopeKey: SHADOW_SCOPE, ...(["status", "export"].includes(kind) ? {} : { commandId: "t-" + Math.random().toString(36).slice(2) }), body: { actorKey: SHADOW_ACTOR, ...body } });
const enableShadow = (f: Awaited<ReturnType<typeof fixture>>) => shadowCmd(f, "configure", { enabled: true, dailyCap: 50, expectedRevision: shadowCmd(f, "status").revision });
const shadowAnswer = (quote: string) => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ subject: "user", attribute: "tool", value: "VS Code", polarity: "positive", status: "asserted", quote, reason: "stated directly" }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
const shadowRequests = (f: Awaited<ReturnType<typeof fixture>>) => f.sent.filter(body => body.includes("userMessage") && !body.includes("user-fact-v2"));
async function waitUntil(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); }
async function finishTurn(f: Awaited<ReturnType<typeof fixture>>, text: string, runId = "run-a", id = "session-a") {
  const quote = text;
  f.sessions.get(id).messages.push({ id: "a0", role: "model", content: "你一般用什么编辑器？" });
  await f.user(id, text);
  f.memory.authorizeRun(f.event, id);
  const input = f.input(id, runId), run = await f.memory.openRun(input);
  await run.call(f.call()); await run.bindSink(input.transcriptSink!).appendAssistant({ message: { role: "assistant", content: "synthetic answer" } });
  f.respond(async () => shadowAnswer(quote));
  return run;
}

it("ordinary Chat proposes a new natural fact with shadow off, then settings confirmation reaches another session's request", async () => {
  const f = await fixture("chat", { withoutShadow: true }), run = await finishTurn(f, "我平时用 VS Code");
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" });
  const pending = await f.memory.settingsHost.getState(f.settingsEvent);
  expect(pending.facts).toEqual([]);
  expect(pending.candidates).toMatchObject([{ assertion: "用户使用工具：VS Code", attribute: "tool", value: "VS Code" }]);
  const candidate = pending.candidates[0];
  const accepted = await f.memory.settingsHost.applyAction(f.settingsEvent, { kind: "confirm", id: candidate.candidateId, expectedRevision: candidate.revision, contentHash: candidate.contentHash });
  expect(accepted.status).toBe("active"); await run.close();
  f.sessions.set("session-b", { id: "session-b", mode: "chat", messages: [], modelProfileId: "luna" }); f.select("session-b");
  await f.user("session-b", "按我的习惯推荐编辑器", "b1"); f.memory.authorizeRun(f.event, "session-b");
  const next = await f.memory.openRun(f.input("session-b", "next-run")); await next.call(f.call());
  expect(f.sent.at(-1)).toContain("用户使用工具：VS Code");
  const wire = JSON.parse(f.sent.at(-1)!);
  expect(wire.messages.find((message: {content:string}) => message.content.startsWith("User-stated memory")).role).toBe("user");
  expect(wire.messages.filter((message: {role:string}) => message.role === "system").every((message: {content:string}) => !message.content.includes("用户使用工具：VS Code"))).toBe(true);
  await f.memory.settingsHost.applyAction(f.settingsEvent, { kind: "correct", id: accepted.factId!, expectedRevision: 1, text: "我平时用 Vim" });
  expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toMatchObject([{ revision: 2, assertion: "用户使用工具：Vim" }]);
  await f.memory.settingsHost.applyAction(f.settingsEvent, { kind: "forget", id: accepted.factId!, expectedRevision: 2 });
  expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toEqual([]); await next.close();
});

it.each(["unsent", "result-unknown", "result-saved"] as const)("new Main owner recovers journal %s using only the owned authenticated source", async phase => {
  const f = await fixture("chat", { withoutShadow: true }), quote = "我平时用 VS Code";
  if (phase !== "result-unknown") f.pauseNatural(phase === "unsent" ? "dispatch" : "apply");
  const run = await finishTurn(f, quote);
  const answer = () => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ subject: "user", attribute: "tool", value: "VS Code", polarity: "positive", status: "asserted", quote, reason: "direct user statement" }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
  f.respond(phase === "result-unknown" ? async () => { throw new TypeError("synthetic disconnected provider"); } : async () => answer());
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await run.close();
  const list = () => f.repo.policyCommand({ kind: "naturalJob", scopeKey: SHADOW_SCOPE, body: { actorKey: SHADOW_ACTOR, operation: "list" } }) as { jobs: Array<{ phase: string }> };
  expect(list().jobs).toMatchObject([{ phase }]); f.pauseNatural(); const before = f.sent.length;
  let arrived!: () => void, release!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.respond(async () => { arrived(); await gate; return answer(); }); await f.restart();
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  if (phase === "unsent") { await started; expect(state.backendStatus.available).toBe(true); expect(list().jobs).toMatchObject([{ phase: "result-unknown" }]); release(); await expect.poll(async () => (await f.memory.settingsHost.getState(f.settingsEvent)).candidates.some(c => c.assertion === "用户使用工具：VS Code")).toBe(true); }
  else { expect(f.sent.length).toBe(before); expect(state.candidates.some(c => c.assertion === "用户使用工具：VS Code")).toBe(phase === "result-saved"); }
  expect(f.sent.length - before).toBe(phase === "unsent" ? 1 : 0);
});

it("new Main owner fences a saved result when host profile configuration changed while closed", async () => {
  const f = await fixture("chat", { withoutShadow: true }); f.pauseNatural("apply"); const run = await finishTurn(f, "我平时用 VS Code");
  f.respond(async () => { const response = await shadowAnswer("我平时用 VS Code"), body = await response.json(); return Response.json({ ...body, usage: { prompt_tokens: 50, completion_tokens: 10 } }); });
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await run.close(); f.pauseNatural(); const before = f.sent.length;
  await f.memory.close(); f.settings.modelProfiles![0].apiKey = "synthetic-replaced-key"; await f.restart();
  const state = await f.memory.settingsHost.getState(f.settingsEvent); expect(state.candidates.filter(c => c.assertion === "用户使用工具：VS Code")).toEqual([]); expect(f.sent.length).toBe(before);
  expect(f.repo.readRows("jobs", SHADOW_SCOPE).some(row => (row.payload as any).reason === "profile-changed")).toBe(true);
});

it.each([
  ["form-of-address", "小周是我习惯用的称呼", "小周", "小林", "用户称呼：小周", "用户称呼：小林", "positive"],
  ["language", "I always prefer English for our chats", "English", "zh", "用户回复语言：en", "用户回复语言：zh", "positive"],
  ["response-style", "I prefer detailed replies", "detailed", "concise", "用户回复风格：detailed", "用户回复风格：concise", "positive"],
  ["tool", "My editor is Vim", "Vim", "Emacs", "用户使用工具：Vim", "用户使用工具：Emacs", "positive"],
  ["preference", "I like tea", "tea", "coffee", "用户喜好：tea", "用户喜好：coffee", "positive"],
  ["tool", "I don't use Vim", "Vim", "Emacs", "用户使用工具（否定）：Vim", "用户使用工具（否定）：Emacs", "negative"],
] as const)("settings prefilled %s edit preserves typed value and identity through UI/IPC/SQLite (%s)", async (attribute, text, value, replacement, before, after, polarity) => {
  const f = await fixture("chat", { withoutShadow: true }), run = await finishTurn(f, text);
  f.respond(async () => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ subject: "user", attribute, value, polarity, status: "asserted", quote: text, reason: "direct self statement" }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await run.close();
  const ipc = createMemorySettingsIpc({ getSettingsWindow: () => f.settingsWindow, host: f.memory.settingsHost });
  const candidate = (await ipc.getMemoryPanelState(f.settingsEvent)).candidates[0]; expect(candidate.assertion).toBe(before);
  const accepted = await ipc.applyMemoryPanelAction(f.settingsEvent, { kind: "confirm", id: candidate.candidateId, expectedRevision: candidate.revision, contentHash: candidate.contentHash });
  expect(accepted.status).toBe("active");
  const readTyped = () => f.repo.policyCommand({ kind: "recall", scopeKey: SHADOW_SCOPE, body: { actorKey: SHADOW_ACTOR } }) as import("../../shared/memory-contracts").FactView[];
  const original = readTyped()[0], dom = new JSDOM("<main></main>"), root = dom.window.document.querySelector("main")!;
  const submitted: MemoryPanelAction[] = []; let outcome: MemoryPanelOutcome | undefined;
  const panel = createMemoryEntriesPanel(root, {
    getState: () => ipc.getMemoryPanelState(f.settingsEvent),
    applyAction: async action => { submitted.push(action); outcome = await ipc.applyMemoryPanelAction(f.settingsEvent, action); return outcome; },
    auditSource: id => ipc.auditMemoryPanelSource(f.settingsEvent, id),
  });
  try {
    await panel.load(); (root.querySelector('[data-memory-action="correct"]') as HTMLButtonElement).click();
    const editor = root.querySelector("textarea")!; expect(editor.value).toBe(before);
    editor.value = editor.value.replace(value === "English" ? "en" : value, replacement);
    expect(editor.value).toBe(after); (root.querySelector('[data-memory-action="save-correction"]') as HTMLButtonElement).click();
    await expect.poll(() => outcome).toBeDefined(); expect(outcome).toMatchObject({ status: "active", factRevision: 2 });
    expect(submitted).toEqual([{ kind: "correct", id: accepted.factId, expectedRevision: 1, text: after }]);
    const current = readTyped()[0];
    expect(current).toMatchObject({ assertion: after, revision: 2, typed: { attribute: attribute === "form-of-address" ? "address" : attribute, value: replacement, canonicalValue: replacement.toLowerCase(), polarity, entityKey: original.typed!.entityKey } });
    expect(current.subjectKey).toBe(current.typed!.slotKey); expect(current.typed!.assertionKey).not.toBe(original.typed!.assertionKey);
    if (attribute === "tool" || attribute === "preference") expect(current.subjectKey).not.toBe(original.subjectKey);
    else expect(current.subjectKey).toBe(original.subjectKey);
    expect(await ipc.applyMemoryPanelAction(f.settingsEvent, { kind: "correct", id: current.factId, expectedRevision: 1, text: before })).toEqual({ status: "rejected", reason: "MEMORY_REVISION_CONFLICT" });
    await panel.load(); (root.querySelector('[data-memory-action="forget"]') as HTMLButtonElement).click();
    await expect.poll(() => outcome?.status).toBe("forgotten"); expect(f.repo.current(SHADOW_SCOPE)).toEqual([]);
    expect((await ipc.applyMemoryPanelAction(f.settingsEvent, { kind: "correct", id: current.factId, expectedRevision: 2, text: after })).status).toBe("rejected");
    expect(f.repo.current(SHADOW_SCOPE)).toEqual([]);
  } finally { dom.window.close(); }
});

it.each(["用户使用工具：＂Emacs＂", "用户使用工具：如果我用 Emacs", "用户喜好：tea"])("prefilled settings edit rejects quoted, hypothetical or foreign-category input: %s", async text => {
  const f = await fixture("chat", { withoutShadow: true }), run = await finishTurn(f, "我平时用 VS Code");
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await run.close();
  const ipc = createMemorySettingsIpc({ getSettingsWindow: () => f.settingsWindow, host: f.memory.settingsHost }), c = (await ipc.getMemoryPanelState(f.settingsEvent)).candidates[0];
  const accepted = await ipc.applyMemoryPanelAction(f.settingsEvent, { kind: "confirm", id: c.candidateId, expectedRevision: c.revision, contentHash: c.contentHash });
  const before = f.repo.current(SHADOW_SCOPE);
  expect(await ipc.applyMemoryPanelAction(f.settingsEvent, { kind: "correct", id: accepted.factId!, expectedRevision: 1, text })).toMatchObject({ status: "rejected", reason: "MEMORY_POLICY_UNRESOLVED" });
  expect(f.repo.current(SHADOW_SCOPE)).toEqual(before);
});

it("shadow stays off while the separate natural pipeline produces only pending candidates", async () => {
  const f = await fixture(); const run = await finishTurn(f, "我平时用 VS Code");
  const before = f.sent.length;
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.sent).toHaveLength(before + 1); expect(shadowRequests(f)).toHaveLength(0); expect(shadowCmd(f, "status")).toMatchObject({ enabled: false, used: 0, counters: {} });
  expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts).toEqual([]);
  await run.close();
});

it("extracts once after a successful desktop chat turn using the run's own profile", async () => {
  const f = await fixture(); enableShadow(f);
  const run = await finishTurn(f, "我平时用 VS Code");
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" });
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" });
  await waitUntil(() => shadowCmd(f, "export").length === 1);
  const records = shadowCmd(f, "export");
  expect(records).toMatchObject([{ candidate: { attribute: "tool", value: "VS Code", evidence: { messageId: "u1", quote: "我平时用 VS Code" } }, profile: { id: "luna", revision: 1 }, promptVersion: "m-shadow-prompt-v1" }]);
  const requests = shadowRequests(f);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("previousAssistantReply"); expect(requests[0]).toContain("你一般用什么编辑器？");
  expect(requests[0]).toContain("openai/gpt-6-luna"); expect(requests[0]).toContain('\"max_tokens\":800');
  expect(shadowCmd(f, "status")).toMatchObject({ used: 1, counters: { sent: 1, candidates: 1 } });
  await run.close();
});

it("does not extract from Work or Code sessions", async () => {
  for (const mode of ["work", "code"] as const) {
    const f = await fixture(mode); enableShadow(f);
    const run = await finishTurn(f, "我平时用 VS Code", "run-" + mode);
    await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-" + mode });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(shadowRequests(f)).toHaveLength(0); expect(shadowCmd(f, "status").used).toBe(0);
    await run.close();
  }
});

it("a turn that never reports success leaves nothing behind", async () => {
  const f = await fixture(); enableShadow(f); const run = await finishTurn(f, "我平时用 VS Code");
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "other-run" });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(shadowRequests(f)).toHaveLength(0); expect(shadowCmd(f, "status").used).toBe(0);
  await run.close();
});

it("cancels the extraction when the model profile changed after the run started", async () => {
  const f = await fixture(); enableShadow(f); const run = await finishTurn(f, "我平时用 VS Code");
  (f.settings as any).modelProfiles[0].apiKey = "changed-after-run";
  await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" });
  await waitUntil(() => shadowCmd(f, "status").counters["cancel:profile-changed"] === 1);
  expect(shadowRequests(f)).toHaveLength(0); expect(shadowCmd(f, "status")).toMatchObject({ used: 0, counters: { "cancel:profile-changed": 1 } });
  await run.close();
});

it("keeps working when the memory backend has no shadow storage", async () => {
  const f = await fixture("chat", { withoutShadow: true }); const run = await finishTurn(f, "我平时用 VS Code");
  await expect(f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" })).resolves.toBeUndefined();
  expect(shadowRequests(f)).toHaveLength(0);
  await run.close();
});

// ── Temporary chat: zero persistence, no M/H, no cross-session reads in either direction ──
const marked: string[] = [];
afterEach(async () => { const { ephemeralConversations } = await import("../chats/ephemeral-conversations"); for (const id of marked.splice(0)) ephemeralConversations.release(id); });
async function temporarySession(f: Awaited<ReturnType<typeof fixture>>, id = "tmp-1") {
  const { ephemeralConversations } = await import("../chats/ephemeral-conversations");
  ephemeralConversations.mark(id); marked.push(id);
  f.sessions.set(id, { id, mode: "chat", temporary: true, messages: [], modelProfileId: "luna" }); f.select(id);
  return id;
}
async function temporaryTurn(f: Awaited<ReturnType<typeof fixture>>, id: string, runId: string, userId: string, text: string, answer = "synthetic answer") {
  await f.user(id, text, userId); const admission = f.memory.authorizeRun(f.event, id);
  // The real AG-UI bridge asks for an attachment grant even for text-only turns.
  await expect(f.memory.prepareAttachmentGrant(f.event, id, { userTurnId: userId })).resolves.toBeUndefined();
  const input = f.input(id, runId), run = await f.memory.openRun(input);
  await run.call(f.call()); await run.bindSink(input.transcriptSink!).appendAssistant({ message: { role: "assistant", content: answer } });
  const request = f.sent.at(-1)!; await run.close(); admission.release();
  return request;
}

it("a temporary chat keeps the whole conversation as context but writes nothing to memory or disk", async () => {
  const f = await fixture(); const id = await temporarySession(f);
  const first = await temporaryTurn(f, id, "run-1", "u1", "my secret plan is to learn Rust", "first answer");
  expect(first).toContain("my secret plan is to learn Rust"); expect(first).not.toContain("User-stated memory");
  const second = await temporaryTurn(f, id, "run-2", "u2", "what did I just say?");
  expect(second).toContain("my secret plan is to learn Rust"); expect(second).toContain("first answer"); expect(second).toContain("what did I just say?");
  expect(f.commands).toEqual([]); expect(f.historyCommands).toEqual([]);
  expect(fs.existsSync(path.join(storage.dataRoot, "transcripts", id))).toBe(false);
  expect(f.memory.getHistoryCoverage(id)).toMatchObject({ status: "not-checked", selected: 0 });
});

it("a temporary chat never becomes a fact, a candidate, shadow input, or another session's history", async () => {
  const f = await fixture(); enableShadow(f); const id = await temporarySession(f);
  await temporaryTurn(f, id, "run-1", "u1", "I prefer PowerShell and harbor notes");
  await f.memory.onTurnSucceeded({ sessionId: id, runId: "run-1" });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(shadowRequests(f)).toHaveLength(0); expect(shadowCmd(f, "status").used).toBe(0);
  const state = await f.memory.settingsHost.getState(f.settingsEvent); expect(state.facts).toEqual([]); expect(state.candidates).toEqual([]);
  f.sessions.set("session-a", { id: "session-a", mode: "chat", messages: [], modelProfileId: "luna" }); f.select("session-a");
  await f.user("session-a", "give me a harbor terminal command", "u-a"); f.memory.authorizeRun(f.event, "session-a");
  const run = await f.memory.openRun(f.input("session-a", "run-a")); await run.call(f.call());
  expect(f.sent.at(-1)).not.toContain("PowerShell"); expect(f.sent.at(-1)).not.toContain("harbor notes");
  expect(f.memory.getHistoryCoverage("session-a")).toMatchObject({ selected: 0 });
  await run.close();
});

it("editing or deleting a temporary chat message touches no memory storage", async () => {
  const f = await fixture(); const id = await temporarySession(f);
  await f.user(id, "to be removed", "u1");
  let committed = false;
  await f.memory.mutate(f.event, id, ["u1"], () => { committed = true; f.sessions.get(id).messages = []; });
  expect(committed).toBe(true); expect(f.commands).toEqual([]);
});

it("the temporary mode is immutable for a session and attachments are refused", async () => {
  const f = await fixture(); const id = await temporarySession(f);
  await expect(f.memory.appendUser(f.event, id, { id: "u9", role: "user", content: "see file", attachments: [{ kind: "document", name: "a.txt", filePath: "C:\\a.txt", status: "pending" }] } as any, () => true)).rejects.toThrow("MEMORY_TEMPORARY_ATTACHMENT_UNSUPPORTED");
  f.memory.authorizeRun(f.event, id);
  f.sessions.get(id).messages.push({ id: "injected-file", role: "user", content: "file", attachments: [{ kind: "document", name: "a.txt", filePath: "C:\\a.txt", status: "pending" }] } as any);
  await expect(f.memory.prepareAttachmentGrant(f.event, id, { userTurnId: "injected-file" })).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
  expect(f.commands).toEqual([]);
  delete f.sessions.get(id).temporary;
  await expect(f.memory.openRun(f.input(id, "run-x"))).rejects.toThrow("MEMORY_SESSION_MODE_DENIED");
  expect(f.sent).toHaveLength(0);
});

it("a temporary session must be a Chat session", async () => {
  const f = await fixture("work");
  f.sessions.set("bad", { id: "bad", mode: "work", temporary: true, messages: [], modelProfileId: "luna" }); f.select("bad");
  await expect(f.memory.appendUser(f.event, "bad", { id: "u1", role: "user", content: "x" }, () => true)).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");
});

it("a temporary chat bound to a workspace still reads and writes no project or global facts", async () => {
  const f = await fixture("code");
  const alpha = { workspaceRoot: "C:\\work\\alpha", displayName: "alpha", boundAt: 1 };
  f.sessions.set("learn", { id: "learn", mode: "code", messages: [], modelProfileId: "luna", workspaceBinding: alpha }); f.select("learn");
  await f.user("learn", "I prefer bash", "u-learn"); f.memory.authorizeRun(f.event, "learn");
  const learn = await f.memory.openRun(f.input("learn", "run-learn")); await learn.call(f.call()); await learn.close();
  const id = await temporarySession(f, "tmp-alpha"); f.sessions.get(id).workspaceBinding = alpha;
  const before = f.commands.length;
  const request = await temporaryTurn(f, id, "run-t", "u-t", "give me a terminal command");
  expect(request).not.toContain("User-stated memory"); expect(request).not.toContain("I prefer bash");
  expect(f.commands.length).toBe(before);
  const other = await temporaryTurn(f, id, "run-t2", "u-t2", "I prefer PowerShell here");
  expect(other).toBeTruthy(); expect(f.commands.length).toBe(before);
  expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts.map((fact: any) => fact.assertion)).toEqual(["I prefer bash"]);
});

it("ordinary sessions keep their persistent memory behaviour next to a temporary one", async () => {
  const f = await fixture(); const id = await temporarySession(f);
  await temporaryTurn(f, id, "run-1", "u1", "temporary words");
  f.sessions.set("session-a", { id: "session-a", mode: "chat", messages: [], modelProfileId: "luna" }); f.select("session-a");
  const request = await temporaryTurn(f, "session-a", "run-a", "u-a", "persistent words");
  expect(request).toContain("persistent words"); expect(f.commands.some((command: any) => command.kind === "claim")).toBe(true);
  expect(fs.existsSync(path.join(storage.dataRoot, "transcripts", "session-a"))).toBe(true);
});

// ── One continuous user story: remember → recall in another session → correct → forget → keep chatting ──
it("remember, recall in a new session, correct, forget, and keep chatting without resurrecting the forgotten text", async () => {
  const f = await fixture("chat");
  // History is read from checkpointed transcripts, so every story turn is checkpointed once it ends.
  const turn = async (id: string, text: string) => { const request = await turnIn(f, id, "chat", null, text); await f.store.checkpoint(id); return request; };
  await turn('safe-before-a','harbor sapphire independent note');
  await turn('safe-before-b','harbor emerald independent note');
  await turn("story-1", "请叫我小林");
  const stated = (await f.memory.settingsHost.getState(f.settingsEvent)).facts.find((fact: any) => fact.assertion.includes("小林"))!;
  expect(stated).toBeTruthy();

  const recalled = await turn("story-2", "你好");
  expect(recalled).toContain(MEMORY_MARKER); expect(recalled).toContain("请叫我小林");

  const corrected = await f.memory.settingsHost.applyAction(f.settingsEvent, { kind: "correct", id: stated.factId, expectedRevision: stated.revision, text: "请叫我小萤" });
  expect(corrected).toMatchObject({ status: "active" });
  const unrelated=await turn('safe-query','harbor sapphire emerald');
  expect(unrelated).toContain('harbor sapphire independent note');expect(unrelated).toContain('harbor emerald independent note');expect(unrelated).not.toContain(stated.assertion);
  // Correction retires only dependent or unproved H while the corrected fact remains usable.
  const afterCorrect = await turn("story-3", "请叫我什么");
  expect(afterCorrect).toContain("请叫我小萤");
  expect(afterCorrect).toContain("MEMORY_HISTORY_ORIGIN_UNPROVEN"); expect(afterCorrect).not.toContain(stated.assertion);

  expect(await f.memory.settingsHost.applyAction(f.settingsEvent, { kind: "forget", id: stated.factId, expectedRevision: corrected.factRevision! })).toMatchObject({ status: "forgotten" });
  await turn('safe-new','harbor amber new history');await f.restart();
  const restarted=await turn('safe-restart-query','harbor sapphire emerald amber');
  expect(restarted).toContain('harbor sapphire independent note');expect(restarted).toContain('harbor emerald independent note');expect(restarted).toContain('harbor amber new history');expect(restarted).not.toContain(stated.assertion);
  // The next turns must not fail, must not carry the fact, and must not bring the forgotten wording back through raw history.
  const afterForget = await turn("story-4", "请叫我什么");
  expect(afterForget).not.toContain(MEMORY_MARKER);
  expect(afterForget).not.toContain("小萤"); expect(afterForget).not.toContain("小林");
  const stillChatting = await turn("story-5", "继续聊别的");
  expect(stillChatting).toBeTruthy(); expect(stillChatting).not.toContain("小萤");
  expect((await f.memory.settingsHost.getState(f.settingsEvent)).facts.filter((fact: any) => /小林|小萤/.test(fact.assertion))).toEqual([]);
});

// ── Project isolation: facts learned in one bound workspace never reach another ──
const binding = (name: string, root = "C:\\work\\" + name) => ({ workspaceRoot: root, displayName: name, boundAt: 1 });
async function turnIn(f: Awaited<ReturnType<typeof fixture>>, id: string, mode: "chat" | "code", workspace: string | null, text: string, root?: string) {
  f.sessions.set(id, { id, mode, messages: [], modelProfileId: "luna", ...(workspace ? { workspaceBinding: binding(workspace, root) } : {}) });
  f.select(id); await f.user(id, text, "u-" + id); const admission = f.memory.authorizeRun(f.event, id);
  const run = await f.memory.openRun(f.input(id, "run-" + id));
  await run.call(f.call()); const request = f.sent.at(-1)!;
  await run.close(); admission.release();
  return request;
}
const MEMORY_MARKER = "User-stated memory with source and time metadata";

it("automation settings require the current settings frame and strict CAS before recording consent", async () => {
  const f = await fixture(); expect(f.memory.automationHost).toBeDefined();
  await expect(f.memory.automationHost.state(f.event)).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN"); expect(f.opened).toBe(0);
  const initial = await f.memory.automationHost.state(f.settingsEvent); expect(initial.config).toEqual({ revision: 0, language: false, responseStyle: false });
  await expect(f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 0, language: true, responseStyle: false, scope: "invented" } as any)).rejects.toThrow("MEMORY_INPUT_INVALID");
  const updated = await f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 0, language: true, responseStyle: false }); expect(updated.config).toEqual({ revision: 1, language: true, responseStyle: false });
  await expect(f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 0, language: false, responseStyle: true })).rejects.toThrow("MEMORY_REVISION_CONFLICT");
  await f.restart(); expect((await f.memory.automationHost.state(f.settingsEvent)).config).toEqual(updated.config);
});

it("a settings frame revoked during consent preflight cannot write a new consent epoch", async () => {
  const f = await fixture(); expect(f.memory.automationHost).toBeDefined();
  await f.memory.automationHost.state(f.settingsEvent);
  let arrived!: () => void, release!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.repo.policyCommand.bind(f.repo);
  vi.spyOn(f.repo, "policyCommand").mockImplementation(((command: any) => { if (command.kind === "naturalJob" && command.body.operation === "state") { arrived(); return gate.then(() => original(command)); } return original(command); }) as any);
  const saving = f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 0, language: true, responseStyle: false }); await started;
  f.settingsWindow.webContents.mainFrame = {}; release(); await expect(saving).rejects.toThrow("MEMORY_SETTINGS_FORBIDDEN");
  expect((original({ kind: "naturalJob", scopeKey: SHADOW_SCOPE, body: { actorKey: SHADOW_ACTOR, operation: "state" } }) as any).config.revision).toBe(0);
});

it("the actual automation checkbox crosses IPC/Main/SQLite and an opted-in ADD reaches another session as user data", async () => {
  const f = await fixture("chat", { withoutShadow: true }); expect(f.memory.automationHost).toBeDefined();
  const ipc = createMemoryAutomationSettingsIpc({ getSettingsWindow: () => f.settingsWindow, host: f.memory.automationHost });
  const dom = new JSDOM("<section></section>"), root = dom.window.document.querySelector("section")!;
  try {
    const panel = createMemoryAutomationPanel(root, { state: () => ipc.state(f.settingsEvent), configure: input => ipc.configure(f.settingsEvent, input) }); await panel.load();
    const input = root.querySelector<HTMLInputElement>('[data-memory-automation="language"]')!; input.checked = true; input.dispatchEvent(new dom.window.Event("change"));
    await expect.poll(async () => (await f.memory.automationHost.state(f.settingsEvent)).config.language).toBe(true);
    const quote = "I always prefer English for our chats", run = await finishTurn(f, quote);
    f.respond(async () => Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ subject: "user", attribute: "language", value: "en", polarity: "positive", status: "asserted", quote, reason: "durable first-person statement" }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    await f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await run.close();
    const state = await f.memory.settingsHost.getState(f.settingsEvent); expect(state.facts).toMatchObject([{ assertion: "用户回复语言：en", policyVersion: "natural-add-v1" }]); expect(state.candidates).toEqual([]);
    const request = JSON.parse(await turnIn(f, "automation-read", "chat", null, "hello"));
    const memory = request.messages.find((message: any) => message.content.startsWith(MEMORY_MARKER)); expect(memory).toMatchObject({ role: "user" }); expect(memory.content).toContain("用户回复语言：en");
    expect(request.messages.filter((message: any) => message.role === "system").some((message: any) => message.content.includes("用户回复语言：en"))).toBe(false);
  } finally { dom.window.close(); }
});

it("settings off/on remains responsive during a blocked send and removes that result's automatic authority", async () => {
  const f = await fixture("chat", { withoutShadow: true }); expect(f.memory.automationHost).toBeDefined();
  await f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 0, language: true, responseStyle: false });
  const quote = "I always prefer English for our chats", run = await finishTurn(f, quote);
  let arrived!: () => void, release!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.respond(async () => { arrived(); await gate; return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ subject: "user", attribute: "language", value: "en", polarity: "positive", status: "asserted", quote, reason: "durable statement" }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }); });
  const sending = f.memory.onTurnSucceeded({ sessionId: "session-a", runId: "run-a" }); await started;
  try {
    await f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 1, language: false, responseStyle: false });
    expect((await f.memory.automationHost.configure(f.settingsEvent, { expectedRevision: 2, language: true, responseStyle: false })).config.revision).toBe(3);
  } finally { release(); }
  await sending; await run.close(); const state = await f.memory.settingsHost.getState(f.settingsEvent); expect(state.facts).toEqual([]); expect(state.candidates).toMatchObject([{ assertion: "用户回复语言：en", reason: "model-needs-confirmation" }]);
});

it("a tool preference stated in one project is injected only into that project's sessions", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-alpha", "code", "alpha", "I prefer bash");
  const same = await turnIn(f, "ask-alpha", "code", "alpha", "give me a terminal command");
  expect(same).toContain(MEMORY_MARKER); expect(same).toContain("I prefer bash");
  const other = await turnIn(f, "ask-beta", "code", "beta", "give me a terminal command");
  expect(other).not.toContain(MEMORY_MARKER); expect(other).not.toContain("I prefer bash");
  const chat = await turnIn(f, "ask-chat", "chat", null, "give me a terminal command");
  expect(chat).not.toContain(MEMORY_MARKER); expect(chat).not.toContain("I prefer bash");
});

it("a global preference stated in Chat still reaches every project", async () => {
  const f = await fixture("chat");
  await turnIn(f, "learn-chat", "chat", null, "请叫我小林");
  const alpha = await turnIn(f, "ask-alpha", "code", "alpha", "hello there");
  expect(alpha).toContain(MEMORY_MARKER); expect(alpha).toContain("请叫我小林");
});

it("rebinding a session to another workspace changes which project facts it sees", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-alpha", "code", "alpha", "I prefer bash");
  f.sessions.set("mover", { id: "mover", mode: "code", messages: [], modelProfileId: "luna", workspaceBinding: binding("beta") });
  f.select("mover"); await f.user("mover", "give me a terminal command", "u-mover-1"); let admission = f.memory.authorizeRun(f.event, "mover");
  let run = await f.memory.openRun(f.input("mover", "run-mover-1")); await run.call(f.call());
  expect(f.sent.at(-1)).not.toContain(MEMORY_MARKER);
  await run.close(); admission.release();
  f.sessions.get("mover").workspaceBinding = binding("alpha");
  await f.user("mover", "give me a terminal command", "u-mover-2"); admission = f.memory.authorizeRun(f.event, "mover");
  run = await f.memory.openRun(f.input("mover", "run-mover-2")); await run.call(f.call());
  expect(f.sent.at(-1)).toContain(MEMORY_MARKER); expect(f.sent.at(-1)).toContain("I prefer bash");
  await run.close(); admission.release();
});

// ── Project isolation also bounds which other sessions' raw history a turn may read ──
async function historyTurn(f: Awaited<ReturnType<typeof fixture>>, id: string, mode: "chat" | "code", workspace: string | null, text: string) {
  f.sessions.set(id, { id, mode, messages: [], modelProfileId: "luna", ...(workspace ? { workspaceBinding: binding(workspace) } : {}) });
  f.select(id); await f.user(id, text, "u-" + id); await f.store.checkpoint(id);
  await primeHistory(f,id);
}
it("a project session reads history from its own project and from unbound chats, never from another project", async () => {
  const f = await fixture("code");
  await historyTurn(f, "h-alpha", "code", "alpha", "zephyr alphamark");
  await historyTurn(f, "h-beta", "code", "beta", "zephyr betamark");
  await historyTurn(f, "h-chat", "chat", null, "zephyr chatmark");
  const request = await turnIn(f, "ask-alpha", "code", "alpha", "zephyr");
  expect(request).toContain("alphamark"); expect(request).toContain("chatmark"); expect(request).not.toContain("betamark");
});

it("an unbound session never reads project history", async () => {
  const f = await fixture("code");
  await historyTurn(f, "h-alpha", "code", "alpha", "zephyr alphamark");
  await historyTurn(f, "h-chat", "chat", null, "zephyr chatmark");
  const request = await turnIn(f, "ask-chat", "chat", null, "zephyr");
  expect(request).toContain("chatmark"); expect(request).not.toContain("alphamark");
});

// ── The settings view says where a memory applies and which project it belongs to ──
it("settings state labels a project fact with its project name and a global fact as global, without exposing the project key", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-alpha", "code", "alpha", "I prefer bash");
  await turnIn(f, "learn-chat", "chat", null, "请叫我小林");
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  const byText = (text: string) => state.facts.find((fact: any) => fact.assertion.includes(text)) as any;
  expect(byText("bash")).toMatchObject({ scope: "project", projectName: "alpha", attribute: "shell" });
  expect(byText("小林")).toMatchObject({ scope: "global", attribute: "address" }); expect(byText("小林").projectName).toBeUndefined();
  expect(JSON.stringify(state)).not.toMatch(/project-[a-f0-9]{64}/);
});

it("settings state tells two same-named projects apart by an opaque reference that is not the project key", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-work", "code", "app", "I prefer bash", "C:\\work\\app");
  await turnIn(f, "learn-home", "code", "app", "I prefer bash", "C:\\personal\\app");
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  const projectFacts = state.facts.filter((fact: any) => fact.scope === "project") as any[];
  expect(projectFacts.map(fact => fact.projectName)).toEqual(["app", "app"]);
  expect(projectFacts.every(fact => /^[a-f0-9]{16}$/.test(fact.projectRef))).toBe(true);
  expect(new Set(projectFacts.map(fact => fact.projectRef)).size).toBe(2);
  expect(JSON.stringify(state)).not.toMatch(/project-[a-f0-9]{64}/);
  // Stable while the app runs, so the graph keeps its nodes across refreshes.
  const again = await f.memory.settingsHost.getState(f.settingsEvent);
  expect((again.facts as any[]).filter(fact => fact.scope === "project").map(fact => fact.projectRef).sort()).toEqual(projectFacts.map(fact => fact.projectRef).sort());
});

it("settings state names the conversation a fact came from, and leaves it out when the session is gone or untitled", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-title", "chat", null, "请叫我小林");
  await turnIn(f, "learn-untitled", "code", "alpha", "I prefer bash");
  f.sessions.get("learn-title").title = "  周末聊天  ";
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  const byText = (text: string) => state.facts.find((fact: any) => fact.assertion.includes(text)) as any;
  expect(byText("小林").sourceTitle).toBe("周末聊天"); expect(byText("bash")).not.toHaveProperty("sourceTitle");
  f.sessions.delete("learn-title");
  expect(((await f.memory.settingsHost.getState(f.settingsEvent)).facts.find((fact: any) => fact.assertion.includes("小林")) as any)).not.toHaveProperty("sourceTitle");
});
it("a project fact keeps its scope but loses the name once no session is bound to that project any more", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-alpha", "code", "alpha", "I prefer bash");
  f.sessions.delete("learn-alpha");
  const fact = (await f.memory.settingsHost.getState(f.settingsEvent)).facts.find((item: any) => item.assertion.includes("bash")) as any;
  expect(fact.scope).toBe("project"); expect(fact.projectName).toBeUndefined();
});

it("settings state reads only the listed memories' own source sessions when none belongs to a project", async () => {
  const f = await fixture("chat");
  await turnIn(f, "learn-chat", "chat", null, "请叫我小林");
  f.sessions.set("unrelated", { id: "unrelated", mode: "chat", messages: [], modelProfileId: "luna" });
  const get = vi.spyOn(f.sessions, "get"); get.mockClear();
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  expect(state.facts.some((fact: any) => fact.assertion.includes("小林"))).toBe(true);
  // The conversation title of each memory's source; no scan of other sessions for project names.
  expect(new Set(get.mock.calls.map(([id]) => id))).toEqual(new Set(["learn-chat"]));
});
it("a session that cannot be read never fails the settings list; the project fact just has no name", async () => {
  const f = await fixture("code");
  await turnIn(f, "learn-alpha", "code", "alpha", "I prefer bash");
  vi.spyOn(f.sessions, "get").mockImplementation(() => { throw new Error("SESSION_READ_FAILED"); });
  const state = await f.memory.settingsHost.getState(f.settingsEvent);
  const fact = state.facts.find((item: any) => item.assertion.includes("bash")) as any;
  expect(fact).toMatchObject({ scope: "project" }); expect(fact.projectName).toBeUndefined();
});
