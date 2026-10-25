import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { cancelPendingApprovalsForRun, requestApproval, registerPermissionIpc } from "./permission";

const shell = vi.hoisted(() => ({ profile: "", windows: vi.fn(), handle: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => shell.profile },
  BrowserWindow: { getAllWindows: shell.windows }, ipcMain: { handle: shell.handle } }));
shell.profile = mkdtempSync(join(tmpdir(), "ff-approval-contract-"));
afterAll(() => rmSync(shell.profile, { recursive: true, force: true }));
beforeEach(() => { vi.useFakeTimers(); shell.windows.mockReset(); shell.windows.mockReturnValue([{ webContents: { send: vi.fn() } }]); });
afterEach(() => vi.useRealTimers());
const card = (runId: string) => ({ runId, risk: "fs-write" as const, toolId: "garden_save",
  toolName: "Save garden", toolDescription: "Stores garden notes", args: { path: "C:/garden/notes.md" } });
it("rejects cancelled run approvals with AbortError while another run remains pending", async () => {
  let unaffected: unknown;
  const cancelled = requestApproval(card("garden:cancel")).catch(error => ({ name: error.name, status: "rejected" }));
  const survivor = requestApproval(card("garden:keep")).then(value => { unaffected = value; }, error => { unaffected = error; });
  cancelPendingApprovalsForRun("garden:cancel");
  expect(await cancelled).toEqual({ name: "AbortError", status: "rejected" });
  expect(unaffected).toBeUndefined();
  cancelPendingApprovalsForRun("garden:keep");
  await survivor;
});
it("broadcasts cancellation to every renderer with the generated approval id", async () => {
  const sends = [vi.fn(), vi.fn()];
  shell.windows.mockReturnValue(sends.map(send => ({ webContents: { send } })));
  const pending = requestApproval(card("garden:broadcast")).catch(() => {});
  cancelPendingApprovalsForRun("garden:broadcast");
  await pending;
  for (const send of sends) {
    const notices = send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_SETTLED);
    expect(notices).toHaveLength(1);
    expect(notices[0][1]).toEqual({ id: expect.stringMatching(/^approve-/), runId: "garden:broadcast", reason: "cancelled" });
  }
});
it("waits for user action and replays the complete approval origin rather than auto-denying", async () => {
  const send = vi.fn();
  shell.windows.mockReturnValue([{ webContents: { send } }]);
  let settled = false;
  const origin = { ...card("garden:patient"), toolCallId: "call:seed", childRunId: "child:seed", agentId: "gardener" };
  const pending = requestApproval(origin).then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(20001);
  expect(settled).toBe(false);
  const requests = send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_REQUEST);
  expect(requests).toHaveLength(3);
  for (const [, payload] of requests) expect(payload).toEqual({ id: expect.stringMatching(/^approve-/), ...origin });
  cancelPendingApprovalsForRun(origin.runId);
  await pending;
});
it("cancels only a signalled child card and rejects its late response while accepting its sibling", async () => {
  shell.handle.mockClear();
  registerPermissionIpc();
  const answer = shell.handle.mock.calls.find(([channel]) => channel === IPC.PERMISSION_APPROVAL_RESOLVE)![1];
  const send = vi.fn(), child = new AbortController();
  shell.windows.mockReturnValue([{ webContents: { send } }]);
  const first = requestApproval(card("garden:parent"), child.signal).catch(error => error.name);
  let siblingSettled = false;
  const second = requestApproval(card("garden:parent")).then(value => { siblingSettled = true; return value; });
  const requests = send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_REQUEST);
  const [firstId, secondId] = requests.map(([, payload]) => payload.id);
  try {
    child.abort();
    await Promise.resolve();
    expect(send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_SETTLED)).toHaveLength(1);
    expect(await first).toBe("AbortError");
    expect(siblingSettled).toBe(false);
    expect(answer({}, { id: firstId, allowed: true })).toEqual({ ok: false });
    expect(answer({}, { id: secondId, allowed: true })).toEqual({ ok: true });
    expect(await second).toBe(true);
    expect(send.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_SETTLED).map(([, value]) => value))
      .toEqual([{ id: firstId, runId: "garden:parent", reason: "cancelled" }, { id: secondId, runId: "garden:parent", reason: "answered" }]);
  } finally {
    cancelPendingApprovalsForRun("garden:parent");
    await Promise.allSettled([first, second]);
  }
});
