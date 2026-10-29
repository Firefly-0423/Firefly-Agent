import { useSlashCommands } from "./SlashCommandMenu";
import { DesktopAsrButton } from "./DesktopAsrButton";
import { Sender } from "@ant-design/x";
import { Popover } from "antd";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "../../../i18n";
import { resolveAsset } from "../../../../../shared/renderer-base";
import { FIREFLY_AUTO_STICKERS } from "../../../../../shared/firefly-stickers";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import './ModelEffortControl.css';
import { PermissionControl } from "./PermissionControl";
import { ModelEffortControl } from "./ModelEffortControl";
import { PendingQueueDock, type PendingQueueDockItem } from "./PendingQueueDock";
import { StepProgressPill } from "./StepProgressPill";
import { smartPunctuate } from "./smart-punctuation";
import type { StepProgressSummary } from "./step-progress";

type ChatComposerProps = {
  stepProgress?: StepProgressSummary;
  contextUsage?: ContextUsageSnapshot;
  onSelectModelProfile?: (id: string) => void;
  activeModelProfileId?: string;
  onChooseSticker: (id: string) => void;
  /** 粘贴图片（Ctrl+V 时剪贴板含图片且没有文本）会触发它；由父级落临时文件并追加附件。 */
  onPasteImage?: (file: File) => void;
  onScreenshot: () => void;
  onRemoveAttachment: (index: number) => void;
  onChooseFiles: (files: File[]) => void;
  onChooseWorkspace: () => void;
  onAdjustQueuedMessage?: (id: string) => Promise<boolean>;
  onEditQueuedMessage?: (id: string, content: string) => Promise<boolean>;
  onRemoveQueuedMessage?: (id: string) => void;
  onQueueMessage?: (value: string) => void;
  onCancel?: () => void;
  onSubmit: (value: string) => void;
  onChange: (value: string) => void;
  pendingQueue?: PendingQueueDockItem[];
  modelBusy?: boolean;
  attachmentBusy?: boolean;
  onRequireDocumentReadChange?: (value: boolean) => void;
  requireDocumentRead?: boolean;
  attachments: ComposerAttachment[];
  /** 当前会话绑定的项目根路径：计划文件优先落到工作区的 .firefly/ 目录。 */
  workspaceRoot?: string;
  workspaceName?: string;
  /** 当前会话 ID：用于上下文用量与计划模式状态。 */
  conversationId?: string;
  /** 由斜杠命令产生的简短结果提示，例如 "/compact"。 */
  onNotice?: (message: string, tone: "success" | "error") => void;
  /** 输入 "/new" 时在斜杠菜单里开始新任务。 */
  onNewTask?: () => void;
  docked: boolean;
  mode: string;
  value: string;
};

export type ComposerAttachment = {
  imageSendMode?: "direct" | "caption";
  reason?: string;
  status?: string;
  caption?: string;
  hasAnnotations?: boolean;
  previewUrl?: string;
  mime?: string;
  filePath?: string;
  kind: string;
  name: string;
};

/** 粘贴图片的 MIME 白名单，与主进程对截图临时文件的校验保持一致。 */
const PASTE_IMAGE_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

type EnabledSticker = {
  description?: string;
  src: string;
  id: string;
};

/** 把输入框内容拆成正文和贴纸标记：可见正文去掉贴纸标记；非 code 模式下会保留第一个贴纸 ID。 */
type ParsedComposerMessage = { rawContent: string; visibleContent: string; userSticker?: string };

export function parseComposerMessage(mode: string, content: string): ParsedComposerMessage {
  const trimmed = content.trim();
  const visibleContent = trimmed.replace(/\[sticker:[^\]]+\]/gi, "").trim();
  if (mode === "code") return { rawContent: visibleContent, visibleContent, userSticker: undefined };
  const firstSticker = trimmed.match(/\[sticker:([^\]]+)\]/i)?.[1]?.trim();
  return { rawContent: trimmed, visibleContent, userSticker: firstSticker || undefined };
}

/** 把已识别的 `[sticker:id]` 标记从输入文本里拆出来。标记会追加回正文末尾，原文可以无损还原，包括末尾空格。 */
export function splitStickerMarkers(value: string, knownIds: ReadonlySet<string>): { visible: string; markers: string[] } {
  const markers: string[] = [];
  const visible = value.replace(/\[sticker:([^\]]+)\]/gi, (marker, rawId: string) => {
    if (!knownIds.has(rawId.trim())) return marker;
    markers.push(marker);
    return "";
  });
  return { visible, markers };
}

