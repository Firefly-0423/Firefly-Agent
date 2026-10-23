import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "../../plugins/manager";
import { createPluginPromptRegistry } from "../../plugins/prompts";
import type { PluginRuntime } from "../../plugins/context";
import type { ScheduledTask } from "../scheduler/types";
import { createAgentRuntime, type AgentRuntimeDeps } from "./agent-runtime";
import * as builders from "./build-options";

const effects = vi.hoisted(() => ({ finish: vi.fn(), legacy: vi.fn(), worldbook: vi.fn(), write: vi.fn(), root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => effects.root } }));
vi.mock("./build-options", async (original) => ({ ...await original<typeof import("./build-options")>(), onAgentRunFinished: effects.finish }));
vi.mock("./index", async (original) => ({ ...await original<typeof import("./index")>(), buildAlwaysOnContext: effects.legacy, buildWorldbookContext: effects.worldbook, scheduleMemoryWrite: effects.write }));
const directories: string[] = [];
let plugin: PluginManager | undefined;
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-runtime-")); directories.push(root); return root; }
const savedSettings = () => ({ mode: "manual", provider: "", model: "", baseUrl: "", apiKey: "", multimodal: false, perProvider: {}, modelProfiles: [{ id: "calendar-profile", provider: "Calendar provider", baseUrl: "https://calendar-profile.invalid/v1", model: "calendar-model", apiKey: "calendar-profile-key", explicitTransport: "anthropic" }] });
function dependencies(patch: Partial<AgentRuntimeDeps> = {}): AgentRuntimeDeps {
  return {
    loadModelSettings: savedSettings, loadGeneralSettings: () => ({ skillModeOverrides: { chat: ["calendar-skill"] } }), loadUserProfile: () => ({}),
    toolRegistry: { getEnabledTools: vi.fn(() => []), getEnabledToolsForMode: vi.fn(() => []) },
    skillRegistry: { getEnabled: vi.fn(() => []), getEnabledForMode: vi.fn(() => []), getBody: vi.fn(() => null) },
    getStickerEmbeddingIndex: () => undefined, getEmbeddingProvider: () => undefined,
    socialContextScheduler: { schedule: vi.fn() }, chatsStore: { getWorkspaceBinding: vi.fn(() => ({ workspaceRoot: "E:/calendar-workspace", displayName: "Calendar", boundAt: 84 })) },
    socialAtomStore: { listActive: vi.fn(() => []) }, buildPluginPromptContext: vi.fn(async () => "[CALENDAR_PLUGIN]"),
    publishPluginHostEvent: vi.fn(async () => {}), ...patch,
  } as unknown as AgentRuntimeDeps;
}
const context = { source: "desktop" as const, mode: "chat" as const, conversationId: "calendar-session", runId: "calendar-run" };
const result = { reply: "Tuesday is available", toolResults: [] };
const stubOptions = () => ({ settings: { provider: "Calendar", baseUrl: "https://calendar.invalid", model: "calendar-model", apiKey: "calendar-key", contextWindowTokens: 256_000 }, messages: [], timeoutMs: 0, toolSystemContent: "", soulSystemBaseContent: "" });
const task = (patch: Partial<ScheduledTask> = {}) => ({ id: "calendar-task", title: "Read the calendar", prompt: "Find Tuesday appointments", enabled: true, schedule: { type: "daily", time: "08:30" }, nextFireAt: null, toolMode: "disabled", allowedToolIds: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...patch }) as ScheduledTask;
const sRequest = { model: "calendar-model", messages: [], maxTokens: 160, stream: true };
const sTarget = (conversationId: string) => ({ conversationId, runId: "calendar-run", userTurnId: "calendar-user", assistantTurnId: "calendar-answer", sink: {} as any, isCurrent: () => true, onEvent: () => {} });
beforeEach(() => {
  effects.finish.mockReset().mockResolvedValue({ sticker: null });
  effects.legacy.mockReset().mockResolvedValue("[CALENDAR_LEGACY]");
  effects.worldbook.mockReset().mockResolvedValue("[CALENDAR_WORLDBOOK]");
});
afterEach(async () => {
  await plugin?.stop(); plugin = undefined; effects.root = "";
  vi.restoreAllMocks(); directories.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("Runtime completion notifications", () => {
  it("publishes only turn metadata after successful effects without waiting for plugin listeners", async () => {
    let release!: () => void;
    const listener = new Promise<void>((resolve) => { release = resolve; });
    const publish = vi.fn(() => listener), runtime = createAgentRuntime(dependencies({ publishPluginHostEvent: publish }));
    await expect(runtime.onRunFinished(result, "Read my calendar", context)).resolves.toEqual({ sticker: null });
    expect(publish).toHaveBeenCalledWith("turn:completed", context); release();
    const channel = { source: "channel" as const, mode: "chat" as const, conversationId: "calendar-channel", channel: "wechat" };
    await runtime.onRunFinished(result, "Read my calendar", channel);
    expect(publish).toHaveBeenCalledWith("turn:completed", channel);
  });

  it.each(["runtime_error", "cancelled", "timeout"] as const)("does not announce a completed turn for %s", async (status) => {
    const publish = vi.fn(async () => {});
    await createAgentRuntime(dependencies({ publishPluginHostEvent: publish })).onRunFinished({ ...result, terminal: { status, reason: "Calendar interrupted", externalEffectsMayContinue: true } }, "Read my calendar", context);
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates host effect failures and isolates plugin publication failures", async () => {
    const publish = vi.fn(async () => {}), runtime = createAgentRuntime(dependencies({ publishPluginHostEvent: publish }));
    effects.finish.mockRejectedValueOnce(Error("Calendar finalization failed"));
    await expect(runtime.onRunFinished(result, "Read my calendar", context)).rejects.toThrow("Calendar finalization failed");
    expect(publish).not.toHaveBeenCalled();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    publish.mockRejectedValueOnce(Error("Calendar listener failed"));
    await expect(runtime.onRunFinished(result, "Read my calendar", context)).resolves.toEqual({ sticker: null });
    await expect.poll(() => warning.mock.calls.length).toBe(1);
  });

  it("delivers metadata through the real plugin manager and event bus", async () => {
    const root = temporary(), packageRoot = path.join(root, "calendar-listener"), received = path.join(root, "calendar-event.json");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "calendar-listener", name: "Calendar Listener", version: "1.0.0", description: "Calendar event consumer", author: "Calendar tests", entry: "listener.cjs", defaultEnabled: true }));
    fs.writeFileSync(path.join(packageRoot, "listener.cjs"), "const fs=require('node:fs'); module.exports={register(host){host.events.on('host:turn:completed', event=>fs.writeFileSync(" + JSON.stringify(received) + ",JSON.stringify(event)))}};");
    const runtime: PluginRuntime = { toolRegistry: { register: () => {}, unregister: () => true }, channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} }, registerIpc: () => {}, unregisterIpc: () => {}, promptRegistry: createPluginPromptRegistry() };
    plugin = new PluginManager({ scanRoots: [{ path: root, source: "builtin" }], storageRoot: path.join(root, "plugin-storage"), runtime, loadEnabledMap: () => ({}), saveEnabledMap: () => {} });
    await plugin.start();
    await createAgentRuntime(dependencies({ publishPluginHostEvent: (event, payload) => plugin!.publishHostEvent(event, payload) })).onRunFinished(result, "Read my calendar", context);
    await expect.poll(() => fs.existsSync(received)).toBe(true);
    expect(JSON.parse(fs.readFileSync(received, "utf8"))).toEqual(context);
  });
});

