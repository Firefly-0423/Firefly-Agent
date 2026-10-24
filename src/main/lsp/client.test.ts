import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspClient, type LspChildProcess } from "./client";
import type { ResolvedLspServer } from "./server-discovery";

interface ScriptedServer {
  proc: EventEmitter & LspChildProcess;
  rpc: MessageConnection;
  log: Array<{ kind: string; params: any }>;
}

/** 用内存管道模拟一个语言服务；hang 表示 initialize 永不应答。 */
function scriptedServer(opts: { hang?: boolean; slowMethod?: string; noPipes?: boolean; stuckShutdown?: boolean } = {}): ScriptedServer {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const emitter = new EventEmitter() as EventEmitter & LspChildProcess;
  Object.assign(emitter, {
    stdin: opts.noPipes ? null : toServer,
    stdout: opts.noPipes ? null : fromServer,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const rpc = createMessageConnection(toServer, fromServer);
  const log: ScriptedServer["log"] = [];
  rpc.onRequest("initialize", (params: unknown) => {
    log.push({ kind: "initialize", params });
    return opts.hang ? new Promise(() => {}) : { capabilities: {} };
  });
  rpc.onRequest("shutdown", () => {
    log.push({ kind: "shutdown", params: undefined });
    return opts.stuckShutdown ? new Promise(() => {}) : null;
  });
  rpc.onRequest("custom/echo", (params: unknown) => ({ echoed: params }));
  if (opts.slowMethod) rpc.onRequest(opts.slowMethod, () => new Promise(() => {}));
  for (const note of ["initialized", "exit", "textDocument/didOpen", "textDocument/didChange"]) {
    rpc.onNotification(note, (params: unknown) => log.push({ kind: note, params }));
  }
  rpc.listen();
  return { proc: emitter, rpc, log };
}

const entries = (s: ScriptedServer, kind: string) => s.log.filter((e) => e.kind === kind);

let tmp: string;
let src: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-lsp-cli-"));
  src = path.join(tmp, "a.ts");
  fs.writeFileSync(src, "let a = 1;\n");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function build(server: ScriptedServer, extra: Partial<ResolvedLspServer["definition"]> = {}) {
  const spawnImpl = vi.fn(() => server.proc);
  const resolved: ResolvedLspServer = {
    definition: { id: "scripted", extensions: [".ts"], commands: [], rootMarkers: [], installHint: "", ...extra },
    executablePath: "/usr/bin/scripted",
    args: ["--flag", "value"],
  };
  const client = new LspClient({ server: resolved, workspaceRoot: tmp, spawnImpl });
  return { client, spawnImpl };
}

describe("启动与握手", () => {
  it("用解析出的可执行文件、参数和安全选项启动进程", async () => {
    const server = scriptedServer();
    const { client, spawnImpl } = build(server);
    await client.initialize();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("/usr/bin/scripted");
    expect(args).toEqual(["--flag", "value"]);
    expect(options).toMatchObject({ cwd: tmp, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    await client.dispose();
  });

  it("initialize 请求携带工作区根、进程号与初始化选项，随后发送 initialized", async () => {
    const server = scriptedServer();
    const { client } = build(server, { initializationOptions: { preferences: { x: 1 } } });
    await client.initialize();
    await vi.waitFor(() => expect(entries(server, "initialized")).toHaveLength(1));
    const params = entries(server, "initialize")[0].params;
    const rootUri = pathToFileURL(tmp).toString();
    expect(params.rootUri).toBe(rootUri);
    expect(params.workspaceFolders).toEqual([{ uri: rootUri, name: path.basename(tmp) }]);
    expect(params.processId).toBe(process.pid);
    expect(params.initializationOptions).toEqual({ preferences: { x: 1 } });
    await client.dispose();
  });

  it("重复 initialize 与并发之后的请求只会启动一次进程", async () => {
    const server = scriptedServer();
    const { client, spawnImpl } = build(server);
    await client.initialize();
    await client.initialize();
    await client.request("custom/echo", 1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(entries(server, "initialize")).toHaveLength(1);
    await client.dispose();
  });

  it("进程没有 stdio 管道时报错", async () => {
    const { client } = build(scriptedServer({ noPipes: true }));
    await expect(client.initialize()).rejects.toThrow(/stdio/);
  });

  it("握手超过上限时以 LSP_INITIALIZE_TIMEOUT 失败", async () => {
    vi.useFakeTimers();
    const { client } = build(scriptedServer({ hang: true }));
    const outcome = client.initialize().then(
      () => "ok",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toBe("LSP_INITIALIZE_TIMEOUT");
  });

  it("释放后再初始化会被拒绝", async () => {
    const { client, spawnImpl } = build(scriptedServer());
    await client.dispose();
    await expect(client.initialize()).rejects.toThrow(/disposed/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("文档同步 touchFile", () => {
  it("首次触碰发送 didOpen，带语言标识、版本 1 与磁盘内容", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.touchFile(src, "typescript");
    await vi.waitFor(() => expect(entries(server, "textDocument/didOpen")).toHaveLength(1));
    expect(entries(server, "textDocument/didOpen")[0].params.textDocument).toEqual({
      uri: pathToFileURL(src).toString(),
      languageId: "typescript",
      version: 1,
      text: "let a = 1;\n",
    });
    await client.dispose();
  });

  it("内容未变时不重复发送任何通知", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.touchFile(src, "typescript");
    await client.touchFile(src, "typescript");
    await client.request("custom/echo", null);
    expect(entries(server, "textDocument/didOpen")).toHaveLength(1);
    expect(entries(server, "textDocument/didChange")).toHaveLength(0);
    await client.dispose();
  });

  it("每次内容变化发送整篇 didChange，版本递增", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.touchFile(src, "typescript");
    fs.writeFileSync(src, "let a = 2;\n");
    await client.touchFile(src, "typescript");
    fs.writeFileSync(src, "let a = 3;\n");
    await client.touchFile(src, "typescript");
    await client.request("custom/echo", null);
    const changes = entries(server, "textDocument/didChange").map((e) => e.params);
    expect(changes.map((c) => c.textDocument.version)).toEqual([2, 3]);
    expect(changes.map((c) => c.contentChanges)).toEqual([[{ text: "let a = 2;\n" }], [{ text: "let a = 3;\n" }]]);
    await client.dispose();
  });

  it("不同文件各自独立计版本", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    const other = path.join(tmp, "b.ts");
    fs.writeFileSync(other, "b");
    await client.touchFile(src, "typescript");
    await client.touchFile(other, "typescript");
    await client.request("custom/echo", null);
    const versions = entries(server, "textDocument/didOpen").map((e) => e.params.textDocument.version);
    expect(versions).toEqual([1, 1]);
    await client.dispose();
  });

  it("文件不存在时抛出读取错误，且不发送 didOpen", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await expect(client.touchFile(path.join(tmp, "missing.ts"), "typescript")).rejects.toThrow(/ENOENT/);
    await client.request("custom/echo", null);
    expect(entries(server, "textDocument/didOpen")).toHaveLength(0);
    await client.dispose();
  });
});

describe("请求", () => {
  it("返回服务端的应答内容", async () => {
    const { client } = build(scriptedServer());
    await expect(client.request("custom/echo", { n: 7 })).resolves.toEqual({ echoed: { n: 7 } });
    await client.dispose();
  });

  it("服务端没有处理的方法会以错误拒绝", async () => {
    const { client } = build(scriptedServer());
    await expect(client.request("custom/unknown", {})).rejects.toBeInstanceOf(Error);
    await client.dispose();
  });

  it("超过超时时间以 LSP_REQUEST_TIMEOUT 失败，且不关闭进程", async () => {
    const server = scriptedServer({ slowMethod: "custom/slow" });
    const { client } = build(server);
    await client.initialize();
    await expect(client.request("custom/slow", {}, 30)).rejects.toThrow("LSP_REQUEST_TIMEOUT");
    expect(server.proc.kill).not.toHaveBeenCalled();
    await expect(client.request("custom/echo", "still-alive")).resolves.toEqual({ echoed: "still-alive" });
    await client.dispose();
  });

  it("信号已取消时立即以 AbortError 拒绝，连进程都不启动", async () => {
    const { client, spawnImpl } = build(scriptedServer());
    const ac = new AbortController();
    ac.abort();
    await expect(client.request("custom/echo", 1, 1000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("请求进行中被取消时以 AbortError 拒绝，进程保持运行", async () => {
    const server = scriptedServer({ slowMethod: "custom/slow" });
    const { client } = build(server);
    await client.initialize();
    const ac = new AbortController();
    const pending = client.request("custom/slow", {}, 5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(server.proc.kill).not.toHaveBeenCalled();
    await client.dispose();
  });
});

describe("服务端主动消息", () => {
  it("记录 publishDiagnostics，并按文件区分", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    const diag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "boom" };
    await server.rpc.sendNotification("textDocument/publishDiagnostics", { uri: pathToFileURL(src).toString(), diagnostics: [diag] });
    await vi.waitFor(() => expect(client.getDiagnostics(src)).toHaveLength(1));
    expect(client.getDiagnostics(src)[0]).toMatchObject({ message: "boom" });
    expect(client.getDiagnostics(path.join(tmp, "other.ts"))).toEqual([]);
    await client.dispose();
  });

  it("后一次诊断整体覆盖前一次，空列表可以清除", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    const uri = pathToFileURL(src).toString();
    const mk = (message: string) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message });
    await server.rpc.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: [mk("one"), mk("two")] });
    await vi.waitFor(() => expect(client.getDiagnostics(src)).toHaveLength(2));
    await server.rpc.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: [] });
    await vi.waitFor(() => expect(client.getDiagnostics(src)).toEqual([]));
    await client.dispose();
  });

  it("getDiagnostics 返回副本，调用方修改不影响内部状态", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    const uri = pathToFileURL(src).toString();
    await server.rpc.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message: "m" }],
    });
    await vi.waitFor(() => expect(client.getDiagnostics(src)).toHaveLength(1));
    client.getDiagnostics(src).length = 0;
    expect(client.getDiagnostics(src)).toHaveLength(1);
    await client.dispose();
  });

  it("没有 uri 的诊断通知被忽略", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    await server.rpc.sendNotification("textDocument/publishDiagnostics", { diagnostics: [{ message: "x" }] });
    await client.request("custom/echo", null);
    expect(client.getDiagnostics(src)).toEqual([]);
    await client.dispose();
  });

  it("对 workspace/configuration、注册能力与进度创建给出空应答", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    await expect(server.rpc.sendRequest("workspace/configuration", { items: [{}] })).resolves.toEqual([]);
    await expect(server.rpc.sendRequest("client/registerCapability", { registrations: [] })).resolves.toBeNull();
    await expect(server.rpc.sendRequest("window/workDoneProgress/create", { token: 1 })).resolves.toBeNull();
    await client.dispose();
  });
});

