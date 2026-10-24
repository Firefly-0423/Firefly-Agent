import { beforeEach, expect, it, vi } from "vitest";
import { ChannelDispatcher, makeSessionId, type DispatcherDeps } from "./dispatcher";
import { createChannelContext, type CreateChannelContextOptions, type ChannelContext } from "./channel-context";
import { createOutgoingComposer } from "./outgoing-composer";
import { createChannelDeliveryService } from "./delivery-service";
import { createChannelRateLimiter } from "./rate-limiter";
import { createKeyedQueue } from "./keyed-queue";
import { appendHistory, migrateHistory } from "./history-log";
import { appendLog, reloadLogFromDisk } from "./message-log";
import type { IncomingMessage, ChannelCapability, OutgoingMessage } from "./types";
import type { ChannelsSettings } from "./settings-store";
import { ChannelManager } from "./manager";
import { createChannelMemoryAccountIdentity, type ChannelAdapter } from "./adapters/base";
import { requireChannelMemoryIngress } from "../memory-context/channel-memory-ingress";

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP, getAppPath: () => process.cwd(), getName: () => "Contract host" },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("./history-log", () => ({ appendHistory: vi.fn(), migrateHistory: vi.fn() }));
vi.mock("./message-log", () => ({ appendLog: vi.fn(), reloadLogFromDisk: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function incoming(extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { channel: "qq", chatType: "private", senderId: "speaker-14", senderName: "Mira", chatId: "review-room",
    text: "Begin review", at: new Date(4000), ...extra };
}
function harness(overrides: Partial<DispatcherDeps> = {}, contextOptions: Partial<CreateChannelContextOptions> = {}, supportsSticker = false) {
  const send = vi.fn(async (_message: OutgoingMessage) => ({ ok: true as boolean, error: undefined as string | undefined }));
  const capability: ChannelCapability = { text: true, image: true, audio: false, file: false, video: false, markdown: false,
    card: false, sticker: supportsSticker, maxTextLength: 4000 };
  const composer = createOutgoingComposer({ resolveStickerImagePath: id => id === "HAPPY" ? "D:/stickers/happy.png" : null });
  const build = vi.fn(async (_message: IncomingMessage, _sessionId: string, _prior?: any[], _ingress?: unknown) => ({ text: "Contract reply", sticker: null as string | null }));
  const context = createChannelContext({ appendChannelHistory: appendHistory, migrateHistory, ...contextOptions });
  const deps: DispatcherDeps = {
    context, buildAndRunAgent: build, queue: createKeyedQueue({ maxPendingPerKey: 20 }),
    limiter: createChannelRateLimiter({ limits: { perUser: 10, perChannel: 100 } }),
    delivery: createChannelDeliveryService({ getAdapter: () => ({ send, capability }) as never }),
    composer: { compose: input => composer.compose({ ...input, capability }), cleanupTransientFiles: composer.cleanupTransientFiles },
    loadSettings: () => ({ rateLimitPerUser: 10, rateLimitPerChannel: 100, stickerEnabled: true, mirrorToDesktop: true }) as ChannelsSettings,
    ...overrides,
  };
  return { dispatcher: new ChannelDispatcher(deps), deps, build, send, context };
}
function latch() {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { blocked, release };
}
async function microtasks() { for (let turn = 0; turn < 24; turn++) await Promise.resolve(); }

it("constructs without reading persisted message logs", () => {
  harness();
  expect(reloadLogFromDisk).not.toHaveBeenCalled();
});

it("uses the unbound channel session and its recent history", async () => {
  const history = [{ role: "user" as const, content: "Earlier channel discussion" }];
  const loadRecentChannelHistory = vi.fn(async () => history);
  const h = harness({}, { loadRecentChannelHistory });
  expect((await h.dispatcher.handleIncoming(incoming()))?.targetId).toEqual("review-room");
  expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "review-room"), 16);
  expect(h.build).toHaveBeenCalledTimes(1);
  expect(h.build).toHaveBeenCalledWith(expect.anything(), makeSessionId("qq", "review-room"), history);
});

it("reads and commits through an injected context service", async () => {
  const history = [{ role: "user" as const, content: "Injected channel context" }];
  const context: ChannelContext = {
    resolveDispatchContext: vi.fn(sessionId => ({ sessionId, boundConversationId: null })),
    recordIncomingSession: vi.fn(), resolvePriorMessages: vi.fn(async () => history),
    appendIncomingContext: vi.fn(async () => {}), appendAssistantContext: vi.fn(async () => {}),
  };
  const h = harness({ context });
  await h.dispatcher.handleIncoming(incoming());
  expect(h.build.mock.calls[0][2]).toStrictEqual(history);
  expect(context.recordIncomingSession).toHaveBeenCalledTimes(1);
  expect(context.appendIncomingContext).toHaveBeenCalledTimes(1);
  expect(context.appendAssistantContext).toHaveBeenCalledTimes(1);
  expect(vi.mocked(context.resolvePriorMessages).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(context.appendIncomingContext).mock.invocationCallOrder[0]);
});

it.each(["wechat", "qq"] as const)("loads desktop history while retaining the %s runtime identity", async channel => {
  const history = [{ role: "user" as const, content: "Desktop review discussion" }];
  const loadRecentChannelHistory = vi.fn(async () => []);
  const loadBoundConversationHistory = vi.fn(async () => history);
  const appendBoundConversationMessage = vi.fn();
  const h = harness({}, {
    resolveBoundConversationId: () => "desktop-review", loadRecentChannelHistory, loadBoundConversationHistory, appendBoundConversationMessage,
  });
  expect((await h.dispatcher.handleIncoming(incoming({ channel })))?.targetId).toEqual("review-room");
  expect(loadRecentChannelHistory).not.toHaveBeenCalled();
  expect(loadBoundConversationHistory).toHaveBeenCalledWith("desktop-review", 16);
  const metadata = { channel, chatType: "private", senderName: "Mira", modelContext: undefined };
  expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "desktop-review", "user", "Begin review", metadata);
  expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(2, "desktop-review", "assistant", "Contract reply", metadata);
  expect(h.build).toHaveBeenCalledTimes(1);
  expect(h.build).toHaveBeenCalledWith(expect.anything(), makeSessionId(channel, "review-room"), history);
});

