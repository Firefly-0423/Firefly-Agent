import { it, expect, describe } from "vitest";
import { normalizeTaskDelegationEvent, applyTaskDelegationEvent } from "./task-delegations";

function dispatch(status: "running" | "completed" | "failed" | "cancelled", invocationId = "delegation-42") {
  return { invocationId, status, taskId: "review-docs", description: "核对文档引用", nickname: "艾利欧", assetFileName: "艾利欧.png" };
}
describe("Delegation activity visible in a chat round", () => {
  it.each(["failed", "cancelled", "completed"] as const)("does not reopen %s activity when a start is replayed", (status) => {
    const settled = applyTaskDelegationEvent([], dispatch(status), "original-turn");
    const replay = applyTaskDelegationEvent(settled, dispatch("running"), "later-turn");
    expect(replay).toStrictEqual(settled);
    const resumed = applyTaskDelegationEvent(replay, dispatch("running", "delegation-43"), "later-turn");
    expect(resumed).toStrictEqual([...settled, { ...dispatch("running", "delegation-43"), roundId: "later-turn" }]);
  });
  it("retains the starting round when settlement arrives in another round", () => {
    const first = applyTaskDelegationEvent([], dispatch("running"), "turn-alpha");
    expect(first).toStrictEqual([{ ...dispatch("running"), roundId: "turn-alpha" }]);
    expect(applyTaskDelegationEvent(first, dispatch("completed"), "turn-beta"))
      .toStrictEqual([{ ...dispatch("completed"), roundId: "turn-alpha" }]);
  });
  it("allows only registered character and asset pairs", () => {
    for (const mismatch of [{ nickname: "不存在的协作者" }, { assetFileName: "知更鸟.png" }, { nickname: "风堇", assetFileName: "风堇.png" }])
      expect(normalizeTaskDelegationEvent({ ...dispatch("running"), ...mismatch })).toEqual(undefined);
    expect(normalizeTaskDelegationEvent(dispatch("running"))).toStrictEqual(dispatch("running"));
    for (const malformed of [null, [], false, { ...dispatch("running"), description: "  " }, { ...dispatch("running"), status: "queued" }])
      expect(normalizeTaskDelegationEvent(malformed)).toEqual(undefined);
  });
});
