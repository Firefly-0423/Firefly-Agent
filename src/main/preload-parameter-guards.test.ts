import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_APPEARANCE } from "../shared/chat-appearance";
import { IPC } from "../shared/ipc-channels";
import { MANUAL_BROWSER_WORKSPACE_IPC } from "../shared/manual-browser";

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
    emit: (channel: string, payload: unknown) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) {
        listener({ sender: "mock" }, payload);
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

describe("preload parameter filtering, normalization, defaults, and error guards", () => {
  beforeEach(async () => {
    vi.resetModules();
    harness.exposed.clear();
    harness.listeners.clear();
    harness.invoke.mockReset();
    harness.invoke.mockResolvedValue({ ok: true });
    harness.send.mockReset();
    harness.on.mockClear();
    harness.off.mockClear();
    harness.removeListener.mockClear();
    harness.getPathForFile.mockReset();
    await import("../preload/index");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("chat.ingestDroppedFiles and chat defaults", () => {
    it("skips empty or failing webUtils lookups and forwards only { path, mime }", async () => {
      const chat = harness.exposed.get("chat")!;
      const goodA = { name: "a.png", type: "image/png", size: 100 } as unknown as File;
      const throwing = { name: "bad.bin", type: "application/octet-stream" } as unknown as File;
      const emptyPath = { name: "empty.txt", type: "text/plain" } as unknown as File;
      const goodB = { name: "b.md", type: "text/markdown", lastModified: 123 } as unknown as File;

      harness.getPathForFile.mockImplementation((file: File) => {
        if (file === goodA) return "E:/drop/a.png";
        if (file === throwing) throw new Error("unreadable native file");
        if (file === emptyPath) return "";
        if (file === goodB) return "E:/drop/b.md";
        return "";
      });
      harness.invoke.mockResolvedValue([{ id: "att-1" }]);

      const result = await chat.ingestDroppedFiles([goodA, throwing, emptyPath, goodB]);
      expect(result).toEqual([{ id: "att-1" }]);
      expect(harness.invoke.mock.calls).toEqual([
        [
          IPC.CHAT_INGEST_FILES,
          [
            { path: "E:/drop/a.png", mime: "image/png" },
            { path: "E:/drop/b.md", mime: "text/markdown" },
          ],
        ],
      ]);
    });

    it("does not invoke IPC when dropped file list is empty or every entry fails", async () => {
      const chat = harness.exposed.get("chat")!;
      expect(await chat.ingestDroppedFiles([])).toEqual([]);
      expect(harness.invoke).not.toHaveBeenCalled();

      harness.getPathForFile.mockImplementation((file: File) => {
        if ((file as unknown as { fail?: boolean }).fail) throw new Error("boom");
        return "";
      });
      expect(await chat.ingestDroppedFiles([{ fail: true, type: "image/png" }, { type: "text/plain" }])).toEqual([]);
      expect(harness.invoke).not.toHaveBeenCalled();
    });

    it("applies default hasAnnotations=false and maps empty sessionId to undefined", async () => {
      const chat = harness.exposed.get("chat")!;
      await chat.captionImage("/tmp/a.png");
      await chat.getImageSendStrategy();
      await chat.getImageSendStrategy("");
      await chat.getImageSendStrategy("sess-9");

      expect(harness.invoke.mock.calls).toEqual([
        [IPC.CHAT_CAPTION_IMAGE, { filePath: "/tmp/a.png", hasAnnotations: false }],
        [IPC.CHAT_GET_IMAGE_SEND_STRATEGY, undefined],
        [IPC.CHAT_GET_IMAGE_SEND_STRATEGY, undefined],
        [IPC.CHAT_GET_IMAGE_SEND_STRATEGY, { sessionId: "sess-9" }],
      ]);
    });
  });

  describe("fireflyAppearance.get and onChanged normalization", () => {
    it("clamps bounds, falls back invalid enums, strips unknown keys, and maps segmentedChatEnabled", async () => {
      const appearance = harness.exposed.get("fireflyAppearance")!;
      const rawUntrusted = {
        chatLineHeight: 99,
        chatParaSpacing: -5,
        uiFontSize: 200,
        chatFontSize: 3,
        codeFontSize: Number.NaN,
        reduceMotion: "never",
        codeFont: "comic-sans",
        fullWidthChat: "yes",
        diffMarkers: "dots",
        pointerCursor: 1,
        smartPunctuation: true,
        codeThemeLight: "invalid-light",
        codeThemeDark: "github-dark",
        segmentedChatEnabled: false,
        leakedSecret: "should-not-pass",
      };
      const expectedNormalized = {
        ...DEFAULT_CHAT_APPEARANCE,
        chatLineHeight: 3.0,
        chatParaSpacing: 0.2,
        uiFontSize: 20,
        chatFontSize: 12,
        codeFontSize: DEFAULT_CHAT_APPEARANCE.codeFontSize,
        fullWidthChat: false,
        pointerCursor: false,
        smartPunctuation: true,
        codeThemeDark: "github-dark",
        segmentedChat: false,
      };

      harness.invoke.mockResolvedValueOnce(rawUntrusted);
      expect(await appearance.get()).toEqual(expectedNormalized);

      const received: unknown[] = [];
      const off = appearance.onChanged((value: unknown) => received.push(value));
      harness.emit(IPC.CHAT_TYPOGRAPHY_CHANGED, rawUntrusted);
      harness.emit(IPC.CHAT_TYPOGRAPHY_CHANGED, null);
      off();

      expect(received).toEqual([
        expectedNormalized,
        {
          ...DEFAULT_CHAT_APPEARANCE,
          segmentedChat: true,
        },
      ]);
    });
  });

  describe("choice.resolve payload discrimination", () => {
    it("maps string responses to { id, value } and non-string responses to { id, answer }", async () => {
      const choice = harness.exposed.get("choice")!;
      await choice.resolve("c-1", "ok");
      await choice.resolve("c-2", "");
      await choice.resolve("c-3", { chosen: 1 });
      await choice.resolve("c-4", null);

      expect(harness.invoke.mock.calls).toEqual([
        [IPC.CHOICE_RESOLVE, { id: "c-1", value: "ok" }],
        [IPC.CHOICE_RESOLVE, { id: "c-2", value: "" }],
        [IPC.CHOICE_RESOLVE, { id: "c-3", answer: { chosen: 1 } }],
        [IPC.CHOICE_RESOLVE, { id: "c-4", answer: null }],
      ]);
    });
  });

  describe("chatStore pageTargetKey, optional keys, and defaults", () => {
    it("keeps a stable UUID rendererTargetId across calls in one preload session and passes null when cleared", async () => {
      const chatStore = harness.exposed.get("chatStore")!;
      await chatStore.setActiveSession("s-1", "work");
      await chatStore.setActiveSession("s-2", "code");
      await chatStore.setActiveSession(null, "work");
      await chatStore.setActiveSession("", "chat");

      const firstPayload = harness.invoke.mock.calls[0][1] as Record<string, unknown>;
      const secondPayload = harness.invoke.mock.calls[1][1] as Record<string, unknown>;
      expect(firstPayload.rendererTargetId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(secondPayload.rendererTargetId).toBe(firstPayload.rendererTargetId);
      expect(harness.invoke.mock.calls[2]).toEqual([IPC.CHATS_SET_ACTIVE_SESSION, null]);
      expect(harness.invoke.mock.calls[3]).toEqual([IPC.CHATS_SET_ACTIVE_SESSION, null]);

      vi.resetModules();
      harness.exposed.clear();
      await import("../preload/index");
      const freshChatStore = harness.exposed.get("chatStore")!;
      await freshChatStore.setActiveSession("s-3", "chat");
      const freshPayload = harness.invoke.mock.calls[4][1] as Record<string, unknown>;
      expect(freshPayload.rendererTargetId).not.toBe(firstPayload.rendererTargetId);
    });

    it("omits userSticker from pendingEdit when undefined and keeps empty string when defined", async () => {
      const chatStore = harness.exposed.get("chatStore")!;
      await chatStore.pendingEdit("s-1", "m-1", { rawContent: "raw", visibleContent: "vis" });
      await chatStore.pendingEdit("s-1", "m-2", { rawContent: "raw2", visibleContent: "vis2", userSticker: "" });
      await chatStore.create();

      const omittedPayload = harness.invoke.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(omittedPayload).sort()).toEqual(["messageId", "rawContent", "sessionId", "visibleContent"]);
      expect(Object.prototype.hasOwnProperty.call(omittedPayload, "userSticker")).toBe(false);

      expect(harness.invoke.mock.calls[1]).toEqual([
        IPC.CHATS_PENDING_EDIT,
        { sessionId: "s-1", messageId: "m-2", rawContent: "raw2", visibleContent: "vis2", userSticker: "" },
      ]);
      expect(harness.invoke.mock.calls[2]).toEqual([IPC.CHATS_CREATE, {}]);
    });
  });

  describe("settings, browser, codeGit, and live2dWork parameter guards", () => {
    it("filters settings.externalSkills DTO payloads and defaults channelsLogGet limit with nullish coalescing", async () => {
      const settings = harness.exposed.get("settings")!;
      await settings.externalSkills.list("openai");
      await settings.externalSkills.detail("openai", "sk-1", undefined);
      await settings.externalSkills.prepare("openai", "sk-2", undefined);
      await settings.channelsLogGet();
      await settings.channelsLogGet(0);

      expect(harness.invoke.mock.calls[0]).toEqual([IPC.EXTERNAL_SKILLS_LIST, { sourceId: "openai", refresh: false }]);
      const detailPayload = harness.invoke.mock.calls[1][1] as Record<string, unknown>;
      expect(Object.keys(detailPayload).sort()).toEqual(["id", "sourceId"]);
      const preparePayload = harness.invoke.mock.calls[2][1] as Record<string, unknown>;
      expect(Object.keys(preparePayload).sort()).toEqual(["id", "sourceId"]);
      expect(harness.invoke.mock.calls[3]).toEqual([IPC.CHANNELS_LOG_GET, 100]);
      expect(harness.invoke.mock.calls[4]).toEqual([IPC.CHANNELS_LOG_GET, 0]);
    });

    it("omits optional tabId/conversationId keys on manualBrowser* and defaults codeGit.switchBranch create=false", async () => {
      const manualBrowser = harness.exposed.get("manualBrowser")!;
      const workspaceBrowser = harness.exposed.get("manualBrowserWorkspace")!;
      const codeGit = harness.exposed.get("codeGit")!;

      await manualBrowser.revokePermission();
      await workspaceBrowser.getPermission();
      await workspaceBrowser.revokePermission("ws-1");
      await workspaceBrowser.execute({ kind: "get" });
      await codeGit.switchBranch("s-1", "main");

      expect(harness.invoke.mock.calls).toEqual([
        [IPC.BROWSER_PERMISSION, { kind: "revoke" }],
        [MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "get" }],
        [MANUAL_BROWSER_WORKSPACE_IPC.permission, { kind: "revoke", workspaceId: "ws-1" }],
        [MANUAL_BROWSER_WORKSPACE_IPC.command, { kind: "get" }],
        [IPC.CODE_GIT_SWITCH_BRANCH, { sessionId: "s-1", branch: "main", create: false }],
      ]);
      for (const call of harness.invoke.mock.calls.slice(0, 4)) {
        const payload = call[1] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(payload, "tabId")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(payload, "conversationId")).toBe(false);
      }
    });

    it("coerces non-boolean live2dWork snapshots and swallows invoke rejections to false", async () => {
      const live2dWork = harness.exposed.get("live2dWork")!;
      harness.invoke.mockResolvedValueOnce("yes");
      expect(await live2dWork.getWorking()).toBe(false);
      harness.invoke.mockRejectedValueOnce(new Error("no handler"));
      expect(await live2dWork.getWorking()).toBe(false);
    });
  });

  describe("listener exception isolation", () => {
    it.each([
      ["agui", IPC.AGUI_EVENT],
      ["schedulerEvents", IPC.SCHEDULER_EVENT],
    ] as const)("%s.onEvent catches callback errors and continues delivering subsequent events", (namespace, channel) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const api = harness.exposed.get(namespace)!;
      const delivered: unknown[] = [];

      const off = api.onEvent((payload: unknown) => {
        if (payload === "boom") {
          throw new Error("listener crashed");
        }
        delivered.push(payload);
      });

      expect(() => harness.emit(channel, "boom")).not.toThrow();
      harness.emit(channel, { ok: true });
      off();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual([{ ok: true }]);
    });
  });
});
