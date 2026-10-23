import { describe, expect, it, vi } from "vitest";
import { PendingSenderRegistry } from "./sender-gate";
import { resolvePendingSender, withPendingSenders } from "./sender-approval";
import type { ChannelsSettings } from "./settings-store";

function setup(allowed: string[] = []) {
  const registry = new PendingSenderRegistry();
  const save = vi.fn();
  const load = () => ({
    wechat: { allowedSenderIds: allowed },
    feishu: { allowedSenderIds: [] },
  }) as unknown as ChannelsSettings;
  return { registry, save, deps: { registry, load, save } };
}

describe("resolvePendingSender", () => {
  it("approves a pending sender into the allowlist and clears it", () => {
    const { registry, save, deps } = setup(["old@im.wechat"]);
    registry.record("wechat", "new@im.wechat", "新朋友");
    expect(resolvePendingSender({ channel: "wechat", senderId: "new@im.wechat", action: "approve" }, deps))
      .toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith({ wechat: { allowedSenderIds: ["old@im.wechat", "new@im.wechat"] } });
    expect(registry.list("wechat")).toEqual([]);
  });

  it("dismisses without touching the allowlist", () => {
    const { registry, save, deps } = setup();
    registry.record("feishu", "ou_x");
    expect(resolvePendingSender({ channel: "feishu", senderId: "ou_x", action: "dismiss" }, deps)).toEqual({ ok: true });
    expect(save).not.toHaveBeenCalled();
    expect(registry.list("feishu")).toEqual([]);
  });

  it("refuses senders that never asked, unknown channels and bad payloads", () => {
    const { save, deps } = setup();
    expect(resolvePendingSender({ channel: "wechat", senderId: "ghost@im.wechat", action: "approve" }, deps).ok).toBe(false);
    expect(resolvePendingSender({ channel: "qq", senderId: "1", action: "approve" }, deps).ok).toBe(false);
    expect(resolvePendingSender({ channel: "wechat", senderId: "bad id", action: "approve" }, deps).ok).toBe(false);
    expect(resolvePendingSender({ channel: "wechat", senderId: "a@im.wechat", action: "grant" }, deps).ok).toBe(false);
    expect(resolvePendingSender(null, deps).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("withPendingSenders", () => {
  it("adds the pending list to wechat and feishu status only", () => {
    const registry = new PendingSenderRegistry();
    registry.record("wechat", "a@im.wechat", "A", 5);
    const status = withPendingSenders({
      wechat: { enabled: true, phase: "running", detail: { account: "x" } },
      qq: { enabled: true, phase: "running" },
    }, registry);
    expect(status.wechat.detail).toEqual({
      account: "x",
      pendingSenders: [{ senderId: "a@im.wechat", senderName: "A", at: 5 }],
    });
    expect(status.qq.detail).toBeUndefined();
  });
});
