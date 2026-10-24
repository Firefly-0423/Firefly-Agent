import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { createSchedulerStore } from "./scheduler-store";
import { createSchedulerSubsystem } from "./bootstrap";

vi.mock("electron", () => ({ app: { getPath: () => { throw Error("real profile forbidden"); } }, ipcMain: {} }));
vi.mock("../orchestrator/firefly-agent", () => ({ FireflyAgent: class {} }));
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [] } }));

it("initializes core IPC with corrupt tasks and reports list/history failures without overwriting files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-scheduler-ipc-"));
  try {
    const tasksFile = path.join(root, "tasks.json"), historyFile = path.join(root, "history.jsonl");
    fs.writeFileSync(tasksFile, "{bad tasks"); fs.writeFileSync(historyFile, "{bad history");
    const store = createSchedulerStore({ tasksFile, historyFile, now: () => new Date(), id: () => "synthetic" });
    const handlers = new Map<string, (...args: any[]) => any>();
    const subsystem = createSchedulerSubsystem({ store, agentRuntime: {} as never, getReactChatWindow: () => null,
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler() {}, on() {}, dispose() {} } });
    expect(() => subsystem.initialize()).not.toThrow();
    expect(handlers.get(IPC.SCHEDULER_LIST)!()).toMatchObject({ ok: false, error: "SCHEDULER_TASKS_UNAVAILABLE" });
    expect(handlers.get(IPC.SCHEDULER_GET_HISTORY)!(null, "synthetic")).toMatchObject({ ok: false, error: "SCHEDULER_HISTORY_UNAVAILABLE" });
    expect(await handlers.get(IPC.SCHEDULER_FIRE_NOW)!(null, "synthetic")).toMatchObject({ ok: false });
    expect(fs.readFileSync(tasksFile, "utf8")).toBe("{bad tasks");
    expect(fs.readFileSync(historyFile, "utf8")).toBe("{bad history");
    await subsystem.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
