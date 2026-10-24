import { beforeEach, expect, it, vi } from "vitest";
import { createDefaultProactiveState } from "./proactive-policy";
import { requireBackgroundMemoryIngress } from "../memory-context/background-memory-ingress";
const mocks = vi.hoisted(() => ({ state: {} as any, listSessions: vi.fn(() => []), getSessionByPurpose: vi.fn(() => null), legacy: vi.fn(async () => "legacy forbidden"), worldbook: vi.fn(async () => "worldbook stays"), searchMemory: vi.fn(async () => ["imported stays"]), profile: { id: "saved-luna", provider: "fixture", baseUrl: "https://fixture.invalid", model: "luna", apiKey: "synthetic", contextWindowTokens: 128000 } }));
vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 0 } }));
vi.mock("../chats/chats-store", () => ({ listSessions: mocks.listSessions, getSessionByPurpose: mocks.getSessionByPurpose }));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({ canStartProactiveChannelDelivery: vi.fn(), sendProactiveChannelMessage: vi.fn() }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: mocks.legacy, buildMemoryInjection: mocks.legacy, buildWorldbookContext: mocks.worldbook }));
vi.mock("../rag", () => ({ searchMemory: mocks.searchMemory }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "persona" }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: () => ({ ...mocks.profile, modelProfiles: [mocks.profile], defaultModelProfileId: mocks.profile.id }), getDefaultModelProfile: () => mocks.profile, resolveModelSettingsProfile: () => mocks.profile }));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: "UTC" }) }));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: () => mocks.state, saveProactiveState: vi.fn() }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("../orchestrator/vendors", () => ({ getAdapterForConfig: () => ({}) }));
import { createProactiveLifecycle } from "./proactive-lifecycle";
beforeEach(() => { vi.clearAllMocks(); mocks.state = createDefaultProactiveState(); mocks.profile.provider = "fixture"; mocks.profile.apiKey = "synthetic"; });
it.each([false, true])("uses only its own trusted canonical S and preserves worldbook/imported docs without legacy reads (local=%s)", async local => {
  if (local) { mocks.profile.provider = "自定义端点（本地）"; mocks.profile.apiKey = ""; }
  const call = vi.fn(async () => ({ text: '{"decision":"silent","text":""}' }));
  const close = vi.fn(async () => {}), sink = { appendAssistant: vi.fn(async () => "a"), checkpoint: vi.fn(async () => {}) };
  const prepareBackgroundRun = vi.fn(async (input: any) => {
    const ingress = requireBackgroundMemoryIngress(input.ingress);
    expect(ingress).toMatchObject({ entry: "proactive", sourceTrust: "system", sessionId: "proactive-memory-v1" });
    expect(input).not.toHaveProperty("readParentGrant");
    return { sessionId: ingress.sessionId, signal: ingress.signal, transcriptSink: sink,
      openMemoryRun: async () => ({ call, bindSink: () => sink, close }), close };
  });
  const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => ({ proactiveChatMode: "on", proactiveDeliveryTarget: "local" } as any), memoryHost: { prepareBackgroundRun } as any });
  lifecycle.initializeProactiveChatService();
  await lifecycle.getProactiveChatService()!.evaluateCandidate({ sceneId: "work_break", score: 90, sceneCooldownMs: 0 });
  expect(prepareBackgroundRun).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce();
  expect(mocks.listSessions).not.toHaveBeenCalled(); expect(mocks.getSessionByPurpose).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  expect(mocks.searchMemory).toHaveBeenCalledWith("work_break", "imported_doc", 2);
  expect(call.mock.calls[0][0].request.messages[0].content).toContain("worldbook stays");
  expect(call.mock.calls[0][0].request.messages[0].content).toContain("imported stays");
  expect(call.mock.calls[0][0].request.maxTokens).toBe(600);
  await lifecycle.close(); expect(close).toHaveBeenCalled();
});

it("does not bypass required credentials on cloud providers", async () => {
  mocks.profile.provider = "自定义端点（云端）"; mocks.profile.apiKey = "";
  const prepareBackgroundRun = vi.fn();
  const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => ({ proactiveChatMode: "on", proactiveDeliveryTarget: "local" } as any), memoryHost: { prepareBackgroundRun } });
  lifecycle.initializeProactiveChatService();
  await lifecycle.getProactiveChatService()!.evaluateCandidate({ sceneId: "work_break", score: 90, sceneCooldownMs: 0 });
  expect(prepareBackgroundRun).not.toHaveBeenCalled(); await lifecycle.close();
});
