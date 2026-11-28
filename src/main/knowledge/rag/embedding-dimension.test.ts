import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenAIEmbeddingProvider, EmbeddingDimensionMismatchError, EmbeddingBatchDimensionInconsistencyError,
  type EmbeddingProvider } from "./embedding";
import { JsonVectorStore } from "./vectorstore";

let directory: string;
const stores: JsonVectorStore[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ff-dimensions-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) await store.flush();
  rmSync(directory, { recursive: true, force: true });
});
function response(...dimensions: number[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true,
    json: async () => ({ data: dimensions.map(size => ({ embedding: Array(size).fill(0.25) })) }) })));
}
const remote = (declared?: number) => createOpenAIEmbeddingProvider("https://vectors.invalid/v1", "fixture-token", "garden-vectors", declared);
function local(size: number): EmbeddingProvider {
  return { name: "fixture-vectors", dims: size, declaredDimensions: size, resolvedDimensions: size,
    cacheIdentity: { provider: "local", model: "garden-vectors", dimensions: size },
    embed: async () => Array(size).fill(0.25), embedBatch: async texts => texts.map(() => Array(size).fill(0.25)) };
}
function open() { const store = new JsonVectorStore(directory); stores.push(store); return store; }
it("discovers dimensions on the first response and exposes a complete cache identity", async () => {
  const provider = remote();
  expect(provider.declaredDimensions).toBeUndefined();
  expect(provider.resolvedDimensions).toBeUndefined();
  expect(provider.cacheIdentity).toBeUndefined();
  response(1024);
  expect((await provider.embed("Rose garden")).length).toBe(1024);
  expect(provider.resolvedDimensions).toBe(1024);
  expect(provider.dims).toBe(1024);
  expect(provider.cacheIdentity).toEqual({ endpoint: "https://vectors.invalid/v1", provider: "openai-compat", model: "garden-vectors", dimensions: 1024 });
});
it("exposes declared dimensions before making a request", () => {
  expect(remote(768).cacheIdentity).toEqual({ endpoint: "https://vectors.invalid/v1", provider: "openai-compat", model: "garden-vectors", dimensions: 768 });
});
it("rejects a server vector that disagrees with the declared dimension", async () => {
  const provider = remote(1536);
  response(1024);
  expect(provider.declaredDimensions).toBe(1536);
  await expect(provider.embed("Rose garden")).rejects.toThrow(EmbeddingDimensionMismatchError);
  await expect(provider.embed("Rose garden")).rejects.toThrow("declared 1536, got 1024");
});
it("rejects mixed dimensions within a single batch and reports the offending index", async () => {
  const provider = remote();
  response(1024, 1536, 1024);
  await expect(provider.embedBatch(["Roses", "Lilies", "Mint"])).rejects.toThrow(EmbeddingBatchDimensionInconsistencyError);
  await expect(provider.embedBatch(["Roses", "Lilies", "Mint"])).rejects.toThrow("at index 1");
});
it("rejects dimension drift after successful discovery", async () => {
  const provider = remote();
  response(1024);
  await provider.embed("First flower");
  expect(provider.resolvedDimensions).toBe(1024);
  response(768);
  await expect(provider.embed("Next flower")).rejects.toThrow(EmbeddingDimensionMismatchError);
  await expect(provider.embed("Next flower")).rejects.toThrow("got 768");
});
it("blocks both writes and queries against incompatible index metadata", async () => {
  const store = open();
  await store.add("Rose garden", "garden", local(1536));
  expect(store.getIndexMeta()).not.toBeNull();
  expect(store.getIndexMeta()!.dimensions).toBe(1536);
  await expect(store.add("Lily pond", "garden", local(1024))).rejects.toThrow(/Index dimension mismatch.*1536.*1024/);
  await expect(store.search("Flowers", "garden", local(1024))).rejects.toThrow(/Index dimension mismatch.*1536.*1024/);
});
it("reconstructs missing metadata from compatible existing vectors", async () => {
  const original = open();
  await original.add("Herb garden", "garden", local(384));
  await original.flush();
  const metadata = join(directory, "memory-store-meta.json");
  expect(existsSync(metadata)).toBe(true);
  unlinkSync(metadata);
  expect(existsSync(metadata)).toBe(false);
  const reopened = open();
  expect(reopened.getIndexMeta()).toBeNull();
  await reopened.add("Mint patch", "garden", local(384));
  expect(reopened.getIndexMeta()).not.toBeNull();
  expect(reopened.getIndexMeta()!.dimensions).toBe(384);
});
it("refuses incompatible vectors even when legacy data has no metadata file", async () => {
  const original = open();
  await original.add("Old garden", "garden", local(1024));
  await original.flush();
  unlinkSync(join(directory, "memory-store-meta.json"));
  const reopened = open();
  await expect(reopened.add("New garden", "garden", local(768))).rejects.toThrow(/Index dimension mismatch.*1024.*768/);
});
it("initializes metadata on the first successful write to an empty store", async () => {
  const store = open();
  expect(store.getIndexMeta()).toBeNull();
  await store.add("First planting", "garden", local(512));
  const metadata = store.getIndexMeta();
  expect(metadata).not.toBeNull();
  expect(metadata).toMatchObject({ dimensions: 512, provider: "local", model: "garden-vectors" });
});
