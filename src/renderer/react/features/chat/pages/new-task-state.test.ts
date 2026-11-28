import { expect, it } from "vitest";
import { inheritedTaskWorkspace, withoutKey } from "./new-task-state";

it("prefers an explicit folder, then the current binding, then the pending choice", () => {
  const pending = { path: "pending" };
  const binding = { workspaceRoot: "current", displayName: "Current" };
  expect(inheritedTaskWorkspace({ path: "chosen", displayName: "Chosen" }, binding, pending)).toEqual({ path: "chosen", displayName: "Chosen" });
  expect(inheritedTaskWorkspace(undefined, binding, pending)).toEqual({ path: "current", displayName: "Current" });
  expect(inheritedTaskWorkspace(undefined, undefined, pending)).toBe(pending);
});

it("removes only the requested key from a fresh state object", () => {
  const state = { chat: "a", work: "b" };
  const result = withoutKey(state, "chat");
  expect(result).toEqual({ work: "b" });
  expect(state.chat).toBe("a");
  expect(result).not.toBe(state);
});
