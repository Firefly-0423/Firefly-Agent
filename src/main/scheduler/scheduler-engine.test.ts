import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerEngine } from "./scheduler-engine";
import { createSchedulerStore } from "./scheduler-store";
import { pluginTaskTogglePatch } from "./execution-spec";
import type { ScheduledTask, ScheduledTaskHistoryEntry, ScheduledRunResult } from "./types";

const engines: SchedulerEngine[] = [], folders: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const at = (time: string) => new Date(`2026-10-21T${time}:00.000Z`);
function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "garden-task", title: "Garden review", prompt: "Review plants", enabled: true,
    schedule: { kind: "daily", timeOfDay: "14:00" }, nextFireAt: at("06:00").toISOString(), toolMode: "all-enabled",
    allowedToolIds: [], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...patch };
}
function plugin(patch: Partial<ScheduledTask> = {}) {
  const current = task({ enabled: false, ownerPluginId: "garden-plugin", ...patch });
  return { ...current, ...pluginTaskTogglePatch(current, true) };
}
function memoryStore(initial: ScheduledTask[]) {
  let tasks = initial;
  const history: ScheduledTaskHistoryEntry[] = [], listeners = new Set<(value: ScheduledTask[]) => void>();
  return {
    getTasks: () => structuredClone(tasks),
    updateTask: vi.fn((id: string, patch: Partial<ScheduledTask>) => {
      tasks = tasks.map(entry => entry.id === id ? { ...entry, ...patch } : entry);
      for (const notify of listeners) notify(tasks);
      return tasks.find(entry => entry.id === id)!;
    }),
    recordHistory: vi.fn((entry: ScheduledTaskHistoryEntry) => { history.push(entry); }),
    onChange: (notify: (value: ScheduledTask[]) => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    history,
  };
}
const success = async (): Promise<ScheduledRunResult> => ({ ok: true, historyId: "garden-history", effectiveToolIds: [] });
function engine(deps: ConstructorParameters<typeof SchedulerEngine>[0]) {
  const instance = new SchedulerEngine(deps); engines.push(instance); return instance;
}
function realStore(now: () => Date, persisted?: ScheduledTask) {
  const folder = mkdtempSync(join(tmpdir(), "ff-engine-store-")); folders.push(folder);
  const tasksFile = join(folder, "tasks.json");
  if (persisted) writeFileSync(tasksFile, JSON.stringify({ tasks: [persisted] }));
  const store = createSchedulerStore({ tasksFile, historyFile: join(folder, "history.jsonl"), now, id: () => "garden-task" });
  store.load();
  return store;
}
it("keeps a single bounded timer for distant schedules without firing them early", () => {
  const store = memoryStore([task({ nextFireAt: "2027-01-21T06:00:00Z" })]);
  engine({ store, now: () => at("06:00"), runTask: success }).start();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(3600000 - 1);
  expect(store.recordHistory).not.toHaveBeenCalled();
});
it("rejects a manual request for a task that already has an active run", async () => {
  let complete!: (value: ScheduledRunResult) => void;
  const instance = engine({ store: memoryStore([task()]), now: () => at("06:00"),
    runTask: () => new Promise(resolve => { complete = resolve; }) });
  const first = instance.fireNow("garden-task");
  expect(await instance.fireNow("garden-task")).toEqual({ ok: false, reason: "task already running" });
  complete(await success());
  await first;
});
it("runs a delayed interval only once and rolls all missed slots forward", async () => {
  let now = at("05:59");
  const store = memoryStore([task({ schedule: { kind: "interval", every: 1, unit: "hours" } })]), run = vi.fn(success);
  engine({ store, now: () => now, runTask: run }).start();
  now = at("10:15");
  await vi.advanceTimersByTimeAsync(60000);
  now = new Date(at("10:15").getTime() + 1000);
  await vi.runOnlyPendingTimersAsync();
  expect(run).toHaveBeenCalledTimes(1);
  expect(store.getTasks()[0].nextFireAt).toBe(at("11:00").toISOString());
});
it("disables an invalid in-memory timestamp rather than starting a zero-delay timer", () => {
  const store = memoryStore([task({ nextFireAt: "invalid-garden-time" })]);
  engine({ store, now: () => at("06:00"), runTask: success }).start();
  expect(vi.getTimerCount()).toBe(0);
  expect(store.updateTask).toHaveBeenCalledWith("garden-task", { enabled: false, nextFireAt: null });
});
it("normalizes overdue recurring timestamps through the actual persistence store", () => {
  const store = realStore(() => at("06:00"));
  store.addTask({ title: "Garden interval", prompt: "Review plants", schedule: { kind: "interval", every: 1, unit: "hours" } });
  engine({ store, now: () => at("10:15"), runTask: success }).start();
  expect(store.getTasks()[0].nextFireAt).toBe(at("11:00").toISOString());
});
it("persists the next interval after its scheduled slot fires", async () => {
  const store = realStore(() => at("05:00"));
  store.addTask({ title: "Garden interval", prompt: "Review plants", schedule: { kind: "interval", every: 1, unit: "hours" } });
  let now = at("05:59");
  engine({ store, now: () => now, runTask: success }).start();
  now = at("06:00");
  await vi.advanceTimersByTimeAsync(60000);
  expect(store.getTasks()[0].nextFireAt).toBe(at("07:00").toISOString());
});
it("handles malformed persisted next-fire timestamps without throwing", () => {
  const store = realStore(() => at("06:00"), task({ nextFireAt: "invalid-garden-time" }));
  const instance = engine({ store, now: () => at("06:00"), runTask: success });
  expect(() => instance.start()).not.toThrow();
  expect(store.getTasks()[0].enabled).toBe(false);
  expect(store.getTasks()[0].nextFireAt).toBeNull();
});
it("rejects manual plugin runs while their plugin is unavailable", async () => {
  const instance = engine({ store: memoryStore([plugin()]), now: () => at("06:00"), runTask: success, canRunTask: () => false });
  expect(await instance.fireNow("garden-task")).toEqual({ ok: false, reason: "plugin not running" });
});
it("never schedules a plugin task without user authorization", () => {
  const store = memoryStore([plugin({ pluginUserEnabled: false })]);
  const current = store.getTasks()[0];
  store.updateTask(current.id, { pluginUserEnabled: false, approvalFingerprint: "" });
  engine({ store, now: () => at("06:00"), runTask: success }).start();
  expect(vi.getTimerCount()).toBe(0);
});
it("skips unavailable plugins at their scheduled slot and advances without catch-up", async () => {
  const store = memoryStore([plugin({ schedule: { kind: "interval", every: 1, unit: "hours" } })]), run = vi.fn(success);
  let now = at("05:59");
  engine({ store, now: () => now, runTask: run, canRunTask: () => false }).start();
  now = at("06:00");
  await vi.advanceTimersByTimeAsync(60000);
  expect(run).not.toHaveBeenCalled();
  expect(store.history.find(entry => entry.status === "skipped")?.reason).toBe("plugin not running");
  expect(store.getTasks()[0].nextFireAt).toBe(at("07:00").toISOString());
});
it("refreshes overdue plugin tasks and executes their next future slot", async () => {
  const store = memoryStore([plugin({ schedule: { kind: "interval", every: 1, unit: "hours" }, nextFireAt: at("05:00").toISOString() })]);
  let now = at("04:00");
  const run = vi.fn(success), instance = engine({ store, now: () => now, runTask: run, canRunTask: () => true });
  instance.start();
  now = at("10:15");
  instance.refreshPluginTasks();
  expect(store.getTasks()[0].nextFireAt).toBe(at("11:00").toISOString());
  now = at("11:00");
  await vi.advanceTimersByTimeAsync(3600000);
  expect(run).toHaveBeenCalledTimes(1);
});