function stickerUrl(src: string): string {
  return src.startsWith("/stickers/") ? resolveAsset(src) : src;
}

// Firefly 自己发送的贴纸，由她自动发出，所以不放进我们的选择器里。
const FIREFLY_OWN_STICKER_IDS = new Set<string>(FIREFLY_AUTO_STICKERS.map(sticker => sticker.id));

/** 用户可以手动发送的贴纸：除了 Firefly 自己保留的之外，其余都可以选。 */
export function pickableStickers<T extends { id: string }>(items: readonly T[]): T[] {
  return items.filter(item => !FIREFLY_OWN_STICKER_IDS.has(item.id));
}

function StickerGrid({ onChoose }: { onChoose: (id: string) => void }) {
  const { t } = useTranslation();
  const [stickers, setStickers] = useState<EnabledSticker[]>([]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((items) => {
      if (active) setStickers(pickableStickers(items));
    }).catch(() => {
      if (!active) return;
      setStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="ff-sticker-picker" aria-label={t("composer.stickerList")}>
      {stickers.length === 0 && <span className="ff-sticker-picker__empty">{t("composer.stickerEmpty")}</span>}
      {stickers.map((sticker) => (
        <button type="button" key={sticker.id} title={sticker.description ?? sticker.id} onClick={() => onChoose(sticker.id)}>
          <img src={stickerUrl(sticker.src)} alt={sticker.description ?? sticker.id} draggable={false} />
        </button>
      ))}
    </div>
  );
}

/** “+”菜单里能看到的入口；不支持贴纸的模式不显示贴纸。 */
export function composerAddMenuEntries(supportsStickers: boolean): Array<"upload" | "screenshot" | "sticker"> {
  return supportsStickers ? ["upload", "screenshot", "sticker"] : ["upload", "screenshot"];
}

/** 一行胶囊放下“+”、输入、语音和发送所需的对话栏宽度（权限与模型在胶囊下面一行）。 */
export const CAPSULE_MIN_ROOM = 440;
export function capsuleFits(room: number): boolean {
  return room >= CAPSULE_MIN_ROOM;
}

function PaperclipIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.6 8.6a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 5 5l-8.7 8.7a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9" /></svg>;
}

function CameraFrameIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><rect x="8" y="8" width="8" height="8" rx="1.5" /></svg>;
}

function SmileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.2a4.2 4.2 0 0 0 7 0M9 9.6h.01M15 9.6h.01" /></svg>;
}

