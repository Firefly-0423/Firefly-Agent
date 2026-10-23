import * as path from "node:path";
import { simpleGit } from "simple-git";
import type { ChatSession } from "../../shared/chat-types";
import { emptyCodeGitStatus } from "../../shared/code-git-types";
import type { CodeGitChangeKind, CodeGitFileChange, CodeGitStatus } from "../../shared/code-git-types";
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
  /** 逐文件增删统计，给 Diff Review 卡片使用 */
  perFile: Array<{ file: string; insertions: number; deletions: number }>;
};

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

export type GitClient = {
  getGitDir: () => Promise<string>;
  isRepository: () => Promise<boolean>;
  init: () => Promise<void>;
  getStatus: () => Promise<GitStatusSnapshot>;
  getBranches: () => Promise<string[]>;
  getLineStats: (files: GitStatusFile[]) => Promise<LineCounts & { byPath: Record<string, LineCounts> }>;
  getDiff: (options: GitDiffQuery) => Promise<GitDiffResult>;
  getLog: (options: GitLogQuery) => Promise<GitLogEntry[]>;
  add: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<string>;
  checkout: (branch: string) => Promise<void>;
  checkoutNewBranch: (branch: string) => Promise<void>;
  push: (remote: string) => Promise<void>;
  revert: (commit: string) => Promise<void>;
};

