import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit, type DiffResult } from "simple-git";
import type { ChatSession } from "../../../shared/chat-types";
import { emptyCodeGitStatus, MAX_UNTRACKED_LINE_STATS } from "../../../shared/code-git-types";
import type { CodeGitChangeKind, CodeGitFileChange, CodeGitStatus } from "../../../shared/code-git-types";
import type { ResolvedGitExecutable } from "./git-executable";
import { createGitWorkspaceWatcher } from "./git-workspace-watcher";
import type { GitWorkspaceWatcher } from "./git-workspace-watcher";

type LineCounts = { insertions: number; deletions: number };

export type GitStatusFile = {
  index: string;
  workingDir: string;
  path: string;
  fromPath?: string;
};

export type GitStatusSnapshot = {
  files: GitStatusFile[];
  current: string;
  behind: number;
  ahead: number;
};

export type GitDiffQuery = {
  /** 限定仓库内相对路径 */
  paths?: string[];
  /** 比较的基准 ref，缺省 HEAD */
  ref?: string;
  /** 为 true 时看暂存区（--cached），否则看工作区 */
  staged?: boolean;
  /** patch 文本的行数上限，超出会被截断 */
  maxPatchLines?: number;
};

export type GitDiffResult = {
  patch: string;
  truncated: boolean;
  files: string[];
  base: string;
  staged: boolean;
  deletions: number;
  insertions: number;
  /** 逐文件增删统计，给 Diff Review 卡片使用；二进制文件没有行数，不在其中 */
  perFile: Array<{ file: string; insertions: number; deletions: number }>;
  /** 有差异的二进制文件，patch 里只有一行说明 */
  binaryFiles: string[];
  /** 截断时没有完整出现在 patch 里的文件；未截断时为空 */
  incompleteFiles: string[];
};

// 未跟踪文件的行数要逐个运行 git 统计，超过 MAX_UNTRACKED_LINE_STATS 个就不再统计，并标明行数只是部分结果。
export { MAX_UNTRACKED_LINE_STATS };
/** patch 先按字符预算截断再按行截断，避免一个巨大的单行或大批文件撑满内存和返回内容。 */
export const MAX_PATCH_CHARS = 512 * 1024;
export const MAX_PATCH_LINES = 5000;

export type GitLogQuery = {
  /** 限定某个文件的历史 */
  path?: string;
  /** 条数上限，缺省 20 */
  maxCount?: number;
  /** 分支或 ref，缺省当前分支 */
  ref?: string;
};

export type GitLogEntry = {
  hash: string;
  author: string;
  date: string;
  message: string;
};

export type PendingGitOperation = "merge" | "cherry-pick" | "revert";

export type GitClient = {
  getGitDir: () => Promise<string>;
  /** Shared metadata (refs, packed-refs) of a linked worktree; the same as getGitDir in an ordinary repository. */
  getCommonDir: () => Promise<string>;
  isRepository: () => Promise<boolean>;
  init: () => Promise<void>;
  getStatus: () => Promise<GitStatusSnapshot>;
  getBranches: () => Promise<string[]>;
  /** partial: some untracked files were past the counting budget, so the totals leave them out. */
  getLineStats: (files: GitStatusFile[]) => Promise<LineCounts & { byPath: Record<string, LineCounts>; partial: boolean }>;
  getDiff: (options: GitDiffQuery) => Promise<GitDiffResult>;
  getLog: (options: GitLogQuery) => Promise<GitLogEntry[]>;
  /** Commits exactly these paths as they are in the working tree; anything else already staged stays staged. */
  commit: (message: string, paths: string[]) => Promise<string>;
  /** Stages every change and commits the whole index; used to conclude a merge, cherry-pick or revert. */
  commitAll: (message: string) => Promise<string>;
  /** The operation a commit would conclude, read from MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD. */
  getPendingOperation: () => Promise<PendingGitOperation | null>;
  checkout: (branch: string) => Promise<void>;
  checkoutNewBranch: (branch: string) => Promise<void>;
  push: (remote: string) => Promise<void>;
  revert: (commit: string) => Promise<void>;
};

export type GitServiceDeps = {
  workspaceWatcher?: GitWorkspaceWatcher;
  /** Builds the watcher with the service's change handler; ignored when workspaceWatcher is given. */
  createWorkspaceWatcher?: (onWorkspaceChanged: (sessionIds: readonly string[]) => void) => GitWorkspaceWatcher;
  createClient?: (input: { workspaceRoot: string; executable: ResolvedGitExecutable }) => GitClient;
  resolveExecutable: () => Promise<ResolvedGitExecutable | null>;
  getSession: (sessionId: string) => ChatSession | null;
};

