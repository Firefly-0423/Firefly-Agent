import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchedulerStore } from "./scheduler-store";
import { SchedulerEngine } from "./scheduler-engine";
import type { ScheduledTaskHistoryEntry } from "./types";

vi.mock("electron", () => ({ app: { getPath: () => { throw Error("synthetic paths must be explicit"); } } }));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-scheduler-recovery-")); roots.push(root);
  const deps = { tasksFile: path.join(root, "tasks.json"), historyFile: path.join(root, "history.jsonl"),
    now: () => new Date("2026-10-19T10:00:00Z"), id: () => "synthetic-task" };
  return { root, deps, store: createSchedulerStore(deps) };
}
function entry(patch: Partial<ScheduledTaskHistoryEntry> = {}): ScheduledTaskHistoryEntry {
  return { id: "synthetic-run", taskId: "synthetic-task", taskTitle: "synthetic", firedAt: "2026-10-18T10:00:00Z",
    status: "running", outputPreview: "partial synthetic output", effectiveToolIds: [], ...patch };
}
function seed(file: string, entries: ScheduledTaskHistoryEntry[]) {
  fs.writeFileSync(file, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
}

describe("scheduler history host recovery", () => {
  it.each(["timer", "plugin-refresh", "store-change"] as const)("preserves an unclaimed slot after live history reload failure via %s", async trigger => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const f = fixture(); f.store.load();
    const task = f.store.addTask({ title: "synthetic", prompt: "synthetic", schedule: { kind: "once", runAt: "2026-10-19T11:00:00Z" } });
    const runTask = vi.fn(async () => ({ ok: true, historyId: "unexpected", effectiveToolIds: [] }));
    const engine = new SchedulerEngine({ store: f.store, runTask }); engine.start();
    try {
      fs.writeFileSync(f.deps.historyFile, "PRIVATE_HISTORY\n"); f.store.load();
      if (trigger === "timer") await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      else {
        vi.setSystemTime(new Date("2026-10-19T11:00:00Z"));
        if (trigger === "plugin-refresh") engine.refreshPluginTasks();
        else f.store.updateTask(task.id, { title: "synthetic edited" });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(runTask).not.toHaveBeenCalled();
      expect(f.store.getTasks()[0]).toMatchObject({ enabled: true, nextFireAt: task.nextFireAt, lastFiredAt: undefined });
      expect(vi.getTimerCount()).toBe(0);
      expect(fs.readFileSync(f.deps.historyFile, "utf8")).toBe("PRIVATE_HISTORY\n");
    } finally { engine.stop(); }
  });
  it("keeps task-only reads independent of opaque history while refusing scheduler execution readiness", async () => {
    const f = fixture(); fs.writeFileSync(f.deps.historyFile, "PRIVATE_HISTORY\n"); f.store.load();
    expect(f.store.getTasks()).toEqual([]);
    const task = f.store.addTask({ title: "synthetic", prompt: "synthetic", schedule: { kind: "once", runAt: "2026-10-19T11:00:00Z" } });
    const runTask = vi.fn(async () => ({ ok: true, historyId: "unexpected", effectiveToolIds: [] }));
    const engine = new SchedulerEngine({ store: f.store, runTask });
    expect(() => engine.start()).toThrow("SCHEDULER_HISTORY_UNAVAILABLE");
    await expect(engine.fireNow(task.id)).rejects.toThrow("SCHEDULER_HISTORY_UNAVAILABLE");
    expect(runTask).not.toHaveBeenCalled();
    expect(() => f.store.getHistory("synthetic-task")).toThrow("SCHEDULER_HISTORY_UNAVAILABLE");
  });
  it("marks legacy running history interrupted with unknown effects and preserves its original identity/output", () => {
    const f = fixture(); seed(f.deps.historyFile, [entry()]); f.store.load();
    expect(f.store.getHistory("synthetic-task")).toEqual([expect.objectContaining({
      id: "synthetic-run", status: "interrupted", executionOutcome: "unknown", externalEffectsMayContinue: true,
      outputPreview: "partial synthetic output", recoveredAt: "2026-10-19T10:00:00.000Z",
    })]);
    const bytes = fs.readFileSync(f.deps.historyFile, "utf8"); f.store.load();
    expect(fs.readFileSync(f.deps.historyFile, "utf8")).toBe(bytes);
    expect(createSchedulerStore(f.deps).getHistory("synthetic-task")[0].status).toBe("interrupted");
  });
  it("does not interrupt current process runs on reload or when another store opens the same history", () => {
    const f = fixture(); f.store.load(); f.store.recordHistory(entry()); f.store.load();
    const other = createSchedulerStore(f.deps); other.load();
    expect(other.getHistory("synthetic-task")[0].status).toBe("running");
    expect(f.store.getHistory("synthetic-task")[0].status).toBe("running");
    f.store.recordHistory(entry({ status: "success" })); other.load();
    expect(other.getHistory("synthetic-task")[0].status).toBe("success");
  });
  it.each(["success", "failed", "skipped"] as const)("never rewrites a settled %s record", status => {
    const f = fixture(); seed(f.deps.historyFile, [entry({ status })]);
    const bytes = fs.readFileSync(f.deps.historyFile, "utf8"); f.store.load();
    expect(fs.readFileSync(f.deps.historyFile, "utf8")).toBe(bytes);
  });
  it("preserves every settled row while recovering multiple runs in one atomic write", () => {
    const f = fixture(), settled = entry({ id: "completed", status: "success", finishedAt: "2026-10-18T10:01:00Z" });
    seed(f.deps.historyFile, [entry(), settled, entry({ id: "other-run", taskId: "deleted-task" })]);
    f.store.load();
    expect(f.store.getHistory("synthetic-task")).toContainEqual(settled);
    expect(f.store.getHistory("deleted-task")[0]).toMatchObject({ id: "other-run", status: "interrupted" });
  });
  it.each(["partial-write", "rename"] as const)("preserves disk and prevents readiness after recovery %s failure until load succeeds", failure => {
    const f = fixture(); seed(f.deps.historyFile, [entry()]);
    const bytes = fs.readFileSync(f.deps.historyFile, "utf8"), write = fs.writeFileSync.bind(fs), rename = fs.renameSync.bind(fs);
    if (failure === "partial-write") vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (path.basename(String(file)).includes("history.jsonl") && String(file).endsWith(".tmp")) {
        write(file, "{partial", options); throw Error("synthetic full disk");
      }
      return write(file, data, options);
    });
    else vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === f.deps.historyFile) throw Error("synthetic rename denied");
      return rename(from, to);
    });
    f.store.load();
    const engine = new SchedulerEngine({ store: f.store, runTask: async () => { throw Error("execution forbidden"); } });
    expect(() => engine.start()).toThrow("SCHEDULER_HISTORY_RECOVERY_FAILED");
    expect(() => f.store.getHistory("synthetic-task")).toThrow("SCHEDULER_HISTORY_RECOVERY_FAILED");
    expect(fs.readFileSync(f.deps.historyFile, "utf8")).toBe(bytes);
    expect(fs.readdirSync(f.root).some(name => name.endsWith(".tmp"))).toBe(false);
    vi.restoreAllMocks(); f.store.load();
    expect(f.store.getHistory("synthetic-task")[0].status).toBe("interrupted");
  });
  it("refuses to hide corrupt history behind a ready scheduler or overwrite its bytes", () => {
    const f = fixture(); fs.writeFileSync(f.deps.historyFile, '{"id":'); f.store.load();
    const engine = new SchedulerEngine({ store: f.store, runTask: async () => { throw Error("execution forbidden"); } });
    expect(() => engine.start()).toThrow("SCHEDULER_HISTORY_UNAVAILABLE");
    expect(fs.readFileSync(f.deps.historyFile, "utf8")).toBe('{"id":');
  });
  it("converges a real child crash after durable running, reopening twice without replaying or changing settled runs", async () => {
    const f = fixture();
    const bundle = (await build({ stdin: { contents: `
      import { createSchedulerStore } from './src/main/scheduler/scheduler-store';
      import { SchedulerEngine } from './src/main/scheduler/scheduler-engine';
      const root = process.argv[2], mode = process.argv[3];
      const store = createSchedulerStore({ tasksFile: root+'/tasks.json', historyFile: root+'/history.jsonl', now:()=>new Date(), id:()=> 'synthetic-task' });
      store.load();
      if (mode === 'crash') {
        const task = store.addTask({title:'synthetic',prompt:'no Agent/tools',schedule:{kind:'once',runAt:new Date(Date.now()+100).toISOString()}});
        store.recordHistory({id:'settled-run',taskId:task.id,taskTitle:task.title,firedAt:new Date().toISOString(),status:'success',effectiveToolIds:[]});
        const engine = new SchedulerEngine({store,runTask:async task=>{
          store.recordHistory({id:'crashed-run',taskId:task.id,taskTitle:task.title,firedAt:new Date().toISOString(),status:'running',outputPreview:'synthetic partial',effectiveToolIds:[]});
          process.exit(23);
        }}); engine.start();
      } else {
        let runs = 0;
        const engine = new SchedulerEngine({store,runTask:async()=>{runs++;return {ok:true,historyId:'unexpected',effectiveToolIds:[]}}});
        engine.start();setTimeout(()=>{engine.stop();console.log(JSON.stringify({runs,history:store.getHistory('synthetic-task'),tasks:store.getTasks()}));},20);
      }`, resolveDir: process.cwd(), sourcefile: "synthetic-scheduler-crash.ts", loader: "ts" },
      bundle: true, platform: "node", format: "cjs", write: false,
      plugins: [{ name: "synthetic-electron", setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "synthetic" }));
        build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: "exports.app={getPath(){throw Error('private data forbidden')}}" }));
      } }],
    })).outputFiles[0].text;
    const script = path.join(f.root, "child.cjs"); fs.writeFileSync(script, bundle);
    const crash = spawnSync(process.execPath, [script, f.root, "crash"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    expect(crash.status, crash.stderr).toBe(23);
    const crashedRows = fs.readFileSync(f.deps.historyFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(crashedRows.find(row => row.id === "crashed-run").status).toBe("running");
    const settled = crashedRows.find(row => row.id === "settled-run");
    let recoveredBytes: string | undefined;
    for (let reopen = 0; reopen < 2; reopen++) {
      const child = spawnSync(process.execPath, [script, f.root, "reopen"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      expect(child.status, child.stderr).toBe(0);
      const observed = JSON.parse(child.stdout);
      expect(observed.runs).toBe(0);
      expect(observed.tasks[0]).toMatchObject({ enabled: false, nextFireAt: null });
      expect(observed.history.find((row: ScheduledTaskHistoryEntry) => row.id === "crashed-run")).toMatchObject({
        status: "interrupted", executionOutcome: "unknown", externalEffectsMayContinue: true, outputPreview: "synthetic partial",
      });
      expect(observed.history.find((row: ScheduledTaskHistoryEntry) => row.id === "settled-run")).toEqual(settled);
      const bytes = fs.readFileSync(f.deps.historyFile, "utf8");
      if (recoveredBytes) expect(bytes).toBe(recoveredBytes); recoveredBytes = bytes;
    }
  });
});
