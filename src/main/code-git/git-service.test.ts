import { describe, it, vi, expect } from "vitest";
import { createGitService, type GitClient, type GitDiffQuery, type GitServiceDeps, type TrustedGitContext } from "./git-service";
import type { ChatSession } from "../../shared/chat-types";

const directory = "D:\\projects\\lantern";
const identity = "workspace-session-62";
const trusted: TrustedGitContext = { workspaceRoot: directory, mode: "code", sessionId: identity };
const tool = { source: "system" as const, command: "git", version: "2.49.2" };

function repository(replacements: Partial<GitClient> = {}): GitClient {
  return {
    getLog: vi.fn().mockResolvedValue([]), getBranches: vi.fn().mockResolvedValue(["trunk"]),
    getStatus: vi.fn().mockResolvedValue({ current: "trunk", ahead: 0, behind: 0, files: [] }),
    getLineStats: vi.fn().mockResolvedValue({ byPath: {}, insertions: 0, deletions: 0 }),
    getDiff: vi.fn(async (query: GitDiffQuery) => ({ files: [], perFile: [], patch: "", truncated: false,
      insertions: 3, deletions: 4, base: query.ref ?? "HEAD", staged: query.staged ?? false })),
    getGitDir: vi.fn().mockResolvedValue(`${directory}\\.git`), isRepository: vi.fn().mockResolvedValue(true),
    add: vi.fn(), commit: vi.fn(), init: vi.fn(), checkout: vi.fn(), checkoutNewBranch: vi.fn(), push: vi.fn(), revert: vi.fn(),
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
    expect(output).toEqual({ base: "HEAD", staged: false, files: [], perFile: [], patch: "", truncated: false, insertions: 3, deletions: 4 });
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
    await openWorkspace(repository({ getGitDir: async () => "D:\\metadata\\linked-tree" }), "code", {
      subscribe, unsubscribe: vi.fn(), dispose: vi.fn(),
    }).watchSession(identity);
    expect(subscribe.mock.calls).toEqual([[{ gitDir: "D:\\metadata\\linked-tree", workspaceRoot: directory, sessionId: identity }]]);
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
