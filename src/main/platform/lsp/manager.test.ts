import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspManager, type LspClientLike } from "./manager";
import type { ResolvedLspServer } from "./server-discovery";
import type { LspOperation, LspQuery, LspServerOverride } from "./types";

class RecordingClient implements LspClientLike {
  readonly requests: Array<{ method: string; params: any; extra: unknown[] }> = [];
  readonly touched: Array<{ file: string; lang: string }> = [];
  readonly initialize = vi.fn(async () => {});
  readonly dispose = vi.fn(async () => {});
  reply: unknown = null;
  diagnosticsReply: unknown[] = [];

  constructor(readonly server: ResolvedLspServer, readonly root: string) {}

  async touchFile(file: string, lang: string) {
    this.touched.push({ file, lang });
  }
  async request(method: string, params: unknown, ...extra: unknown[]) {
    this.requests.push({ method, params, extra });
    return this.reply;
  }
  getDiagnostics() {
    return this.diagnosticsReply;
  }
}

let base: string;
let ws: string;
let created: RecordingClient[];
let installed: Set<string>;
let overridesNow: LspServerOverride[];
/** 每次服务发现收到的 (服务 id, 工作区根)；成功路径也要看它，真实的解析器靠根目录找 node_modules/.bin。 */
let discoveryCalls: Array<{ id: string; root: string }>;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ff-lsp-mgr-")));
  ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "pkg", "main.ts"), "");
  fs.writeFileSync(path.join(ws, "util.h"), "");
  fs.writeFileSync(path.join(ws, "weird.zzz"), "");
  created = [];
  installed = new Set(["typescript-language-server", "clangd"]);
  overridesNow = [];
  discoveryCalls = [];
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function makeManager(spy?: { resolve?: ReturnType<typeof vi.fn> }) {
  return new LspManager({
    getServerOverrides: () => overridesNow,
    resolveServer: (definition, root) => {
      discoveryCalls.push({ id: definition.id, root });
      spy?.resolve?.(definition.id, root);
      if (!installed.has(definition.id)) return null;
      const exe = definition.commands[0].command;
      return { definition, executablePath: `/bin/${exe}`, args: definition.commands[0].args };
    },
    createClient: ({ server, workspaceRoot }) => {
      const c = new RecordingClient(server, workspaceRoot);
      created.push(c);
      return c;
    },
  });
}

const run = (m: LspManager, q: Partial<LspQuery> & { operation: LspOperation }, extra: { signal?: AbortSignal; root?: string | null } = {}) =>
  m.execute(q as LspQuery, {
    resolvedWorkspaceRoot: extra.root === null ? undefined : (extra.root ?? ws),
    signal: extra.signal,
  });

const failCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return e.code as string;
  }
  return "NO_ERROR";
};

