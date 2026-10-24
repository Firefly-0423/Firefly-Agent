import { useState, useRef, useEffect, type DragEvent } from "react";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";
import { t } from "../../../i18n";
import type { ScreenshotInsertPayload } from "../../../../../shared/ipc-channels";
import type { ComposerAttachment } from "../components/ChatComposer";
import { containsFiles, PASTE_IMAGE_MAX_BYTES, arrayBufferToBase64 } from "../pages/attachment-utils";

type ComposerChatApi = {
  captionImage: (filePath: string, hasAnnotations: boolean) => Promise<{ ok: boolean; caption?: string; error?: string }>;
  getImageSendStrategy: (sessionId: string) => Promise<{ mode: "direct" | "caption" }>;
  onScreenshotInsert: (callback: (data: ScreenshotInsertPayload) => void) => () => void;
  startScreenshot: () => Promise<{ ok: boolean; reason?: string } | undefined>;
  saveScreenshotTemp: (base64: string, mime: string) => Promise<{ filePath: string }>;
  ingestDroppedFiles: (files: File[]) => Promise<ComposerAttachment[]>;
};
function composerChatApi(): ComposerChatApi | undefined {
  return (window as typeof window & { chat?: ComposerChatApi }).chat;
}
export type ComposerDragHandlers = {
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
};
export type ComposerAttachmentsApi = {
  dragHandlers: ComposerDragHandlers;
  deleteScopeAttachments: (scope: string) => void;
  clearScopeAttachments: (sent: ComposerAttachment[]) => void;
  prepareImageAttachments: (sessionId: string, messageId: string, attachments: ComposerAttachment[]) => Promise<void>;
  removeAttachment: (index: number) => void;
  handleScreenshot: () => Promise<void>;
  handlePastedImage: (file: File) => Promise<void>;
  chooseFiles: (files: File[]) => Promise<void>;
  isDraggingFiles: boolean;
  attachmentBusy: boolean;
  attachments: ComposerAttachment[];
};

