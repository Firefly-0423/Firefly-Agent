export type CodeGitState = "ready" | "no_workspace" | "git_unavailable" | "not_repository" | "error";
export type CodeGitExecutableSource = "system" | "bundled";
export type CodeGitChangeKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";
export type CodeGitFileChange = {
  deletions: number; insertions: number; unstaged: boolean; staged: boolean;
  kind: CodeGitChangeKind; fromPath?: string; path: string;
};
export type CodeGitStatus = {
  behind: number; ahead: number;
  /** partial: some untracked files were past the counting budget and are not in the totals. */
  lines: { deletions: number; insertions: number; partial?: boolean };
  summary: Record<CodeGitChangeKind, number>; files: CodeGitFileChange[];
  branch: { branches: string[]; detached: boolean; current: string | null } | null;
  executable: { version: string; source: CodeGitExecutableSource } | null;
  message?: string; state: CodeGitState; sessionId: string;
};
/** Untracked files are counted one Git process each; past this many, the status line totals are marked partial. */
export const MAX_UNTRACKED_LINE_STATS = 200;
export type CodeGitChangedPayload = { sessionId: string };
export function emptyCodeGitStatus(
  sessionId: string, state: Exclude<CodeGitState, "ready">, message: string,
): CodeGitStatus {
  const totals: Record<CodeGitChangeKind, number> = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 };
  return { sessionId, state, message, executable: null, branch: null, files: [],
    summary: totals, lines: { insertions: 0, deletions: 0 }, ahead: 0, behind: 0 };
}
