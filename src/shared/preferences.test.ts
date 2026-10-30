import { describe, expect, it } from "vitest";
import {
  normalizeChatSocialContextEnabled,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  normalizeSegmentedOutputMode,
} from "./preferences";

describe("normalizeChatSocialContextEnabled", () => {
  it("is off only when the user turned it off", () => {
    expect(normalizeChatSocialContextEnabled(true)).toBe(true);
    expect(normalizeChatSocialContextEnabled(false)).toBe(false);
  });

  it.each([undefined, null, 1, 0, "true", "false", {}, []])("reads %j as the default, on", (value) => {
    expect(normalizeChatSocialContextEnabled(value)).toBe(true);
  });
});

describe("normalizeSegmentedOutputMode", () => {
  it("keeps the supported modes", () => {
    expect(normalizeSegmentedOutputMode("all")).toBe("all");
    expect(normalizeSegmentedOutputMode("chat")).toBe("chat");
    expect(normalizeSegmentedOutputMode("off")).toBe("off");
  });

  it.each([undefined, null, "", "ALL", "Chat", "on", 0, {}, []])("defaults %j to off", (value) => {
    expect(normalizeSegmentedOutputMode(value)).toBe("off");
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
