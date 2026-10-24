import { expect, test } from "vitest";
import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import { buildGitActionIntent, buildGitPanelSummary, buildGitStatusCopy } from "./code-git-presentation";

const repository = (patch: Partial<CodeGitStatus>): CodeGitStatus => ({
  state: "ready", sessionId: "git-review", executable: { source: "system", version: "2.54.1" },
  branch: { current: "topic", detached: false, branches: ["topic", "trunk"] },
  files: [], ahead: 0, behind: 0, lines: { insertions: 0, deletions: 0 },
  summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 }, ...patch,
});

test("uses the aggregate change count for the ready repository status", () => {
  const state = repository({ summary: { added: 1, modified: 1, deleted: 1, renamed: 2, conflicted: 1 } });
  expect(buildGitStatusCopy(state)).toBe("6 个变更");
  expect(buildGitPanelSummary(state)).toBe("6 个变更");
});

test("a dirty checkout takes priority over outgoing commits", () => {
  const state = repository({ ahead: 4, files: [{ path: "docs/guide.md", kind: "added", staged: true,
    unstaged: false, insertions: 8, deletions: 0 }] });
  expect(buildGitActionIntent(state)).toStrictEqual({
    prompt: "请检查当前 Git 变更，并在确认合适后提交。", label: "提交变更",
  });
});

test("offers the exact push request only when commits are outgoing", () => {
  expect(buildGitActionIntent(repository({ ahead: 2 }))).toStrictEqual({
    prompt: "请把当前分支尚未推送的 2 个提交推送到远端。", label: "推送 2 个提交",
  });
  expect(buildGitActionIntent(repository({}))).toBeNull();
});

test("preserves the explanation supplied for a non-repository directory", () => {
  const state = repository({ state: "not_repository", executable: null, branch: null,
    message: "这个目录还不是 Git 仓库" });
  expect(buildGitActionIntent(state)).toBeNull();
  expect(buildGitStatusCopy(state)).toBe("这个目录还不是 Git 仓库");
});
