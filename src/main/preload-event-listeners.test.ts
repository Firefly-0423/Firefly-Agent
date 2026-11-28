import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_APPEARANCE } from "../shared/chat-appearance";
import { IPC } from "../shared/ipc-channels";
import { MANUAL_BROWSER_WORKSPACE_IPC } from "../shared/manual-browser";
import { SIDEBAR_LAYOUT_IPC } from "../shared/sidebar-layout";

const harness = vi.hoisted(() => {
  const exposed = new Map<string, Record<string, any>>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  // G3 compatibility: off and removeListener share one listener registry so tests never depend on which API is called.
  const detach = (channel: string, listener: (...args: unknown[]) => void) => {
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
    off: vi.fn(detach),
    removeListener: vi.fn(detach),
    getPathForFile: vi.fn(),
    emit: (channel: string, ipcEvent: unknown, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) {
        listener(ipcEvent, ...args);
      }
    },
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

interface ListenerCase {
  path: string;
  channel: string;
  firstPayload: unknown;
  secondPayload: unknown;
  thirdPayload: unknown;
  expectDelivered?: (payload: unknown) => unknown[];
}

const expectSingleArg = (payload: unknown) => [payload];
const expectNoArgs = () => [] as unknown[];

const LISTENER_CASES: readonly ListenerCase[] = [
  { path: "firefly.onPetZoom", channel: IPC.PET_ZOOM, firstPayload: 1.1, secondPayload: 1.3, thirdPayload: 1.5 },
  { path: "firefly.onPetVisibilityChanged", channel: IPC.PET_VISIBILITY_CHANGED, firstPayload: true, secondPayload: false, thirdPayload: true },
  { path: "live2dWork.onChanged", channel: IPC.LIVE2D_WORKING_CHANGED, firstPayload: true, secondPayload: false, thirdPayload: true },
  { path: "appUpdate.onStateChanged", channel: IPC.APP_UPDATE_STATE, firstPayload: { status: "checking" }, secondPayload: { status: "ready" }, thirdPayload: { status: "idle" } },
  { path: "chat.onScreenshotInsert", channel: IPC.SCREENSHOT_INSERT, firstPayload: { filePath: "/tmp/1.png" }, secondPayload: { filePath: "/tmp/2.png" }, thirdPayload: { filePath: "/tmp/3.png" } },
  { path: "agui.onEvent", channel: IPC.AGUI_EVENT, firstPayload: { type: "TEXT_DELTA" }, secondPayload: { type: "RUN_FINISHED" }, thirdPayload: { type: "STEP" } },
  { path: "schedulerEvents.onEvent", channel: IPC.SCHEDULER_EVENT, firstPayload: { kind: "fired" }, secondPayload: { kind: "done" }, thirdPayload: { kind: "idle" } },
  { path: "toast.onPush", channel: IPC.TOAST_PUSH, firstPayload: { id: "t-1" }, secondPayload: { id: "t-2" }, thirdPayload: { id: "t-3" } },
  { path: "toast.onRemove", channel: IPC.TOAST_REMOVE, firstPayload: "t-1", secondPayload: "t-2", thirdPayload: "t-3" },
  { path: "fireflyTheme.onColorsChanged", channel: IPC.UI_COLORS_CHANGED, firstPayload: { accent: "#111111" }, secondPayload: { accent: "#222222" }, thirdPayload: { accent: "#333333" } },
  { path: "fireflyTheme.onChanged", channel: IPC.UI_THEME_CHANGED, firstPayload: { mode: "light" }, secondPayload: { mode: "dark" }, thirdPayload: { mode: "system" } },
  { path: "fireflyFont.onChanged", channel: IPC.UI_FONT_CHANGED, firstPayload: { family: "sans" }, secondPayload: { family: "mono" }, thirdPayload: { family: "serif" } },
  {
    path: "fireflyAppearance.onChanged",
    channel: IPC.CHAT_TYPOGRAPHY_CHANGED,
    firstPayload: { ...DEFAULT_CHAT_APPEARANCE, chatFontSize: 15, segmentedChat: true },
    secondPayload: { ...DEFAULT_CHAT_APPEARANCE, chatFontSize: 16, segmentedChat: false },
    thirdPayload: { ...DEFAULT_CHAT_APPEARANCE, chatFontSize: 18, segmentedChat: true },
  },
  { path: "settings.onSwitchSection", channel: IPC.SETTINGS_SWITCH_SECTION, firstPayload: "models", secondPayload: "channels", thirdPayload: "general" },
  { path: "settings.onChannelsInstallProgress", channel: IPC.CHANNELS_INSTALL_PROGRESS, firstPayload: { channel: "wechat", phase: "dl", pct: 40 }, secondPayload: { channel: "wechat", phase: "ok", pct: 100 }, thirdPayload: { channel: "qq", phase: "init", pct: 10 } },
  { path: "settings.onChannelsStatusChanged", channel: IPC.CHANNELS_STATUS_CHANGED, firstPayload: { wechat: "online" }, secondPayload: { wechat: "offline" }, thirdPayload: { qq: "online" } },
  { path: "settings.onChannelsWechatQrcode", channel: IPC.CHANNELS_WECHAT_QRCODE, firstPayload: "data:image/png;base64,AAA", secondPayload: "data:image/png;base64,BBB", thirdPayload: "data:image/png;base64,CCC" },
  { path: "settings.onChannelsWechatLoginDone", channel: IPC.CHANNELS_WECHAT_LOGIN_DONE, firstPayload: { ok: true, botId: "b-1" }, secondPayload: { ok: false, error: "timeout" }, thirdPayload: { ok: true, botId: "b-2" } },
  { path: "settings.onPlanStateChanged", channel: IPC.PLAN_STATE_CHANGED, firstPayload: { conversationId: "c-1", state: "planning" }, secondPayload: { conversationId: "c-1", state: "ready" }, thirdPayload: { conversationId: "c-1", state: "done" } },
  { path: "settings.onPermissionApprovalRequest", channel: IPC.PERMISSION_APPROVAL_REQUEST, firstPayload: { id: "req-1" }, secondPayload: { id: "req-2" }, thirdPayload: { id: "req-3" } },
  { path: "settings.onPermissionApprovalSettled", channel: IPC.PERMISSION_APPROVAL_SETTLED, firstPayload: { id: "req-1", allowed: true }, secondPayload: { id: "req-2", allowed: false }, thirdPayload: { id: "req-3", allowed: true } },
  { path: "settings.onPopQuizRequest", channel: IPC.POP_QUIZ_REQUEST, firstPayload: { quizId: "q-1" }, secondPayload: { quizId: "q-2" }, thirdPayload: { quizId: "q-3" } },
  { path: "settings.onPopQuizSettled", channel: IPC.POP_QUIZ_SETTLED, firstPayload: { quizId: "q-1", reason: "submitted" }, secondPayload: { quizId: "q-2", reason: "skipped" }, thirdPayload: { quizId: "q-3", reason: "cancelled" } },
  { path: "plugins.onChanged", channel: IPC.PLUGINS_CHANGED, firstPayload: { plugins: ["a"] }, secondPayload: { plugins: ["b"] }, thirdPayload: { plugins: ["c"] } },
  { path: "plugins.onV2BorrowingChanged", channel: IPC.PLUGINS_V2_BORROWING_CHANGED, firstPayload: { entries: [{ id: "b-1", pluginId: "p1", pluginName: "P1" }] }, secondPayload: { entries: [] }, thirdPayload: { entries: [{ id: "b-2", pluginId: "p2", pluginName: "P2" }] } },
  { path: "plugins.onV2ConfirmRequest", channel: IPC.PLUGINS_V2_CONFIRM_REQUEST, firstPayload: { id: "c-1", pluginId: "p1", pluginName: "P1", permission: "sessions.read" }, secondPayload: { id: "c-2", pluginId: "p1", pluginName: "P1", permission: "workspace.read" }, thirdPayload: { id: "c-3", pluginId: "p1", pluginName: "P1", permission: "model.run" } },
  { path: "plugins.onV2ConfirmSettled", channel: IPC.PLUGINS_V2_CONFIRM_SETTLED, firstPayload: { id: "c-1", reason: "answered" }, secondPayload: { id: "c-2", reason: "cancelled" }, thirdPayload: { id: "c-3", reason: "answered" } },
  { path: "modelConfig.onConnectionChanged", channel: IPC.MODEL_CONNECTION_CHANGED, firstPayload: { revision: 1 }, secondPayload: { revision: 2 }, thirdPayload: { revision: 3 } },
  { path: "modelConfig.onChanged", channel: IPC.MODEL_CONFIG_CHANGED, firstPayload: { model: "gpt-4o" }, secondPayload: { model: "claude" }, thirdPayload: { model: "gemini" } },
  { path: "manualBrowser.onChanged", channel: IPC.BROWSER_CHANGED, firstPayload: { requestId: 1 }, secondPayload: { requestId: 2 }, thirdPayload: { requestId: 3 } },
  { path: "manualBrowserWorkspace.onChanged", channel: MANUAL_BROWSER_WORKSPACE_IPC.changed, firstPayload: { tabId: "t-1" }, secondPayload: { tabId: "t-2" }, thirdPayload: { tabId: "t-3" } },
  { path: "manualBrowserWorkspace.onToolsChanged", channel: MANUAL_BROWSER_WORKSPACE_IPC.toolsChanged, firstPayload: { kind: "downloads" }, secondPayload: { kind: "zoom" }, thirdPayload: { kind: "find" } },
  { path: "user.onProfileChanged", channel: IPC.USER_PROFILE_CHANGED, firstPayload: { name: "A" }, secondPayload: { name: "B" }, thirdPayload: { name: "C" } },
  { path: "user.onAvatarChanged", channel: IPC.USER_AVATAR_CHANGED, firstPayload: { leaked: true }, secondPayload: { leaked: true }, thirdPayload: { leaked: true }, expectDelivered: expectNoArgs },
  { path: "chatStore.sidebarLayout.onChanged", channel: SIDEBAR_LAYOUT_IPC.changed, firstPayload: { leaked: true }, secondPayload: { leaked: true }, thirdPayload: { leaked: true }, expectDelivered: expectNoArgs },
  { path: "chatStore.onChanged", channel: IPC.CHATS_CHANGED, firstPayload: { leaked: true }, secondPayload: { leaked: true }, thirdPayload: { leaked: true }, expectDelivered: expectNoArgs },
  { path: "chatStore.onReactSwitchSession", channel: IPC.CHATS_REACT_SWITCH_SESSION, firstPayload: "s-1", secondPayload: "s-2", thirdPayload: "s-3" },
  { path: "codeGit.onChanged", channel: IPC.CODE_GIT_CHANGED, firstPayload: { sessionId: "s-1" }, secondPayload: { sessionId: "s-2" }, thirdPayload: { sessionId: "s-3" } },
];

function resolveCallable(methodPath: string): (cb: (...args: any[]) => void) => () => void {
  const segments = methodPath.split(".");
  let current: any = harness.exposed.get(segments[0]);
  for (let i = 1; i < segments.length; i += 1) {
    current = current?.[segments[i]];
  }
  return current;
}

function collectListenerPaths(rootMap: Map<string, Record<string, any>>): string[] {
  const paths: string[] = [];
  const walk = (prefix: string, node: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(node)) {
      const next = `${prefix}.${key}`;
      if (typeof value === "function" && /^on[A-Z]/.test(key)) {
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

describe("preload event listeners, payload unwrapping, and unsubscribe isolation", () => {
  beforeAll(async () => {
    vi.resetModules();
    harness.exposed.clear();
    harness.listeners.clear();
    await import("../preload/index");
  });

  beforeEach(() => {
    harness.listeners.clear();
    harness.on.mockClear();
    harness.off.mockClear();
    harness.removeListener.mockClear();
  });

  it("covers all 38 exposed on* event listener subscriptions", () => {
    const listed = LISTENER_CASES.map((entry) => entry.path);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toHaveLength(38);
    expect(listed.slice().sort()).toEqual(collectListenerPaths(harness.exposed));
  });

  it("only forwards the session ID from a run insertion history notice", () => {
    const receive = vi.fn();
    const off = resolveCallable("chatStore.onChanged")(receive);
    try {
      const nativeEvent = { sender: "native-ipc-event" };
      harness.emit(IPC.CHATS_CHANGED, nativeEvent, { runInsertionSessionId: "work-1", private: "unexpected field" });
      harness.emit(IPC.CHATS_CHANGED, nativeEvent, { runInsertionSessionId: 42 });
      harness.emit(IPC.CHATS_CHANGED, nativeEvent);
      expect(receive.mock.calls).toEqual([[{ runInsertionSessionId: "work-1" }], [], []]);
    } finally {
      off();
    }
  });

  it.each(LISTENER_CASES)(
    "$path strips _ipcEvent, isolates sibling listeners, and supports idempotent unsubscribe",
    ({ path, channel, firstPayload, secondPayload, thirdPayload, expectDelivered = expectSingleArg }) => {
      const subscribe = resolveCallable(path);
      expect(typeof subscribe).toBe("function");

      const sentinelIpcEvent = { sender: "native-ipc-event", frameId: 99 };
      const siblingChannel = "__unrelated_sibling_channel__";
      const unrelatedSentinel = vi.fn();
      harness.on(siblingChannel, unrelatedSentinel);

      const callbackA = vi.fn();
      const callbackB = vi.fn();
      const unsubA = subscribe(callbackA);
      const unsubB = subscribe(callbackB);
      expect(typeof unsubA).toBe("function");
      expect(typeof unsubB).toBe("function");
      expect(harness.listeners.get(channel)?.size).toBe(2);

      // First emission reaches both listeners without leaking the native IPC event.
      harness.emit(channel, sentinelIpcEvent, firstPayload);
      expect(callbackA.mock.calls).toEqual([expectDelivered(firstPayload)]);
      expect(callbackB.mock.calls).toEqual([expectDelivered(firstPayload)]);

      // Unsubscribing A stops future deliveries to A while keeping sibling B active.
      unsubA();
      expect(harness.listeners.get(channel)?.size).toBe(1);
      harness.emit(channel, sentinelIpcEvent, secondPayload);
      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackB.mock.calls).toEqual([expectDelivered(firstPayload), expectDelivered(secondPayload)]);

      // Repeated unsubA() is idempotent and does not disturb sibling B or other channels.
      expect(() => unsubA()).not.toThrow();
      expect(harness.listeners.get(channel)?.size).toBe(1);
      harness.emit(channel, sentinelIpcEvent, thirdPayload);
      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackB.mock.calls).toEqual([
        expectDelivered(firstPayload),
        expectDelivered(secondPayload),
        expectDelivered(thirdPayload),
      ]);

      // Unsubscribing B clears the channel and leaves unrelated channels untouched.
      unsubB();
      expect(harness.listeners.get(channel)?.size ?? 0).toBe(0);
      harness.emit(channel, sentinelIpcEvent, firstPayload);
      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackB).toHaveBeenCalledTimes(3);
      expect(harness.listeners.get(siblingChannel)?.has(unrelatedSentinel)).toBe(true);
      expect(unrelatedSentinel).not.toHaveBeenCalled();
    },
  );
});