export function useComposerAttachments(input: {
  scopeKey: string;
  getActiveScope: () => string;
  patchMessageAttachments: (sessionId: string, messageId: string, updater: (attachments: ComposerAttachment[]) => ComposerAttachment[]) => void;
}): ComposerAttachmentsApi {
  const { scopeKey, getActiveScope, patchMessageAttachments } = input;
  const notices = useFeedback();
  const [scopes, updateScopes] = useState<Record<string, ComposerAttachment[]>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const previews = useRef(new Set<string>());

  useEffect(() => () => {
    for (const address of previews.current) URL.revokeObjectURL(address);
    previews.current.clear();
  }, []);

  function appendToScope(owner: string, entries: ComposerAttachment[]) {
    updateScopes((previous) => ({ ...previous, [owner]: [...(previous[owner] ?? []), ...entries] }));
  }

  useEffect(() => composerChatApi()?.onScreenshotInsert?.((packet) => {
    const owner = getActiveScope();
    const screenshot: ComposerAttachment = {
      kind: "image", name: t("chatPage.screenshotAttachmentName", { ts: Date.now() }),
      filePath: packet.filePath, mime: packet.mime, previewUrl: packet.previewUrl, hasAnnotations: packet.hasAnnotations,
    };
    appendToScope(owner, [screenshot]);
  }), []);

  async function chooseFiles(files: File[]) {
    const owner = scopeKey;
    const bridge = composerChatApi();
    if (!bridge || files.length === 0) return;
    setBusy(true);
    const byFilename = new Map<string, string[]>();
    for (const selected of files) {
      if (!selected.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(selected.name)) continue;
      const address = URL.createObjectURL(selected);
      previews.current.add(address);
      byFilename.set(selected.name, [...(byFilename.get(selected.name) ?? []), address]);
    }
    try {
      const imported = await bridge.ingestDroppedFiles(files);
      if (imported.length > 0) {
        const entries = imported.map((entry) => {
          if (entry.kind !== "image") return entry;
          const matching = byFilename.get(entry.name);
          const address = matching?.shift();
          return address ? { ...entry, previewUrl: address } : entry;
        });
        appendToScope(owner, entries);
      }
    } catch (failure) {
      notices.notice({ tone: "error", message: t("chatPage.ingestFilesFailed", { error: failure instanceof Error ? failure.message : String(failure) }) });
    } finally { setBusy(false); }
  }

  async function handlePastedImage(file: File) {
    const owner = scopeKey;
    const bridge = composerChatApi();
    if (!bridge?.saveScreenshotTemp) return;
    if (file.size > PASTE_IMAGE_MAX_BYTES) {
      notices.notice({ tone: "warning", message: t("chatPage.pastedImageTooLargeSkipped") });
      return;
    }
    setBusy(true);
    try {
      const encoded = arrayBufferToBase64(await file.arrayBuffer());
      const saved = await bridge.saveScreenshotTemp(encoded, file.type);
      const address = URL.createObjectURL(file);
      previews.current.add(address);
      const pasted: ComposerAttachment = {
        kind: "image", name: file.name && file.name !== "image.png" ? file.name : t("chatPage.pastedImageAttachmentName", { ts: Date.now() }),
        filePath: saved.filePath, mime: file.type, previewUrl: address,
      };
      appendToScope(owner, [pasted]);
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      let message: string;
      if (detail === "SCREENSHOT_TOO_LARGE") message = t("chatPage.pastedImageTooLarge");
      else if (detail === "INVALID_SCREENSHOT_IMAGE") message = t("chatPage.pastedImageInvalid");
      else message = t("chatPage.pastedImageFailed", { error: detail });
      notices.notice({ tone: "error", message });
    } finally { setBusy(false); }
  }

  async function handleScreenshot() {
    const reply = await composerChatApi()?.startScreenshot();
    if (!reply || reply.ok) return;
    const code = typeof reply.reason === "string" ? reply.reason : "";
    let message: string;
    let tone: "info" | "error" = "error";
    if (code.startsWith("HELPER_")) message = t("chatPage.screenshotHelperNotReady");
    else if (code.startsWith("SCREENSHOT_CANCELLED")) {
      message = t("chatPage.screenshotCancelled");
      tone = "info";
    } else if (code === "SCREENSHOT_FILE_PATH_REQUIRED") message = t("chatPage.screenshotFileMissing");
    else message = t("chatPage.screenshotFailed", { reason: code || t("chatPage.unknownError") });
    notices.notice({ tone, message });
  }

  async function prepareImageAttachments(sessionId: string, messageId: string, attachments: ComposerAttachment[]) {
    const pictures = attachments.filter((entry) => entry.kind === "image" && entry.filePath);
    const bridge = composerChatApi();
    if (pictures.length === 0 || !bridge) return;
    let delivery: { mode: "direct" | "caption" } = { mode: "caption" };
    try { delivery = await bridge.getImageSendStrategy(sessionId); }
    catch (failure) { console.warn("[Firefly React] 获取图片发送策略失败，回退视觉描述:", failure); }

    if (delivery.mode === "direct") {
      const paths = new Set(pictures.map((picture) => picture.filePath));
      patchMessageAttachments(sessionId, messageId, (previous) => previous.map((entry) =>
        paths.has(entry.filePath) ? { ...entry, imageSendMode: "direct", status: "done" } : entry));
      return;
    }
    for (const picture of pictures) {
      patchMessageAttachments(sessionId, messageId, (previous) => previous.map((entry) =>
        entry.filePath === picture.filePath ? { ...entry, imageSendMode: "caption", status: "processing" } : entry));
      let captioned: { ok: boolean; caption?: string; error?: string };
      try { captioned = await bridge.captionImage(picture.filePath!, picture.hasAnnotations === true); }
      catch (failure) { captioned = { ok: false, error: failure instanceof Error ? failure.message : String(failure) }; }
      patchMessageAttachments(sessionId, messageId, (previous) => previous.map((entry) => {
        if (entry.filePath !== picture.filePath) return entry;
        return captioned.ok && captioned.caption
          ? { ...entry, imageSendMode: "caption", status: "done", caption: captioned.caption, reason: undefined }
          : { ...entry, imageSendMode: "caption", status: "error", reason: captioned.error ?? t("chatPage.imageCaptionFailed") };
      }));
    }
  }

  function removeAttachment(index: number) {
    const owner = scopeKey;
    updateScopes((previous) => ({ ...previous, [owner]: (previous[owner] ?? []).filter((_entry, offset) => offset !== index) }));
  }
  function clearScopeAttachments(sent: ComposerAttachment[]) {
    updateScopes((previous) => {
      if (sent.length === 0) return previous;
      const delivered = new Set(sent.map((entry) => entry.filePath ?? entry.name));
      return { ...previous, [scopeKey]: (previous[scopeKey] ?? []).filter((entry) => !delivered.has(entry.filePath ?? entry.name)) };
    });
  }
  function deleteScopeAttachments(scope: string) {
    updateScopes((previous) => {
      const remaining = { ...previous };
      delete remaining[scope];
      return remaining;
    });
  }
  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }
  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }
  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!containsFiles(event.dataTransfer)) return;
    depth.current = 0;
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) void chooseFiles(dropped);
    else notices.notice({ tone: "warning", message: t("chatPage.dropNoFiles") });
  }
  return {
    attachments: scopes[scopeKey] ?? [], attachmentBusy: busy, isDraggingFiles: dragging,
    chooseFiles, handlePastedImage, handleScreenshot, removeAttachment, prepareImageAttachments,
    clearScopeAttachments, deleteScopeAttachments,
    dragHandlers: { onDragEnter: handleDragEnter, onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop },
  };
}
