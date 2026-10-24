import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage } from "./types";

const ports = vi.hoisted(() => ({
  dispatchers: [] as any[], contexts: [] as any[], runs: [] as any[],
  resolveBinding: vi.fn(), flush: vi.fn(), listSessions: vi.fn(), getSession: vi.fn(), appendMessage: vi.fn(),
  attachmentInputs: vi.fn(async () => ({ attachments: [], imageAttachments: [] })),
  result: { reply: "Contract response", toolResults: [] } as any, failure: undefined as Error | undefined,
}));
vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP, whenReady: async () => {} }, BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("./init", () => ({ initializeChannels: vi.fn(), startChannels: vi.fn(async () => {}), shutdownChannels: vi.fn(async () => {}) }));
vi.mock("./dispatcher", () => ({ ChannelDispatcher: class {
  constructor(private options: any) { ports.dispatchers.push(options); }
  handleIncoming = (message: IncomingMessage) => this.options.buildAndRunAgent(message, "contract-channel-session", []);
  reloadSettings = vi.fn();
} }));
vi.mock("./channel-context", () => ({
  formatChannelUserText: () => "Contract question",
  createChannelContext: (options: any) => { ports.contexts.push(options); return {}; },
}));
vi.mock("./conversation-binding-store", () => ({
  getChannelConversationBindingStore: () => ({ resolve: ports.resolveBinding, flush: ports.flush }),
}));
vi.mock("../chats/chats-store", () => ({ listSessions: ports.listSessions, getSession: ports.getSession, appendMessage: ports.appendMessage }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] } }));
vi.mock("../orchestrator/tools/history-tools", () => ({ indexConversationTurn: vi.fn() }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {
  get lastResult() { return ports.result; }
  runWithEvents(options: any) {
    ports.runs.push(options);
    return { subscribe: ({ complete, error }: any) => ports.failure ? error(ports.failure) : complete() };
  }
} }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: () => ({ toolSandbox: "off" }) }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: () => ({}) }));
vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => ({ defaultModelProfileId: "contract-profile", modelProfiles: [{ id: "contract-profile", provider: "openai" }] }),
  resolveModelSettingsProfile: () => ({ multimodal: false }),
}));
vi.mock("./agent-input", () => ({ buildChannelAttachmentInputs: ports.attachmentInputs }));
vi.mock("./agent-policy", () => ({
  resolveChannelAgentPolicy: () => ({ exposeTools: false, executionMode: "chat" }), enforceChannelAgentPolicy: vi.fn(),
}));
import { createChannelsSubsystem, type ChannelsSubsystemDeps, type ChannelsLifecycleAdapter } from "./bootstrap";
import { initializeChannels, startChannels } from "./init";
import { indexConversationTurn } from "../orchestrator/tools/history-tools";
import { ChannelManager } from "./manager";
import { createChannelMemoryAccountIdentity, type ChannelAdapter } from "./adapters/base";
import { requireChannelMemoryIngress, type ChannelMemoryIngress } from "../memory-context/channel-memory-ingress";
import { createMainAttachmentProjectionAuthority } from "../memory-context/main-attachment-projection";

beforeEach(() => {
  vi.clearAllMocks(); ports.dispatchers.length = 0; ports.contexts.length = 0; ports.runs.length = 0;
  ports.result = { reply: "Contract response", toolResults: [] }; ports.failure = undefined;
});
function runtime() {
  return {
    buildOptions: vi.fn(async () => ({ options: { executionMode: "chat", conversationMode: "chat" }, latestUserText: "Unreferenced" })),
    onRunFinished: vi.fn(async () => ({ sticker: null })), buildSchedulerOptions: vi.fn(),
  };
}
function dependencies(extra: Partial<ChannelsSubsystemDeps> = {}): ChannelsSubsystemDeps {
  return { agentRuntime: runtime() as never, getReactChatWindow: () => null, ...extra };
}
function lifecycle(): ChannelsLifecycleAdapter & { initialize: ReturnType<typeof vi.fn> } {
  return { initialize: vi.fn(), start: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
}
const incoming = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channel: "qq", chatType: "private", senderId: "contract-sender", chatId: "contract-room", text: "Review", at: new Date(5000), ...extra,
});
const run = (...args: any[]) => ports.dispatchers.at(-1).buildAndRunAgent(...args);
const publisher = () => ({ publishTurnStarted: vi.fn(), publishTurnFinished: vi.fn(), publishSchedulerFinished: vi.fn() });

