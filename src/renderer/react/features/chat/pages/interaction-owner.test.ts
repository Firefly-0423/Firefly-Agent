import { describe, expect, it } from "vitest";
import { interactionOwner } from "./interaction-owner";

const runs = { a: { runId: "run-a" }, b: { runId: "run-b" }, idle: {} };

describe("interaction owner (ChatPage G1)", () => {
  it.each([
    { name: "a known background run goes to its owner, not the visible session", runId: "run-b", visible: "a", owner: "b" },
    { name: "a known run goes to its owner when no session is visible", runId: "run-b", visible: undefined, owner: "b" },
    { name: "a known run owned by the visible session stays there", runId: "run-a", visible: "a", owner: "a" },
    { name: "an unknown run is not routed to the visible session", runId: "run-gone", visible: "a", owner: undefined },
    { name: "an unknown run has no owner when no session is visible", runId: "run-gone", visible: undefined, owner: undefined },
  ])("$name", ({ runId, visible, owner }) => {
    expect(interactionOwner(runs, runId, visible)).toBe(owner);
  });

  // 无 run ID 的请求在 G1 保持原样（回退可见会话），G3 再按负责人决定改走独立提醒。
  it("keeps the current fallback for a request without a run id", () => {
    expect(interactionOwner(runs, undefined, "a")).toBe("a");
    expect(interactionOwner(runs, undefined, undefined)).toBeUndefined();
  });
});