export type GitServiceDeps = {
  workspaceWatcher?: GitWorkspaceWatcher;
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

function isStatusResult(value: ReadyWorkspace | CodeGitStatus): value is CodeGitStatus {
  return "state" in value;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const makeClient = deps.createClient ?? createSimpleGitClient;
  const subscribers = new Set<(payload: { sessionId: string }) => void>();
  const workspaceWatcher = deps.workspaceWatcher ?? createGitWorkspaceWatcher({
    onWorkspaceChanged: (sessionIds) => {
      for (const id of sessionIds) notify(id);
    },
    onError: () => undefined,
  });

  function notify(sessionId: string): void {
    for (const listener of subscribers) listener({ sessionId });
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

  return {
    onChanged(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    async watchSession(sessionId) {
      const ready = await requireReadyWorkspace(sessionId);
      const client = makeClient(ready);
      if (!(await client.isRepository())) throw new Error("这个目录还不是 Git 仓库");
      await workspaceWatcher.subscribe({
        sessionId,
        workspaceRoot: ready.workspaceRoot,
        gitDir: await client.getGitDir(),
      });
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
      await client.init();
      notify(ctx.sessionId);
      return "已初始化 Git 仓库";
    },

    async commit(ctx, message, paths) {
      if (!message.trim()) throw new Error("提交信息不能为空");
      if (paths.length === 0 || !paths.every(isRepoRelative)) {
        throw new Error("请提供要提交的仓库内文件路径");
      }
      const client = await clientFor(ctx);
      await client.add(paths);
      const created = await client.commit(message.trim());
      notify(ctx.sessionId);
      return created;
    },

    async switchBranch(ctx, branch, create) {
      if (!isSafeBranchName(branch)) throw new Error("分支名称不合法");
      const client = await clientFor(ctx);
      if (create) {
        await client.checkoutNewBranch(branch);
      } else {
        await client.checkout(branch);
      }
      notify(ctx.sessionId);
      return `已切换到分支 ${branch}`;
    },

    async push(ctx, remote = "origin") {
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("远端名称不合法");
      const client = await clientFor(ctx);
      await client.push(remote);
      notify(ctx.sessionId);
      return `已推送到 ${remote}`;
    },

    async revert(ctx, commit) {
      if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("提交标识必须是 7 到 40 位十六进制 hash");
      const client = await clientFor(ctx);
      await client.revert(commit);
      notify(ctx.sessionId);
      return `已创建回退提交 ${commit}`;
    },

    async diff(ctx, options = {}) {
      const client = await clientFor(ctx);
      const ref = options.ref ?? "HEAD";
      if (!isSafeGitRef(ref)) throw new Error("ref 不合法");
      const paths = options.paths ?? [];
      if (!paths.every(isRepoRelative)) throw new Error("请提供仓库内相对路径");
      const query: GitDiffQuery = { maxPatchLines: options.maxPatchLines ?? 400, paths, ref };
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

        const client = makeClient(gate);
        if (!(await client.isRepository())) {
          return emptyCodeGitStatus(sessionId, "not_repository", "这个目录还不是 Git 仓库");
        }

        const [snapshot, branches] = await Promise.all([client.getStatus(), client.getBranches()]);
        const stats = await client.getLineStats(snapshot.files);
        const files = snapshot.files.map((file) => toFileChange(file, stats.byPath[file.path]));
        const detached = snapshot.current === "HEAD";
        const { source, version } = gate.executable;
        const ready: CodeGitStatus = {
          sessionId,
          state: "ready",
          executable: { source, version },
          branch: { current: detached ? null : snapshot.current, detached, branches },
          files,
          summary: tallyKinds(files),
          lines: { insertions: stats.insertions, deletions: stats.deletions },
          ahead: snapshot.ahead,
          behind: snapshot.behind,
        };
        return ready;
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
      const emptySummary = { insertions: 0, deletions: 0, files: [] };
      const tracked = await git.diffSummary(["HEAD"]).catch(() => emptySummary);
      let insertions = tracked.insertions;
      let deletions = tracked.deletions;
      const byPath: Record<string, LineCounts> = {};
      for (const entry of tracked.files ?? []) {
        if ("file" in entry && "insertions" in entry && "deletions" in entry) {
          byPath[entry.file] = { insertions: entry.insertions, deletions: entry.deletions };
        }
      }

      // 未跟踪文件没有 HEAD 基线，改用 --no-index 与空文件对比来计算行数。
      for (const untracked of files.filter(isUntrackedEntry)) {
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
      return { insertions, deletions, byPath };
    },

    init: async () => {
      await git.init();
    },
    add: async (paths) => {
      await git.raw(["add", "-A", "--", ...paths]);
    },
    async commit(message) {
      const result = await git.commit(message);
      return result.commit ? `已创建提交 ${result.commit}` : "已创建提交";
    },
    checkout: async (branch) => {
      await git.checkout(branch);
    },
    checkoutNewBranch: async (branch) => {
      await git.checkoutLocalBranch(branch);
    },
    push: async (remote) => {
      await git.push(remote);
    },
    revert: async (commit) => {
      await git.raw(["revert", "--no-edit", commit]);
    },

    async getDiff(options) {
      const base = options.ref ?? "HEAD";
      const staged = options.staged ?? false;
      const args = options.staged ? ["--cached"] : [];
      args.push(base);
      if (options.paths?.length) args.push("--", ...options.paths);

      const fetched = await fetchDiffParts(git, args).then(
        (parts) => parts,
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // 新仓库尚无提交时 HEAD 不存在，按无差异处理。
          if (/unknown revision|bad revision|ambiguous argument/i.test(message)) return null;
          throw error;
        },
      );
      if (fetched === null) {
        return { base, staged, files: [], insertions: 0, deletions: 0, truncated: false, patch: "", perFile: [] };
      }

      const [summary, patch] = fetched;
      const maxLines = options.maxPatchLines ?? 400;
      const lines = patch.split("\n");
      const truncated = lines.length > maxLines;
      const perFile = summary.files.flatMap((entry) => (
        "insertions" in entry && "deletions" in entry
          ? [{ file: entry.file, insertions: entry.insertions, deletions: entry.deletions }]
          : []
      ));
      return {
        base,
        staged,
        files: perFile.map((entry) => entry.file),
        insertions: summary.insertions,
        deletions: summary.deletions,
        truncated,
        patch: truncated ? `${lines.slice(0, maxLines).join("\n")}\n...（已截断）` : patch,
        perFile,
      };
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
      if (options.path) args.push("--", options.path);

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

    getGitDir: async () => {
      const raw = await git.raw(["rev-parse", "--absolute-git-dir"]);
      return path.resolve(input.workspaceRoot, raw.trim());
    },
  };
  return client;
}

async function fetchDiffParts(git: ReturnType<typeof simpleGit>, args: string[]) {
  return Promise.all([git.diffSummary(args), git.diff(args)]);
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
