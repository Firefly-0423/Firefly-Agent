import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { composePromptLayers } from "../orchestrator/prompt-layers";
import { createTranscriptSink, requireTranscriptSinkBinding, wrapTranscriptSink } from "../orchestrator/transcript-sink";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { OpenAICompatAdapter } from "../orchestrator/vendors/openai-adapter";
import { AnthropicAdapter } from "../orchestrator/vendors/anthropic-adapter";
import { setVendorRuntimeSettingsGetter } from "../orchestrator/vendors/runtime-settings";
import type { ProviderCapability, VendorConfig } from "../orchestrator/vendors/types";
import { createConversationTranscriptAdapter } from "./conversation-transcript-adapter";
import { createMemoryRunAuthority } from "./main-memory-contracts";
import { createMemorySessionModes } from "./memory-session-modes";
import { resolveMemoryCounter } from "./model-counting";
import { createSmhFixture } from "./smh-fixture.test-support";
import { createMainMemoryRuntime, type MainMemoryCapture, type MainMemoryModelBinding } from "./main-memory-runtime";
import { createDefaultRunCapture } from "./default-run-capture";

// Real prompt-dump I/O stays in a test-owned home even with diagnostics enabled.
const diagnosticIO = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostic-home-")), pending: [] as Promise<void>[] };
});
vi.mock("os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => diagnosticIO.home }, homedir: () => diagnosticIO.home };
});
vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFile: typeof actual.writeFile = ((...args: Parameters<typeof actual.writeFile>) => {
    const callback = args.at(-1) as (error: NodeJS.ErrnoException | null) => void;
    diagnosticIO.pending.push(new Promise<void>(resolve => {
      args[args.length - 1] = (error: NodeJS.ErrnoException | null) => { try { callback(error); } finally { resolve(); } };
      Reflect.apply(actual.writeFile, actual, args);
    }));
  }) as typeof actual.writeFile;
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});
beforeAll(() => { vi.stubEnv("FIREFLY_PROMPT_DUMP", "1"); });
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(diagnosticIO.home, { recursive: true, force: true }); });