export type TrustedGitContext = {
  workspaceRoot: string;
  sessionId: string;
  mode: "code";
};

export type GitService = {
  getStatusForSession: (sessionId: string) => Promise<CodeGitStatus>;
  onChanged: (listener: (payload: { sessionId: string }) => void) => () => void;
  watchSession: (sessionId: string) => Promise<void>;
  unwatchSession: (sessionId: string) => Promise<void>;
  dispose: () => Promise<void>;
  initRepository: (ctx: TrustedGitContext) => Promise<string>;
  commit: (ctx: TrustedGitContext, message: string, paths: string[]) => Promise<string>;
  switchBranch: (ctx: TrustedGitContext, branch: string, create: boolean) => Promise<string>;
  push: (ctx: TrustedGitContext, remote?: string) => Promise<string>;
  revert: (ctx: TrustedGitContext, commit: string) => Promise<string>;
  diff: (ctx: TrustedGitContext, options?: GitDiffQuery) => Promise<GitDiffResult>;
  log: (ctx: TrustedGitContext, options?: GitLogQuery) => Promise<GitLogEntry[]>;
  switchBranchForSession: (sessionId: string, branch: string, create: boolean) => Promise<string>;
  commitForSession: (sessionId: string, message: string, paths: string[]) => Promise<string>;
  pushForSession: (sessionId: string) => Promise<string>;
};

/** 会话检查通过后的结果：工作区目录加上已解析的 Git 可执行文件。 */
type ReadyWorkspace = {
  executable: ResolvedGitExecutable;
  workspaceRoot: string;
};

/** A status read before the session it was asked for is filled in; several sessions on one repository share it. */
type StatusBody = Omit<CodeGitStatus, "sessionId">;

