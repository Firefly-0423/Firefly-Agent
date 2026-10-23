import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "./client";
import { BUILTIN_LSP_SERVERS, findServerCandidates } from "./server-catalog";
import { resolveLspServer, type ResolvedLspServer } from "./server-discovery";
import { LspContractError, toProtocolPosition, type LspQuery, type LspServerOverride, type LspToolResult } from "./types";

export interface LspClientLike {
  initialize(): Promise<void>;
  touchFile(filePath: string, languageId: string): Promise<void>;
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  getDiagnostics(filePath: string): unknown[];
  dispose(): Promise<void>;
}

export interface LspManagerOptions {
  resolveServer?: (definition: ResolvedLspServer["definition"], workspaceRoot: string) => ResolvedLspServer | null;
  createClient?: (input: { server: ResolvedLspServer; workspaceRoot: string }) => LspClientLike;
  // 每次执行都重新读取覆盖配置，保存设置后无需重启服务。
  getServerOverrides?: () => readonly LspServerOverride[];
}

export interface LspExecutionContext {
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
}

interface DocumentPosition {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".c", "cpp"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".h", "cpp"],
  [".hpp", "cpp"],
]);

// 未登记的扩展名直接取去掉点号后的部分作为语言标识，没有扩展名时使用 plaintext。
function languageIdFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) ?? (extension.slice(1) || "plaintext");
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function positionedDocument(filePath: string, query: LspQuery): DocumentPosition {
  if (query.line === undefined || query.character === undefined) {
    throw new LspContractError("LSP_POSITION_INVALID", "该操作需要 line 和 character");
  }
  return {
    textDocument: { uri: pathToFileURL(filePath).toString() },
    position: toProtocolPosition({ line: query.line, character: query.character }),
  };
}

function clientKey(workspaceRoot: string, serverId: string, executablePath: string): string {
  return [workspaceRoot, serverId, executablePath].join("\u0000");
}

/** 复用同一可信工作区中同一外部语言服务进程的管理器。 */
export class LspManager {
  private readonly clients = new Map<string, LspClientLike>();
  private readonly resolveServer: NonNullable<LspManagerOptions["resolveServer"]>;
  private readonly createClient: NonNullable<LspManagerOptions["createClient"]>;
  private readonly getServerOverrides: NonNullable<LspManagerOptions["getServerOverrides"]>;

  constructor(options: LspManagerOptions = {}) {
    this.resolveServer = options.resolveServer ?? resolveLspServer;
    this.createClient = options.createClient ?? ((input) => new LspClient(input));
    this.getServerOverrides = options.getServerOverrides ?? (() => []);
  }

  async execute(query: LspQuery, context: LspExecutionContext): Promise<LspToolResult> {
    if (!context.resolvedWorkspaceRoot) {
      throw new LspContractError("LSP_WORKSPACE_REQUIRED", "Code 模式需要绑定可信工作目录");
    }
    const workspaceRoot = fs.realpathSync(context.resolvedWorkspaceRoot);
    const filePath = query.filePath ? this.resolveWorkspaceFile(workspaceRoot, query.filePath) : undefined;
    const { client, serverId } = await this.clientFor(workspaceRoot, filePath);

    if (filePath && query.operation !== "workspaceSymbol") {
      await client.touchFile(filePath, languageIdFor(filePath));
    }

    const value = await this.dispatch(client, query, filePath, context.signal);
    const items = Array.isArray(value) ? value : value == null ? [] : [value];
    return {
      serverId,
      operation: query.operation,
      workspaceRoot,
      items,
      message: items.length > 0 ? "已获得语言服务结果。" : "语言服务未返回结果。",
    };
  }

  async releaseWorkspace(workspaceRoot: string): Promise<void> {
    const prefix = `${fs.realpathSync(workspaceRoot)}\u0000`;
    const owned = [...this.clients].filter(([key]) => key.startsWith(prefix));
    await Promise.all(owned.map(async ([key, client]) => {
      this.clients.delete(key);
      await client.dispose();
    }));
  }

