import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCachedStickerEmbeddingIndex as build } from "./sticker-embedding-cache";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "./sticker-descriptions";
import type { EmbeddingProvider } from "../rag/embedding";

const model = vi.hoisted(() => ({ provider: "local", model: "garden-vector", dimensions: 1024 }));
vi.mock("../rag/embedding", async original => ({
  ...await original<typeof import("../rag/embedding")>(), getEmbeddingProviderIdentity: async () => ({ ...model }),
}));
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ff-stickers-contract-")); model.model = "garden-vector"; model.dimensions = 1024; });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function embedder(): EmbeddingProvider {
  return { name: "garden-test", dims: 2, embed: vi.fn(),
    embedBatch: vi.fn(async texts => texts.map((_, index) => [index + 3, index + 5])) };
}
it("reuses a persisted vector without requesting embeddings again", async () => {
  const descriptions = { greeting: { phrases: ["Welcome back"] } }, initial = embedder();
  const result = await build(initial, descriptions, {}, directory);
  expect(result).toEqual([{ id: "greeting", embedding: [3, 5] }]);
  expect(initial.embedBatch).toHaveBeenCalledTimes(1);
  const cached = embedder();
  expect(await build(cached, descriptions, {}, directory)).toEqual(result);
  expect(cached.embedBatch).not.toHaveBeenCalled();
});
it.each(["phrases", "model"] as const)("invalidates persisted vectors when %s change", async changed => {
  const original = { greeting: { phrases: ["Welcome back"] } };
  await build(embedder(), original, {}, directory);
  if (changed === "model") { model.model = "garden-vector-v2"; model.dimensions = 768; }
  const next = embedder();
  await build(next, changed === "phrases" ? { greeting: { phrases: ["Glad to see you"] } } : original, {}, directory);
  expect(next.embedBatch).toHaveBeenCalledTimes(1);
});
it("retires old builtin stickers, retains custom stickers and leaves adjacent data alone", async () => {
  const custom = { "garden-custom": { phrases: ["Time to water"] } };
  await build(embedder(), { playful: { phrases: ["Obsolete phrase"] } }, custom, directory);
  const sentinel = join(directory, "separate-data.json");
  writeFileSync(sentinel, "garden-sentinel");
  const replacement = embedder();
  const result = await build(replacement, BUILT_IN_STICKER_DESCRIPTIONS, custom, directory);
  expect(result).toHaveLength(30);
  expect(result.some(entry => entry.id === "playful")).toBe(false);
  expect(result.some(entry => entry.id === "garden-custom")).toBe(true);
  expect(replacement.embedBatch).toHaveBeenCalledTimes(1);
  const cached = embedder();
  expect(await build(cached, BUILT_IN_STICKER_DESCRIPTIONS, custom, directory)).toEqual(result);
  expect(cached.embedBatch).not.toHaveBeenCalled();
  expect(readFileSync(sentinel, "utf8")).toBe("garden-sentinel");
});