function repositoryKey(workspaceRoot: string): string {
  const absolute = path.resolve(workspaceRoot);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isStatusResult(value: ReadyWorkspace | CodeGitStatus): value is CodeGitStatus {
  return "state" in value;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const makeClient = deps.createClient ?? createSimpleGitClient;
  const subscribers = new Set<(payload: { sessionId: string }) => void>();
  const onWorkspaceChanged = (sessionIds: readonly string[]) => {
    for (const id of sessionIds) notify(id);
  };
  const workspaceWatcher = deps.workspaceWatcher ?? deps.createWorkspaceWatcher?.(onWorkspaceChanged) ?? createGitWorkspaceWatcher({
    onWorkspaceChanged,
    // The watcher also asks the panels to read the repository again, so an event lost to the error is caught up.
    onError: (error, workspaceRoot) => console.warn("[code-git] workspace watcher error", workspaceRoot, error),
  });

  /**
   * Tells the panels the repository changed. A status read already in flight began before the change (a checkout in a terminal,
   * a write here), so it is retired first: the reads the panels start now must not be handed that earlier snapshot.
   */
  function notify(sessionId: string): void {
    const workspaceRoot = deps.getSession(sessionId)?.workspaceBinding?.workspaceRoot;
    if (workspaceRoot) bumpGeneration(repositoryKey(workspaceRoot));
    for (const listener of subscribers) listener({ sessionId });
  }

  /**
   * Writes to one repository run one after another: two commits, or a commit and a checkout, would otherwise interleave their
   * add/commit steps, and Git's index.lock only refuses the loser instead of ordering them.
   * Each write also moves the repository's generation on, so a status read that started before it is not handed out afterwards.
   */
  const writeQueues = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const statusReads = new Map<string, { generation: number; read: Promise<StatusBody> }>();

  function bumpGeneration(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }

  function exclusive<T>(workspaceRoot: string, task: () => Promise<T>): Promise<T> {
    const key = repositoryKey(workspaceRoot);
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      bumpGeneration(key);
      return task();
    });
    const settled = run.then(() => undefined, () => undefined).then(() => {
      bumpGeneration(key);
      if (writeQueues.get(key) === settled) writeQueues.delete(key);
    });
    writeQueues.set(key, settled);
    return run;
  }

  /** Panels of several sessions on one repository, or a burst of change events, share one status read while it is in flight. */
  function readStatus(gate: ReadyWorkspace): Promise<StatusBody> {
    const key = `${repositoryKey(gate.workspaceRoot)}\n${gate.executable.command}`;
    const generation = generations.get(repositoryKey(gate.workspaceRoot)) ?? 0;
    const current = statusReads.get(key);
    if (current && current.generation === generation) return current.read;
    const entry = { generation, read: computeStatus(gate) };
    statusReads.set(key, entry);
    const forget = () => { if (statusReads.get(key) === entry) statusReads.delete(key); };
    entry.read.then(forget, forget);
    return entry.read;
  }

  async function computeStatus(gate: ReadyWorkspace): Promise<StatusBody> {
    const client = makeClient(gate);
    if (!(await client.isRepository())) {
      const { sessionId: _unused, ...body } = emptyCodeGitStatus("", "not_repository", "这个目录还不是 Git 仓库");
      return body;
    }
    const [snapshot, branches] = await Promise.all([client.getStatus(), client.getBranches()]);
    const stats = await client.getLineStats(snapshot.files);
    const files = snapshot.files.map((file) => toFileChange(file, stats.byPath[file.path]));
    const detached = snapshot.current === "HEAD";
    const { source, version } = gate.executable;
    return {
      state: "ready",
      executable: { source, version },
      branch: { current: detached ? null : snapshot.current, detached, branches },
      files,
      summary: tallyKinds(files),
      lines: { insertions: stats.insertions, deletions: stats.deletions, ...(stats.partial ? { partial: true } : {}) },
      ahead: snapshot.ahead,
      behind: snapshot.behind,
    };
  }

  /** 会话门禁：依次检查会话存在、模式为 code、已绑定目录、Git 可用。 */
  async function gateSession(sessionId: string): Promise<ReadyWorkspace | CodeGitStatus> {
    const session = deps.getSession(sessionId);
    if (!session) return emptyCodeGitStatus(sessionId, "error", "找不到当前对话");
    if (session.mode !== "code") return emptyCodeGitStatus(sessionId, "error", "Git 工作台只在 Code 模式可用");
    const workspaceRoot = session.workspaceBinding?.workspaceRoot;
    if (!workspaceRoot) return emptyCodeGitStatus(sessionId, "no_workspace", "尚未绑定代码目录");
    const executable = await deps.resolveExecutable();
    if (!executable) return emptyCodeGitStatus(sessionId, "git_unavailable", "未检测到可用 Git");
    return { workspaceRoot, executable };
  }

  async function requireReadyWorkspace(sessionId: string): Promise<ReadyWorkspace> {
    const gate = await gateSession(sessionId);
    if (isStatusResult(gate)) throw new Error(gate.message ?? "Git 状态暂时不可用");
    return gate;
  }

  async function clientFor(ctx: TrustedGitContext): Promise<GitClient> {
    const executable = await deps.resolveExecutable();
    if (!executable) throw new Error("未检测到可用 Git");
    return makeClient({ workspaceRoot: ctx.workspaceRoot, executable });
  }

  async function trustedContextFor(sessionId: string): Promise<TrustedGitContext> {
    const ready = await requireReadyWorkspace(sessionId);
    return { sessionId, mode: "code", workspaceRoot: ready.workspaceRoot };
  }

  async function commitChosen(client: GitClient, ctx: TrustedGitContext, message: string, paths: string[]): Promise<string> {
    try {
      const [snapshot, operation] = await Promise.all([client.getStatus(), client.getPendingOperation()]);
      if (operation) {
        // Git refuses a path-limited commit while a merge, cherry-pick or revert is open: that commit has to take every change.
        await assertCompletesOperation(operation, snapshot, paths, ctx.workspaceRoot);
        return await client.commitAll(message.trim());
      }
      return await client.commit(message.trim(), await withRenameSources(snapshot, paths, ctx.workspaceRoot));
    } finally {
      // A failed commit may still have run hooks or left the index changed, so the panel reads the repository again either way.
      notify(ctx.sessionId);
    }
  }

  return {
    onChanged(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    async watchSession(sessionId) {
      const ready = await requireReadyWorkspace(sessionId);
      const client = makeClient(ready);
      if (!(await client.isRepository())) throw new Error("这个目录还不是 Git 仓库");
      const [gitDir, commonDir] = await Promise.all([client.getGitDir(), client.getCommonDir()]);
      await workspaceWatcher.subscribe({ sessionId, workspaceRoot: ready.workspaceRoot, gitDir, commonDir });
    },

    unwatchSession: (sessionId) => workspaceWatcher.unsubscribe(sessionId),
    dispose: () => workspaceWatcher.dispose(),

    async switchBranchForSession(sessionId, branch, create) {
      return this.switchBranch(await trustedContextFor(sessionId), branch, create);
    },
    async commitForSession(sessionId, message, paths) {
      return this.commit(await trustedContextFor(sessionId), message, paths);
    },
    async pushForSession(sessionId) {
      return this.push(await trustedContextFor(sessionId));
    },

    async initRepository(ctx) {
      const client = await clientFor(ctx);
      await exclusive(ctx.workspaceRoot, () => client.init());
      notify(ctx.sessionId);
      return "已初始化 Git 仓库";
    },

    async commit(ctx, message, paths) {
      if (!message.trim()) throw new Error("提交信息不能为空");
      if (paths.length === 0 || !paths.every(isRepoRelative)) {
        throw new Error("请提供要提交的仓库内文件路径");
      }
      const client = await clientFor(ctx);
      return exclusive(ctx.workspaceRoot, () => commitChosen(client, ctx, message, paths));
    },

    async switchBranch(ctx, branch, create) {
      if (!isSafeBranchName(branch)) throw new Error("分支名称不合法");
      const client = await clientFor(ctx);
      await exclusive(ctx.workspaceRoot, () => (create ? client.checkoutNewBranch(branch) : client.checkout(branch)))
        .finally(() => notify(ctx.sessionId));
      return `已切换到分支 ${branch}`;
    },

    async push(ctx, remote = "origin") {
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("远端名称不合法");
      const client = await clientFor(ctx);
      await exclusive(ctx.workspaceRoot, () => client.push(remote)).finally(() => notify(ctx.sessionId));
      return `已推送到 ${remote}`;
    },

    async revert(ctx, commit) {
      if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("提交标识必须是 7 到 40 位十六进制 hash");
      const client = await clientFor(ctx);
      // A conflicted revert leaves files in the working tree, so the panel reads the repository again either way.
      await exclusive(ctx.workspaceRoot, () => client.revert(commit)).finally(() => notify(ctx.sessionId));
      return `已创建回退提交 ${commit}`;
    },

    async diff(ctx, options = {}) {
      const client = await clientFor(ctx);
      const ref = options.ref ?? "HEAD";
      if (!isSafeGitRef(ref)) throw new Error("ref 不合法");
      const paths = options.paths ?? [];
      if (!paths.every(isRepoRelative)) throw new Error("请提供仓库内相对路径");
      const maxPatchLines = options.maxPatchLines ?? 400;
      if (!Number.isInteger(maxPatchLines) || maxPatchLines < 1 || maxPatchLines > MAX_PATCH_LINES) {
        throw new Error(`maxPatchLines 必须是 1 到 ${MAX_PATCH_LINES} 的整数`);
      }
      const query: GitDiffQuery = { maxPatchLines, paths, ref };
      query.staged = options.staged ?? false;
      return client.getDiff(query);
    },

    async log(ctx, options = {}) {
      const client = await clientFor(ctx);
      const ref = options.ref;
      if (ref !== undefined && !isSafeGitRef(ref)) throw new Error("ref 不合法");
      const filePath = options.path;
      if (filePath !== undefined && !isRepoRelative(filePath)) throw new Error("请提供仓库内相对路径");
      const maxCount = options.maxCount ?? 20;
      if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 200) {
        throw new Error("maxCount 必须是 1 到 200 的整数");
      }
      return client.getLog({
        maxCount,
        ...(ref ? { ref } : {}),
        ...(filePath ? { path: filePath } : {}),
      });
    },

    async getStatusForSession(sessionId: string): Promise<CodeGitStatus> {
      try {
        const gate = await gateSession(sessionId);
        if (isStatusResult(gate)) return gate;
        return { ...(await readStatus(gate)), sessionId };
      } catch (error) {
        return emptyCodeGitStatus(sessionId, "error", describeFailure(error));
      }
    },
  };
}

