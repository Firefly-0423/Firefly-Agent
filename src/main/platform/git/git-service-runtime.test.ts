import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../shared/chat-types";
import { createGitService, MAX_UNTRACKED_LINE_STATS } from "./git-service";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-runtime-")));
  roots.push(root);
  const templates = path.join(root, "empty-templates");
  fs.mkdirSync(templates);
  execFileSync("git", ["init", "--initial-branch=main", `--template=${templates}`], { cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  const session: ChatSession = { id: "public-git-fixture", title: "public Git fixture", identityId: null, messages: [], createdAt: 1, updatedAt: 1, schemaVersion: 1, mode: "code", workspaceBinding: { workspaceRoot: root, displayName: "public fixture", boundAt: 1 } };
  return { root, session };
}

describe("actual simple-git runtime compatibility", () => {
  it("does not inherit trace destinations or injected Git configuration from the host", () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-host-env-")));
    roots.push(root);
    const trace = path.join(root, "must-not-write-trace.json");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", path.join(root, "must-not-load-hooks"));
    fixture();
    expect(fs.existsSync(trace)).toBe(false);
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("keeps the normal system Git path working without granting inherited pager execution", async () => {
    const context = fixture();
    vi.stubEnv("GIT_PAGER", "firefly-public-never-execute");
    vi.stubEnv("PAGER", "firefly-public-never-execute");
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "system", version: "public-fixture" }) });
    try {
      expect((await service.getStatusForSession(context.session.id)).state).toBe("ready");
    } finally { await service.dispose(); }
  });

  it("preserves bundled Git config isolation without forwarding inherited pager commands", async () => {
    const context = fixture();
    vi.stubEnv("GIT_PAGER", "firefly-public-never-execute");
    vi.stubEnv("PAGER", "firefly-public-never-execute");
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "bundled", version: "public-fixture", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" } }) });
    try {
      const status = await service.getStatusForSession(context.session.id);
      expect(status.state).toBe(process.platform === "win32" ? "ready" : "error");
      if (process.platform !== "win32") expect(status.message).toMatch(/GIT_CONFIG_GLOBAL/);
    } finally { await service.dispose(); }
  });

  it("continues rejecting arbitrary explicit global configuration paths", async () => {
    const context = fixture();
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "bundled", version: "public-fixture", env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(context.root, "must-not-read-config") } }) });
    try {
      const status = await service.getStatusForSession(context.session.id);
      expect(status.state).toBe("error");
      expect(status.message).toMatch(/GIT_CONFIG_GLOBAL/);
      expect(fs.existsSync(path.join(context.root, "must-not-read-config"))).toBe(false);
    } finally { await service.dispose(); }
  });
});

