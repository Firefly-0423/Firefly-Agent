import { describe, it, vi, expect } from "vitest";
import type { DiffResult } from "simple-git";
import { createGitService, MAX_PATCH_CHARS, shapeDiff, type GitClient, type GitDiffQuery, type GitServiceDeps, type TrustedGitContext } from "./git-service";
import type { ChatSession } from "../../shared/chat-types";

const directory = "D:\\projects\\lantern";
const identity = "workspace-session-62";
const trusted: TrustedGitContext = { workspaceRoot: directory, mode: "code", sessionId: identity };
const tool = { source: "system" as const, command: "git", version: "2.49.2" };

function repository(replacements: Partial<GitClient> = {}): GitClient {
  return {
    getLog: vi.fn().mockResolvedValue([]), getBranches: vi.fn().mockResolvedValue(["trunk"]),
    getStatus: vi.fn().mockResolvedValue({ current: "trunk", ahead: 0, behind: 0, files: [] }),
    getLineStats: vi.fn().mockResolvedValue({ byPath: {}, insertions: 0, deletions: 0, partial: false }),
    getDiff: vi.fn(async (query: GitDiffQuery) => ({ files: [], perFile: [], binaryFiles: [], incompleteFiles: [], patch: "", truncated: false,
      insertions: 3, deletions: 4, base: query.ref ?? "HEAD", staged: query.staged ?? false })),
    getGitDir: vi.fn().mockResolvedValue(`${directory}\\.git`), getCommonDir: vi.fn().mockResolvedValue(`${directory}\\.git`), isRepository: vi.fn().mockResolvedValue(true),
    commit: vi.fn(), commitAll: vi.fn(), getPendingOperation: vi.fn().mockResolvedValue(null), init: vi.fn(), checkout: vi.fn(), checkoutNewBranch: vi.fn(), push: vi.fn(), revert: vi.fn(),
    ...replacements,
  };
}

function openWorkspace(git = repository(), mode: ChatSession["mode"] = "code", watcher?: GitServiceDeps["workspaceWatcher"]) {
  const tab: ChatSession = { id: identity, title: "Inspect local changes", mode, identityId: null,
    createdAt: 17, updatedAt: 29, schemaVersion: 1, messages: [],
    workspaceBinding: { workspaceRoot: directory, displayName: "lantern", boundAt: 13 } };
  return createGitService({ getSession: () => tab, createClient: () => git, resolveExecutable: async () => tool,
    workspaceWatcher: watcher ?? { subscribe: vi.fn(), unsubscribe: vi.fn(), dispose: vi.fn() } });
}

describe("Validated repository queries", () => {
  it("uses a bounded working tree diff when no options are supplied", async () => {
    const git = repository();
    const output = await openWorkspace(git).diff(trusted);
    expect(git.getDiff).toHaveBeenCalledExactlyOnceWith({ paths: [], maxPatchLines: 400, staged: false, ref: "HEAD" });
    expect(output).toEqual({ base: "HEAD", staged: false, files: [], perFile: [], binaryFiles: [], incompleteFiles: [], patch: "", truncated: false, insertions: 3, deletions: 4 });
  });

  it("accepts hashes, branch names, tags and full ref names", async () => {
    const git = repository();
    const api = openWorkspace(git);
    const revisions = ["fedcba9876", "repair/toolbar", "v3.7.1", "refs/heads/trunk"];
    for (const ref of revisions) await api.diff(trusted, { ref });
    expect(git.getDiff).toHaveBeenCalledTimes(4);
    expect(vi.mocked(git.getDiff).mock.calls.map(([query]) => query.ref)).toEqual(revisions);
  });

  it.each(["--exec=untrusted", "trunk..remote"])("blocks unsafe diff revisions %s", async (ref) => {
    const git = repository();
    await expect(openWorkspace(git).diff(trusted, { ref })).rejects.toThrow("ref 不合法");
    expect(git.getDiff).not.toHaveBeenCalled();
  });

  it("blocks parent directory traversal in diff queries", async () => {
    const git = repository();
    await expect(openWorkspace(git).diff(trusted, { paths: ["../private.md"] })).rejects.toThrow("请提供仓库内相对路径");
    expect(git.getDiff).not.toHaveBeenCalled();
  });

  it("returns the history entries unchanged and forwards the complete query", async () => {
    const history = [{ hash: "fedcba9", author: "Local Author", date: "2026-10-02", message: "repair toolbar" }];
    const git = repository({ getLog: vi.fn().mockResolvedValue(history) });
    expect(await openWorkspace(git).log(trusted, { ref: "trunk", path: "ui/toolbar.ts", maxCount: 5 })).toEqual(history);
    expect(git.getLog).toHaveBeenCalledExactlyOnceWith({ path: "ui/toolbar.ts", maxCount: 5, ref: "trunk" });
  });

  it.each([0, 201, 1.5])("rejects a history limit of %s", async (maxCount) => {
    const git = repository();
    await expect(openWorkspace(git).log(trusted, { maxCount })).rejects.toThrow("maxCount 必须是 1 到 200 的整数");
    expect(git.getLog).not.toHaveBeenCalled();
  });

  it.each([
    [{ ref: "--upload-pack=untrusted" }, "ref 不合法"],
    [{ path: "../private" }, "请提供仓库内相对路径"],
  ] as const)("rejects invalid history selectors %j", async (query, message) => {
    const git = repository();
    await expect(openWorkspace(git).log(trusted, query)).rejects.toThrow(message);
    expect(git.getLog).not.toHaveBeenCalled();
  });
});

