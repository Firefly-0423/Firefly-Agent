import type { ToolFileChange } from "../../../../../shared/chat-types";
import type { ReviewFileChange } from "../../../../../shared/review-types";
import type { FileVersionEvidence, TaskWriteEvidence } from "../../../../../shared/agent-execution-evidence";
import { normalizeToolTaskResult } from "../../../../../shared/task-result-evidence";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Diff, ExternalLink, FileDiff, FileMinus2, FilePen, FilePlus2, type LucideIcon } from "lucide-react";
import { OUTPUT_FILE_ICONS } from "./output-file-icons";
import { useTranslation } from "../../../i18n";
import { getCharacterPortraitByAssetFileName } from "../../../character-portraits";
import { MarkdownContent } from "../components/ChatMessageList";
import { ChatInspectorActionsContext } from "../components/inspector-actions";
import { TaskDelegationRow } from "../components/TaskDelegationRow";
import { workspaceRelativePath, type WorkspaceChangedFile, type WorkspaceRunOutput } from "./workspace-artifacts";
import { CodeDiff } from "./CodeDiff";
import { findReviewFile, useReviewSnapshot } from "./review-snapshot";
import "./WorkspaceRunResults.css";

type ToolRecord = WorkspaceRunOutput["tools"][number];
type ToolGroup = { kind: "plain"; key: string; /** Raw tool name: the identity a group is keyed by. */ toolName: string; /** Visible label only. */ name: string; items: ToolRecord[] } | { kind: "delegate"; tool: ToolRecord };

/** Delegations keep their full cards; consecutive calls of the same ordinary tool fold into one group so a long run reads as a short list. */
export function groupTools(tools: readonly ToolRecord[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const tool of tools) {
    if (tool.name === "delegate_agent") { groups.push({ kind: "delegate", tool }); continue; }
    const last = groups[groups.length - 1];
    // Two tools may share a display name (plugins do not have to make them unique); only the same tool folds together.
    if (last?.kind === "plain" && last.toolName === tool.name) last.items.push(tool);
    else groups.push({ kind: "plain", key: tool.id, toolName: tool.name, name: tool.displayName ?? tool.name, items: [tool] });
  }
  return groups;
}

const oneLine = (text: string, limit = 90) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/**
 * One line per step, like a file list: a chevron, the label and its status on a single bar; the details open under it.
 * Opening animates the way open-claude-ui's thinking block does: the body's grid row grows from 0fr to 1fr and the chevron turns.
 */