it("keeps construction passive and exposes explicit initialize, start and shutdown operations", async () => {
  const operations = lifecycle();
  const subsystem = createChannelsSubsystem(dependencies(), operations);
  expect(operations.initialize).not.toHaveBeenCalled();
  expect(operations.start).not.toHaveBeenCalled();
  let registered = false;
  void subsystem.adaptersRegistered.then(() => { registered = true; });
  await Promise.resolve();
  expect(registered).toEqual(false);
  subsystem.initialize();
  expect(operations.initialize).toHaveBeenCalledTimes(1);
  await expect(subsystem.adaptersRegistered).resolves.toBeUndefined();
  expect(registered).toEqual(true);
  const controller = new AbortController();
  await subsystem.start(controller.signal);
  expect(operations.start).toHaveBeenCalledTimes(1);
  expect(operations.start).toHaveBeenCalledWith(controller.signal);
  await subsystem.shutdown();
  expect(operations.shutdown).toHaveBeenCalledTimes(1);
});

it("rejects adapter registration readiness when synchronous initialization throws", async () => {
  const operations = lifecycle();
  operations.initialize.mockImplementation(() => { throw new Error("contract adapter registration failed"); });
  const subsystem = createChannelsSubsystem(dependencies(), operations);
  expect(() => subsystem.initialize()).toThrow("contract adapter registration failed");
  await expect(subsystem.adaptersRegistered).rejects.toThrow("contract adapter registration failed");
});

it.each([false, true])("flushes binding observations after shutdown, including failure=%s", async failure => {
  const operations = lifecycle();
  operations.shutdown = vi.fn(async () => {
    expect(ports.flush).not.toHaveBeenCalled();
    if (failure) throw new Error("contract shutdown failed");
  });
  const subsystem = createChannelsSubsystem(dependencies(), operations);
  if (failure) await expect(subsystem.shutdown()).rejects.toThrow("contract shutdown failed");
  else await subsystem.shutdown();
  expect(ports.flush).toHaveBeenCalledTimes(1);
});

it("uses the init module for the default lifecycle without eagerly initializing it", () => {
  const subsystem = createChannelsSubsystem(dependencies());
  expect(initializeChannels).not.toHaveBeenCalled();
  expect(startChannels).not.toHaveBeenCalled();
  subsystem.initialize();
  expect(initializeChannels).toHaveBeenCalledTimes(1);
});

it("keeps the runtimes and broadcast windows of two subsystem instances independent", async () => {
  const firstRuntime = runtime(), secondRuntime = runtime();
  const firstSend = vi.fn(), secondSend = vi.fn();
  const first = createChannelsSubsystem(dependencies({ agentRuntime: firstRuntime as never, getReactChatWindow: () => ({ isDestroyed: () => false, webContents: { send: firstSend } }) as never }));
  const second = createChannelsSubsystem(dependencies({ agentRuntime: secondRuntime as never, getReactChatWindow: () => ({ isDestroyed: () => false, webContents: { send: secondSend } }) as never }));
  first.initialize(); second.initialize();
  const callbacks = vi.mocked(initializeChannels).mock.calls.map(call => call[0]!.handleIncoming);
  expect(callbacks[0]).toBeTypeOf("function"); expect(callbacks[1]).toBeTypeOf("function");
  await callbacks[0]!(incoming());
  expect(firstRuntime.buildOptions).toHaveBeenCalledTimes(1);
  expect(secondRuntime.buildOptions).not.toHaveBeenCalled();
  await callbacks[1]!(incoming());
  expect(firstRuntime.buildOptions).toHaveBeenCalledTimes(1);
  expect(secondRuntime.buildOptions).toHaveBeenCalledTimes(1);
  const event = { type: "bot:incoming", channel: "qq", senderId: "contract-sender", chatId: "contract-room", text: "Review", at: 5000 };
  ports.dispatchers[0].broadcastChat(event);
  expect(firstSend).toHaveBeenCalledTimes(1); expect(secondSend).not.toHaveBeenCalled();
  ports.dispatchers[1].broadcastChat(event);
  expect(firstSend).toHaveBeenCalledTimes(1); expect(secondSend).toHaveBeenCalledTimes(1);
});