it("keeps the group author's identity in model context while mirroring clean visible text", async () => {
  const appendBoundConversationMessage = vi.fn();
  const h = harness({}, { resolveBoundConversationId: () => "desktop-group", loadBoundConversationHistory: async () => [], appendBoundConversationMessage });
  await h.dispatcher.handleIncoming(incoming({ chatType: "group", senderId: "31415", senderName: "Mira", chatId: "27182", text: "Review starts now" }));
  expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(1, "desktop-group", "user", "Review starts now", {
    channel: "qq", chatType: "group", senderName: "Mira", modelContext: "[群聊发送者：Mira (31415)]\nReview starts now",
  });
});

it.each([true, false])("commits the selected sticker only when supported=%s", async supported => {
  const appendBoundConversationMessage = vi.fn();
  const h = harness({}, { resolveBoundConversationId: () => "desktop-sticker", loadBoundConversationHistory: async () => [], appendBoundConversationMessage }, supported);
  h.build.mockResolvedValue({ text: "Contract reply", sticker: "HAPPY" });
  await h.dispatcher.handleIncoming(incoming({ channel: supported ? "wechat" : "qq" }));
  if (supported) expect(appendBoundConversationMessage).toHaveBeenNthCalledWith(2, "desktop-sticker", "assistant", "Contract reply",
    expect.objectContaining({ channel: "wechat", sticker: "HAPPY" }));
  else expect(appendBoundConversationMessage.mock.calls[1][3]).not.toHaveProperty("sticker");
});

