import * as fs from "fs";
import * as path from "path";
import crypto from "node:crypto";
import { Worker, isMainThread, parentPort } from "worker_threads";
import { iterateDocumentChunks } from "./chunk";
import { createLocalEmbeddingProvider, createOpenAIEmbeddingProvider, type EmbeddingWorkerConfig } from "./embedding";
import { isBinary, isTextExt, isUnsupportedExt, SMALL_THRESHOLD } from "./file-ingest";
import type { DocumentIndexJobResult, QueuedDocumentIndexJob } from "./document-index-queue";

export type PreparedDocumentChunk = { index: number; text: string };

/** worker 准备阶段的结果：要么是待嵌入的大文档摘要，要么是无需索引的直接结果。 */
export type PreparedDocumentIndexResult =
  | Exclude<DocumentIndexJobResult, { kind: "indexed" }>
  | { kind: "prepared-indexed"; name: string; textSha256: string; totalChunks: number };

type PreparedMeta = Extract<PreparedDocumentIndexResult, { kind: "prepared-indexed" }>;
type PlainResult = Exclude<PreparedDocumentIndexResult, { kind: "prepared-indexed" }>;
type EmbeddedChunk = PreparedDocumentChunk & { embedding: number[] };

type WorkerPreparedDocument = PreparedMeta & {
  text: string;
};
type WorkerPrepareFileResult = WorkerPreparedDocument | PlainResult;

type WorkerCancelMessage = { type: "cancel" };
type WorkerEmbedMessage = { type: "embed"; embedding: EmbeddingWorkerConfig };
type WorkerStartMessage = { type: "start"; filePath: string; cancellationBuffer: SharedArrayBuffer };
type WorkerInboundMessage = WorkerCancelMessage | WorkerEmbedMessage | WorkerStartMessage;

export type WorkerOutboundMessage =
  | { type: "stage"; status: "reading" | "chunking"; completedChunks?: number; totalChunks?: number }
  | { type: "prepared"; result: PreparedMeta }
  | { type: "result"; result: PlainResult }
  | { type: "progress"; completedChunks: number; totalChunks: number }
  | { type: "embedded-batch"; chunks: Array<EmbeddedChunk> }
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; reason: string };

export interface DocumentIndexWorkerPort {
  terminate(): Promise<number>;
  on(event: "message" | "error" | "exit", listener: (...args: any[]) => void): unknown;
  postMessage(message: WorkerInboundMessage): void;
}

type CachedImport = { importId: string; chunkCount: number };
type PersistBatchInput = { fileName: string; importId: string; chunks: Array<EmbeddedChunk> };
type PutCacheInput = { textSha256: string; fileName: string; importId: string; chunkCount: number };

export type DocumentIndexWorkerRunnerDependencies = {
  createWorker: () => DocumentIndexWorkerPort;
  createImportId: () => string;
  getEmbeddingConfig: () => EmbeddingWorkerConfig;
  getCachedImport: (textSha256: string) => Promise<CachedImport | null>;
  persistPreparedBatch: (input: PersistBatchInput) => Promise<void>;
  putCache: (input: PutCacheInput) => Promise<void>;
};

const failureOf = (filePath: string, reason: string): DocumentIndexJobResult => ({
  kind: "error",
  name: path.basename(filePath),
  reason,
});

const cancelledOf = (filePath: string): DocumentIndexJobResult => failureOf(filePath, "cancelled");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ───────────── 主线程侧：调度 worker 并落库 ─────────────

