import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchedulerStore } from "./scheduler-store";

// Forward builtin namespace writes to the same native object as AtomicJsonStore.
vi.mock("fs", async (original) => {
  const module = await original<typeof import("node:fs")>();
  return { ...module,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => module.default.writeFileSync(...args),
    renameSync: (...args: Parameters<typeof fs.renameSync>) => module.default.renameSync(...args),
  };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-scheduler-persistence-")); roots.push(root);
  const tasksFile = path.join(root, "tasks.json"), historyFile = path.join(root, "history.jsonl");
  const deps = { tasksFile, historyFile, now: () => new Date("2026-10-18T10:00:00Z"), id: (() => { let id = 0; return () => `task-${++id}`; })() };
  const store = createSchedulerStore(deps); store.load();
  store.addTask({ title: "user", prompt: "offline", schedule: { kind: "daily", timeOfDay: "12:00" } });
  store.addTask({ title: "plugin", prompt: "offline", schedule: { kind: "daily", timeOfDay: "12:00" }, ownerPluginId: "plugin-a" });
  return { store, deps, root, tasksFile, historyFile };
}
const actions = {
  add: (store: ReturnType<typeof createSchedulerStore>) => store.addTask({ title: "new", prompt: "offline", schedule: { kind: "daily", timeOfDay: "13:00" } }),
  update: (store: ReturnType<typeof createSchedulerStore>) => store.updateTask("task-1", { title: "uncommitted" }),
  toggle: (store: ReturnType<typeof createSchedulerStore>) => store.toggleTask("task-1", false),
  delete: (store: ReturnType<typeof createSchedulerStore>) => store.deleteTask("task-1"),
  ownerDelete: (store: ReturnType<typeof createSchedulerStore>) => store.deleteTasksByOwner("plugin-a"),
};
function failWrite(root: string, name: string, failure: "partial-write" | "rename") {
  const write = fs.writeFileSync.bind(fs), rename = fs.renameSync.bind(fs);
  if (failure === "partial-write") vi.spyOn(fs, "writeFileSync").mockImplementation((file, _data, options) => {
    if (path.dirname(String(file)) === root && path.basename(String(file)).includes(name)) {
      write(file, "{partial", options);
      throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
    }
    write(file, _data, options);
  });
  else vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(root, name)) throw Object.assign(new Error("synthetic replace denied"), { code: "EACCES" });
    rename(from, to);
  });
}

describe("scheduler failure-atomic persistence", () => {
  for (const [name, action] of Object.entries(actions)) {
    it.each(["partial-write", "rename"] as const)(`${name} preserves committed state and notifications after %s failure`, (failure) => {
      const { store, deps, root, tasksFile } = fixture(), before = store.getTasks(), bytes = fs.readFileSync(tasksFile, "utf8");
      let notifications = 0; store.onChange(() => notifications++); failWrite(root, "tasks.json", failure);
      expect(() => action(store)).toThrow();
      expect(fs.readFileSync(tasksFile, "utf8")).toBe(bytes);
      expect(store.getTasks()).toEqual(before);
      expect(notifications).toBe(0);
      vi.restoreAllMocks();
      const reopened = createSchedulerStore(deps); reopened.load(); expect(reopened.getTasks()).toEqual(before);
      action(store); expect(notifications).toBe(1);
    });
  }

  it.each(["{broken", '{"tasks":null}'])("blocks reads and every mutation after an invalid load (%s), until a successful reload", (bytes) => {
    const { store, tasksFile } = fixture(); fs.writeFileSync(tasksFile, bytes);
    expect(() => store.load()).not.toThrow();
    expect(() => store.getTasks()).toThrow();
    for (const action of Object.values(actions)) expect(() => action(store)).toThrow();
    expect(fs.readFileSync(tasksFile, "utf8")).toBe(bytes);
    fs.writeFileSync(tasksFile, '{"tasks":[]}'); store.load(); expect(store.getTasks()).toEqual([]);
  });

  it("keeps schedule and array references outside the committed snapshot", () => {
    const { store } = fixture();
    const schedule = { kind: "daily" as const, timeOfDay: "15:00" };
    const added = store.addTask({ title: "copy", prompt: "offline", schedule, allowedToolIds: ["a"] });
    schedule.timeOfDay = "16:00";
    if (added.schedule.kind === "daily") added.schedule.timeOfDay = "17:00";
    const listed = store.getTasks().find(t => t.id === added.id)!;
    if (listed.schedule.kind === "daily") listed.schedule.timeOfDay = "18:00";
    listed.allowedToolIds.push("b");
    expect(store.getTasks().find(t => t.id === added.id)).toMatchObject({ schedule: { kind: "daily", timeOfDay: "15:00" }, allowedToolIds: ["a"] });
  });

  it.each(["partial-write", "rename"] as const)("preserves committed JSONL after %s failure", (failure) => {
    const { store, root, historyFile } = fixture();
    const entry = { id: "h", taskId: "task-1", taskTitle: "user", firedAt: "2026-10-18T10:00:00Z", status: "running" as const, effectiveToolIds: [] };
    store.recordHistory(entry); const bytes = fs.readFileSync(historyFile, "utf8");
    failWrite(root, "history.jsonl", failure);
    expect(() => store.recordHistory({ ...entry, status: "success" })).toThrow();
    expect(fs.readFileSync(historyFile, "utf8")).toBe(bytes);
    vi.restoreAllMocks(); expect(store.getHistory("task-1")[0].status).toBe("running");
    store.recordHistory({ ...entry, status: "failed" }); expect(store.getHistory("task-1")).toHaveLength(1);
  });

  it("refuses to replace corrupt history with an apparently empty history", () => {
    const { store, historyFile } = fixture(); fs.writeFileSync(historyFile, '{"id":');
    expect(() => store.getHistory("task-1")).toThrow();
    expect(() => store.recordHistory({ id: "h", taskId: "task-1", taskTitle: "user", firedAt: "2026-10-18T10:00:00Z", status: "failed", effectiveToolIds: [] })).toThrow();
    expect(fs.readFileSync(historyFile, "utf8")).toBe('{"id":');
  });
});
