import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import { t } from "../../../i18n";

export type GitActionIntent = { prompt: string; label: string };

export function buildGitPanelSummary(status: CodeGitStatus): string {
  let changed = 0;
  for (const amount of Object.values(status.summary)) changed += amount;
  if (changed === 0) return t("codeGit.workspaceClean");
  return t("codeGit.changeCount", { count: changed });
}

export function buildGitStatusCopy(status: CodeGitStatus): string {
  return status.state === "ready"
    ? buildGitPanelSummary(status)
    : (status.message ?? t("codeGit.statusUnavailable"));
}

export function buildGitActionIntent(status: CodeGitStatus): GitActionIntent | null {
  if (status.state !== "ready") return null;
  const dirty = status.files.length > 0;
  if (!dirty && !(status.ahead > 0)) return null;
  const label = dirty
    ? t("codeGit.commitChanges")
    : t("codeGit.pushCommits", { count: status.ahead });
  const prompt = dirty
    ? t("codeGit.intentCommitPrompt")
    : t("codeGit.intentPushPrompt", { count: status.ahead });
  return { label, prompt };
}

export function changeKindLabel(kind: CodeGitStatus["files"][number]["kind"]): string {
  const translations: Record<typeof kind, string> = {
    conflicted: "codeGit.kindConflicted", renamed: "codeGit.kindRenamed",
    deleted: "codeGit.kindDeleted", modified: "codeGit.kindModified", added: "codeGit.kindAdded",
  };
  return t(translations[kind]);
}