describe("Options dependency assembly", () => {
  async function capture(deps: AgentRuntimeDeps) {
    let observed!: builders.BuildOptionsDeps;
    vi.spyOn(builders, "buildAgentRunOptions").mockImplementation(async (_input, supplied) => { observed = supplied; return { options: stubOptions(), latestUserText: "Read my calendar" }; });
    const runtime = createAgentRuntime(deps), built = await runtime.buildOptions({} as never);
    return { observed, runtime, built };
  }
  it("forwards tool completion observers only when an event publisher is configured", async () => {
    const publish = vi.fn();
    const withObserver = await capture(dependencies({ publishToolFinished: publish }));
    expect(withObserver.built.options.onToolFinished).toBeTypeOf("function");
    const event = { toolId: "write_file", toolCallId: "calendar-call", runId: "calendar-run", status: "success", risk: "fs-write", durationMs: 28 } as const;
    withObserver.built.options.onToolFinished!(event); expect(publish).toHaveBeenCalledWith(event);
    expect((await createAgentRuntime(dependencies()).buildOptions({} as never)).options.onToolFinished).toBeUndefined();
  });
  it("connects tool registries, workspace bindings, plugin prompts, social retrieval and image fallback", async () => {
    const deps = dependencies(), { observed } = await capture(deps);
    expect(observed).toBeDefined();
    observed.toolRegistry.getEnabled(); expect(deps.toolRegistry.getEnabledTools).toHaveBeenCalled();
    observed.toolRegistry.getEnabledToolsForMode("work"); expect(deps.toolRegistry.getEnabledToolsForMode).toHaveBeenCalledWith("work", undefined);
    observed.getWorkspaceBinding!("calendar-session"); expect(deps.chatsStore.getWorkspaceBinding).toHaveBeenCalledWith("calendar-session");
    await observed.buildPluginPromptContext!({ source: "desktop", mode: "chat" } as never);
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "desktop", mode: "chat" });
    const social = await observed.buildChatSocialContext!({ conversationId: "calendar-session", query: "Tuesday plans" });
    expect(deps.socialAtomStore.listActive).toHaveBeenCalledWith("calendar-session", expect.any(Number));
    expect(social).toEqual({ contextBlock: "", retrievedAtoms: [] });
    const caption = await observed.captionImageForFallback!("calendar.png");
    expect(caption).toMatchObject({ ok: false }); expect((caption as { error: string }).error).toContain("不支持查看图片");
  });
  it("uses authoritative persisted transcript content in place of renderer history", async () => {
    effects.root = temporary();
    const { getConversationTranscriptStore } = await import("./conversation-transcript-store");
    await getConversationTranscriptStore(effects.root).append("calendar-session", { id: "calendar-seed", kind: "user", turnId: "calendar-user", revision: 1, at: 84, payload: { text: "Canonical calendar request" } });
    const built = await createAgentRuntime(dependencies()).buildOptions({ sessionId: "calendar-session", useTranscriptContext: true, messages: [{ role: "user", content: "Obsolete renderer calendar" }] } as never);
    expect(built.options.cleanMessages).toContainEqual(expect.objectContaining({ content: "Canonical calendar request" }));
    expect(JSON.stringify(built.options.messages)).not.toContain("Obsolete renderer calendar");
  });
});

