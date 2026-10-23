// ChatPageInspector — 把 ChatPage 的标签状态组装成 RightInspector 的标签列表。
// 标签固定顺序：文件树（files）→ 文件预览（file:<路径>）→ Diff（diff:<run>:<路径>）→ 计划（plan:<会话>）。

import type { ToolFileChange } from "../../../../../shared/chat-types";
import { WorkspaceChangeDiff, WorkspaceChangedFiles, WorkspaceOutputFiles, WorkspaceRunResults, type WorkspaceOutputFile } from "../workspace/WorkspaceRunResults";
import { changesTabId, type WorkspaceChangedFile, type WorkspaceRunOutput } from "../workspace/workspace-artifacts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderTree, LayoutList, SquareTerminal } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { FileTreePanel, FilePreviewContent } from "./FileTreePanel";
import { requestWorkspaceEditorClose, workspaceEditorKey, useWorkspaceEditorState } from "./WorkspaceTextEditor";
import { PlanContent, planTabDotClass, planTabLabel, type PlanReviewPhase } from "./PlanReviewPanel";
import { ReviewDiffContent } from "./ReviewInspector";
import { RightInspector, type InspectorTab } from "./RightInspector";
import type { ManualBrowserTabHandle } from "../workspace/ManualBrowserTab";
import { BrowserWorkspaceTabs } from "../workspace/BrowserWorkspaceTabs";
import { BrowserNewTabToolsContext, type BrowserNewTabTool } from "../workspace/BrowserNewTab";
import "./ChatPageInspector.css";

/** Open and close length of the docked pane. ChatPageInspector.css animates the width for the same time. */
const MOTION_MS = 220;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

/**
 * CSS animates the panel width. This reports only whether that width is moving: while it is, the native
 * browser stays detached (its bounds are not animated) and reattaches once the pane has settled.
 * The state is adjusted during render, so the first commit after a toggle already reports the motion.
 */
function useInspectorMotion(visible: boolean): boolean {
  const [seen, setSeen] = useState(visible);
  const [motion, setMotion] = useState(() => ({ moving: visible, id: 0 }));
  if (seen !== visible) {
    setSeen(visible);
    setMotion(current => ({ moving: !prefersReducedMotion(), id: current.id + 1 }));
  }
  useEffect(() => {
    if (!motion.moving) return;
    const timer = window.setTimeout(() => setMotion(current => current.id === motion.id
      ? { ...current, moving: false } : current), MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [motion]);
  return motion.moving;
}

function FileDraftMarker({ editorKey }: { editorKey: string }) {
  const { t } = useTranslation();
  const draft = useWorkspaceEditorState(editorKey)?.draft;
  if (!draft || (!draft.saving && draft.text === draft.original)) return null;
  return <span className="ff-right-inspector__dirty" data-inspector-dirty="true" role="status"
    aria-label={t(draft.saving ? "fileTree.saving" : "fileTree.unsaved")}
    title={t(draft.saving ? "fileTree.saving" : "fileTree.unsaved")} />;
}

/** 取路径的最末一段作为标签标题；同时识别 / 与 \ 两种分隔符。 */
function fileBaseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1];
}

export type ChatPageInspectorDiffTab = {
  change?: ToolFileChange;
  filePath: string;
  fileIndex: number;
  runId: string;
  id: string;
};

export type ChatPageInspectorFileTab = {
  /** 定位序号：同一个标签重复点击不同行时，靠它触发重新滚动。 */
  lineSeq?: number;
  /** 从消息链接跳转过来时携带的定位行，从 1 开始计数。 */
  line?: number;
  relPath: string;
  id: string;
};