function createSimpleGitClient(input: { workspaceRoot: string; executable: ResolvedGitExecutable }): GitClient {
  const bundled = input.executable.env;
  const passthroughEnv = bundled ? ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"] : [];
  const git = simpleGit({
    maxConcurrentProcesses: 1,
    binary: input.executable.command,
    baseDir: input.workspaceRoot,
    allowEnvironment: passthroughEnv,
  });
  if (bundled) {
    git.env({
      GIT_CONFIG_NOSYSTEM: bundled.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: bundled.GIT_CONFIG_GLOBAL,
    });
  }

  // rev-parse -q --verify exits 1 silently for a missing ref; simple-git resolves that with empty output.
  const readRef = async (ref: string) => (await git.raw(["rev-parse", "-q", "--verify", ref]).catch(() => "")).trim();
  const readHead = () => readRef("HEAD");
  // simple-git also resolves a commit that exits non-zero without writing to stderr (a hook that just exits 1),
  // so success is judged by HEAD moving, not by the command returning.
  const createdSince = async (before: string) => {
    const after = await readHead();
    if (!after || after === before) throw new Error("提交没有完成：Git 未创建新提交，可能被 hook 拒绝");
    return `已创建提交 ${after.slice(0, 7)}`;
  };
  // Before the first commit HEAD does not exist yet; the empty tree is its baseline, so new files count as added rather than as no change.
  let emptyTree: Promise<string> | undefined;
  const baselineFor = async (ref: string) => {
    if (ref !== "HEAD" || (await readHead())) return ref;
    emptyTree ??= git.raw(["hash-object", "-t", "tree", "/dev/null"]).then((hash) => hash.trim());
    return emptyTree;
  };

  const client: GitClient = {
    isRepository: () => git.checkIsRepo(),

    async getStatus() {
      const status = await git.status();
      return {
        behind: status.behind,
        ahead: status.ahead,
        current: status.current ?? "HEAD",
        files: status.files.map((entry) => ({
          path: entry.path,
          fromPath: entry.from,
          index: entry.index,
          workingDir: entry.working_dir,
        })),
      };
    },

    async getBranches() {
      const listing = await git.branchLocal();
      return listing.all;
    },

    async getLineStats(files) {
      // A failure here is a real failure (a damaged index, a lock, no permission); it is not reported as zero changed lines.
      const tracked = await git.diffSummary([await baselineFor("HEAD")]);
      let insertions = tracked.insertions;
      let deletions = tracked.deletions;
      const byPath: Record<string, LineCounts> = {};
      for (const entry of tracked.files ?? []) {
        if ("file" in entry && "insertions" in entry && "deletions" in entry) {
          byPath[entry.file] = { insertions: entry.insertions, deletions: entry.deletions };
        }
      }

      // 未跟踪文件没有 HEAD 基线，改用 --no-index 与空文件对比来计算行数。每个文件一个 git 进程，所以只统计前
      // MAX_UNTRACKED_LINE_STATS 个，其余标为未统计，而不是当作 0 行。
      const untrackedFiles = files.filter(isUntrackedEntry);
      const partial = untrackedFiles.length > MAX_UNTRACKED_LINE_STATS;
      for (const untracked of untrackedFiles.slice(0, MAX_UNTRACKED_LINE_STATS)) {
        let output: string | undefined;
        try {
          output = await git.raw(["diff", "--no-index", "--numstat", "--", "/dev/null", untracked.path]);
        } catch (error) {
          // --no-index 有差异时以退出码 1 结束，输出仍在错误对象里。
          output = readGitCommandOutput(error);
        }
        if (typeof output !== "string") continue;
        const counts = parseNumstat(output);
        insertions += counts.insertions;
        deletions += counts.deletions;
        byPath[untracked.path] = counts;
      }
      return { insertions, deletions, byPath, partial };
    },

    init: async () => {
      await git.init();
    },
    async commit(message, paths) {
      const specs = paths.map(literalPathspec);
      // commit --only reads the chosen paths from the working tree, but it cannot take a file Git has never seen; stage just those first.
      const listed = await git.raw(["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]);
      const untracked = listed.split("\0").filter(Boolean).map(literalPathspec);
      const before = await readHead();
      if (untracked.length) await git.raw(["add", "--", ...untracked]);
      try {
        await git.raw(["commit", "-m", message, "--only", "--", ...specs]);
        return await createdSince(before);
      } catch (error) {
        // Put the new files back to untracked so a failed commit does not leave them staged behind the user's back.
        if (untracked.length) await git.raw(["reset", "-q", "--", ...untracked]).catch(() => undefined);
        throw error;
      }
    },
    async commitAll(message) {
      const before = await readHead();
      // The caller has checked that every change was chosen. Nothing is unstaged on failure: during a merge the index holds the resolutions.
      await git.raw(["add", "--all"]);
      await git.raw(["commit", "-m", message]);
      return createdSince(before);
    },
    async getPendingOperation() {
      for (const [ref, operation] of PENDING_OPERATION_REFS) {
        if (await readRef(ref)) return operation;
      }
      return null;
    },
    checkout: async (branch) => {
      await git.checkout(branch);
    },
    checkoutNewBranch: async (branch) => {
      await git.checkoutLocalBranch(branch);
    },
    push: async (remote) => {
      await git.push(remote).catch((error: unknown) => { throw explainFailure(error, PUSH_FAILURES); });
    },
    revert: async (commit) => {
      await git.raw(["revert", "--no-edit", commit]).catch((error: unknown) => { throw explainFailure(error, REVERT_FAILURES); });
    },

    async getDiff(options) {
      const base = options.ref ?? "HEAD";
      const staged = options.staged ?? false;
      const args = options.staged ? ["--cached"] : [];
      args.push(await baselineFor(base));
      if (options.paths?.length) args.push("--", ...options.paths.map(literalPathspec));

      const [summary, patch] = await fetchDiffParts(git, args).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // A ref that does not exist is the caller's mistake, not an empty diff.
        if (/unknown revision|bad revision|ambiguous argument/i.test(message)) throw new Error(`找不到 ref：${base}`, { cause: error });
        throw error;
      });
      return shapeDiff({ base, staged, summary, patch, maxLines: options.maxPatchLines ?? 400 });
    },

    async getLog(options) {
      const recordDelimiter = "\u001e";
      const fieldDelimiter = "\u001f";
      const args = [
        "log",
        `--pretty=format:%H${fieldDelimiter}%ad${fieldDelimiter}%an${fieldDelimiter}%s${recordDelimiter}`,
        "--date=short",
        `-n${options.maxCount ?? 20}`,
      ];
      if (options.ref) args.push(options.ref);
      if (options.path) args.push("--", literalPathspec(options.path));

      const output = await git.raw(args);
      return output
        .split(recordDelimiter)
        .map((chunk) => chunk.replace(/^\n/, ""))
        .filter((chunk) => chunk.trim().length > 0)
        .map((chunk) => {
          const [hash, date, author, message] = chunk.split(fieldDelimiter);
          return { hash, date, author, message };
        });
    },

    getCommonDir: async () => {
      // --git-common-dir may answer relative to the working directory (".git").
      const raw = await git.raw(["rev-parse", "--git-common-dir"]);
      return path.resolve(input.workspaceRoot, raw.trim());
    },

    getGitDir: async () => {
      const raw = await git.raw(["rev-parse", "--absolute-git-dir"]);
      return path.resolve(input.workspaceRoot, raw.trim());
    },
  };
  return client;
}

