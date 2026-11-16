import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observable, type Subscriber } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import type { IpcScope } from "../../base/ipc/ipc-scope";

const wire = vi.hoisted(() => ({
  root: "", handlers: new Map<string, (...args: any[]) => any>(),
  broadcast: vi.fn(), dispatch: vi.fn(), tool: vi.fn(),
  streams: [] as Subscriber<any>[], options: [] as any[],
}));
vi.mock("electron", () => ({
  app: { getPath: () => wire.root }, shell: {},
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: wire.broadcast } }] },
  ipcMain: { handle: (id: string, fn: (...args: any[]) => any) => wire.handlers.set(id, fn), on: vi.fn(), removeListener: vi.fn() },
}));
// The model boundary owns a single suspended tool call; permission and run registration stay real.
vi.mock("../../agent/runtime/firefly-agent", () => ({ FireflyAgent: class {
  lastResult = { reply: "Done", toolResults: [] };
  runWithEvents(options: any) {
    wire.dispatch(options.runId);
    wire.options.push(options);
    return new Observable(subscriber => {
      wire.streams.push(subscriber);
      subscriber.next({ type: "RUN_STARTED", runId: options.runId });
      void import("../../platform/permission/permission").then(async permission => {
        try {
          const result = await permission.checkPermission({ runId: options.runId, signal: options.signal,
            risk: "fs-write", toolId: "write_file", toolName: "Write file", toolDescription: "Write", args: { path: "result.txt" } });
          if (result.allowed) wire.tool(options.runId);
        } catch { /* Cancellation leaves the stream open to exercise takeover drain. */ }
      });
    });
  }
} }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  wire.root = fs.mkdtempSync(join(tmpdir(), "approval-acceptance-"));
  wire.handlers.clear(); wire.streams = []; wire.options = [];
});
let cleanup: (() => void) | undefined;
afterEach(async () => {
  cleanup?.(); cleanup = undefined;
  wire.streams.forEach(stream => stream.complete());
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers();
  fs.rmSync(wire.root, { recursive: true, force: true });
});

async function fixture() {
  const permission = await import("../../platform/permission/permission");
  const bridge = await import("./agui-bridge");
  const chats = await import("../sessions/chats-store");
  const { toastEvents } = await import("../../platform/interaction/toast-events");
  const { createApprovalReview } = await import("../../platform/toast/approval-review");
  const { createToastService } = await import("../../platform/toast/toast-service");
  const { activeChatTargetRegistry: target } = await import("../../platform/interaction/active-chat-target");
  chats.initialize();
  const a = chats.createSession({ mode: "chat", title: "A", initialMessages: [{ id: "input", role: "user", content: "Write", at: 1 }] });
  const b = chats.createSession({ mode: "chat", title: "B" });
  permission.setCurrentLevel("per-action");
  const send = vi.fn(), routes = new Map<string, (...args: any[]) => any>(), listeners = new Map<string, (...args: any[]) => any>();
  const ipc: IpcScope = { handle: (id, fn) => { routes.set(id, fn); }, on: (id, fn) => { listeners.set(id, fn); }, dispose: vi.fn(), removeHandler: vi.fn() };
  const service = createToastService({ bus: toastEvents, activate: vi.fn(), newId: () => "toast-a",
    window: { send, owns: sender => sender.id === 106, updateHeight: vi.fn(), syncVisibility: vi.fn(), preload: vi.fn(), dispose: vi.fn(), isVisible: () => false },
    review: createApprovalReview({ ...permission, findActiveSessionForRun: bridge.findActiveConversationForRun, getSessionTitle: id => chats.getSession(id)?.title }),
  });
  service.registerIpc(ipc);
  const build = vi.fn(async () => ({ options: { settings: { provider: "fixture", baseUrl: "", model: "", apiKey: "", contextWindowTokens: 256000 }, messages: [], timeoutMs: 2000, toolSystemContent: "", soulSystemBaseContent: "" }, latestUserText: "Write" }));
  bridge.registerAgUiIpc(build, async () => ({}), () => null);
  const navigation = new Map<string, (...args: any[]) => void>();
  const sender = { id: 12, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), on: (name: string, fn: (...args: any[]) => void) => navigation.set(name, fn), removeListener: vi.fn() };
  const run = (patch = {}) => wire.handlers.get(IPC.AGUI_RUN)!({ sender }, { sessionId: a.id, messages: [{ role: "user", content: "Write" }], userTurnId: "input", ...patch });
  const ack = await run();
  await vi.advanceTimersByTimeAsync(0);
  const id = service.getActiveToasts()[0].sourceId;
  cleanup = () => { permission.cancelPendingApprovalsForRun(ack.runId); service.dispose(); target.dispose(); };
  const invoke = (channel: string, payload: unknown, from = 106) => routes.get(channel)!({ sender: { id: from } }, payload);
  return { permission, bridge, a, b, target, sender, navigation, run, ack, id, build, service, send,
    inspect: (from = 106) => invoke(IPC.TOAST_APPROVAL_INSPECT, id, from),
    answer: (from = 106) => invoke(IPC.TOAST_APPROVAL_ANSWER, { id, allowed: true }, from),
    report: (channel: string) => listeners.get(channel)!({ sender: { id: 106 } }, "toast-a"),
    removes: () => send.mock.calls.filter(([channel]) => channel === IPC.TOAST_REMOVE),
    settled: () => wire.broadcast.mock.calls.filter(([channel]) => channel === IPC.PERMISSION_APPROVAL_SETTLED),
  };
}