describe("Scheduled run assembly", () => {
  it("expands the saved profile and builds ordered work context with frozen mode and unlimited run duration", async () => {
    const deps = dependencies(), options = await createAgentRuntime(deps).buildSchedulerOptions(task());
    expect(options.settings).toMatchObject({ provider: "Calendar provider", baseUrl: "https://calendar-profile.invalid/v1", model: "calendar-model", apiKey: "calendar-profile-key", explicitTransport: "anthropic" });
    expect(deps.skillRegistry.getEnabledForMode).toHaveBeenCalledWith("work", { chat: ["calendar-skill"] });
    expect(options.messages[0].role).toEqual("system");
    for (const fragment of ["[CALENDAR_LEGACY]", "[CALENDAR_PLUGIN]", "---"]) expect(options.messages[0].content).toContain(fragment);
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "scheduler", mode: "work", userText: "Find Tuesday appointments" });
    expect(options.messages[1]).toEqual({ role: "user", content: "Find Tuesday appointments" });
    expect(options.timeoutMs).toEqual(0); expect(options.onToolFinished).toBeUndefined();
  });
  it("omits skills in scheduled chat and forwards the configured tool observer", async () => {
    const publish = vi.fn(), deps = dependencies({ publishToolFinished: publish }), runtime = createAgentRuntime(deps);
    const options = await runtime.buildSchedulerOptions(task({ mode: "chat", prompt: "Read today's calendar" }));
    expect(deps.skillRegistry.getEnabledForMode).not.toHaveBeenCalled();
    expect(deps.buildPluginPromptContext).toHaveBeenCalledWith({ source: "scheduler", mode: "chat", userText: "Read today's calendar" });
    expect(options.onToolFinished).toBeTypeOf("function");
    const event = { toolId: "run_shell", toolCallId: "calendar-call", runId: "calendar-run", status: "success", risk: "shell", durationMs: 28 } as const;
    options.onToolFinished!(event); expect(publish).toHaveBeenCalledWith(event);
  });
  it("requires saved profile identity for memory runs and forwards the lazy background host", async () => {
    const prepareBackgroundRun = vi.fn(), options = await createAgentRuntime(dependencies({ defaultMemory: { openRun: vi.fn(), prepareBackgroundRun } })).buildSchedulerOptions(task());
    expect(options).toHaveProperty("modelProfileId", "calendar-profile"); expect(options.backgroundMemory?.prepareBackgroundRun).toBeTypeOf("function");
    expect(prepareBackgroundRun).not.toHaveBeenCalled();
    const deps = dependencies({ defaultMemory: { openRun: vi.fn() }, loadModelSettings: () => ({ ...savedSettings(), modelProfiles: [] }) as any });
    await expect(createAgentRuntime(deps).buildSchedulerOptions(task())).rejects.toThrow("MEMORY_RUN_PROFILE_DENIED");
  });
});

