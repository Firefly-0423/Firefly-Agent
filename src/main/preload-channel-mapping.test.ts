import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc-channels";
import { MANUAL_BROWSER_WORKSPACE_IPC } from "../shared/manual-browser";
import { SIDEBAR_LAYOUT_IPC } from "../shared/sidebar-layout";

const harness = vi.hoisted(() => {
  const exposed = new Map<string, Record<string, any>>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const removeChannelListener = (channel: string, listener: (...args: unknown[]) => void) => {
    listeners.get(channel)?.delete(listener);
  };

  return {
    exposed,
    listeners,
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    }),
    off: vi.fn(removeChannelListener),
    removeListener: vi.fn(removeChannelListener),
    getPathForFile: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, any>) => {
      harness.exposed.set(name, api);
    },
  },
  ipcRenderer: {
    invoke: harness.invoke,
    send: harness.send,
    on: harness.on,
    off: harness.off,
    removeListener: harness.removeListener,
  },
  webUtils: {
    getPathForFile: harness.getPathForFile,
  },
}));

interface MappingCase {
  path: string;
  op: "invoke" | "send";
  channel: string;
  callArgs: unknown[];
  expectedArgs: unknown[];
}

const CHANNEL_MAPPING_CASES: readonly MappingCase[] = [
  // desktopAsr (4)
  { path: "desktopAsr.start", op: "invoke", channel: IPC.DESKTOP_ASR_START, callArgs: ["entity-1"], expectedArgs: ["entity-1"] },
  { path: "desktopAsr.frame", op: "invoke", channel: IPC.DESKTOP_ASR_FRAME, callArgs: ["entity-1", new Uint8Array([1, 2])], expectedArgs: ["entity-1", new Uint8Array([1, 2])] },
  { path: "desktopAsr.stop", op: "invoke", channel: IPC.DESKTOP_ASR_STOP, callArgs: ["entity-1"], expectedArgs: ["entity-1"] },
  { path: "desktopAsr.cancel", op: "invoke", channel: IPC.DESKTOP_ASR_CANCEL, callArgs: ["entity-1"], expectedArgs: ["entity-1"] },

  // firefly (5)
  { path: "firefly.minimize", op: "send", channel: IPC.WINDOW_MINIMIZE, callArgs: [], expectedArgs: [] },
  { path: "firefly.setInteractive", op: "invoke", channel: IPC.WINDOW_SET_INTERACTIVE, callArgs: [true], expectedArgs: [true] },
  { path: "firefly.moveTo", op: "send", channel: IPC.WINDOW_MOVE_TO, callArgs: [120, 240], expectedArgs: [120, 240] },
  { path: "firefly.setDragging", op: "send", channel: IPC.WINDOW_SET_DRAGGING, callArgs: [true], expectedArgs: [true] },
  { path: "firefly.getCursorPosition", op: "invoke", channel: IPC.WINDOW_GET_CURSOR_POSITION, callArgs: [], expectedArgs: [] },

  // live2dWork (1)
  { path: "live2dWork.getWorking", op: "invoke", channel: IPC.LIVE2D_GET_WORKING, callArgs: [], expectedArgs: [] },

  // appUpdate (3)
  { path: "appUpdate.getState", op: "invoke", channel: IPC.APP_UPDATE_GET_STATE, callArgs: [], expectedArgs: [] },
  { path: "appUpdate.download", op: "invoke", channel: IPC.APP_UPDATE_DOWNLOAD, callArgs: [], expectedArgs: [] },
  { path: "appUpdate.install", op: "invoke", channel: IPC.APP_UPDATE_INSTALL, callArgs: [], expectedArgs: [] },

  // sidebar (4)
  { path: "sidebar.minimize", op: "send", channel: IPC.SIDEBAR_MINIMIZE, callArgs: [], expectedArgs: [] },
  { path: "sidebar.close", op: "send", channel: IPC.SIDEBAR_CLOSE, callArgs: [], expectedArgs: [] },
  { path: "sidebar.toggleAlwaysOnTop", op: "invoke", channel: IPC.SIDEBAR_TOGGLE_ALWAYS_ON_TOP, callArgs: [], expectedArgs: [] },
  { path: "sidebar.openSettings", op: "send", channel: IPC.SIDEBAR_OPEN_SETTINGS, callArgs: ["general"], expectedArgs: ["general"] },

  // toast (4)
  { path: "toast.getAll", op: "invoke", channel: IPC.TOAST_GET_ALL, callArgs: [], expectedArgs: [] },
  { path: "toast.clicked", op: "send", channel: IPC.TOAST_CLICKED, callArgs: ["toast-1"], expectedArgs: ["toast-1"] },
  { path: "toast.dismissed", op: "send", channel: IPC.TOAST_DISMISSED, callArgs: ["toast-1"], expectedArgs: ["toast-1"] },
  { path: "toast.reportHeight", op: "send", channel: IPC.TOAST_RESIZE, callArgs: [128], expectedArgs: [128] },
  { path: "toast.inspectApproval", op: "invoke", channel: IPC.TOAST_APPROVAL_INSPECT, callArgs: ["approve-1"], expectedArgs: ["approve-1"] },
  { path: "toast.resolveApproval", op: "invoke", channel: IPC.TOAST_APPROVAL_ANSWER, callArgs: ["approve-1", false], expectedArgs: [{ id: "approve-1", allowed: false }] },

  // chat (15; ingestDroppedFiles is verified in preload-parameter-guards.test.ts)
  { path: "chat.minimize", op: "send", channel: IPC.CHAT_MINIMIZE, callArgs: [], expectedArgs: [] },
  { path: "chat.close", op: "send", channel: IPC.CHAT_CLOSE, callArgs: [], expectedArgs: [] },
  { path: "chat.toggleMaximize", op: "send", channel: IPC.CHAT_TOGGLE_MAXIMIZE, callArgs: [], expectedArgs: [] },
  { path: "chat.isMaximized", op: "invoke", channel: IPC.CHAT_IS_MAXIMIZED, callArgs: [], expectedArgs: [] },
  { path: "chat.startWindowDrag", op: "send", channel: IPC.CHAT_WINDOW_DRAG_START, callArgs: [], expectedArgs: [] },
  { path: "chat.endWindowDrag", op: "send", channel: IPC.CHAT_WINDOW_DRAG_END, callArgs: [], expectedArgs: [] },
  { path: "chat.getEnabledStickers", op: "invoke", channel: IPC.STICKERS_GET_ENABLED, callArgs: [], expectedArgs: [] },
  { path: "chat.captionImage", op: "invoke", channel: IPC.CHAT_CAPTION_IMAGE, callArgs: ["/tmp/pic.png", true], expectedArgs: [{ filePath: "/tmp/pic.png", hasAnnotations: true }] },
  { path: "chat.getImagePreview", op: "invoke", channel: IPC.CHAT_GET_IMAGE_PREVIEW, callArgs: ["/tmp/pic.png"], expectedArgs: [{ filePath: "/tmp/pic.png" }] },
  { path: "chat.getImageSendStrategy", op: "invoke", channel: IPC.CHAT_GET_IMAGE_SEND_STRATEGY, callArgs: ["s-1"], expectedArgs: [{ sessionId: "s-1" }] },
  { path: "chat.getGeneralSettings", op: "invoke", channel: IPC.SETTINGS_GET_GENERAL, callArgs: [], expectedArgs: [] },
  { path: "chat.getReasoningState", op: "invoke", channel: IPC.CHAT_GET_REASONING_STATE, callArgs: [{ sessionId: "s-1" }], expectedArgs: [{ sessionId: "s-1" }] },
  { path: "chat.setReasoning", op: "invoke", channel: IPC.CHAT_SET_REASONING, callArgs: [{ sessionId: "s-1", providerKey: "openai", preference: "high" }], expectedArgs: [{ sessionId: "s-1", providerKey: "openai", preference: "high" }] },
  { path: "chat.startScreenshot", op: "invoke", channel: IPC.SCREENSHOT_START, callArgs: [], expectedArgs: [] },
  { path: "chat.saveScreenshotTemp", op: "invoke", channel: IPC.SCREENSHOT_SAVE_TEMP, callArgs: ["YmFzZTY0", "image/png"], expectedArgs: ["YmFzZTY0", "image/png"] },

  // choice (1)
  { path: "choice.resolve", op: "invoke", channel: IPC.CHOICE_RESOLVE, callArgs: ["q-1", "confirm"], expectedArgs: [{ id: "q-1", value: "confirm" }] },

  // agui (4)
  { path: "agui.run", op: "invoke", channel: IPC.AGUI_RUN, callArgs: [{ messages: [], sessionId: "s-1" }], expectedArgs: [{ messages: [], sessionId: "s-1" }] },
  { path: "agui.cancel", op: "invoke", channel: IPC.AGUI_CANCEL, callArgs: ["run-1"], expectedArgs: ["run-1"] },
  { path: "agui.reportRunPersisted", op: "send", channel: IPC.AGUI_RUN_PERSISTED, callArgs: [{ runId: "run-1", finalMessageId: "m-1" }], expectedArgs: [{ runId: "run-1", finalMessageId: "m-1" }] },
  { path: "agui.getRunStatus", op: "invoke", channel: IPC.AGUI_RUN_STATUS, callArgs: [{ sessionId: "s-1", candidates: [{ assistantTurnId: "m-1" }] }], expectedArgs: [{ sessionId: "s-1", candidates: [{ assistantTurnId: "m-1" }] }] },
  { path: "agui.getInterruptedRun", op: "invoke", channel: IPC.AGENT_RUN_GET_INTERRUPTED, callArgs: ["s-1"], expectedArgs: ["s-1"] },

  // fireflyTheme, fireflyFont, fireflyAppearance (4)
  { path: "fireflyTheme.getColors", op: "invoke", channel: IPC.UI_COLORS_GET, callArgs: [], expectedArgs: [] },
  { path: "fireflyTheme.get", op: "invoke", channel: IPC.UI_THEME_GET, callArgs: [], expectedArgs: [] },
  { path: "fireflyFont.get", op: "invoke", channel: IPC.UI_FONT_GET, callArgs: [], expectedArgs: [] },
  { path: "fireflyAppearance.get", op: "invoke", channel: IPC.SETTINGS_GET_GENERAL, callArgs: [], expectedArgs: [] },

  // settings (65 top-level + 5 externalSkills = 70)
  { path: "settings.minimize", op: "send", channel: IPC.SETTINGS_MINIMIZE, callArgs: [], expectedArgs: [] },
  { path: "settings.close", op: "send", channel: IPC.SETTINGS_CLOSE, callArgs: [], expectedArgs: [] },
  { path: "settings.getConfig", op: "invoke", channel: IPC.SETTINGS_GET_CONFIG, callArgs: [], expectedArgs: [] },
  { path: "settings.saveConfig", op: "invoke", channel: IPC.SETTINGS_SAVE_CONFIG, callArgs: [{ provider: "openai" }], expectedArgs: [{ provider: "openai" }] },
  { path: "settings.listModelProfiles", op: "invoke", channel: IPC.SETTINGS_MODEL_PROFILES_LIST, callArgs: [], expectedArgs: [] },
  { path: "settings.getAgentRouting", op: "invoke", channel: IPC.SETTINGS_AGENT_ROUTING_GET, callArgs: [], expectedArgs: [] },
  { path: "settings.updateAgentRouting", op: "invoke", channel: IPC.SETTINGS_AGENT_ROUTING_UPDATE, callArgs: [{ defaultProfileId: "p-1" }], expectedArgs: [{ defaultProfileId: "p-1" }] },
  { path: "settings.saveModelProfile", op: "invoke", channel: IPC.SETTINGS_MODEL_PROFILE_SAVE, callArgs: [{ id: "p-1" }], expectedArgs: [{ id: "p-1" }] },
  { path: "settings.deleteModelProfile", op: "invoke", channel: IPC.SETTINGS_MODEL_PROFILE_DELETE, callArgs: ["p-1"], expectedArgs: ["p-1"] },
  { path: "settings.setDefaultModelProfile", op: "invoke", channel: IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, callArgs: ["p-1"], expectedArgs: ["p-1"] },
  { path: "settings.fetchModels", op: "invoke", channel: IPC.SETTINGS_FETCH_MODELS, callArgs: [{ provider: "openai", baseUrl: "https://api.example.com", apiKey: "sk-test", explicitTransport: "responses" }], expectedArgs: [{ provider: "openai", baseUrl: "https://api.example.com", apiKey: "sk-test", explicitTransport: "responses" }] },
  { path: "settings.resolveInputModalities", op: "invoke", channel: IPC.SETTINGS_RESOLVE_INPUT_MODALITIES, callArgs: [{ provider: "openai", model: "gpt-4o", inputModalities: ["text", "image"], inputModalitiesSource: "user" }], expectedArgs: [{ provider: "openai", model: "gpt-4o", inputModalities: ["text", "image"], inputModalitiesSource: "user" }] },
  { path: "settings.testConnection", op: "invoke", channel: IPC.SETTINGS_TEST_CONNECTION, callArgs: [{ provider: "anthropic", baseUrl: "https://api.example.com", model: "claude", apiKey: "sk-test" }], expectedArgs: [{ provider: "anthropic", baseUrl: "https://api.example.com", model: "claude", apiKey: "sk-test" }] },
  { path: "settings.getGeneral", op: "invoke", channel: IPC.SETTINGS_GET_GENERAL, callArgs: [], expectedArgs: [] },
  { path: "settings.saveGeneral", op: "invoke", channel: IPC.SETTINGS_SAVE_GENERAL, callArgs: [{ chatFontSize: 15 }], expectedArgs: [{ chatFontSize: 15 }] },
  { path: "settings.getTimeoutSettings", op: "invoke", channel: IPC.SETTINGS_GET_TIMEOUT_SETTINGS, callArgs: [], expectedArgs: [] },
  { path: "settings.saveTimeoutSettings", op: "invoke", channel: IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, callArgs: [{ requestTimeoutMs: 30000 }], expectedArgs: [{ requestTimeoutMs: 30000 }] },
  { path: "settings.pickUiFont", op: "invoke", channel: IPC.SETTINGS_PICK_UI_FONT, callArgs: [], expectedArgs: [] },
  { path: "settings.importUiFont", op: "invoke", channel: IPC.SETTINGS_IMPORT_UI_FONT, callArgs: ["/tmp/font.ttf"], expectedArgs: ["/tmp/font.ttf"] },
  { path: "settings.resetUiFont", op: "invoke", channel: IPC.SETTINGS_RESET_UI_FONT, callArgs: [], expectedArgs: [] },
  { path: "settings.setPetAlwaysOnTop", op: "send", channel: IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, callArgs: [true], expectedArgs: [true] },
  { path: "settings.setPetVisible", op: "send", channel: IPC.SETTINGS_SET_PET_VISIBLE, callArgs: [false], expectedArgs: [false] },
  { path: "settings.setPetZoom", op: "send", channel: IPC.SETTINGS_SET_PET_ZOOM, callArgs: [1.5], expectedArgs: [1.5] },
  { path: "settings.openStickerManager", op: "invoke", channel: IPC.SETTINGS_OPEN_STICKER_MANAGER, callArgs: [], expectedArgs: [] },
  { path: "settings.stickerPickFile", op: "invoke", channel: IPC.STICKERS_PICK_FILE, callArgs: [], expectedArgs: [] },
  { path: "settings.stickerAdd", op: "invoke", channel: IPC.STICKERS_ADD, callArgs: [{ sourcePath: "/tmp/s.png", id: "s1", description: "wave", phrases: ["hi"] }], expectedArgs: [{ sourcePath: "/tmp/s.png", id: "s1", description: "wave", phrases: ["hi"] }] },
  { path: "settings.embeddingSetModel", op: "invoke", channel: IPC.EMBEDDING_SET_MODEL, callArgs: ["bge-m3"], expectedArgs: ["bge-m3"] },
  { path: "settings.rerankerSetMode", op: "invoke", channel: IPC.RERANKER_SET_MODE, callArgs: ["standard"], expectedArgs: ["standard"] },
  { path: "settings.getRerankerStatus", op: "invoke", channel: IPC.RERANKER_GET_STATUS, callArgs: [], expectedArgs: [] },
  { path: "settings.getToolCatalog", op: "invoke", channel: IPC.TOOL_GET_CATALOG, callArgs: [], expectedArgs: [] },
  { path: "settings.getToolModeOverrides", op: "invoke", channel: IPC.TOOL_GET_MODE_OVERRIDES, callArgs: [], expectedArgs: [] },
  { path: "settings.setToolModeOverride", op: "invoke", channel: IPC.TOOL_SET_MODE_OVERRIDE, callArgs: ["bash", "work", true], expectedArgs: [{ toolId: "bash", mode: "work", enabled: true }] },
  { path: "settings.externalSkills.list", op: "invoke", channel: IPC.EXTERNAL_SKILLS_LIST, callArgs: ["openai", true], expectedArgs: [{ sourceId: "openai", refresh: true }] },
  { path: "settings.externalSkills.detail", op: "invoke", channel: IPC.EXTERNAL_SKILLS_DETAIL, callArgs: ["openai", "sk-1", { kind: "reviewed", commit: "abc" }], expectedArgs: [{ sourceId: "openai", id: "sk-1", selection: { kind: "reviewed", commit: "abc" } }] },
  { path: "settings.externalSkills.prepare", op: "invoke", channel: IPC.EXTERNAL_SKILLS_PREPARE, callArgs: ["anthropic", "sk-2"], expectedArgs: [{ sourceId: "anthropic", id: "sk-2" }] },
  { path: "settings.externalSkills.commit", op: "invoke", channel: IPC.EXTERNAL_SKILLS_COMMIT, callArgs: ["tok-1"], expectedArgs: [{ token: "tok-1" }] },
  { path: "settings.externalSkills.cancel", op: "invoke", channel: IPC.EXTERNAL_SKILLS_CANCEL, callArgs: [], expectedArgs: [{}] },
  { path: "settings.setSkillEnabled", op: "invoke", channel: IPC.SKILL_SET_ENABLED, callArgs: ["sk-1", true], expectedArgs: [{ id: "sk-1", enabled: true }] },
  { path: "settings.getSkillCatalog", op: "invoke", channel: IPC.SKILL_GET_CATALOG, callArgs: [], expectedArgs: [] },
  { path: "settings.rescanSkills", op: "invoke", channel: IPC.SKILL_RESCAN, callArgs: [], expectedArgs: [] },
  { path: "settings.translateSkillDescriptions", op: "invoke", channel: IPC.SKILL_TRANSLATE_DESCRIPTIONS, callArgs: [], expectedArgs: [] },
  { path: "settings.getSkillModeOverrides", op: "invoke", channel: IPC.SKILL_GET_MODE_OVERRIDES, callArgs: [], expectedArgs: [] },
  { path: "settings.setSkillModeOverride", op: "invoke", channel: IPC.SKILL_SET_MODE_OVERRIDE, callArgs: ["sk-1", "code", false], expectedArgs: [{ skillId: "sk-1", mode: "code", enabled: false }] },
  { path: "settings.addMcpServer", op: "invoke", channel: IPC.MCP_ADD_SERVER, callArgs: [{ id: "mcp-1" }], expectedArgs: [{ id: "mcp-1" }] },
  { path: "settings.removeMcpServer", op: "invoke", channel: IPC.MCP_REMOVE_SERVER, callArgs: ["mcp-1"], expectedArgs: ["mcp-1"] },
  { path: "settings.listMcpServers", op: "invoke", channel: IPC.MCP_LIST_SERVERS, callArgs: [], expectedArgs: [] },
  { path: "settings.setMcpServerEnabled", op: "invoke", channel: IPC.MCP_SET_ENABLED, callArgs: ["mcp-1", true], expectedArgs: [{ id: "mcp-1", enabled: true }] },
  { path: "settings.channelsGetConfig", op: "invoke", channel: IPC.CHANNELS_GET_CONFIG, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsSaveConfig", op: "invoke", channel: IPC.CHANNELS_SAVE_CONFIG, callArgs: [{ wechat: { enabled: true } }], expectedArgs: [{ wechat: { enabled: true } }] },
  { path: "settings.channelsGetStatus", op: "invoke", channel: IPC.CHANNELS_GET_STATUS, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsRestart", op: "invoke", channel: IPC.CHANNELS_RESTART, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsSenderResolve", op: "invoke", channel: IPC.CHANNELS_SENDER_RESOLVE, callArgs: [{ channel: "wechat", senderId: "u-1", action: "approve" }], expectedArgs: [{ channel: "wechat", senderId: "u-1", action: "approve" }] },
  { path: "settings.channelsWechatLoginStart", op: "invoke", channel: IPC.CHANNELS_WECHAT_LOGIN_START, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsQqTestConnection", op: "invoke", channel: IPC.CHANNELS_QQ_TEST_CONNECTION, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsQqResolveAuthRequirement", op: "invoke", channel: IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT, callArgs: [{ listenMode: "local" }], expectedArgs: [{ listenMode: "local" }] },
  { path: "settings.channelsQqBotTestConnection", op: "invoke", channel: IPC.CHANNELS_QQBOT_TEST_CONNECTION, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsLogGet", op: "invoke", channel: IPC.CHANNELS_LOG_GET, callArgs: [25], expectedArgs: [25] },
  { path: "settings.channelsLogClear", op: "invoke", channel: IPC.CHANNELS_LOG_CLEAR, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsContextBindingsGet", op: "invoke", channel: IPC.CHANNELS_CONTEXT_BINDINGS_GET, callArgs: [], expectedArgs: [] },
  { path: "settings.channelsContextBind", op: "invoke", channel: IPC.CHANNELS_CONTEXT_BIND, callArgs: [{ sessionId: "s-1", conversationId: "c-1" }], expectedArgs: [{ sessionId: "s-1", conversationId: "c-1" }] },
  { path: "settings.channelsContextUnbind", op: "invoke", channel: IPC.CHANNELS_CONTEXT_UNBIND, callArgs: ["c-1"], expectedArgs: ["c-1"] },
  { path: "settings.getPermissionLevel", op: "invoke", channel: IPC.PERMISSION_GET_LEVEL, callArgs: [], expectedArgs: [] },
  { path: "settings.setPermissionLevel", op: "invoke", channel: IPC.PERMISSION_SET_LEVEL, callArgs: ["strict"], expectedArgs: ["strict"] },
  { path: "settings.setPlanMode", op: "invoke", channel: IPC.PLAN_SET_MODE, callArgs: [{ conversationId: "c-1", target: "on", workspaceRoot: "/repo" }], expectedArgs: [{ conversationId: "c-1", target: "on", workspaceRoot: "/repo" }] },
  { path: "settings.getPlanState", op: "invoke", channel: IPC.PLAN_GET_STATE, callArgs: ["c-1"], expectedArgs: [{ conversationId: "c-1" }] },
  { path: "settings.resolvePermissionApproval", op: "invoke", channel: IPC.PERMISSION_APPROVAL_RESOLVE, callArgs: ["req-1", true], expectedArgs: [{ id: "req-1", allowed: true }] },
  { path: "settings.resolvePopQuiz", op: "invoke", channel: IPC.POP_QUIZ_RESOLVE, callArgs: [{ quizId: "qz-1", answers: ["a"] }], expectedArgs: [{ quizId: "qz-1", answers: ["a"] }] },
  { path: "settings.skipPopQuiz", op: "invoke", channel: IPC.POP_QUIZ_SKIP, callArgs: ["qz-1"], expectedArgs: [{ quizId: "qz-1" }] },
  { path: "settings.beginScreenshotHotkeyCapture", op: "invoke", channel: IPC.SCREENSHOT_HOTKEY_CAPTURE_START, callArgs: [], expectedArgs: [] },
  { path: "settings.endScreenshotHotkeyCapture", op: "invoke", channel: IPC.SCREENSHOT_HOTKEY_CAPTURE_END, callArgs: [], expectedArgs: [] },

  // plugins (15)
  { path: "plugins.list", op: "invoke", channel: IPC.PLUGINS_LIST, callArgs: [], expectedArgs: [] },
  { path: "plugins.setEnabled", op: "invoke", channel: IPC.PLUGINS_SET_ENABLED, callArgs: ["plug-1", true], expectedArgs: ["plug-1", true] },
  { path: "plugins.setPermission", op: "invoke", channel: IPC.PLUGINS_SET_PERMISSION, callArgs: ["plug-1", "secrets", false], expectedArgs: ["plug-1", "secrets", false] },
  { path: "plugins.setModelRateLimit", op: "invoke", channel: IPC.PLUGINS_SET_MODEL_RATE_LIMIT, callArgs: ["plug-1", 20], expectedArgs: ["plug-1", 20] },
  { path: "plugins.open", op: "invoke", channel: IPC.PLUGINS_OPEN, callArgs: ["plug-1"], expectedArgs: ["plug-1"] },
  { path: "plugins.rescan", op: "invoke", channel: IPC.PLUGINS_RESCAN, callArgs: [], expectedArgs: [] },
  { path: "plugins.importZip", op: "invoke", channel: IPC.PLUGINS_IMPORT_ZIP, callArgs: [], expectedArgs: [] },
  { path: "plugins.importFolder", op: "invoke", channel: IPC.PLUGINS_IMPORT_FOLDER, callArgs: [], expectedArgs: [] },
  { path: "plugins.uninstall", op: "invoke", channel: IPC.PLUGINS_UNINSTALL, callArgs: ["plug-1", { deleteSecrets: false, deleteData: true }], expectedArgs: ["plug-1", { deleteSecrets: false, deleteData: true }] },
  { path: "plugins.marketList", op: "invoke", channel: IPC.PLUGINS_MARKET_LIST, callArgs: ["zh-CN"], expectedArgs: ["zh-CN"] },
  { path: "plugins.marketInstall", op: "invoke", channel: IPC.PLUGINS_MARKET_INSTALL, callArgs: ["plug-1"], expectedArgs: ["plug-1"] },
  { path: "plugins.getV2Borrowing", op: "invoke", channel: IPC.PLUGINS_V2_BORROWING_GET, callArgs: [], expectedArgs: [] },
  { path: "plugins.stopV2Borrowing", op: "invoke", channel: IPC.PLUGINS_V2_BORROWING_STOP, callArgs: [{ id: "b-1" }], expectedArgs: [{ id: "b-1" }] },
  { path: "plugins.getV2Confirms", op: "invoke", channel: IPC.PLUGINS_V2_CONFIRM_GET, callArgs: [], expectedArgs: [] },
  { path: "plugins.resolveV2Confirm", op: "invoke", channel: IPC.PLUGINS_V2_CONFIRM_RESOLVE, callArgs: ["c-1", true], expectedArgs: [{ id: "c-1", allowed: true }] },

  // fireflyScheduler (8)
  { path: "fireflyScheduler.list", op: "invoke", channel: IPC.SCHEDULER_LIST, callArgs: [], expectedArgs: [] },
  { path: "fireflyScheduler.add", op: "invoke", channel: IPC.SCHEDULER_ADD, callArgs: [{ title: "daily" }], expectedArgs: [{ title: "daily" }] },
  { path: "fireflyScheduler.update", op: "invoke", channel: IPC.SCHEDULER_UPDATE, callArgs: ["task-1", { enabled: false }], expectedArgs: ["task-1", { enabled: false }] },
  { path: "fireflyScheduler.delete", op: "invoke", channel: IPC.SCHEDULER_DELETE, callArgs: ["task-1"], expectedArgs: ["task-1"] },
  { path: "fireflyScheduler.toggle", op: "invoke", channel: IPC.SCHEDULER_TOGGLE, callArgs: ["task-1", true], expectedArgs: ["task-1", true] },
  { path: "fireflyScheduler.fireNow", op: "invoke", channel: IPC.SCHEDULER_FIRE_NOW, callArgs: ["task-1"], expectedArgs: ["task-1"] },
  { path: "fireflyScheduler.getHistory", op: "invoke", channel: IPC.SCHEDULER_GET_HISTORY, callArgs: ["task-1", 10], expectedArgs: ["task-1", 10] },
  { path: "fireflyScheduler.getTools", op: "invoke", channel: IPC.SCHEDULER_GET_TOOLS, callArgs: [], expectedArgs: [] },

  // stickerManager (4)
  { path: "stickerManager.minimize", op: "send", channel: IPC.STICKERS_MINIMIZE, callArgs: [], expectedArgs: [] },
  { path: "stickerManager.close", op: "send", channel: IPC.STICKERS_CLOSE, callArgs: [], expectedArgs: [] },
  { path: "stickerManager.getConfig", op: "invoke", channel: IPC.STICKERS_GET_CONFIG, callArgs: [], expectedArgs: [] },
  { path: "stickerManager.setEnabled", op: "invoke", channel: IPC.STICKERS_SET_ENABLED, callArgs: ["sticker-1", false], expectedArgs: [{ id: "sticker-1", enabled: false }] },

  // modelConfig (3)
  { path: "modelConfig.getConnectionSnapshot", op: "invoke", channel: IPC.MODEL_CONNECTION_GET, callArgs: [], expectedArgs: [] },
  { path: "modelConfig.get", op: "invoke", channel: IPC.MODEL_CONFIG_GET, callArgs: [], expectedArgs: [] },
  { path: "modelConfig.getModelInstallStatus", op: "invoke", channel: IPC.MODEL_GET_INSTALL_STATUS, callArgs: [], expectedArgs: [] },

  // manualBrowser & manualBrowserWorkspace (15)
  { path: "manualBrowser.getPermission", op: "invoke", channel: IPC.BROWSER_PERMISSION, callArgs: [], expectedArgs: [{ kind: "get" }] },
  { path: "manualBrowser.requestPermission", op: "invoke", channel: IPC.BROWSER_PERMISSION, callArgs: [{ hosts: ["example.com"], actions: ["navigate"] }], expectedArgs: [{ kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] } }] },
  { path: "manualBrowser.revokePermission", op: "invoke", channel: IPC.BROWSER_PERMISSION, callArgs: ["c-1"], expectedArgs: [{ kind: "revoke", conversationId: "c-1" }] },
  { path: "manualBrowser.getAvailability", op: "invoke", channel: IPC.BROWSER_AVAILABILITY, callArgs: [], expectedArgs: [] },
  { path: "manualBrowser.execute", op: "invoke", channel: IPC.BROWSER_COMMAND, callArgs: [{ kind: "get" }], expectedArgs: [{ kind: "get" }] },
  { path: "manualBrowserWorkspace.getAvailability", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.availability, callArgs: [], expectedArgs: [] },
  { path: "manualBrowserWorkspace.getPermission", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.permission, callArgs: ["tab-1"], expectedArgs: [{ kind: "get", tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.requestPermission", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.permission, callArgs: [{ hosts: ["example.com"], actions: ["navigate"] }, "tab-1"], expectedArgs: [{ kind: "request", scope: { hosts: ["example.com"], actions: ["navigate"] }, tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.revokePermission", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.permission, callArgs: ["ws-1", "tab-1"], expectedArgs: [{ kind: "revoke", workspaceId: "ws-1", tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.getTabs", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: [], expectedArgs: [{ kind: "tabs" }] },
  { path: "manualBrowserWorkspace.newTab", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: [], expectedArgs: [{ kind: "new-tab" }] },
  { path: "manualBrowserWorkspace.selectTab", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: ["tab-1"], expectedArgs: [{ kind: "select-tab", tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.closeTab", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: ["tab-1"], expectedArgs: [{ kind: "close-tab", tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.execute", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: [{ kind: "open", url: "https://example.com/" }, "tab-1"], expectedArgs: [{ kind: "open", url: "https://example.com/", tabId: "tab-1" }] },
  { path: "manualBrowserWorkspace.tool", op: "invoke", channel: MANUAL_BROWSER_WORKSPACE_IPC.command, callArgs: [{ tool: "download", op: "list" }, "tab-1"], expectedArgs: [{ kind: "tool", request: { tool: "download", op: "list" }, tabId: "tab-1" }] },

  // user, memoryPanel, memoryAutomation (15)
  { path: "user.getProfile", op: "invoke", channel: IPC.USER_GET_PROFILE, callArgs: [], expectedArgs: [] },
  { path: "user.saveProfile", op: "invoke", channel: IPC.USER_SAVE_PROFILE, callArgs: [{ displayName: "User" }], expectedArgs: [{ displayName: "User" }] },
  { path: "user.uploadAvatar", op: "invoke", channel: IPC.USER_UPLOAD_AVATAR, callArgs: [], expectedArgs: [] },
  { path: "user.getAvatar", op: "invoke", channel: IPC.USER_GET_AVATAR, callArgs: [], expectedArgs: [] },
  { path: "memoryPanel.getState", op: "invoke", channel: IPC.MEMORY_PANEL_GET_STATE, callArgs: [], expectedArgs: [] },
  { path: "memoryPanel.applyAction", op: "invoke", channel: IPC.MEMORY_PANEL_APPLY_ACTION, callArgs: [{ kind: "confirm" }], expectedArgs: [{ kind: "confirm" }] },
  { path: "memoryPanel.auditSource", op: "invoke", channel: IPC.MEMORY_PANEL_AUDIT_SOURCE, callArgs: ["fact-1"], expectedArgs: ["fact-1"] },
  { path: "memoryPanel.getData", op: "invoke", channel: IPC.MEMORY_PANEL_GET_DATA, callArgs: [], expectedArgs: [] },
  { path: "memoryPanel.deleteImportedDoc", op: "invoke", channel: IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, callArgs: ["imp-1", "notes.md"], expectedArgs: [{ importId: "imp-1", fileName: "notes.md" }] },
  { path: "memoryPanel.shadowState", op: "invoke", channel: IPC.MEMORY_SHADOW_STATE, callArgs: [], expectedArgs: [] },
  { path: "memoryPanel.shadowConfigure", op: "invoke", channel: IPC.MEMORY_SHADOW_CONFIGURE, callArgs: [{ enabled: true, dailyCap: 5, expectedRevision: 2 }], expectedArgs: [{ enabled: true, dailyCap: 5, expectedRevision: 2 }] },
  { path: "memoryPanel.shadowExport", op: "invoke", channel: IPC.MEMORY_SHADOW_EXPORT, callArgs: [], expectedArgs: [] },
  { path: "memoryPanel.shadowClear", op: "invoke", channel: IPC.MEMORY_SHADOW_CLEAR, callArgs: [], expectedArgs: [] },
  { path: "memoryAutomation.state", op: "invoke", channel: IPC.MEMORY_AUTOMATION_STATE, callArgs: [], expectedArgs: [] },
  { path: "memoryAutomation.configure", op: "invoke", channel: IPC.MEMORY_AUTOMATION_CONFIGURE, callArgs: [{ enabled: true }], expectedArgs: [{ enabled: true }] },

  // chatStore (26 top-level + 2 sidebarLayout = 28)
  { path: "chatStore.sidebarLayout.get", op: "invoke", channel: SIDEBAR_LAYOUT_IPC.get, callArgs: [], expectedArgs: [] },
  { path: "chatStore.sidebarLayout.mutate", op: "invoke", channel: SIDEBAR_LAYOUT_IPC.mutate, callArgs: [{ expectedRevision: 1, patch: { mode: "chat", kind: "set-sort", sortMode: "manual" } }], expectedArgs: [{ expectedRevision: 1, patch: { mode: "chat", kind: "set-sort", sortMode: "manual" } }] },
  { path: "chatStore.list", op: "invoke", channel: IPC.CHATS_LIST, callArgs: [{ mode: "work" }], expectedArgs: [{ mode: "work" }] },
  { path: "chatStore.get", op: "invoke", channel: IPC.CHATS_GET, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.exportWorkMarkdown", op: "invoke", channel: IPC.CHATS_EXPORT_WORK_MARKDOWN, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.create", op: "invoke", channel: IPC.CHATS_CREATE, callArgs: [{ title: "Test", mode: "chat" }], expectedArgs: [{ title: "Test", mode: "chat" }] },
  { path: "chatStore.append", op: "invoke", channel: IPC.CHATS_APPEND, callArgs: ["s-1", { role: "user", text: "hi" }], expectedArgs: [{ id: "s-1", message: { role: "user", text: "hi" } }] },
  { path: "chatStore.upsert", op: "invoke", channel: IPC.CHATS_UPSERT, callArgs: ["s-1", { id: "m-1" }], expectedArgs: [{ id: "s-1", message: { id: "m-1" } }] },
  { path: "chatStore.replaceTail", op: "invoke", channel: IPC.CHATS_REPLACE_TAIL, callArgs: ["s-1", 3, [{ id: "m-4" }]], expectedArgs: [{ id: "s-1", startIndex: 3, messages: [{ id: "m-4" }] }] },
  { path: "chatStore.compactConversation", op: "invoke", channel: IPC.CHATS_COMPACT, callArgs: ["s-1"], expectedArgs: [{ sessionId: "s-1" }] },
  { path: "chatStore.rename", op: "invoke", channel: IPC.CHATS_RENAME, callArgs: ["s-1", "Renamed"], expectedArgs: [{ id: "s-1", title: "Renamed" }] },
  { path: "chatStore.delete", op: "invoke", channel: IPC.CHATS_DELETE, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.pendingEnqueue", op: "invoke", channel: IPC.CHATS_PENDING_ENQUEUE, callArgs: ["s-1", { id: "p-1" }], expectedArgs: [{ sessionId: "s-1", entry: { id: "p-1" } }] },
  { path: "chatStore.pendingList", op: "invoke", channel: IPC.CHATS_PENDING_LIST, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.pendingRemove", op: "invoke", channel: IPC.CHATS_PENDING_REMOVE, callArgs: ["s-1", "m-1"], expectedArgs: [{ sessionId: "s-1", messageId: "m-1" }] },
  { path: "chatStore.pendingClaim", op: "invoke", channel: IPC.CHATS_PENDING_CLAIM, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.pendingCompleteDispatch", op: "invoke", channel: IPC.CHATS_PENDING_COMPLETE_DISPATCH, callArgs: ["s-1", "m-1"], expectedArgs: [{ sessionId: "s-1", messageId: "m-1" }] },
  { path: "chatStore.pendingEdit", op: "invoke", channel: IPC.CHATS_PENDING_EDIT, callArgs: ["s-1", "m-1", { rawContent: "raw", visibleContent: "vis", userSticker: "wave" }], expectedArgs: [{ sessionId: "s-1", messageId: "m-1", rawContent: "raw", visibleContent: "vis", userSticker: "wave" }] },
  { path: "chatStore.pendingUnmark", op: "invoke", channel: IPC.CHATS_PENDING_UNMARK, callArgs: ["s-1", "m-1"], expectedArgs: [{ sessionId: "s-1", messageId: "m-1" }] },
  { path: "chatStore.pendingAdjust", op: "invoke", channel: IPC.CHATS_PENDING_ADJUST, callArgs: ["s-1", "m-1"], expectedArgs: [{ sessionId: "s-1", messageId: "m-1" }] },
  { path: "chatStore.setPinned", op: "invoke", channel: IPC.CHATS_SET_PINNED, callArgs: ["s-1", true], expectedArgs: [{ id: "s-1", pinned: true }] },
  { path: "chatStore.setModelProfile", op: "invoke", channel: IPC.CHATS_SET_MODEL_PROFILE, callArgs: ["s-1", "mp-1"], expectedArgs: [{ id: "s-1", modelProfileId: "mp-1" }] },
  { path: "chatStore.openWorkspace", op: "invoke", channel: IPC.CHATS_OPEN_WORKSPACE, callArgs: ["/repo"], expectedArgs: ["/repo"] },
  { path: "chatStore.setActiveSession", op: "invoke", channel: IPC.CHATS_SET_ACTIVE_SESSION, callArgs: [null], expectedArgs: [null] },
  { path: "chatStore.setWorkspace", op: "invoke", channel: IPC.CHATS_SET_WORKSPACE, callArgs: ["s-1", "/repo"], expectedArgs: [{ sessionId: "s-1", workspaceRoot: "/repo" }] },
  { path: "chatStore.pickWorkspaceFolder", op: "invoke", channel: IPC.CHATS_PICK_WORKSPACE_FOLDER, callArgs: [], expectedArgs: [] },
  { path: "chatStore.openInReactChatWindow", op: "invoke", channel: IPC.CHATS_OPEN_IN_REACT_WINDOW, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "chatStore.notifyReactReady", op: "send", channel: IPC.CHATS_REACT_READY, callArgs: [], expectedArgs: [] },

  // review, workspaceFiles, openInApp, codeGit, tokenUsage, music (19)
  { path: "review.get", op: "invoke", channel: IPC.REVIEW_GET, callArgs: ["run-1"], expectedArgs: ["run-1"] },
  { path: "review.restore", op: "invoke", channel: IPC.REVIEW_RESTORE, callArgs: ["run-1"], expectedArgs: ["run-1"] },
  { path: "workspaceFiles.list", op: "invoke", channel: IPC.WORKSPACE_FILES_LIST, callArgs: ["s-1", "src"], expectedArgs: [{ sessionId: "s-1", relPath: "src" }] },
  { path: "workspaceFiles.read", op: "invoke", channel: IPC.WORKSPACE_FILES_READ, callArgs: ["s-1", "src/a.ts"], expectedArgs: [{ sessionId: "s-1", relPath: "src/a.ts" }] },
  { path: "workspaceFiles.save", op: "invoke", channel: IPC.WORKSPACE_FILES_SAVE, callArgs: ["s-1", "src/a.ts", "export {};", "rev-1"], expectedArgs: [{ sessionId: "s-1", relPath: "src/a.ts", content: "export {};", editVersion: "rev-1" }] },
  { path: "openInApp.listApps", op: "invoke", channel: IPC.WORKSPACE_OPEN_IN_LIST_APPS, callArgs: ["s-1"], expectedArgs: [{ sessionId: "s-1" }] },
  { path: "openInApp.open", op: "invoke", channel: IPC.WORKSPACE_OPEN_IN, callArgs: ["s-1", "vscode"], expectedArgs: [{ sessionId: "s-1", appId: "vscode" }] },
  { path: "codeGit.getStatus", op: "invoke", channel: IPC.CODE_GIT_STATUS, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "codeGit.watch", op: "invoke", channel: IPC.CODE_GIT_WATCH, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "codeGit.unwatch", op: "invoke", channel: IPC.CODE_GIT_UNWATCH, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "codeGit.switchBranch", op: "invoke", channel: IPC.CODE_GIT_SWITCH_BRANCH, callArgs: ["s-1", "feat/x", true], expectedArgs: [{ sessionId: "s-1", branch: "feat/x", create: true }] },
  { path: "codeGit.commit", op: "invoke", channel: IPC.CODE_GIT_COMMIT, callArgs: ["s-1", "feat: msg", ["src/a.ts"]], expectedArgs: [{ sessionId: "s-1", message: "feat: msg", paths: ["src/a.ts"] }] },
  { path: "codeGit.push", op: "invoke", channel: IPC.CODE_GIT_PUSH, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "tokenUsage.get", op: "invoke", channel: IPC.TOKEN_USAGE_GET, callArgs: [7], expectedArgs: [7] },
  { path: "tokenUsage.clear", op: "invoke", channel: IPC.TOKEN_USAGE_CLEAR, callArgs: [], expectedArgs: [] },
  { path: "tokenUsage.history", op: "invoke", channel: IPC.TOKEN_USAGE_HISTORY, callArgs: [30], expectedArgs: [30] },
  { path: "tokenUsage.sessionStats", op: "invoke", channel: IPC.TOKEN_USAGE_SESSION_STATS, callArgs: ["s-1"], expectedArgs: ["s-1"] },
  { path: "music.getStatus", op: "invoke", channel: IPC.MUSIC_QQ_GET_STATUS, callArgs: [], expectedArgs: [] },
  { path: "music.control", op: "invoke", channel: IPC.MUSIC_QQ_CONTROL, callArgs: [{ action: "pause" }], expectedArgs: [{ action: "pause" }] },
];

function resolveCallable(methodPath: string): (...args: unknown[]) => unknown {
  const segments = methodPath.split(".");
  let current: any = harness.exposed.get(segments[0]);
  for (let i = 1; i < segments.length; i += 1) {
    current = current?.[segments[i]];
  }
  return current;
}

function collectLeafFunctionPaths(rootMap: Map<string, Record<string, any>>): string[] {
  const paths: string[] = [];
  const walk = (prefix: string, node: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(node)) {
      const next = `${prefix}.${key}`;
      if (typeof value === "function") {
        paths.push(next);
      } else if (value && typeof value === "object") {
        walk(next, value as Record<string, unknown>);
      }
    }
  };
  for (const [namespace, api] of rootMap.entries()) {
    walk(namespace, api);
  }
  return paths.sort();
}

describe("preload IPC channel and argument mapping", () => {
  beforeAll(async () => {
    vi.resetModules();
    harness.exposed.clear();
    harness.listeners.clear();
    await import("../preload/index");
  });

  beforeEach(() => {
    harness.invoke.mockReset();
    harness.invoke.mockResolvedValue({ ok: true });
    harness.send.mockReset();
  });

  it("accounts for every non-listener invoke/send method across all exposed APIs", () => {
    const mapped = CHANNEL_MAPPING_CASES.map((entry) => entry.path);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped).toHaveLength(225);

    const allExposedFunctions = collectLeafFunctionPaths(harness.exposed);
    expect(allExposedFunctions).toHaveLength(264);

    const nonTableFunctions = allExposedFunctions.filter(
      (methodPath) => methodPath === "chat.ingestDroppedFiles" || /\.on[A-Z]/.test(methodPath),
    );
    expect(nonTableFunctions).toHaveLength(39);
    expect(mapped.slice().sort()).toEqual(
      allExposedFunctions.filter((methodPath) => !nonTableFunctions.includes(methodPath)),
    );
  });

  it.each(CHANNEL_MAPPING_CASES)(
    "routes $path via $op($channel)",
    async ({ path, op, channel, callArgs, expectedArgs }) => {
      const fn = resolveCallable(path);
      expect(typeof fn).toBe("function");

      await fn(...callArgs);

      if (op === "invoke") {
        expect(harness.invoke.mock.calls).toEqual([[channel, ...expectedArgs]]);
        expect(harness.send).not.toHaveBeenCalled();
      } else {
        expect(harness.send.mock.calls).toEqual([[channel, ...expectedArgs]]);
        expect(harness.invoke).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["plugins.importZip", IPC.PLUGINS_IMPORT_ZIP],
    ["plugins.importFolder", IPC.PLUGINS_IMPORT_FOLDER],
  ])("forwards the replace confirmation token from %s as the only argument", async (path, channel) => {
    await resolveCallable(path)("token-1");
    expect(harness.invoke.mock.calls).toEqual([[channel, "token-1"]]);
  });
});
