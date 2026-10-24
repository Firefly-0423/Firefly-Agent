import * as fs from "node:fs";
import * as path from "node:path";
import chokidar, { type ChokidarOptions } from "chokidar";

type WatchListener = (value?: unknown, evidence?: NativeEventEvidence) => void;

type FsWatchEventName = "add" | "change" | "unlink" | "addDir" | "unlinkDir" | "error";

export type WorkspaceFsWatcher = {
  close: () => Promise<unknown>;
  on: (event: FsWatchEventName, listener: WatchListener) => WorkspaceFsWatcher;
};

export type NativeEventEvidence = {
  recordedAt: number;
  sequence: number;
  timestamp: number;
  stage: "native" | "schedule" | "fire";
  phase: string;
  eventType: string;
  watchRoot: string;
  filename: string | null;
  filenameType: "string" | "buffer" | "null";
  candidate: string | null;
  ignored: boolean | null;
  classification: "IGNORED" | "MEANINGFUL" | "UNCLASSIFIED";
  scheduleId?: number;
  fireId?: number;
};

type NativeEventRecorder = (eventType: string, filename: string | Buffer | null, resolvedPath: string | null, ignored: boolean | null, watchRoot: string) => NativeEventEvidence;

export type GitWorkspaceSubscription = {
  gitDir: string;
  workspaceRoot: string;
  sessionId: string;
};

export type GitWorkspaceWatcher = {
  dispose: () => Promise<void>;
  unsubscribe: (sessionId: string) => Promise<void>;
  subscribe: (input: GitWorkspaceSubscription) => Promise<void>;
};

type DiagnosticsSink = { phase(): string; record(evidence: NativeEventEvidence): void };

export type GitWorkspaceWatcherDeps = {
  debounceMs?: number;
  diagnostics?: DiagnosticsSink;
  onError: (error: unknown, workspaceRoot: string) => void;
  onWorkspaceChanged: (sessionIds: readonly string[]) => void;
  createWatcher?: (paths: string[], options: ChokidarOptions, record?: NativeEventRecorder) => WorkspaceFsWatcher;
};

