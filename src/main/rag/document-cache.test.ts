import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildDocumentCacheIdentity as identify, createDocumentCacheKey as keyFor,
  getValidDocumentCacheRecord as lookup, putDocumentCacheRecord as save } from "./document-cache";
import { DOCUMENT_CHUNK_SIZE, DOCUMENT_CHUNK_OVERLAP } from "./chunk";

const environment = vi.hoisted(() => ({
  root: "", identity: { provider: "local", model: "garden-embed", dimensions: 1024, endpoint: undefined as string | undefined },
}));
vi.mock("electron", () => ({ app: { getPath: () => environment.root } }));
vi.mock("./embedding", () => ({ getEmbeddingProviderIdentity: async () => environment.identity }));
beforeEach(() => {
  environment.root = mkdtempSync(join(tmpdir(), "ff-doc-cache-"));
  environment.identity = { provider: "local", model: "garden-embed", dimensions: 1024, endpoint: undefined };
});
afterEach(() => rmSync(environment.root, { recursive: true, force: true }));
it("identifies equivalent newline encodings with the configured embedding and chunk policy", async () => {
  const windows = await identify("plant\r\nnotes"), unix = await identify("plant\nnotes");
  expect(windows.textSha256).toBe(unix.textSha256);
  expect(windows.embeddingProvider).toBeTruthy();
  expect(windows.embeddingModel).toBeTruthy();
  expect([windows.chunkStrategyVersion, windows.chunkSize, windows.chunkOverlap])
    .toEqual(["document-chunks-v1", DOCUMENT_CHUNK_SIZE, DOCUMENT_CHUNK_OVERLAP]);
});
it("distinguishes endpoint, model and vector dimension changes", async () => {
  environment.identity = { provider: "openai-compat", model: "garden-remote", dimensions: 1536, endpoint: "https://first.invalid/v1" };
  const first = await identify("plant notes");
  environment.identity.endpoint = "https://second.invalid/v1";
  expect(keyFor(first)).not.toBe(keyFor(await identify("plant notes")));
  expect(keyFor({ ...first, embeddingModel: "garden-next", dimensions: 384 })).not.toBe(keyFor(first));
});
it("rejects a cache hit whose import no longer has stored chunks", async () => {
  await save({ key: "garden-key", importId: "removed-import", fileName: "plants.md", chunkCount: 6, createdAt: "2026-10-20T00:00:00Z" });
  expect(await lookup("garden-key", () => false)).toBeNull();
});
it("rejects each malformed persisted field instead of returning corrupt cache data", async () => {
  const target = join(environment.root, "rag-data", "document-cache.json");
  mkdirSync(dirname(target), { recursive: true });
  const good = { key: "garden-key", importId: "plant-import", fileName: "plants.md", chunkCount: 6, createdAt: "2026-10-20T00:00:00Z" };
  for (const patch of [{ key: undefined }, { importId: 47 }, { chunkCount: -1 }, { fileName: null }, { createdAt: false }]) {
    writeFileSync(target, JSON.stringify({ records: { "garden-key": { ...good, ...patch } } }));
    await expect(lookup("garden-key", () => true)).resolves.toBeNull();
  }
});