async function fetchDiffParts(git: ReturnType<typeof simpleGit>, args: string[]): Promise<[DiffResult, string]> {
  // Wait for both processes before reporting a failure, so a rejected summary does not leave the patch process still running.
  const [summary, patch] = await Promise.allSettled([git.diffSummary(args), git.diff(args)]);
  if (summary.status === "rejected") throw summary.reason;
  if (patch.status === "rejected") throw patch.reason;
  return [summary.value, patch.value];
}

/**
 * Cuts the patch by characters, then by lines, and names the files the reader does not get in full, so a cut diff is not
 * taken for complete review evidence. Git prints files in the same order as the summary, one `diff --git` header each.
 */
export function shapeDiff(input: { base: string; staged: boolean; summary: DiffResult; patch: string; maxLines: number }): GitDiffResult {
  const { base, staged, summary, patch, maxLines } = input;
  const files = summary.files.map((entry) => entry.file);
  const perFile = summary.files.flatMap((entry) => (
    !entry.binary && "insertions" in entry && "deletions" in entry
      ? [{ file: entry.file, insertions: entry.insertions, deletions: entry.deletions }]
      : []
  ));
  const binaryFiles = summary.files.filter((entry) => entry.binary).map((entry) => entry.file);

  let kept = patch;
  let truncated = false;
  if (kept.length > MAX_PATCH_CHARS) {
    kept = kept.slice(0, MAX_PATCH_CHARS);
    truncated = true;
  }
  let lines = kept.split("\n");
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  const started = lines.filter((line) => line.startsWith("diff --git ")).length;
  // The file whose header was last shown may have been cut inside it; every file after it was not shown at all.
  const incompleteFiles = truncated ? files.slice(Math.max(0, started - 1)) : [];
  const note = incompleteFiles.length > 0
    ? `...（已截断，以下 ${incompleteFiles.length} 个文件未完整显示：${incompleteFiles.slice(0, 20).join("、")}${incompleteFiles.length > 20 ? " 等" : ""}）`
    : "...（已截断）";
  return {
    base,
    staged,
    files,
    insertions: summary.insertions,
    deletions: summary.deletions,
    truncated,
    patch: truncated ? `${lines.join("\n")}\n${note}` : patch,
    perFile,
    binaryFiles,
    incompleteFiles,
  };
}

