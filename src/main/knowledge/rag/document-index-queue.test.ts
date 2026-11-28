import { expect, it, vi } from "vitest";
import { createDocumentIndexQueue, type DocumentIndexJobResult, type DocumentIndexRunner } from "./document-index-queue";

function queueFixture() {
  const started: string[] = [], completions: Array<(value: DocumentIndexJobResult) => void> = [];
  const runner: DocumentIndexRunner = job => new Promise(resolve => {
    started.push(job.input.filePath);
    completions.push(resolve);
  });
  const queue = createDocumentIndexQueue({ runner });
  const enqueue = (filePath: string) => queue.enqueue({ filePath, query: "garden", onProgress: vi.fn() });
  const finish = (index: number) => completions[index]({ kind: "indexed", name: started[index], chunks: 5, importId: "garden-import" });
  return { queue, enqueue, finish, started };
}
it("runs queued files serially in submission order and exposes transitions in diagnostics", async () => {
  const fixture = queueFixture(), first = fixture.enqueue("plants.md"), next = fixture.enqueue("soil.md");
  expect(fixture.started).toEqual(["plants.md"]);
  expect(fixture.queue.getStats()).toMatchObject({ activeJobId: first.jobId, pendingJobs: 1, cancellationListeners: 0 });
  fixture.finish(0);
  await first.promise;
  expect(fixture.started).toEqual(["plants.md", "soil.md"]);
  expect(fixture.queue.getStats()).toMatchObject({ activeJobId: next.jobId, pendingJobs: 0 });
  fixture.finish(1);
  await next.promise;
});
it("cancels a waiting file without ever starting it", async () => {
  const fixture = queueFixture(), active = fixture.enqueue("plants.md"), pending = fixture.enqueue("soil.md");
  expect(fixture.queue.cancel(pending.jobId)).toBe(true);
  await expect(pending.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
  fixture.finish(0);
  await active.promise;
  expect(fixture.started).toEqual(["plants.md"]);
});
it("retains the active slot until a cancelled runner finishes and then reports cancellation", async () => {
  const fixture = queueFixture(), active = fixture.enqueue("plants.md"), pending = fixture.enqueue("soil.md");
  expect(fixture.queue.cancel(active.jobId)).toBe(true);
  expect(fixture.queue.getStats()).toMatchObject({ activeJobId: active.jobId, pendingJobs: 1, cancellationListeners: 0 });
  fixture.finish(0);
  await expect(active.promise).resolves.toMatchObject({ kind: "error", reason: "cancelled" });
  expect(fixture.queue.getStats()).toMatchObject({ activeJobId: pending.jobId, pendingJobs: 0 });
  fixture.finish(1);
  await pending.promise;
});