export interface ChatPageInspectorProps {
  sessionId?: string;
  visible?: boolean;
  refreshRevision?: number | string;
  resultTabs?: WorkspaceRunOutput[];
  /** Which run of the session a result is (1-based), so its tab reads "第 3 次运行结果" even when it is the only one open. */
  runNumberOf?: (output: WorkspaceRunOutput) => number;
  /** Runs whose changed files are open in a panel of their own (tab id `changes:<run output id>`). */
  changesTabs?: WorkspaceRunOutput[];
  onOpenChanges?: (output: WorkspaceRunOutput) => void;
  /** Delegated task whose result the chat asked to reveal inside its run result tab. */
  focusTask?: { taskId: string; seq: number };
  onOpenResultDiff?: (output: WorkspaceRunOutput, file: WorkspaceChangedFile) => void;
  /** 工作区根路径（未绑定时为空，文件树显示引导态） */
  workspaceRoot?: string;
  filesTabOpen: boolean;
  /** The session's produced files, listed in their own tab (opened from the overview's 产出 card). */
  outputFiles?: readonly WorkspaceOutputFile[];
  browserTabOpen?: boolean;
  tasksTabOpen?: boolean;
  taskPanel?: ReactNode;
  /** Entry points offered on the browser new-tab page; omit one to hide it. */
  onOpenFilesTab?: () => void;
  onOpenTasksTab?: () => void;
  onOpenOverviewTab?: () => void;
  pendingWorkspaceName?: string;
  onChooseWorkspace?: () => void;
  /** 文件树里点击文件时，会打开或激活对应的预览标签。 */
  onOpenFile: (relPath: string) => void;
  /** 由页面递增来关闭浏览器：走它自己的清理流程（权限撤销、原生页面关闭都会走这里）。 */
  browserCloseRequest?: number;
  onCloseTab: (id: string) => void;
  onTabChange: (id: string) => void;
  activeTabId: string | null;
  /** 计划标签 ID（plan:<会话>），由 ChatPage 统一算出。 */
  planTabId: string;
  planDrawerOpen: boolean;
  activePlan: { content: string; phase: PlanReviewPhase } | null;
  diffTabs: ChatPageInspectorDiffTab[];
  fileTabs: ChatPageInspectorFileTab[];
}