describe("committing selected files in a real repository", () => {
  function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  }
  function repositoryWithHistory() {
    const context = fixture();
    git(context.root, "config", "user.name", "Fixture");
    git(context.root, "config", "user.email", "fixture@example.invalid");
    git(context.root, "config", "core.autocrlf", "false");
    for (const name of ["edited.txt", "removed.txt", "moved.txt", "partial.txt", "unrelated.txt"]) fs.writeFileSync(path.join(context.root, name), `${name} v1\n`);
    git(context.root, "add", "--all");
    git(context.root, "commit", "-q", "-m", "base");
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "system", version: "public-fixture" }) });
    const ctx = { sessionId: context.session.id, mode: "code" as const, workspaceRoot: context.root };
    return { ...context, ctx, service, git: (...args: string[]) => git(context.root, ...args) };
  }
  const lines = (output: string) => output.split(/\r?\n/).filter(Boolean).sort();

  it("commits only the chosen paths and leaves other staged work staged", async () => {
    const repo = repositoryWithHistory();
    try {
      fs.writeFileSync(path.join(repo.root, "unrelated.txt"), "unrelated v2\n");
      repo.git("add", "unrelated.txt");
      fs.writeFileSync(path.join(repo.root, "edited.txt"), "edited v2\n");
      fs.rmSync(path.join(repo.root, "removed.txt"));
      fs.writeFileSync(path.join(repo.root, "created.txt"), "created\n");
      fs.writeFileSync(path.join(repo.root, "partial.txt"), "partial staged\n");
      repo.git("add", "partial.txt");
      fs.writeFileSync(path.join(repo.root, "partial.txt"), "partial working tree\n");
      repo.git("mv", "moved.txt", "renamed.txt");

      // The panel sends the new path of a staged rename; its old path has to go with it.
      await repo.service.commit(repo.ctx, "selected work", ["edited.txt", "removed.txt", "created.txt", "partial.txt", "renamed.txt"]);

      expect(lines(repo.git("show", "--name-status", "--format=", "HEAD"))).toEqual([
        "A\tcreated.txt", "D\tremoved.txt", "M\tedited.txt", "M\tpartial.txt", "R100\tmoved.txt\trenamed.txt",
      ]);
      // A chosen file is committed as it is in the working tree.
      expect(repo.git("show", "HEAD:partial.txt")).toBe("partial working tree\n");
      expect(repo.git("status", "--porcelain").trim()).toBe("M  unrelated.txt");
    } finally { await repo.service.dispose(); }
  });

  it("treats pathspec magic in a chosen path as a literal file name", async () => {
    const repo = repositoryWithHistory();
    try {
      fs.writeFileSync(path.join(repo.root, "edited.txt"), "edited v2\n");
      fs.writeFileSync(path.join(repo.root, "created.txt"), "created\n");
      const head = repo.git("rev-parse", "HEAD");
      await expect(repo.service.commit(repo.ctx, "glob", [":(glob)*.txt"])).rejects.toThrow();
      expect(repo.git("rev-parse", "HEAD")).toBe(head);
      expect(lines(repo.git("status", "--porcelain"))).toEqual([" M edited.txt", "?? created.txt"]);
      expect((await repo.service.diff(repo.ctx, { paths: [":(glob)*.txt"] })).files).toEqual([]);
      expect((await repo.service.diff(repo.ctx, { paths: ["edited.txt"] })).files).toEqual(["edited.txt"]);
    } finally { await repo.service.dispose(); }
  });

  it("puts new files back to untracked when the commit fails", async () => {
    const repo = repositoryWithHistory();
    try {
      fs.writeFileSync(path.join(repo.root, "created.txt"), "created\n");
      fs.mkdirSync(path.join(repo.root, "hooks"));
      fs.writeFileSync(path.join(repo.root, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      repo.git("config", "core.hooksPath", "hooks");
      const head = repo.git("rev-parse", "HEAD");
      await expect(repo.service.commit(repo.ctx, "blocked", ["created.txt"])).rejects.toThrow();
      expect(repo.git("rev-parse", "HEAD")).toBe(head);
      expect(repo.git("status", "--porcelain", "--", "created.txt").trim()).toBe("?? created.txt");
    } finally { await repo.service.dispose(); }
  });

  it("leaves a recreated rename source out unless it was chosen", async () => {
    const repo = repositoryWithHistory();
    try {
      repo.git("mv", "moved.txt", "renamed.txt");
      fs.writeFileSync(path.join(repo.root, "moved.txt"), "replacement\n");
      await repo.service.commit(repo.ctx, "rename only", ["renamed.txt"]);
      expect(lines(repo.git("show", "--name-status", "--format=", "HEAD"))).toEqual(["A\trenamed.txt"]);
      expect(repo.git("show", "HEAD:moved.txt")).toBe("moved.txt v1\n");
      // The staged deletion is kept for a later commit, and the replacement stays untracked.
      expect(lines(repo.git("status", "--porcelain"))).toEqual(["?? moved.txt", "D  moved.txt"]);
    } finally { await repo.service.dispose(); }
  });

  /** main and side both change edited.txt; side also changes unrelated.txt, which merges cleanly. */
  function conflictedMerge() {
    const repo = repositoryWithHistory();
    repo.git("switch", "-q", "-c", "side");
    fs.writeFileSync(path.join(repo.root, "edited.txt"), "side\n");
    fs.writeFileSync(path.join(repo.root, "unrelated.txt"), "side\n");
    repo.git("commit", "-q", "-am", "side");
    repo.git("switch", "-q", "main");
    fs.writeFileSync(path.join(repo.root, "edited.txt"), "main\n");
    repo.git("commit", "-q", "-am", "main");
    expect(() => repo.git("merge", "-q", "side")).toThrow();
    return repo;
  }

  it("concludes a merge once every conflict is resolved and every change is chosen", async () => {
    const repo = conflictedMerge();
    try {
      fs.writeFileSync(path.join(repo.root, "edited.txt"), "resolved\n");
      await repo.service.commit(repo.ctx, "merge side", ["edited.txt", "unrelated.txt"]);
      expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
      expect(repo.git("show", "HEAD:edited.txt")).toBe("resolved\n");
      expect(repo.git("status", "--porcelain")).toBe("");
    } finally { await repo.service.dispose(); }
  });

  it("refuses to conclude a merge while a conflict is unresolved or a change is left out", async () => {
    const repo = conflictedMerge();
    try {
      const head = repo.git("rev-parse", "HEAD");
      await expect(repo.service.commit(repo.ctx, "merge side", ["edited.txt", "unrelated.txt"])).rejects.toThrow("还有未解决的冲突：edited.txt");
      repo.git("add", "edited.txt");
      await expect(repo.service.commit(repo.ctx, "merge side", ["edited.txt"])).rejects.toThrow("还没有选择：unrelated.txt");
      expect(repo.git("rev-parse", "HEAD")).toBe(head);
      expect(repo.git("rev-parse", "-q", "--verify", "MERGE_HEAD").trim()).not.toBe("");
    } finally { await repo.service.dispose(); }
  });

  it("explains a push without an upstream and a conflicted revert", async () => {
    const repo = repositoryWithHistory();
    try {
      const remote = path.join(repo.root, "..", `${path.basename(repo.root)}-remote.git`);
      roots.push(remote);
      git(repo.root, "init", "-q", "--bare", remote);
      repo.git("remote", "add", "origin", remote);
      repo.git("switch", "-q", "-c", "topic");
      await expect(repo.service.push(repo.ctx)).rejects.toThrow("当前分支还没有对应的远端分支");

      fs.writeFileSync(path.join(repo.root, "edited.txt"), "second\n");
      repo.git("commit", "-q", "-am", "second");
      const second = repo.git("rev-parse", "HEAD").trim();
      fs.writeFileSync(path.join(repo.root, "edited.txt"), "third\n");
      repo.git("commit", "-q", "-am", "third");
      await expect(repo.service.revert(repo.ctx, second)).rejects.toThrow("回退时出现冲突");
    } finally { await repo.service.dispose(); }
  });
});

