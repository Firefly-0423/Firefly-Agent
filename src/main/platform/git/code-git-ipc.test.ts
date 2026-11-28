import { it, expect, vi, describe } from "vitest";
import { registerCodeGitIpc } from "./code-git-ipc";
import { IPC } from "../../../shared/ipc-channels";
import type { RegisterCodeGitIpcDeps } from "./code-git-ipc";
import type { CodeGitChangedPayload } from "../../../shared/code-git-types";

function chatContents() {
  const mainFrame = { url: "app://chat" };
  return { mainFrame, destroyed: false, isDestroyed() { return this.destroyed; }, send: vi.fn() };
}

function connectRoutes() {
  const routes: Record<string, (event: unknown, ...data: unknown[]) => unknown> = {};
  let publish!: (change: CodeGitChangedPayload) => void;
  const unsubscribe = vi.fn();
  const backend: RegisterCodeGitIpcDeps["service"] = {
    onChanged: vi.fn((callback) => { publish = callback; return unsubscribe; }),
    getStatusForSession: vi.fn(), watchSession: vi.fn(), unwatchSession: vi.fn(),
    commitForSession: vi.fn(), switchBranchForSession: vi.fn(), pushForSession: vi.fn(),
  };
  let chat: ReturnType<typeof chatContents> | null = chatContents();
  const registration = registerCodeGitIpc({
    service: backend,
    ipcMain: { handle(channel, callback) { routes[channel] = callback; } },
    getChatContents: () => chat,
  });
  const fromChat = () => ({ sender: chat, senderFrame: chat?.mainFrame });
  return {
    backend, registration, unsubscribe,
    get chat() { return chat; },
    closeChat() { chat = null; },
    publish: (data: CodeGitChangedPayload) => publish(data),
    call: (channel: string, data: unknown, event: unknown = fromChat()) => routes[channel](event, data),
  };
}

const ALL_CHANNELS = [IPC.CODE_GIT_STATUS, IPC.CODE_GIT_WATCH, IPC.CODE_GIT_UNWATCH, IPC.CODE_GIT_SWITCH_BRANCH, IPC.CODE_GIT_COMMIT, IPC.CODE_GIT_PUSH];

describe("Code Git renderer contract", () => {
  it("delivers a change identity only to the living chat window", () => {
    const port = connectRoutes();
    port.publish({ sessionId: "code-tab-84" });
    expect(port.chat!.send.mock.calls).toEqual([[IPC.CODE_GIT_CHANGED, { sessionId: "code-tab-84" }]]);
    port.chat!.destroyed = true;
    port.publish({ sessionId: "code-tab-84" });
    expect(port.chat!.send).toHaveBeenCalledTimes(1);
    port.closeChat();
    expect(() => port.publish({ sessionId: "code-tab-84" })).not.toThrow();
  });

  it("stops listening for changes when disposed", () => {
    const port = connectRoutes();
    port.registration.dispose();
    expect(port.unsubscribe).toHaveBeenCalledOnce();
  });

  it("routes status and subscription requests using their session identity", async () => {
    const port = connectRoutes();
    for (const channel of [IPC.CODE_GIT_STATUS, IPC.CODE_GIT_WATCH, IPC.CODE_GIT_UNWATCH]) {
      await port.call(channel, "code-tab-84");
    }
    for (const operation of [port.backend.getStatusForSession, port.backend.watchSession, port.backend.unwatchSession]) {
      expect(operation).toHaveBeenCalledExactlyOnceWith("code-tab-84");
    }
  });

  it("forwards branch and commit data without a renderer supplied directory", async () => {
    const port = connectRoutes();
    await port.call(IPC.CODE_GIT_COMMIT, { sessionId: "code-tab-84", message: "repair: navigation", paths: ["ui/panel.ts"], workspaceRoot: "D:\\untrusted" });
    await port.call(IPC.CODE_GIT_SWITCH_BRANCH, { sessionId: "code-tab-84", branch: "repair/navigation", create: false, workspaceRoot: "D:\\untrusted" });
    expect(port.backend.commitForSession).toHaveBeenCalledExactlyOnceWith("code-tab-84", "repair: navigation", ["ui/panel.ts"]);
    expect(port.backend.switchBranchForSession).toHaveBeenCalledExactlyOnceWith("code-tab-84", "repair/navigation", false);
  });

  it.each([null, undefined, "", "  ", 23])("rejects unusable subscription identities: %s", (identity) => {
    const port = connectRoutes();
    expect(() => port.call(IPC.CODE_GIT_WATCH, identity)).toThrow("缺少会话标识");
    expect(() => port.call(IPC.CODE_GIT_UNWATCH, identity)).toThrow("缺少会话标识");
    expect(port.backend.watchSession).not.toHaveBeenCalled();
    expect(port.backend.unwatchSession).not.toHaveBeenCalled();
  });

  type Chat = ReturnType<typeof chatContents>;
  it.each([
    ["another window", (_chat: Chat) => { const other = chatContents(); return { sender: other, senderFrame: other.mainFrame }; }],
    ["a subframe of the chat window", (chat: Chat) => ({ sender: chat, senderFrame: { url: "https://embedded.example" } })],
    ["a frame that is gone", (chat: Chat) => ({ sender: chat, senderFrame: null })],
  ])("refuses every Git request from %s", (_label, makeEvent) => {
    const port = connectRoutes();
    const event = makeEvent(port.chat!);
    const body = { sessionId: "code-tab-84", message: "m", paths: ["a.ts"], branch: "b" };
    for (const channel of ALL_CHANNELS) {
      const data = channel === IPC.CODE_GIT_COMMIT || channel === IPC.CODE_GIT_SWITCH_BRANCH ? body : "code-tab-84";
      expect(() => port.call(channel, data, event)).toThrow("CODE_GIT_FORBIDDEN");
    }
    const backend = port.backend;
    for (const operation of [backend.getStatusForSession, backend.watchSession, backend.unwatchSession, backend.commitForSession, backend.switchBranchForSession, backend.pushForSession]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("refuses requests once the chat window is destroyed or closed", () => {
    const port = connectRoutes();
    const event = { sender: port.chat, senderFrame: port.chat!.mainFrame };
    port.chat!.destroyed = true;
    expect(() => port.call(IPC.CODE_GIT_PUSH, "code-tab-84", event)).toThrow("CODE_GIT_FORBIDDEN");
    port.closeChat();
    expect(() => port.call(IPC.CODE_GIT_PUSH, "code-tab-84", event)).toThrow("CODE_GIT_FORBIDDEN");
    expect(port.backend.pushForSession).not.toHaveBeenCalled();
  });
});
