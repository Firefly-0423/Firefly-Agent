import { describe, expect, it } from "vitest";
import {
  CHANNEL_CARD_IDS,
  getAppChannelCard,
  pickInitiallyExpandedChannel,
  summarizeChannelOverview,
} from "./view-model";

describe("summarizeChannelOverview", () => {
  it("counts only running channels among the four managed cards", () => {
    expect(summarizeChannelOverview({ wechat: { phase: "running" }, qq: { phase: "running" }, feishu: { phase: "error" } }))
      .toEqual({ running: 2, total: 4 });
  });

  it("reports zero when nothing is reported yet", () => {
    expect(summarizeChannelOverview({})).toEqual({ running: 0, total: CHANNEL_CARD_IDS.length });
  });

  it("ignores statuses that are not managed by this page", () => {
    expect(summarizeChannelOverview({ app: { phase: "running" } } as Record<string, { phase: string }>).running).toBe(0);
  });
});

describe("pickInitiallyExpandedChannel", () => {
  it("expands the first running channel in card order", () => {
    expect(pickInitiallyExpandedChannel({ feishu: { phase: "running" }, qq: { phase: "running" } })).toBe("feishu");
  });

  it("expands a channel that is still starting, such as a pairing in progress", () => {
    expect(pickInitiallyExpandedChannel({ wechat: { phase: "offline" }, feishu: { phase: "starting" } })).toBe("feishu");
    expect(pickInitiallyExpandedChannel({ qqbot: { phase: "starting" } })).toBe("qqbot");
  });

  it("keeps every card collapsed when nothing is connected or pairing", () => {
    expect(pickInitiallyExpandedChannel({ wechat: { phase: "offline" }, qq: { phase: "error" } })).toBeNull();
    expect(pickInitiallyExpandedChannel({})).toBeNull();
  });
});

describe("getAppChannelCard", () => {
  it("is coming-soon with pairing disabled", () => {
    expect(getAppChannelCard()).toEqual({
      status: "coming-soon",
      statusKey: "settings.panel.channels.appStatusComingSoon",
      pairDisabled: true,
    });
  });

  it("stays coming-soon even when a future pairing state is supplied", () => {
    expect(getAppChannelCard({ paired: true, online: true }).status).toBe("coming-soon");
    expect(getAppChannelCard({ paired: true }).pairDisabled).toBe(true);
  });
});
