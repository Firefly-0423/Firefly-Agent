import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchedulerStore } from "./scheduler-store";
import { SchedulerEngine } from "./scheduler-engine";
import { computeExecutionSpecFingerprint, isTaskEnabled, pluginTaskTogglePatch } from "./execution-spec";
import { computeInitialNextFireAt, computeNextFireAtAfter, normalizeOverdueNextFireAt } from "./schedule-calculator";
import type { ScheduleConfig, ScheduledRunResult } from "../../platform/schedule/schedule-types";

const cron = { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" } as ScheduleConfig;
const at = (time: string) => new Date(`2032-03-10T${time}:00.000Z`);
let directory: string, now: Date;
let engine: SchedulerEngine | undefined;
beforeEach(() => { vi.useFakeTimers(); now = at("10:00"); vi.setSystemTime(now); directory = mkdtempSync(join(tmpdir(), "ff-native-cron-")); });
afterEach(() => { engine?.stop(); engine = undefined; vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
function open() {
  const store = createSchedulerStore({ tasksFile: join(directory, "tasks.json"), historyFile: join(directory, "history.jsonl"), now: () => now, id: () => "cron-task" });
  store.load(); return store;
}
function add(store: ReturnType<typeof open>) {
  const task = store.addTask({ title: "Quarter hour", prompt: "Check", ownerPluginId: "dev.firefly.cron", schedule: cron, allowedToolIds: [] });
  return store.updateTask(task.id, pluginTaskTogglePatch(task, true));
}
const success = async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "run", effectiveToolIds: [] });
it("persists native cron and on restart skips missed slots to 10:30 without disabling authorization", () => {
  const original = add(open()); expect(original.schedule).toEqual(cron);
  now = at("10:20"); const store = open(); const runTask = vi.fn(success);
  engine = new SchedulerEngine({ store, now: () => now, runTask }); engine.start();
  const [task] = store.getTasks();
  expect(task.schedule).toEqual(cron); expect(task.nextFireAt).toBe(at("10:30").toISOString());
  expect(task.approvalFingerprint).toBe(original.approvalFingerprint); expect(isTaskEnabled(task)).toBe(true); expect(runTask).not.toHaveBeenCalled();
});
it("advances native cron when plugin is unavailable then runs the next slot without changing its approval", async () => {
  const store = open(); const original = add(store); let running = false; const runTask = vi.fn(success);
  engine = new SchedulerEngine({ store, now: () => now, runTask, canRunTask: () => running }); engine.start();
  now = at("10:15"); await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(runTask).not.toHaveBeenCalled(); expect(isTaskEnabled(store.getTasks()[0])).toBe(true);
  expect(store.getTasks()[0].nextFireAt).toBe(at("10:30").toISOString());
  expect(store.getHistory(original.id)).toContainEqual(expect.objectContaining({ status: "skipped", reason: "plugin not running" }));
  running = true; now = at("10:30"); await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(runTask).toHaveBeenCalledTimes(1); expect(store.getTasks()[0].nextFireAt).toBe(at("10:45").toISOString());
  expect(store.getTasks()[0].approvalFingerprint).toBe(original.approvalFingerprint);
});
it("skips overlapping native cron slots while preserving enablement and advances after completion", async () => {
  const store = open(); add(store); let release!: (result: ScheduledRunResult) => void;
  const runTask = vi.fn(() => new Promise<ScheduledRunResult>(resolve => { release = resolve; }));
  engine = new SchedulerEngine({ store, now: () => now, runTask }); engine.start();
  now = at("10:15"); await vi.advanceTimersByTimeAsync(15 * 60_000);
  now = at("10:30"); await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(runTask).toHaveBeenCalledTimes(1); expect(isTaskEnabled(store.getTasks()[0])).toBe(true);
  expect(store.getTasks()[0].nextFireAt).toBe(at("10:45").toISOString());
  expect(store.getHistory("cron-task")).toContainEqual(expect.objectContaining({ status: "skipped", reason: "previous run still active" }));
  release(await success()); await vi.advanceTimersByTimeAsync(0);
  now = at("10:45"); await vi.advanceTimersByTimeAsync(15 * 60_000); expect(runTask).toHaveBeenCalledTimes(2);
  release(await success());
});
it("resuming paused native cron after its appointment schedules the next future slot", () => {
  const store = open(); add(store); now = at("10:05"); store.updateTask("cron-task", { pluginUserEnabled: false });
  now = at("10:20"); store.updateTask("cron-task", { pluginUserEnabled: true });
  const [task] = store.getTasks(); expect(task.schedule).toEqual(cron); expect(isTaskEnabled(task)).toBe(true); expect(task.nextFireAt).toBe(at("10:30").toISOString());
});
it("calculates cron across New York spring gap and autumn repeated hour", () => {
  const spring = { kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" } as ScheduleConfig;
  expect(computeInitialNextFireAt(spring, new Date("2026-03-08T06:59:00Z"))?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  const autumn = { kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" } as ScheduleConfig;
  expect(computeNextFireAtAfter(autumn, new Date("2026-11-01T05:30:00Z"))?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  expect(normalizeOverdueNextFireAt(cron, at("10:15"), at("10:20"))?.toISOString()).toBe(at("10:30").toISOString());
});
it("fingerprints cron expression and timezone so either change revokes prior authorization", () => {
  const store = open(); const original = add(store); const spec = { schedule: cron, prompt: original.prompt, mode: "work" as const, allowedToolIds: [] };
  const fingerprint = computeExecutionSpecFingerprint(spec);
  for (const schedule of [{ kind: "cron", expression: "*/30 * * * *", timezone: "UTC" }, { kind: "cron", expression: "*/15 * * * *", timezone: "America/New_York" }] as ScheduleConfig[]) {
    expect(computeExecutionSpecFingerprint({ ...spec, schedule })).not.toBe(fingerprint);
    expect(isTaskEnabled({ ...original, schedule })).toBe(false);
  }
});
it.each([{ kind: "cron", expression: "60 * * * *" }, { kind: "cron", expression: "* * * * *", timezone: "Invalid/Timezone" }])("rejects invalid native cron without writing tasks: %j", schedule => {
  const store = open(); expect(() => store.addTask({ title: "Bad cron", prompt: "Check", schedule: schedule as ScheduleConfig })).toThrow(); expect(store.getTasks()).toEqual([]);
});

it.each(["restart", "dispatch"] as const)("a persisted impossible cron is stopped with history while other tasks continue on %s", async phase => {
  const original = add(open());
  const base = { ...original, enabled: true, ownerPluginId: undefined, schedule: { kind: "interval", every: 15, unit: "minutes" }, nextFireAt: at("10:15").toISOString() };
  writeFileSync(join(directory, "tasks.json"), JSON.stringify({ tasks: [
    { ...base, id: "bad-cron", schedule: { kind: "cron", expression: "0 9 30 2 *", timezone: "UTC" } },
    { ...base, id: "good-task" },
  ] }));
  if (phase === "restart") now = at("10:20");
  const store = open(); const runTask = vi.fn(success);
  engine = new SchedulerEngine({ store, now: () => now, runTask });
  expect(() => engine!.start()).not.toThrow();
  if (phase === "dispatch") { now = at("10:15"); await vi.advanceTimersByTimeAsync(15 * 60_000); }
  const bad = store.getTasks().find(task => task.id === "bad-cron")!;
  expect({ enabled: bad.enabled, nextFireAt: bad.nextFireAt }).toEqual({ enabled: false, nextFireAt: null });
  expect(store.getHistory("bad-cron")).toContainEqual(expect.objectContaining({ status: "skipped", reason: "schedule has no future occurrence" }));
  expect(store.getTasks().find(task => task.id === "good-task")!.nextFireAt).toBe(at("10:30").toISOString());
  now = at("10:30"); await vi.advanceTimersByTimeAsync((phase === "restart" ? 10 : 15) * 60_000);
  expect(runTask.mock.calls.map(([task]) => task.id)).toEqual(phase === "restart" ? ["good-task"] : ["good-task", "good-task"]);
});
it("keeps a legal leap-day cron across the non-leap century year 2100", () => {
  const plan = { kind: "cron", expression: "0 9 29 2 *", timezone: "UTC" } as ScheduleConfig;
  expect(computeNextFireAtAfter(plan, new Date("2096-02-29T09:00:00Z"))?.toISOString()).toBe("2104-02-29T09:00:00.000Z");
});
