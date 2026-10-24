import { it, expect, vi, describe } from "vitest";
import { registerCodeGitIpc } from "./code-git-ipc";
import { IPC } from "../../shared/ipc-channels";
import type { RegisterCodeGitIpcDeps } from "./code-git-ipc";
import type { CodeGitChangedPayload } from "../../shared/code-git-types";

function connectRoutes() {
  const routes: Record<string, (event: unknown, ...data: unknown[]) => unknown> = {};
  let publish!: (change: CodeGitChangedPayload) => void;
  const alive = vi.fn();
  const closed = vi.fn();
  const backend: RegisterCodeGitIpcDeps["service"] = {
    onChanged: vi.fn((callback) => { publish = callback; return vi.fn(); }),
    getStatusForSession: vi.fn(), watchSession: vi.fn(), unwatchSession: vi.fn(),
    commitForSession: vi.fn(), switchBranchForSession: vi.fn(), pushForSession: vi.fn(),
  };
  registerCodeGitIpc({
    service: backend,
    ipcMain: { handle(channel, callback) { routes[channel] = callback; } },
    getWindows: () => [
      { isDestroyed: () => true, webContents: { send: closed } },
      { isDestroyed: () => false, webContents: { send: alive } },
    ],
  });
  return { backend, alive, closed, publish: (data: CodeGitChangedPayload) => publish(data),
    call: (channel: string, data: unknown) => routes[channel]({}, data) };
}

describe("Code Git renderer contract", () => {
  it("delivers a change identity only to living windows", () => {
    const port = connectRoutes();
    port.publish({ sessionId: "code-tab-84" });
    expect(port.closed).not.toHaveBeenCalled();
    expect(port.alive.mock.calls).toEqual([[IPC.CODE_GIT_CHANGED, { sessionId: "code-tab-84" }]]);
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
});