export function ChatPageInspector({
  sessionId,
  visible = true,
  refreshRevision,
  resultTabs = [],
  runNumberOf,
  changesTabs = [],
  onOpenChanges,
  focusTask,
  onOpenResultDiff,
  workspaceRoot,
  filesTabOpen,
  outputFiles,
  browserTabOpen = false,
  tasksTabOpen = false,
  taskPanel,
  onOpenFilesTab,
  onOpenTasksTab,
  onOpenOverviewTab,
  pendingWorkspaceName,
  onChooseWorkspace,
  browserCloseRequest = 0,
  onOpenFile,
  onCloseTab,
  onTabChange,
  activeTabId,
  planTabId,
  planDrawerOpen,
  activePlan,
  diffTabs,
  fileTabs,
}: ChatPageInspectorProps) {
  const { t } = useTranslation();
  const browserRef = useRef<ManualBrowserTabHandle>(null);
  useEffect(() => {
    if (browserCloseRequest === 0) return;
    if (browserRef.current) browserRef.current.close();
    else onCloseTab("browser");
  }, [browserCloseRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const moving = useInspectorMotion(visible);
  const newTabTools = useMemo<BrowserNewTabTool[]>(() => [
    ...(onOpenOverviewTab ? [{ id: "overview", label: t("sessionOverview.tab"), icon: <LayoutList size={16} strokeWidth={1.8} />, onSelect: onOpenOverviewTab }] : []),
    ...(onOpenFilesTab ? [{ id: "files", label: t("fileTree.title"), icon: <FolderTree size={16} strokeWidth={1.8} />, onSelect: onOpenFilesTab }] : []),
    ...(onOpenTasksTab ? [{ id: "tasks", label: t("workspace.tasks"), icon: <SquareTerminal size={16} strokeWidth={1.8} />, onSelect: onOpenTasksTab }] : []),
  ], [onOpenFilesTab, onOpenOverviewTab, onOpenTasksTab, t]);
  const tabs: InspectorTab[] = [];

  if (tasksTabOpen) {
    tabs.push({ id: "tasks", kind: "tasks", label: t("workspace.tasks"), content: taskPanel });
  }
  if (filesTabOpen) {
    tabs.push({
      id: "files",
      kind: "files",
      label: t("fileTree.title"),
      content: (
        sessionId && workspaceRoot ? <FileTreePanel
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          refreshRevision={refreshRevision}
          onOpenFile={onOpenFile}
        /> : <div className="ff-workspace-empty">
          <p>{pendingWorkspaceName
            ? t("workspace.pendingFiles", { name: pendingWorkspaceName })
            : t("fileTree.errNoWorkspace")}</p>
          {onChooseWorkspace && <button type="button" data-workspace-choose="true"
            onClick={onChooseWorkspace}>{t("workspace.chooseFolder")}</button>}
        </div>
      ),
    });
  }
  if (outputFiles) {
    tabs.push({ id: "outputs", kind: "outputs", label: t("sessionOverview.outputs"),
      content: <WorkspaceOutputFiles files={outputFiles} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile}
        onOpenDiff={(result, file) => onOpenResultDiff?.(result, file)} /> });
  }
  for (const tab of fileTabs) {
    const preview = sessionId
      ? <FilePreviewContent sessionId={sessionId} workspaceRoot={workspaceRoot} relPath={tab.relPath} refreshRevision={refreshRevision} scrollToLine={tab.line} lineSeq={tab.lineSeq} />
      : null;
    tabs.push({
      kind: "file",
      title: tab.relPath,
      label: fileBaseName(tab.relPath),
      status: sessionId ? <FileDraftMarker editorKey={workspaceEditorKey(sessionId, workspaceRoot, tab.relPath)} /> : undefined,
      content: preview,
      id: tab.id,
    });
  }
  for (const tab of diffTabs) {
    tabs.push({
      id: tab.id,
      label: tab.filePath ? fileBaseName(tab.filePath) : "Diff",
      title: `Diff · ${tab.filePath}`,
      kind: "diff",
      content: tab.change ? <WorkspaceChangeDiff change={tab.change} runId={tab.runId} workspaceRoot={workspaceRoot} /> : <ReviewDiffContent runId={tab.runId} fileIndex={tab.fileIndex} />,
    });
  }
  for (const [index, output] of resultTabs.entries()) {
    if (output.sessionId !== sessionId) continue;
    // A run with a single delegated task is named after that task, like a file tab.
    const label = output.tasks.length === 1 && output.tasks[0].description.trim()
      ? output.tasks[0].description.trim().slice(0, 24) : t("workspace.runResult", { index: runNumberOf?.(output) ?? index + 1 });
    tabs.push({ id: output.id, kind: "result", label, title: output.tasks.length === 1 ? output.tasks[0].description : undefined,
      content: <WorkspaceRunResults output={output} workspaceRoot={workspaceRoot} focusTask={focusTask} onOpenFile={onOpenFile}
        onOpenDiff={(result, file) => onOpenResultDiff?.(result, file)} onOpenChanges={onOpenChanges} /> });
  }
  for (const output of changesTabs) {
    if (output.sessionId !== sessionId) continue;
    tabs.push({ id: changesTabId(output.id), kind: "changes", label: `${t("workspace.changedFiles")} ${output.files.length}`,
      content: <WorkspaceChangedFiles output={output} workspaceRoot={workspaceRoot} onOpenFile={onOpenFile}
        onOpenDiff={(result, file) => onOpenResultDiff?.(result, file)} /> });
  }
  if (activePlan && planDrawerOpen) {
    tabs.push({
      id: planTabId,
      kind: "plan",
      label: planTabLabel(activePlan.phase),
      dotClass: planTabDotClass(activePlan.phase),
      content: <PlanContent content={activePlan.content} phase={activePlan.phase} />,
    });
  }
  if (browserTabOpen) {
    // The browser is appended last, so it is the only inspector tab exactly when nothing else was added.
    const soleTab = tabs.length === 0;
    tabs.push({
      id: "browser",
      kind: "browser",
      label: t("browserWorkspace.title"),
      content: <BrowserNewTabToolsContext.Provider value={newTabTools}>
        <BrowserWorkspaceTabs ref={browserRef} sessionId={sessionId} paneClose={soleTab}
          // Tiled panels are all on screen at once: the page stays attached while the panel is shown, whichever panel has focus.
          // A panel hidden by another one's enlarge has no size, and the browser detaches its page for that on its own.
          active={visible && !moving}
          onClose={() => onCloseTab("browser")} />
      </BrowserNewTabToolsContext.Provider>,
    });
  }
  if (tabs.length === 0) return null;

  const browserOnly = tabs.length === 1 && tabs[0].id === "browser";
  return (
    <div className={`ff-chat-inspector${browserOnly ? " is-browser-only" : ""}${visible ? "" : " is-closed"}`}
      data-dock-motion={moving || undefined} inert={!visible || undefined}>
      <RightInspector
        tabs={tabs}
        visible={visible}
        activeTabId={activeTabId}
        onTabChange={onTabChange}
        onCloseTab={id => {
          if (id === "browser" && browserRef.current) { onTabChange(id); browserRef.current.close(); return; }
          const file = fileTabs.find(tab => tab.id === id);
          if (file && sessionId && !requestWorkspaceEditorClose(workspaceEditorKey(sessionId, workspaceRoot, file.relPath), () => onCloseTab(id))) {
            onTabChange(id);
            return;
          }
          onCloseTab(id);
        }}
      />
    </div>
  );
}