type FailureRule = readonly [RegExp, string];

const PUSH_FAILURES: readonly FailureRule[] = [
  [/has no upstream branch|no upstream|does not match any/i, "推送失败：当前分支还没有对应的远端分支，可在终端运行 git push -u origin 分支名 建立关联"],
  [/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i, "推送失败：远端有本地没有的提交，先拉取合并后再推送"],
  [/authentication failed|could not read username|permission denied|access denied|403|401/i, "推送失败：远端拒绝了身份验证，请检查 Git 凭据或访问权限"],
  [/could not resolve host|unable to access|failed to connect|connection (timed out|refused|reset)|network is unreachable|timed out|SSL|TLS/i, "推送失败：连不上远端，请检查网络或代理"],
];

const REVERT_FAILURES: readonly FailureRule[] = [
  [/conflict/i, "回退时出现冲突：冲突文件已留在工作区，解决后提交，或在终端运行 git revert --abort 放弃"],
  [/is a merge but no -m option/i, "这是一个合并提交，回退需要指定保留哪一侧（git revert -m），面板暂不支持"],
];

/** Gives a known Git failure a plain reason and keeps Git's own first line for diagnosis. */
function explainFailure(error: unknown, rules: readonly FailureRule[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const reason = rules.find(([pattern]) => pattern.test(message))?.[1];
  if (!reason) return error instanceof Error ? error : new Error(message);
  const detail = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return new Error(detail ? `${reason}（${detail}）` : reason, { cause: error });
}

function parseNumstat(output: string): LineCounts {
  const [added, removed] = output.trim().split(/\s+/);
  return { insertions: countToken(added), deletions: countToken(removed) };
}

function countToken(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : 0;
}

function toFileChange(file: GitStatusFile, counts: LineCounts = { insertions: 0, deletions: 0 }): CodeGitFileChange {
  return {
    path: file.path,
    ...(file.fromPath ? { fromPath: file.fromPath } : {}),
    kind: kindOf(file),
    staged: isStagedEntry(file),
    unstaged: isUnstagedEntry(file),
    ...counts,
  };
}

/** 按优先级依次匹配的分类规则：冲突优先于新增，重命名优先于删除。 */
const KIND_RULES: ReadonlyArray<readonly [(file: GitStatusFile, code: string) => boolean, CodeGitChangeKind]> = [
  [(_file, code) => code.includes("U"), "conflicted"],
  [(_file, code) => code.includes("?"), "added"],
  [(file, code) => code.includes("R") || Boolean(file.fromPath), "renamed"],
  [(_file, code) => code.includes("D"), "deleted"],
  [(_file, code) => code.includes("A"), "added"],
];

function kindOf(file: GitStatusFile): CodeGitChangeKind {
  const code = `${file.index}${file.workingDir}`;
  const rule = KIND_RULES.find(([matches]) => matches(file, code));
  return rule ? rule[1] : "modified";
}

const IDLE_MARKS = new Set([" ", "?"]);

function isStagedEntry(file: GitStatusFile): boolean {
  return !IDLE_MARKS.has(file.index);
}

function isUnstagedEntry(file: GitStatusFile): boolean {
  return !IDLE_MARKS.has(file.workingDir);
}

function isUntrackedEntry(file: GitStatusFile): boolean {
  return file.index === "?" || file.workingDir === "?";
}

function tallyKinds(files: CodeGitFileChange[]): Record<CodeGitChangeKind, number> {
  const tally: Record<CodeGitChangeKind, number> = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 };
  for (const entry of files) tally[entry.kind] += 1;
  return tally;
}

