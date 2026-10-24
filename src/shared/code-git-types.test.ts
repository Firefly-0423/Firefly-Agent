import { expect, it } from "vitest";
import { emptyCodeGitStatus } from "./code-git-types";

it.each(["error", "git_unavailable", "no_workspace", "not_repository"] as const)(
  "reports an empty repository view for %s", (state) => {
    const status = emptyCodeGitStatus("workspace-audit", state, "Repository cannot be inspected");
    expect(status).toStrictEqual({
      state, sessionId: "workspace-audit", message: "Repository cannot be inspected",
      behind: 0, ahead: 0, lines: { deletions: 0, insertions: 0 }, files: [],
      summary: { conflicted: 0, renamed: 0, deleted: 0, modified: 0, added: 0 },
      branch: null, executable: null,
    });
  },
);