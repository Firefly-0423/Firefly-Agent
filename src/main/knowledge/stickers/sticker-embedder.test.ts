import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../rag/embedding";
import { buildStickerEmbeddingIndex, matchSticker } from "./sticker-embedder";

function provider(embed: (text: string) => number[], batches?: string[][]): EmbeddingProvider {
  return {
    embed: vi.fn(async (text: string) => embed(text)),
    embedBatch: vi.fn(async (texts: string[]) => {
      batches?.push([...texts]);
      return texts.map(embed);
    }),
  } as unknown as EmbeddingProvider;
}

describe("buildStickerEmbeddingIndex", () => {
  it("returns an empty index without calling the provider when there is nothing to embed", async () => {
    const p = provider(() => [1, 0]);
    await expect(buildStickerEmbeddingIndex(p, {}, {})).resolves.toEqual([]);
    expect(p.embedBatch).not.toHaveBeenCalled();
  });

  it("embeds built-ins first, joining phrases, then user stickers", async () => {
    const batches: string[][] = [];
    const p = provider((text) => [text.length, 1], batches);
    const index = await buildStickerEmbeddingIndex(
      p,
      { builtin: { phrases: ["a", "bb"] } },
      { custom: { phrases: ["ccc"] } },
    );
    expect(batches).toEqual([["a，bb", "ccc"]]);
    expect(index).toEqual([
      { id: "builtin", embedding: [4, 1] },
      { id: "custom", embedding: [3, 1] },
    ]);
  });

  it("lets a user sticker override a built-in with the same id exactly once", async () => {
    const batches: string[][] = [];
    const p = provider((text) => [text.length], batches);
    const index = await buildStickerEmbeddingIndex(
      p,
      { shared: { phrases: ["builtin"] }, kept: { phrases: ["builtin-kept"] } },
      { shared: { phrases: ["user"] } },
    );
    expect(batches[0]).toEqual(["builtin-kept", "user"]);
    expect(index.map((entry) => entry.id)).toEqual(["kept", "shared"]);
  });

  it("preserves insertion order of the records", async () => {
    const p = provider((text) => [text.length]);
    const index = await buildStickerEmbeddingIndex(
      p,
      { z: { phrases: ["z"] }, a: { phrases: ["a"] } },
      { m: { phrases: ["m"] }, b: { phrases: ["b"] } },
    );
    expect(index.map((entry) => entry.id)).toEqual(["z", "a", "m", "b"]);
  });
});

describe("matchSticker", () => {
  const index = [
    { id: "same", embedding: [1, 0] },
    { id: "orthogonal", embedding: [0, 1] },
  ];

  it("returns null for an empty index without embedding the query", async () => {
    const p = provider(() => [1, 0]);
    await expect(matchSticker("hello", p, [], 0.5)).resolves.toBeNull();
    expect(p.embed).not.toHaveBeenCalled();
  });

  it("returns the best scoring sticker above the threshold", async () => {
    const p = provider(() => [1, 0]);
    await expect(matchSticker("hello", p, index, 0.5)).resolves.toEqual({ id: "same", score: 1 });
    expect(p.embed).toHaveBeenCalledWith("hello");
  });

  it("returns null when the best score is below the threshold", async () => {
    const p = provider(() => [1, 1]);
    const result = await matchSticker("hello", p, index, 0.8);
    expect(result).toBeNull();
  });

  it("accepts a score exactly equal to the threshold", async () => {
    const p = provider(() => [1, 0]);
    await expect(matchSticker("hello", p, [{ id: "identical", embedding: [1, 0] }], 1)).resolves.toEqual({
      id: "identical",
      score: 1,
    });
  });

  it("keeps the first sticker when scores tie", async () => {
    const p = provider(() => [1, 0]);
    const result = await matchSticker("hello", p, [
      { id: "first", embedding: [2, 0] },
      { id: "second", embedding: [3, 0] },
    ], 0.9);
    expect(result?.id).toBe("first");
  });

  it("treats a zero vector as zero similarity", async () => {
    const p = provider(() => [0, 0]);
    await expect(matchSticker("hello", p, [{ id: "zero", embedding: [1, 0] }], 0.1)).resolves.toBeNull();
  });
});
