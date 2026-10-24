import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { userDataRoot, cleanupUserData } = await vi.hoisted(async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-permission-contract-"));
  return { userDataRoot: root, cleanupUserData: () => fs.rmSync(root, { recursive: true, force: true }) };
});

const env = vi.hoisted(() => ({
  events: [] as string[],
  windows: [] as Array<{ webContents: { send: (channel: string, payload: unknown) => void } }>,
  ipcHandlers: new Map<string, (...args: any[]) => unknown>(),
  sends: [] as Array<{ win: number; channel: string; payload: any }>,
  toastPending: vi.fn(),
  toastSettled: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => userDataRoot) },
  BrowserWindow: { getAllWindows: () => env.windows },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => unknown) => { env.ipcHandlers.set(channel, listener); },
    removeHandler: vi.fn(),
  },
}));
vi.mock("./toast/toast-events", () => ({
  toastEvents: {
    publishApprovalPending: (payload: unknown) => { env.events.push("toast:pending"); env.toastPending(payload); },
    publishApprovalSettled: (payload: unknown) => { env.events.push("toast:settled"); env.toastSettled(payload); },
  },
}));

import * as fs from "node:fs";
import * as path from "node:path";
import { IPC } from "../shared/ipc-channels";
import {
  ACCESS_LEVEL_LABEL,
  cancelPendingApprovalsForRun,
  checkPermission,
  getCurrentLevel,
  initPermissionFromDisk,
  registerPermissionIpc,
  requestApproval,
  setCurrentLevel,
} from "./permission";
import type { AgentFileAccessLevel } from "./permission-policy";

afterAll(cleanupUserData);

const levelFile = path.join(userDataRoot, "agent-permission.json");

function useWindows(count: number): void {
  env.windows = Array.from({ length: count }, (_, win) => ({
    webContents: {
      send: (channel: string, payload: unknown) => {
        env.sends.push({ win, channel, payload });
        env.events.push("send:" + channel);
      },
    },
  }));
}

const requestsSeen = () => env.sends.filter(s => s.channel === IPC.PERMISSION_APPROVAL_REQUEST);
const settledSeen = () => env.sends.filter(s => s.channel === IPC.PERMISSION_APPROVAL_SETTLED);
const resolveHandler = () => env.ipcHandlers.get(IPC.PERMISSION_APPROVAL_RESOLVE)!;
const answer = (id: unknown, allowed: unknown) => resolveHandler()({}, { id, allowed });

type Outcome = { status: "resolved"; value: boolean } | { status: "rejected"; name: string };
const touchedRuns = new Set<string>();

/** 发起审批并把结果收进 holder；promise 永不抛出，避免遗留未处理拒绝。 */
function begin(runId: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
  touchedRuns.add(runId);
  const holder: { outcome?: Outcome } = {};
  const done = requestApproval({
    toolId: "write_file",
    toolName: "Write File",
    toolDescription: "writes a file",
    args: { path: "C:/tmp/x" },
    risk: "fs-write",
    runId,
    ...extra,
  }, signal).then(
    value => { holder.outcome = { status: "resolved", value }; },
    (error: Error) => { holder.outcome = { status: "rejected", name: error.name }; },
  );
  return { holder, done };
}

function idOf(index = 0): string {
  return requestsSeen().filter(s => s.win === 0)[index].payload.id as string;
}

beforeEach(() => {
  env.events.length = 0;
  env.sends.length = 0;
  env.ipcHandlers.clear();
  env.toastPending.mockClear();
  env.toastSettled.mockClear();
  useWindows(1);
  setCurrentLevel("full");
  fs.rmSync(levelFile, { force: true });
  registerPermissionIpc();
});

afterEach(() => {
  vi.useRealTimers();
  for (const runId of touchedRuns) cancelPendingApprovalsForRun(runId);
  touchedRuns.clear();
});

