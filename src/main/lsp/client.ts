import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import type { ResolvedLspServer } from "./server-discovery";

// 等待 initialize 应答的上限，超时后进程仍保留，由调用方决定是否释放。
const HANDSHAKE_LIMIT_MS = 45_000;
const DEFAULT_REQUEST_LIMIT_MS = 10_000;
const SHUTDOWN_LIMIT_MS = 2_000;

export interface LspChildProcess {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: "error" | "exit", listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface LspClientOptions {
  server: ResolvedLspServer;
  workspaceRoot: string;
  spawnImpl?: (command: string, args: string[], options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => LspChildProcess;
}

interface TrackedDocument {
  uri: string;
  version: number;
  content: string;
}

function launchWithNodeSpawn(
  command: string,
  args: string[],
  options: { cwd: string; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] },
): LspChildProcess {
  return spawn(command, args, options) as unknown as LspChildProcess;
}

function cancellationError(): Error {
  const error = new Error("LSP request cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * 给一个异步操作加上超时与取消。超时时以 message 作为错误文本；
 * 无论哪种结局都会清理计时器和 abort 监听。
 */
function bounded<T>(work: Promise<T>, limitMs: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancellationError());

  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined;

  const expiry = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), limitMs);
  });
  const cancellation = new Promise<T>((_, reject) => {
    if (!signal) return;
    const onAbort = (): void => reject(cancellationError());
    signal.addEventListener("abort", onAbort, { once: true });
    detach = () => signal.removeEventListener("abort", onAbort);
  });

  return Promise.race([work, expiry, cancellation]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    detach?.();
  });
}

function fileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

/** 一个工作区内单个外部 LSP 服务进程的 JSON-RPC 客户端。 */
export class LspClient {
  private readonly options: LspClientOptions;
  private readonly spawnImpl: NonNullable<LspClientOptions["spawnImpl"]>;
  private child: LspChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private readonly documents = new Map<string, TrackedDocument>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private initialized = false;
  private disposed = false;

  constructor(options: LspClientOptions) {
    this.options = options;
    this.spawnImpl = options.spawnImpl ?? launchWithNodeSpawn;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("LSP client has been disposed");

    const child = this.spawnServerProcess();
    const { stdin, stdout } = child;
    if (!stdin || !stdout) throw new Error("LSP server did not expose stdio pipes");

    const connection = createMessageConnection(stdout, stdin);
    this.installServerHandlers(connection);
    connection.listen();
    this.trackProcessHealth(child);

    this.child = child;
    this.connection = connection;
    await bounded(connection.sendRequest("initialize", this.initializeParams()), HANDSHAKE_LIMIT_MS, "LSP_INITIALIZE_TIMEOUT");
    connection.sendNotification("initialized", {});
    this.initialized = true;
  }

  async touchFile(filePath: string, languageId: string): Promise<void> {
    await this.initialize();
    const connection = this.connectionOrThrow();
    const absolutePath = path.resolve(filePath);
    const text = fs.readFileSync(absolutePath, "utf8");
    const uri = pathToFileURL(absolutePath).toString();
    const tracked = this.documents.get(uri);

    if (!tracked) {
      this.documents.set(uri, { uri, version: 1, content: text });
      connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    if (tracked.content === text) return;

    const nextVersion = tracked.version + 1;
    this.documents.set(uri, { uri, version: nextVersion, content: text });
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  }

  async request<T>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_LIMIT_MS, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw cancellationError();
    await this.initialize();
    const pending = this.connectionOrThrow().sendRequest(method, params);
    return bounded(pending, timeoutMs, "LSP_REQUEST_TIMEOUT", signal) as Promise<T>;
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    const current = this.diagnostics.get(fileUri(filePath)) ?? [];
    return [...current];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.connection && this.initialized) {
        await bounded(this.connection.sendRequest("shutdown"), SHUTDOWN_LIMIT_MS, "LSP shutdown timeout");
        this.connection.sendNotification("exit");
      }
    } catch {
      // 服务端可能已经先行退出，此时只需继续回收本地句柄。
    } finally {
      this.connection?.dispose();
      this.child?.kill();
      this.connection = null;
      this.child = null;
      this.initialized = false;
    }
  }

  private spawnServerProcess(): LspChildProcess {
    return this.spawnImpl(this.options.server.executablePath, [...this.options.server.args], {
      cwd: this.options.workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private installServerHandlers(connection: MessageConnection): void {
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri?: string; diagnostics?: Diagnostic[] }) => {
      if (typeof params?.uri !== "string") return;
      this.diagnostics.set(params.uri, [...(params.diagnostics ?? [])]);
    });
    // 客户端不提供额外配置、动态注册或进度 UI，统一以空应答满足协议。
    connection.onRequest("workspace/configuration", () => []);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
  }

  private trackProcessHealth(child: LspChildProcess): void {
    const markStale = (): void => {
      if (!this.disposed) this.initialized = false;
    };
    child.on("exit", markStale);
    child.on("error", markStale);
  }

  private initializeParams(): Record<string, unknown> {
    const rootUri = pathToFileURL(this.options.workspaceRoot).toString();
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.workspaceRoot) }],
      capabilities: { workspace: { configuration: true }, textDocument: {} },
      initializationOptions: this.options.server.definition.initializationOptions,
    };
  }

  private connectionOrThrow(): MessageConnection {
    if (!this.connection) throw new Error("LSP server is not initialized");
    return this.connection;
  }
}
