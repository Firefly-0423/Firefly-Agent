import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => "E:/Codex/permission-unknown-level-synthetic" },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock("fs", () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() }, LogTag: { Permission: "permission" } }));
vi.mock("./toast/toast-events", () => ({ toastEvents: { publishApprovalPending: vi.fn(), publishApprovalSettled: vi.fn() } }));

import { checkPermission, setCurrentLevel } from "./permission";
import type { AgentFileAccessLevel } from "./permission-policy";

// 会话快照里出现无法识别的档位时，必须按拒绝处理（只能收紧，不能放宽）。
// 这是对旧实现的一处收紧：旧版 policyFor 对未知档位返回 undefined，被合并逻辑当成放行。
describe("a session snapshot with an unrecognised level fails closed", () => {
  beforeEach(() => { send.mockReset(); setCurrentLevel("full"); });

  it.each(["bogus", "", "FULL"])("denies non-safe tools for session level %j", async (bad) => {
    for (const risk of ["fs-read", "fs-write", "shell", "network", "input-control"] as const) {
      await expect(checkPermission({
        toolId: "t", toolName: "T", toolDescription: "d", args: {}, risk, runId: "unknown-level",
        level: bad as unknown as AgentFileAccessLevel,
      })).resolves.toMatchObject({ allowed: false });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("still allows safe tools", async () => {
    await expect(checkPermission({
      toolId: "t", toolName: "T", toolDescription: "d", args: {}, risk: "safe", runId: "unknown-level",
      level: "bogus" as unknown as AgentFileAccessLevel,
    })).resolves.toEqual({ allowed: true });
  });
});
