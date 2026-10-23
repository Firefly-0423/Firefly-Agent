// 右侧面板里的会话工作区文件树，以及文件预览。
//
// 文件树用 antd 的 Tree.DirectoryTree：首次只拉根目录，展开某个目录时才拉该层；点击目录名即可展开。
// 点击文件时，由 ChatPage 打开 file:<relPath> 标签；内容经 workspaceFiles.read 读取，
// 主进程负责 realpath 防越界、1MB 上限以及拒绝二进制文件。
// 语法高亮用 shiki 单例 + github-light 主题，按扩展名选语言。先显示纯文本，再渐进上色；
// 高亮失败或语言不支持时保持纯文本，不影响阅读。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Tree } from "antd";
import type { DataNode, EventDataNode } from "antd/es/tree";
import { FileText, RefreshCw } from "lucide-react";
import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";
import { useTranslation } from "../../../i18n";
import { uiColorContrast, uiColorTokens } from "../../../../../shared/ui-colors";
import type { WorkspaceFileEntry, WorkspaceFileErrorCode, WorkspaceReadResult } from "../../../../../shared/workspace-files-types";
import { MarkdownContent } from "./ChatMessageList";
import { releaseFocusedDescendant } from "./focus-handoff";
import { vscodeIconForFile } from "./vscodeFileIcon";
import { WorkspaceTextEditor, workspaceEditorKey, useWorkspaceEditorState, getWorkspaceEditorState, consumeWorkspaceEditorSave } from "./WorkspaceTextEditor";
import './FileTreePanel.css';

/** 预览区最多渲染的行数：超过太多一次性铺进 DOM 会卡顿。 */
const PREVIEW_MAX_LINES = 2000;

/** shiki 主题：浅色的 GitHub 主题，与应用的浅色界面配色相符。 */
const HIGHLIGHT_THEME = "github-light";

/** 按语言分组列出支持的扩展名，展开后即为扩展名到语法的映射（与 HIGHLIGHT_LANGS 保持一致）。 */
const LANGUAGE_GROUPS: ReadonlyArray<readonly [BundledLanguage, string]> = [
  ["typescript", "ts mts"], ["tsx", "tsx"], ["javascript", "js mjs cjs"], ["jsx", "jsx"],
  ["json", "json"], ["jsonc", "jsonc"], ["css", "css"], ["scss", "scss"], ["html", "html htm"],
  ["markdown", "md markdown"], ["python", "py"], ["bash", "sh bash zsh"], ["yaml", "yml yaml"],
  ["xml", "xml svg"], ["toml", "toml"], ["sql", "sql"], ["go", "go"], ["rust", "rs"], ["java", "java"],
  ["c", "c h"], ["cpp", "cpp hpp cc cxx"],
];
const EXT_LANG: Record<string, BundledLanguage> = Object.fromEntries(
  LANGUAGE_GROUPS.flatMap(([language, exts]) => exts.split(" ").map((ext) => [ext, language] as const)),
);

/** 从相对路径取语言；无法识别的扩展名返回 undefined，此时按纯文本显示。 */
function langForPath(relPath: string): BundledLanguage | undefined {
  const base = relPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? EXT_LANG[base.slice(dot + 1).toLowerCase()] : undefined;
}

/** 是否为 Markdown 文件，决定能否在预览与源码之间切换。 */
function isMarkdownPath(relPath: string): boolean {
  return /\.(md|markdown)$/i.test(relPath);
}

/** 图标的描边参数，两个图标共用。 */
const ICON_STROKE = { stroke: "currentColor", strokeWidth: "4", strokeLinejoin: "round" } as const;
const ARROW_STROKE = { stroke: "currentColor", strokeWidth: "4", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** 眼睛图标：渲染预览。 */
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M24 36C35.0457 36 44 24 44 24C44 24 35.0457 12 24 12C12.9543 12 4 24 4 24C4 24 12.9543 36 24 36Z" {...ICON_STROKE} />
      <path d="M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z" {...ICON_STROKE} />
    </svg>
  );
}

/** 尖括号图标：源码视图。 */
function CodeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M18 16L10 24L18 32" {...ARROW_STROKE} />
      <path d="M30 16L38 24L30 32" {...ARROW_STROKE} />
    </svg>
  );
}

