import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import type { ToolContext } from "./registry/tool-context";
import { ToolExecutionError } from "./registry/tool-execution-error";
import { assertWorkspaceBoundary, workspaceRestriction } from "./workspace-boundary";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FRAME = MAX_BYTES * 2 + 128 * 1024;
export interface WorkspaceIdentity { readonly deviceId: string; readonly fileId: string }
export interface WorkspaceSnapshot {
  readonly exists: boolean;
  readonly kind: "file" | "directory" | "missing";
  readonly size: number;
  readonly identity: WorkspaceIdentity | null;
  readonly canonicalPath: string | null;
  /** Null for missing/directory/over-budget read snapshots. */
  readonly bytes: Buffer | null;
}
export interface WorkspaceEntry { readonly name: string; readonly kind: "file" | "directory"; readonly size: number; readonly identity: WorkspaceIdentity }
export interface WorkspaceWriteLease {
  readonly before: WorkspaceSnapshot;
  commit(bytes: Buffer, mode: "replace" | "append"): Promise<WorkspaceSnapshot>;
}
export type WorkspaceErrorReason = "reparse-point" | "hard-link" | "outside-root" | "sharing-violation" | "missing" | "io"
  | "invalid-path" | "unsupported-filesystem" | "unsupported-platform" | "budget" | "protocol" | "timeout" | "aborted";