it("loads model context for mirrored messages while retaining legacy plain messages", async () => {
  ports.getSession.mockReturnValue({ messages: [
    { role: "user", content: "Legacy request" },
    { role: "user", content: "Group request", modelContext: "[群聊发送者：Mira]\nGroup request" },
    { role: "model", content: "Assistant response" },
  ] });
  createChannelsSubsystem(dependencies());
  expect(await ports.contexts[0].loadBoundConversationHistory("desktop-review", 10)).toStrictEqual([
    { role: "user", content: "Legacy request" }, { role: "user", content: "[群聊发送者：Mira]\nGroup request" },
    { role: "assistant", content: "Assistant response" },
  ]);
});

it("persists visible bubble text beside channel, model-context and sticker metadata", () => {
  ports.appendMessage.mockReturnValue({ id: "desktop-review" });
  createChannelsSubsystem(dependencies());
  ports.contexts[0].appendBoundConversationMessage("desktop-review", "user", "Group request", {
    channel: "qq", chatType: "group", senderName: "Mira", modelContext: "[群聊发送者：Mira]\nGroup request", sticker: "HAPPY",
  });
  expect(ports.appendMessage).toHaveBeenCalledWith("desktop-review", expect.objectContaining({
    role: "user", content: "Group request", modelContext: "[群聊发送者：Mira]\nGroup request",
    channelSource: { channel: "qq", chatType: "group", senderName: "Mira" }, sticker: "HAPPY",
  }));
});

it("validates a binding using conversation metadata without reading transcripts", () => {
  ports.resolveBinding.mockReturnValue("desktop-review"); ports.listSessions.mockReturnValue([{ id: "desktop-review" }]);
  createChannelsSubsystem(dependencies());
  expect(ports.contexts[0].resolveBoundConversationId("external-review")).toEqual("desktop-review");
  ports.listSessions.mockReturnValue([]);
  expect(ports.contexts[0].resolveBoundConversationId("external-review")).toBeNull();
  expect(ports.getSession).not.toHaveBeenCalled();
});

it.each(["success", "timeout", "runtime_error"] as const)("publishes one started and finished event for terminal status %s", async status => {
  const agentRuntime = runtime(), events = publisher();
  if (status === "timeout") ports.result = { reply: "Partial contract response", toolResults: [], terminal: { status: "timeout", reason: "timeout", externalEffectsMayContinue: true } };
  if (status === "runtime_error") ports.failure = new Error("contract agent failed");
  createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, publishLifecycle: events as never }));
  const executing = run(incoming({ channel: "wechat" }), "external-review", []);
  if (status === "runtime_error") await expect(executing).rejects.toThrow("contract agent failed");
  else {
    const result = await executing;
    if (status === "timeout") expect(result.text).toEqual("Partial contract response");
  }
  if (status === "success") expect(agentRuntime.onRunFinished).toHaveBeenCalledWith(
    { reply: "Contract response", toolResults: [] }, "Contract question",
    { source: "channel", mode: "chat", conversationId: "external-review", channel: "wechat" });
  else expect(agentRuntime.onRunFinished).not.toHaveBeenCalled();
  expect(events.publishTurnStarted).toHaveBeenCalledTimes(1);
  expect(events.publishTurnFinished).toHaveBeenCalledTimes(1);
  const started = events.publishTurnStarted.mock.calls[0][0];
  expect(started).toMatchObject({ source: "channel", channel: "wechat", conversationId: "external-review", mode: "chat" });
  expect(typeof started.runId).toEqual("string");
  expect("inputMessageId" in started).toEqual(false);
  expect(events.publishTurnFinished.mock.calls[0][0]).toMatchObject({
    source: "channel", channel: "wechat", conversationId: "external-review", runId: started.runId, mode: "chat", status,
  });
  expect(typeof events.publishTurnFinished.mock.calls[0][0].durationMs).toEqual("number");
});

