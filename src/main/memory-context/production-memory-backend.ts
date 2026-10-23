import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MemoryClient } from "../memory-core/worker-client";
import type { KeyProtection } from "../memory-core/key-provider";
import { getStorageContext, type StorageContext } from "../storage-context";
import type { createMainHistory } from "../memory-history/main-history";
import {
  createNativeHistoryEndpointFactory,
  type NativeHistoryEndpoint,
  type NativeHistoryEndpointFactory,
} from "../memory-sources/native-history-transport";

type MemoryTransport = Pick<MemoryClient,
  "sourceCommand" | "policyCommand" | "recallCommand" | "historyCommand" | "contextCommand">
  // Optional so existing fakes keep working; without it shadow extraction stays unavailable.
  & Partial<Pick<MemoryClient, "shadowCommand">>;
export type ProductionMemoryWorker = MemoryTransport & Pick<MemoryClient, "close">;
interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}
export interface ProductionMemoryBackendOptions {
  /** Main-only injection. Production uses the installed StorageContext and MemoryClient.open. */
  storage?: StorageContext;
  app?: { isPackaged: boolean; getAppPath(): string };
  safeStorage?: SafeStorage;
  resourcesPath?: string;
  helperPath?: string;
  helperExists?: (helperPath: string) => boolean;
  spawn?: (input: { helperPath: string; root: string; deadlineMs: number }) => ChildProcessWithoutNullStreams;
  /** A rejected opener owns its partial-initialization cleanup, as MemoryClient.open already does. */
  workerFactory?: (input: { storage: StorageContext; keyProtection: KeyProtection }) => Promise<ProductionMemoryWorker>;
}
export interface ProductionMemoryBackend {
  readonly transport: MemoryTransport;
  readonly endpointFactory: NativeHistoryEndpointFactory;
  /** Omitted by default: H uses lexical retrieval with null document vectors, without a semantic-quality guarantee. */
  readonly localRetrieval?: Parameters<typeof createMainHistory>[0]["localRetrieval"];
  close(): Promise<void>;
}

const CLOSED = "MEMORY_BACKEND_CLOSED";
function closed(): never { throw Error(CLOSED); }

/**
 * Shared Main storage ownership, independent of model profiles and provider transports.
 * Uses the existing single-writer Worker and safeStorage protection. No implicit embedding,
 * reranker, model request, or diagnostic expense ledger is initialized here.
 */
