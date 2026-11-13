import { describe, it, expect, vi } from "vitest";
import { routeProactiveDelivery } from "./proactive-delivery-routing";
import type { ProactiveCommitResult } from "./proactive-service";

describe("destination dispatch", () => {
  it.each(["local", "feishu", "wechat"] as const)("delegates exactly once to the handler for %s", async (destination) => {
    const receipt: ProactiveCommitResult = { kind: "committed" };
    const handlers = {
      commitChannel: vi.fn(async () => receipt),
      commitLocal: vi.fn(async () => receipt),
    };
    const received = await routeProactiveDelivery(destination, handlers);
    expect(received).toEqual({ kind: "committed" });
    expect(received).toBe(receipt);
    expect(handlers.commitLocal.mock.calls).toEqual(destination === "local" ? [[]] : []);
    expect(handlers.commitChannel.mock.calls).toEqual(destination === "local" ? [] : [[destination]]);
  });

  it("returns the cancellation reason without attempting a local rescue", async () => {
    const receipt: ProactiveCommitResult = { kind: "cancelled", reason: "channel_offline" };
    const local = vi.fn();
    const channel = vi.fn(async () => receipt);
    await expect(routeProactiveDelivery("wechat", { commitLocal: local, commitChannel: channel }))
      .resolves.toEqual({ reason: "channel_offline", kind: "cancelled" });
    expect(channel.mock.calls).toEqual([["wechat"]]);
    expect(local.mock.calls).toEqual([]);
  });
});
