import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ load: vi.fn(), expected: { dataRoot: "data", indexRoot: "index", tempRoot: "temp" } }));
vi.mock("../storage/storage-context", () => ({ createStorageContext: () => ({ memory: deps.expected }) }));
vi.mock("../startup/runtime-profile", () => ({ canonicalPath: (p: string) => p, assertRuntimePathsOwned: vi.fn() }));
vi.mock("./protected-key", () => ({ loadOrCreateMemoryKey: deps.load }));
vi.mock("./writer-ownership", () => ({ acquireWriterOwnership: vi.fn() }));
import { createMemoryKeyHandle } from "./key-provider";
import { MemoryClient } from "./worker-client";
const clients: MemoryClient[] = [];
beforeEach(() => { vi.resetAllMocks(); });
afterEach(async () => { vi.useRealTimers(); for (const client of clients.splice(0)) await client.close().catch(() => {}); });
async function fixture(options: { ready?: boolean; terminateFails?: boolean } = {}) {
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => { if (options.terminateFails) throw Error("terminate"); worker.emit("exit", 1); return 1; }) });
  let lose!: () => void;
  const writer = { assertHeld: vi.fn(), release: vi.fn(async () => {}), onLost: vi.fn((callback: () => void) => { lose = callback; return vi.fn(); }) };
  const keyLease = { assertHeld: vi.fn(), release: vi.fn(async () => {}), onLost: () => () => {} };
  deps.load.mockResolvedValue(createMemoryKeyHandle(Buffer.alloc(32, 7), keyLease));
  const storage = { profile: {}, memory: { ...deps.expected } } as never;
  const factory = vi.fn((_data: { databasePath: string; key: Uint8Array }) => { if (options.ready !== false) queueMicrotask(() => worker.emit("message", { type: "ready" })); return worker; });
  const input = { storage, keyProtection: { protect: async (b: Uint8Array) => b, unprotect: async (b: Uint8Array) => b }, writerLeaseFactory: async () => writer, workerFactory: factory };
  const opening = MemoryClient.open(input);
  return { worker, writer, keyLease, factory, input, lose: () => lose(), opening, async open() { const client = await opening; clients.push(client); return client; } };
}
function reply(worker: Awaited<ReturnType<typeof fixture>>["worker"], result: unknown = "ok", ok = true, error?: string) { const request = worker.postMessage.mock.calls.at(-1)![0]; worker.emit("message", { id: request.id, ok, result, error }); return request; }
function closeNormally(f: Awaited<ReturnType<typeof fixture>>) { f.worker.postMessage.mockImplementation((m: any) => { queueMicrotask(() => { f.worker.emit("message", { id: m.id, ok: true }); if (m.type === "close") f.worker.emit("exit", 0); }); }); }
it("validates storage paths before acquiring ownership", async () => {
  const writerLeaseFactory = vi.fn(); await expect(MemoryClient.open({ storage: { profile: {}, memory: { ...deps.expected, dataRoot: "foreign" } }, writerLeaseFactory } as never)).rejects.toThrow(/^MEMORY_STORAGE_INVALID$/); expect(writerLeaseFactory).not.toHaveBeenCalled();
});
it("zeros the transferred key buffer after constructing the worker", async () => {
  const f = await fixture(), client = await f.open(); expect(f.factory.mock.calls[0][0]).toEqual({ databasePath: path.join("data", "memory.sqlite"), key: Buffer.alloc(32) }); expect(f.keyLease.release).toHaveBeenCalledOnce(); closeNormally(f); await client.close();
});
it.each(["jobCommand", "policyCommand", "contextCommand", "recallCommand", "historyCommand", "shadowCommand", "execute", "sourceCommand", "writeBatch"] as const)("round-trips %s without changing the command", async method => {
  const f = await fixture(), client = await f.open(), body = { command: "test" }; const pending = (client[method] as (x: any) => Promise<unknown>)(body); const sent = reply(f.worker, { result: 1 });
  expect(sent).toEqual({ id: 1, type: ({ jobCommand: "job", policyCommand: "policy", contextCommand: "context", recallCommand: "recall", historyCommand: "historical", shadowCommand: "shadow", execute: "execute", sourceCommand: "source", writeBatch: "batch" })[method], body }); expect(await pending).toEqual({ result: 1 }); closeNormally(f);
});
it("maps row, fact, history and optional backup arguments", async () => {
  const f = await fixture(), client = await f.open();
  for (const [call, type, body] of [
    [() => client.current("s"), "current", { scopeKey: "s" }], [() => client.history("s", "f"), "history", { scopeKey: "s", factId: "f" }], [() => client.readRows("sources", "s"), "rows", { table: "sources", scopeKey: "s" }], [() => client.backup(), "backup", {}], [() => client.backup("b"), "backup", { backupId: "b" }],
  ] as const) { const pending = call(); expect(reply(f.worker, [])).toMatchObject({ type, body }); expect(await pending).toEqual([]); }
  closeNormally(f);
});
it.each(["MEMORY_COMMAND_INVALID", "private error"])("normalizes worker error %s without closing the client", async error => {
  const f = await fixture(), client = await f.open(), pending = client.jobCommand({}); reply(f.worker, undefined, false, error); await expect(pending).rejects.toThrow(new RegExp(`^${error.startsWith("MEMORY_") ? error : "MEMORY_WORKER_FAILED"}$`)); closeNormally(f);
});
it.each([null, { id: 999, ok: true }, { id: 1, ok: "true" }])("fails all pending requests for malformed protocol %j", async message => {
  const f = await fixture(), client = await f.open(); const pending = client.jobCommand({}); const assertion = expect(pending).rejects.toThrow(/^MEMORY_PROTOCOL_INVALID$/); f.worker.emit("message", message); await assertion; await client.closed; expect(f.writer.release).toHaveBeenCalledOnce(); await expect(client.current("s")).rejects.toThrow(/^MEMORY_CLIENT_CLOSED$/);
});
it("rejects excess queue requests while allowing a graceful drain", async () => {
  const f = await fixture(), client = await f.open(); const pending = Array.from({ length: 256 }, () => client.jobCommand({})); await expect(client.jobCommand({})).rejects.toThrow(/^MEMORY_QUEUE_FULL$/);
  const requests = f.worker.postMessage.mock.calls.map(c => c[0]); closeNormally(f); const closing = client.close(); for (const request of requests) f.worker.emit("message", { id: request.id, ok: true, result: request.id }); expect(await Promise.all(pending)).toEqual(Array.from({ length: 256 }, (_, i) => i + 1)); await closing;
});
it.each(["error", "exit", "lease"])("rejects pending work and releases ownership after %s", async kind => {
  const f = await fixture(), client = await f.open(), pending = client.current("s"); const assertion = expect(pending).rejects.toThrow(kind === "lease" ? /^MEMORY_WRITER_LOCK_LOST$/ : /^MEMORY_WORKER_FAILED$/); if (kind === "lease") f.lose(); else f.worker.emit(kind, kind === "exit" ? 2 : Error("private")); await assertion; await client.closed; expect(f.writer.release).toHaveBeenCalledOnce();
});
it("times out requests and releases resources", async () => {
  const f = await fixture(), client = await f.open(); vi.useFakeTimers(); const assertion = expect(client.jobCommand({})).rejects.toThrow(/^MEMORY_WORKER_TIMEOUT$/); await vi.advanceTimersByTimeAsync(5000); await assertion; await client.closed; expect(f.worker.terminate).toHaveBeenCalledOnce();
});
it("makes close idempotent and rejects work as soon as shutdown starts", async () => {
  const f = await fixture(), client = await f.open(); closeNormally(f); const closing = client.close(); expect(client.close()).toBe(closing); await expect(client.backup()).rejects.toThrow(/^MEMORY_CLIENT_CLOSED$/); await closing; expect(f.writer.release).toHaveBeenCalledOnce(); expect(f.worker.terminate).not.toHaveBeenCalled();
});
it("maps synchronous transport failures to a protocol failure", async () => {
  const f = await fixture(), client = await f.open(); f.worker.postMessage.mockImplementation(() => { throw Error("send"); }); await expect(client.jobCommand({})).rejects.toThrow(/^MEMORY_PROTOCOL_INVALID$/); await client.closed;
});
it("times out an opening handshake and releases ownership", async () => {
  vi.useFakeTimers();
  const f = await fixture({ ready: false });
  const assertion = expect(f.opening).rejects.toThrow(/^MEMORY_WORKER_TIMEOUT$/);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(f.worker.terminate).toHaveBeenCalledOnce();
  expect(f.writer.release).toHaveBeenCalledOnce();
});
it("releases ownership when loading a key fails before worker creation", async () => {
  const f = await fixture();
  const client = await f.open();
  closeNormally(f);
  await client.close();
  deps.load.mockRejectedValue(Error("MEMORY_KEY_UNAVAILABLE"));
  f.writer.release.mockClear();
  f.factory.mockClear();
  await expect(MemoryClient.open(f.input)).rejects.toThrow(/^MEMORY_KEY_UNAVAILABLE$/);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.writer.release).toHaveBeenCalledOnce();
});
it("fails immediately when writer ownership cannot be asserted", async () => {
  const f = await fixture(), client = await f.open();
  f.writer.assertHeld.mockImplementation(() => { throw Error("lost"); });
  await expect(client.current("scope")).rejects.toThrow(/^MEMORY_WRITER_LOCK_LOST$/);
  await client.closed;
  expect(f.worker.postMessage).not.toHaveBeenCalled();
});
it("times out shutdown when the worker acknowledges but never exits", async () => {
  const f = await fixture(), client = await f.open();
  vi.useFakeTimers();
  const closing = client.close();
  const assertion = expect(closing).rejects.toThrow(/^MEMORY_WORKER_TIMEOUT$/);
  reply(f.worker);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(f.worker.terminate).toHaveBeenCalledOnce();
});
it("rejects a nonzero exit after the close acknowledgement", async () => {
  const f = await fixture(), client = await f.open();
  const closing = client.close();
  const assertion = expect(closing).rejects.toThrow(/^MEMORY_WORKER_FAILED$/);
  reply(f.worker);
  f.worker.emit("exit", 7);
  await assertion;
  await client.closed;
});
it("keeps ownership after termination fails until the worker really exits", async () => {
  const f = await fixture({ terminateFails: true }), client = await f.open();
  f.worker.emit("error", Error("crashed"));
  await expect(client.closed).rejects.toThrow(/^MEMORY_WORKER_CLEANUP_FAILED$/);
  expect(f.writer.release).not.toHaveBeenCalled();
  f.worker.emit("exit", 1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.writer.release).toHaveBeenCalledOnce();
});
it("reports resource release failure through the closed promise", async () => {
  const f = await fixture(), client = await f.open();
  f.writer.release.mockRejectedValue(Error("release failed"));
  f.worker.emit("error", Error("crashed"));
  await expect(client.closed).rejects.toThrow(/^MEMORY_OWNERSHIP_CLEANUP_FAILED$/);
});