describe("Session Git presentation", () => {
  it("subscribes with the repository metadata location reported by Git", async () => {
    const subscribe = vi.fn();
    await openWorkspace(repository({ getGitDir: async () => "D:\\metadata\\worktrees\\linked-tree", getCommonDir: async () => "D:\\metadata" }), "code", {
      subscribe, unsubscribe: vi.fn(), dispose: vi.fn(),
    }).watchSession(identity);
    expect(subscribe.mock.calls).toEqual([[{ gitDir: "D:\\metadata\\worktrees\\linked-tree", commonDir: "D:\\metadata", workspaceRoot: directory, sessionId: identity }]]);
  });

  it.each(["chat", "work", "learn"])("hides repository details in %s mode", async (mode) => {
    const git = repository();
    expect(await openWorkspace(git, mode as ChatSession["mode"]).getStatusForSession(identity)).toMatchObject({
      files: [], message: "Git 工作台只在 Code 模式可用", state: "error",
    });
    expect(git.getStatus).not.toHaveBeenCalled();
  });

  it("distinguishes a folder without repository metadata from a clean repository", async () => {
    const result = await openWorkspace(repository({ isRepository: async () => false })).getStatusForSession(identity);
    expect(result).toMatchObject({ files: [], message: "这个目录还不是 Git 仓库", state: "not_repository" });
  });

  it("preserves file order while presenting kinds, totals and branch divergence", async () => {
    const git = repository({
      getBranches: async () => ["trunk", "repair/toolbar"],
      getStatus: async () => ({ current: "trunk", ahead: 2, behind: 1, files: [
        { path: "draft.md", workingDir: "?", index: "?" },
        { path: "ui/toolbar.ts", workingDir: "M", index: " " },
        { path: "obsolete.md", workingDir: " ", index: "D" },
        { path: "guide.md", fromPath: "help.md", workingDir: " ", index: "R" },
        { path: "merge.md", workingDir: "U", index: "U" },
      ] }),
      getLineStats: async () => ({ insertions: 100, deletions: 23, byPath: { "ui/toolbar.ts": { insertions: 100, deletions: 23 } } }),
    });
    const view = await openWorkspace(git).getStatusForSession(identity);
    expect(view).toMatchObject({ state: "ready", ahead: 2, behind: 1,
      lines: { deletions: 23, insertions: 100 }, summary: { conflicted: 1, renamed: 1, deleted: 1, modified: 1, added: 1 },
      branch: { branches: ["trunk", "repair/toolbar"], detached: false, current: "trunk" } });
    expect(view.files.map(({ kind }) => kind)).toEqual(["added", "modified", "deleted", "renamed", "conflicted"]);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("Writes to one repository", () => {
  it("run one after another, and a failed write does not block the next", async () => {
    const first = deferred<string>();
    const order: string[] = [];
    const git = repository({
      commit: vi.fn(async () => { order.push("commit:start"); const created = await first.promise; order.push("commit:end"); return created; }),
      checkout: vi.fn(async () => { order.push("checkout"); }),
      push: vi.fn(async () => { order.push("push"); throw new Error("offline"); }),
      revert: vi.fn(async () => { order.push("revert"); }),
    });
    const api = openWorkspace(git);
    const committing = api.commit(trusted, "first", ["a.ts"]);
    const switching = api.switchBranch(trusted, "topic", false);
    const pushing = api.push(trusted);
    const reverting = api.revert(trusted, "abcdef1");
    await vi.waitFor(() => expect(order).toEqual(["commit:start"]));
    await new Promise((done) => setTimeout(done, 20));
    expect(git.checkout).not.toHaveBeenCalled();
    first.resolve("已创建提交 abcdef1");
    await committing;
    await switching;
    await expect(pushing).rejects.toThrow("offline");
    await reverting;
    expect(order).toEqual(["commit:start", "commit:end", "checkout", "push", "revert"]);
  });
});

describe("Status reads", () => {
  it("share one read between concurrent requests for the same repository", async () => {
    const snapshot = deferred<Awaited<ReturnType<GitClient["getStatus"]>>>();
    const git = repository({ getStatus: vi.fn(() => snapshot.promise) });
    const api = openWorkspace(git);
    const reads = [api.getStatusForSession(identity), api.getStatusForSession(identity), api.getStatusForSession(identity)];
    await vi.waitFor(() => expect(git.getStatus).toHaveBeenCalledTimes(1));
    snapshot.resolve({ current: "trunk", ahead: 0, behind: 0, files: [] });
    const results = await Promise.all(reads);
    expect(results.map((result) => [result.state, result.sessionId])).toEqual(Array(3).fill(["ready", identity]));
    expect(git.getStatus).toHaveBeenCalledTimes(1);
    await api.getStatusForSession(identity);
    expect(git.getStatus).toHaveBeenCalledTimes(2);
  });

  it("do not hand out a read that started before a write", async () => {
    const stale = deferred<Awaited<ReturnType<GitClient["getStatus"]>>>();
    const getStatus = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ current: "topic", ahead: 0, behind: 0, files: [] });
    const api = openWorkspace(repository({ getStatus }));
    const before = api.getStatusForSession(identity);
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    await api.switchBranch(trusted, "topic", false);
    const after = await api.getStatusForSession(identity);
    expect(after.branch?.current).toBe("topic");
    stale.resolve({ current: "trunk", ahead: 0, behind: 0, files: [] });
    expect((await before).branch?.current).toBe("trunk");
  });

  it("mark line totals as partial when untracked files were past the counting budget", async () => {
    const git = repository({ getLineStats: vi.fn().mockResolvedValue({ byPath: {}, insertions: 7, deletions: 0, partial: true }) });
    expect((await openWorkspace(git).getStatusForSession(identity)).lines).toEqual({ insertions: 7, deletions: 0, partial: true });
  });

  it("report a failed line count as an error instead of zero changes", async () => {
    const git = repository({ getLineStats: vi.fn().mockRejectedValue(new Error("fatal: index file corrupt")) });
    expect(await openWorkspace(git).getStatusForSession(identity)).toMatchObject({ state: "error", message: "fatal: index file corrupt" });
  });
});

describe("Diff limits", () => {
  it.each([0, 5001, 2.5])("reject a patch line limit of %s", async (maxPatchLines) => {
    const git = repository();
    await expect(openWorkspace(git).diff(trusted, { maxPatchLines })).rejects.toThrow("maxPatchLines 必须是 1 到 5000 的整数");
    expect(git.getDiff).not.toHaveBeenCalled();
  });

  const summary = (files: DiffResult["files"]) => ({ changed: files.length, insertions: 30, deletions: 0, files } as DiffResult);
  const text = (file: string) => ({ file, changes: 10, insertions: 10, deletions: 0, binary: false as const });

  it("names the files a truncated patch does not show in full", () => {
    const patch = ["a.ts", "b.ts", "c.ts"].map((file) => [`diff --git a/${file} b/${file}`, "@@ -0,0 +1,3 @@", "+1", "+2", "+3"].join("\n")).join("\n");
    const result = shapeDiff({ base: "HEAD", staged: false, summary: summary([text("a.ts"), text("b.ts"), text("c.ts")]), patch, maxLines: 7 });
    expect(result.truncated).toBe(true);
    expect(result.incompleteFiles).toEqual(["b.ts", "c.ts"]);
    expect(result.patch.split("\n")).toHaveLength(8);
    expect(result.patch).toContain("以下 2 个文件未完整显示：b.ts、c.ts");
  });

  it("cuts an oversized single line by characters before counting lines", () => {
    const patch = `diff --git a/min.js b/min.js\n+${"x".repeat(MAX_PATCH_CHARS * 2)}`;
    const result = shapeDiff({ base: "HEAD", staged: false, summary: summary([text("min.js")]), patch, maxLines: 400 });
    expect(result.truncated).toBe(true);
    expect(result.patch.length).toBeLessThan(MAX_PATCH_CHARS + 200);
    expect(result.incompleteFiles).toEqual(["min.js"]);
  });

  it("lists binary files without inventing line counts for them", () => {
    const binary = { file: "logo.png", before: 10, after: 12, binary: true as const };
    const result = shapeDiff({ base: "HEAD", staged: false, summary: summary([text("a.ts"), binary]), patch: "diff --git a/a.ts b/a.ts", maxLines: 400 });
    expect(result).toMatchObject({ files: ["a.ts", "logo.png"], binaryFiles: ["logo.png"], truncated: false, incompleteFiles: [] });
    expect(result.perFile.map((entry) => entry.file)).toEqual(["a.ts"]);
  });
});
