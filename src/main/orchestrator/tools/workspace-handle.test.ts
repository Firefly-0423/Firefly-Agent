import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./registry/tool-context";
const { live, guard } = vi.hoisted(() => ({ live: { level: "full" }, guard: vi.fn() }));
vi.mock("../../permission", () => ({ getCurrentLevel: () => live.level }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "C:\\app" } }));
vi.mock("./workspace-boundary", async original => ({ ...await original<typeof import("./workspace-boundary")>(), assertWorkspaceBoundary: guard }));
import { createWorkspaceHandleBridge, workspaceHelperPath } from "./workspace-handle";

const root = "C:\\workspace", file = root + "\\file.txt";
const ctx = (level: ToolContext["fileAccessLevel"]): ToolContext => ({ userQuery: "test", resolvedWorkspaceRoot: root, fileAccessLevel: level });
const wire = (text = "before") => ({ exists: true, kind: "file", size: Buffer.byteLength(text), identity: { deviceId: "00000000000000000000000000000007", fileId: "0000000000000000123456789abcdef0" }, canonicalPath: file, bytesHex: Buffer.from(text).toString("hex") });
function processMock(reply: (command: Record<string, unknown>, send: (v: unknown) => void, child: EventEmitter) => void, ready: unknown = { type: "ready", version: 1 }) {
  const output = new PassThrough(), errors = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const commands: Record<string, unknown>[] = [];
  const send = (v: unknown) => output.write(JSON.stringify(v) + "\n");
  const input = new Writable({ write(bytes, _encoding, done) {
    const command = JSON.parse(bytes.toString()); commands.push(command);
    queueMicrotask(() => {
      if (command.type === "release") { send({ type: "released", version: 1 }); output.end(); child.emit("close", 0); }
      else reply(command, send, child);
    }); done();
  } });
  Object.assign(child, { stdin: input, stdout: output, stderr: errors, kill: vi.fn(() => { queueMicrotask(() => child.emit("close", null)); return true; }) });
  const start = vi.fn(() => { if (ready !== null) queueMicrotask(() => send(ready)); return child; });
  const bridge = createWorkspaceHandleBridge({ platform: "win32", spawn: start as unknown as typeof spawn, resolveBinary: () => "C:\\app\\bin\\firefly-workspace.exe", timeoutMs: 50 });
  return { bridge, child, start, commands, output, send };
}
afterEach(() => { live.level = "full"; guard.mockReset(); vi.restoreAllMocks(); });
describe("workspace helper transport and policy", () => {
  it.each(["reparse-point", "hard-link", "outside-root", "missing", "io"])("preserves the typed native reason %s", async reason => {
    const p = processMock((_c, send) => send({ type: "error", version: 1, code: "workspace-boundary", reason }));
    await expect(p.bridge.readFile(file, ctx("project-read-only"))).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", reason });
    expect(p.start).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "invented", 1])("rejects an invalid native error reason %s", async reason => {
    const p = processMock((_c, send) => send({ type: "error", version: 1, code: "workspace-boundary", reason }));
    await expect(p.bridge.readFile(file, ctx("project-read-only"))).rejects.toMatchObject({ reason: "protocol" });
  });
  it.each(["read", "image", "preimage", "list"])("reader_writer_contention_is_not_boundary: %s recovers", async operation => {
    let attempts = 0;
    const p = processMock((_c, send) => {
      if (++attempts < 3) send({ type: "error", version: 1, code: "workspace-busy", reason: "sharing-violation" });
      else if (operation === "list") send({ type: "entries", version: 1, entries: [] });
      else send({ type: "snapshot", version: 1, snapshot: wire("after writer") });
    });
    const result = operation === "list" ? await p.bridge.listDirectory(root, ctx("project-read-only"))
      : await p.bridge.readFile(file, ctx(operation === "preimage" ? "scoped" : "project-read-only"), operation === "image" ? 5 * 1024 * 1024 : 100, operation === "preimage" ? "write" : "read");
    if (operation === "list") expect(result).toEqual([]);
    else expect(result).toMatchObject({ bytes: Buffer.from("after writer") });
    expect(p.start).toHaveBeenCalledTimes(3);
  });
  it("reader_writer_contention_is_not_boundary", async () => {
    vi.useFakeTimers();
    try {
      const p = processMock((_c, send) => send({ type: "error", version: 1, code: "workspace-busy", reason: "sharing-violation" }));
      const check = expect(p.bridge.readFile(file, ctx("project-read-only"))).rejects.toMatchObject({ code: "E_WORKSPACE_BUSY", reason: "sharing-violation", effectState: "not_applied" });
      void check.catch(() => undefined);
      const start = Date.now();
      await vi.runAllTimersAsync(); await check;
      expect(p.start).toHaveBeenCalledTimes(5);
      expect(Date.now() - start).toBeLessThan(300);
    } finally { vi.useRealTimers(); }
  });
  it("never retries a busy write lease", async () => {
    const p = processMock((_c, send) => send({ type: "error", version: 1, code: "workspace-busy", reason: "sharing-violation" }));
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, async () => { throw Error("must not run"); })).rejects.toMatchObject({ code: "E_WORKSPACE_BUSY", reason: "sharing-violation" });
    expect(p.start).toHaveBeenCalledTimes(1);
  });
  it("does not start another helper after a delayed backoff exceeds the retry budget", async () => {
    vi.useFakeTimers();
    try {
      const p = processMock((_c, send) => send({ type: "error", version: 1, code: "workspace-busy", reason: "sharing-violation" }));
      const check = expect(p.bridge.readFile(file, ctx("project-read-only"))).rejects.toMatchObject({ code: "E_WORKSPACE_BUSY", reason: "sharing-violation" });
      void check.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + 300);
      await vi.advanceTimersByTimeAsync(40);
      await check;
      expect(p.start).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { cause: "timeout", name: "timeout_after_commit_reports_unknown_effects" },
    { cause: "abort", name: "abort_after_commit_reports_unknown_effects" },
  ])("$name", async ({ cause }) => {
    const controller = new AbortController();
    const p = processMock((c, send) => {
      if (c.type !== "commit") send({ type: "snapshot", version: 1, snapshot: wire() });
      else if (cause === "abort") controller.abort();
    });
    await expect(p.bridge.withWrite(file, { ...ctx("scoped"), signal: controller.signal }, false, lease => lease!.commit(Buffer.from("x"), "replace")))
      .rejects.toMatchObject({ code: "E_WORKSPACE_UNKNOWN_EFFECTS", reason: cause === "abort" ? "aborted" : "timeout", effectState: "unknown" });
    expect(p.child.kill).toHaveBeenCalled();
    expect(p.commands.filter(c => c.type === "commit")).toHaveLength(1);
    expect(p.start).toHaveBeenCalledTimes(1);
  });
  it("invalid after-image reports possibly written content", async () => {
    const p = processMock((c, send) => send({ type: "snapshot", version: 1, snapshot: c.type === "commit" ? { ...wire(), size: 99 } : wire() }));
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, lease => lease!.commit(Buffer.from("x"), "replace")))
      .rejects.toMatchObject({ code: "E_WORKSPACE_UNKNOWN_EFFECTS", reason: "protocol", effectState: "unknown" });
  });
  it("returns the exact native bytes and releases only after clean acknowledgement and exit", async () => {
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: wire("native") }));
    const value = await p.bridge.readFile(file, ctx("project-read-only"), 100);
    expect(value?.bytes?.toString()).toBe("native");
    expect(p.commands).toEqual([{ type: "read", version: 1, components: ["file.txt"], maxBytes: 100 }, { type: "release", version: 1 }]);
    expect(p.start).toHaveBeenCalledWith("C:\\app\\bin\\firefly-workspace.exe", ["--root", root, "--parent-pid", String(process.pid), "--deadline-ms", "50"], expect.objectContaining({ shell: false, windowsHide: true }));
    expect(guard).not.toHaveBeenCalled();
  });
  it("keeps the prepared lease until commit and sends replacement without a path", async () => {
    const p = processMock((c, send) => send({ type: "snapshot", version: 1, snapshot: wire(c.type === "commit" ? "after" : "before") }));
    const after = await p.bridge.withWrite(file, ctx("scoped"), true, async lease => {
      expect(lease?.before.bytes?.toString()).toBe("before");
      return lease!.commit(Buffer.from("after"), "replace");
    });
    expect(after.bytes?.toString()).toBe("after");
    expect(p.commands).toEqual([{ type: "prepare-write", version: 1, components: ["file.txt"], createParents: true }, { type: "commit", version: 1, mode: "replace", bytesHex: "6166746572" }, { type: "release", version: 1 }]);
  });
  it.each(["spawn", "exit", "timeout", "invalid-json", "extra-field", "wrong-version", "invalid-bytes", "wrong-size", "native-error", "unsupported", "unsolicited", "partial-line"])("fails closed on %s without a path fallback", async kind => {
    const p = processMock((_c, send, child) => {
      if (kind === "exit") { child.emit("close", 7); return; }
      if (kind === "timeout") return;
      if (kind === "invalid-json") { p.output.write("bad\n"); return; }
      if (kind === "partial-line") { p.output.write("{"); p.output.end(); child.emit("close", 0); return; }
      if (kind === "native-error" || kind === "unsupported") { send({ type: "error", version: 1, code: kind === "unsupported" ? "workspace-unsupported-platform" : "workspace-boundary" }); return; }
      send({ type: "snapshot", version: kind === "wrong-version" ? 2 : 1,
        snapshot: { ...wire(), ...(kind === "invalid-bytes" ? { bytesHex: "ffx" } : {}), ...(kind === "wrong-size" ? { size: 99 } : {}) }, ...(kind === "extra-field" ? { extra: 1 } : {}) });
      if (kind === "unsolicited") send({ type: "snapshot", version: 1, snapshot: wire() });
    });
    if (kind === "spawn") p.start.mockImplementationOnce(() => { throw Error("ENOENT"); });
    await expect(p.bridge.readFile(file, ctx("project-read-only"))).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", category: "permission_denied" });
    expect(guard).not.toHaveBeenCalled();
  });
  it("marks uncertain commit failure unknown and never retries a write", async () => {
    const p = processMock((c, send, child) => { if (c.type === "commit") child.emit("close", 8); else send({ type: "snapshot", version: 1, snapshot: wire() }); });
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, lease => lease!.commit(Buffer.from("x"), "append"))).rejects.toMatchObject({ code: "E_WORKSPACE_UNKNOWN_EFFECTS", effectState: "unknown" });
    expect(p.commands.filter(c => c.type === "commit")).toHaveLength(1);
  });
  it("rechecks live read-only downgrades before commit", async () => {
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: wire() }));
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, async lease => { live.level = "read-only"; return lease!.commit(Buffer.from("x"), "replace"); }))
      .rejects.toMatchObject({ code: "E_FILESYSTEM_READ_ONLY" });
    expect(p.commands.some(c => c.type === "commit")).toBe(false);
  });
  it("inherits the live-level intersection but allow_all full bypasses it", async () => {
    live.level = "project-read-only";
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: wire() }));
    expect((await p.bridge.readFile(file, ctx("full")))?.exists).toBe(true);
    const unrestricted = { ...ctx("full"), permissionMode: "allow_all" as const };
    expect(await p.bridge.readFile(file, unrestricted)).toBeUndefined();
  });
  it.each(["linux", "darwin"] as const)("exposes unsupported %s and uses the existing guard", async platform => {
    const start = vi.fn(); const b = createWorkspaceHandleBridge({ platform, spawn: start as unknown as typeof spawn });
    const file = "/workspace/file.txt", readContext = { ...ctx("project-read-only"), resolvedWorkspaceRoot: "/workspace" }, writeContext = { ...ctx("scoped"), resolvedWorkspaceRoot: "/workspace" };
    expect(b.support).toEqual({ supported: false, code: "workspace-unsupported-platform" });
    expect(await b.readFile(file, readContext)).toBeUndefined();
    expect(await b.withWrite(file, writeContext, false, async lease => lease)).toBeUndefined();
    expect(guard).toHaveBeenCalledWith(file, "read", expect.anything()); expect(guard).toHaveBeenCalledWith(file, "write", expect.anything()); expect(start).not.toHaveBeenCalled();
  });
  it.each([undefined, "full", "per-action", "read-only", "scoped"] as const)("does not spawn for unrestricted read level %s", async level => {
    const p = processMock(() => { throw Error("unexpected"); });
    expect(await p.bridge.readFile(file, ctx(level))).toBeUndefined(); expect(p.start).not.toHaveBeenCalled();
  });
  it.each(["C:\\workspace-other\\file", "C:\\workspace\\file:stream", "C:\\workspace\\CON", "C:\\workspace\\bad.", "\\\\server\\workspace\\file"])("rejects unsafe Windows target %s before spawn", async target => {
    const p = processMock(() => {});
    await expect(p.bridge.readFile(target, ctx("project-read-only"))).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY" }); expect(p.start).not.toHaveBeenCalled();
  });
  it("aborts a lease without commit and preserves callback errors", async () => {
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: wire() }));
    const failure = Error("overwrite denied");
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, async () => { throw failure; })).rejects.toBe(failure);
    expect(p.commands.some(c => c.type === "commit")).toBe(false);
  });
  it("resolves packaged resources without using an asar path", () => {
    const resources = path.resolve("fixture", "resources"), repository = path.resolve("fixture", "repo");
    expect(workspaceHelperPath({ isPackaged: true, getAppPath: () => { throw Error("asar"); } }, resources)).toBe(path.join(resources, "bin", "firefly-workspace.exe"));
    expect(workspaceHelperPath({ isPackaged: false, getAppPath: () => repository }, resources)).toBe(path.join(repository, "native", "target", "release", "firefly-workspace.exe"));
  });
  it("preserves full-width platform-neutral device and file identities", async () => {
    const id = { deviceId: "fedcba98765432100123456789abcdef", fileId: "123456789abcdef00123456789abcdef" };
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: { ...wire(), identity: id } }));
    expect((await p.bridge.readFile(file, ctx("project-read-only")))?.identity).toEqual(id);
  });
  it("joins fragmented frames including split UTF-8 without changing bytes", async () => {
    const p = processMock(() => {
      const bytes = Buffer.from(JSON.stringify({ type: "snapshot", version: 1, snapshot: { ...wire("leaf\0bytes"), canonicalPath: "C:\\workspace\\文件.txt" } }) + "\n");
      for (let i = 0; i < bytes.length; i++) p.output.write(bytes.subarray(i, i + 1));
    });
    expect((await p.bridge.readFile(file, ctx("project-read-only")))?.bytes).toEqual(Buffer.from("leaf\0bytes"));
  });
  it("a lease expiring during the callback cannot send a commit or leave an unhandled request rejection", async () => {
    const p = processMock((_c, send) => send({ type: "snapshot", version: 1, snapshot: wire() }));
    await expect(p.bridge.withWrite(file, ctx("scoped"), false, async lease => {
      await new Promise(resolve => setTimeout(resolve, 75));
      return lease!.commit(Buffer.from("late"), "replace");
    })).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", reason: "timeout", effectState: "not_applied" });
    expect(p.commands.some(c => c.type === "commit")).toBe(false);
    expect(guard).not.toHaveBeenCalled();
  });
});