describe("approval review after a renderer reload", () => {
  it("approves A after reload and switching to B, resumes once and delivers one terminal", async () => {
    const f = await fixture();
    // Exercise the real main-process target registry's navigation invalidation and new page registration.
    f.target.setActive({ sender: f.sender as any, sessionId: f.a.id, mode: "chat", rendererTargetId: "old-page" });
    f.navigation.get("did-start-navigation")!({}, "app://chat", false, true);
    expect(f.target.getActive()).toEqual(null);
    f.target.setActive({ sender: f.sender as any, sessionId: f.b.id, mode: "chat", rendererTargetId: "new-page" });
    expect(f.target.getActive()).toEqual({ sessionId: f.b.id, mode: "chat", rendererTargetId: "new-page", webContentsId: 12 });
    const pushes = f.send.mock.calls.filter(([channel]) => channel === IPC.TOAST_PUSH);
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1].review).toEqual({ approvalId: f.id });
    expect(f.inspect()).toEqual({ state: "pending", approvalId: f.id, toolName: "Write file", toolId: "write_file", args: [{ key: "path", value: "result.txt" }], session: { id: f.a.id, title: "A" } });
    expect(f.answer()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.tool.mock.calls).toEqual([[f.ack.runId]]);
    expect(wire.dispatch.mock.calls).toEqual([[f.ack.runId]]);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.settled()).toEqual([[IPC.PERMISSION_APPROVAL_SETTLED, { id: f.id, runId: f.ack.runId, reason: "answered" }]]);
    expect(f.removes()).toEqual([[IPC.TOAST_REMOVE, "toast-a"]]);
    expect(f.answer()).toEqual({ ok: false });
    wire.streams[0].next({ type: "RUN_FINISHED", runId: f.ack.runId, result: { status: "success", externalEffectsMayContinue: false } });
    wire.streams[0].complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sender.send.mock.calls.filter(([channel, event]) => channel === IPC.AGUI_EVENT && event.type === "RUN_FINISHED").map(([, event]) => ({ runId: event.runId, result: event.result }))).toEqual([{ runId: f.ack.runId, result: { status: "success", externalEffectsMayContinue: false } }]);
    expect(f.settled()).toHaveLength(1); expect(f.removes()).toHaveLength(1);
    expect(wire.tool.mock.calls).toEqual([[f.ack.runId]]);
  });

  it("expires the old reminder after cancellation without executing the tool", async () => {
    const f = await fixture();
    await wire.handlers.get(IPC.AGUI_CANCEL)!({}, f.ack.runId);
    expect(f.inspect()).toEqual({ state: "expired", approvalId: f.id });
    const settled = f.settled(), removes = f.removes();
    expect(f.answer()).toEqual({ ok: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.tool.mock.calls).toEqual([]);
    expect(f.settled()).toEqual(settled); expect(f.removes()).toEqual(removes);
    expect(wire.dispatch.mock.calls).toEqual([[f.ack.runId]]);
  });

  it("rejects the old approval during takeover drain, including a late pending request", async () => {
    const f = await fixture();
    const takeover = f.run({ takeoverFromRunId: f.ack.runId });
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.options[0].signal.aborted).toBe(true);
    expect(f.inspect()).toEqual({ state: "expired", approvalId: f.id });
    expect(f.answer()).toEqual({ ok: false });
    // A stale producer without a signal can still publish while the aborted run drains.
    const late = f.permission.requestApproval({ runId: f.ack.runId, toolId: "write_file", toolName: "Write file", toolDescription: "Write", risk: "fs-write", args: {} });
    const observed = late.catch(() => false);
    const lateId = f.service.getActiveToasts()[0].sourceId;
    const { createApprovalReview } = await import("../../platform/toast/approval-review");
    const review = createApprovalReview({ ...f.permission, findActiveSessionForRun: f.bridge.findActiveConversationForRun });
    expect(review.inspect(lateId)).toEqual({ state: "unverified", approvalId: lateId, toolId: "write_file", toolName: "Write file", args: [] });
    expect(review.answer(lateId, true)).toEqual({ ok: false });
    expect(f.permission.getPendingApproval(lateId)?.id).toEqual(lateId);
    expect(wire.tool.mock.calls).toEqual([]);
    expect(wire.dispatch.mock.calls).toEqual([[f.ack.runId]]);
    f.permission.cancelPendingApprovalsForRun(f.ack.runId); await observed;
    wire.streams[0].complete(); await vi.advanceTimersByTimeAsync(0);
    const next = await takeover;
    f.permission.cancelPendingApprovalsForRun(next.runId);
  });

  it("accepts only one concurrent answer and rejects a late click", async () => {
    const f = await fixture();
    expect(await Promise.all([Promise.resolve().then(() => f.answer()), Promise.resolve().then(() => f.answer())])).toEqual([{ ok: true }, { ok: false }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.answer()).toEqual({ ok: false });
    expect(wire.tool.mock.calls).toEqual([[f.ack.runId]]);
    expect(f.settled()).toHaveLength(1); expect(f.removes()).toEqual([[IPC.TOAST_REMOVE, "toast-a"]]);
  });

  it("rejects both IPCs from another sender and keeps the approval waiting", async () => {
    const f = await fixture(), pending = f.permission.getPendingApproval(f.id), active = f.service.getActiveToasts();
    expect(f.inspect(907)).toEqual({ state: "expired", approvalId: f.id });
    expect(f.answer(907)).toEqual({ ok: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.permission.getPendingApproval(f.id)).toEqual(pending);
    expect(f.service.getActiveToasts()).toEqual(active);
    expect(f.settled()).toEqual([]); expect(f.removes()).toEqual([]); expect(wire.tool.mock.calls).toEqual([]);
    expect(wire.dispatch.mock.calls).toEqual([[f.ack.runId]]);
  });

  it("retains the reminder through inspect, body click and close until one settlement", async () => {
    const f = await fixture(), active = f.service.getActiveToasts();
    f.inspect();
    expect(f.service.getActiveToasts()).toEqual(active); expect(f.removes()).toEqual([]);
    for (const channel of [IPC.TOAST_CLICKED, IPC.TOAST_DISMISSED]) {
      f.report(channel);
      expect(f.service.getActiveToasts()).toEqual(active); expect(f.removes()).toEqual([]);
    }
    expect(f.answer()).toEqual({ ok: true }); expect(f.answer()).toEqual({ ok: false });
    expect(f.service.getActiveToasts()).toEqual([]);
    expect(f.removes()).toEqual([[IPC.TOAST_REMOVE, "toast-a"]]);
    expect(f.settled()).toHaveLength(1);
  });
});
