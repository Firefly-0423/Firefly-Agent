import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const exposedCalls: Array<[string, unknown]> = [];
  const exposed = new Map<string, Record<string, unknown>>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const removeChannelListener = (channel: string, listener: (...args: unknown[]) => void) => {
    listeners.get(channel)?.delete(listener);
  };

  return {
    exposedCalls,
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
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
      harness.exposedCalls.push([name, api]);
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

const EXPECTED_NAMESPACE_KEYS: Record<string, readonly string[]> = {
  agui: ["cancel", "getInterruptedRun", "getRunStatus", "onEvent", "reportRunPersisted", "run"],
  appUpdate: ["download", "getState", "install", "onStateChanged"],
  chat: [
    "captionImage",
    "close",
    "endWindowDrag",
    "getEnabledStickers",
    "getGeneralSettings",
    "getImagePreview",
    "getImageSendStrategy",
    "getReasoningState",
    "ingestDroppedFiles",
    "isMaximized",
    "minimize",
    "onScreenshotInsert",
    "saveScreenshotTemp",
    "setReasoning",
    "startScreenshot",
    "startWindowDrag",
    "toggleMaximize",
  ],
  chatStore: [
    "append",
    "compactConversation",
    "create",
    "delete",
    "exportWorkMarkdown",
    "get",
    "list",
    "notifyReactReady",
    "onChanged",
    "onReactSwitchSession",
    "openInReactChatWindow",
    "openWorkspace",
    "pendingAdjust",
    "pendingClaim",
    "pendingCompleteDispatch",
    "pendingEdit",
    "pendingEnqueue",
    "pendingList",
    "pendingRemove",
    "pendingUnmark",
    "pickWorkspaceFolder",
    "rename",
    "replaceTail",
    "setActiveSession",
    "setModelProfile",
    "setPinned",
    "setWorkspace",
    "sidebarLayout",
    "upsert",
  ],
  choice: ["resolve"],
  codeGit: ["commit", "getStatus", "onChanged", "push", "switchBranch", "unwatch", "watch"],
  desktopAsr: ["cancel", "frame", "start", "stop"],
  firefly: [
    "getCursorPosition",
    "minimize",
    "moveTo",
    "onPetVisibilityChanged",
    "onPetZoom",
    "setDragging",
    "setInteractive",
  ],
  fireflyAppearance: ["get", "onChanged"],
  fireflyFont: ["get", "onChanged"],
  fireflyScheduler: ["add", "confirmPluginProposal", "delete", "fireNow", "getHistory", "getTools", "list", "listPluginProposals", "rejectPluginProposal", "toggle", "update"],
  fireflyTheme: ["get", "getColors", "onChanged", "onColorsChanged"],
  live2dWork: ["getWorking", "onChanged"],
  manualBrowser: ["execute", "getAvailability", "getPermission", "onChanged", "requestPermission", "revokePermission"],
  manualBrowserWorkspace: [
    "closeTab",
    "execute",
    "getAvailability",
    "getPermission",
    "getTabs",
    "newTab",
    "onChanged",
    "onToolsChanged",
    "requestPermission",
    "revokePermission",
    "selectTab",
    "tool",
  ],
  memoryAutomation: ["configure", "state"],
  memoryPanel: [
    "applyAction",
    "auditSource",
    "deleteImportedDoc",
    "getData",
    "getState",
    "shadowClear",
    "shadowConfigure",
    "shadowExport",
    "shadowState",
  ],
  modelConfig: ["get", "getConnectionSnapshot", "getModelInstallStatus", "onChanged", "onConnectionChanged"],
  music: ["control", "getStatus"],
  openInApp: ["listApps", "open"],
  pluginPanel: ["invoke"],
  plugins: [
    "getV2Borrowing",
    "getV2Confirms",
    "importZip",
    "list",
    "marketInstall",
    "marketList",
    "onChanged",
    "onV2BorrowingChanged",
    "onV2ConfirmRequest",
    "onV2ConfirmSettled",
    "open",
    "rescan",
    "resolveV2Confirm",
    "setEnabled",
    "stopV2Borrowing",
    "uninstall",
  ],
  review: ["get", "restore"],
  schedulerEvents: ["onEvent"],
  settings: [
    "addMcpServer",
    "beginScreenshotHotkeyCapture",
    "channelsContextBind",
    "channelsContextBindingsGet",
    "channelsContextUnbind",
    "channelsGetConfig",
    "channelsGetStatus",
    "channelsLogClear",
    "channelsLogGet",
    "channelsQqBotTestConnection",
    "channelsQqResolveAuthRequirement",
    "channelsQqTestConnection",
    "channelsRestart",
    "channelsSaveConfig",
    "channelsSenderResolve",
    "channelsWechatLoginStart",
    "close",
    "deleteModelProfile",
    "embeddingSetModel",
    "endScreenshotHotkeyCapture",
    "externalSkills",
    "fetchModels",
    "getAgentRouting",
    "getConfig",
    "getGeneral",
    "getPermissionLevel",
    "getPlanState",
    "getRerankerStatus",
    "getSkillCatalog",
    "getSkillModeOverrides",
    "getTimeoutSettings",
    "getToolCatalog",
    "getToolModeOverrides",
    "importUiFont",
    "listMcpServers",
    "listModelProfiles",
    "minimize",
    "onChannelsInstallProgress",
    "onChannelsStatusChanged",
    "onChannelsWechatLoginDone",
    "onChannelsWechatQrcode",
    "onPermissionApprovalRequest",
    "onPermissionApprovalSettled",
    "onPlanStateChanged",
    "onPopQuizRequest",
    "onPopQuizSettled",
    "onSwitchSection",
    "openStickerManager",
    "pickUiFont",
    "removeMcpServer",
    "rerankerSetMode",
    "rescanSkills",
    "resetUiFont",
    "resolveInputModalities",
    "resolvePermissionApproval",
    "resolvePopQuiz",
    "saveConfig",
    "saveGeneral",
    "saveModelProfile",
    "saveTimeoutSettings",
    "setDefaultModelProfile",
    "setMcpServerEnabled",
    "setPermissionLevel",
    "setPetAlwaysOnTop",
    "setPetVisible",
    "setPetZoom",
    "setPlanMode",
    "setSkillEnabled",
    "setSkillModeOverride",
    "setToolModeOverride",
    "skipPopQuiz",
    "stickerAdd",
    "stickerPickFile",
    "testConnection",
    "translateSkillDescriptions",
    "updateAgentRouting",
  ],
  sidebar: ["close", "minimize", "openSettings", "toggleAlwaysOnTop"],
  stickerManager: ["close", "getConfig", "minimize", "setEnabled"],
  toast: ["clicked", "dismissed", "getAll", "inspectApproval", "onPush", "onRemove", "reportHeight", "resolveApproval"],
  tokenUsage: ["clear", "get", "history", "sessionStats"],
  user: ["getAvatar", "getProfile", "onAvatarChanged", "onProfileChanged", "saveProfile", "uploadAvatar"],
  workspaceFiles: ["list", "read", "save"],
};

const EXPECTED_NESTED_KEYS: Array<[namespace: string, nestedKey: string, keys: readonly string[]]> = [
  ["settings", "externalSkills", ["cancel", "commit", "detail", "list", "prepare"]],
  ["chatStore", "sidebarLayout", ["get", "mutate", "onChanged"]],
];

describe("preload exposure surface", () => {
  beforeEach(async () => {
    vi.resetModules();
    harness.exposedCalls.length = 0;
    harness.exposed.clear();
    harness.listeners.clear();
    harness.invoke.mockReset();
    harness.send.mockReset();
    harness.on.mockClear();
    harness.off.mockClear();
    harness.removeListener.mockClear();
    harness.getPathForFile.mockReset();
    await import("../preload/index");
  });

  it("exposes the exact 31 window namespaces once each via contextBridge.exposeInMainWorld", () => {
    const expectedNamespaces = Object.keys(EXPECTED_NAMESPACE_KEYS).sort();
    expect(expectedNamespaces).toHaveLength(31);
    expect(harness.exposedCalls.map(([name]) => name).sort()).toEqual(expectedNamespaces);
    expect([...harness.exposed.keys()].sort()).toEqual(expectedNamespaces);
  });

  it.each(Object.entries(EXPECTED_NAMESPACE_KEYS))(
    "freezes exact method keys and function types on window.%s",
    (namespace, expectedKeys) => {
      const api = harness.exposed.get(namespace);
      expect(api).toBeDefined();
      expect(Object.keys(api!).sort()).toEqual([...expectedKeys]);

      const expectedNested = new Set(
        EXPECTED_NESTED_KEYS.filter(([ns]) => ns === namespace).map(([, nestedKey]) => nestedKey),
      );
      for (const key of expectedKeys) {
        if (expectedNested.has(key)) {
          expect(typeof api![key]).toBe("object");
          expect(api![key]).not.toBeNull();
        } else {
          expect(typeof api![key], `${namespace}.${key}`).toBe("function");
        }
      }
    },
  );

  it.each(EXPECTED_NESTED_KEYS)(
    "freezes exact method keys and function types on window.%s.%s",
    (namespace, nestedKey, expectedKeys) => {
      const parent = harness.exposed.get(namespace);
      const nested = parent?.[nestedKey] as Record<string, unknown> | undefined;
      expect(nested).toBeDefined();
      expect(Object.keys(nested!).sort()).toEqual([...expectedKeys]);
      for (const key of expectedKeys) {
        expect(typeof nested![key], `${namespace}.${nestedKey}.${key}`).toBe("function");
      }
    },
  );

  it("excludes retired namespaces and forbidden bypass/constructor properties", () => {
    const retiredGlobals = ["moments", "call", "openCall", "LEGACY_WINDOW_API_NAMES"];
    for (const forbidden of retiredGlobals) {
      expect(harness.exposed.has(forbidden), `unexpected global ${forbidden}`).toBe(false);
    }

    for (const [namespace, api] of harness.exposed.entries()) {
      expect(Object.prototype.hasOwnProperty.call(api, "openCall"), `${namespace}.openCall`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(api, "grant"), `${namespace}.grant`).toBe(false);
    }

    const memoryPanel = harness.exposed.get("memoryPanel")!;
    for (const forbidden of ["bindActor", "event", "source"]) {
      expect(Object.prototype.hasOwnProperty.call(memoryPanel, forbidden), `memoryPanel.${forbidden}`).toBe(false);
    }
  });
});