interface OpenWorkspace {
  watcher: WorkspaceFsWatcher;
  sessionIds: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

interface SessionBinding {
  key: string;
  references: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const CHANGE_EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;
const NOISY_PATH_SEGMENT = /(^|\/)(node_modules|dist|build|coverage|\.cache|\.next|\.turbo|release[\w-]*|\.worktrees|tmp)(\/|$)/;

export function createGitWorkspaceWatcher(deps: GitWorkspaceWatcherDeps): GitWorkspaceWatcher {
  const openWorkspaces = new Map<string, OpenWorkspace>();
  const bindings = new Map<string, SessionBinding>();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const makeWatcher = deps.createWatcher ?? createPlatformWatcher;
  const sink = resolveDiagnosticsSink(deps.diagnostics);
  let serial = 0;
  const recordNative = sink ? makeNativeRecorder(sink, () => ++serial) : undefined;

  async function releaseSession(sessionId: string): Promise<void> {
    const binding = bindings.get(sessionId);
    if (!binding) return;
    if (binding.references > 1) {
      binding.references -= 1;
      return;
    }
    bindings.delete(sessionId);

    const workspace = openWorkspaces.get(binding.key);
    if (!workspace) return;
    workspace.sessionIds.delete(sessionId);
    if (workspace.sessionIds.size > 0) return;

    if (workspace.timer) clearTimeout(workspace.timer);
    openWorkspaces.delete(binding.key);
    await workspace.watcher.close();
  }

  function createScheduler(key: string, workspaceRoot: string): WatchListener {
    let scheduleCount = 0;
    let fireCount = 0;
    let pending: NativeEventEvidence[] = [];

    return (value, nativeEvidence) => {
      const workspace = openWorkspaces.get(key);
      if (!workspace) return;

      if (sink && recordNative) {
        scheduleCount += 1;
        const native = nativeEvidence ?? recordNative("adapter", typeof value === "string" ? value : null, null, null, workspaceRoot);
        const scheduled: NativeEventEvidence = { ...native, stage: "schedule", scheduleId: scheduleCount, recordedAt: Date.now() };
        pending.push(scheduled);
        sink.record(scheduled);
      }

      if (workspace.timer) clearTimeout(workspace.timer);
      workspace.timer = setTimeout(() => {
        workspace.timer = undefined;
        if (sink) {
          fireCount += 1;
          const batch = pending;
          pending = [];
          for (const event of batch) sink.record({ ...event, stage: "fire", fireId: fireCount, recordedAt: Date.now() });
        }
        deps.onWorkspaceChanged([...workspace.sessionIds]);
      }, debounceMs);
    };
  }

  function openWorkspace(key: string, input: GitWorkspaceSubscription): OpenWorkspace {
    const gitEntries = ["HEAD", "index", "refs"].map((name) => path.join(input.gitDir, name));
    const options: ChokidarOptions = {
      ignored: createCodeGitIgnoredPredicate(input),
      awaitWriteFinish: { pollInterval: 50, stabilityThreshold: 250 },
      atomic: true,
      ignoreInitial: true,
    };
    const watcher = makeWatcher([input.workspaceRoot, ...gitEntries], options, recordNative);

    const workspace: OpenWorkspace = { watcher, sessionIds: new Set() };
    openWorkspaces.set(key, workspace);

    const schedule = createScheduler(key, input.workspaceRoot);
    for (const event of CHANGE_EVENTS) watcher.on(event, schedule);
    watcher.on("error", (error) => deps.onError(error, input.workspaceRoot));
    return workspace;
  }

  return {
    async subscribe(input) {
      const key = workspaceKey(input.workspaceRoot);
      const current = bindings.get(input.sessionId);
      if (current && current.key === key) {
        current.references += 1;
        return;
      }

      await releaseSession(input.sessionId);
      const workspace = openWorkspaces.get(key) ?? openWorkspace(key, input);
      workspace.sessionIds.add(input.sessionId);
      bindings.set(input.sessionId, { key, references: 1 });
    },

    unsubscribe: releaseSession,

    async dispose() {
      const stale = [...openWorkspaces.values()];
      openWorkspaces.clear();
      bindings.clear();
      for (const workspace of stale) {
        if (workspace.timer) clearTimeout(workspace.timer);
        await workspace.watcher.close();
      }
    },
  };
}

/** 生成 .git 与工作区的忽略谓词：保留 HEAD/index/refs，过滤对象库、日志、钩子、锁文件与常见产物目录。 */
export function createCodeGitIgnoredPredicate({ workspaceRoot, gitDir }: { workspaceRoot: string; gitDir: string }): (candidate: string) => boolean {
  const root = normalizePath(workspaceRoot);
  const git = normalizePath(gitDir);
  const kept = new Set([normalizePath(path.join(gitDir, "HEAD")), normalizePath(path.join(gitDir, "index"))]);
  const keptRefsPrefix = `${normalizePath(path.join(gitDir, "refs"))}/`;
  const noisyGitDirs = ["objects", "logs", "hooks"].map((name) => `${git}/${name}`);

  return (candidate) => {
    const value = normalizePath(candidate);
    if (kept.has(value) || value.startsWith(keptRefsPrefix)) return false;
    // .git 目录本身的事件（Windows 下子项变化会冒泡到父目录）不携带有效信息；
    // objects/logs/hooks 及其内部变化、目录创建都属于噪音。
    if (value === git) return true;
    if (noisyGitDirs.some((dir) => value === dir || value.startsWith(`${dir}/`))) return true;
    if (value.endsWith(".lock")) return true;

    const relative = value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
    return NOISY_PATH_SEGMENT.test(relative);
  };
}

// 平台默认监视器：Windows/macOS 使用内核递归句柄，挂载是一次性完成的；chokidar 需要逐目录建立
// 监视器，大仓库会冻结主进程。Linux 的 fs.watch 递归支持不完整，仍走 chokidar。原生句柄创建
// 失败时同样回落到 chokidar。
function createPlatformWatcher(paths: string[], options: ChokidarOptions, record?: NativeEventRecorder): WorkspaceFsWatcher {
  const supportsNativeRecursion = process.platform === "win32" || process.platform === "darwin";
  if (supportsNativeRecursion) {
    try {
      return createNativeRecursiveWatcher(paths, options, record);
    } catch {
      // 落入下方的 chokidar 分支。
    }
  }
  return chokidar.watch(paths, options) as WorkspaceFsWatcher;
}

/**
 * 把 fs.watch 的递归内核事件适配成 WorkspaceFsWatcher。被忽略谓词命中的路径不会通知；
 * filename 为 null 或 Buffer 时无法判断路径，按保守策略视为有变化，交给防抖合并。
 */
export function createNativeRecursiveWatcher(paths: string[], options: ChokidarOptions, record?: NativeEventRecorder): WorkspaceFsWatcher {
  const isIgnored = typeof options.ignored === "function" ? (options.ignored as (candidate: string) => boolean) : undefined;
  const bucketsByEvent = new Map<string, Set<WatchListener>>();
  const nativeHandles: fs.FSWatcher[] = [];

  const dispatch = (event: string, value?: unknown, evidence?: NativeEventEvidence): void => {
    for (const listener of bucketsByEvent.get(event) ?? []) listener(value, evidence);
  };

  const attachRoot = (watchRoot: string): void => {
    const nativeRoot = process.platform === "win32" ? fs.realpathSync.native(watchRoot) : watchRoot;
    const handle = fs.watch(nativeRoot, { recursive: true, persistent: true }, (eventType, filename) => {
      if (typeof filename !== "string") {
        dispatch("change", undefined, record?.(eventType, filename, null, null, watchRoot));
        return;
      }
      const candidate = path.resolve(watchRoot, filename);
      const ignoredHit = isIgnored?.(candidate) ?? false;
      const evidence = record?.(eventType, filename, candidate, ignoredHit, watchRoot);
      if (ignoredHit) return;
      dispatch("change", candidate, evidence);
    });
    handle.once("error", (error) => dispatch("error", error));
    nativeHandles.push(handle);
  };

  const root = paths[0];
  attachRoot(root);
  // worktree 场景下 gitDir 位于仓库根之外，根句柄覆盖不到元数据，需要额外挂一个句柄。
  if (paths.slice(1).some((candidate) => !isUnder(candidate, root))) attachRoot(path.dirname(paths[1]));

  const watcher: WorkspaceFsWatcher = {
    on(event, listener) {
      const bucket = bucketsByEvent.get(event) ?? new Set<WatchListener>();
      bucket.add(listener);
      bucketsByEvent.set(event, bucket);
      return watcher;
    },
    async close() {
      for (const handle of nativeHandles) handle.close();
      nativeHandles.length = 0;
    },
  };
  return watcher;
}

function resolveDiagnosticsSink(explicit: DiagnosticsSink | undefined): DiagnosticsSink | undefined {
  if (explicit != null) return explicit;
  if (process.env.FIREFLY_VITEST_DIAGNOSTICS !== "1") return undefined;
  return {
    phase: () => "runtime",
    record: (evidence) => console.info("[watch-evidence]", evidence),
  };
}

function makeNativeRecorder(sink: DiagnosticsSink, nextSequence: () => number): NativeEventRecorder {
  return (eventType, filename, resolvedPath, ignored, watchRoot) => {
    const evidence: NativeEventEvidence = {
      sequence: nextSequence(),
      timestamp: Date.now(),
      recordedAt: Date.now(),
      phase: sink.phase(),
      eventType,
      filename: filename === null ? null : String(filename),
      filenameType: describeFilename(filename),
      classification: classifyIgnored(ignored),
      candidate: resolvedPath,
      ignored,
      watchRoot,
      stage: "native",
    };
    sink.record(evidence);
    return evidence;
  };
}

function describeFilename(filename: string | Buffer | null): NativeEventEvidence["filenameType"] {
  if (filename === null) return "null";
  return Buffer.isBuffer(filename) ? "buffer" : "string";
}

function classifyIgnored(ignored: boolean | null): NativeEventEvidence["classification"] {
  if (ignored === null) return "UNCLASSIFIED";
  return ignored ? "IGNORED" : "MEANINGFUL";
}

function isUnder(candidate: string, root: string): boolean {
  const child = normalizePath(candidate);
  const parent = normalizePath(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function workspaceKey(workspaceRoot: string): string {
  const absolute = path.resolve(workspaceRoot);
  if (process.platform !== "win32") return absolute;
  return absolute.toLowerCase();
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}
