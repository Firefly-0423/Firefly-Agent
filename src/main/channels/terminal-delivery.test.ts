import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FireflyRunTerminalResult } from "../../shared/run-terminal";
import type { IncomingMessage, OutgoingMessage } from "./types";

const fake = vi.hoisted(() => ({
  terminal: undefined as FireflyRunTerminalResult | undefined,
  eventOnly: false,
  error: undefined as Error | undefined,
  text: "synthetic reply",
  sent: [] as OutgoingMessage[],
  history: [] as Array<{ role: string; content: string }>,
  indexed: vi.fn(),
  deliveryOk: true,
  handle: undefined as ((message: IncomingMessage) => Promise<OutgoingMessage | null>) | undefined,
}));
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() } }));
vi.mock("./init", () => ({
  initializeChannels: (options: { handleIncoming: typeof fake.handle }) => { fake.handle = options.handleIncoming; },
  startChannels: async () => {}, shutdownChannels: async () => {},
}));
vi.mock("./manager", () => ({ channelManager: { getAdapter: () => ({
  capability: { text: true, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, maxTextLength: 500 },
  send: async (message: OutgoingMessage) => { fake.sent.push(message); return { ok: fake.deliveryOk }; },
}) } }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: () => ({
  resolve: () => null, observe: () => {}, flush: () => {},
}) }));
vi.mock("../chats/chats-store", () => ({ appendMessage: vi.fn(), getSession: () => null, listSessions: () => [] }));
vi.mock("./history-log", () => ({
  appendHistory: (_session: string, role: string, content: string) => { fake.history.push({ role, content }); },
  loadRecentHistory: async () => [], migrateHistory: () => {},
}));
vi.mock("./message-log", () => ({ appendLog: () => {} }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] } }));
vi.mock("../orchestrator/tools/history-tools", () => ({ indexConversationTurn: fake.indexed }));
vi.mock("../chat/image-caption", () => ({ captionImageSafe: vi.fn(), IMAGE_CAPTION_PROMPT: "unused" }));
vi.mock("./agent-input", () => ({ buildChannelAttachmentInputs: async () => ({}) }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: () => ({}), resolveModelSettingsProfile: () => ({ multimodal: false }) }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: () => ({
  toolSandbox: "safe", rateLimitPerUser: 50, rateLimitPerChannel: 50, stickerEnabled: false, mirrorToDesktop: false,
}) }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {
  get lastResult() { return fake.eventOnly ? undefined : { reply: fake.text, toolResults: [], terminal: fake.terminal }; }
  runWithEvents() { return { subscribe: (observer: {
    next?: (event: unknown) => void; complete: () => void; error: (error: Error) => void;
  }) => {
    if (fake.error) observer.error(fake.error);
    else {
      if (fake.terminal) observer.next?.({ type: "RUN_FINISHED", result: fake.terminal });
      observer.complete();
    }
  } }; }
} }));

import { createChannelsSubsystem, type ChannelsSubsystemDeps } from "./bootstrap";

const incoming: IncomingMessage = { channel: "qq", chatType: "private", chatId: "synthetic-chat", senderId: "synthetic-user", text: "synthetic question", at: new Date(0) };
function fixture(memory?: ChannelsSubsystemDeps["memory"]) {
  const finished = vi.fn(async () => ({ sticker: null }));
  const lifecycle = { publishTurnStarted: vi.fn(), publishTurnFinished: vi.fn(), publishSchedulerFinished: vi.fn(), publishToolFinished: vi.fn() };
  const subsystem = createChannelsSubsystem({
    agentRuntime: { buildOptions: async () => ({ options: { executionMode: "chat", conversationMode: "chat", messages: [] } }),
      onRunFinished: finished } as unknown as ChannelsSubsystemDeps["agentRuntime"],
    getReactChatWindow: () => null, publishLifecycle: lifecycle, ...(memory ? { memory } : {}),
  });
  subsystem.initialize();
  return { finished, lifecycle, run: () => fake.handle!(incoming) };
}
function deliveredText() {
  return fake.sent.flatMap(message => message.parts).map(part => part.kind === "text" ? part.text : "").join("\n");
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.terminal = undefined; fake.eventOnly = false; fake.error = undefined; fake.text = "synthetic reply";
  fake.sent.length = 0; fake.history.length = 0; fake.deliveryOk = true;
});

