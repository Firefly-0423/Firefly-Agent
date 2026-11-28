import { it, expect } from "vitest";
import { resolve, join } from "node:path";
import { resolveLocalStickerPath as resolveSticker, parseLocalStickerFileFromUrl as parse,
  buildLocalStickerUrl as urlFor } from "./sticker-protocol";

it("encodes a filename in a path URL and also reads older host URLs", () => {
  expect(urlFor("sleepy fox.png")).toBe("local-sticker:///sleepy%20fox.png");
  expect(parse(urlFor("sleepy fox.png"))).toBe("sleepy fox.png");
  expect(parse("local-sticker://fox.png")).toBe("fox.png");
});
it.each(["local-sticker:///%2e%2e/private.json", "local-sticker://..%2Fprivate.json", "local-sticker:///"])(
  "rejects an unsafe or absent filename in %s", value => { expect(parse(value)).toBeNull(); });
it("resolves only a direct file below the sticker root", () => {
  const root = join("C:", "fixtures", "art", "stickers");
  expect(resolveSticker(root, "fox.png")).toBe(resolve(root, "fox.png"));
  expect(resolveSticker(root, "../private.json")).toBeNull();
});