describe("前置校验", () => {
  it("没有可信工作区时报 LSP_WORKSPACE_REQUIRED", async () => {
    expect(await failCode(run(makeManager(), { operation: "hover", filePath: "util.h", line: 1, character: 1 }, { root: null }))).toBe("LSP_WORKSPACE_REQUIRED");
  });

  it.each([
    ["相对路径向上越界", "../secret.ts"],
    ["绝对路径指向工作区之外", path.join(os.tmpdir(), "elsewhere.ts")],
    ["看似在内、实则回退出去", "pkg/../../x.ts"],
  ])("%s 时报 LSP_PATH_OUTSIDE_WORKSPACE，且不触发服务发现", async (_l, filePath) => {
    const resolve = vi.fn();
    const m = makeManager({ resolve });
    expect(await failCode(run(m, { operation: "documentSymbol", filePath }))).toBe("LSP_PATH_OUTSIDE_WORKSPACE");
    expect(resolve).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("文件不存在时报 LSP_FILE_NOT_FOUND", async () => {
    expect(await failCode(run(makeManager(), { operation: "documentSymbol", filePath: "pkg/nope.ts" }))).toBe("LSP_FILE_NOT_FOUND");
  });

  it("符号链接指向工作区外时被拒绝", async () => {
    const outside = path.join(base, "outside.ts");
    fs.writeFileSync(outside, "");
    try {
      fs.symlinkSync(outside, path.join(ws, "link.ts"));
    } catch {
      return; // 当前环境不允许创建符号链接
    }
    expect(await failCode(run(makeManager(), { operation: "documentSymbol", filePath: "link.ts" }))).toBe("LSP_PATH_OUTSIDE_WORKSPACE");
  });

  it("没有任何已安装服务时报 LSP_SERVER_NOT_FOUND", async () => {
    installed.clear();
    expect(await failCode(run(makeManager(), { operation: "documentSymbol", filePath: "pkg/main.ts" }))).toBe("LSP_SERVER_NOT_FOUND");
  });

  it("扩展名没有对应服务时报 LSP_SERVER_NOT_FOUND", async () => {
    expect(await failCode(run(makeManager(), { operation: "documentSymbol", filePath: "weird.zzz" }))).toBe("LSP_SERVER_NOT_FOUND");
  });

  it("需要位置的操作缺少 line 或 character 时报 LSP_POSITION_INVALID", async () => {
    const m = makeManager();
    expect(await failCode(run(m, { operation: "hover", filePath: "pkg/main.ts", character: 1 }))).toBe("LSP_POSITION_INVALID");
    expect(await failCode(run(m, { operation: "goToDefinition", filePath: "pkg/main.ts", line: 1 }))).toBe("LSP_POSITION_INVALID");
  });

  it("位置为 0 时同样被拒绝，且没有发出请求", async () => {
    const m = makeManager();
    expect(await failCode(run(m, { operation: "hover", filePath: "pkg/main.ts", line: 0, character: 1 }))).toBe("LSP_POSITION_INVALID");
    expect(created[0].requests).toEqual([]);
  });

  it("未知操作名报 LSP_UNSUPPORTED_OPERATION", async () => {
    expect(await failCode(run(makeManager(), { operation: "teleport" as LspOperation, filePath: "pkg/main.ts" }))).toBe("LSP_UNSUPPORTED_OPERATION");
  });
});

describe("服务发现收到的工作区根", () => {
  it("成功的请求把解析后的工作区根原样交给服务发现", async () => {
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    expect(discoveryCalls).toEqual([{ id: "typescript-language-server", root: ws }]);
  });

  it("换一个工作区根就以新的根做发现，不会沿用旧的", async () => {
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "a.h"), "");
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "util.h" });
    await run(m, { operation: "documentSymbol", filePath: "a.h" }, { root: other });
    expect(discoveryCalls.map((c) => c.root)).toEqual([ws, other]);
    expect(discoveryCalls.map((c) => c.id)).toEqual(["clangd", "clangd"]);
  });
});

describe("操作到协议方法的映射", () => {
  const uriOf = (rel: string) => pathToFileURL(path.join(ws, rel)).toString();

  it.each<[LspOperation, string]>([
    ["goToDefinition", "textDocument/definition"],
    ["hover", "textDocument/hover"],
    ["goToImplementation", "textDocument/implementation"],
    ["prepareCallHierarchy", "textDocument/prepareCallHierarchy"],
  ])("%s 发送 %s，并把 1 基坐标换成 0 基", async (operation, method) => {
    const m = makeManager();
    await run(m, { operation, filePath: "pkg/main.ts", line: 4, character: 9 });
    expect(created[0].requests).toEqual([
      { method, params: { textDocument: { uri: uriOf("pkg/main.ts") }, position: { line: 3, character: 8 } }, extra: [] },
    ]);
  });

  it("findReferences 同时请求声明本身", async () => {
    await run(makeManager(), { operation: "findReferences", filePath: "pkg/main.ts", line: 1, character: 1 });
    expect(created[0].requests[0].method).toBe("textDocument/references");
    expect(created[0].requests[0].params.context).toEqual({ includeDeclaration: true });
  });

  it("documentSymbol 只发送文档标识，不带位置", async () => {
    await run(makeManager(), { operation: "documentSymbol", filePath: "pkg/main.ts" });
    expect(created[0].requests[0]).toMatchObject({ method: "textDocument/documentSymbol", params: { textDocument: { uri: uriOf("pkg/main.ts") } } });
    expect(created[0].requests[0].params.position).toBeUndefined();
  });

  it("diagnostics 直接读取客户端缓存而不发请求", async () => {
    const m = makeManager();
    await run(m, { operation: "diagnostics", filePath: "pkg/main.ts" });
    created[0].diagnosticsReply = [{ message: "bad" }];
    const res = await run(m, { operation: "diagnostics", filePath: "pkg/main.ts" });
    expect(res.items).toEqual([{ message: "bad" }]);
    expect(created[0].requests).toEqual([]);
  });

  it("workspaceSymbol 使用 query，缺省为空串，且不触碰任何文件", async () => {
    const m = makeManager();
    await run(m, { operation: "workspaceSymbol", query: "Foo" });
    await run(m, { operation: "workspaceSymbol" });
    expect(created[0].requests.map((r) => [r.method, r.params])).toEqual([
      ["workspace/symbol", { query: "Foo" }],
      ["workspace/symbol", { query: "" }],
    ]);
    expect(created[0].touched).toEqual([]);
  });

  it.each<LspOperation>(["incomingCalls", "outgoingCalls"])("%s 原样转发 prepareCallHierarchy 得到的条目", async (operation) => {
    const item = { name: "run", kind: 12, uri: "file:///x", range: {}, selectionRange: {} };
    await run(makeManager(), { operation, filePath: "pkg/main.ts", item });
    const expectedMethod = operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    expect(created[0].requests[0]).toMatchObject({ method: expectedMethod, params: { item } });
  });

  it.each([
    ["缺少条目", undefined],
    ["空对象", {}],
    ["数组", [1] as unknown as Record<string, unknown>],
  ])("调用层级后续查询%s时报 LSP_UNSUPPORTED_OPERATION", async (_l, item) => {
    expect(await failCode(run(makeManager(), { operation: "incomingCalls", filePath: "pkg/main.ts", item }))).toBe("LSP_UNSUPPORTED_OPERATION");
  });
});

