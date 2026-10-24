import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSchedulerStore } from "./scheduler-store";
import type { NewScheduledTaskInput } from "./types";

let directory: string, clock: Date;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ff-schedule-store-")); clock = new Date("2026-10-21T06:00:00Z"); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function open(id = () => "garden-id") {
  const store = createSchedulerStore({ tasksFile: join(directory, "tasks.json"), historyFile: join(directory, "history.jsonl"), now: () => clock, id });
  store.load();
  return store;
}
const input = (patch: Partial<NewScheduledTaskInput> = {}): NewScheduledTaskInput => ({
  title: "Garden review", prompt: "Review plants", schedule: { kind: "daily", timeOfDay: "15:30" }, ...patch,
});
it("restores historical Learn mode as Work but refuses newly submitted Learn tasks", () => {
  const legacy = { id: "garden-legacy", ...input(), ownerPluginId: "garden-plugin", mode: "learn", allowedToolIds: [], toolMode: "allow-list" };
  writeFileSync(join(directory, "tasks.json"), JSON.stringify({ tasks: [legacy] }));
  const store = open();
  expect(store.getTasks()[0].mode).toBe("work");
  expect(() => store.addTask(legacy as never)).toThrow("会话模式无效");
  expect(store.getTasks()).toHaveLength(1);
});
it("normalizes text and tool ids and persists the resulting task", () => {
  const store = open();
  const task = store.addTask(input({ title: "  Garden review  ", prompt: "  Review plants  ",
    toolMode: "allow-list", allowedToolIds: ["plant_lookup", "plant_lookup", "rain_check"] }));
  expect(task.title).toBe("Garden review");
  expect(task.prompt).toBe("Review plants");
  expect(task.allowedToolIds).toEqual(["plant_lookup", "rain_check"]);
  expect(task.nextFireAt).toBeTruthy();
  expect(open().getTasks()).toHaveLength(1);
  expect(open().getTasks()[0].title).toBe("Garden review");
});
it("keeps the latest fifty history records per task in descending query order", () => {
  const store = open();
  for (let index = 0; index < 60; index++) store.recordHistory({
    id: `garden-history:${index}`, taskId: "garden-task", taskTitle: "Garden review",
    firedAt: new Date(clock.getTime() + index * 60000).toISOString(), status: "success", effectiveToolIds: [],
  });
  expect(store.getHistory("garden-task", 100)).toHaveLength(50);
  expect(store.getHistory("garden-task", 1)[0].id).toBe("garden-history:59");
});
it("resolves collisions from an id provider without overwriting the first task", () => {
  const store = open(), first = store.addTask(input()), second = store.addTask(input({ title: "Other garden" }));
  expect(first.id).toBe("garden-id");
  expect(second.id).not.toBe("garden-id");
  expect(new Set(store.getTasks().map(task => task.id)).size).toBe(2);
});
it("replaces a running record with its final record sharing the same history id", () => {
  const store = open(), common = { id: "garden-run", taskId: "garden-task", taskTitle: "Garden review",
    firedAt: clock.toISOString(), effectiveToolIds: [] };
  store.recordHistory({ ...common, status: "running" });
  store.recordHistory({ ...common, status: "success", finishedAt: new Date(clock.getTime() + 7000).toISOString(), outputPreview: "Plants reviewed" });
  const history = store.getHistory("garden-task", 10);
  expect(history).toHaveLength(1);
  expect(history[0].status).toBe("success");
});
it("restores missing optional arrays and normalizes plugin host invariants without changing user enablement", () => {
  writeFileSync(join(directory, "tasks.json"), JSON.stringify({ tasks: [
    { id: "garden-plugin-task", ...input(), enabled: true, ownerPluginId: "garden-plugin", toolMode: "all-enabled", pluginUserEnabled: true, approvalFingerprint: "saved-approval" },
    { id: "garden-user-task", ...input(), enabled: true, toolMode: "allow-list" },
  ] }));
  const [plugin, user] = open().getTasks();
  expect(plugin).toMatchObject({ enabled: false, toolMode: "allow-list", pluginUserEnabled: true, approvalFingerprint: "saved-approval" });
  expect(user.enabled).toBe(true);
  expect(user.ownerPluginId).toBeUndefined();
  expect(user.allowedToolIds).toEqual([]);
});
it("forces plugin tasks to remain disabled and allow-listed during creation and hostile patches", () => {
  const store = open();
  const plugin = store.addTask(input({ ownerPluginId: "garden-plugin", enabled: true, toolMode: "all-enabled",
    pluginUserEnabled: false, approvalFingerprint: "", mode: "chat" }));
  expect(plugin).toMatchObject({ enabled: false, toolMode: "allow-list", ownerPluginId: "garden-plugin",
    mode: "chat", pluginUserEnabled: false, approvalFingerprint: "" });
  const updated = store.updateTask(plugin.id, { enabled: true, toolMode: "all-enabled" });
  expect(updated.enabled).toBe(false);
  expect(updated.toolMode).toBe("allow-list");
});
it.each([false, true])("rolls stale hourly schedules forward when plugin=%s tasks are enabled again", plugin => {
  const store = open();
  const created = store.addTask(input({ schedule: { kind: "interval", every: 1, unit: "hours" },
    ...(plugin ? { ownerPluginId: "garden-plugin" } : {}) }));
  expect(created.nextFireAt).toBe("2026-10-21T07:00:00.000Z");
  if (!plugin) store.toggleTask(created.id, false);
  clock = new Date("2026-10-21T10:15:00Z");
  const updated = plugin ? store.updateTask(created.id, { pluginUserEnabled: true, approvalFingerprint: "new-approval" })
    : store.toggleTask(created.id, true);
  expect(updated.nextFireAt).toBe("2026-10-21T11:00:00.000Z");
  if (plugin) {
    expect(updated.pluginUserEnabled).toBe(true);
    expect(updated.approvalFingerprint).toBe("new-approval");
  }
});
it("deletes only the specified owner's tasks and persists the remaining ordered list", () => {
  let sequence = 0;
  const store = open(() => `garden-task:${++sequence}`);
  store.addTask(input({ title: "Personal review" }));
  store.addTask(input({ title: "Rose check", ownerPluginId: "rose-plugin" }));
  store.addTask(input({ title: "Rose watering", ownerPluginId: "rose-plugin" }));
  store.addTask(input({ title: "Lily check", ownerPluginId: "lily-plugin" }));
  expect(store.deleteTasksByOwner("rose-plugin")).toBe(2);
  expect(store.deleteTasksByOwner("rose-plugin")).toBe(0);
  const expected = ["Personal review", "Lily check"];
  expect(store.getTasks().map(task => task.title)).toEqual(expected);
  expect(open().getTasks().map(task => task.title)).toEqual(expected);
});