vi.mock("../token-usage-store", () => ({ recordModelCall: () => undefined, recordToolCall: () => undefined, recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => { throw Error("PRODUCT_DATA_READ_FORBIDDEN"); } } }));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { await Promise.all(diagnosticIO.pending.splice(0)); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setVendorRuntimeSettingsGetter(() => ({})); });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(mode: "persistent" | "temporary" = "persistent", temporaryCaptureSupported = false, options: { defaultCapture?: boolean; anthropic?: boolean; attachmentProjection?: object; attachments?: import("../../shared/chat-types").PendingChatAttachment[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-runtime-"));
  const f = createSmhFixture(root); cleanup.push(() => { f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new ConversationTranscriptStore(path.join(root, "conversation"));
  const modes = createMemorySessionModes(); modes.bind("session-a", mode); modes.bind("session-b", mode);
  let revision = 1, captured = 0, closed = 0, temporaryRevision = 1, temporaryText = "trusted ephemeral question";
  let countHook: (() => Promise<void>) | undefined, captureHook: (() => Promise<void>) | undefined;
  let captureOverride: ((capture: MainMemoryCapture) => MainMemoryCapture) | undefined;
  let runtimeContext: Parameters<Parameters<typeof createMainMemoryRuntime>[0]["createCapture"]>[0]["context"] | undefined;
  let runtimeTranscript: NonNullable<ReturnType<typeof createConversationTranscriptAdapter>> | undefined;
  const actor = mode === "persistent" ? f.actor : f.actorAuthority.bindActor(f.access, f.adapter, f.identity, { sessionMode: mode });
  const sibling = f.actorAuthority.bindActor(f.access, f.adapter, { ...f.identity, sessionId: "session-b" }, { sessionMode: mode });
  const runAuthority = createMemoryRunAuthority({ actors: f.actorAuthority, sessionModes: modes,
    resolveProfile: id => id === "saved-secondary" ? { id, revision } : null,
    resolveEntry: () => ({ revision: 1 }), canRead: (from, to) => from.actorKey === to.actorKey });
  const config: VendorConfig = { provider: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", apiKey: "synthetic-secret-do-not-log", explicitTransport: "openai" };
  const capability: ProviderCapability = { id: "openrouter", displayName: "OpenRouter", baseUrl: config.baseUrl, transport: "openai", authStyle: "bearer", defaultModel: config.model, supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content", cacheStrategy: "none", testStrategy: "text+tool" };
  if (options.anthropic) {
    Object.assign(config, { model: "synthetic-model", explicitTransport: "anthropic" });
    Object.assign(capability, { transport: "anthropic", authStyle: "x-api-key", defaultModel: config.model, thinkingField: "thinking" });
  }
  const adapter = options.anthropic ? new AnthropicAdapter(capability.id, capability) : new OpenAICompatAdapter("openrouter", capability);
  const baseCounter = resolveMemoryCounter(config, revision), counted: string[] = [], sent: string[] = [];
  const counter = { capability: baseCounter.capability, count: async (...args: Parameters<typeof baseCounter.count>) => { counted.push(JSON.stringify(args[0].body)); await countHook?.(); return baseCounter.count(...args); } };
  const binding: MainMemoryModelBinding = { profileId: "saved-secondary", revision, config, adapter, counter,
    budget: { admissionMode: "bounded", maxContextTokens: 100000, reservedOutputTokens: options.anthropic ? 32768 : 8192, safetyMarginTokens: 512, maxSTokens: 30000, minRecentCompleteTurns: 1 },
    assertCurrent: () => { if (revision !== 1) throw Error("MEMORY_RUN_PROFILE_CHANGED"); } };
  let fetchHook: ((request: Request) => Promise<Response>) | undefined;
  vi.stubGlobal("fetch", async (source: RequestInfo | URL, init?: RequestInit) => { const request = new Request(source, init); sent.push(await request.clone().text());
    if (fetchHook) return fetchHook(request);
    return Response.json({ choices: [{ message: { role: "assistant", content: "synthetic reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } }); });
  const runtime = createMainMemoryRuntime({ actorAuthority: f.actorAuthority, registry: f.registry, transport: f.transport, runAuthority,
    clock: () => 1700000000000, resolveModel: () => binding,
    ...(temporaryCaptureSupported ? { createTemporaryCapture: () => ({ captureTemporary: async () => {
      const revision = temporaryRevision; return { units: [{ id: "ephemeral-turn", kind: "recent" as const, messages: [{ role: "user" as const, text: temporaryText }] }],
        assertCurrent: () => { if (revision !== temporaryRevision) throw Error("MEMORY_CONTEXT_TRANSCRIPT_STALE"); } };
    } }) } : {}),
    createCapture: ({ context, run }) => {
      if (options.defaultCapture) return createDefaultRunCapture({ context, actorAuthority: f.actorAuthority, actorToken: run.actorToken,
        registry: f.registry, store, conversationId: run.identity.sessionId, runId: run.identity.runId, assistantTurnId: "assistant-turn", attachmentProjection: options.attachmentProjection });
      const transcript = createConversationTranscriptAdapter({ enabled: true, store, context, actorAuthority: f.actorAuthority, actorToken: run.actorToken, attachmentProjection: options.attachmentProjection })!;
      runtimeContext = context; runtimeTranscript = transcript;
      const capture: MainMemoryCapture = { capture: async () => { captured++; await captureHook?.(); const current = await transcript.captureRun();
        return { sourceRefs: [], transcriptTokens: current.transcriptTokens, assertCurrent: current.assertCurrent, currentTranscript: { token: current.transcriptTokens.at(-1)!, user: { turnId: current.userTurnId, revision: current.userRevision } } }; }, close: () => transcript.close() };
      return captureOverride?.(capture) ?? capture;
    }, close: async () => { closed++; } });
  cleanup.push(() => runtime.close());
  function grant(sessionId = "session-a", runId = "run-a", readActorTokens: object[] = []) { return runAuthority.issue({ identity: { entry: "desktop", sessionId, runId, modelProfileId: "saved-secondary", sessionMode: mode }, actorToken: sessionId === "session-a" ? actor : sibling, sourceProvider: f.adapter, readActorTokens, signal: new AbortController().signal }); }
  const input = () => ({ adapter, config, timeoutMs: 1200, request: { model: config.model, stream: false, messages: [{ role: "system" as const, content: "fixed persona and document" }, { role: "user" as const, content: "caller history must be replaced" }], tools: [{ name: "lookup", description: "synthetic tool", parameters: { type: "object", properties: { query: { type: "string" } } } }] } });
  await store.append("session-a", { id: "u1", at: 1000, kind: "user", turnId: "u1", revision: 1, payload: { text: "canonical question 中文", ...(options.attachments ? { attachments: options.attachments } : {}) } });
  await store.append("session-b", { id: "u2", at: 1000, kind: "user", turnId: "u2", revision: 1, payload: { text: "independent second question" } });
  return { ...f, get reads() { return f.reads; }, store, runtime, runAuthority, binding, config, actor, sibling, grant, input, counted, sent,
    runtimeContext: () => runtimeContext!, runtimeTranscript: () => runtimeTranscript!, captures: () => captured, closes: () => closed, drift: () => { revision++; }, mutateTemporary: () => { temporaryRevision++; }, setTemporaryText: (text: string) => { temporaryText = text; temporaryRevision++; },
    onCount: (hook?: typeof countHook) => { countHook = hook; }, onCapture: (hook?: typeof captureHook) => { captureHook = hook; },
    overrideCapture: (hook: NonNullable<typeof captureOverride>) => { captureOverride = hook; }, onFetch: (hook: NonNullable<typeof fetchHook>) => { fetchHook = hook; } };
}

it("uses genuine grants and canonical S with the unchanged saved non-default model", async () => {
  const f = await fixture(), before = JSON.stringify(f.config), run = await f.runtime.openRun(f.grant());
  const response = await run.call(f.input());
  expect(response.text).toBe("synthetic reply"); expect(f.sent).toHaveLength(1); expect(f.counted).toContain(f.sent[0]);
  expect(f.sent[0]).toContain("canonical question 中文"); expect(f.sent[0]).toContain("fixed persona and document"); expect(f.sent[0]).not.toContain("caller history must be replaced");
  expect(f.sent[0]).toContain("openai/gpt-6-luna"); expect(f.sent[0]).toContain("lookup"); expect(JSON.stringify(f.config)).toBe(before);
  expect(f.commands.filter((c: any) => c.kind === "claim")).toHaveLength(1);
  expect(f.commands.filter((c: any) => c.kind === "confirmUse")).toHaveLength(1);
  expect(await f.policy.recall(f.actor)).toEqual([]);
});

it.each([
  ["temporary", "success"], ["temporary", "failure"], ["temporary", "cancel"],
  ["persistent", "success"], ["persistent", "failure"], ["persistent", "cancel"],
] as const)("%s streaming diagnostics respect trusted persistence on %s", async (mode, terminal) => {
  const f = await fixture(mode, mode === "temporary"), run = await f.runtime.openRun(f.grant());
  const sentinel = `diagnostic-${mode}-${terminal}`, controller = new AbortController();
  const dumpRoot = path.join(diagnosticIO.home, ".firefly", "prompt-dumps");
  const before = new Set(fs.existsSync(dumpRoot) ? fs.readdirSync(dumpRoot, { recursive: true }).map(String) : []);
  f.setTemporaryText(sentinel);
  if (mode === "persistent") await f.store.append("session-a", { id: "diagnostic-user", at: 2000, kind: "user", turnId: "diagnostic-user", revision: 1, payload: { text: sentinel } });
  f.onFetch(async () => terminal === "failure"
    ? Response.json({ error: { message: sentinel } }, { status: 400 })
    : new Response([
      { choices: [{ delta: { content: sentinel }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const input = f.input(); input.request.stream = true;
  const result = run.call({ ...input, signal: controller.signal,
    // Caller metadata must never override the genuine temporary run's policy.
    ...({ persistDiagnostics: true } as object),
    onDelta: () => { if (terminal === "cancel") controller.abort(new DOMException(sentinel, "AbortError")); },
  });
  if (terminal === "success") await expect(result).resolves.toMatchObject({ text: sentinel });
  else await expect(result).rejects.toThrow();
  await Promise.all(diagnosticIO.pending);
  const files = fs.existsSync(dumpRoot) ? fs.readdirSync(dumpRoot, { recursive: true }).map(String).filter(file => file.endsWith(".json")) : [];
  const payloads = files.map(file => fs.readFileSync(path.join(dumpRoot, file), "utf8")).filter(text => text.includes(sentinel)).map(text => JSON.parse(text));
  if (mode === "temporary") { expect(files.filter(file => !before.has(file))).toEqual([]); expect(payloads).toEqual([]); }
  else {
    const request = payloads.find(payload => payload.phase === "request"); expect(request?.body).toBeDefined();
    const response = files.map(file => JSON.parse(fs.readFileSync(path.join(dumpRoot, file), "utf8"))).find(payload => payload.phase === "response" && payload.traceId === request.traceId);
    expect(response).toMatchObject({ ok: terminal === "success" });
    if (terminal === "success") expect(response.text).toBe(sentinel);
  }
});

it("rejects forged grants before captures, counting, or persistent commands", async () => {
  const f = await fixture(), before = f.commands.length;
  await expect(f.runtime.openRun({} as never)).rejects.toThrow("MEMORY_RUN_DENIED");
  expect(f.captures()).toBe(0); expect(f.counted).toEqual([]); expect(f.sent).toEqual([]); expect(f.commands).toHaveLength(before);
});

it("keeps two independent runs alive without retaining the shared mutation queue during model waits", async () => {
  const f = await fixture(), firstStarted = deferred(), release = deferred<Response>();
  f.onFetch(async request => { if ((await request.clone().text()).includes("canonical question")) { firstStarted.resolve(); return release.promise; } return Response.json({ choices: [{ message: { role: "assistant", content: "second" }, finish_reason: "stop" }] }); });
  const a = await f.runtime.openRun(f.grant()), b = await f.runtime.openRun(f.grant("session-b", "run-b"));
  const one = a.call(f.input()); await firstStarted.promise;
  await expect(b.call(f.input())).resolves.toMatchObject({ text: "second" });
  await expect(f.actorAuthority.coordinate(() => "queue available")).resolves.toBe("queue available");
  release.resolve(Response.json({ choices: [{ message: { role: "assistant", content: "first" }, finish_reason: "stop" }] }));
  await expect(one).resolves.toMatchObject({ text: "first" }); expect(f.sent).toHaveLength(2);
  expect(f.sent[1]).not.toContain("canonical question");
});

it("uses a fresh permit and private prepared handle for every call", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant());
  await run.call(f.input()); await run.call(f.input());
  expect(f.sent).toHaveLength(2); expect(f.sent[0]).toBe(f.sent[1]);
  expect(f.commands.filter((c: any) => c.kind === "claim")).toHaveLength(2);
});

it("rejects source mutation during counting before provider dispatch", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()); let changed = false;
  f.onCount(async () => { if (changed) return; changed = true; await f.store.append("session-a", { id: "edit", at: 2000, kind: "turn_rewind", turnId: "u1", revision: 2, payload: { anchorUserTurnId: "u1", disposition: "replace_user", reason: "edit", replacementUser: { text: "edited question" } } }); });
  await expect(run.call(f.input())).rejects.toThrow(/MEMORY_/); expect(f.sent).toEqual([]);
});

it("revokes a profile binding that changes while counting", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()); f.onCount(async () => { f.drift(); });
  await expect(run.call(f.input())).rejects.toThrow(/MEMORY_/); expect(f.sent).toEqual([]);
});

it("quiesces immediately but drains the actual started provider operation before closing resources", async () => {
  const f = await fixture(), started = deferred(), release = deferred<Response>(); f.onFetch(async () => { started.resolve(); return release.promise; });
  const run = await f.runtime.openRun(f.grant()), call = run.call(f.input()); const rejected = expect(call).rejects.toThrow(/MEMORY_CONTEXT_(CANCELLED|SEND_UNKNOWN)/); await started.promise;
  f.runtime.quiesce(); const closing = f.runtime.close();
  await expect(f.runtime.openRun(f.grant("session-b", "late"))).rejects.toThrow("MEMORY_CONTEXT_RUNTIME_CLOSED");
  expect(f.closes()).toBe(0); release.resolve(Response.json({ choices: [{ message: { role: "assistant", content: "late" }, finish_reason: "stop" }] }));
  await rejected; await closing; expect(f.closes()).toBe(1);
});

it("temporary runs fail closed before any persistent M, H, or context command", async () => {
  const f = await fixture("temporary"), before = f.commands.length;
  await expect(f.runtime.openRun(f.grant())).rejects.toThrow("MEMORY_CONTEXT_TEMPORARY_UNSUPPORTED");
  expect(f.commands).toHaveLength(before); expect(f.captures()).toBe(0); expect(f.sent).toEqual([]);
});

it("unsupported capture rejects without leaking raw provider text or secrets", async () => {
  const f = await fixture(); f.overrideCapture(capture => ({ ...capture, capture: async () => { throw Error("private source text synthetic-secret-do-not-log"); } }));
  const run = await f.runtime.openRun(f.grant());
  await expect(run.call(f.input())).rejects.toThrow(/^MEMORY_CONTEXT_CAPTURE_FAILED$/); expect(f.sent).toEqual([]);
});

it("detaches caller messages and schemas before asynchronous capture", async () => {
  const f = await fixture(), started = deferred(), release = deferred(); f.onCapture(async () => { started.resolve(); await release.promise; });
  const run = await f.runtime.openRun(f.grant()), input = f.input(), pending = run.call(input); await started.promise;
  input.request.messages[0].content = "mutated fixed text"; input.request.tools[0].description = "mutated tool schema"; release.resolve();
  await pending; expect(f.sent[0]).toContain("fixed persona and document"); expect(f.sent[0]).not.toContain("mutated");
});


it("uses trusted ephemeral S without any persistent M, H, or context command", async () => {
  const f = await fixture("temporary", true), before = f.commands.length, run = await f.runtime.openRun(f.grant());
  await expect(run.call(f.input())).resolves.toMatchObject({ text: "synthetic reply" });
  expect(f.commands).toHaveLength(before); expect(f.sent[0]).toContain("trusted ephemeral question");
  expect(f.sent[0]).not.toContain("caller history must be replaced"); expect(f.counted).toContain(f.sent[0]);
  await run.close(); expect(f.commands).toHaveLength(before);
});

it("invalidates a changed ephemeral capture after counting and sends nothing", async () => {
  const f = await fixture("temporary", true), before = f.commands.length, run = await f.runtime.openRun(f.grant());
  f.onCount(async () => { f.mutateTemporary(); });
  await expect(run.call(f.input())).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  expect(f.sent).toEqual([]); expect(f.commands).toHaveLength(before);
});


it("denies ungranted cross-session M supports before reading the source", async () => {
  const f = await fixture(), source = await f.source("I prefer bash", { sessionId: "session-b" });
  const fact = await f.policy.ingest(f.sibling, source.ref);
  expect(fact.factId).toBeTruthy();
  f.overrideCapture(capture => ({ ...capture, capture: async (...args) => ({ ...await capture.capture(...args), factRefs: [{ factId: fact.factId!, revision: 1 }] }) }));
  const run = await f.runtime.openRun(f.grant()), readsBefore = f.reads;
  await expect(run.call(f.input())).rejects.toThrow("MEMORY_RUN_READ_DENIED");
  expect(f.reads).toBe(readsBefore); expect(f.sent).toEqual([]);
});

it("includes authorized M assertions with their actual source and time provenance", async () => {
  const f = await fixture(), source = await f.source("I prefer bash", { sessionId: "session-b", occurredAt: 1699999999000 });
  const fact = await f.policy.ingest(f.sibling, source.ref);
  f.overrideCapture(capture => ({ ...capture, capture: async (...args) => ({ ...await capture.capture(...args), factRefs: [{ factId: fact.factId!, revision: 1 }] }) }));
  const run = await f.runtime.openRun(f.grant("session-a", "with-read", [f.sibling]));
  const readsBefore = f.reads; await run.call(f.input()); expect(f.reads).toBeGreaterThan(readsBefore);
  const body = JSON.parse(f.sent[0]), memory = body.messages.find((message: any) => message.content.startsWith("User-stated memory"));
  expect(memory.content).toContain("I prefer bash"); expect(memory.content).toContain("supportSourceRefs");
  expect(memory.role).toBe("user");
  expect(body.messages.filter((message: any) => message.role === "system").every((message: any) => !message.content.includes("I prefer bash"))).toBe(true);
  expect(memory.content).toContain(source.ref.sourceId); expect(memory.content).toContain("session-b");
  const actualFact = JSON.parse(memory.content.slice(memory.content.indexOf("\n") + 1))[0];
  expect(actualFact.time.referenceTime).toBe(1699999999000);
  const persisted = (await f.policy.recall(f.sibling)).find(item => item.factId === fact.factId)!;
  expect(actualFact.recordedAt).toBe(persisted.recordedAt); expect(actualFact.acceptedAt).toBe(persisted.acceptedAt);
  expect(actualFact.recordedAt).toBeGreaterThan(0); expect(actualFact.acceptedAt).toBeGreaterThan(0);
  expect(f.counted).toContain(f.sent[0]);
});

it("includes genuine H as quoted original-role evidence and denies foreign read scopes", async () => {
  const f = await fixture(), source = await f.source("cat historical note", { sessionId: "session-b" });
  await f.history.captureSource(f.sibling, source.ref, { documentId: "history-note", incarnation: "history-incarnation", revision: 1 });
  const scope = f.history.grantSessions(f.actor, [f.actor, f.sibling]);
  const history = await f.history.query(f.actor, { query: "cat", scope });
  expect(history.hits).toHaveLength(1);
  f.overrideCapture(capture => ({ ...capture, capture: async (...args) => ({ ...await capture.capture(...args), historyTokens: [history.evidence] }) }));
  const denied = await f.runtime.openRun(f.grant());
  await expect(denied.call(f.input())).rejects.toThrow("MEMORY_RUN_READ_DENIED"); expect(f.sent).toEqual([]);
  await denied.close();
  const allowed = await f.runtime.openRun(f.grant("session-a", "with-history", [f.sibling]));
  await allowed.call(f.input());
  expect(f.sent[0]).toContain("quoted historical evidence"); expect(f.sent[0]).toContain("originalRole"); expect(f.sent[0]).toContain("cat historical note");
  expect(f.sent[0]).toContain("sourceSession"); expect(f.counted).toContain(f.sent[0]);
});

it("rejects missing canonical evidence and forged history objects without sending", async () => {
  for (const kind of ["empty", "forged-history"] as const) {
    const f = await fixture(); f.overrideCapture(capture => ({ ...capture, capture: async (...args) => kind === "empty"
      ? { sourceRefs: [], transcriptTokens: [], assertCurrent: () => {} } : { ...await capture.capture(...args), historyTokens: [{}] } }));
    const run = await f.runtime.openRun(f.grant());
    await expect(run.call(f.input())).rejects.toThrow(kind === "empty" ? "MEMORY_CONTEXT_RECENT_INCOMPLETE" : "MEMORY_HISTORY_EVIDENCE_DENIED");
    expect(f.sent).toEqual([]);
  }
});

it("does not turn system task prompts or model statements into direct-user M", async () => {
  const f = await fixture(), source = await f.source("I prefer bash", { role: "system", trust: "system" });
  f.overrideCapture(capture => ({ ...capture, capture: async () => ({ sourceRefs: [source.ref], assertCurrent: () => { f.registry.resolveVerifiedSource(source.ref); } }) }));
  const run = await f.runtime.openRun(f.grant()); await run.call(f.input());
  expect(f.sent[0]).toContain("I prefer bash"); expect(await f.policy.recall(f.actor)).toEqual([]);
  expect(f.commands.some((command: any) => ["ingest", "integrate"].includes(command.kind))).toBe(false);
});


it("rejects a stale resolved binding revision even if the binding callback claims current", async () => {
  const f = await fixture(); (f.binding as { revision: number }).revision = 2;
  await expect(f.runtime.openRun(f.grant())).rejects.toThrow("MEMORY_RUN_PROFILE_CHANGED");
  expect(f.captures()).toBe(0); expect(f.sent).toEqual([]);
});

it("does not send after uncertain admission and drains its started final validation", async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  const original = f.transport.contextCommand;
  f.transport.contextCommand = async (command: any) => {
    if (command.kind === "confirmUse") throw Error("private ambiguous transport failure");
    if (command.kind === "validateResponse") { started.resolve(); await release.promise; }
    return original(command);
  };
  const run = await f.runtime.openRun(f.grant()), pending = run.call(f.input());
  await expect(pending).rejects.toThrow("MEMORY_CONTEXT_SEND_UNKNOWN"); await started.promise;
  const closing = f.runtime.close(); expect(f.closes()).toBe(0);
  release.resolve();
  await closing; expect(f.closes()).toBe(1); expect(f.sent).toHaveLength(0);
});

it("keeps close errors secret-free", async () => {
  const f = await fixture(); f.overrideCapture(capture => ({ ...capture, close: async () => { await capture.close?.(); throw Error("private source text secret close details"); } }));
  const run = await f.runtime.openRun(f.grant()); await run.call(f.input());
  await expect(run.close()).rejects.toThrow(/^MEMORY_CONTEXT_CLOSE_FAILED$/);
  // The same settled close remains explicit; no unhandled cleanup rejection.
  await expect(f.runtime.close()).rejects.toThrow("MEMORY_CONTEXT_CLOSE_FAILED");
  cleanup.pop();
});

it("gives the trusted response hook the exact opaque successful snapshot", async () => {
  const f = await fixture(); let snapshot: object | undefined;
  // Capture adapter owns context, and receives only the opaque successful snapshot.
  f.overrideCapture(capture => ({ ...capture, onResponse: async (response: { snapshot: object }) => { snapshot = response.snapshot; } }));
  const run = await f.runtime.openRun(f.grant());
  await run.call(f.input()); expect(snapshot).toBeDefined(); expect(Object.isFrozen(snapshot)).toBe(true);
  expect(f.sent).toHaveLength(1);
});

it("rejects a response hook failure without returning success, resending, or leaking source text", async () => {
  const f = await fixture(); f.overrideCapture(capture => ({ ...capture, onResponse: async () => { throw Error("private source response failure"); } }));
  const run = await f.runtime.openRun(f.grant());
  await expect(run.call(f.input())).rejects.toThrow(/^MEMORY_CONTEXT_RESPONSE_FAILED$/); expect(f.sent).toHaveLength(1);
});

it("cancels and drains a started trusted response hook before closing", async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  f.overrideCapture(capture => ({ ...capture, onResponse: async () => { started.resolve(); await release.promise; } }));
  const run = await f.runtime.openRun(f.grant()), call = run.call(f.input());
  const rejected = expect(call).rejects.toThrow("MEMORY_CONTEXT_CANCELLED"); await started.promise;
  const closing = f.runtime.close(); expect(f.closes()).toBe(0); release.resolve();
  await rejected; await closing; expect(f.closes()).toBe(1); expect(f.sent).toHaveLength(1);
});


it("reuses the counted frozen frame for a genuine post-response canonical commit", async () => {
  const f = await fixture(); let snapshot: object | undefined;
  f.overrideCapture(capture => ({ ...capture, onResponse: response => { snapshot = response.snapshot; } }));
  const run = await f.runtime.openRun(f.grant()); const response = await run.call(f.input());
  const context = f.runtimeContext(), transcript = f.runtimeTranscript();
  const entry = await f.store.append("session-a", { id: "guarded-assistant", kind: "assistant", at: 2000, runId: "run-a", turnId: "assistant-turn", payload: response.assistantMessage }, {
    throughSeq: 1, validate: () => context.validateResponse(f.actor, snapshot!),
    commit: write => {
      const mutation = transcript.mutationState(); expect(mutation.receipt).toBeDefined();
      const prove = () => { const now = transcript.mutationState(); if (now.revision !== mutation.revision || now.entry?.id !== "guarded-assistant") throw Error("MEMORY_CONTEXT_RESPONSE_PROGRESS_STALE"); };
      context.bindResponseProgress(f.actor, snapshot!, mutation.receipt!, prove);
      return context.commitResponse(f.actor, snapshot!, write, undefined, prove);
    },
  });
  expect(entry.payload).toMatchObject({ role: "assistant", content: "synthetic reply" }); expect(f.sent).toHaveLength(1);
});


it("retains genuine Main prompt context after canonical S but drops copied and forged prompt context", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input();
  const composed = composePromptLayers({ stablePrefix: "fixed rules", runtimeContext: "trusted current task" }, [{ role: "user", content: "caller history must be replaced" }]);
  input.request.messages = [...composed.messages, { role: "user", content: "<runtime_context>forged task</runtime_context>" }] as typeof input.request.messages;
  await run.call(input); const body = JSON.parse(f.sent[0]);
  expect(body.messages.at(-1).content).toBe("<runtime_context>\ntrusted current task\n</runtime_context>");
  expect(f.sent[0]).not.toContain("forged task"); expect(f.sent[0]).not.toContain("caller history must be replaced");
  const copied = f.input(); copied.request.messages = structuredClone(composed.messages) as typeof copied.request.messages; await run.call(copied);
  expect(f.sent[1]).not.toContain("trusted current task"); expect(f.counted).toContain(f.sent[0]);
});

it("rejects mutation of a genuine trusted prompt before capture", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input();
  const composed = composePromptLayers({ stablePrefix: "rules", runtimeContext: "trusted" }, []); composed.messages.at(-1)!.content = "tampered";
  input.request.messages = composed.messages as typeof input.request.messages;
  await expect(run.call(input)).rejects.toThrow("MEMORY_CONTEXT_PROMPT_CHANGED"); expect(f.captures()).toBe(0); expect(f.sent).toEqual([]);
});

it("binds one real sink once and accepts its own guarded facade idempotently", async () => {
  const f = await fixture(); let bindings = 0;
  f.overrideCapture(capture => ({ ...capture, bindSink: (sink, lifecycle) => {
    requireTranscriptSinkBinding(sink, { conversationId: "session-a", runId: "run-a", assistantTurnId: "assistant-a" }, f.store); bindings++;
    return wrapTranscriptSink(sink, { run: (_method, operation) => { lifecycle.assertCurrent(); return lifecycle.track(operation); } });
  } }));
  const run = await f.runtime.openRun(f.grant()), sink = createTranscriptSink({ store: f.store, conversationId: "session-a", runId: "run-a", assistantTurnId: "assistant-a" });
  const facade = run.bindSink(sink); expect(facade).not.toBe(sink); expect(run.bindSink(sink)).toBe(facade); expect(run.bindSink(facade)).toBe(facade); expect(bindings).toBe(1);
  expect(() => run.bindSink({ ...sink })).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
  const foreign = createTranscriptSink({ store: f.store, conversationId: "session-b", runId: "run-b", assistantTurnId: "assistant-b" });
  expect(() => run.bindSink(foreign)).toThrow("MEMORY_CONTEXT_STREAM_SINK_DENIED");
});

it("returns only a stable explicit streaming rejection code and permits a fresh counted fallback", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input(); input.request.stream = true;
  f.onFetch(async request => JSON.parse(await request.text()).stream
    ? Response.json({ error: { message: "Streaming is not supported private provider error detail" } }, { status: 400 })
    : Response.json({ choices: [{ message: { role: "assistant", content: "nonstream fallback" }, finish_reason: "stop" }] }));
  await expect(run.call(input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_UNSUPPORTED$/);
  input.request.stream = false; await expect(run.call(input)).resolves.toMatchObject({ text: "nonstream fallback" });
  expect(f.sent).toHaveLength(2); expect(f.commands.filter((command: any) => command.kind === "claim")).toHaveLength(2);
  expect(f.counted).toContain(f.sent[0]); expect(f.counted).toContain(f.sent[1]);
});

it("does not authorize fallback for a server failure merely mentioning unsupported streaming", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input(); input.request.stream = true;
  f.onFetch(async () => Response.json({ error: { message: "Streaming is not supported" } }, { status: 500 }));
  await expect(run.call(input)).rejects.toThrow(/^MEMORY_CONTEXT_SEND_UNKNOWN$/); expect(f.sent).toHaveLength(1);
});


it("screens actual credentials from ephemeral S without persisting or sending them", async () => {
  const f = await fixture("temporary", true); f.setTemporaryText("password = synthetic-super-secret-value");
  const before = f.commands.length, run = await f.runtime.openRun(f.grant());
  await expect(run.call(f.input())).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
  expect(f.commands).toHaveLength(before); expect(f.sent).toEqual([]); expect(f.counted).toEqual([]);
});

it("rejects wire output bounds above the approved profile reserve without changing settings", async () => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input(), before = JSON.stringify(f.config);
  Object.assign(input.request, { maxTokens: f.binding.budget.reservedOutputTokens + 1 });
  await expect(run.call(input)).rejects.toThrow("MEMORY_CONTEXT_OUTPUT_RESERVE_INVALID"); expect(f.sent).toEqual([]);
  expect(JSON.stringify(f.config)).toBe(before);
});

it("stops emitting ephemeral stream content as soon as its captured view changes", async () => {
  const f = await fixture("temporary", true), run = await f.runtime.openRun(f.grant()), input = f.input(), deltas: string[] = []; input.request.stream = true;
  f.onFetch(async () => new Response([
    { choices: [{ delta: { content: "first" }, finish_reason: null }] },
    { choices: [{ delta: { content: "second" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  await expect(run.call({ ...input, onDelta: delta => { if (delta.type === "text_delta") { deltas.push(delta.delta); f.mutateTemporary(); } } })).rejects.toThrow("MEMORY_CONTEXT_TRANSCRIPT_STALE");
  expect(deltas).toEqual(["first"]);
});

it("forwards real Anthropic terminal diagnostics through the memory-owned counted send", async () => {
  const f = await fixture("persistent", false, { anthropic: true }), run = await f.runtime.openRun(f.grant()), input = f.input(), onDiagnostic = vi.fn();
  input.request.stream = true;
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: f.config.model, stop_reason: null, stop_sequence: null, usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<think>思考</think>完成" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 12, output_tokens: 3 } },
    { type: "message_stop" },
  ];
  f.onFetch(async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }));
  await run.call({ ...input, onDiagnostic });
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "E_STREAM_TERMINAL_MISMATCH", differences: expect.arrayContaining(["text"]) }));
  expect(f.sent).toHaveLength(1); expect(f.counted).toContain(f.sent[0]);
});

it("keeps the real default capture response frame through consecutive tool commits and the next counted round", async () => {
  const f = await fixture("persistent", false, { defaultCapture: true }), run = await f.runtime.openRun(f.grant());
  const original = createTranscriptSink({ store: f.store, conversationId: "session-a", runId: "run-a", assistantTurnId: "assistant-turn" });
  const sink = run.bindSink(original); expect(run.bindSink(sink)).toBe(sink);
  f.onFetch(async () => Response.json({ choices: [{ message: { role: "assistant", content: "checking", tool_calls: ["t1", "t2"].map(id => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } })) }, finish_reason: "tool_calls" }] }));
  const first = await run.call(f.input());
  const assistantEntryId = await sink.appendAssistant({ message: first.assistantMessage, roundId: "r1" });
  await Promise.all(["t1", "t2"].map(toolCallId => sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId, name: "lookup", content: `result ${toolCallId}` }, outcome: "success", roundId: "r1" })));
  f.onFetch(async () => Response.json({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
  const second = await run.call(f.input()); await sink.appendAssistant({ message: second.assistantMessage, roundId: "r2" });
  expect((await f.store.read("session-a")).entries.map(entry => entry.kind)).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
  expect(f.sent).toHaveLength(2); expect(f.sent[1]).toContain("result t1"); expect(f.sent[1]).toContain("result t2");
  expect(f.commands.filter((command: any) => command.kind === "claim")).toHaveLength(2);
  for (const body of f.sent) expect(f.counted).toContain(body);
  expect(fs.readFileSync(f.databasePath).includes(Buffer.from("canonical question 中文"))).toBe(false);
});

it.each(["usage", "tool"])("classifies %s stream progress before an explicit capability refusal", async kind => {
  const f = await fixture(), run = await f.runtime.openRun(f.grant()), input = f.input(), progressed = deferred();
  input.request.stream = true;
  f.onFetch(async () => {
    let started = false;
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      if (!started) {
        started = true;
        const event = kind === "usage" ? { choices: [], usage: { prompt_tokens: 9, completion_tokens: 0 } }
          : { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }] };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      } else { await progressed.promise; controller.error(Object.assign(Error("Streaming is not supported"), { status: 400 })); }
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  await expect(run.call({ ...input, onDelta: () => progressed.resolve() })).rejects.toThrow(kind === "usage" ? "MEMORY_CONTEXT_STREAM_UNSUPPORTED" : "MEMORY_CONTEXT_SEND_UNKNOWN");
  expect(f.sent).toHaveLength(1);
});

it("permits only deterministic closure after the real default round's caller signal is cancelled", async () => {
  const f = await fixture("persistent", false, { defaultCapture: true }), run = await f.runtime.openRun(f.grant()), controller = new AbortController();
  const sink = run.bindSink(createTranscriptSink({ store: f.store, conversationId: "session-a", runId: "run-a", assistantTurnId: "assistant-turn" }));
  f.onFetch(async () => Response.json({ choices: [{ message: { role: "assistant", content: "checking", tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  const response = await run.call({ ...f.input(), signal: controller.signal });
  const assistantEntryId = await sink.appendAssistant({ message: response.assistantMessage, roundId: "r1" }); controller.abort();
  await expect(sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "t1", content: "late success" }, outcome: "success", roundId: "r1" })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
  const closure = { reason: "user_cancel" as const, runSession: { conversationId: "session-a", runId: "run-a", toolCalls: [{ toolCallId: "t1", toolName: "lookup", status: "started" }] } as any };
  await sink.closeInterruption(closure); await sink.closeInterruption(closure); await sink.checkpoint();
  const entries = (await f.store.read("session-a")).entries;
  expect(entries.map(entry => entry.kind)).toEqual(["user", "assistant", "tool_result", "interruption"]);
  expect(entries.filter(entry => entry.kind === "tool_result").map(entry => entry.payload.outcome)).toEqual(["unknown"]);
  expect(JSON.stringify(entries)).not.toContain("late success"); expect(f.sent).toHaveLength(1);
  await expect(run.call(f.input())).rejects.toThrow("MEMORY_CONTEXT_CANCELLED"); expect(f.sent).toHaveLength(1);
});

it("rejects a canonical edit during SDK wire verification before the real provider fetch", async () => {
  const f = await fixture("persistent", false, { defaultCapture: true }), run = await f.runtime.openRun(f.grant());
  const originalText = Request.prototype.text, arrived = deferred(), release = deferred(); let paused = false;
  vi.spyOn(Request.prototype, "text").mockImplementation(async function(this: Request) {
    if (!paused) { paused = true; arrived.resolve(); await release.promise; }
    return originalText.call(this);
  });
  const pending = run.call(f.input()).catch(error => error.message);
  await arrived.promise; expect(f.sent).toHaveLength(0);
  await f.store.append("session-a", { id: "wire-edit", at: 2000, kind: "turn_rewind", turnId: "u1", revision: 2,
    payload: { anchorUserTurnId: "u1", disposition: "replace_user", reason: "edit", replacementUser: { text: "edited question" } } });
  release.resolve(); await pending;
  expect(f.sent).toHaveLength(0);
});

it("rejects a forgotten M fact during SDK wire verification before the real provider fetch", async () => {
  const f = await fixture(), source = await f.source("I prefer bash", { occurredAt: 1000 });
  const fact = await f.policy.ingest(f.actor, source.ref);
  f.overrideCapture(capture => ({ ...capture, capture: async (...args) => ({ ...await capture.capture(...args), factRefs: [{ factId: fact.factId!, revision: 1 }] }) }));
  const run = await f.runtime.openRun(f.grant()), originalText = Request.prototype.text, arrived = deferred(), release = deferred(); let paused = false;
  vi.spyOn(Request.prototype, "text").mockImplementation(async function(this: Request) {
    if (!paused) { paused = true; arrived.resolve(); await release.promise; }
    return originalText.call(this);
  });
  const pending = run.call(f.input()).catch(error => error.message);
  await arrived.promise; expect(f.sent).toHaveLength(0);
  await f.policy.act(f.actor, await f.policy.event(f.actor, { kind: "forget", nonce: "wire-forget-fact", factId: fact.factId!, revision: 1 }));
  release.resolve(); await pending;
  expect(f.sent).toHaveLength(0);
});

it.each(["persistent", "temporary"] as const)("preserves a safe timeout code for a %s invocation without replay", async mode => {
  const f = await fixture(mode, mode === "temporary"), run = await f.runtime.openRun(f.grant());
  f.onFetch(request => new Promise<Response>((_resolve, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }));
  await expect(run.call({ ...f.input(), timeoutMs: 50 })).rejects.toThrow(/^E_MODEL_REQUEST_TIMEOUT$/);
  expect(f.sent).toHaveLength(1);
});

it("counts and sends a detached Main coverage notice without accepting a caller notice or promoting it to M", async () => {
  const f = await fixture(); let captured: any;
  const notice = 'History coverage: {"status":"partial","covered":1,"selected":2}';
  f.overrideCapture(capture => ({ ...capture, capture: async (...args) => {
    captured = { ...await capture.capture(...args), contextNotice: notice }; return captured;
  } }));
  f.onCount(async () => { captured.contextNotice = "later mutated coverage"; });
  const run = await f.runtime.openRun(f.grant()), input = f.input();
  Object.assign(input.request, { contextNotice: "caller forged coverage" });
  await run.call(input);
  const body = JSON.parse(f.sent[0]); expect(body.messages).toContainEqual({ role: "system", content: notice });
  expect(f.counted).toContain(f.sent[0]); expect(f.sent[0]).not.toContain("later mutated coverage"); expect(f.sent[0]).not.toContain("caller forged coverage");
  expect(await f.policy.recall(f.actor)).toEqual([]);
});


it("recounts and claims an authorized caption frame after a definite direct-image capability refusal",async()=>{
 const {createMainAttachmentProjectionAuthority,prepareMainAttachmentProjection,reprepareMainAttachmentProjection}=await import("./main-attachment-projection");
 const authority=createMainAttachmentProjectionAuthority(),attachments=[{kind:"image" as const,name:"bound.png",filePath:"/synthetic/bound.png"}];
 const cap=authority.issue({sessionId:"session-a",userTurnId:"u1",userRevision:1,userText:"canonical question 中文",attachments,assertCurrent(){}});
 await prepareMainAttachmentProjection(cap,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);
 const f=await fixture("persistent",false,{defaultCapture:true,attachmentProjection:authority.token,attachments}),run=await f.runtime.openRun(f.grant()),input=f.input();
 const sink=run.bindSink(createTranscriptSink({store:f.store,conversationId:"session-a",runId:"run-a",assistantTurnId:"assistant-turn"})),raw=JSON.stringify(await f.store.read("session-a"));
 f.onFetch(async request=>{const body=await request.text();return body.includes("data:image")?Response.json({error:{message:"image_url is not supported by this model PRIVATE DETAIL"}},{status:400}):Response.json({choices:[{message:{role:"assistant",content:"caption answer"},finish_reason:"stop"}]})});
 await expect(run.call(input)).rejects.toThrow(/^MEMORY_CONTEXT_IMAGE_UNSUPPORTED$/);
 await reprepareMainAttachmentProjection(cap,async()=>[{type:"text",text:"authorized caption bytes"}]);
 expect(JSON.stringify(await f.store.read("session-a"))).toBe(raw);
 const response=await run.call(input);expect(response.text).toBe("caption answer");await sink.appendAssistant({message:response.assistantMessage});
 expect(f.sent).toHaveLength(2);expect(f.sent[0]).toContain("data:image");expect(f.sent[1]).not.toContain("data:image");expect(f.sent[1]).toContain("authorized caption bytes");
 expect(f.commands.filter((command:any)=>command.kind==="claim")).toHaveLength(2);for(const body of f.sent)expect(f.counted).toContain(body);
 const users=(await f.store.read("session-a")).entries.filter(entry=>entry.kind==="user");expect(users).toHaveLength(1);expect(users[0]).toMatchObject({revision:1,payload:{text:"canonical question 中文",attachments}});
});
it.each([[500,"image inputs are not supported",true],[400,"invalid image encoding",true],[400,"image inputs are not supported",false]] as const)("does not grant caption retry for status %s, reason %s, prepared-image %s",async(status,message,hasImage)=>{
 const {createMainAttachmentProjectionAuthority,prepareMainAttachmentProjection}=await import("./main-attachment-projection");
 const authority=createMainAttachmentProjectionAuthority(),attachments=[{kind:"image" as const,name:"bound.png",filePath:"/synthetic/bound.png"}];
 if(hasImage){const cap=authority.issue({sessionId:"session-a",userTurnId:"u1",userRevision:1,userText:"canonical question 中文",attachments,assertCurrent(){}});await prepareMainAttachmentProjection(cap,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);}
 const f=await fixture("persistent",false,hasImage?{attachmentProjection:authority.token,attachments}:{}),run=await f.runtime.openRun(f.grant()),input=f.input();
 input.request.messages.push({role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]} as any);
 f.onFetch(async()=>Response.json({error:{message}},{status}));await expect(run.call(input)).rejects.toThrow("MEMORY_CONTEXT_SEND_UNKNOWN");expect(f.sent).toHaveLength(1);
});

it.each([400,422])("completes the real Chat image-to-caption path after HTTP %s with fresh counted wire bodies",async status=>{
 const {createMainAttachmentProjectionAuthority}=await import("./main-attachment-projection"),{buildAgentRunOptions}=await import("../orchestrator/build-options"),{runChatLoop}=await import("../orchestrator/chat-loop");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"caption-full-path-"));cleanup.push(()=>fs.rmSync(root,{recursive:true,force:true}));
 const filePath=path.join(root,"bound.png");fs.writeFileSync(filePath,Buffer.from("synthetic image bytes"));
 const authority=createMainAttachmentProjectionAuthority(),attachments=[{kind:"image" as const,name:"bound.png",filePath}],cap=authority.issue({sessionId:"session-a",userTurnId:"u1",userRevision:1,userText:"canonical question 中文",attachments,assertCurrent(){}});
 const f=await fixture("persistent",false,{defaultCapture:true,attachmentProjection:authority.token,attachments}),before=JSON.stringify(await f.store.read("session-a")),caption=vi.fn(async()=>({ok:true,caption:"fresh authorized caption"}));
 const built=await buildAgentRunOptions({sessionId:"session-a",userTurnId:"u1",mode:"chat",executionMode:"chat",messages:[{role:"user",content:"untrusted request"}]},{
  attachmentGrant:cap,requireAttachmentGrant:true,captionImageForFallback:caption,
  loadModelSettings:()=>({...f.config,multimodal:true,contextWindowTokens:100000}),loadGeneralSettings:()=>({chatSocialContextEnabled:false}),loadUserProfile:()=>({}),
  buildEnvironmentContext:()=>"",buildSkillCatalog:()=>"",buildAutoInjectedSkillContext:()=>"",skillRegistry:{getEnabled:()=>[],getEnabledForMode:()=>[],getBody:()=>null},resolveSlashActivation:()=>"",buildToneInjection:()=>"",buildAlwaysOnContext:async()=>"",buildRelationshipContext:async()=>"",buildToolSystemPrompt:()=>"",buildSoulSystemBasePrompt:()=>"fixed persona",readStylePrompt:()=>"",resolveSoulSampling:()=>({}),toolRegistry:{getEnabled:()=>[],getEnabledToolsForMode:()=>[]},normalizeChatMessages:raw=>raw as any,chatRequestTimeoutMs:5000,
 });
 const run=await f.runtime.openRun(f.grant());f.onFetch(async request=>{
  const body=await request.text();if(body.includes("data:image"))return Response.json({error:{message:"image inputs are not supported by this model"}},{status});
  expect(JSON.stringify(await f.store.read("session-a"))).toBe(before);
  return new Response([{choices:[{delta:{content:"recovered caption answer"},finish_reason:null}]},{choices:[{delta:{},finish_reason:"stop"}]}].map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
 });
 const result=await runChatLoop({settings:built.options.settings,adapter:f.binding.adapter,messages:built.options.messages,soulSystemBaseContent:built.options.soulSystemBaseContent,runtimeContext:built.options.soulRuntimeContext,timeoutMs:5000,memoryRun:run,imageCaptionFallback:built.options.imageCaptionFallback,
  transcriptSink:createTranscriptSink({store:f.store,conversationId:"session-a",runId:"run-a",assistantTurnId:"assistant-turn"}),recordUsage:()=>{}});
 expect(result.reply).toBe("recovered caption answer");expect(caption).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(2);
 expect(f.sent[0]).toContain("data:image");expect(f.sent[1]).not.toContain("data:image");expect(f.sent[1]).toContain("fresh authorized caption");expect(f.sent.join("")).not.toContain("untrusted request");
 for(const body of f.sent)expect(f.counted).toContain(body);const claims=f.commands.filter((command:any)=>command.kind==="claim");expect(claims).toHaveLength(2);expect(claims[0]).not.toEqual(claims[1]);
 expect((await f.store.read("session-a")).entries.filter(entry=>entry.kind==="user")).toMatchObject([{turnId:"u1",revision:1,payload:{text:"canonical question 中文",attachments}}]);expect(await f.policy.recall(f.actor)).toEqual([]);
});

it.each(["usage","text","tool"])("permits image capability recovery only before meaningful %s progress",async kind=>{
 const {createMainAttachmentProjectionAuthority,prepareMainAttachmentProjection}=await import("./main-attachment-projection"),authority=createMainAttachmentProjectionAuthority(),attachments=[{kind:"image" as const,name:"bound.png",filePath:"/synthetic/bound.png"}];
 const cap=authority.issue({sessionId:"session-a",userTurnId:"u1",userRevision:1,userText:"canonical question 中文",attachments,assertCurrent(){}});await prepareMainAttachmentProjection(cap,async()=>[{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}]);
 const f=await fixture("persistent",false,{attachmentProjection:authority.token,attachments}),run=await f.runtime.openRun(f.grant()),input=f.input(),progressed=deferred();input.request.stream=true;
 f.onFetch(async()=>{let first=true;return new Response(new ReadableStream<Uint8Array>({async pull(controller){
  if(first){first=false;const event=kind==="usage"?{choices:[],usage:{prompt_tokens:9,completion_tokens:0}}:kind==="text"?{choices:[{delta:{content:"partial text"},finish_reason:null}]}:{choices:[{delta:{tool_calls:[{index:0,id:"t1",type:"function",function:{name:"lookup",arguments:""}}]},finish_reason:null}]};controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));}
  else{await progressed.promise;controller.error(Object.assign(Error("image inputs are not supported"),{status:400}));}
 }}),{headers:{"content-type":"text/event-stream"}})});
 await expect(run.call({...input,onDelta:()=>progressed.resolve()})).rejects.toThrow(kind==="usage"?"MEMORY_CONTEXT_IMAGE_UNSUPPORTED":"MEMORY_CONTEXT_SEND_UNKNOWN");expect(f.sent).toHaveLength(1);
});

it("uses a fresh trusted observer for every actual prepared request with no identity from call DTO", async () => {
  const f = await fixture(), events: Array<[number, string, string | undefined]> = [];
  let execution = 0;
  const run = await f.runtime.openRun(f.grant(), { createModelExecutionObserver: () => {
    const identity = ++execution;
    return (phase, terminal) => events.push([identity, phase, terminal]);
  } });
  await run.call(f.input()); await run.call(f.input());
  expect(events).toEqual([[1, "start", undefined], [1, "end", "completed"], [2, "start", undefined], [2, "end", "completed"]]);
  expect(f.sent).toHaveLength(2);
});

it("never publishes observer starts for rejected counting or forged call observers", async () => {
  const f = await fixture(), trusted: string[] = [], forged: string[] = [];
  const run = await f.runtime.openRun(f.grant(), { createModelExecutionObserver: () => (phase) => trusted.push(phase) });
  const input = { ...f.input(), onModelExecution: () => forged.push("forged") };
  await run.call(input);
  expect(trusted).toEqual(["start", "end"]); expect(forged).toEqual([]);
  f.onCount(async () => { f.drift(); }); trusted.length = 0;
  await expect(run.call(input)).rejects.toThrow(/MEMORY_/);
  expect(trusted).toEqual([]); expect(f.sent).toHaveLength(1);
});
