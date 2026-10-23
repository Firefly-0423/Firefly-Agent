import { describe, expect, it } from "vitest";
import { isRetiredStickerId, isRetiredStickerRef } from "./retired-stickers";

describe("retired stickers", () => {
  it("recognizes retired ids and ignores unknown ids", () => {
    expect(isRetiredStickerId("playful")).toBe(true);
    expect(isRetiredStickerId("love-happy")).toBe(true);
    expect(isRetiredStickerId("please")).toBe(true);
    expect(isRetiredStickerId("not-a-sticker")).toBe(false);
    expect(isRetiredStickerId("")).toBe(false);
  });

  it("does not treat Object.prototype names as retired stickers", () => {
    expect(isRetiredStickerId("toString")).toBe(false);
    expect(isRetiredStickerId("hasOwnProperty")).toBe(false);
    expect(isRetiredStickerId("__proto__")).toBe(false);
  });

  it("recognizes only exact sticker references, with or without one leading slash", () => {
    expect(isRetiredStickerRef("stickers/playful.png")).toBe(true);
    expect(isRetiredStickerRef("/stickers/peek.gif")).toBe(true);
    expect(isRetiredStickerRef("stickers/HI.jpg")).toBe(true);
    expect(isRetiredStickerRef("stickers/please.jpg")).toBe(true);
  });

  it("rejects unrelated, nested, differently-cased or partially matching references", () => {
    expect(isRetiredStickerRef("other/playful.png")).toBe(false);
    expect(isRetiredStickerRef("stickers/nested/playful.png")).toBe(false);
    expect(isRetiredStickerRef("stickers/Playful.png")).toBe(false);
    expect(isRetiredStickerRef("stickers/playful.png.bak")).toBe(false);
    expect(isRetiredStickerRef("playful.png")).toBe(false);
    expect(isRetiredStickerRef("//stickers/playful.png")).toBe(false);
    expect(isRetiredStickerRef("")).toBe(false);
  });

  it("maps every id to the expected file shape", () => {
    for (const id of ["playful", "love-happy", "confident", "calm", "peek", "goodnight", "thinking", "please"]) {
      expect(isRetiredStickerId(id)).toBe(true);
    }
    expect(isRetiredStickerRef("stickers/confident.png")).toBe(true);
    expect(isRetiredStickerRef("stickers/goodnight.jpg")).toBe(true);
  });
});
