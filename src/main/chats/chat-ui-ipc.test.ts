import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
const state = vi.hoisted(() => {
    const profiles = [
        { id: "reasoning-primary", provider: "ChatGPT（OpenAI）", model: "profile-reasoning-model", baseUrl: "https://api.openai.com/v1", apiKey: "primary-test-key", explicitTransport: "openai" as const, reasoning: { mode: "on" as const, effort: "high" as const } },
        { id: "reasoning-custom", provider: "自定义", model: "custom-reasoner", baseUrl: "https://reasoning.invalid/v1", apiKey: "custom-test-key", explicitTransport: "openai" as const, reasoningLevels: { efforts: ["low" as const, "high" as const], allowOff: true } },
    ];
    return { handlers: new Map<string, any>(), sessions: new Map<string, any>(), saveProfile: vi.fn(), saveSettings: vi.fn(), sender: { id: 317, mainFrame: {}, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), removeListener: vi.fn() }, settings: { provider: "MiniMax（稀宇科技）", model: "global-mirror-model", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "mirror-test-key", perProvider: {}, thinkingOverride: -1, modelProfiles: profiles } };
});
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] }, screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) }, ipcMain: { handle: (channel: string, handler: any) => state.handlers.set(channel, handler), on: vi.fn() } }));
vi.mock("../settings/model-settings", () => ({
    loadModelSettings: () => state.settings, listSavedModelProfiles: (settings: any) => settings.modelProfiles,
    getDefaultModelProfile: (settings: any) => settings.modelProfiles[0],
    resolveModelSettingsProfile: (settings: any, id: string) => ({ ...settings, ...settings.modelProfiles.find((profile: any) => profile.id === id) }),
    saveModelProfile: state.saveProfile, saveModelSettings: state.saveSettings,
}));
vi.mock("./chats-store", () => ({ getSession: (id: string) => state.sessions.get(id) }));
vi.mock("../windows/window-state", () => ({ reactChatWindow: { webContents: state.sender, isDestroyed: () => false }, reactChatSession: {} }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); state.handlers.clear(); state.sessions.clear(); state.settings.model = "global-mirror-model"; });
async function register(onActiveTargetChanged?: () => void) { const { registerChatUiIpc } = await import("./chat-ui-ipc"); registerChatUiIpc({ windowManager: null, live2dWindowLifecycle: { getDiagnostics: () => ({}) }, onActiveTargetChanged }); }
describe("reasoning profile selection", () => {
    it("reads the bound model's provider, transport, preference and override", async () => {
        state.sessions.set("bound-session", { id: "bound-session", modelProfileId: "reasoning-primary" });
        await register();
        expect(state.handlers.get(IPC.CHAT_GET_REASONING_STATE)({}, { sessionId: "bound-session" })).toMatchObject({ providerKey: "ChatGPT（OpenAI）", providerId: "chatgpt", model: "profile-reasoning-model", preference: { mode: "on", effort: "high" }, thinkingOverride: 0, transport: "openai", modelProfileId: "reasoning-primary" });
    });
    it("returns custom API effort declarations in their original order", async () => {
        state.sessions.set("custom-session", { id: "custom-session", modelProfileId: "reasoning-custom" });
        await register();
        expect(state.handlers.get(IPC.CHAT_GET_REASONING_STATE)({}, { sessionId: "custom-session" })).toMatchObject({ model: "custom-reasoner", reasoningLevels: { efforts: ["low", "high"], allowOff: true } });
    });
    it("uses the default profile when the welcome screen mirror is empty", async () => {
        state.settings.model = "";
        await register();
        expect(state.handlers.get(IPC.CHAT_GET_REASONING_STATE)({}, {})).toMatchObject({ providerKey: "ChatGPT（OpenAI）", model: "profile-reasoning-model", modelProfileId: "reasoning-primary" });
    });
    it("honors the welcome screen's pending profile", async () => {
        await register();
        expect(state.handlers.get(IPC.CHAT_GET_REASONING_STATE)({}, { modelProfileId: "reasoning-primary" })).toMatchObject({ modelProfileId: "reasoning-primary", preference: { mode: "on", effort: "high" } });
    });
    it.each([false, true])("writes to the selected profile with bound session=%s", async (bound) => {
        if (bound)
            state.sessions.set("bound-session", { id: "bound-session", modelProfileId: "reasoning-primary" });
        await register();
        state.handlers.get(IPC.CHAT_SET_REASONING)({}, { ...(bound ? { sessionId: "bound-session" } : { modelProfileId: "reasoning-primary" }), providerKey: "ChatGPT（OpenAI）", preference: { mode: "on", effort: "max" } });
        expect(state.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "reasoning-primary", provider: "ChatGPT（OpenAI）", reasoning: { mode: "on", effort: "max" } }));
        expect(state.saveSettings).not.toHaveBeenCalled();
    });
    it("rejects a provider mismatch without saving either profile or global settings", async () => {
        await register();
        state.handlers.get(IPC.CHAT_SET_REASONING)({}, { modelProfileId: "reasoning-primary", providerKey: "MiniMax（稀宇科技）", preference: { mode: "on", effort: "max" } });
        expect(state.saveProfile).not.toHaveBeenCalled();
        expect(state.saveSettings).not.toHaveBeenCalled();
    });
});
it("synchronously updates private browser ownership only for the trusted renderer", async () => {
    const { activeChatTargetRegistry: targets } = await import("../plugin-host/active-chat-target");
    const changes: Array<string | null> = [];
    await register(() => { changes.push(targets.getActive()?.sessionId ?? null); });
    const invoke = state.handlers.get(IPC.CHATS_SET_ACTIVE_SESSION);
    expect(invoke({ sender: {} }, { sessionId: "untrusted-session", mode: "chat", rendererTargetId: "renderer-317" })).toEqual(false);
    expect(changes).toEqual([]);
    expect(invoke({ sender: state.sender }, { sessionId: "selected-session", mode: "code", rendererTargetId: "renderer-317" })).toEqual(true);
    expect(changes).toEqual(["selected-session"]);
    expect(invoke({ sender: state.sender }, null)).toEqual(true);
    expect(changes).toEqual(["selected-session", null]);
    targets.dispose();
});