export function createDocumentIndexWorkerRunner(deps: DocumentIndexWorkerRunnerDependencies) {
  return async (job: QueuedDocumentIndexJob): Promise<DocumentIndexJobResult> => new Promise((resolve) => {
    const { filePath } = job.input;
    const worker = deps.createWorker();
    const cancelFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let done = false;
    let meta: PreparedMeta | null = null;
    let importId: string | null = null;
    let stored = 0;
    let queue: Promise<void> = Promise.resolve();

    const finish = (result: DocumentIndexJobResult) => {
      if (done) return;
      done = true;
      meta = null;
      stopListening();
      void worker.terminate();
      resolve(result);
    };
    const requestCancel = () => {
      Atomics.store(cancelFlag, 0, 1);
      worker.postMessage({ type: "cancel" });
    };
    const stopListening = job.onCancel(requestCancel);
    // 任务已被取消则收尾并返回 true
    const bailIfCancelled = (): boolean => {
      if (!job.cancelled) return false;
      finish(cancelledOf(filePath));
      return true;
    };

    const dispatch = async (message: WorkerOutboundMessage): Promise<void> => {
      if (done) return;
      switch (message.type) {
        case "progress":
        case "stage": {
          const { completedChunks, totalChunks } = message;
          const status = message.type === "progress" ? "embedding" : message.status;
          job.reportProgress({ status, completedChunks, totalChunks });
          return;
        }
        case "cancelled":
          finish(cancelledOf(filePath));
          return;
        case "error":
          job.reportProgress({ status: "failed", reason: message.reason });
          finish(failureOf(filePath, message.reason));
          return;
        case "result": {
          const r = message.result;
          job.reportProgress(r.kind === "unsupported" ? { status: "failed", reason: r.reason } : { status: "done" });
          finish(r);
          return;
        }
        case "prepared": {
          const result = message.result;
          meta = result;
          if (bailIfCancelled()) return;
          let hit: CachedImport | null = null;
          try {
            hit = await deps.getCachedImport(result.textSha256);
          } catch (error) {
            console.warn("[RAG] document cache lookup failed:", error);
          }
          if (bailIfCancelled()) return;
          if (hit) {
            const counts = { completedChunks: hit.chunkCount, totalChunks: hit.chunkCount };
            job.reportProgress({ status: "cached", ...counts });
            job.reportProgress({ status: "done", ...counts });
            finish({ kind: "indexed", name: result.name, chunks: hit.chunkCount, importId: hit.importId, cached: true });
            return;
          }
          job.reportProgress({ status: "embedding", completedChunks: 0, totalChunks: result.totalChunks });
          worker.postMessage({ type: "embed", embedding: deps.getEmbeddingConfig() });
          return;
        }
        case "embedded-batch": {
          if (!meta || job.cancelled) {
            finish(cancelledOf(filePath));
            return;
          }
          importId ??= deps.createImportId();
          await deps.persistPreparedBatch({ fileName: meta.name, importId, chunks: message.chunks });
          stored += message.chunks.length;
          bailIfCancelled();
          return;
        }
        case "completed": {
          if (!meta || !importId || job.cancelled) {
            finish(cancelledOf(filePath));
            return;
          }
          try {
            await deps.putCache({ textSha256: meta.textSha256, fileName: meta.name, importId, chunkCount: stored });
          } catch (error) {
            console.warn("[RAG] document cache write failed:", error);
          }
          if (bailIfCancelled()) return;
          job.reportProgress({ status: "done", completedChunks: stored, totalChunks: stored });
          finish({ kind: "indexed", name: meta.name, chunks: stored, importId });
        }
      }
    };

    worker.on("message", (message: WorkerOutboundMessage) => {
      queue = queue
        .then(() => dispatch(message))
        .catch((error) => finish(failureOf(filePath, messageOf(error))));
    });
    worker.on("error", (error: Error) => finish(failureOf(filePath, error.message)));
    worker.on("exit", (code: number) => {
      if (!done && code !== 0) finish(failureOf(filePath, `document worker exited with code ${code}`));
    });
    worker.postMessage({ type: "start", filePath, cancellationBuffer: cancelFlag.buffer as SharedArrayBuffer });
  });
}

function defaultDependencies(): DocumentIndexWorkerRunnerDependencies {
  // 延迟 require，避免 worker 线程加载时拉起 electron 相关模块
  const cacheModule = () => require("./document-cache") as typeof import("./document-cache");
  const ragModule = () => require("./index") as typeof import("./index");

  return {
    createWorker: () => new Worker(__filename),
    getCachedImport: async (textSha256) => {
      const cache = cacheModule();
      const rag = ragModule();
      const identity = await cache.buildDocumentCacheIdentityFromTextSha(textSha256);
      return cache.getValidDocumentCacheRecord(cache.createDocumentCacheKey(identity), rag.hasImportedDocumentChunks);
    },
    getEmbeddingConfig: () => (require("./embedding") as typeof import("./embedding")).getEmbeddingWorkerConfig(),
    createImportId: () => {
      const suffix = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 8);
      return `import-${Date.now()}-${suffix}`;
    },
    persistPreparedBatch: async ({ fileName, importId, chunks }) => {
      await ragModule().appendPreparedDocumentBatch(
        fileName,
        importId,
        chunks.map(({ text, index, embedding }) => ({ text, chunkIndex: index, embedding })),
      );
    },
    putCache: async ({ textSha256, fileName, importId, chunkCount }) => {
      const cache = cacheModule();
      const key = cache.createDocumentCacheKey(await cache.buildDocumentCacheIdentityFromTextSha(textSha256));
      const createdAt = new Date().toISOString();
      await cache.putDocumentCacheRecord({ key, importId, chunkCount, fileName, createdAt });
    },
  };
}

export const runDocumentIndexJob = createDocumentIndexWorkerRunner(defaultDependencies());

type IndexedResult = Extract<DocumentIndexJobResult, { kind: "indexed" }>;
type RetrievedChunks = Awaited<ReturnType<typeof import("./index").searchImportedDocumentChunksForImportIds>>;

