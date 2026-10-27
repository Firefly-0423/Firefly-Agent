import { it, expect, describe } from "vitest";
import { normalizeChatSocialContextEnabled as social, normalizeProactiveChatMode as proactive,
  normalizeProactiveDeliveryTarget as delivery, normalizeSegmentedOutputMode as segments } from "../shared/preferences";

describe("values accepted from persisted preferences", () => {
  it("keeps context enhancement on unless the user turned it off", () => {
    expect([true, false, undefined, "true", 1, null].map(social)).toEqual([true, false, true, true, true, true]);
  });
  it("recognizes each output mode and falls back for corrupt settings", () => {
    expect(["off", "chat", "all", undefined, "invalid-mode"].map(segments)).toEqual(["off", "chat", "all", "off", "off"]);
    expect(["off", "on", undefined, "invalid-mode"].map(proactive)).toEqual(["off", "on", "off", "off"]);
  });
  it("keeps the two remote destinations and defaults all other values to local", () => {
    expect(["feishu", "wechat", "local", undefined, "", "unregistered"].map(delivery))
      .toEqual(["feishu", "wechat", "local", "local", "local", "local"]);
  });
});
