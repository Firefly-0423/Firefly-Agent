import { describe, expect, it } from "vitest";
import { buildMixRounds, fourTierMix } from "./four-tier-mix";

const TIERS = ["high", "mid-high", "mid", "low"];

describe("buildMixRounds", () => {
  it("builds the requested number of indexed rounds", () => {
    const rounds = buildMixRounds(100, 42);
    expect(rounds).toHaveLength(100);
    expect(rounds.map((round) => round.index)).toEqual(
      Array.from({ length: 100 }, (_value, index) => index),
    );
    expect(rounds.some((round) => round.note === "silence")).toBe(true);
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(buildMixRounds(100, 42)).toEqual(buildMixRounds(100, 42));
    expect(buildMixRounds(100, 7)).not.toEqual(buildMixRounds(100, 42));
  });

  it("returns no rounds for zero or negative totals", () => {
    expect(buildMixRounds(0, 42)).toEqual([]);
    expect(buildMixRounds(-3, 42)).toEqual([]);
  });

  it("never emits silence on the first round even when the roll says silence", () => {
    // seed 1972 produces a first LCG value below the 0.15 silence threshold.
    const rounds = buildMixRounds(2, 1972);
    expect(rounds[0].note).not.toBe("silence");
    expect(rounds[0].userText).not.toBe("嗯");
  });

  it("keeps silence rounds empty and non-silence rounds on a tier keyword", () => {
    const rounds = buildMixRounds(100, 42);
    for (const round of rounds) {
      if (round.note === "silence") {
        expect(round.userText).toBe("嗯");
        expect(round.modelText).toBe("");
        continue;
      }
      const match = /^tier=(high|mid-high|mid|low) kw=(.+)$/.exec(round.note ?? "");
      expect(match, round.note).not.toBeNull();
      expect(TIERS).toContain(match![1]);
      expect(round.userText).toBe(`聊${match![2]}`);
    }
  });

  it("only echoes keywords mentioned within the previous eight non-silence rounds", () => {
    const rounds = buildMixRounds(100, 42);
    const recent: string[] = [];
    let echoes = 0;
    for (const round of rounds) {
      if (round.note === "silence") continue;
      if (round.modelText) {
        const match = /^对，(.+)，我同意。$/.exec(round.modelText);
        expect(match, round.modelText).not.toBeNull();
        expect(recent.slice(-8)).toContain(match![1]);
        echoes += 1;
      }
      const keyword = / kw=(.+)$/.exec(round.note ?? "")?.[1];
      expect(keyword).toBeDefined();
      recent.push(keyword!);
    }
    expect(echoes).toBeGreaterThan(0);
  });

  it("covers every tier in the default 100-round run", () => {
    const tiers = new Set(
      buildMixRounds(100, 42)
        .map((round) => /^tier=([^ ]+)/.exec(round.note ?? "")?.[1])
        .filter(Boolean),
    );
    expect([...tiers].sort()).toEqual([...TIERS].sort());
  });
});

describe("fourTierMix scenario", () => {
  it("exposes its name, description and deterministic rounds", () => {
    expect(fourTierMix.name).toBe("four-tier-mix");
    expect(fourTierMix.description).toContain("100");
    expect(fourTierMix.buildRounds()).toEqual(buildMixRounds(100, 42));
  });

  it("parses the inline fixture into four tiers plus one permanent entry", () => {
    const entries = fourTierMix.buildEntries();
    expect(entries).toHaveLength(10);

    const permanent = entries[0];
    expect(permanent).toMatchObject({
      id: "wb_mix_测试常驻",
      keywords: ["常驻测试", "fixture_permanent"],
      permanent: true,
      enabled: true,
      intrinsicValue: 100,
      priority: 200,
    });
    expect(permanent.content).toContain("fixture permanent");
    expect(entries.slice(1).every((entry) => entry.permanent === false)).toBe(true);
    expect(entries.map((entry) => entry.intrinsicValue)).toEqual(
      expect.arrayContaining([90, 70, 45, 15]),
    );
  });
});
