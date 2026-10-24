import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFileAccessLevel } from "./permission-policy";

const { send, handles } = vi.hoisted(() => ({ send: vi.fn(), handles: new Map<string, (...args: any[]) => unknown>() }));
vi.mock("electron", () => ({
  app: { getPath: () => "E:/Codex/2026-10-03/task-10/r1-r2/permission-synthetic" },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handles.set(channel, handler), removeHandler: vi.fn() },
}));
vi.mock("fs", () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() }, LogTag: { Permission: "permission" } }));
vi.mock("./toast/toast-events", () => ({ toastEvents: { publishApprovalPending: vi.fn(), publishApprovalSettled: vi.fn() } }));

import { IPC } from "../shared/ipc-channels";
import { checkPermission, registerPermissionIpc, setCurrentLevel } from "./permission";

registerPermissionIpc();
function request(level?: AgentFileAccessLevel) {
  return { toolId: "write_file", toolName: "Write File", toolDescription: "synthetic write", args: { path: "synthetic.txt" }, risk: "fs-write" as const, runId: "snapshot-test", level };
}

describe("session permission intersection", () => {
  beforeEach(() => { send.mockReset(); setCurrentLevel("full"); });
  it("does not widen a read-only session when global permissions become full", async () => {
    await expect(checkPermission(request("read-only"))).resolves.toMatchObject({ allowed: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("does not widen global read-only with a full session snapshot", async () => {
    setCurrentLevel("read-only");
    await expect(checkPermission(request("full"))).resolves.toMatchObject({ allowed: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps one per-action approval when the global setting becomes full", async () => {
    send.mockImplementation((channel: string, payload: { id: string }) => {
      if (channel === IPC.PERMISSION_APPROVAL_REQUEST) handles.get(IPC.PERMISSION_APPROVAL_RESOLVE)!(undefined, { id: payload.id, allowed: true });
    });
    await expect(checkPermission(request("per-action"))).resolves.toMatchObject({ allowed: true });
    expect(send.mock.calls.filter(call => call[0] === IPC.PERMISSION_APPROVAL_REQUEST)).toHaveLength(1);
  });
  it("retains the full/full legal positive control", async () => {
    await expect(checkPermission(request("full"))).resolves.toMatchObject({ allowed: true });
    expect(send).not.toHaveBeenCalled();
  });
  it("rechecks tightening while one approval is pending", async () => {
    send.mockImplementation((channel: string, payload: { id: string }) => {
      if (channel !== IPC.PERMISSION_APPROVAL_REQUEST) return;
      setCurrentLevel("read-only");
      handles.get(IPC.PERMISSION_APPROVAL_RESOLVE)!(undefined, { id: payload.id, allowed: true });
    });
    await expect(checkPermission(request("per-action"))).resolves.toMatchObject({ allowed: false });
    expect(send.mock.calls.filter(call => call[0] === IPC.PERMISSION_APPROVAL_REQUEST)).toHaveLength(1);
  });
  it("rechecks cancellation after an approval has been accepted", async () => {
    const controller = new AbortController();
    send.mockImplementation((channel: string, payload: { id: string }) => {
      if (channel !== IPC.PERMISSION_APPROVAL_REQUEST) return;
      handles.get(IPC.PERMISSION_APPROVAL_RESOLVE)!(undefined, { id: payload.id, allowed: true });
      controller.abort();
    });
    await expect(checkPermission({ ...request("per-action"), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(send.mock.calls.filter(call => call[0] === IPC.PERMISSION_APPROVAL_REQUEST)).toHaveLength(1);
  });
});