describe("结果整形", () => {
  it("返回服务标识、操作、真实工作区根与提示文字", async () => {
    const m = makeManager();
    created.length = 0;
    const res = await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    created[0].reply = null;
    expect(res).toMatchObject({ serverId: "typescript-language-server", operation: "documentSymbol", workspaceRoot: ws, items: [] });
    expect(res.message).toBe("语言服务未返回结果。");
  });

  it("数组结果原样作为 items，并给出成功提示", async () => {
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    created[0].reply = [{ a: 1 }, { b: 2 }];
    const res = await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    expect(res.items).toEqual([{ a: 1 }, { b: 2 }]);
    expect(res.message).toBe("已获得语言服务结果。");
  });

  it("单个对象结果被包成长度为 1 的数组", async () => {
    const m = makeManager();
    await run(m, { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 });
    created[0].reply = { contents: "int" };
    const res = await run(m, { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 });
    expect(res.items).toEqual([{ contents: "int" }]);
  });

  it("空数组结果仍给出“未返回结果”提示", async () => {
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    created[0].reply = [];
    const res = await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    expect(res.items).toEqual([]);
    expect(res.message).toBe("语言服务未返回结果。");
  });

  it("下游请求失败时错误原样向上传递", async () => {
    const m = makeManager();
    await run(m, { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 });
    created[0].request = async () => {
      throw new Error("server blew up");
    };
    await expect(run(m, { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 })).rejects.toThrow("server blew up");
  });
});

describe("文档同步与语言标识", () => {
  it.each([
    ["pkg/main.ts", "typescript"],
    ["util.h", "cpp"],
  ])("%s 使用语言标识 %s，并带真实路径触碰", async (rel, lang) => {
    await run(makeManager(), { operation: "documentSymbol", filePath: rel });
    expect(created[0].touched).toEqual([{ file: path.join(ws, rel), lang }]);
  });

  it("未登记扩展名时使用去点后的扩展名作语言标识", async () => {
    installed.add("yaml-language-server");
    fs.writeFileSync(path.join(ws, "c.yml"), "");
    await run(makeManager(), { operation: "documentSymbol", filePath: "c.yml" });
    expect(created[0].touched[0].lang).toBe("yml");
  });

  it("扩展名为大写时语言标识仍按小写处理", async () => {
    fs.writeFileSync(path.join(ws, "UP.TS"), "");
    await run(makeManager(), { operation: "documentSymbol", filePath: "UP.TS" });
    expect(created[0].touched[0].lang).toBe("typescript");
  });
});