// shiki 高亮器的全局单例：只创建一次；语言在初始化时一次性加载
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [HIGHLIGHT_THEME],
    langs: [...new Set(Object.values(EXT_LANG))],
  });
  return highlighterPromise;
}

/** 错误码到 i18n 文案 key 的映射，文件树与预览共用。 */
const ERROR_KEY_SUFFIX: Record<WorkspaceFileErrorCode, string> = {
  NO_WORKSPACE: "NoWorkspace", OUT_OF_ROOT: "OutOfRoot", NOT_FOUND: "NotFound", IS_DIRECTORY: "IsDirectory",
  TOO_LARGE: "TooLarge", BINARY: "Binary", LIST_FAILED: "ListFailed", READ_FAILED: "ReadFailed",
  INVALID_REQUEST: "InvalidRequest", FORBIDDEN: "Forbidden", CANCELLED: "Cancelled", CONFLICT: "Conflict",
  WORKSPACE_CHANGED: "WorkspaceChanged", LINK_READ_ONLY: "LinkReadOnly", UNSUPPORTED_TEXT: "UnsupportedText",
  READ_ONLY: "ReadOnly", WRITE_FAILED: "WriteFailed", WRITE_BUSY: "WriteBusy",
};
const ERROR_KEYS = Object.fromEntries(
  (Object.entries(ERROR_KEY_SUFFIX) as Array<[WorkspaceFileErrorCode, string]>).map(([code, suffix]) => [code, `fileTree.err${suffix}`]),
) as Record<WorkspaceFileErrorCode, string>;

type TreeItem = DataNode & {
  key: string;
  title: string;
  isDir: boolean;
  /** 目录的子级是否已经拉取过（懒加载标记）。 */
  loaded?: boolean;
  /** 覆盖 DataNode 中过于宽泛的 children 类型，让 attachChildren 的递归参数能对上。 */
  children?: TreeItem[];
};

/** 目录图标：展开时显示 📁，收起时显示 📂。 */
const folderGlyph = (props: { expanded?: boolean }) => (
  <span className="ff-file-tree__folder-icon" aria-hidden="true">
    {props.expanded ? "📁" : "📂"}
  </span>
);

/** 文件图标：能识别类型的用 VS Code 官方图标，其余用通用文件图标。 */
function fileGlyph(name: string) {
  const iconUrl = vscodeIconForFile(name);
  return iconUrl
    ? <img className="ff-file-tree__type-icon" src={iconUrl} alt="" width={14} height={14} />
    : <FileText size={14} strokeWidth={1.75} aria-hidden="true" />;
}

/** 把目录条目转换成树节点。 */
function toTreeItem(entry: WorkspaceFileEntry): TreeItem {
  const icon = entry.isDir ? folderGlyph : () => fileGlyph(entry.name);
  return { key: entry.relPath, title: entry.name, isDir: entry.isDir, isLeaf: !entry.isDir, icon };
}

/** 把拉取到的子级挂到指定的目录节点下，递归查找目标。 */
function attachChildren(items: TreeItem[], parentKey: string, children: TreeItem[]): TreeItem[] {
  return items.map((item) => {
    if (item.key === parentKey) return { ...item, children, loaded: true };
    return item.children ? { ...item, children: attachChildren(item.children, parentKey, children) } : item;
  });
}