describe("requestApproval request and settlement", () => {
  it("broadcasts one request to every window, then notifies the toast service", async () => {
    useWindows(2);
    const { holder, done } = begin("run-shape");
    expect(requestsSeen().map(s => s.win)).toEqual([0, 1]);
    const payload = requestsSeen()[0].payload;
    expect(payload).toEqual({
      id: expect.stringMatching(/^approve-\d+-\d+$/),
      toolId: "write_file",
      toolName: "Write File",
      toolDescription: "writes a file",
      args: { path: "C:/tmp/x" },
      risk: "fs-write",
      runId: "run-shape",
    });
    expect(requestsSeen()[1].payload).toEqual(payload);
    expect(env.toastPending).toHaveBeenCalledTimes(1);
    expect(env.toastPending).toHaveBeenCalledWith({
      id: payload.id, toolId: "write_file", toolName: "Write File", runId: "run-shape",
    });
    expect(env.events).toEqual([
      "send:" + IPC.PERMISSION_APPROVAL_REQUEST,
      "send:" + IPC.PERMISSION_APPROVAL_REQUEST,
      "toast:pending",
    ]);
    expect(holder.outcome).toBeUndefined();
    answer(payload.id, true);
    await done;
  });

  it("resolves true on approval and broadcasts the answered settlement before resolving", async () => {
    const { holder, done } = begin("run-yes");
    const id = idOf();
    env.events.length = 0;
    expect(answer(id, true)).toEqual({ ok: true });
    expect(env.events).toEqual(["send:" + IPC.PERMISSION_APPROVAL_SETTLED, "toast:settled"]);
    expect(holder.outcome).toBeUndefined();
    await done;
    expect(holder.outcome).toEqual({ status: "resolved", value: true });
    expect(settledSeen().map(s => s.payload)).toEqual([{ id, runId: "run-yes", reason: "answered" }]);
    expect(env.toastSettled).toHaveBeenCalledWith({ id, runId: "run-yes", reason: "answered" });
  });

  it("resolves false when the user declines", async () => {
    const { holder, done } = begin("run-no");
    expect(answer(idOf(), false)).toEqual({ ok: true });
    await done;
    expect(holder.outcome).toEqual({ status: "resolved", value: false });
  });

  it.each([[1, true], ["yes", true], [{}, true], [0, false], ["", false], [null, false], [undefined, false]])(
    "coerces allowed=%j to %s",
    async (raw, expected) => {
      const { holder, done } = begin("run-coerce");
      answer(idOf(), raw);
      await done;
      expect(holder.outcome).toEqual({ status: "resolved", value: expected });
    },
  );

  it("ignores a second answer, an unknown id and a missing payload", async () => {
    const { done } = begin("run-twice");
    const id = idOf();
    expect(answer(id, true)).toEqual({ ok: true });
    await done;
    expect(answer(id, false)).toEqual({ ok: false });
    expect(answer("approve-0-0", true)).toEqual({ ok: false });
    expect(answer(undefined, true)).toEqual({ ok: false });
    expect(resolveHandler()({}, undefined)).toEqual({ ok: false });
    expect(resolveHandler()({}, null)).toEqual({ ok: false });
    expect(settledSeen()).toHaveLength(1);
  });

  it("refuses immediately, without any broadcast, when no window exists", async () => {
    useWindows(0);
    await expect(requestApproval({
      toolId: "t", toolName: "T", toolDescription: "d", args: {}, risk: "shell", runId: "run-none",
    })).resolves.toBe(false);
    expect(env.sends).toEqual([]);
    expect(env.toastPending).not.toHaveBeenCalled();
    expect(env.toastSettled).not.toHaveBeenCalled();
  });

  it("rejects an already aborted signal before anything is sent", async () => {
    const controller = new AbortController();
    controller.abort();
    const { holder, done } = begin("run-pre-aborted", {}, controller.signal);
    await done;
    expect(holder.outcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(env.sends).toEqual([]);
    expect(env.toastPending).not.toHaveBeenCalled();
  });

  it("an abort after the request settles it as cancelled and makes late answers no-ops", async () => {
    const controller = new AbortController();
    const { holder, done } = begin("run-abort", {}, controller.signal);
    const id = idOf();
    controller.abort();
    await done;
    expect(holder.outcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(settledSeen().map(s => s.payload)).toEqual([{ id, runId: "run-abort", reason: "cancelled" }]);
    expect(env.toastSettled).toHaveBeenCalledWith({ id, runId: "run-abort", reason: "cancelled" });
    expect(answer(id, true)).toEqual({ ok: false });
  });

  it("detaches the abort listener once the user has answered", async () => {
    const controller = new AbortController();
    const { holder, done } = begin("run-detach", {}, controller.signal);
    answer(idOf(), true);
    await done;
    controller.abort();
    expect(holder.outcome).toEqual({ status: "resolved", value: true });
    expect(settledSeen()).toHaveLength(1);
  });

  it("never times out on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout"] });
    const { holder } = begin("run-patient");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(holder.outcome).toBeUndefined();
    expect(settledSeen()).toEqual([]);
  });
});