it.each(["history", "binding"] as const)("falls back to unbound channel history when %s lookup fails", async failed => {
  const history = [{ role: "user" as const, content: "Channel fallback discussion" }];
  const loadRecentChannelHistory = vi.fn(async () => history);
  const h = harness({}, {
    loadRecentChannelHistory, loadBoundConversationHistory: async () => { throw new Error("desktop history unavailable"); },
    resolveBoundConversationId: () => { if (failed === "binding") throw new Error("binding store unavailable"); return "desktop-missing"; },
  });
  expect((await h.dispatcher.handleIncoming(incoming()))?.targetId).toEqual("review-room");
  expect(loadRecentChannelHistory).toHaveBeenCalledWith(makeSessionId("qq", "review-room"), 16);
  expect(h.build).toHaveBeenCalledWith(expect.anything(), makeSessionId("qq", "review-room"), history);
});

it("does not commit or broadcast assistant state when the transport rejects a send", async () => {
  const appendBoundConversationMessage = vi.fn(), broadcastChat = vi.fn();
  const h = harness({ broadcastChat }, {
    resolveBoundConversationId: () => "desktop-review", loadBoundConversationHistory: async () => [], appendBoundConversationMessage,
  });
  h.send.mockResolvedValue({ ok: false, error: "connection unavailable" });
  expect(await h.dispatcher.handleIncoming(incoming())).toBeNull();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(appendBoundConversationMessage).toHaveBeenCalledTimes(1);
  expect(appendBoundConversationMessage).toHaveBeenCalledWith("desktop-review", "user", "Begin review", expect.anything());
  expect(appendHistory).not.toHaveBeenCalledWith(makeSessionId("qq", "review-room"), "assistant", expect.any(String));
  expect(appendLog).not.toHaveBeenCalledWith(expect.objectContaining({ dir: "outgoing" }));
  expect(broadcastChat).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bot:outgoing" }));
});

it("uses an injected delivery service and commits only after a successful send", async () => {
  const h = harness({ delivery: { send: vi.fn(async () => ({ ok: true })) } });
  const result = await h.dispatcher.handleIncoming(incoming());
  expect(result?.parts).toStrictEqual([{ kind: "text", text: "Contract reply" }]);
  expect(appendHistory).toHaveBeenCalledWith(makeSessionId("qq", "review-room"), "assistant", "Contract reply");
});

it.each([true, false])("retains temporary media through delivery and cleans it afterwards (success=%s)", async success => {
  const file = "D:/temporary/review.mp3";
  const files = new Set([file]);
  let presentAtSend = false;
  const cleanup = createOutgoingComposer({ removeFile: async path => { files.delete(path); } });
  const h = harness({
    composer: {
      compose: async input => ({ ...(await cleanup.compose(input)), transientFiles: [file],
        message: { channel: input.incoming.channel, targetId: input.incoming.chatId, parts: [{ kind: "audio", filePath: file }] } }),
      cleanupTransientFiles: cleanup.cleanupTransientFiles,
    },
    delivery: { send: async message => {
      const audio = message.parts.find(part => part.kind === "audio");
      presentAtSend = audio?.kind === "audio" && files.has(audio.filePath);
      return success ? { ok: true } : { ok: false, error: "delivery unavailable" };
    } },
  });
  const result = await h.dispatcher.handleIncoming(incoming({ channel: "feishu" }));
  expect(presentAtSend).toEqual(true);
  expect(files.size).toEqual(0);
  expect(result === null).toEqual(!success);
});