/** 唯一的“+”入口：上传文件、截图，或选择贴纸。 */
function ComposerAddMenu({ supportsStickers, attachmentBusy, onUpload, onScreenshot, onChooseSticker }: {
  supportsStickers: boolean;
  attachmentBusy: boolean;
  onUpload: () => void;
  onScreenshot: () => void;
  onChooseSticker: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "stickers">("menu");
  const close = () => { setOpen(false); setView("menu"); };
  const entries = composerAddMenuEntries(supportsStickers);

  const menu = (
    <div className="ff-add-menu">
      <span className="ff-add-menu__title">{t("composer.addMenuTitle")}</span>
      {entries.includes("upload") && (
        <button type="button" className="ff-add-menu__item" aria-label={t("composer.uploadFile")} disabled={attachmentBusy} onClick={() => { close(); onUpload(); }}>
          <PaperclipIcon /><span>{t("composer.uploadFile")}</span>
        </button>
      )}
      {entries.includes("screenshot") && (
        <button type="button" className="ff-add-menu__item" aria-label={t("composer.screenshot")} onClick={() => { close(); onScreenshot(); }}>
          <CameraFrameIcon /><span>{t("composer.screenshot")}</span><small>Alt+Shift+S</small>
        </button>
      )}
      {entries.includes("sticker") && (
        <button type="button" className="ff-add-menu__item" aria-label={t("composer.stickerPicker")} onClick={() => setView("stickers")}>
          <SmileIcon /><span>{t("composer.stickerPicker")}</span>
        </button>
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setView("menu"); }}
      trigger="click"
      placement="topLeft"
      rootClassName="ff-add-popover"
      content={view === "stickers" ? (
        <div className="ff-add-menu ff-add-menu--stickers">
          <button type="button" className="ff-add-menu__back" onClick={() => setView("menu")}><span aria-hidden="true">‹</span><span>{t("composer.stickerPicker")}</span></button>
          <StickerGrid onChoose={(id) => { onChooseSticker(id); close(); }} />
        </div>
      ) : menu}
    >
      <button type="button" className="ff-composer__icon-button ff-composer__add-button" aria-label={t("composer.addMenuTitle")} title={t("composer.addMenuTitle")}>
        <PlusIcon />
      </button>
    </Popover>
  );
}

/** 文件夹图标的路径数据，两种图标都基于 48×48 视口。 */
const FOLDER_PATHS = [
  "M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z",
  "M14 22L19 27L14 32",
  "M26 32H34",
];
const CODE_FOLDER_PATHS = [
  "M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22",
  "M38 29L43 34L38 39",
  "M30 29L25 34L30 39",
];

function FolderIcon() {
  return (
    <svg className="ff-composer__terminal-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {FOLDER_PATHS.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function CodeFolderIcon() {
  return (
    <svg className="ff-composer__code-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {CODE_FOLDER_PATHS.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    value, mode, docked, onNewTask, onNotice, conversationId, workspaceName, workspaceRoot,
    attachments, requireDocumentRead = false, onRequireDocumentReadChange, attachmentBusy = false,
    modelBusy = false, pendingQueue = [], onChange, onSubmit, onCancel, onQueueMessage,
    onRemoveQueuedMessage, onEditQueuedMessage, onAdjustQueuedMessage, onChooseWorkspace,
    onChooseFiles, onRemoveAttachment, onScreenshot, onPasteImage, onChooseSticker,
    activeModelProfileId, onSelectModelProfile, contextUsage, stepProgress,
  } = props;
  void contextUsage;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compositionActiveRef = useRef(false);
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const { t } = useTranslation();
  const supportsWorkFiles = ["work", "code"].includes(mode);
  const supportsPermission = supportsWorkFiles;
  const supportsStickers = mode !== "code";
  const requiresWorkspace = supportsWorkFiles;
  const missingWorkspace = requiresWorkspace && !workspaceName;
  const placeholder = mode === "chat" ? t("composer.placeholderChat")
    : missingWorkspace ? t("composer.placeholderTaskNoWorkspace") : t("composer.placeholderTask");
  const markerIds = supportsStickers
    ? [...value.matchAll(/\[sticker:([^\]]+)\]/gi)].map((match) => match[1].trim()).filter(Boolean)
    : [];
  const seenCount = new Map<string, number>();
  const selectedStickers = markerIds
    .map((id) => {
      const occurrence = seenCount.get(id) ?? 0;
      seenCount.set(id, occurrence + 1);
      return { id, occurrence, sticker: enabledStickers.find((item) => item.id === id) };
    })
    .filter((item): item is { id: string; occurrence: number; sticker: EnabledSticker } => Boolean(item.sticker));

  // 草稿字符串始终保留 `[sticker:id]` 标记。输入框只显示用户自己输入的文字；识别出来的贴纸只出现一次，
  // 以可删除的缩略图形式放在输入框上方。没识别出的标记仍然可见，避免变成看不见的文字。
  const { visible: visibleValue, markers: hiddenMarkers } = supportsStickers
    ? splitStickerMarkers(value, new Set(enabledStickers.map((item) => item.id)))
    : { visible: value, markers: [] as string[] };
  const withStickerMarkers = (typed: string) => `${typed}${hiddenMarkers.join("")}`;

  useEffect(() => {
    let alive = true;
    void window.chat?.getEnabledStickers?.().then((items) => {
      if (alive) setEnabledStickers(items);
    }).catch(() => {
      if (alive) setEnabledStickers([]);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 删除第 targetIndex 个同 ID 的贴纸标记，然后合并多余的空格
  const removeSelectedSticker = (id: string, targetIndex: number) => {
    let seen = -1;
    const stripped = value.replace(/\[sticker:([^\]]+)\]/gi, (marker, rawId: string) => {
      if (rawId.trim() !== id) return marker;
      seen += 1;
      return seen === targetIndex ? "" : marker;
    });
    onChange(stripped.replace(/ {2,}/g, " ").trim());
  };

  const hasComposerHeader = attachments.length > 0 || selectedStickers.length > 0;

  // 运行中的会话里，输入框先是一行的胶囊。文字换行或加了附件时展开成完整卡片；只有输入框重新变空时才收回，
  // 这样用户在换行临界点附近打字时，它不会来回切换。
  const shellRef = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);
  useEffect(() => { if (!value.trim()) setGrown(false); }, [value]);
  useEffect(() => {
    if (!docked || grown) return;
    const input = shellRef.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (!input || typeof ResizeObserver !== "function") return;
    // 只有真正的文字才可能换行；输入框为空时，即便 textarea 还保留着旧高度，也维持胶囊形态。
    const check = () => {
      if (!input.value) return;
      const style = getComputedStyle(input);
      const line = parseFloat(style.lineHeight) || 22;
      const content = input.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (content > line * 1.5) setGrown(true);
    };
    const observer = new ResizeObserver(check);
    observer.observe(input);
    check();
    return () => observer.disconnect();
  }, [docked, grown, value]);
  // 对话栏旁边开着概览卡片时可能比胶囊还窄；放不下就用两行卡片，不伸到卡片上面去。
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const column = shellRef.current?.closest<HTMLElement>(".ff-workspace-content");
    if (!docked || !column || typeof ResizeObserver !== "function") return;
    const measure = () => setRoomy(capsuleFits(column.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    measure();
    return () => observer.disconnect();
  }, [docked]);
  const capsule = Boolean(docked) && !grown && !hasComposerHeader && roomy;
  // 对话底部的输入框把权限和模型放在框下面一行（左权限、右模型），框里只留输入和发送；欢迎页的大输入框不变。
  const controlsBelow = Boolean(docked);
  const permissionControl = supportsPermission ? <PermissionControl /> : null;
  const modelControl = onSelectModelProfile
    ? <ModelEffortControl sessionId={conversationId} activeProfileId={activeModelProfileId} onSelectModelProfile={onSelectModelProfile} />
    : null;

  // Sender 的 onKeyDown 声明在 Element 层级；函数体只用基类属性，参数随组件声明放宽
  const slash = useSlashCommands({
    value: visibleValue, mode, conversationId, busy: modelBusy,
    onChange: (next) => onChange(withStickerMarkers(next)), onNewTask, onNotice,
  });

  const handleSenderKeyDown = (event: KeyboardEvent<Element>) => {
    // 斜杠菜单打开时，接管 ↑ ↓ Enter Tab Esc
    if (slash.onKeyDown(event)) return false;
    const plainEnter = event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (!modelBusy || !plainEnter) return;
    const native = event.nativeEvent as globalThis.KeyboardEvent;
    if (compositionActiveRef.current || native.isComposing || native.keyCode === 229) return;
    event.preventDefault();
    if (value.trim()) onQueueMessage?.(value);
    // Sender 会先调用 onKeyDown；返回 false 可以阻止它继续走内置的提交逻辑。
    return false;
  };

  // Ctrl+V 粘贴图片：只有剪贴板里没有 text/plain、且含白名单内图片时才拦截默认粘贴。
  // 浏览器剪贴板经常同时带 text/plain 和 image/png（复制网页富文本），如果一律拦截，用户想粘的文字就没了。
  // 大小限制与临时文件由父级的 handlePastedImage 负责。
  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const data = event.clipboardData;
    if (!onPasteImage || !data) return;
    if (Array.from(data.types).includes("text/plain")) return;
    const image = Array.from(data.items).find((item) => item.kind === "file" && PASTE_IMAGE_MIME_WHITELIST.has(item.type));
    const file = image?.getAsFile();
    if (file == null) return;
    event.preventDefault();
    onPasteImage(file);
  };

  return (
    <div
      className={`ff-composer-stack ${docked ? "is-docked" : "is-centered"}`}
      onCompositionStartCapture={() => { compositionActiveRef.current = true; }}
      onCompositionEndCapture={() => { compositionActiveRef.current = false; }}
    >
      {stepProgress && <StepProgressPill {...stepProgress} />}
      <PendingQueueDock
        onRemove={onRemoveQueuedMessage}
        onAdjust={onAdjustQueuedMessage}
        onEdit={onEditQueuedMessage}
        adjustmentAvailable={modelBusy}
        items={pendingQueue}
      />
      {supportsWorkFiles && (
        <div className="ff-composer__project-strip">
          <button type="button" className="ff-composer__footer-button" aria-label={t("composer.workspaceChoose")} onClick={onChooseWorkspace}>
            {mode === "code" ? <CodeFolderIcon /> : <FolderIcon />}
            <span>{workspaceName ?? (docked ? t("composer.workspaceFolder") : t("composer.workspaceEnter"))}</span>
            <ChevronIcon />
          </button>
        </div>
      )}
      {slash.menu}
      <div ref={shellRef} className={`ff-composer-shell${capsule ? " is-capsule" : ""}`}>
        <input
          ref={fileInputRef}
          className="ff-composer__file-input"
          multiple
          type="file"
          accept=".txt,.md,.json,.csv,.log,.png,.jpg,.jpeg,.webp,.gif,.bmp"
          onChange={(event) => {
            const picked = Array.from(event.currentTarget.files ?? []);
            if (picked.length > 0) onChooseFiles(picked);
            event.currentTarget.value = "";
          }}
        />
        <Sender
          rootClassName="ff-composer"
          value={visibleValue}
          placeholder={placeholder}
          // 运行中使用 Sender 自带的停止按钮；Enter 入队由 onKeyDown 在内置提交前处理。
          loading={modelBusy}
          disabled={!modelBusy && requiresWorkspace && !workspaceName}
          autoSize={capsule ? { minRows: 1, maxRows: 1 } : { minRows: docked ? 2 : 3, maxRows: 7 }}
          onChange={(next) => onChange(withStickerMarkers(
            // 智能标点（外观 → 高级）只格式化草稿末尾刚输入的内容。
            document.documentElement.hasAttribute("data-smart-punctuation") ? smartPunctuate(visibleValue, next) : next,
          ))}
          onPaste={handlePaste}
          onCancel={onCancel}
          onKeyDown={handleSenderKeyDown}
          onSubmit={(submitValue) => {
            const full = withStickerMarkers(submitValue);
            if (!full.trim()) return;
            onSubmit(full);
          }}
          suffix={(actionNode, { components }) => {
            const send = modelBusy ? (
              <components.LoadingButton
                title={t("composer.stopRun")}
                aria-label={t("composer.stopRun")}
              />
            ) : hiddenMarkers.length > 0 && !visibleValue.trim() ? (
              // 只有一个贴纸也算一条完整消息，即使文字框是空的。
              <span className="ff-composer__send-sticker"><components.SendButton disabled={false} /></span>
            ) : actionNode;
            return (
              <div className="ff-composer__suffix">
                {!controlsBelow && modelControl}
                <DesktopAsrButton key={`${mode}:${conversationId ?? "new"}:${workspaceRoot ?? ""}`} onText={text => onChange(`${value}${value && !/\s$/.test(value) ? " " : ""}${text}`)} />
                {send}
              </div>
            );
          }}
          header={hasComposerHeader ? (
            <div className="ff-composer__attachments" aria-label={t("composer.attachmentsLabel")}>
              {attachments.map((attachment, index) => {
                const isImage = attachment.kind === "image" && attachment.previewUrl;
                return (
                  <div className={`ff-composer__attachment ${isImage ? "is-image" : ""}`} key={`${attachment.filePath ?? attachment.name}-${index}`}>
                    {isImage ? <img src={attachment.previewUrl} alt="" draggable={false} /> : <span title={attachment.name}>{attachment.name}</span>}
                    <button type="button" aria-label={t("composer.removeAttachment", { name: attachment.name })} onClick={() => onRemoveAttachment(index)}>×</button>
                  </div>
                );
              })}
              {selectedStickers.map(({ id, occurrence, sticker }) => (
                <div className="ff-composer__attachment ff-composer__attachment--sticker" key={`${id}-${occurrence}`}>
                  <img src={stickerUrl(sticker.src)} draggable={false} alt={sticker.description ?? t("composer.stickerSelected")} />
                  <button onClick={() => removeSelectedSticker(id, occurrence)} type="button" aria-label={t("composer.removeSticker")}>×</button>
                </div>
              ))}
            </div>
          ) : undefined}
          prefix={
            <div className="ff-composer__prefix-actions">
              <ComposerAddMenu
                supportsStickers={supportsStickers}
                attachmentBusy={attachmentBusy}
                onUpload={() => fileInputRef.current?.click()}
                onScreenshot={onScreenshot}
                onChooseSticker={onChooseSticker}
              />
              {!controlsBelow && permissionControl}
            </div>
          }
        />
        {mode === "work" && attachments.some((attachment) => attachment.kind === "document") && (
          <div className="ff-composer__footer">
            <label className="ff-composer__read-requirement">
              <input type="checkbox" checked={requireDocumentRead} onChange={(event) => onRequireDocumentReadChange?.(event.target.checked)} />
              {t("composer.requireDocumentRead")}
            </label>
          </div>
        )}
      </div>
      {controlsBelow && (permissionControl || modelControl) && (
        <div className="ff-composer__below">
          <div className="ff-composer__below-start">{permissionControl}</div>
          <div className="ff-composer__below-end">{modelControl}</div>
        </div>
      )}
    </div>
  );
}