function FoldRow({ head, children, className, openRequest, actions, ...data }: {
  head: ReactNode; children: ReactNode; className?: string;
  /** Changes whenever something outside asks this row to open (the chat pointing at a task). */
  openRequest?: number;
  /** Small buttons at the right end of the bar, beside (not inside) the toggle; they show on hover or focus. */
  actions?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  const toggle = <button type="button" className="ff-run-row__head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
    <ChevronRight className="ff-run-row__chevron" size={14} aria-hidden="true" />
    {head}
  </button>;
  return <div className={`ff-run-row${className ? ` ${className}` : ""}`} data-open={open ? "" : undefined} {...data}>
    {actions ? <div className="ff-run-row__bar">{toggle}<span className="ff-run-row__actions">{actions}</span></div> : toggle}
    <div id={bodyId} className="ff-run-row__body" inert={!open}>
      <div className="ff-run-row__inner">{children}</div>
    </div>
  </div>;
}

function ToolFold({ name, items }: { name: string; items: ToolRecord[] }) {
  const { t } = useTranslation();
  const failed = items.filter(item => item.status === "error").length;
  const status = (tool: ToolRecord) => <span className="ff-run-row__status" data-tool-status={tool.status}>{t(`workspace.toolStatus.${tool.status}`)}</span>;
  const preview = (tool: ToolRecord) => <span className="ff-run-row__preview">{oneLine(tool.result || "") || t("workspace.emptyResult")}</span>;
  const result = (tool: ToolRecord) => <pre>{tool.result || t("workspace.emptyResult")}</pre>;
  if (items.length === 1) {
    const [tool] = items as [ToolRecord];
    return <FoldRow className="ff-run-row--tool" head={<><strong>{name}</strong>{preview(tool)}{status(tool)}</>}>{result(tool)}</FoldRow>;
  }
  return <FoldRow className="ff-run-row--group" head={<>
    <strong>{name}</strong>
    <span className="ff-run-row__count">{t("workspace.toolGroupCount", { count: items.length })}</span>
    {failed > 0 && <span className="ff-run-row__failed" data-tool-status="error">{t("workspace.toolGroupFailed", { count: failed })}</span>}
  </>}>
    <div className="ff-run-list ff-run-list--nested">
      {items.map(tool => <FoldRow key={tool.id} className="ff-run-row--item" head={<>{preview(tool)}{status(tool)}</>}>{result(tool)}</FoldRow>)}
    </div>
  </FoldRow>;
}

/** Splits a path into its file name and the folder it sits in, accepting either slash. */
function splitPath(path: string): { name: string; dir: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/**
 * A changed file as one row of a diff list: kind icon, file name, its folder (relative to the project when inside it),
 * +added −removed; the row opens the diff in place, and "open file" / "view diff in a tab" sit at the right end.
 */
function ChangedFileRow({ file, reviewFile, workspaceRoot, onOpenFile, onOpenDiff, icon, iconKind }: {
  file: WorkspaceChangedFile;
  /** Overrides the change-kind icon (the outputs panel shows what sort of file it is instead). */
  icon?: LucideIcon; iconKind?: string;
  /** The run's full record of this file, when its review snapshot is in. */
  reviewFile?: ReviewFileChange;
  workspaceRoot?: string; onOpenFile(path: string): void; onOpenDiff(): void;
}) {
  const { t } = useTranslation();
  const { change } = file;
  const relative = workspaceRoot ? workspaceRelativePath(change.file, workspaceRoot) : undefined;
  const { name, dir } = splitPath(relative ?? change.file);
  const Icon = icon ?? (change.kind === "added" ? FilePlus2 : change.kind === "deleted" ? FileMinus2 : FilePen);
  return <FoldRow className="ff-run-row--file" data-change-kind={change.kind} data-file-type={iconKind} head={<>
    <Icon className="ff-run-file__icon" size={14} aria-hidden="true" />
    <strong title={change.file}>{name}</strong>
    {dir && <span className="ff-run-row__preview" title={change.file}>{dir}</span>}
    <span className="ff-run-file__stats"><span className="is-add">+{reviewFile?.additions ?? change.insertions}</span><span className="is-remove">−{reviewFile?.deletions ?? change.deletions}</span></span>
  </>} actions={<>
    {relative && change.kind !== "deleted" && <button type="button" className="ff-run-row__action" data-output-file={relative}
      aria-label={`${t("workspace.openFile")} ${name}`} title={t("workspace.openFile")} onClick={() => onOpenFile(relative)}>
      <ExternalLink size={13} aria-hidden="true" />
    </button>}
    <button type="button" className="ff-run-row__action" data-output-diff={change.file}
      aria-label={`${t("workspace.openDiff")} ${name}`} title={t("workspace.openDiff")} onClick={onOpenDiff}>
      <Diff size={13} aria-hidden="true" />
    </button>
  </>}>
    <WorkspaceChangeDiff change={change} reviewFile={reviewFile ?? null} bare />
  </FoldRow>;
}

export function WorkspaceResultsIndex({ outputs, onOpenResult }: { outputs: WorkspaceRunOutput[]; onOpenResult(id: string): void }) {
  const { t } = useTranslation();
  return <section className="ff-workspace-results-index" aria-label={t("workspace.results")}>
    <h3>{t("workspace.results")}</h3>
    {!outputs.length && <p>{t("workspace.noResults")}</p>}
    {outputs.map((output, index) => <button type="button" key={output.id} data-output-result={output.id} onClick={() => onOpenResult(output.id)}>
      <span>{t("workspace.runResult", { index: index + 1 })}</span>
      <small>{t("workspace.resultCounts", { files: output.files.length, tools: output.tools.length })}</small>
    </button>)}
  </section>;
}

/** The run's changed files, shown in a panel of their own: one diff-list row per file. */
export function WorkspaceChangedFiles({ output, workspaceRoot, onOpenFile, onOpenDiff }: {
  output: WorkspaceRunOutput; workspaceRoot?: string;
  onOpenFile(path: string): void; onOpenDiff(output: WorkspaceRunOutput, file: WorkspaceChangedFile): void;
}) {
  const { t } = useTranslation();
  const snapshot = useReviewSnapshot(output.runId);
  return <section className="ff-workspace-run-results ff-run-files" aria-label={t("workspace.changedFiles")} data-source-run={output.runId}>
    <h3 className="ff-run-files__title">{t("workspace.changedFiles")}<span>{output.files.length}</span></h3>
    {output.files.length === 0 ? <p className="ff-run-files__empty">{t("workspace.noChangedFiles")}</p>
      : <div className="ff-run-list">{output.files.map(file => <ChangedFileRow key={`${file.toolId}:${file.change.file}`}
        file={file} reviewFile={findReviewFile(snapshot, file.change.file, workspaceRoot)} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} onOpenDiff={() => onOpenDiff(output, file)} />)}</div>}
  </section>;
}

export interface WorkspaceOutputFile { file: string; type: keyof typeof OUTPUT_FILE_ICONS; output: WorkspaceRunOutput; changed: WorkspaceChangedFile }

/** A produced file's row: it reads the review snapshot of the run that last wrote it, so the diff it opens is complete. */
function OutputFileRow({ item, workspaceRoot, onOpenFile, onOpenDiff }: {
  item: WorkspaceOutputFile; workspaceRoot?: string; onOpenFile(path: string): void; onOpenDiff(output: WorkspaceRunOutput, file: WorkspaceChangedFile): void;
}) {
  const snapshot = useReviewSnapshot(item.output.runId);
  return <ChangedFileRow file={item.changed} reviewFile={findReviewFile(snapshot, item.changed.change.file, workspaceRoot)} workspaceRoot={workspaceRoot}
    icon={OUTPUT_FILE_ICONS[item.type]} iconKind={item.type} onOpenFile={onOpenFile} onOpenDiff={() => onOpenDiff(item.output, item.changed)} />;
}

/** Everything the session produced, one diff-list row per file, newest first; a row unfolds its diff in place. */
export function WorkspaceOutputFiles({ files, workspaceRoot, onOpenFile, onOpenDiff }: {
  files: readonly WorkspaceOutputFile[]; workspaceRoot?: string;
  onOpenFile(path: string): void; onOpenDiff(output: WorkspaceRunOutput, file: WorkspaceChangedFile): void;
}) {
  const { t } = useTranslation();
  return <section className="ff-workspace-run-results ff-run-files ff-run-outputs" aria-label={t("sessionOverview.outputs")}>
    <h3 className="ff-run-files__title">{t("sessionOverview.outputs")}<span>{files.length}</span></h3>
    {files.length === 0 ? <p className="ff-run-files__empty">{t("sessionOverview.outputsEmpty")}</p>
      : <div className="ff-run-list">{files.map(item => <OutputFileRow key={item.file} item={item} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />)}</div>}
  </section>;
}

export function WorkspaceRunResults({ output, workspaceRoot, focusTask, onOpenFile, onOpenDiff, onOpenChanges }: {
  output: WorkspaceRunOutput; workspaceRoot?: string;
  /** Task whose result the chat asked to see; `seq` lets a repeated request scroll again. */
  focusTask?: { taskId: string; seq: number };
  onOpenFile(path: string): void; onOpenDiff(output: WorkspaceRunOutput, file: WorkspaceChangedFile): void;
  /** Opens the changed files in their own panel; without it the list stays inline. */
  onOpenChanges?(output: WorkspaceRunOutput): void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusTask) return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find(node => node.dataset.taskId === focusTask.taskId);
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focusTask?.taskId, focusTask?.seq]);
  const groups = groupTools(output.tools);
  return <section ref={root} className="ff-workspace-run-results" aria-label={t("workspace.results")} data-source-session={output.sessionId} data-source-run={output.runId}>
    {/* Inside the panel the rows stay informational: they unfold in place instead of reopening this panel. */}
    <ChatInspectorActionsContext.Provider value={{}}>
      {output.tasks.map(task => <TaskDelegationRow key={task.invocationId} delegation={task} />)}
    </ChatInspectorActionsContext.Provider>
    {groups.length > 0 && <div className="ff-run-list">{groups.map(group => {
      if (group.kind === "plain") return <ToolFold key={group.key} name={group.name} items={group.items} />;
      const tool = group.tool;
      const taskResult = tool.name === "delegate_agent" ? normalizeToolTaskResult(tool.taskResult, output.runId) : undefined;
      const task = taskResult && output.tasks.find(item => item.taskId === taskResult.sessionId);
      const portrait = task ? getCharacterPortraitByAssetFileName(task.assetFileName) : undefined;
      return <FoldRow key={tool.id} className="ff-run-row--task ff-workspace-run-results__tool" data-task-id={taskResult?.sessionId}
        openRequest={focusTask && focusTask.taskId === taskResult?.sessionId ? focusTask.seq : undefined}
        head={<>
          {portrait && <img className="ff-workspace-run-results__avatar" src={portrait} alt="" />}
          <strong>{task?.nickname ?? taskResult?.agentId ?? tool.displayName ?? tool.name}</strong>
          {task && <span className="ff-run-row__preview">{task.description}</span>}
          <span className="ff-run-row__status" data-tool-status={tool.status}>{t(`workspace.toolStatus.${tool.status}`)}</span>
        </>}>
        {taskResult ? <>
          {task && <p className="ff-workspace-run-results__task">{task.description}</p>}
          <p>{t("workspace.childResult")} · {t(`workspace.childStatus.${taskResult.status}`)}</p>
          {taskResult.error && <p role="status" data-child-error={taskResult.error.code}>{taskResult.error.code}: {taskResult.error.message}</p>}
          {taskResult.text
            ? <div className="ff-workspace-run-results__text"><MarkdownContent content={taskResult.text} /></div>
            : <pre>{t("workspace.emptyResult")}</pre>}
          {taskResult.truncated && <p role="status">{t("workspace.resultTruncated")}</p>}
          <div className="ff-workspace-run-results__files" aria-label={t("workspace.writeEvidence")}>
            <h3>{t("workspace.writeEvidence")}</h3>
            {taskResult.writes === undefined ? <p>{t("workspace.writeEvidenceUnavailable")}</p>
              : taskResult.writes.length === 0 ? <p>{t("workspace.noRecordedWrites")}</p>
              : taskResult.writes.map((write, index) => <WorkspaceWriteEvidence key={`${write.toolCallId}:${write.canonicalPath}:${index}`} write={write} />)}
          </div>
          {taskResult.executionEvents && taskResult.executionEvents.length > 0 && <details>
            <summary>{t("workspace.executionEvidence")}</summary>
            {taskResult.executionEvents.map(event => <p key={event.id} data-execution-phase={event.phase}>
              {event.id} · {event.agentId} · {event.childRunId} · {event.executionId} · {t(`workspace.executionPhase.${event.phase}`)}
              {event.terminal && <> · {t(`workspace.childStatus.${event.terminal}`)}</>}
              {" · "}{t("workspace.executionClock")}: {event.clockDomainId} · #{event.seq} · {event.monotonicMs} ms
            </p>)}
          </details>}
        </> : <>
          <p>{t("workspace.toolSummary")}</p>
          <pre>{tool.result || t("workspace.emptyResult")}</pre>
          {tool.name === "delegate_agent" && <p>{t("workspace.writeEvidenceUnavailable")}</p>}
        </>}
      </FoldRow>;
    })}</div>}
    {/* The run's steps first, then what they changed, as the summary that closes the run. */}
    {output.files.length > 0 && (onOpenChanges
      ? <button type="button" className="ff-run-files-entry" data-open-changes={output.id} onClick={() => onOpenChanges(output)}>
          <FileDiff size={15} aria-hidden="true" />
          <strong>{t("workspace.changedFiles")}</strong>
          <span className="ff-run-files-entry__count">{output.files.length}</span>
          <span className="ff-run-file__stats">
            <span className="is-add">+{output.files.reduce((sum, file) => sum + file.change.insertions, 0)}</span>
            <span className="is-remove">−{output.files.reduce((sum, file) => sum + file.change.deletions, 0)}</span>
          </span>
          <ChevronRight className="ff-run-files-entry__chevron" size={14} aria-hidden="true" />
        </button>
      : <WorkspaceChangedFiles output={output} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />)}
  </section>;
}