/**
 * A path the caller chose names one file. Without the literal magic Git would read `*`, `?`, `[` and a leading `:(...)` as patterns,
 * so a single chosen path could match and commit other files.
 */
function literalPathspec(file: string): string {
  return `:(literal)${process.platform === "win32" ? file.replace(/\\/g, "/") : file}`;
}

/**
 * The panel lists a staged rename under its new path; commit --only needs the old path too, or the old file would stay in the commit.
 * commit --only reads that path from the working tree, so the old path is added only while nothing is there: a file recreated at it
 * was never chosen and must not be committed. Then the commit records a copy, and the staged deletion waits for a later commit.
 */
async function withRenameSources(snapshot: GitStatusSnapshot, paths: string[], workspaceRoot: string): Promise<string[]> {
  const chosen = new Set(paths.map(normalizeRepoPath));
  const sources: string[] = [];
  for (const file of snapshot.files) {
    const source = file.fromPath;
    if (!source || !chosen.has(normalizeRepoPath(file.path)) || chosen.has(normalizeRepoPath(source))) continue;
    const recreated = await fs.promises.lstat(path.join(workspaceRoot, source)).then(() => true, () => false);
    if (!recreated) sources.push(source);
  }
  return [...paths, ...new Set(sources)];
}

const PENDING_OPERATION_REFS: ReadonlyArray<readonly [string, PendingGitOperation]> = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

