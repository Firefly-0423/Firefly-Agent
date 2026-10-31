import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal } from "antd";
import { useTranslation } from "../../../i18n";
import { Button, IconButton } from "../../../components/ui/Button";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../../../../shared/code-git-types";
import type { TodoState } from "../../../../../shared/todo-types";
import { buildGitStatusCopy } from "./code-git-presentation";
import { useFloatingCard } from "./floating-card";
import { createCodeGitRefreshController, type CodeGitRefreshController } from "./code-git-refresh";
import { PlanReviewEntry, type PlanReviewPhase } from "./PlanReviewPanel";
import './CodeGitPanel.css';

type CodeGitApi = {
  onChanged(callback: (payload: CodeGitChangedPayload) => void): () => void;
  push(sessionId: string): Promise<void>;
  commit(sessionId: string, message: string, paths: string[]): Promise<void>;
  switchBranch(sessionId: string, branch: string, create?: boolean): Promise<void>;
  unwatch(sessionId: string): Promise<void>;
  watch(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<CodeGitStatus>;
};

export type CodeGitPanelProps = {
  onOpenPlan?: () => void;
  planPhase?: PlanReviewPhase;
  todoState: TodoState | null;
  projectName?: string;
  sessionId: string;
  expanded?: boolean;
  docked?: boolean;
};

function codeGitApi(): CodeGitApi | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { codeGit?: CodeGitApi };
  return host.codeGit;
}