async function trusted(extra: Partial<IncomingMessage> = {}) {
  const identity = createChannelMemoryAccountIdentity();
  identity.authenticate("qq:contract-account");
  const adapter: ChannelAdapter = { id: "qq", displayName: "Contract", capability: {} as never, onMessage: null,
    start: async () => {}, stop: async () => {}, send: async () => ({ ok: true }), getMemoryAccountIdentity: identity.read,
    getStatus: () => ({ enabled: true, phase: "running" }) };
  const manager = new ChannelManager(); manager.register(adapter);
  let ingress!: ChannelMemoryIngress;
  manager.setDispatcher(async (_message, capability) => { ingress = capability!; return null; });
  await manager.startOne("qq");
  const message = incoming(extra);
  await adapter.onMessage!(message);
  return { manager, message, ingress, binding: requireChannelMemoryIngress(ingress, message) };
}
function admitted(input: Awaited<ReturnType<typeof trusted>>, close = vi.fn(async () => {})) {
  const transcriptSink = {} as never, openMemoryRun = vi.fn();
  const prepareRun = vi.fn(async (_request: any) => ({
    sessionId: input.binding.sessionId, signal: input.binding.signal, transcriptSink, openMemoryRun, close,
  }));
  return { prepareRun, close, transcriptSink, openMemoryRun };
}

it("uses the Main-owned canonical run and signal, excluding legacy desktop history", async () => {
  const input = await trusted();
  try {
    const memory = admitted(input), agentRuntime = runtime();
    createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, memory }));
    expect(await run(input.message, input.binding.sessionId, [{ role: "user", content: "Private desktop history" }], input.ingress)).toMatchObject({ text: "Contract response" });
    expect(memory.prepareRun).toHaveBeenCalledTimes(1);
    const request = memory.prepareRun.mock.calls[0][0];
    expect(request).toMatchObject({ ingress: input.ingress, message: input.message, modelProfileId: "contract-profile", userText: "Contract question" });
    expect(ports.runs[0]).toMatchObject({
      runId: request.runId, conversationId: input.binding.sessionId, transcriptSink: memory.transcriptSink, signal: input.binding.signal,
      userTurnId: request.userTurnId, assistantTurnId: request.assistantTurnId, tools: [], openMemoryRun: memory.openMemoryRun,
    });
    expect(agentRuntime.buildOptions).toHaveBeenCalledWith(expect.objectContaining({
      modelProfileId: "contract-profile", workspaceBindingSessionId: null, messages: [{ role: "user", content: "Contract question" }],
    }), { attachmentGrant: undefined });
    expect(memory.close).toHaveBeenCalledTimes(1);
    expect(indexConversationTurn).not.toHaveBeenCalled();
    expect(ports.dispatchers.at(-1).memoryEnabled).toEqual(true);
  } finally { await input.manager.stopAll(); }
});

it("rejects missing account authority before preparing memory or model options", async () => {
  const memory = { prepareRun: vi.fn() }, agentRuntime = runtime();
  createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, memory }));
  await expect(run(incoming(), "untrusted-session", [])).rejects.toThrow("MEMORY_CHANNEL_ACCOUNT_UNAVAILABLE");
  expect(memory.prepareRun).not.toHaveBeenCalled(); expect(agentRuntime.buildOptions).not.toHaveBeenCalled();
  expect(indexConversationTurn).not.toHaveBeenCalled();
});

