import { it, expect, describe } from "vitest";
import { normalizeChatSocialContextEnabled as social, normalizeProactiveChatMode as proactive,
  normalizeProactiveDeliveryTarget as delivery, normalizeSegmentedChatEnabled as segments } from "../shared/preferences";

describe("values accepted from persisted preferences", () => {
  it("requires an actual opt-in boolean", () => {
    expect([true, false, undefined, "true", 1, null].map(social)).toEqual([true, false, false, false, false, false]);
  });
  it("keeps segmented chat on unless turned off, and recognizes each proactive mode", () => {
    expect([false, true, undefined, "off"].map(segments)).toEqual([false, true, true, true]);
    expect(["off", "on", undefined, "invalid-mode"].map(proactive)).toEqual(["off", "on", "off", "off"]);
  });
  it("keeps the two remote destinations and defaults all other values to local", () => {
    expect(["feishu", "wechat", "local", undefined, "", "unregistered"].map(delivery))
      .toEqual(["feishu", "wechat", "local", "local", "local", "local"]);
  });
});
