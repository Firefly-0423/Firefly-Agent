import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerEngine } from "./scheduler-engine";
import type { ScheduledTask, ScheduledTaskHistoryEntry } from "./types";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(ids = ["a"]) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  const tasks: ScheduledTask[] = ids.map(id => ({ id, title: id, prompt: "offline", enabled: true,
    schedule: { kind: "interval", every: 1, unit: "hours" }, nextFireAt: "2026-10-18T10:01:00.000Z",
    toolMode: "allow-list", allowedToolIds: [], createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z" }));
  const listeners = new Set<() => void>();
  let writeFailure = false, readFailure = false;
  const store = {
    getTasks: () => { if (readFailure) throw Error("synthetic read failure"); return tasks.map(t => ({ ...t })); },
    updateTask: (id: string, patch: Partial<ScheduledTask>) => {
      if (writeFailure) throw Error("synthetic config failure");
      const task = tasks.find(t => t.id === id)!; Object.assign(task, patch); for (const listener of listeners) listener(); return task;
    },
    recordHistory: (_entry: ScheduledTaskHistoryEntry) => {},
    onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { store, tasks, listeners, failWrite: (value: boolean) => { writeFailure = value; }, failRead: (value: boolean) => { readFailure = value; } };
}
const success = async () => ({ ok: true, historyId: "h", effectiveToolIds: [] });

describe("scheduler asynchronous fault boundaries", () => {
  it("persists the scheduled slot before any task can produce effects", async () => {
    const f = fixture(); f.tasks[0].schedule = { kind: "once", runAt: f.tasks[0].nextFireAt! };
    const observed: unknown[] = [];
    const engine = new SchedulerEngine({ store: f.store, runTask: async () => {
      observed.push({ enabled: f.tasks[0].enabled, nextFireAt: f.tasks[0].nextFireAt }); return success();
    } });
    engine.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(observed).toEqual([{ enabled: false, nextFireAt: null }]); engine.stop();
  });

  it("does not execute or spin after a config advancement fails, and refresh cannot resume it", async () => {
    const f = fixture(), ran: string[] = [];
    const engine = new SchedulerEngine({ store: f.store, runTask: async task => { ran.push(task.id); return success(); } });
    engine.start(); f.failWrite(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toEqual([]); expect(f.tasks[0].nextFireAt).toBe("2026-10-18T10:01:00.000Z");
    expect(vi.getTimerCount()).toBe(0); expect(() => engine.refreshPluginTasks()).not.toThrow(); expect(vi.getTimerCount()).toBe(0);
    f.failWrite(false); engine.start(); expect(vi.getTimerCount()).toBe(1);
    expect(f.tasks[0].nextFireAt).toBe("2026-10-18T11:01:00.000Z");
    await vi.advanceTimersByTimeAsync(3_600_000); expect(ran).toEqual(["a"]); engine.stop();
  });

  it("pauses after a timer config read failure without an unhandled rejection", async () => {
    const f = fixture(), ran: string[] = [];
    const engine = new SchedulerEngine({ store: f.store, runTask: async task => { ran.push(task.id); return success(); } });
    engine.start(); f.failRead(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    expect(() => engine.refreshPluginTasks()).not.toThrow(); engine.stop();
  });

  it("continues other due tasks after one rejected run without replaying its slot", async () => {
    const f = fixture(["a", "b"]), ran: string[] = [];
    const engine = new SchedulerEngine({ store: f.store, runTask: async task => {
      ran.push(task.id); if (task.id === "a") throw Error("synthetic history/cleanup failure"); return success();
    } });
    engine.start(); await vi.advanceTimersByTimeAsync(60_000); await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["a", "b"]); expect(f.tasks.map(t => t.nextFireAt)).toEqual(["2026-10-18T11:01:00.000Z", "2026-10-18T11:01:00.000Z"]);
    expect(vi.getTimerCount()).toBe(1); engine.stop();
  });

  it("contains skipped-history failures after advancing and still runs other due work", async () => {
    const f = fixture(["a", "b"]), ran: string[] = [];
    f.store.recordHistory = () => { throw Error("synthetic history failure"); };
    const engine = new SchedulerEngine({ store: f.store, canRunTask: task => task.id !== "a", runTask: async task => { ran.push(task.id); return success(); } });
    engine.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toEqual(["b"]); expect(f.tasks[0].nextFireAt).toBe("2026-10-18T11:01:00.000Z"); engine.stop();
  });

  it("refresh cannot create timers before start or after stop", () => {
    const f = fixture(), engine = new SchedulerEngine({ store: f.store, runTask: success });
    engine.refreshPluginTasks(); expect(vi.getTimerCount()).toBe(0);
    engine.start(); expect(vi.getTimerCount()).toBe(1);
    engine.stop(); engine.refreshPluginTasks(); for (const listener of f.listeners) listener(); expect(vi.getTimerCount()).toBe(0);
  });

  it("a stop during committed-state notification prevents late dispatch and timer resurrection", async () => {
    const f = fixture(), ran: string[] = [];
    const engine = new SchedulerEngine({ store: f.store, runTask: async task => { ran.push(task.id); return success(); } });
    engine.start(); f.listeners.add(() => engine.stop()); await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a default-Node process alive when an automatic run rejects", () => {
    vi.useRealTimers();
    const bundle = buildSync({ entryPoints: [path.resolve("src/main/scheduler/scheduler-engine.ts")], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;
    const script = `${bundle}\nconst Engine = module.exports.SchedulerEngine;
      const task = {id:'offline',title:'offline',prompt:'offline',enabled:true,schedule:{kind:'interval',every:1,unit:'hours'},nextFireAt:new Date(Date.now()+20).toISOString(),allowedToolIds:[],toolMode:'allow-list'};
      const engine = new Engine({store:{getTasks:()=>[{...task}],updateTask:(_,patch)=>Object.assign(task,patch),recordHistory(){},onChange:()=>()=>{}},runTask:async()=>{throw Error('synthetic failure')}});
      engine.start();setTimeout(()=>engine.stop(),60);`;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    expect(child.status, child.stderr).toBe(0);
  });
});
