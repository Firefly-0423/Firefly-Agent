import { describe, expect, it } from "vitest";
import {
  NEGATIVE_AFTER_POSITIVE_COOLDOWN_MS,
  createStickerMoodGuard,
  moodOfAutoSticker,
  replyReadsAsDispleased,
} from "./sticker-mood";

const index = ["firefly-pout", "firefly-cake", "firefly-wink"].map(id => ({ id, embedding: [1] }));
const ids = (entries: { id: string }[]) => entries.map(entry => entry.id);

describe("auto sticker moods", () => {
  it("marks only the pout sticker as negative", () => {
    expect(moodOfAutoSticker("firefly-pout")).toBe("negative");
    expect(moodOfAutoSticker("firefly-cake")).toBe("positive");
    expect(moodOfAutoSticker("firefly-hug")).toBeUndefined();
  });

  it("reads a reply as displeased only on a clear, non-negated, non-cheerful signal", () => {
    expect(replyReadsAsDispleased("哼，你又不听我的，我有点生气了")).toBe(true);
    expect(replyReadsAsDispleased("我有点不高兴")).toBe(true);
    expect(replyReadsAsDispleased("我没有生气哦，别担心")).toBe(false);
    expect(replyReadsAsDispleased("哈哈，我才不会生气呢")).toBe(false);
    expect(replyReadsAsDispleased("哈哈，被你气死了，不过好开心")).toBe(false);
    expect(replyReadsAsDispleased("今天天气真好，一起去散步吧")).toBe(false);
  });

  it("handles English negation and cheerful wording", () => {
    expect(replyReadsAsDispleased("I'm a bit annoyed that you ignored me")).toBe(true);
    expect(replyReadsAsDispleased("I'm not angry, don't worry")).toBe(false);
    expect(replyReadsAsDispleased("Don't be upset, I am not mad at you")).toBe(false);
    expect(replyReadsAsDispleased("I am never annoyed by questions")).toBe(false);
    expect(replyReadsAsDispleased("Haha, I'm angry? Not at all, thanks for asking")).toBe(false);
  });
});

describe("sticker mood guard", () => {
  it("hides the angry sticker unless the reply itself is displeased", () => {
    const guard = createStickerMoodGuard();
    expect(ids(guard.filterIndex(index, "好呀，我们一起吃蛋糕吧", "c1"))).toEqual(["firefly-cake", "firefly-wink"]);
    expect(ids(guard.filterIndex(index, "哼，我有点生气了", "c1"))).toEqual(["firefly-pout", "firefly-cake", "firefly-wink"]);
  });

  it("never turns from a happy sticker straight into an angry one", () => {
    const guard = createStickerMoodGuard();
    guard.recordSent("c1", "firefly-cake", { now: 1_000 });
    expect(ids(guard.filterIndex(index, "哼，我生气了", "c1", { now: 2_000 }))).not.toContain("firefly-pout");
    // another conversation is unaffected
    expect(ids(guard.filterIndex(index, "哼，我生气了", "c2", { now: 2_000 }))).toContain("firefly-pout");
    // after the cooldown it may happen again
    expect(ids(guard.filterIndex(index, "哼，我生气了", "c1", { now: 1_000 + NEGATIVE_AFTER_POSITIVE_COOLDOWN_MS + 1 }))).toContain("firefly-pout");
  });

  it("lets a happy sticker follow an angry one", () => {
    const guard = createStickerMoodGuard();
    guard.recordSent("c1", "firefly-pout", { now: 1_000 });
    expect(ids(guard.filterIndex(index, "好啦好啦，不生气了，哈哈", "c1", { now: 2_000 }))).toContain("firefly-cake");
  });

  it("does not apply a built-in mood to a custom sticker that reuses a built-in id", () => {
    const guard = createStickerMoodGuard();
    const isCustom = (id: string) => id === "firefly-pout";
    // the user's own "firefly-pout" stays available in a cheerful reply
    expect(ids(guard.filterIndex(index, "好呀，我们一起吃蛋糕吧", "c1", { isCustom }))).toContain("firefly-pout");
    // and sending it does not start the happy→angry cooldown either way
    guard.recordSent("c1", "firefly-pout", { isCustom, now: 1_000 });
    guard.recordSent("c2", "firefly-cake", { isCustom, now: 1_000 });
    expect(ids(guard.filterIndex(index, "哼，我生气了", "c1", { now: 2_000 }))).toContain("firefly-pout");
    expect(ids(guard.filterIndex(index, "哼，我生气了", "c2", { now: 2_000 }))).not.toContain("firefly-pout");
  });
});