describe("reading a repository before and around its first commit", () => {
  function emptyRepository() {
    const context = fixture();
    const service = createGitService({ getSession: () => context.session, resolveExecutable: async () => ({ command: "git", source: "system", version: "public-fixture" }) });
    return { ...context, service, ctx: { sessionId: context.session.id, mode: "code" as const, workspaceRoot: context.root } };
  }

  it("compares staged files with the empty tree instead of reporting no change", async () => {
    const repo = emptyRepository();
    try {
      fs.writeFileSync(path.join(repo.root, "first.txt"), "one\ntwo\n");
      execFileSync("git", ["add", "first.txt"], { cwd: repo.root, windowsHide: true });
      const diff = await repo.service.diff(repo.ctx, { staged: true });
      expect(diff).toMatchObject({ base: "HEAD", files: ["first.txt"], insertions: 2 });
      const status = await repo.service.getStatusForSession(repo.session.id);
      expect(status).toMatchObject({ state: "ready", lines: { insertions: 2, deletions: 0 } });
    } finally { await repo.service.dispose(); }
  });

  it("reports a ref that does not exist instead of an empty diff", async () => {
    const repo = emptyRepository();
    try {
      await expect(repo.service.diff(repo.ctx, { ref: "no-such-branch" })).rejects.toThrow("找不到 ref：no-such-branch");
    } finally { await repo.service.dispose(); }
  });

  it("stops counting untracked lines past the budget and says the total is partial", async () => {
    const repo = emptyRepository();
    try {
      for (let index = 0; index <= MAX_UNTRACKED_LINE_STATS; index += 1) fs.writeFileSync(path.join(repo.root, `note-${index}.txt`), "line\n");
      const status = await repo.service.getStatusForSession(repo.session.id);
      expect(status.files).toHaveLength(MAX_UNTRACKED_LINE_STATS + 1);
      expect(status.lines).toEqual({ insertions: MAX_UNTRACKED_LINE_STATS, deletions: 0, partial: true });
    } finally { await repo.service.dispose(); }
  }, 120_000);
});