export async function openProductionMemoryBackend(
  options: ProductionMemoryBackendOptions = {},
): Promise<ProductionMemoryBackend> {
  const storage = options.storage ?? getStorageContext();
  const electron = options.app && options.safeStorage ? undefined : await import("electron");
  const app = options.app ?? electron!.app;
  const safeStorage = options.safeStorage ?? electron!.safeStorage;
  const protection: KeyProtection = {
    async protect(bytes) {
      if (!safeStorage.isEncryptionAvailable()) throw Error("MEMORY_KEY_PROTECTION_UNAVAILABLE");
      return safeStorage.encryptString(Buffer.from(bytes).toString("base64"));
    },
    async unprotect(bytes) {
      if (!safeStorage.isEncryptionAvailable()) throw Error("MEMORY_KEY_PROTECTION_UNAVAILABLE");
      return Buffer.from(safeStorage.decryptString(Buffer.from(bytes)), "base64");
    },
  };
  const worker = await (options.workerFactory ?? (input => MemoryClient.open(input)))({ storage, keyProtection: protection });
  try {
    // Missing binaries are an H availability condition, never an S/M initialization failure.
    const helperPath = options.helperPath ?? (app.isPackaged
      ? path.join(options.resourcesPath ?? process.resourcesPath, "bin", "firefly-history-read.exe")
      : path.join(app.getAppPath(), "native", "target", "release", "firefly-history-read.exe"));
    const helperExists = options.helperExists ?? fs.existsSync;
    const nativeFactory = createNativeHistoryEndpointFactory({
      spawn: input => options.spawn
        ? options.spawn({ helperPath, ...input })
        : spawn(helperPath, ["--root", input.root, "--parent-pid", String(process.pid), "--deadline-ms", String(input.deadlineMs)], {
          windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    const operations = new Set<Promise<unknown>>();
    const endpoints = new Set<NativeHistoryEndpoint>();
    const lifetime = new AbortController();
    let closing = false;
    let closeResult: Promise<void> | undefined;

    function track<T>(operation: Promise<T>): Promise<T> {
      operations.add(operation);
      void operation.then(() => operations.delete(operation), () => operations.delete(operation));
      return operation;
    }
    function admit<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(Error(CLOSED));
      try { return track(Promise.resolve(operation())); }
      catch (error) { return Promise.reject(error); }
    }
    function ownEndpoint(endpoint: NativeHistoryEndpoint): NativeHistoryEndpoint {
      let disposal: Promise<void> | undefined;
      const owned: NativeHistoryEndpoint = Object.freeze({
        rootIdentity: endpoint.rootIdentity,
        assertLive() { if (closing) closed(); endpoint.assertLive(); },
        read: (components: readonly string[], maxBytes: number) => admit(() => endpoint.read(components, maxBytes)),
        dispose(reason: "release" | "cancel") {
          if (disposal) return disposal;
          disposal = track(Promise.resolve().then(() => endpoint.dispose(reason)));
          void disposal.then(() => endpoints.delete(owned), () => endpoints.delete(owned));
          return disposal;
        },
      });
      endpoints.add(owned);
      return owned;
    }
    const endpointFactory: NativeHistoryEndpointFactory = input => admit(async () => {
      let available = false;
      try { available = path.isAbsolute(helperPath) && helperExists(helperPath); }
      catch { /* A failed file check also cannot authorize native acquisition. */ }
      if (!available) throw Error("MEMORY_HISTORY_NATIVE_UNAVAILABLE");
      const endpoint = await nativeFactory({ ...input, signal: AbortSignal.any([input.signal, lifetime.signal]) });
      if (closing) {
        await endpoint.dispose("cancel");
        closed();
      }
      return ownEndpoint(endpoint);
    });
    const transport: MemoryTransport = Object.freeze({
      sourceCommand: (command: unknown) => admit(() => worker.sourceCommand(command)),
      policyCommand: (command: unknown) => admit(() => worker.policyCommand(command)),
      recallCommand: (command: unknown) => admit(() => worker.recallCommand(command)),
      historyCommand: (command: unknown) => admit(() => worker.historyCommand(command)),
      contextCommand: (command: unknown) => admit(() => worker.contextCommand(command)),
      ...(worker.shadowCommand ? { shadowCommand: (command: unknown) => admit(() => worker.shadowCommand!(command)) } : {}),
    });
    return Object.freeze({
      transport,
      endpointFactory,
      close(): Promise<void> {
        if (closeResult) return closeResult;
        closing = true;
        // Publish the close promise before aborting: synchronous cancellation callbacks may reenter close().
        closeResult = Promise.resolve().then(async () => {
          const disposals = Promise.allSettled([...endpoints].map(endpoint => endpoint.dispose("cancel")));
          // Cancellation/rejected commands still retain ownership until the real operation settles.
          await Promise.allSettled([...operations]);
          const failures: unknown[] = (await disposals).flatMap(result => result.status === "rejected" ? [result.reason] : []);
          try { await worker.close(); }
          catch (error) { failures.push(error); }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "MEMORY_BACKEND_CLEANUP_FAILED");
        });
        lifetime.abort(Error(CLOSED));
        return closeResult;
      },
    });
  } catch (error) {
    try { await worker.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "MEMORY_BACKEND_INITIALIZATION_CLEANUP_FAILED"); }
    throw error;
  }
}
