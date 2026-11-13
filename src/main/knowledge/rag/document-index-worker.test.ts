import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createDocumentIndexWorkerRunner, type DocumentIndexWorkerPort } from "./document-index-worker";
import type { QueuedDocumentIndexJob } from "./document-index-queue";

function indexing() {
  const events = new EventEmitter(), sent: unknown[] = [];
  const worker: DocumentIndexWorkerPort = { on: (event, callback) => events.on(event, callback),
    postMessage: message => { sent.push(message); }, terminate: vi.fn(async () => 0) };
  let cancellation: (() => void) | undefined;
  const job: QueuedDocumentIndexJob = {
    id: "garden-job", input: { filePath: "plants.md", query: "plants", onProgress: vi.fn() },
    cancelled: false, reportProgress: vi.fn(), onCancel: listener => { cancellation = listener; return () => { cancellation = undefined; }; },
  };
  const persist = vi.fn(async () => {}), cache = vi.fn(async () => {});
  const run = createDocumentIndexWorkerRunner({ createWorker: () => worker, getCachedImport: async () => null,
    getEmbeddingConfig: () => ({ provider: "local", modelKey: "bgem3" }), createImportId: () => "plant-import",
    persistPreparedBatch: persist, putCache: cache });
  return { job, sent, persist, cache, run, emit: (message: unknown) => events.emit("message", message),
    cancel: () => { job.cancelled = true; cancellation?.(); } };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
it("persists ordered batches under one import and writes cache only after completion", async () => {
  const h = indexing(), pending = h.run(h.job);
  h.emit({ type: "prepared", result: { kind: "prepared-indexed", name: "plants.md", textSha256: "garden-sha", totalChunks: 3 } });
  await tick();
  const batches = [[{ text: "Seeds", index: 0, embedding: [0.3, 0.7] }],
    [{ text: "Roots", index: 1, embedding: [0.8, 0.2] }, { text: "Leaves", index: 2, embedding: [0.6, 0.4] }]];
  h.emit({ type: "embedded-batch", chunks: batches[0] });
  h.emit({ type: "embedded-batch", chunks: batches[1] });
  await tick();
  expect(h.cache).not.toHaveBeenCalled();
  expect(h.persist.mock.calls).toEqual(batches.map(chunks => [{ fileName: "plants.md", importId: "plant-import", chunks }]));
  h.emit({ type: "completed" });
  await expect(pending).resolves.toEqual({ kind: "indexed", name: "plants.md", chunks: 3, importId: "plant-import" });
  expect(h.cache).toHaveBeenCalledWith({ textSha256: "garden-sha", fileName: "plants.md", importId: "plant-import", chunkCount: 3 });
});
it("forwards embedding progress and cancels before persisting vectors or cache", async () => {
  const h = indexing(), pending = h.run(h.job);
  h.emit({ type: "prepared", result: { kind: "prepared-indexed", name: "plants.md", textSha256: "garden-sha", totalChunks: 4 } });
  await tick();
  expect(h.sent).toContainEqual({ type: "embed", embedding: { provider: "local", modelKey: "bgem3" } });
  h.emit({ type: "progress", completedChunks: 2, totalChunks: 4 });
  await tick();
  expect(h.job.reportProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "embedding", completedChunks: 2, totalChunks: 4 }));
  h.cancel();
  expect(h.sent).toContainEqual({ type: "cancel" });
  h.emit({ type: "cancelled" });
  await expect(pending).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
  expect(h.persist).not.toHaveBeenCalled();
  expect(h.cache).not.toHaveBeenCalled();
});
it("accepts metadata-only preparation and counts actual batch payloads in the final result", async () => {
  const h = indexing(), pending = h.run(h.job);
  h.emit({ type: "prepared", result: { kind: "prepared-indexed", name: "orchard.md", textSha256: "orchard-sha", totalChunks: 42 } });
  await tick();
  expect(h.job.reportProgress).toHaveBeenCalledWith({ status: "embedding", completedChunks: 0, totalChunks: 42 });
  expect(h.sent).toContainEqual({ type: "embed", embedding: { provider: "local", modelKey: "bgem3" } });
  h.emit({ type: "embedded-batch", chunks: [{ text: "One delivered chunk", index: 0, embedding: [0.9] }] });
  h.emit({ type: "completed" });
  await expect(pending).resolves.toEqual({ kind: "indexed", name: "orchard.md", chunks: 1, importId: "plant-import" });
});