describe("Controlled Main S provisioning and session ownership", () => {
  it("never provisions or reads request properties while the feature is disabled", async () => {
    const createPort = vi.fn(() => { throw Error("Calendar provisioning forbidden"); });
    const runtime = createAgentRuntime(dependencies({ sContext: { createPort } }));
    const unreadable = new Proxy({}, { get() { throw Error("Calendar request read forbidden"); } });
    expect(createPort).not.toHaveBeenCalled();
    await expect(runtime.runSContext(unreadable as any)).rejects.toThrow("MEMORY_CONTEXT_RUNTIME_DISABLED");
    expect(createPort).not.toHaveBeenCalled();
  });
  it("shares lazy provisioning and snapshots input before delivering it to the Main port", async () => {
    const run = vi.fn(async (_input: unknown) => ({ status: "sent" as const, requestDigest: "calendar-digest", result: "Calendar response" })), createPort = vi.fn(async () => ({ run }));
    const runtime = createAgentRuntime(dependencies({ sContext: { enabled: true, createPort } }));
    expect(createPort).not.toHaveBeenCalled();
    const input = { request: { ...sRequest, stream: false } };
    await Promise.all([runtime.runSContext(input), runtime.runSContext(input)]);
    expect(createPort).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toEqual({ ...input, signal: undefined }); expect(run.mock.calls[0][0]).not.toBe(input);
  });
  it("does no provisioning for a pre-aborted run and no sending after provisioning aborts", async () => {
    const pre = new AbortController(); pre.abort(); const noProvision = vi.fn();
    await expect(createAgentRuntime(dependencies({ sContext: { enabled: true, createPort: noProvision } })).runSContext({ signal: pre.signal } as any)).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
    expect(noProvision).not.toHaveBeenCalled();
    const abort = new AbortController(), run = vi.fn(), createPort = vi.fn(async () => { abort.abort(); return { run }; });
    const runtime = createAgentRuntime(dependencies({ sContext: { enabled: true, createPort } }));
    await expect(runtime.runSContext({ request: sRequest, signal: abort.signal })).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
    expect(run).not.toHaveBeenCalled(); expect(createPort).toHaveBeenCalledTimes(1);
    await expect(runtime.runSContext({ signal: abort.signal } as any)).rejects.toThrow("MEMORY_CONTEXT_CANCELLED");
    expect(createPort).toHaveBeenCalledTimes(1);
  });
  it("retains a provisioning failure without retrying or touching legacy model dependencies", async () => {
    const legacy = vi.fn(() => { throw Error("Calendar legacy path forbidden"); }), createPort = vi.fn(async () => { throw Error("Calendar provisioning refused"); });
    const runtime = createAgentRuntime(dependencies({ loadModelSettings: legacy, llmClient: { chat: legacy } as any, sContext: { enabled: true, createPort } }));
    for (let attempt = 0; attempt < 2; attempt++) await expect(runtime.runSContext({ request: sRequest })).rejects.toThrow("Calendar provisioning refused");
    expect(createPort).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
  });
  it("isolates per-session ports and shares concurrent provisioning for the same session", async () => {
    const provisioned: string[] = [], sent: string[] = [];
    const runtime = createAgentRuntime(dependencies({ sContext: { enabled: true, createPort: async (scope) => {
      provisioned.push(scope?.conversationId ?? "unbound");
      return { run: async (input: any) => { sent.push(scope?.conversationId + ":" + input.stream.conversationId); return { status: "sent" as const, requestDigest: "calendar-digest", result: null }; } };
    } } }));
    await Promise.all(["calendar-blue", "calendar-gold", "calendar-blue"].map((session) => runtime.runSContext({ request: sRequest, stream: sTarget(session) })));
    expect(provisioned).toEqual(["calendar-blue", "calendar-gold"]);
    expect(sent.sort()).toEqual(["calendar-blue:calendar-blue", "calendar-blue:calendar-blue", "calendar-gold:calendar-gold"]);
  });
  it("prepares the exact session before dispatch and rejects missing or accessor session IDs", async () => {
    const provisioned: string[] = [];
    const runtime = createAgentRuntime(dependencies({ sContext: { enabled: true, streamRequest: () => sRequest, createPort: async (scope) => { provisioned.push(scope?.conversationId ?? "unbound"); return { run: async () => ({ status: "sent" as const, requestDigest: "calendar-digest", result: null }) }; } } }));
    await expect(runtime.buildOptions.prepareTranscript!({ mode: "chat", messages: [] } as any)).rejects.toThrow("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    await expect(runtime.buildOptions.prepareTranscript!(Object.defineProperty({ mode: "chat", messages: [] }, "sessionId", { get() { throw Error("Calendar accessor forbidden"); } }) as any)).rejects.toThrow("MEMORY_CONTEXT_STREAM_TARGET_INVALID");
    expect(provisioned).toEqual([]);
    await runtime.buildOptions.prepareTranscript!({ sessionId: "calendar-blue", mode: "chat", messages: [] });
    await runtime.runSContext({ request: sRequest, stream: sTarget("calendar-blue") });
    expect(provisioned).toEqual(["calendar-blue"]);
  });
  it("keeps a failed session from poisoning another session or silently retrying", async () => {
    const provisioned: string[] = [];
    const runtime = createAgentRuntime(dependencies({ sContext: { enabled: true, createPort: async (scope) => {
      provisioned.push(scope?.conversationId ?? "unbound");
      if (scope?.conversationId === "calendar-blue") throw Error("Calendar blue denied");
      return { run: async () => ({ status: "sent" as const, requestDigest: "calendar-digest", result: null }) };
    } } }));
    await expect(runtime.runSContext({ request: sRequest, stream: sTarget("calendar-blue") })).rejects.toThrow("Calendar blue denied");
    await expect(runtime.runSContext({ request: sRequest, stream: sTarget("calendar-gold") })).resolves.toMatchObject({ status: "sent" });
    await expect(runtime.runSContext({ request: sRequest, stream: sTarget("calendar-blue") })).rejects.toThrow("Calendar blue denied");
    expect(provisioned).toEqual(["calendar-blue", "calendar-gold"]);
  });
  it("bypasses legacy completion effects for controlled desktop turns and keeps metadata notifications", async () => {
    const publish = vi.fn(async () => {});
    const runtime = createAgentRuntime(dependencies({ publishPluginHostEvent: publish, sContext: { enabled: true, isControlledSession: (id) => id === context.conversationId, createPort: () => ({ run: vi.fn() }) } }));
    expect(await runtime.onRunFinished({ ...result, terminal: { status: "success", reason: "completed", externalEffectsMayContinue: false } }, "Calendar request", context)).toEqual({ sticker: null });
    expect(effects.finish).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("turn:completed", context);
  });
});

describe("Ordinary Main memory and attachment authority", () => {
  it("defers Main run creation, retains worldbook context and sends the SMH completion policy", async () => {
    effects.root = temporary(); const openRun = vi.fn(), runtime = createAgentRuntime(dependencies({ defaultMemory: { openRun } }));
    const built = await runtime.buildOptions({ sessionId: "calendar-session", messages: [{ role: "user", content: "Read the calendar" }], mode: "chat", modelProfileId: "calendar-profile" } as never);
    expect(openRun).not.toHaveBeenCalled(); expect(built.options.openMemoryRun).toBeTypeOf("function");
    expect(effects.legacy).not.toHaveBeenCalled(); expect(effects.worldbook).toHaveBeenCalled();
    expect(built.options.soulRuntimeContext).toContain("[CALENDAR_WORLDBOOK]");
    const current = { ...built.options, runId: "calendar-run" }; await built.options.openMemoryRun!(current);
    expect(openRun).toHaveBeenCalledWith(current);
    effects.finish.mockResolvedValueOnce({ sticker: "calendar-sticker" });
    expect(await runtime.onRunFinished(result, "Calendar request", context)).toEqual({ sticker: "calendar-sticker" });
    expect(effects.finish.mock.calls[0][2]).toMatchObject({ personalMemoryMode: "smh" });
  });
  it("filters only retired personal-memory tools from both registry entry points", async () => {
    const tools = ["user_memory", "read_memory", "write_memory", "recall_history", "search_knowledge", "read_file"].map((id) => ({ id }));
    let observed!: builders.BuildOptionsDeps;
    vi.spyOn(builders, "buildAgentRunOptions").mockImplementation(async (_input, supplied) => { observed = supplied; return { options: stubOptions(), latestUserText: "Calendar request" }; });
    const deps = dependencies({ defaultMemory: { openRun: vi.fn() }, toolRegistry: { getEnabledTools: () => tools, getEnabledToolsForMode: () => tools } as any });
    await createAgentRuntime(deps).buildOptions({} as never);
    const expected = [{ id: "search_knowledge" }, { id: "read_file" }];
    expect(observed.toolRegistry.getEnabled()).toEqual(expected);
    expect(observed.toolRegistry.getEnabledToolsForMode("work")).toEqual(expected);
  });
  it("accepts attachment grants only from the separate Main build context", async () => {
    const { createMainAttachmentProjectionAuthority } = await import("../memory-context/main-attachment-projection");
    const authority = createMainAttachmentProjectionAuthority();
    const grant = authority.issue({ sessionId: "calendar-session", userTurnId: "calendar-user", userRevision: 1, userText: "Calendar request", attachments: [{ kind: "image", name: "calendar.png", filePath: "/calendar/never-read.png", mime: "image/png" }], assertCurrent: () => {} });
    let observed!: builders.BuildOptionsDeps;
    vi.spyOn(builders, "buildAgentRunOptions").mockImplementation(async (_input, supplied) => { observed = supplied; return { options: stubOptions(), latestUserText: "Calendar request" }; });
    try {
      const runtime = createAgentRuntime(dependencies({ defaultMemory: { openRun: vi.fn() } }));
      await runtime.buildOptions({ attachmentGrant: grant } as never);
      expect(observed.attachmentGrant).toBeUndefined(); expect(observed.requireAttachmentGrant).toEqual(true);
      await runtime.buildOptions({} as never, { attachmentGrant: grant });
      expect(observed.attachmentGrant).toBe(grant); expect(observed.materializeAttachmentDocument).toBeTypeOf("function");
    } finally { await authority.close(); }
  });
});