describe("approval replay timer", () => {
  it("replays the identical request every 10 seconds until settled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { done } = begin("run-replay");
    const first = requestsSeen()[0].payload;
    vi.advanceTimersByTime(9_999);
    expect(requestsSeen()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(requestsSeen()).toHaveLength(2);
    expect(requestsSeen()[1].payload).toEqual(first);
    vi.advanceTimersByTime(10_000);
    expect(requestsSeen()).toHaveLength(3);
    // 重播不再触发 toast
    expect(env.toastPending).toHaveBeenCalledTimes(1);
    answer(first.id, true);
    await done;
    vi.advanceTimersByTime(60_000);
    expect(requestsSeen()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the replay timer when the run is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { done } = begin("run-replay-cancel");
    cancelPendingApprovalsForRun("run-replay-cancel");
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("concurrent approvals", () => {
  it("keeps independent pending entries with distinct, increasing ids", async () => {
    const calls = [begin("run-q1"), begin("run-q2"), begin("run-q3")];
    const ids = [0, 1, 2].map(i => idOf(i));
    expect(new Set(ids).size).toBe(3);
    const counters = ids.map(id => Number(/^approve-(\d+)-/.exec(id)![1]));
    expect(counters[1]).toBe(counters[0] + 1);
    expect(counters[2]).toBe(counters[1] + 1);

    // 乱序回答，各自拿到自己的结果
    answer(ids[2], false);
    answer(ids[0], true);
    expect(calls[1].holder.outcome).toBeUndefined();
    answer(ids[1], true);
    await Promise.all(calls.map(c => c.done));
    expect(calls.map(c => c.holder.outcome)).toEqual([
      { status: "resolved", value: true },
      { status: "resolved", value: true },
      { status: "resolved", value: false },
    ]);
    expect(settledSeen().map(s => s.payload.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it("cancels every pending approval of one run and nothing else", async () => {
    const a = begin("run-multi");
    const b = begin("run-multi");
    const other = begin("run-other");
    cancelPendingApprovalsForRun("run-multi");
    await Promise.all([a.done, b.done]);
    expect(a.holder.outcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(b.holder.outcome).toEqual({ status: "rejected", name: "AbortError" });
    expect(other.holder.outcome).toBeUndefined();
    expect(settledSeen()).toHaveLength(2);
    expect(settledSeen().every(s => s.payload.reason === "cancelled" && s.payload.runId === "run-multi")).toBe(true);
    // 重复取消与未知 run 都是空操作
    cancelPendingApprovalsForRun("run-multi");
    cancelPendingApprovalsForRun("run-never-existed");
    expect(settledSeen()).toHaveLength(2);
    answer(idOf(2), true);
    await other.done;
    expect(other.holder.outcome).toEqual({ status: "resolved", value: true });
  });

  it("does not cancel approvals that carry no runId when another run is cancelled", async () => {
    const anonymous = requestApproval({
      toolId: "t", toolName: "T", toolDescription: "d", args: {}, risk: "network",
    });
    let state = "pending";
    void anonymous.then(() => { state = "resolved"; });
    cancelPendingApprovalsForRun("undefined");
    await Promise.resolve();
    expect(state).toBe("pending");
    answer(idOf(), true);
    await anonymous;
    expect(settledSeen().map(s => s.payload)).toEqual([
      { id: expect.any(String), runId: undefined, reason: "answered" },
    ]);
  });
});

describe("approval origin passthrough", () => {
  it("copies toolCallId, childRunId and agentId onto the card and its replay", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { done } = begin("run-origin", { toolCallId: "call-1", childRunId: "child-1", agentId: "agent-1" });
    vi.advanceTimersByTime(10_000);
    const sent = requestsSeen();
    expect(sent).toHaveLength(2);
    for (const entry of sent) {
      expect(entry.payload).toMatchObject({ runId: "run-origin", toolCallId: "call-1", childRunId: "child-1", agentId: "agent-1" });
    }
    expect(env.toastPending).toHaveBeenCalledWith({
      id: sent[0].payload.id, toolId: "write_file", toolName: "Write File", runId: "run-origin",
    });
    answer(sent[0].payload.id, true);
    await done;
  });

  it("omits origin fields that were not provided", async () => {
    const { done } = begin("run-no-origin");
    const payload = requestsSeen()[0].payload;
    expect(Object.keys(payload).sort()).toEqual(
      ["args", "id", "risk", "runId", "toolDescription", "toolId", "toolName"],
    );
    answer(payload.id, true);
    await done;
  });
});

describe("checkPermission", () => {
  const base = {
    toolId: "write_file",
    toolName: "Write File",
    toolDescription: "synthetic write",
    args: { path: "a.txt" },
    risk: "fs-write" as const,
    runId: "check-run",
  };
  const check = (input: Partial<Parameters<typeof checkPermission>[0]> = {}) => {
    touchedRuns.add(input.runId ?? base.runId);
    return checkPermission({ ...base, ...input });
  };
  /** 等审批卡出现，再按给定答案回传。 */
  const answerOnRequest = (allowed: boolean, before?: () => void) => {
    const wasSend = env.windows[0].webContents.send;
    env.windows[0].webContents.send = (channel, payload) => {
      wasSend(channel, payload);
      if (channel !== IPC.PERMISSION_APPROVAL_REQUEST) return;
      before?.();
      answer((payload as { id: string }).id, allowed);
    };
  };

  it("allows a safe tool without asking, at every global level", async () => {
    for (const level of ["project-read-only", "read-only", "scoped", "per-action", "full"] as const) {
      setCurrentLevel(level);
      await expect(check({ risk: "safe" })).resolves.toEqual({ allowed: true });
    }
    expect(env.sends).toEqual([]);
  });

  it("denies with the level label and risk in the reason", async () => {
    setCurrentLevel("read-only");
    await expect(check()).resolves.toEqual({
      allowed: false,
      reason: "当前档位「只读」不允许此操作（risk=fs-write）。请到设置 → 流萤 → 本地文件权限提升档位。",
    });
    setCurrentLevel("project-read-only");
    await expect(check({ risk: "input-control" })).resolves.toEqual({
      allowed: false,
      reason: "当前档位「完全只读」不允许此操作（risk=input-control）。请到设置 → 流萤 → 本地文件权限提升档位。",
    });
    expect(env.sends).toEqual([]);
  });

  it("asks at per-action and passes the approval, risk and origin through", async () => {
    setCurrentLevel("per-action");
    answerOnRequest(true);
    await expect(check({
      runId: "run-pass", origin: { toolCallId: "call-9", childRunId: "child-9", agentId: "writer" },
    })).resolves.toEqual({ allowed: true });
    expect(requestsSeen()).toHaveLength(1);
    expect(requestsSeen()[0].payload).toEqual({
      id: expect.any(String),
      toolId: "write_file",
      toolName: "Write File",
      toolDescription: "synthetic write",
      args: { path: "a.txt" },
      risk: "fs-write",
      runId: "run-pass",
      toolCallId: "call-9",
      childRunId: "child-9",
      agentId: "writer",
    });
    expect(settledSeen()[0].payload).toMatchObject({ runId: "run-pass", reason: "answered" });
  });

  it("returns the refusal reason when the user declines", async () => {
    setCurrentLevel("per-action");
    answerOnRequest(false);
    await expect(check()).resolves.toEqual({ allowed: false, reason: "用户拒绝了此次操作。" });
  });

  it("reports tightening that happens while the approval is pending", async () => {
    setCurrentLevel("per-action");
    answerOnRequest(true, () => setCurrentLevel("read-only"));
    await expect(check()).resolves.toEqual({
      allowed: false,
      reason: "等待审批期间权限已收紧，此次操作未执行。",
    });
  });

  it("re-checks the session level after approval too", async () => {
    setCurrentLevel("per-action");
    answerOnRequest(true);
    await expect(check({ level: "per-action" })).resolves.toEqual({ allowed: true });
  });

  it("rejects when the signal was aborted before the check", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(check({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(check({ signal: controller.signal, risk: "safe" })).rejects.toMatchObject({ name: "AbortError" });
    expect(env.sends).toEqual([]);
  });

  it("rejects when the signal aborts while the approval is pending", async () => {
    setCurrentLevel("per-action");
    const controller = new AbortController();
    const result = check({ signal: controller.signal, runId: "run-abort-check" });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(settledSeen().map(s => s.payload.reason)).toEqual(["cancelled"]);
  });

  it("a run cancel rejects the pending check with AbortError", async () => {
    setCurrentLevel("per-action");
    const result = check({ runId: "run-cancel-check" });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    cancelPendingApprovalsForRun("run-cancel-check");
    await rejection;
  });

  const NARROW: Array<[AgentFileAccessLevel, AgentFileAccessLevel | undefined, "fs-write" | "shell" | "input-control" | "network", "allow" | "ask" | "deny"]> = [
    ["full", undefined, "fs-write", "allow"],
    ["full", "full", "input-control", "allow"],
    ["full", "read-only", "fs-write", "deny"],
    ["full", "project-read-only", "network", "allow"],
    ["full", "scoped", "input-control", "deny"],
    ["full", "per-action", "shell", "ask"],
    ["read-only", "full", "fs-write", "deny"],
    ["read-only", "per-action", "fs-write", "deny"],
    ["scoped", "full", "input-control", "deny"],
    ["scoped", "per-action", "fs-write", "ask"],
    ["per-action", "read-only", "fs-write", "deny"],
    ["per-action", "full", "fs-write", "ask"],
    ["per-action", "scoped", "fs-write", "ask"],
    ["per-action", "scoped", "input-control", "deny"],
    ["per-action", undefined, "shell", "ask"],
    ["scoped", "scoped", "shell", "allow"],
  ];

  it.each(NARROW)("global %s with session %s on %s -> %s", async (global, session, risk, expected) => {
    setCurrentLevel(global);
    if (expected === "ask") answerOnRequest(true);
    const result = await check({ level: session, risk, runId: "run-narrow" });
    expect(result.allowed).toBe(expected !== "deny");
    expect(requestsSeen().length).toBe(expected === "ask" ? 1 : 0);
    if (expected === "deny") expect(result.reason).toContain("risk=" + risk);
  });
});

describe("level persistence and IPC", () => {
  it("labels every level", () => {
    expect(ACCESS_LEVEL_LABEL).toEqual({
      "project-read-only": "完全只读",
      "read-only": "只读",
      "scoped": "指定目录",
      "per-action": "每次审批",
      "full": "完全访问",
    });
  });

  it("registers exactly the three channels on a supplied scope", () => {
    const registered = new Map<string, (...args: any[]) => unknown>();
    const scope = {
      handle: (channel: string, listener: (...args: any[]) => unknown) => { registered.set(channel, listener); },
      removeHandler: vi.fn(), on: vi.fn(), dispose: vi.fn(),
    };
    env.ipcHandlers.clear();
    registerPermissionIpc(scope);
    expect([...registered.keys()].sort()).toEqual([
      IPC.PERMISSION_APPROVAL_RESOLVE, IPC.PERMISSION_GET_LEVEL, IPC.PERMISSION_SET_LEVEL,
    ].sort());
    expect(env.ipcHandlers.size).toBe(0);
    expect(scope.on).not.toHaveBeenCalled();
  });

  it("reports the in-memory level", () => {
    setCurrentLevel("scoped");
    expect(env.ipcHandlers.get(IPC.PERMISSION_GET_LEVEL)!({})).toEqual({ level: "scoped" });
  });

  it("switches level for valid input and persists it as indented JSON", () => {
    const set = env.ipcHandlers.get(IPC.PERMISSION_SET_LEVEL)!;
    expect(set({}, "per-action")).toEqual({ ok: true, level: "per-action" });
    expect(getCurrentLevel()).toBe("per-action");
    expect(fs.readFileSync(levelFile, "utf8")).toBe('{\n  "level": "per-action"\n}');
  });

  it.each(["", "FULL", "bogus", undefined, null, 3, {}])("rejects invalid level %j without changing anything", (bad) => {
    setCurrentLevel("scoped");
    fs.rmSync(levelFile, { force: true });
    const set = env.ipcHandlers.get(IPC.PERMISSION_SET_LEVEL)!;
    expect(set({}, bad)).toEqual({ ok: false, error: "无效的档位: " + String(bad) });
    expect(getCurrentLevel()).toBe("scoped");
    expect(fs.existsSync(levelFile)).toBe(false);
  });

  it("does not rewrite the file when the level is unchanged", () => {
    setCurrentLevel("scoped");
    fs.rmSync(levelFile, { force: true });
    setCurrentLevel("scoped");
    expect(fs.existsSync(levelFile)).toBe(false);
    expect(env.ipcHandlers.get(IPC.PERMISSION_SET_LEVEL)!({}, "scoped")).toEqual({ ok: true, level: "scoped" });
    expect(fs.existsSync(levelFile)).toBe(false);
  });

  it("loads a saved level on startup without rewriting it", () => {
    setCurrentLevel("read-only");
    fs.writeFileSync(levelFile, JSON.stringify({ level: "per-action" }), "utf8");
    initPermissionFromDisk();
    expect(getCurrentLevel()).toBe("per-action");
    expect(fs.readFileSync(levelFile, "utf8")).toBe('{"level":"per-action"}');
  });

  it.each([
    ["missing file", undefined],
    ["unknown level", JSON.stringify({ level: "root" })],
    ["non-string level", JSON.stringify({ level: 1 })],
    ["no level", JSON.stringify({})],
    ["null document", "null"],
    ["corrupt JSON", "{not json"],
  ])("keeps the current level for %s", (_name, content) => {
    setCurrentLevel("scoped");
    fs.rmSync(levelFile, { force: true });
    if (content !== undefined) fs.writeFileSync(levelFile, content, "utf8");
    initPermissionFromDisk();
    expect(getCurrentLevel()).toBe("scoped");
  });
});
