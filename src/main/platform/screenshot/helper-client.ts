import { randomUUID } from "node:crypto";
import { parseHelperEvent, resolveCompletedFile } from "./protocol";
import type { HelperEvent, ScreenshotMode } from "./protocol";

export type { ScreenshotMode } from "./protocol";

export type HelperProcessState = "ready" | "starting" | "restarting" | "stopping" | "stopped" | "unavailable";
export type CaptureState = "committing" | "selected" | "selecting" | "freezing" | "idle";
export type HelperInteractionState = "selecting" | "selected" | "committing";

type RequestSource = "hotkey" | "chat-button";

export interface PendingRequest {
  requestId: string;
  mode: ScreenshotMode;
  source: RequestSource;
  captureReleased: boolean;
  startedAt: number;
}

export interface ScreenshotResult {
  requestId: string;
  mime: "image/png";
  filePath: string | null;
  height: number;
  width: number;
  hasAnnotations: boolean;
  clipboardWritten: boolean;
}

export interface ScreenshotHelperClient {
  ensureStarted(): Promise<void>;
  start(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult>;
  cancel(requestId: string): void;
  shutdown(): Promise<void>;
  readonly pendingRequests: ReadonlyMap<string, PendingRequest>;
  readonly captureState: CaptureState;
  readonly processState: HelperProcessState;
}

type ChunkHandler = (chunk: Buffer | string) => void;
type LifecycleHandler = (...args: unknown[]) => void;

export interface HelperChildProcess {
  stdin: {
    write(line: string): boolean;
    // 真实子进程的 stdin 是流，管道断开时错误经由 'error' 事件送达；测试替身可以不提供。
    on?(event: "error", listener: (error: Error) => void): unknown;
    readonly destroyed?: boolean;
  };
  stdout: { on(event: "data", listener: ChunkHandler): unknown };
  stderr?: { on(event: "data", listener: ChunkHandler): unknown };
  on(event: "error" | "exit", listener: LifecycleHandler): unknown;
}

export type ScreenshotHelperClientOptions = {
  logger?: Pick<Console, "debug" | "warn" | "error">;
  createRequestId?: () => string;
  now?: () => number;
  parentProcessId?: number;
  screenshotDirectory: string;
  resolveHelperPath(): string;
  spawnImpl(command: string, args: string[]): HelperChildProcess;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function createDeferred<T>(): Deferred<T> {
  let settleOk: (value: T) => void = () => undefined;
  let settleErr: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((ok, err) => {
    settleOk = ok;
    settleErr = err;
  });
  return {
    promise,
    resolve: (value) => settleOk(value),
    reject: (error) => settleErr(error),
  };
}

const PROTOCOL_VERSION = 1;

export class ElectronScreenshotHelperClient implements ScreenshotHelperClient {
  private helperState: HelperProcessState = "stopped";
  private captureMode: CaptureState = "idle";
  private readonly inFlight = new Map<string, PendingRequest>();
  private readonly waiters = new Map<string, Deferred<ScreenshotResult>>();
  private helper: HelperChildProcess | null = null;
  private interactiveRequestId: string | null = null;
  private lineBuffer = "";
  private readyGate: Deferred<void> | null = null;
  private exitHandled = false;

  constructor(private readonly options: ScreenshotHelperClientOptions) {}

  get processState(): HelperProcessState {
    return this.helperState;
  }

  get captureState(): CaptureState {
    return this.captureMode;
  }

  get pendingRequests(): ReadonlyMap<string, PendingRequest> {
    return this.inFlight;
  }

  ensureStarted(): Promise<void> {
    if (this.helperState === "ready") return Promise.resolve();
    if (this.helperState === "starting" && this.readyGate) return this.readyGate.promise;

    this.helperState = "starting";
    this.exitHandled = false;
    this.readyGate = createDeferred<void>();

    try {
      const child = this.options.spawnImpl(this.options.resolveHelperPath(), [
        "--output-dir", this.options.screenshotDirectory,
        "--protocol-version", String(PROTOCOL_VERSION),
        "--parent-pid", String(this.options.parentProcessId ?? process.pid),
      ]);
      this.helper = child;
      this.wireChild(child);
    } catch (error) {
      this.handleExit(error instanceof Error ? error : new Error("HELPER_START_FAILED"));
    }
    // 同步失败路径下 handleExit 已清空 readyGate，这里保留既有的 null 返回值。
    return (this.readyGate?.promise ?? null) as Promise<void>;
  }

  start(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult> {
    if (this.helperState === "ready") return this.beginRequest(mode, source);
    return this.ensureStarted().then(() => this.beginRequest(mode, source));
  }

  cancel(requestId: string): void {
    if (!this.inFlight.has(requestId) || !this.helper) return;
    this.send({ type: "cancel", requestId });
  }

  async shutdown(): Promise<void> {
    if (!this.helper) {
      this.helperState = "stopped";
      return;
    }
    this.helperState = "stopping";
    this.send({ type: "shutdown" });
  }

  private wireChild(child: HelperChildProcess): void {
    // 管道在 helper 先退出时会立即断开，而 'exit' 要稍后才到。这里挂的监听器只负责吞掉
    // 异步 EPIPE（否则 Node 会升级为 uncaughtException），真正的收尾交给 handleExit。
    child.stdin.on?.("error", (error) => {
      this.options.logger?.debug("[ScreenshotHelper] stdin 写入失败（helper 可能已退出）:", error);
    });
    child.stdout.on("data", (chunk) => this.ingest(chunk.toString()));
    child.stderr?.on("data", (chunk) => this.options.logger?.debug("[ScreenshotHelper stderr]", chunk.toString()));
    child.on("error", (error) => this.handleExit(error instanceof Error ? error : new Error("HELPER_PROCESS_ERROR")));
    child.on("exit", (code) => this.handleExit(new Error(`HELPER_EXITED${typeof code === "number" ? `:${code}` : ""}`)));
  }

  private beginRequest(mode: ScreenshotMode, source: PendingRequest["source"]): Promise<ScreenshotResult> {
    if (!this.helper || this.helperState !== "ready") return Promise.reject(new Error("HELPER_NOT_READY"));

    const requestId = (this.options.createRequestId ?? randomUUID)();
    const startedAt = (this.options.now ?? Date.now)();
    const pending: PendingRequest = { requestId, startedAt, mode, source, captureReleased: false };
    this.inFlight.set(requestId, pending);
    this.interactiveRequestId = requestId;
    this.captureMode = "freezing";

    const waiter = createDeferred<ScreenshotResult>();
    this.waiters.set(requestId, waiter);
    this.send({ type: "start", requestId, mode });
    return waiter.promise;
  }

  /**
   * 向 helper 的 stdin 写一条命令。helper 已退出时写入没有意义，因此三层防护：
   * 已知断开就不写；同步抛错就吞掉并记录；异步 EPIPE 由 wireChild 里的 error 监听器兜底。
   */
  private send(command: Record<string, unknown>): void {
    const stdin = this.helper?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.options.logger?.debug("[ScreenshotHelper] 写入命令失败（helper 可能已退出）:", error);
    }
  }

  private ingest(chunk: string): void {
    this.lineBuffer += chunk;
    let cut = this.lineBuffer.indexOf("\n");
    while (cut >= 0) {
      const line = this.lineBuffer.slice(0, cut).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(cut + 1);
      if (line) this.dispatchLine(line);
      cut = this.lineBuffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    try {
      this.onEvent(parseHelperEvent(line));
    } catch (error) {
      this.options.logger?.warn("[ScreenshotHelper] ignored invalid event", error);
    }
  }

  private onEvent(event: HelperEvent): void {
    if (event.type === "ready") return this.onHelperReady(event.protocolVersion);
    if (event.type === "interaction-state") return this.onInteractionState(event.requestId, event.state);
    if (event.type === "capture-released") return this.onCaptureReleased(event.requestId);
    if (event.type === "completed") return this.onCompleted(event);
    if (event.type === "cancelled") return this.failWaiter(event.requestId, new Error(`SCREENSHOT_CANCELLED:${event.reason}`));
    if (event.type === "error") return this.onErrorEvent(event.requestId, event.code, event.message);
    // accepted 与 overlay-visible 目前不影响状态。
  }

  private onHelperReady(protocolVersion: number): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.handleExit(new Error("INCOMPATIBLE_HELPER_PROTOCOL"));
      return;
    }
    this.helperState = "ready";
    this.readyGate?.resolve();
    this.dropReadyGate();
  }

  private onInteractionState(requestId: string, state: HelperInteractionState): void {
    if (requestId === this.interactiveRequestId && this.inFlight.has(requestId)) {
      this.captureMode = state;
    }
  }

  private onCaptureReleased(requestId: string): void {
    const request = this.inFlight.get(requestId);
    if (!request) return;
    request.captureReleased = true;
    if (requestId === this.interactiveRequestId) this.releaseInteraction();
  }

  private onCompleted(event: Extract<HelperEvent, { type: "completed" }>): void {
    const waiter = this.waiters.get(event.requestId);
    if (!waiter) return;
    this.retire(event.requestId);
    try {
      const { requestId, fileName, width, height, mime, clipboardWritten, hasAnnotations } = event;
      const filePath = fileName === null
        ? null
        : resolveCompletedFile(this.options.screenshotDirectory, fileName);
      waiter.resolve({ hasAnnotations, clipboardWritten, mime, height, width, filePath, requestId });
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error("INVALID_SCREENSHOT_FILE_NAME"));
    }
  }

  private onErrorEvent(requestId: string | null | undefined, code: string, message: string): void {
    if (requestId) {
      this.failWaiter(requestId, new Error(`${code}: ${message}`));
    } else {
      this.options.logger?.error("[ScreenshotHelper]", code, message);
    }
  }

  private failWaiter(requestId: string, error: Error): void {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return;
    this.retire(requestId);
    waiter.reject(error);
  }

  private retire(requestId: string): void {
    this.inFlight.delete(requestId);
    this.waiters.delete(requestId);
    if (this.interactiveRequestId === requestId) this.releaseInteraction();
  }

  private releaseInteraction(): void {
    this.interactiveRequestId = null;
    this.captureMode = "idle";
  }

  private handleExit(error: Error): void {
    if (this.exitHandled) return;
    this.exitHandled = true;

    const wasStopping = this.helperState === "stopping";
    this.helper = null;
    this.helperState = wasStopping ? "stopped" : "unavailable";
    this.releaseInteraction();

    this.readyGate?.reject(error);
    this.dropReadyGate();
    for (const requestId of [...this.waiters.keys()]) {
      this.failWaiter(requestId, error);
    }
  }

  private dropReadyGate(): void {
    this.readyGate = null;
  }
}