it.each(["model", "cleanup", "preparation"] as const)("closes admitted memory runs on %s failures", async stage => {
  const input = await trusted();
  try {
    const memory = admitted(input), agentRuntime = runtime(), events = publisher();
    if (stage === "model") ports.failure = new Error("contract model failed");
    if (stage === "cleanup") memory.close.mockRejectedValue(new Error("MEMORY_CLOSE_FAILED"));
    if (stage === "preparation") agentRuntime.buildOptions.mockRejectedValueOnce(new Error("MEDIA_PREPARATION_FAILED"));
    createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, memory, publishLifecycle: events as never }));
    await expect(run(input.message, input.binding.sessionId, [], input.ingress)).rejects.toThrow(
      stage === "model" ? "contract model failed" : stage === "cleanup" ? "MEMORY_CLOSE_FAILED" : "MEDIA_PREPARATION_FAILED");
    expect(memory.close).toHaveBeenCalledTimes(1);
    if (stage === "cleanup") expect(events.publishTurnFinished).toHaveBeenCalledTimes(1);
    if (stage === "preparation") {
      expect(memory.prepareRun).toHaveBeenCalledTimes(1); expect(ports.runs).toStrictEqual([]);
    }
  } finally { await input.manager.stopAll(); }
});

it("authorizes attachments before preparation and forwards only the host-issued opaque grant", async () => {
  const input = await trusted({ attachments: [{ kind: "image", filePath: "D:/authorized/chart.png", mime: "image/png" }] });
  const authority = createMainAttachmentProjectionAuthority();
  try {
    const memory = admitted(input), agentRuntime = runtime();
    let grant: unknown;
    memory.prepareRun.mockImplementation(async request => {
      grant = authority.issue({
        sessionId: input.binding.sessionId, userTurnId: request.userTurnId, userRevision: 1, userText: request.userText,
        attachments: [{ kind: "image", name: "chart.png", filePath: "D:/authorized/chart.png", mime: "image/png" }],
        assertCurrent: input.binding.assertCurrent, signal: input.binding.signal,
      });
      return { sessionId: input.binding.sessionId, signal: input.binding.signal, transcriptSink: memory.transcriptSink,
        openMemoryRun: memory.openMemoryRun, close: memory.close, attachmentGrant: grant } as never;
    });
    Object.assign(input.message, { attachmentGrant: {}, memoryGrant: {} });
    createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, memory }));
    await run(input.message, input.binding.sessionId, [], input.ingress);
    expect(memory.prepareRun.mock.invocationCallOrder[0]).toBeLessThan(agentRuntime.buildOptions.mock.invocationCallOrder[0]);
    const [request, context] = agentRuntime.buildOptions.mock.calls[0] as any;
    expect(context.attachmentGrant).toBe(grant);
    expect(request.attachments).toBeUndefined(); expect(request.imageAttachments).toBeUndefined();
    expect(ports.attachmentInputs).not.toHaveBeenCalled();
    expect(memory.close).toHaveBeenCalledTimes(1);
  } finally { authority.close(); await input.manager.stopAll(); }
});

it("rejects unauthorized media without legacy media IO or model preparation", async () => {
  const input = await trusted({ attachments: [{ kind: "file", filePath: "D:/unauthorized/brief.txt" }] });
  try {
    const memory = { prepareRun: vi.fn(async () => { throw new Error("MEMORY_ATTACHMENT_DENIED"); }) }, agentRuntime = runtime();
    createChannelsSubsystem(dependencies({ agentRuntime: agentRuntime as never, memory }));
    await expect(run(input.message, input.binding.sessionId, [], input.ingress)).rejects.toThrow("MEMORY_ATTACHMENT_DENIED");
    expect(ports.attachmentInputs).not.toHaveBeenCalled(); expect(agentRuntime.buildOptions).not.toHaveBeenCalled();
    expect(ports.runs).toStrictEqual([]);
  } finally { await input.manager.stopAll(); }
});