  async disposeAll(): Promise<void> {
    const everything = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(everything.map((client) => client.dispose()));
  }

  private async dispatch(
    client: LspClientLike,
    query: LspQuery,
    filePath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    // 非空断言沿用原有语义：只有需要文件的操作才会走到这里，缺失时由下游报错。
    const file = filePath!;
    switch (query.operation) {
      case "goToDefinition":
        return this.send(client, "textDocument/definition", positionedDocument(file, query), signal);
      case "findReferences":
        return this.send(client, "textDocument/references", { ...positionedDocument(file, query), context: { includeDeclaration: true } }, signal);
      case "hover":
        return this.send(client, "textDocument/hover", positionedDocument(file, query), signal);
      case "documentSymbol":
        return this.send(client, "textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).toString() } }, signal);
      case "workspaceSymbol":
        return this.send(client, "workspace/symbol", { query: query.query ?? "" }, signal);
      case "goToImplementation":
        return this.send(client, "textDocument/implementation", positionedDocument(file, query), signal);
      case "diagnostics":
        return client.getDiagnostics(file);
      case "prepareCallHierarchy":
        return this.send(client, "textDocument/prepareCallHierarchy", positionedDocument(file, query), signal);
      case "incomingCalls":
        return this.send(client, "callHierarchy/incomingCalls", { item: this.hierarchyItem(query) }, signal);
      case "outgoingCalls":
        return this.send(client, "callHierarchy/outgoingCalls", { item: this.hierarchyItem(query) }, signal);
      default:
        throw new LspContractError("LSP_UNSUPPORTED_OPERATION");
    }
  }

  private resolveWorkspaceFile(workspaceRoot: string, requestedPath: string): string {
    const lexical = path.resolve(workspaceRoot, requestedPath);
    if (!isWithin(workspaceRoot, lexical)) {
      throw new LspContractError("LSP_PATH_OUTSIDE_WORKSPACE", "文件路径不在绑定工作目录内");
    }
    if (!fs.existsSync(lexical)) throw new LspContractError("LSP_FILE_NOT_FOUND", "找不到请求的文件");
    const resolved = fs.realpathSync(lexical);
    if (!isWithin(workspaceRoot, resolved)) {
      throw new LspContractError("LSP_PATH_OUTSIDE_WORKSPACE", "文件真实路径不在绑定工作目录内");
    }
    return resolved;
  }

  private async clientFor(workspaceRoot: string, filePath?: string): Promise<{ client: LspClientLike; serverId: string }> {
    const overrides = this.getServerOverrides();
    const candidates = filePath ? findServerCandidates(filePath, overrides) : [...BUILTIN_LSP_SERVERS];
    for (const definition of candidates) {
      const server = this.resolveServer(definition, workspaceRoot);
      if (!server) continue;
      const client = this.reuseOrCreate(workspaceRoot, server);
      await client.initialize();
      return { client, serverId: server.definition.id };
    }
    throw new LspContractError("LSP_SERVER_NOT_FOUND", "没有找到可用的语言服务；请按提示安装或配置对应服务。");
  }

  private reuseOrCreate(workspaceRoot: string, server: ResolvedLspServer): LspClientLike {
    const key = clientKey(workspaceRoot, server.definition.id, server.executablePath);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = this.createClient({ server, workspaceRoot });
    this.clients.set(key, created);
    return created;
  }

  private hierarchyItem(query: LspQuery): Record<string, unknown> {
    const item = query.item;
    if (!item || Array.isArray(item) || Object.keys(item).length === 0) {
      throw new LspContractError("LSP_UNSUPPORTED_OPERATION", "调用层级后续查询需要 prepareCallHierarchy 返回的条目");
    }
    return item;
  }

  // 没有取消信号时保持两参数调用，避免下游把 undefined 当成显式超时参数。
  private send(client: LspClientLike, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return signal ? client.request(method, params, undefined, signal) : client.request(method, params);
  }
}
