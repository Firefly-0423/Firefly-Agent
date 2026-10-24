import { randomUUID } from "crypto";
import { basename } from "path";
import type { DocumentIndexJobStatus, DocumentIndexProgress } from "../../shared/document-index";
export type { DocumentIndexJobStatus, DocumentIndexProgress };

export type DocumentIndexJobResult =
  | { kind: "indexed"; name: string; chunks: number; importId: string; cached?: boolean }
  | { kind: "text"; name: string; text: string } | { kind: "empty"; name: string }
  | { kind: "unsupported"; name: string; reason: string } | { kind: "error"; name: string; reason: string };
export type EnqueueDocumentIndexJobInput = {
  filePath: string; query: string; onProgress: (progress: DocumentIndexProgress) => void;
};
export type QueuedDocumentIndexJob = {
  id: string; input: EnqueueDocumentIndexJobInput; cancelled: boolean;
  reportProgress: (progress: Omit<DocumentIndexProgress, "jobId" | "filePath" | "fileName">) => void;
  onCancel: (listener: () => void) => () => void;
};
export type DocumentIndexRunner = (job: QueuedDocumentIndexJob) => Promise<DocumentIndexJobResult>;
export type DocumentIndexJobHandle = { jobId: string; promise: Promise<DocumentIndexJobResult> };
export type DocumentIndexQueueStats = { activeJobId: string | null; pendingJobs: number; cancellationListeners: number };
type Task = QueuedDocumentIndexJob & {
  resolve: (result: DocumentIndexJobResult) => void; cancellationListeners: Set<() => void>;
};

function failure(task: QueuedDocumentIndexJob, reason: string): DocumentIndexJobResult {
  return { kind: "error", name: basename(task.input.filePath), reason };
}
function allocateTask(input: EnqueueDocumentIndexJobInput): { task: Task; promise: Promise<DocumentIndexJobResult> } {
  const id = randomUUID();
  let complete!: Task["resolve"];
  const promise = new Promise<DocumentIndexJobResult>((resolve) => { complete = resolve; });
  const fileName = basename(input.filePath);
  const observers = new Set<() => void>();
  const task: Task = {
    id, input, cancelled: false, resolve: complete, cancellationListeners: observers,
    reportProgress: (update) => input.onProgress({ jobId: id, filePath: input.filePath, fileName, ...update }),
    onCancel: (observer) => {
      if (task.cancelled) { observer(); return () => undefined; }
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
  return { task, promise };
}

export function createDocumentIndexQueue({ runner }: { runner: DocumentIndexRunner }) {
  const backlog: Task[] = [];
  let current: Task | null = null;

  async function advance(): Promise<void> {
    if (current) return;
    current = backlog.shift() ?? null;
    if (current === null) return;
    const task = current;
    try {
      const outcome = await runner(task);
      task.resolve(task.cancelled ? failure(task, "cancelled") : outcome);
    } catch (cause) {
      if (task.cancelled) task.resolve(failure(task, "cancelled"));
      else {
        const reason = cause instanceof Error ? cause.message : String(cause);
        task.reportProgress({ status: "failed", reason });
        task.resolve(failure(task, reason));
      }
    } finally {
      current = null;
      void advance();
    }
  }
  function enqueue(input: EnqueueDocumentIndexJobInput): DocumentIndexJobHandle {
    const { task, promise } = allocateTask(input);
    backlog.push(task);
    task.reportProgress({ status: "queued" });
    void advance();
    return { jobId: task.id, promise };
  }
  function cancel(jobId: string): boolean {
    const offset = backlog.findIndex((task) => task.id === jobId);
    if (offset >= 0) {
      const task = backlog.splice(offset, 1)[0];
      task.cancelled = true;
      task.reportProgress({ status: "cancelled" });
      task.resolve(failure(task, "cancelled"));
      return true;
    }
    if (current?.id !== jobId) return false;
    current.cancelled = true;
    for (const observer of current.cancellationListeners) observer();
    current.reportProgress({ status: "cancelled" });
    return true;
  }
  function getStats(): DocumentIndexQueueStats {
    return {
      activeJobId: current?.id ?? null, pendingJobs: backlog.length,
      cancellationListeners: (current?.cancellationListeners.size ?? 0)
        + backlog.reduce((count, task) => count + task.cancellationListeners.size, 0),
    };
  }
  return { enqueue, cancel, getStats };
}

let singleton = createDocumentIndexQueue({ runner: async (task) => failure(task, "document index queue is not configured") });
export function configureDocumentIndexQueue(runner: DocumentIndexRunner): void {
  singleton = createDocumentIndexQueue({ runner });
}
export function enqueueDocumentIndexJob(input: EnqueueDocumentIndexJobInput): Promise<DocumentIndexJobResult> {
  return singleton.enqueue(input).promise;
}
export function cancelDocumentIndexJob(jobId: string): boolean { return singleton.cancel(jobId); }
export function getDocumentIndexQueueStats(): DocumentIndexQueueStats { return singleton.getStats(); }