it.each(["same-external", "shared-desktop"] as const)("serializes the complete processing chain for %s conversations", async shared => {
  const gate = latch(), started = latch();
  const trace: string[] = [];
  let count = 0;
  const h = harness({
    buildAndRunAgent: async message => {
      trace.push(message.text + ":started");
      if (++count === 1) { started.release(); await gate.blocked; }
      return { text: message.text + ":reply", sticker: null };
    },
  }, shared === "shared-desktop" ? {
    resolveBoundConversationId: () => "shared-review", loadBoundConversationHistory: async () => [],
    appendBoundConversationMessage: async (_id, role) => { if (role === "assistant") trace.push("assistant committed"); },
  } : {});
  h.send.mockImplementation(async () => { trace.push("reply sent"); return { ok: true, error: undefined }; });
  const first = h.dispatcher.handleIncoming(incoming({ text: "earlier" }));
  await started.blocked;
  const second = h.dispatcher.handleIncoming(incoming({ text: "later",
    ...(shared === "shared-desktop" ? { senderId: "speaker-15", chatId: "other-review-room" } : {}) }));
  await microtasks();
  try { expect(trace).not.toContain("later:started"); }
  finally { gate.release(); await Promise.all([first, second]); }
  expect(trace.indexOf("later:started")).toBeGreaterThan(trace.indexOf(shared === "shared-desktop" ? "assistant committed" : "reply sent"));
});

it("allows two conversations with distinct desktop bindings to execute concurrently", async () => {
  const gate = latch();
  const started: string[] = [];
  const h = harness({ buildAndRunAgent: async message => {
    started.push(message.chatId); await gate.blocked; return { text: "Parallel reply", sticker: null };
  } }, { resolveBoundConversationId: id => "desktop-" + id, loadBoundConversationHistory: async () => [] });
  const first = h.dispatcher.handleIncoming(incoming({ senderId: "speaker-14", chatId: "north-room" }));
  const second = h.dispatcher.handleIncoming(incoming({ senderId: "speaker-15", chatId: "south-room" }));
  await microtasks();
  try { expect(new Set(started)).toStrictEqual(new Set(["north-room", "south-room"])); }
  finally { gate.release(); await Promise.all([first, second]); }
});

it("passes exact manager authority through canonical dispatch and rejects forged or revoked authority", async () => {
  const identity = createChannelMemoryAccountIdentity(); identity.authenticate("qq:contract-account");
  const adapter: ChannelAdapter = {
    id: "qq", displayName: "Contract", onMessage: null, capability: {} as never, start: async () => {}, stop: async () => {},
    send: async () => ({ ok: true }), getMemoryAccountIdentity: identity.read, getStatus: () => ({ enabled: true, phase: "running" }),
  };
  const manager = new ChannelManager(); manager.register(adapter);
  const context: ChannelContext = {
    resolveDispatchContext: vi.fn(sessionId => ({ sessionId, boundConversationId: "desktop-excluded" })),
    recordIncomingSession: vi.fn(), resolvePriorMessages: vi.fn(async () => [{ role: "user", content: "Private desktop discussion" }]),
    appendIncomingContext: vi.fn(), appendAssistantContext: vi.fn(),
  };
  const h = harness({ memoryEnabled: true, context });
  manager.setDispatcher((message, ingress) => h.dispatcher.handleIncoming(message, ingress));
  await manager.startOne("qq");
  try {
    const message = incoming();
    await adapter.onMessage!(message);
    expect(h.build).toHaveBeenCalledTimes(1);
    const args = h.build.mock.calls[0], binding = requireChannelMemoryIngress(args[3], message);
    expect(args[0]).toBe(message);
    expect(args[1]).toEqual(binding.sessionId);
    expect(args[2]).toStrictEqual([]);
    expect(context.resolvePriorMessages).not.toHaveBeenCalled();
    expect(context.appendIncomingContext).toHaveBeenCalledTimes(1);
    await expect(h.dispatcher.handleIncoming(message, {} as never)).rejects.toThrow("MEMORY_CHANNEL_INGRESS_DENIED");
    expect(h.build).toHaveBeenCalledTimes(1);
    h.build.mockImplementationOnce(async () => { identity.revoke(); return { text: "Stale response", sticker: null }; });
    expect(await adapter.onMessage!({ ...message, text: "Following event" })).toBeNull();
    expect(context.appendAssistantContext).toHaveBeenCalledTimes(1);
  } finally { await manager.stopAll(); }
});