const OPERATION_LABELS: Record<PendingGitOperation, string> = { merge: "合并", "cherry-pick": "拣选（cherry-pick）", revert: "回退（revert）" };

/** git status codes for an unresolved conflict: either side unmerged, or both sides added or deleted. */
function isUnmergedEntry(file: GitStatusFile): boolean {
  const code = `${file.index}${file.workingDir}`;
  return code.includes("U") || code === "AA" || code === "DD";
}

const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/m;

/**
 * Concluding a merge, cherry-pick or revert commits the whole index, so it needs every change chosen and every conflict resolved.
 * The panel has no separate "mark resolved" step: a conflicted file counts as resolved once its saved content has no conflict markers,
 * and committing stages it, as `git add` would.
 */
async function assertCompletesOperation(operation: PendingGitOperation, snapshot: GitStatusSnapshot, paths: string[], workspaceRoot: string): Promise<void> {
  const label = OPERATION_LABELS[operation];
  const chosen = new Set(paths.map(normalizeRepoPath));
  const left = snapshot.files.map((file) => file.path).filter((file) => !chosen.has(normalizeRepoPath(file)));
  if (left.length) throw new Error(`正在进行${label}，这次提交需要包含全部改动，还没有选择：${listSome(left)}`);
  const conflicts: string[] = [];
  for (const file of snapshot.files.filter(isUnmergedEntry)) {
    // A side that deleted the file leaves nothing to check; keeping the deletion is a resolution.
    const content = await fs.promises.readFile(path.join(workspaceRoot, file.path), "utf8").catch(() => "");
    if (CONFLICT_MARKER.test(content)) conflicts.push(file.path);
  }
  if (conflicts.length) throw new Error(`正在进行${label}，还有未解决的冲突：${listSome(conflicts)}。解决并保存后再提交`);
}

function listSome(files: string[]): string {
  return files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个文件` : files.join("、");
}

function normalizeRepoPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function isRepoRelative(candidate: string): boolean {
  if (!candidate || path.isAbsolute(candidate) || candidate.includes("\0")) return false;
  return !candidate.replace(/\\/g, "/").split("/").includes("..");
}

const BRANCH_FORBIDDEN_CHARS = /[~^:\\?*\[\s]/;

function isSafeBranchName(candidate: string): boolean {
  if (!candidate || candidate.length > 255) return false;
  if (candidate.startsWith("-") || candidate.includes("..")) return false;
  if (BRANCH_FORBIDDEN_CHARS.test(candidate)) return false;
  return !(candidate.endsWith("/") || candidate.endsWith("."));
}

const SHA_LIKE_REF = /^[0-9a-fA-F]{7,40}$/;
const NAME_LIKE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** 只放行 commit hash、分支/标签名和 ref 路径（refs/heads/x），阻止选项注入与范围语法 */
function isSafeGitRef(candidate: string): boolean {
  if (SHA_LIKE_REF.test(candidate)) return true;
  return NAME_LIKE_REF.test(candidate)
    && !candidate.includes("..")
    && !candidate.includes("@{")
    && !candidate.endsWith(".");
}

function describeFailure(error: unknown): string {
  const fallback = "Git 状态暂时不可用";
  if (!(error instanceof Error)) return fallback;
  return error.message || fallback;
}

/** `git diff --no-index --numstat` uses exit code 1 when differences exist. */
function readGitCommandOutput(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const fields = error as { stdout?: unknown; git?: { stdout?: unknown }; message?: unknown };
  if (typeof fields.stdout === "string") return fields.stdout;
  if (typeof fields.git?.stdout === "string") return fields.git.stdout;

  const message = fields.message;
  if (typeof message !== "string" || !/^\d/.test(message)) return undefined;
  const cut = message.search(/^(warning|fatal|error):/m);
  return cut >= 0 ? message.slice(0, cut) : message;
}
