import { describe, expect, it } from "vitest";
import {
  normalizeChatSocialContextEnabled,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedChatEnabled,
} from "./preferences";

describe("normalizeChatSocialContextEnabled", () => {
  it("only accepts an explicit boolean true", () => {
    expect(normalizeChatSocialContextEnabled(true)).toBe(true);
    expect(normalizeChatSocialContextEnabled(false)).toBe(false);
  });

  it.each([undefined, null, 1, 0, "true", "1", {}, []])("defaults %j to disabled", (value) => {
    expect(normalizeChatSocialContextEnabled(value)).toBe(false);
  });
});

describe("normalizeSegmentedChatEnabled", () => {
  it("is off only when explicitly turned off", () => {
    expect(normalizeSegmentedChatEnabled(false)).toBe(false);
    expect(normalizeSegmentedChatEnabled(true)).toBe(true);
  });

  it.each([undefined, null, "", "off", 0, {}])("defaults %j to on", (value) => {
    expect(normalizeSegmentedChatEnabled(value)).toBe(true);
  });
});

describe("normalizeProactiveChatMode", () => {
  it("keeps on and off", () => {
    expect(normalizeProactiveChatMode("on")).toBe("on");
    expect(normalizeProactiveChatMode("off")).toBe("off");
  });

  it.each([undefined, null, "", "ON", "true", true, 1, {}, []])("defaults %j to off", (value) => {
    expect(normalizeProactiveChatMode(value)).toBe("off");
  });
});

describe("normalizeProactiveDeliveryTarget", () => {
  it("keeps all supported delivery targets", () => {
    expect(normalizeProactiveDeliveryTarget("local")).toBe("local");
    expect(normalizeProactiveDeliveryTarget("wechat")).toBe("wechat");
    expect(normalizeProactiveDeliveryTarget("feishu")).toBe("feishu");
  });

  it.each([undefined, null, "", "WeChat", "telegram", 0, {}, []])("defaults %j to local", (value) => {
    expect(normalizeProactiveDeliveryTarget(value)).toBe("local");
  });
});