function ToggleIcon() {
  return <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M27 9V21H39M21 39V27H9M27 21L42 6M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CodeGitPanel({ sessionId, projectName, todoState, planPhase, onOpenPlan, docked = false, expanded = false }: CodeGitPanelProps) {
  const floating = useFloatingCard({ width: 260, defaultCollapsed: docked && !expanded });
  const api = codeGitApi();
  const refreshControllerRef = useRef<CodeGitRefreshController | null>(null);
  const [status, setStatus] = useState<CodeGitStatus | null>(() => null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [operating, setOperating] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [dialog, setDialog] = useState<"branch" | "commit" | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  // 记录正在执行的动作，只有对应按钮显示加载态，其它按钮保持禁用
  const { t } = useTranslation();

  useEffect(() => {
    if (!api) return;
    const controller = createCodeGitRefreshController({
      load: () => api.getStatus(sessionId),
      failed: () => setStatus(null),
      busy: setRefreshing,
      apply: setStatus,
    });
    refreshControllerRef.current = controller;
    void api.watch(sessionId).catch(() => undefined);
    controller.request();
    return (): void => {
      controller.dispose();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      void api.unwatch(sessionId).catch(() => undefined);
    };
  }, [api, sessionId]);

  useEffect(() => api?.onChanged((payload) => {
    if (payload.sessionId === sessionId) refreshControllerRef.current?.request();
  }), [api, sessionId]);

  const todos = todoState?.todos ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const branchName = status?.branch?.current ?? (status?.branch?.detached ? "detached HEAD" : t("codeGit.noBranch"));
  const statusCopy = status ? buildGitStatusCopy(status) : t("codeGit.readingStatus");
  const runOperation = async (action: () => Promise<void>, onSuccess?: () => void, key: string | null = null) => {
    const begin = () => { setOperating(true); setPendingKey(key); setOperationError(null); };
    const end = () => { setOperating(false); setPendingKey(null); };
    begin();
    try {
      await action();
      const controller = refreshControllerRef.current;
      controller?.request();
      if (onSuccess) onSuccess();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : t("codeGit.operationFailed"));
    } finally {
      end();
    }
  };

  return (
    <aside
      className={`ff-code-git ${docked ? "ff-code-git--docked" : ""} ${floating.collapsed ? "ff-code-git--collapsed" : ""}`}
      style={docked ? undefined : { left: floating.position.x, top: floating.position.y }}
      aria-label={t("codeGit.panelAria")}
    >
      <button type="button" className="ff-code-git__dragbar" onMouseDown={docked ? undefined : floating.onHeaderMouseDown} onClick={floating.onHeaderClick} aria-expanded={!floating.collapsed} title={t(docked ? "codeGit.panelAria" : "codeGit.drag")}>
        {docked ? <span className="ff-code-git__dock-label">{t("codeGit.panelAria")}</span> : <span className="ff-code-git__dragline" />}
        <span className="ff-code-git__toggle" data-floating-toggle onClick={(event) => { event.stopPropagation(); floating.toggle(); }}><ToggleIcon /></span>
      </button>

      <div className="ff-code-git__body" inert={floating.collapsed} aria-hidden={floating.collapsed}>
        <div className="ff-code-git__mode"><i aria-hidden="true" />Coding</div>
        <div className="ff-code-git__hero">
          <div className="ff-code-git__project">
            <strong>{projectName ?? t("codeGit.noWorkspace")}</strong>
            <span title={statusCopy}>{statusCopy}</span>
          </div>
          <IconButton className="ff-code-git__refresh" size="sm" label={t("codeGit.refresh")} onClick={() => refreshControllerRef.current?.request()} disabled={!api} loading={refreshing}>↻</IconButton>
        </div>

        <div className="ff-code-git__git-actions">
          <button type="button" disabled={status?.state !== "ready"} onClick={() => setDialog("branch")}>
            <span>{t("codeGit.branchSwitch")}</span><code>{branchName}</code><b>›</b>
          </button>
          <div className="ff-code-git__change-row">
            <span>{t("codeGit.changes")}</span>
            <span className="ff-code-git__added">+{status?.lines.insertions ?? 0}</span>
            <span className="ff-code-git__deleted">-{status?.lines.deletions ?? 0}</span>
          </div>
          <button type="button" disabled={status?.state !== "ready" || (status.files.length === 0 && status.ahead === 0)} onClick={() => setDialog("commit")}>
            <span>{t("codeGit.commitOrPush")}</span>
            <code>{status?.files.length ? t("codeGit.commitChanges") : status?.ahead ? t("codeGit.pushCommits", { count: status.ahead }) : t("codeGit.noAction")}</code>
            <b>›</b>
          </button>
          {operationError && <p className="ff-code-git__operation-error">{operationError}</p>}
        </div>

        {/* Docked in the Code pane, the plan already shows in the run timeline, so the pane keeps to the project and Git. */}
        {!docked && <>
          <div className="ff-code-git__divider" />
          <div className="ff-code-git__todo-heading"><span>{t("codeGit.currentTasks")}</span><small>{t("codeGit.todoProgress", { completed, total: todos.length })}</small></div>
          <ul className="ff-code-git__todos" data-testid="code-todo-list">
            {todos.length > 0
              ? todos.map((todo) => (
                <li key={todo.id} className={todo.status === "completed" ? "is-completed" : ""}>
                  <i /> <span>{todo.content}</span>
                </li>
              ))
              : <li className="is-empty"><i />{t("codeGit.noTasks")}</li>}
          </ul>
        </>}
        {planPhase && onOpenPlan && (
          <div className="ff-code-git__plan-status" data-testid="code-plan-status">
            <PlanReviewEntry phase={planPhase} onOpen={onOpenPlan} />
          </div>
        )}
      </div>

      <Modal open={dialog === "branch"} title={t("codeGit.switchBranch")} footer={null} onCancel={() => setDialog(null)} className="ff-code-git-modal">
        <p className="ff-code-git-modal__hint">{t("codeGit.currentBranch")}<code>{branchName}</code></p>
        <div className="ff-code-git-modal__branch-list">
          {status?.branch?.branches.map((branch) => {
            const key = `switch:${branch}`;
            return <Button key={branch} block disabled={branch === status.branch?.current || (operating && pendingKey !== key)} loading={pendingKey === key} onClick={() => api && void runOperation(() => api.switchBranch(sessionId, branch), () => setDialog(null), key)}>{branch === status.branch?.current ? "✓ " : ""}{branch}</Button>;
          })}
        </div>
        <div className="ff-code-git-modal__new-branch">
          <Input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder={t("codeGit.newBranchPlaceholder")} disabled={operating} onPressEnter={() => api && newBranch.trim() && !operating && void runOperation(() => api.switchBranch(sessionId, newBranch.trim(), true), () => { setNewBranch(""); setDialog(null); }, "create")} />
          <Button variant="primary" disabled={!api || !newBranch.trim() || (operating && pendingKey !== "create")} loading={pendingKey === "create"} onClick={() => api && void runOperation(() => api.switchBranch(sessionId, newBranch.trim(), true), () => { setNewBranch(""); setDialog(null); }, "create")}>{t("codeGit.createAndSwitch")}</Button>
        </div>
      </Modal>

      <Modal open={dialog === "commit"} title={t("codeGit.commitOrPush")} footer={null} onCancel={() => setDialog(null)} className="ff-code-git-modal">
        {status?.files.length ? <section className="ff-code-git-modal__commit-section">
          <p className="ff-code-git-modal__hint">{t("codeGit.commitHint", { count: status.files.length })}</p>
          <Input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t("codeGit.commitMessagePlaceholder")} disabled={operating} />
          <Button variant="primary" block disabled={!api || !commitMessage.trim() || (operating && pendingKey !== "commit")} loading={pendingKey === "commit"} onClick={() => api && void runOperation(() => api.commit(sessionId, commitMessage, status.files.map((file) => file.path)), () => { setCommitMessage(""); setDialog(null); }, "commit")}>{t("codeGit.commitAll")}</Button>
        </section> : null}
        {status?.ahead ? <section className="ff-code-git-modal__commit-section">
          <p className="ff-code-git-modal__hint">{t("codeGit.pushHint", { count: status.ahead })}</p>
          <Button variant="primary" block disabled={!api || (operating && pendingKey !== "push")} loading={pendingKey === "push"} onClick={() => api && void runOperation(() => api.push(sessionId), () => setDialog(null), "push")}>{t("codeGit.pushCommits", { count: status.ahead })}</Button>
        </section> : null}
        {operationError && <p className="ff-code-git__operation-error">{operationError}</p>}
      </Modal>
    </aside>
  );
}
