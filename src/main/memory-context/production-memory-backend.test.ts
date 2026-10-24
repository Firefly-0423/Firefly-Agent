import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Real SQLite / filesystem integration cases: the 5 s default is too tight on CI runners, so this file allows 30 s. Other files keep the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { MemoryClient } from "../memory-core/worker-client";
import type { KeyProtection } from "../memory-core/key-provider";
import * as storageContext from "../storage-context";
import { createMainHistory } from "../memory-history/main-history";
import { recallFixture } from "../../../scripts/verify/memory-recall/recall-fixture";
import { openProductionMemoryBackend, type ProductionMemoryBackend, type ProductionMemoryBackendOptions } from "./production-memory-backend";

const backends: ProductionMemoryBackend[] = [];
const cleanup: Array<() => void> = [];
const roots: string[] = [];
const commandMethods = ["sourceCommand", "policyCommand", "recallCommand", "historyCommand", "contextCommand"] as const;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(setImmediate);
async function open(options?: ProductionMemoryBackendOptions): Promise<ProductionMemoryBackend> {
  const backend = await openProductionMemoryBackend(options);
  backends.push(backend);
  return backend;
}
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-production-memory-")));
  roots.push(root);
  const storage = storageContext.createStorageContext({
    kind: "test", applicationName: "Firefly-test", appData: root,
    userData: path.join(root, "data"), sessionData: path.join(root, "session"),
    logs: path.join(root, "logs"), isolationRoot: root,
  });
  const worker = {
    sourceCommand: vi.fn(async (command: unknown) => ({ method: "sourceCommand", command })),
    policyCommand: vi.fn(async (command: unknown) => ({ method: "policyCommand", command })),
    recallCommand: vi.fn(async (command: unknown) => ({ method: "recallCommand", command })),
    historyCommand: vi.fn(async (command: unknown) => ({ method: "historyCommand", command })),
    contextCommand: vi.fn(async (command: unknown) => ({ method: "contextCommand", command })),
    close: vi.fn(async () => {}),
  };
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: vi.fn((text: string) => Buffer.from(`synthetic-sealed:${text}`)),
    decryptString: vi.fn((sealed: Buffer) => sealed.toString().replace(/^synthetic-sealed:/, "")),
  };
  const workerFactory = vi.fn(async (_input: { storage: storageContext.StorageContext; keyProtection: KeyProtection }) => worker);
  const options: ProductionMemoryBackendOptions = {
    storage, workerFactory, safeStorage,
    app: { isPackaged: false, getAppPath: () => root },
    resourcesPath: path.join(root, "resources"),
    helperExists: () => false,
    spawn: () => { throw Error("UNEXPECTED_NATIVE_SPAWN"); },
  };
  return { root, storage, worker, options, workerFactory, safeStorage, unavailable: () => { available = false; } };
}
class SyntheticChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  closed = false;
  kill() { this.kills++; return true; }
  frame(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  finish(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, code === null ? "SIGTERM" : null);
  }
  asProcess() { return this as unknown as ChildProcessWithoutNullStreams; }
}
const nativeIdentity = { volumeSerial: 42, fileIndex: "1234567890abcdef" };
function nativeInput(f: ReturnType<typeof fixture>) {
  return { root: f.storage.dataRoot, deadlineAt: performance.now() + 10_000, signal: new AbortController().signal };
}
beforeEach(() => { vi.stubGlobal("fetch", () => { throw Error("UNEXPECTED_EXTERNAL_REQUEST"); }); });
afterEach(async () => {
  for (const release of cleanup.splice(0)) release();
  for (const backend of backends.splice(0)) await backend.close().catch(() => {});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production memory backend", () => {
  it("opens S/M without a history helper or model restrictions and preserves saved model bytes", async () => {
    const f = fixture();
    fs.mkdirSync(f.storage.configRoot, { recursive: true });
    const modelPath = path.join(f.storage.configRoot, "synthetic-model-profiles.json");
    const saved = JSON.stringify({ profiles: [{ provider: "OpenRouter", model: "openai/gpt-6-luna" }, { provider: "Anthropic", model: "synthetic-model" }] });
    fs.writeFileSync(modelPath, saved);
    const backend = await open(f.options);

    expect(f.workerFactory).toHaveBeenCalledTimes(1);
    expect(f.workerFactory.mock.calls[0][0].storage).toBe(f.storage);
    for (const method of commandMethods) {
      const command = { synthetic: method };
      expect(await backend.transport[method](command)).toEqual({ method, command });
    }
    expect(backend.localRetrieval).toBeUndefined();
    expect(fs.readFileSync(modelPath, "utf8")).toBe(saved);
  });

  it("denies native H explicitly when the helper is missing without closing S/M", async () => {
    const f = fixture();
    const backend = await open(f.options);
    await expect(backend.endpointFactory(nativeInput(f))).rejects.toThrow("MEMORY_HISTORY_NATIVE_UNAVAILABLE");
    expect(await backend.transport.contextCommand({ kind: "synthetic" })).toMatchObject({ method: "contextCommand" });
    expect(f.worker.close).not.toHaveBeenCalled();
  });

  it("uses installed storage and the existing MemoryClient opener by default", async () => {
    const f = fixture();
    vi.spyOn(storageContext, "getStorageContext").mockReturnValue(f.storage);
    const existingOpen = vi.spyOn(MemoryClient, "open").mockResolvedValue(f.worker as unknown as MemoryClient);
    const { storage: _storage, workerFactory: _workerFactory, ...options } = f.options;
    await open(options);
    expect(existingOpen).toHaveBeenCalledTimes(1);
    expect(existingOpen.mock.calls[0][0].storage).toBe(f.storage);
  });

  it("keeps the existing safeStorage base64 protection and fails closed when encryption is unavailable", async () => {
    const f = fixture();
    await open(f.options);
    const protection = f.workerFactory.mock.calls[0][0].keyProtection;
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const sealed = await protection.protect(bytes);
    expect(f.safeStorage.encryptString).toHaveBeenCalledWith(Buffer.from(bytes).toString("base64"));
    expect(await protection.unprotect(sealed)).toEqual(Buffer.from(bytes));
    f.unavailable();
    await expect(protection.protect(bytes)).rejects.toThrow("MEMORY_KEY_PROTECTION_UNAVAILABLE");
    await expect(protection.unprotect(sealed)).rejects.toThrow("MEMORY_KEY_PROTECTION_UNAVAILABLE");
    expect(f.safeStorage.encryptString).toHaveBeenCalledTimes(1);
    expect(f.safeStorage.decryptString).toHaveBeenCalledTimes(1);
  });

  it("uses lexical history with null document vectors and no implicit embedding calls", async () => {
    const f = fixture();
    const repository = recallFixture();
    cleanup.push(() => repository.close());
    const worker = { ...repository.transport, historyCommand: async (command: unknown) => repository.repo.historyCommand(command), close: async () => {} };
    const backend = await open({ ...f.options, workerFactory: async () => worker });
    const history = createMainHistory({ actorAuthority: repository.authority, registry: repository.registry, transport: backend.transport, localRetrieval: backend.localRetrieval });
    const source = await repository.source("harbor lexical history");
    await history.captureSource(repository.actor, source.ref, { documentId: "history-a", incarnation: "first", revision: 1 });
    const result = await history.query(repository.actor, { query: "harbor" });
    expect(result.diversity).toBe("lexical-dedup");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].document.vector).toBeNull();
  });

  it("waits for admitted commands and the real worker close settlement exactly once", async () => {
    const f = fixture();
    const operation = deferred<any>();
    const workerClosed = deferred();
    cleanup.push(() => { operation.resolve({ done: true }); workerClosed.resolve(); });
    f.worker.contextCommand.mockImplementation(() => operation.promise);
    f.worker.close.mockImplementation(() => workerClosed.promise);
    const backend = await open(f.options);
    const request = backend.transport.contextCommand({ kind: "pending" });
    const closing = backend.close();
    expect(backend.close()).toBe(closing);
    let settled = false;
    void closing.then(() => { settled = true; });
    await expect(backend.transport.sourceCommand({})).rejects.toThrow("MEMORY_BACKEND_CLOSED");
    await expect(backend.endpointFactory(nativeInput(f))).rejects.toThrow("MEMORY_BACKEND_CLOSED");
    await tick();
    expect(f.worker.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    operation.resolve({ done: true });
    await request;
    await tick();
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    workerClosed.resolve();
    await closing;
    expect(settled).toBe(true);
  });

  it("preserves worker close failures and never retries resource release", async () => {
    const f = fixture();
    f.worker.close.mockRejectedValue(Error("MEMORY_WORKER_CLEANUP_FAILED"));
    const backend = await open(f.options);
    const closing = backend.close();
    await expect(closing).rejects.toThrow("MEMORY_WORKER_CLEANUP_FAILED");
    expect(backend.close()).toBe(closing);
    expect(f.worker.close).toHaveBeenCalledTimes(1);
  });

  it("uses the actual native transport framing and waits for release acknowledgement and child closure", async () => {
    const f = fixture();
    const child = new SyntheticChild();
    cleanup.push(() => child.finish(null));
    const spawned: unknown[] = [];
    const backend = await open({ ...f.options, helperExists: () => true, spawn: input => { spawned.push(input); return child.asProcess(); } });
    const opening = backend.endpointFactory(nativeInput(f));
    await tick();
    child.frame({ type: "ready", version: 1, rootIdentity: nativeIdentity });
    const endpoint = await opening;
    expect(spawned).toEqual([expect.objectContaining({ helperPath: path.join(f.root, "native", "target", "release", "firefly-history-read.exe"), root: f.storage.dataRoot })]);
    const reading = endpoint.read(["session-a", "snapshot.json"], 2);
    await tick();
    child.frame({ type: "snapshot", version: 1, identity: nativeIdentity, rawLength: 2, bytesHex: "6162" });
    expect((await reading).bytes).toEqual(Uint8Array.from([97, 98]));
    let disposed = false;
    const disposing = endpoint.dispose("release").then(() => { disposed = true; });
    await tick();
    child.frame({ type: "released", version: 1 });
    await tick();
    expect(disposed).toBe(false);
    child.finish();
    await disposing;
    await backend.close();
    expect(child.kills).toBe(0);
  });

  it.each([false, true])("waits for the exact helper child on close (handshake ready=%s)", async (ready) => {
    const f = fixture();
    const child = new SyntheticChild();
    cleanup.push(() => child.finish(null));
    const backend = await open({ ...f.options, helperExists: () => true, spawn: () => child.asProcess() });
    const opening = backend.endpointFactory(nativeInput(f));
    const outcome = opening.catch(error => error.message);
    await tick();
    if (ready) {
      child.frame({ type: "ready", version: 1, rootIdentity: nativeIdentity });
      await opening;
    }
    let settled = false;
    const closing = backend.close().then(() => { settled = true; });
    await tick();
    expect(child.kills).toBe(1);
    expect(settled).toBe(false);
    expect(f.worker.close).not.toHaveBeenCalled();
    child.finish(null);
    await closing;
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    if (!ready) expect(await outcome).toBe("MEMORY_HISTORY_CANCELLED");
  });

  it("settles worker cleanup before reporting an initialization failure", async () => {
    const f = fixture();
    const workerClosed = deferred();
    const closeEntered = deferred();
    cleanup.push(() => workerClosed.resolve());
    f.worker.close.mockImplementation(() => { closeEntered.resolve(); return workerClosed.promise; });
    let settled = false;
    const opening = open({ ...f.options, app: { isPackaged: false, getAppPath: () => { throw Error("SYNTHETIC_APP_PATH_FAILED"); } } });
    const failed = opening.catch(error => { settled = true; return error.message; });
    await closeEntered.promise;
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    workerClosed.resolve();
    expect(await failed).toBe("SYNTHETIC_APP_PATH_FAILED");
  });

  it("preserves both initialization and cleanup failures", async () => {
    const f = fixture();
    f.worker.close.mockRejectedValue(Error("MEMORY_WORKER_CLEANUP_FAILED"));
    const opening = open({ ...f.options, app: { isPackaged: false, getAppPath: () => { throw Error("SYNTHETIC_APP_PATH_FAILED"); } } });
    const failure = await opening.catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual(["SYNTHETIC_APP_PATH_FAILED", "MEMORY_WORKER_CLEANUP_FAILED"]);
  });
});