/** 对刚索引完成的文档按问题检索相关片段；问题为空时不检索。 */
export async function retrieveQueuedDocumentChunks(result: IndexedResult, query: string): Promise<RetrievedChunks | undefined> {
  if (query.trim() === "") return undefined;
  const { searchImportedDocumentChunksForImportIds } = require("./index") as typeof import("./index");
  return searchImportedDocumentChunksForImportIds(query, [result.importId]);
}

// ───────────── worker 线程侧：读文件、切块、向量化 ─────────────

function countDocumentChunks(text: string, source: string): number {
  let total = 0;
  for (const chunk of iterateDocumentChunks(text, source)) total = chunk.index + 1;
  return total;
}

function prepareFile(filePath: string): WorkerPrepareFileResult {
  const name = path.basename(filePath);
  const unsupported = (reason: string): PlainResult => ({ kind: "unsupported", name, reason });

  let info: fs.Stats;
  try {
    info = fs.statSync(filePath);
  } catch (error) {
    return unsupported(messageOf(error));
  }
  if (!info.isFile()) return unsupported("不是文件");

  const ext = path.extname(filePath).toLowerCase();
  if (isUnsupportedExt(ext)) return unsupported(`暂不支持的文件格式 ${ext}（MVP-0 仅支持文本）`);

  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (error) {
    return unsupported(messageOf(error));
  }
  if (isBinary(raw)) return unsupported("二进制文件，暂不支持");

  const text = raw.toString("utf-8");
  if (!text.trim()) return { kind: "empty", name };
  if (text.length <= SMALL_THRESHOLD) return { kind: "text", name, text };

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    kind: "prepared-indexed",
    name,
    textSha256: crypto.createHash("sha256").update(normalized, "utf8").digest("hex"),
    totalChunks: countDocumentChunks(text, "doc_" + name),
    text,
  };
}

const isFlagged = (flag: Int32Array | null): boolean => flag !== null && Atomics.load(flag, 0) === 1;

function embeddingProviderFor(config: EmbeddingWorkerConfig) {
  return config.provider === "openai-compat"
    ? createOpenAIEmbeddingProvider(config.baseUrl, config.apiKey, config.model)
    : createLocalEmbeddingProvider(config.modelKey);
}

const EMBED_BATCH_SIZE = 16;

async function runWorkerThread(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const emit = (message: WorkerOutboundMessage) => port.postMessage(message);

  let doc: WorkerPreparedDocument | null = null;
  let flag: Int32Array | null = null;

  const handleStart = (message: WorkerStartMessage) => {
    flag = new Int32Array(message.cancellationBuffer);
    emit({ type: "stage", status: "reading" });
    const result = prepareFile(message.filePath);

    if (isFlagged(flag)) {
      emit({ type: "cancelled" });
      return;
    }
    if (result.kind !== "prepared-indexed") {
      emit({ type: "result", result });
      return;
    }
    doc = result;
    const { totalChunks } = result;
    emit({ type: "stage", status: "chunking", completedChunks: totalChunks, totalChunks });
    emit({
      type: "prepared",
      result: {
        kind: "prepared-indexed",
        name: result.name,
        textSha256: result.textSha256,
        totalChunks: result.totalChunks,
      },
    });
  };

  const handleEmbed = async (message: WorkerEmbedMessage) => {
    if (!doc) throw new Error("document worker has no prepared document");
    const provider = embeddingProviderFor(message.embedding);
    if (!provider) throw new Error("Embedding provider is not available");

    const abort = () => {
      doc = null;
      emit({ type: "cancelled" });
    };
    let finished = 0;
    let pendingBatch: EmbeddedChunk[] = [];

    for (const chunk of iterateDocumentChunks(doc.text, "doc_" + doc.name)) {
      if (isFlagged(flag)) return abort();
      const embedding = await provider.embed(chunk.text);
      if (isFlagged(flag)) return abort();

      pendingBatch.push({ text: chunk.text, index: chunk.index, embedding });
      finished++;
      if (pendingBatch.length === EMBED_BATCH_SIZE || finished === doc.totalChunks) {
        emit({ type: "embedded-batch", chunks: pendingBatch });
        pendingBatch = [];
      }
      emit({ type: "progress", completedChunks: finished, totalChunks: doc.totalChunks });
    }
    doc = null;
    emit({ type: "completed" });
  };

  port.on("message", (message: WorkerInboundMessage) => {
    const work = async () => {
      if (message.type === "cancel") return;
      if (message.type === "start") return handleStart(message);
      await handleEmbed(message);
    };
    work().catch((error) => emit({ type: "error", reason: messageOf(error) }));
  });
}

if (!isMainThread) void runWorkerThread();
