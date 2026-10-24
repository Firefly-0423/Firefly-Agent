import { expect, it } from "vitest";
import { isProactiveDeliveryTargetSelectable as selectable } from "../shared/proactive-delivery";

it("offers local delivery independently of status and remote delivery only when running", () => {
  const statuses = [undefined, { phase: "error" }, { phase: "offline" }, { phase: "running" }];
  expect(statuses.map(status => selectable("local", status))).toEqual([true, true, true, true]);
  for (const target of ["wechat", "feishu"] as const) {
    expect(statuses.map(status => selectable(target, status))).toEqual([false, false, false, true]);
  }
});