function WorkspaceWriteEvidence({ write }: { write: TaskWriteEvidence }) {
  const { t } = useTranslation();
  const version = (evidence: FileVersionEvidence | undefined) => evidence?.sha256 || evidence?.version
    ? <>{evidence.sha256 && <span>SHA-256: {evidence.sha256}</span>}{evidence.sha256 && evidence.version && " · "}{evidence.version && <span>{t("workspace.fileVersion")}: {evidence.version}</span>}</>
    : t("workspace.versionUnavailable");
  return <div className="ff-workspace-run-results__file" data-write-state={write.state}>
    <span title={write.canonicalPath}>{write.path}</span>
    <strong>{t(`workspace.writeState.${write.state}`)}</strong>
    <small>{write.agentId} · {write.childRunId} · {t("workspace.writeTool")}: {write.toolCallId}</small>
    <span>{t("workspace.beforeWrite")}: {version(write.before)}</span>
    <span>{t("workspace.afterWrite")}: {version(write.after)}</span>
    <span>{t("workspace.writeEvents")}: {write.eventIds.length ? write.eventIds.join(", ") : t("workspace.eventsUnavailable")}</span>
  </div>;
}

/**
 * One changed file's diff. The run's review snapshot holds every line with its line numbers, so that is what shows once
 * it is in; the tool's own evidence (capped in size when it was recorded) only stands in until then or when there is none.
 */