describe("客户端复用与回收", () => {
  const q = { operation: "documentSymbol" as const, filePath: "pkg/main.ts" };

  it("同一工作区同一服务只创建一个客户端并复用", async () => {
    const m = makeManager();
    await run(m, q);
    await run(m, q);
    await run(m, { ...q, filePath: "pkg/main.ts" });
    expect(created).toHaveLength(1);
    expect(created[0].requests).toHaveLength(3);
  });

  it("每次取用前都会确保客户端已初始化", async () => {
    const m = makeManager();
    await run(m, q);
    await run(m, q);
    expect(created[0].initialize).toHaveBeenCalledTimes(2);
  });

  it("不同服务各自拥有客户端", async () => {
    const m = makeManager();
    await run(m, q);
    await run(m, { operation: "documentSymbol", filePath: "util.h" });
    expect(created.map((c) => c.server.definition.id)).toEqual(["typescript-language-server", "clangd"]);
  });

  it("不同工作区不共享客户端", async () => {
    const ws2 = path.join(base, "ws2");
    fs.mkdirSync(path.join(ws2, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(ws2, "pkg", "main.ts"), "");
    const m = makeManager();
    await run(m, q);
    await run(m, q, { root: ws2 });
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.root)).toEqual([ws, ws2]);
  });

  it("releaseWorkspace 只释放该工作区的客户端，之后重新创建", async () => {
    const ws2 = path.join(base, "ws2");
    fs.mkdirSync(path.join(ws2, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(ws2, "pkg", "main.ts"), "");
    const m = makeManager();
    await run(m, q);
    await run(m, q, { root: ws2 });
    await m.releaseWorkspace(ws);
    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expect(created[1].dispose).not.toHaveBeenCalled();
    await run(m, q);
    expect(created).toHaveLength(3);
    await run(m, q, { root: ws2 });
    expect(created).toHaveLength(3);
  });

  it("releaseWorkspace 对没有客户端的工作区是空操作", async () => {
    const m = makeManager();
    await expect(m.releaseWorkspace(ws)).resolves.toBeUndefined();
  });

  it("disposeAll 释放全部客户端，之后重新创建", async () => {
    const m = makeManager();
    await run(m, q);
    await run(m, { operation: "documentSymbol", filePath: "util.h" });
    await m.disposeAll();
    expect(created.every((c) => c.dispose.mock.calls.length === 1)).toBe(true);
    await run(m, q);
    expect(created).toHaveLength(3);
    await m.disposeAll();
    await m.disposeAll();
    expect(created[2].dispose).toHaveBeenCalledTimes(1);
  });

  it("workspaceSymbol 按内置表顺序选用第一个已安装的服务", async () => {
    installed = new Set(["gopls", "clangd"]);
    expect((await run(makeManager(), { operation: "workspaceSymbol", query: "x" })).serverId).toBe("gopls");
    installed = new Set(["clangd"]);
    expect((await run(makeManager(), { operation: "workspaceSymbol", query: "x" })).serverId).toBe("clangd");
  });
});

describe("用户覆盖与取消信号", () => {
  it("每次执行都重新读取覆盖项", async () => {
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    overridesNow = [{ id: "typescript-language-server", command: "my-tsls", args: ["--x"] }];
    await run(m, { operation: "documentSymbol", filePath: "pkg/main.ts" });
    expect(created).toHaveLength(2);
    expect(created[0].server.executablePath).toBe("/bin/typescript-language-server");
    expect(created[1].server.executablePath).toBe("/bin/my-tsls");
    expect(created[1].server.args).toEqual(["--x"]);
  });

  it("覆盖命令后，原来的客户端不会再被复用", async () => {
    overridesNow = [{ id: "clangd", command: "clangd-17" }];
    const m = makeManager();
    await run(m, { operation: "documentSymbol", filePath: "util.h" });
    expect(created[0].server.executablePath).toBe("/bin/clangd-17");
  });

  it("传入取消信号时作为第四个参数转发，超时参数留空", async () => {
    const ac = new AbortController();
    await run(makeManager(), { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 }, { signal: ac.signal });
    expect(created[0].requests[0].extra).toEqual([undefined, ac.signal]);
  });

  it("没有取消信号时只传两个参数", async () => {
    await run(makeManager(), { operation: "hover", filePath: "pkg/main.ts", line: 1, character: 1 });
    expect(created[0].requests[0].extra).toEqual([]);
  });
});