export function FileTreePanel({
  sessionId,
  workspaceRoot,
  onOpenFile,
  refreshRevision,
}: {
  sessionId: string;
  /** 工作区根路径，仅用于判断是否已绑定；真正的访问都带 sessionId，由主进程校验。 */
  workspaceRoot?: string;
  onOpenFile: (relPath: string) => void;
  /** 外部工作区变更时通知；变化后会重新读取目录，以及已展开的子目录。 */
  refreshRevision?: number | string;
}) {
  const [treeData, setTreeData] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<WorkspaceFileErrorCode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const { t } = useTranslation();
  const expandedRef = useRef<string[]>([]);
  const workspaceRef = useRef({ sessionId, workspaceRoot });
  // 每一轮读取都有独立的身份：旧根目录或旧的懒加载结果，不能写进新的一轮。
  const requestScope = useMemo(() => ({ active: false, generation: 0 }), [sessionId, workspaceRoot, refreshRevision, refreshSequence]);
  // 树根容器的引用：切换标签前用它释放焦点，避免 aria-hidden 区域仍持有 activeElement。
  const treeRootRef = useRef<HTMLDivElement>(null);

  const listDirectory = useCallback(async (relPath: string) => {
    const bridge = window.workspaceFiles;
    if (!bridge) throw new Error("workspaceFiles API unavailable");
    const result = await bridge.list(sessionId, relPath);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
    return { items: result.entries.map(toTreeItem), truncated: Boolean(result.truncated) };
  }, [sessionId]);

  useEffect(() => {
    requestScope.active = true;
    const generation = ++requestScope.generation;
    const isCurrent = () => requestScope.active && requestScope.generation === generation;
    if (workspaceRef.current.sessionId !== sessionId || workspaceRef.current.workspaceRoot !== workspaceRoot) {
      expandedRef.current = [];
      setExpandedKeys([]);
      workspaceRef.current = { sessionId, workspaceRoot };
    }
    setLoading(Boolean(workspaceRoot));
    setError(null);
    setTreeData([]);
    setTruncated(false);
    if (!workspaceRoot) return () => { requestScope.active = false; };

    const expanded = new Set(expandedRef.current);
    let nextTruncated = false;
    // 保留展开状态，但不复用已缓存的子节点；如果某个目录已经不存在，就不再请求它。
    const readExpanded = async (relPath: string): Promise<TreeItem[]> => {
      const result = await listDirectory(relPath);
      if (!isCurrent()) return [];
      nextTruncated ||= result.truncated;
      return Promise.all(result.items.map(async (item) => item.isDir && expanded.has(item.key)
        ? { ...item, loaded: true, children: await readExpanded(item.key) }
        : item));
    };
    readExpanded("")
      .then((items) => {
        if (!isCurrent()) return;
        setTreeData(items);
        setTruncated(nextTruncated);
      })
      .catch((err: { code?: WorkspaceFileErrorCode }) => {
        if (isCurrent()) setError(err?.code ?? "LIST_FAILED");
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => { requestScope.active = false; };
  }, [listDirectory, sessionId, workspaceRoot, requestScope]);

  const loadData = useCallback(async (node: EventDataNode<TreeItem>) => {
    const item = node as unknown as TreeItem;
    if (!requestScope.active || !item.isDir || item.loaded) return;
    const generation = requestScope.generation;
    const isCurrent = () => requestScope.active && requestScope.generation === generation;
    try {
      const result = await listDirectory(item.key);
      if (!isCurrent()) return;
      setTreeData((current) => attachChildren(current, item.key, result.items));
      setTruncated((current) => current || result.truncated);
    } catch (err) {
      if (isCurrent()) setError((err as { code?: WorkspaceFileErrorCode })?.code ?? "LIST_FAILED");
    }
  }, [listDirectory, requestScope]);

  const stateMessage = !workspaceRoot ? t("fileTree.errNoWorkspace")
    : loading ? t("fileTree.loading")
    : error ? t(ERROR_KEYS[error])
    : treeData.length === 0 ? t("fileTree.empty") : null;

  return (
    <div className="ff-file-tree" ref={treeRootRef} aria-busy={loading}>
      <div className="ff-file-tree__header">
        <span>{t("fileTree.title")}</span>
        <button
          type="button"
          className="ff-file-refresh"
          aria-label={t("fileTree.refresh")}
          title={!workspaceRoot ? t("fileTree.errNoWorkspace") : t("fileTree.refresh")}
          disabled={!workspaceRoot || loading}
          onClick={() => setRefreshSequence((value) => value + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {t("fileTree.refresh")}
        </button>
      </div>
      {stateMessage ? <div className="ff-file-tree__state" role="status">{stateMessage}</div> : (
        <Tree.DirectoryTree
          treeData={treeData}
          loadData={loadData}
          expandedKeys={expandedKeys}
          onExpand={(keys) => {
            if (!requestScope.active) return;
            const next = keys.map(String);
            expandedRef.current = next;
            setExpandedKeys(next);
          }}
          blockNode
          showIcon
          onSelect={(_keys, info) => {
            const item = info.node as unknown as TreeItem;
            if (item.isDir) return;
            releaseFocusedDescendant(treeRootRef.current);
            onOpenFile(item.key);
          }}
        />
      )}
      {truncated && <div className="ff-file-tree__truncated">{t("fileTree.truncated", { count: 1000 })}</div>}
    </div>
  );
}

// 共享的颜色初始化逻辑负责维护这个属性。监听它只会改变 token 的展示，
// 不能触发新的文件读取，也不能修改主题本身。
function subscribePreviewColors(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-colors"] });
  return () => observer.disconnect();
}
function previewColorSnapshot(): string {
  return document.documentElement.dataset.uiColors ?? "";
}

export function FilePreviewContent({
  sessionId,
  workspaceRoot,
  relPath,
  scrollToLine,
  lineSeq,
  refreshRevision,
}: {
  sessionId: string;
  workspaceRoot?: string;
  relPath: string;
  /** 从消息里的文件链接跳转过来时，要定位并居中滚动到的行；省略则不定位。 */
  scrollToLine?: number;
  /** 定位序号：同一标签切换到不同行号时，靠它的变化触发重新滚动。 */
  lineSeq?: number;
  /** 外部工作区变更时通知；不会重置用户选择的 Markdown 展示方式。 */
  refreshRevision?: number | string;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; code: WorkspaceFileErrorCode }
    | ({ phase: "ok" } & Extract<WorkspaceReadResult, { ok: true }>)
  >({ phase: "loading" });
  // shiki 的高亮结果；null 表示尚未高亮或不支持，先按纯文本渲染
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const { t } = useTranslation();
  const customColorKey = useSyncExternalStore(subscribePreviewColors, previewColorSnapshot, () => "");
  const customPalette = useMemo(() => {
    if (!customColorKey) return null;
    const [accent, background, foreground] = customColorKey.split(":");
    return uiColorTokens({ enabled: true, accent, background, foreground });
  }, [customColorKey]);
  const tokenColor = (color: string) => customPalette && uiColorContrast({
    background: customPalette["--ff-bg-page"], foreground: color,
  }) < 4.5 ? customPalette["--ff-text"] : color;

  // Markdown 文件有两种查看方式：渲染预览和源码（非 Markdown 不需要切换）。
  // 如果是带行号跳转过来的，直接进入源码视图，因为预览视图没有行号的概念。
  const isMarkdown = isMarkdownPath(relPath);
  const [mdView, setMdView] = useState<"preview" | "source">(scrollToLine === undefined ? "preview" : "source");
  const selectMdView = (view: "preview" | "source") => () => setMdView(view);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const editorKey = workspaceEditorKey(sessionId, workspaceRoot, relPath);
  const editorState = useWorkspaceEditorState(editorKey);
  const editing = Boolean(editorState?.draft);
  const [refreshSequence, setRefreshSequence] = useState(0);

  useEffect(() => {
    // 只有切换文件时才恢复默认视图；刷新或重试失败时保留用户的选择。
    setMdView(scrollToLine === undefined ? "preview" : "source");
  }, [sessionId, relPath]);

  useEffect(() => {
    let cancelled = false;
    const draft = getWorkspaceEditorState(editorKey)?.draft;
    if (draft) {
      setState({ phase: "ok", ok: true, content: draft.original, size: draft.size, editVersion: draft.editVersion });
      return;
    }
    setState({ phase: "loading" });
    setTokens(null);
    const bridge = window.workspaceFiles;
    if (!bridge) {
      setState({ phase: "error", code: "READ_FAILED" });
      return;
    }
    bridge.read(sessionId, relPath)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ phase: "error", code: result.code });
          return;
        }
        setState({ phase: "ok", ...result });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ phase: "error", code: "READ_FAILED" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, relPath, editorKey, refreshRevision, refreshSequence]);

  useEffect(() => {
    if (!editorState?.saved) return;
    setState({ phase: "ok", ...editorState.saved });
    consumeWorkspaceEditorSave(editorKey);
  }, [editorKey, editorState?.saved]);

  const highlightedText = state.phase === "ok" ? state.content : undefined;
  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    const language = langForPath(relPath);
    if (highlightedText !== undefined && language) getHighlighter()
      .then(highlighter => highlighter.codeToTokens(highlightedText, { lang: language, theme: HIGHLIGHT_THEME }))
      .then(highlight => { if (!cancelled) setTokens(highlight.tokens); })
      .catch(() => { /* 高亮失败时仍保留纯文本，保证可读 */ });
    return () => { cancelled = true; };
  }, [editorKey, relPath, highlightedText]);

  // 行号定位：内容就绪后把目标行滚到视口中央；lineSeq 变化（同一标签切到别的行号）时重新滚动
  useEffect(() => {
    if (state.phase !== "ok" || scrollToLine === undefined) return;
    const host = scrollHostRef.current;
    if (!host) return;
    const row = host.querySelector<HTMLElement>(`[data-line="${scrollToLine}"]`);
    row?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [state.phase, scrollToLine, lineSeq, mdView]);

  // 高亮结果和纯文本都统一成“每行一组 token”的结构，再渲染
  const text = state.phase === "ok" ? state.content : "";
  const totalLines = tokens ? tokens.length : text.split("\n").length;
  const lineTokens: ThemedToken[][] = tokens ?? text.split("\n").map((line) => [{ content: line, offset: 0 }]);
  const lines = lineTokens.slice(0, PREVIEW_MAX_LINES);
  const renderedContent = isMarkdown && totalLines > PREVIEW_MAX_LINES
    ? text.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n")
    : text;

  return (
    <div className="ff-file-preview" ref={scrollHostRef} aria-busy={state.phase === "loading"}>
      <div className="ff-file-preview__header">
        <span className="ff-file-preview__path" title={relPath}>{relPath}</span>
        {state.phase === "ok" && <span className="ff-file-preview__size">{(state.size / 1024).toFixed(1)} KB</span>}
        <button
          type="button"
          className="ff-file-refresh"
          aria-label={t("fileTree.refreshPreview")}
          title={t("fileTree.refreshPreview")}
          disabled={state.phase === "loading" || editing}
          onClick={() => setRefreshSequence((value) => value + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        {isMarkdown && !editing && (
          <span className="ff-file-preview__md-toggle" role="group" aria-label={t("rightInspector.toggle")}>
            <button
              type="button"
              className={`ff-file-preview__md-btn ${mdView === "preview" ? "is-active" : ""}`}
              onClick={selectMdView("preview")}
              aria-label={t("fileTree.viewPreview")}
              title={t("fileTree.viewPreview")}
            >
              <EyeIcon />
            </button>
            <button
              type="button"
              className={`ff-file-preview__md-btn ${mdView === "source" ? "is-active" : ""}`}
              onClick={selectMdView("source")}
              aria-label={t("fileTree.viewSource")}
              title={t("fileTree.viewSource")}
            >
              <CodeIcon />
            </button>
          </span>
        )}
      </div>
      <WorkspaceTextEditor editorKey={editorKey} sessionId={sessionId} relPath={relPath}
        snapshot={state.phase === "ok" ? state : undefined} errorText={code => t(ERROR_KEYS[code])} />
      {editing ? null : state.phase !== "ok" ? (
        <div className="ff-file-preview__state" role="status">
          {state.phase === "loading" ? t("fileTree.previewLoading") : t(ERROR_KEYS[state.code])}
        </div>
      ) : isMarkdown && mdView === "preview" ? (
        <div className="ff-file-preview__markdown">
          <MarkdownContent content={renderedContent} />
        </div>
      ) : (
        <pre className="ff-file-preview__code">
          {lines.map((line, index) => (
            <div className="ff-file-preview__line" key={index} data-line={index + 1}>
              <span className="ff-file-preview__lineno">{index + 1}</span>
              <span className="ff-file-preview__text">
                {line.map((token, tokenIndex) => token.color
                  ? <span key={tokenIndex} style={{ color: tokenColor(token.color) }}>{token.content}</span>
                  : token.content)}
              </span>
            </div>
          ))}
        </pre>
      )}
      {!editing && state.phase === "ok" && totalLines > PREVIEW_MAX_LINES && (
        <div className="ff-file-preview__truncated">
          {t("fileTree.previewLinesHint", { count: PREVIEW_MAX_LINES })}
        </div>
      )}
    </div>
  );
}