export function WorkspaceChangeDiff({ change, bare = false, runId, workspaceRoot, reviewFile }: {
  change: ToolFileChange;
  /** Inside a changed-file row, which already names the file and its counts. */
  bare?: boolean;
  /** The run the change belongs to; its review snapshot is read when `reviewFile` is not given. */
  runId?: string;
  workspaceRoot?: string;
  /** Already looked up by the caller; null means the caller found none. */
  reviewFile?: ReviewFileChange | null;
}) {
  const { t } = useTranslation();
  const snapshot = useReviewSnapshot(reviewFile === undefined ? runId : undefined);
  const full = reviewFile === undefined ? findReviewFile(snapshot, change.file, workspaceRoot) : reviewFile ?? undefined;
  const body = full?.hunks?.length ? <CodeDiff hunks={full.hunks} />
    : full && (full.kind === "binary" || full.kind === "large-text") ? <p>{t(full.kind === "binary" ? "review.binaryHint" : "review.largeTextHint")}</p>
    : change.diff?.length ? <>
        <CodeDiff lines={change.diff} />
        {change.truncated && <p className="ff-workspace-change-diff__note">{t("fileChange.truncated")}</p>}
      </>
    : <p>{t("workspace.diffUnavailable")}</p>;
  return <section className={`ff-workspace-change-diff${bare ? " ff-workspace-change-diff--bare" : ""}`} aria-label={t("workspace.openDiff")}>
    {!bare && <header>{change.file} <small>+{full?.additions ?? change.insertions} / −{full?.deletions ?? change.deletions}</small></header>}
    {body}
  </section>;
}