describe("释放与进程故障", () => {
  it("dispose 依次发送 shutdown 与 exit，并终止进程", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    await client.dispose();
    await vi.waitFor(() => expect(entries(server, "exit")).toHaveLength(1));
    expect(entries(server, "shutdown")).toHaveLength(1);
    expect(server.log.findIndex((e) => e.kind === "shutdown")).toBeLessThan(server.log.findIndex((e) => e.kind === "exit"));
    expect(server.proc.kill).toHaveBeenCalledTimes(1);
  });

  it("dispose 可重复调用，只回收一次", async () => {
    const server = scriptedServer();
    const { client } = build(server);
    await client.initialize();
    await client.dispose();
    await client.dispose();
    expect(server.proc.kill).toHaveBeenCalledTimes(1);
    expect(entries(server, "shutdown")).toHaveLength(1);
  });

  it("从未启动过时 dispose 不会出错", async () => {
    const server = scriptedServer();
    const { client, spawnImpl } = build(server);
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(server.proc.kill).not.toHaveBeenCalled();
  });

  it("shutdown 无应答时 dispose 在约 2 秒后仍会杀掉进程", { timeout: 8000 }, async () => {
    const server = scriptedServer({ stuckShutdown: true });
    const { client } = build(server);
    await client.initialize();
    const started = Date.now();
    await client.dispose();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(server.proc.kill).toHaveBeenCalledTimes(1);
  });

  it("释放之后请求被拒绝", async () => {
    const { client } = build(scriptedServer());
    await client.initialize();
    await client.dispose();
    await expect(client.request("custom/echo", 1)).rejects.toThrow(/disposed/);
  });

  it("进程退出后下一次请求会重新拉起服务", async () => {
    const first = scriptedServer();
    const second = scriptedServer();
    const procs = [first.proc, second.proc];
    const spawnImpl = vi.fn(() => procs.shift()!);
    const client = new LspClient({
      server: { definition: { id: "s", extensions: [], commands: [], rootMarkers: [], installHint: "" }, executablePath: "srv", args: [] },
      workspaceRoot: tmp,
      spawnImpl,
    });
    await client.initialize();
    first.proc.emit("exit", 1);
    await expect(client.request("custom/echo", "again")).resolves.toEqual({ echoed: "again" });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await client.dispose();
  });
});