/** An unknown effect means a commit may have written bytes. It must not be retried as a clean failure. */
export class WorkspaceError extends ToolExecutionError {
  constructor(readonly reason: WorkspaceErrorReason, uncertain = false, code = "E_WORKSPACE_BOUNDARY") {
    super(uncertain ? "E_WORKSPACE_UNKNOWN_EFFECTS" : code,
      uncertain ? "工作区写入结果未知，可能已写入部分内容" : reason === "sharing-violation" ? "工作区文件正被占用" : "无法通过工作区句柄安全访问目标",
      uncertain ? "partial_failure" : reason === "sharing-violation" ? "transient" : "permission_denied", false, uncertain ? "unknown" : "not_applied");
  }
}
function boundary(uncertain = false, reason: WorkspaceErrorReason = "protocol"): WorkspaceError {
  return new WorkspaceError(reason, uncertain);
}
function nativeError(value: unknown, uncertain: boolean): WorkspaceError {
  const v = fields(value, ["type", "version", "code", "reason"]);
  const reasons = ["reparse-point", "hard-link", "outside-root", "sharing-violation", "missing", "io", "invalid-path", "unsupported-filesystem", "unsupported-platform", "budget", "protocol"];
  const codes: Record<string, string> = {
    "workspace-boundary": "E_WORKSPACE_BOUNDARY", "workspace-busy": "E_WORKSPACE_BUSY", "workspace-io": "E_WORKSPACE_IO",
    "workspace-missing": "E_WORKSPACE_MISSING", "workspace-budget": "E_WORKSPACE_BUDGET", "workspace-unsupported-platform": "E_WORKSPACE_BOUNDARY",
    "workspace-protocol": "E_WORKSPACE_BOUNDARY", "workspace-cli": "E_WORKSPACE_BOUNDARY", "workspace-input": "E_WORKSPACE_IO",
    "workspace-output": "E_WORKSPACE_IO", "workspace-parent": "E_WORKSPACE_IO",
  };
  if (typeof v.code !== "string" || !Object.hasOwn(codes, v.code) || typeof v.reason !== "string" || !reasons.includes(v.reason)
    || (v.code === "workspace-busy") !== (v.reason === "sharing-violation")) throw boundary(uncertain);
  return new WorkspaceError(v.reason as WorkspaceErrorReason, uncertain, codes[v.code]);
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw boundary();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== [...names].sort().join(",")) throw boundary();
  return object;
}
function identity(value: unknown): WorkspaceIdentity {
  const v = fields(value, ["deviceId", "fileId"]);
  if (typeof v.deviceId !== "string" || !/^[a-f0-9]{32}$/.test(v.deviceId) || typeof v.fileId !== "string" || !/^[a-f0-9]{32}$/.test(v.fileId)) throw boundary();
  return Object.freeze({ deviceId: v.deviceId, fileId: v.fileId });
}
function snapshot(value: unknown, maxBytes: number, requireBytes = false): WorkspaceSnapshot {
  const v = fields(value, ["exists", "kind", "size", "identity", "canonicalPath", "bytesHex"]);
  if (typeof v.exists !== "boolean" || !["file", "directory", "missing"].includes(String(v.kind)) || !Number.isSafeInteger(v.size) || (v.size as number) < 0) throw boundary();
  const id = v.identity === null ? null : identity(v.identity);
  const canonicalPath = v.canonicalPath === null ? null : typeof v.canonicalPath === "string" ? localPath(v.canonicalPath) : (() => { throw boundary(); })();
  if (!v.exists) {
    if (v.kind !== "missing" || v.size !== 0 || id !== null || v.bytesHex !== null) throw boundary();
  } else if (v.kind === "missing" || id === null || canonicalPath === null) throw boundary();
  let bytes: Buffer | null = null;
  if (v.bytesHex !== null) {
    if (v.kind !== "file" || typeof v.bytesHex !== "string" || v.bytesHex.length !== (v.size as number) * 2 || v.bytesHex.length > maxBytes * 2 || !/^[a-f0-9]*$/.test(v.bytesHex)) throw boundary();
    bytes = Buffer.from(v.bytesHex, "hex");
  } else if (v.kind === "file" && (requireBytes || (v.size as number) <= maxBytes)) throw boundary();
  return Object.freeze({ exists: v.exists, kind: v.kind as WorkspaceSnapshot["kind"], size: v.size as number, identity: id, canonicalPath, bytes });
}
function validName(name: string): boolean {
  if (!name || name === "." || name === ".." || name.length > 255 || /[. ]$|[\\/:*?"<>|\u0000-\u001f]/u.test(name)) return false;
  const stem = name.split(".")[0].toUpperCase();
  return !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(stem);
}
function localPath(value: string): string {
  const text = value.replace(/^\\\\\?\\/, "").replace(/\//g, "\\");
  if (!/^[a-z]:\\/i.test(text) || text.length > 16000) throw boundary();
  const normalized = path.win32.normalize(text);
  if (normalized.slice(3).split("\\").filter(Boolean).some(c => !validName(c))) throw boundary();
  return normalized;
}
function target(root: string, file: string): { root: string; components: string[] } {
  const normalizedRoot = localPath(root), normalizedFile = localPath(file);
  const relative = path.win32.relative(normalizedRoot, normalizedFile);
  if (relative === ".." || relative.startsWith("..\\") || path.win32.isAbsolute(relative)) throw boundary(false, "outside-root");
  const components = relative ? relative.split("\\") : [];
  if (components.length > 512 || components.some(c => !validName(c))) throw boundary();
  return { root: normalizedRoot, components };
}
/** Mirrors desktopHistoryHelperPath: packaged resources are outside asar. No PATH/env lookup. */
export function workspaceHelperPath(application: { isPackaged: boolean; getAppPath(): string }, resources: string): string {
  return application.isPackaged ? path.join(resources, "bin", "firefly-workspace.exe")
    : path.join(application.getAppPath(), "native", "target", "release", "firefly-workspace.exe");
}

interface Session {
  request(command: object, type: "snapshot" | "entries"): Promise<Record<string, unknown>>;
  release(): Promise<void>;
}
/** Main-only dependency injection, used by mock-process tests. Production exports use fixed defaults. */
export function createWorkspaceHandleBridge(options: {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  resolveBinary?: () => string;
  timeoutMs?: number;
} = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? 30000;
  const support = Object.freeze(platform === "win32" ? { supported: true as const, code: "workspace-handles" as const }
    : { supported: false as const, code: "workspace-unsupported-platform" as const });
  function scope(file: string, access: "read" | "write", context?: ToolContext) {
    const root = workspaceRestriction(access, context, platform);
    if (!root || !support.supported) {
      // Explicit non-Windows fallback: preserves the legacy guard AND its known race.
      assertWorkspaceBoundary(file, access, context);
      return undefined;
    }
    return target(root, file);
  }
  async function session(root: string, context?: ToolContext): Promise<Session> {
    if (context?.signal?.aborted) throw boundary(false, "aborted");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw boundary();
    let child: ChildProcessWithoutNullStreams;
    try {
      const binary = (options.resolveBinary ?? (() => workspaceHelperPath(app, process.resourcesPath)))();
      child = spawn(binary, ["--root", root, "--parent-pid", String(process.pid), "--deadline-ms", String(timeoutMs)], {
        shell: false, windowsHide: true, cwd: path.dirname(binary), stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) { throw boundary(false, (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "io"); }
    let pending: { type: string; resolve(v: Record<string, unknown>): void; reject(error: unknown): void } | undefined;
    let failure: WorkspaceError | undefined, fragments: Buffer[] = [], buffered = 0, closed = false, releasing = false, uncertain = false;
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const fail = (error = boundary(uncertain)) => {
      if (failure) return;
      failure = error;
      fragments = []; buffered = 0;
      const waiter = pending; pending = undefined; waiter?.reject(failure);
      if (!closed) { try { child.kill(); } catch { /* Cleanup still requires close or reports failure. */ } }
    };
    const abort = () => fail(boundary(uncertain, "aborted"));
    const timer = setTimeout(() => fail(boundary(uncertain, "timeout")), timeoutMs);
    const clean = () => { clearTimeout(timer); context?.signal?.removeEventListener("abort", abort); };
    const next = (type: string) => {
      if (failure) return Promise.reject(failure);
      if (closed || pending) return Promise.reject(boundary(uncertain));
      return new Promise<Record<string, unknown>>((resolve, reject) => { pending = { type, resolve, reject }; });
    };
    const send = (command: object) => {
      if (failure || closed || context?.signal?.aborted) throw failure ?? boundary(uncertain);
      const line = JSON.stringify(command) + "\n";
      if (Buffer.byteLength(line) > MAX_FRAME) throw boundary(uncertain);
      // Only a sent commit can have effects. An expired/aborted lease above is a clean failure.
      if ((command as { type?: string }).type === "commit") uncertain = true;
      child.stdin.write(line, error => { if (error) fail(boundary(uncertain, "io")); });
    };
    // Register the waiter before any data listener can receive the ready frame.
    const ready = next("ready");
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
        const part = chunk.subarray(offset, stop);
        if (buffered + part.length > MAX_FRAME) { fail(); return; }
        fragments.push(part); buffered += part.length;
        if (end < 0) return;
        // Join once per frame; repeated concatenation is quadratic for large files.
        const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, buffered);
        fragments = []; buffered = 0;
        try {
          const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as Record<string, unknown>;
          if (!pending || v.version !== 1) throw boundary();
          if (v.type === "error") { fail(nativeError(v, uncertain)); return; }
          if (v.type !== pending.type) throw boundary();
          fields(v, pending.type === "snapshot" ? ["type", "version", "snapshot"] : pending.type === "entries" ? ["type", "version", "entries"] : ["type", "version"]);
          const waiter = pending; pending = undefined; waiter.resolve(v);
        } catch { fail(); return; }
        offset = end + 1;
      }
    });
    child.stdout.on("end", () => { if (pending || buffered || !releasing) fail(); });
    child.stderr.on("data", () => { /* Drain without retaining file bodies/native paths. */ });
    for (const emitter of [child, child.stdin, child.stdout, child.stderr]) emitter.on("error", (error: NodeJS.ErrnoException) => fail(boundary(uncertain, error.code === "ENOENT" ? "missing" : "io")));
    child.once("close", (code: number | null) => {
      closed = true;
      if (code !== 0 || pending || buffered || !releasing) fail();
      clean(); resolveExit();
    });
    context?.signal?.addEventListener("abort", abort, { once: true });
    if (context?.signal?.aborted) fail();
    const release = async () => {
      try {
        if (!closed && !failure) {
          releasing = true;
          const ack = next("released"); void ack.catch(() => undefined);
          send({ type: "release", version: 1 }); await ack;
        }
        if (failure && !closed) { try { child.kill(); } catch { /* Timeout below reports unconfirmed exit. */ } }
        let bound: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exited, new Promise<never>((_, reject) => { bound = setTimeout(() => reject(boundary(uncertain)), 1000); })]); }
        finally { if (bound) clearTimeout(bound); }
        if (failure) throw failure;
      } catch { fail(); throw failure; }
      finally { clean(); }
    };
    try { await ready; if (failure) throw failure; }
    catch (error) { try { await release(); } catch { /* Preserve initial failure. */ } throw error; }
    return {
      async request(command, type) {
        const value = next(type);
        void value.catch(() => undefined);
        try { send(command); const result = await value; if (failure) throw failure; return result; }
        catch { fail(); throw failure; }
      },
      release,
    };
  }
  async function using<T>(root: string, context: ToolContext | undefined, run: (s: Session) => Promise<T>): Promise<T> {
    const s = await session(root, context);
    let failed = false;
    try { return await run(s); }
    catch (error) { failed = true; throw error; }
    finally { try { await s.release(); } catch (error) { if (!failed) throw error; } }
  }
  async function readWithRetry<T>(context: ToolContext | undefined, run: () => Promise<T>): Promise<T> {
    const retryDeadline = Date.now() + 250;
    let lastBusy: WorkspaceError | undefined;
    for (let attempt = 1; ; attempt++) {
      if (context?.signal?.aborted) throw boundary(false, "aborted");
      if (lastBusy && Date.now() >= retryDeadline) throw lastBusy;
      try { return await run(); }
      catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "E_WORKSPACE_BUSY" || attempt >= 5 || Date.now() + 40 >= retryDeadline) throw error;
        lastBusy = error;
        await new Promise<void>(resolve => setTimeout(resolve, 40));
      }
    }
  }
  return {
    support,
    async readFile(file: string, context?: ToolContext, maxBytes = MAX_BYTES, access: "read" | "write" = "read"): Promise<WorkspaceSnapshot | undefined> {
      const scoped = scope(file, access, context); if (!scoped) return undefined;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw boundary();
      return readWithRetry(context, () => {
        scope(file, access, context);
        return using(scoped.root, context, async s => snapshot((await s.request({ type: "read", version: 1, components: scoped.components, maxBytes }, "snapshot")).snapshot, maxBytes));
      });
    },
    async statEntry(file: string, context?: ToolContext, access: "read" | "write" = "read"): Promise<WorkspaceSnapshot | undefined> {
      const scoped = scope(file, access, context); if (!scoped) return undefined;
      // stat has no bytes, even for a small file.
      return using(scoped.root, context, async s => snapshot((await s.request({ type: "stat", version: 1, components: scoped.components }, "snapshot")).snapshot, -1));
    },
    async listDirectory(file: string, context?: ToolContext): Promise<WorkspaceEntry[] | undefined> {
      const scoped = scope(file, "read", context); if (!scoped) return undefined;
      return readWithRetry(context, () => {
        scope(file, "read", context);
        return using(scoped.root, context, async s => {
          const value = (await s.request({ type: "list", version: 1, components: scoped.components }, "entries")).entries;
          if (!Array.isArray(value) || value.length > 100000) throw boundary();
          const seen = new Set<string>();
          return value.map(entry => {
            const v = fields(entry, ["name", "kind", "size", "identity"]);
            if (typeof v.name !== "string" || !validName(v.name) || seen.has(v.name.toLowerCase()) || (v.kind !== "file" && v.kind !== "directory") || !Number.isSafeInteger(v.size) || (v.size as number) < 0) throw boundary();
            seen.add(v.name.toLowerCase());
            return Object.freeze({ name: v.name, kind: v.kind, size: v.size as number, identity: identity(v.identity) });
          });
        });
      });
    },
    async withWrite<T>(file: string, context: ToolContext | undefined, createParents: boolean, run: (lease: WorkspaceWriteLease | undefined) => Promise<T>): Promise<T> {
      const scoped = scope(file, "write", context); if (!scoped) return run(undefined);
      return using(scoped.root, context, async s => {
        const before = snapshot((await s.request({ type: "prepare-write", version: 1, components: scoped.components, createParents }, "snapshot")).snapshot, MAX_BYTES, true);
        if (before.kind === "directory" || !before.canonicalPath) throw boundary();
        let committed = false;
        return run({ before, async commit(bytes, mode) {
          if (committed || !Buffer.isBuffer(bytes) || bytes.length + (mode === "append" ? before.size : 0) > MAX_BYTES) throw boundary();
          const current = scope(file, "write", context);
          if (current && current.root.toLowerCase() !== scoped.root.toLowerCase()) throw boundary();
          committed = true;
          const result = await s.request({ type: "commit", version: 1, mode, bytesHex: bytes.toString("hex") }, "snapshot");
          try {
            const after = snapshot(result.snapshot, MAX_BYTES, true);
            if (!after.exists || after.kind !== "file" || (before.identity && (after.identity?.fileId !== before.identity.fileId || after.identity?.deviceId !== before.identity.deviceId))) throw boundary(true);
            return after;
          } catch (error) { throw boundary(true, error instanceof WorkspaceError ? error.reason : "protocol"); }
        } });
      });
    },
  };
}
const bridge = createWorkspaceHandleBridge();
export const workspaceHandleSupport = bridge.support;
export const readWorkspaceFile = bridge.readFile;
export const listWorkspaceDirectory = bridge.listDirectory;
export const statWorkspaceEntry = bridge.statEntry;
export const withWorkspaceWrite = bridge.withWrite;
