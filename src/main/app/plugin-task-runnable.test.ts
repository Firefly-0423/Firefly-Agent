import { describe, expect, it } from "vitest";
import { isPluginTaskRunnable } from "./plugin-task-runnable";
import type { ScheduledTask } from "../platform/schedule/schedule-types";

const task = (ownerPluginId?: string) => ({ id: "t", ...(ownerPluginId ? { ownerPluginId } : {}) }) as ScheduledTask;
const legacy = (running: boolean) => ({ isRunning: () => running });
const v2 = (status: string) => ({ status: () => status });

describe("isPluginTaskRunnable", () => {
  it.each([
    ["user task", undefined, undefined, undefined, true],
    ["legacy plugin running", "p", legacy(true), v2("disabled"), true],
    ["v2 plugin enabled", "p", legacy(false), v2("enabled"), true],
    ["v2 plugin enabled without a legacy host", "p", undefined, v2("enabled"), true],
    ["v2 plugin restarting", "p", legacy(false), v2("restarting"), false],
    ["v2 plugin disabled-fault", "p", legacy(false), v2("disabled-fault"), false],
    ["no host running it", "p", undefined, undefined, false],
  ])("%s -> %s", (_n, owner, l, v, expected) => {
    expect(isPluginTaskRunnable(task(owner), l, v)).toBe(expected);
  });
});
