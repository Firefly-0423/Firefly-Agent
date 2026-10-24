import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../logging/logger", () => ({
  logger: { info: (...args: unknown[]) => { calls.push(["log", ...args]); } },
  LogTag: { Firefly: "firefly" },
}));
vi.mock("./permission", () => ({
  initPermissionFromDisk: () => { calls.push(["init"]); },
  registerPermissionIpc: (scope: unknown) => { calls.push(["permission-ipc", scope]); },
  getCurrentLevel: () => "scoped",
}));
vi.mock("../chat/user-choice", () => ({
  registerChoiceIpc: (scope: unknown) => { calls.push(["choice-ipc", scope]); },
}));

import { bootstrapPermission } from "./bootstrap";

beforeEach(() => { calls.length = 0; });

it("loads the saved level first, then registers both IPC groups on the shared scope, then logs the level", () => {
  const scope = { marker: "shared-scope" } as never;
  bootstrapPermission(scope);
  expect(calls).toEqual([
    ["init"],
    ["permission-ipc", scope],
    ["choice-ipc", scope],
    ["log", "firefly", "当前 agent 权限档位:", "scoped"],
  ]);
});

it("passes undefined through when no scope is given", () => {
  bootstrapPermission();
  expect(calls[1]).toEqual(["permission-ipc", undefined]);
  expect(calls[2]).toEqual(["choice-ipc", undefined]);
});