describe("channel Agent terminal reaches the recipient through real dispatch", () => {
  it("does not send a failure notice for memory ingress that was never authorized or is no longer issued", async () => {
    const prepareRun = vi.fn(async () => { throw Error("unauthorized preparation"); });
    const f = fixture({ prepareRun });
    expect(await f.run()).toBeNull();
    expect(fake.sent).toEqual([]); expect(fake.history).toEqual([]);
    expect(prepareRun).not.toHaveBeenCalled();
  });
  it("keeps successful and legacy completion as an ordinary reply", async () => {
    const f = fixture(); await f.run();
    expect(deliveredText()).toBe("synthetic reply");
    expect(fake.history.filter(row => row.role === "assistant")).toEqual([{ role: "assistant", content: "synthetic reply" }]);
    expect(f.finished).toHaveBeenCalledOnce();
  });
  it.each(["timeout", "cancelled", "runtime_error"] as const)("labels %s and its partial output without committing success", async status => {
    fake.terminal = { status, reason: "PRIVATE_PROVIDER_BODY", externalEffectsMayContinue: true };
    const f = fixture(); await f.run();
    expect(deliveredText()).toContain(`[${status}]`);
    expect(deliveredText()).toContain("部分输出");
    expect(deliveredText()).toContain("synthetic reply");
    expect(deliveredText()).toContain("外部操作可能仍在继续");
    expect(deliveredText()).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(fake.history.filter(row => row.role === "assistant")).toEqual([]);
    expect(fake.indexed).not.toHaveBeenCalled(); expect(f.finished).not.toHaveBeenCalled();
    expect(f.lifecycle.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });
  it.each(["cancelled", "timeout", "runtime_error"] as const)("uses event-only %s even when the Agent has no lastResult", async status => {
    fake.eventOnly = true; fake.terminal = { status, externalEffectsMayContinue: true };
    const f = fixture(); await f.run();
    expect(deliveredText()).toContain(`[${status}]`);
    expect(f.lifecycle.publishTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(fake.history.filter(row => row.role === "assistant")).toEqual([]);
  });
  it("keeps the timeout/effects notice visible when adapter capability truncates a long partial reply", async () => {
    fake.text = "partial ".repeat(1000); fake.terminal = { status: "timeout", externalEffectsMayContinue: true };
    await fixture().run();
    expect(deliveredText()).toContain("[timeout]"); expect(deliveredText()).toContain("外部操作可能仍在继续");
  });
  it("warns about uncertain external effects even after a success terminal", async () => {
    fake.terminal = { status: "success", externalEffectsMayContinue: true };
    await fixture().run();
    expect(deliveredText()).toContain("外部操作可能仍在继续");
    expect(fake.history.find(row => row.role === "assistant")?.content).toContain("外部操作可能仍在继续");
  });
  it("sends a safe runtime error notice when the Agent throws, without leaking its private exception", async () => {
    fake.error = Error("PRIVATE_SECRET_PROVIDER_BODY");
    const f = fixture(); await f.run();
    expect(deliveredText()).toContain("[runtime_error]"); expect(deliveredText()).toContain("外部操作可能仍在继续");
    expect(deliveredText()).not.toContain("PRIVATE_SECRET_PROVIDER_BODY");
    expect(fake.history.filter(row => row.role === "assistant")).toEqual([]);
    expect(f.finished).not.toHaveBeenCalled();
  });
  it("does not commit a failed delivery as an assistant response", async () => {
    fake.deliveryOk = false; fake.terminal = { status: "timeout", externalEffectsMayContinue: true };
    expect(await fixture().run()).toBeNull();
    expect(fake.history.filter(row => row.role === "assistant")).toEqual([]);
  });
});
