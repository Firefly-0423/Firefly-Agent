// @vitest-environment jsdom
import { act, createElement as element, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useComposerAttachments } from "./useComposerAttachments";
import type { ComposerAttachmentsApi } from "./useComposerAttachments";
import type { ComposerAttachment } from "../components/ChatComposer";
import { t } from "../../../i18n";

const feedback = vi.hoisted(() => ({ notice: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock("../../../components/feedback/FeedbackProvider", () => ({ useFeedback: () => feedback }));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function tray() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); feedback.notice.mockClear();
  let state: ComposerAttachmentsApi;
  let active = "hidden-tray";
  let screenshot: ((data: { mime: "image/png"; filePath: string; previewUrl: string; hasAnnotations: boolean }) => void) | undefined;
  const native = { ingestDroppedFiles: vi.fn(), saveScreenshotTemp: vi.fn(), startScreenshot: vi.fn(), getImageSendStrategy: vi.fn(), captionImage: vi.fn(), onScreenshotInsert: vi.fn((callback: typeof screenshot) => { screenshot = callback; return () => { screenshot = undefined; }; }) };
  native.ingestDroppedFiles.mockResolvedValue([]);
  vi.stubGlobal("chat", native);
  let sequence = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++sequence}`);
  URL.revokeObjectURL = vi.fn();
  const patch = vi.fn<(session: string, id: string, fn: (rows: ComposerAttachment[]) => ComposerAttachment[]) => void>();
  const node = document.body.appendChild(document.createElement("main"));
  const renderer = createRoot(node);
  function Screen() { state = useComposerAttachments({ scopeKey: "visible-tray", getActiveScope: () => active, patchMessageAttachments: patch }); return null; }
  act(() => renderer.render(element(Screen)));
  const unmount = () => { act(() => renderer.unmount()); node.remove(); cleanup = undefined; }; cleanup = unmount;
  return { native, patch, read: () => state!, unmount,
    async run(fn: (api: ComposerAttachmentsApi) => void | Promise<void>) { await act(async () => { await fn(state!); }); },
    select: () => { active = "visible-tray"; },
    capture(path: string, annotated = false) { act(() => screenshot?.({ mime: "image/png", filePath: path, previewUrl: `preview:${path}`, hasAnnotations: annotated })); },
  };
}
const image = (name: string) => new File(["pixels"], name, { type: "image/png" });
function drag(types: string[], files: File[] = []) {
  return { preventDefault: vi.fn(), dataTransfer: { types, files, dropEffect: "" } } as unknown as DragEvent<HTMLElement>;
}

test("oversized pasted images produce a warning without saving or entering busy state", async () => {
  const view = tray();
  await view.run(api => api.handlePastedImage(new File([new Uint8Array(21 * 1024 * 1024)], "oversize.png", { type: "image/png" })));
  expect(feedback.notice).toHaveBeenCalledWith(expect.objectContaining({ tone: "warning", message: t("chatPage.pastedImageTooLargeSkipped") }));
  expect(view.native.saveScreenshotTemp.mock.calls).toEqual([]);
  expect([view.read().attachments, view.read().attachmentBusy]).toEqual([[], false]);
});
test("ingestion rejection reports the error and leaves an idle empty tray", async () => {
  const view = tray(); view.native.ingestDroppedFiles.mockRejectedValue(Error("import pipeline unavailable"));
  await view.run(api => api.chooseFiles([image("broken.png")]));
  expect(feedback.notice).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", message: expect.stringContaining("import pipeline unavailable") }));
  expect([view.read().attachments, view.read().attachmentBusy]).toEqual([[], false]);
});
test("pasted images retain their filename, MIME, saved path and generated preview", async () => {
  const view = tray(); view.native.saveScreenshotTemp.mockResolvedValue({ filePath: "C:/capture/pasted.png" });
  await view.run(api => api.handlePastedImage(image("clipboard.png")));
  expect(view.read().attachments).toEqual([expect.objectContaining({ kind: "image", name: "clipboard.png", mime: "image/png", filePath: "C:/capture/pasted.png", previewUrl: "blob:preview-1" })]);
  expect(view.read().attachmentBusy).toBe(false);
});
test("only image imports receive object previews and returned attachment order is retained", async () => {
  const view = tray(); const document = { kind: "document", name: "manifest.txt" };
  view.native.ingestDroppedFiles.mockResolvedValue([{ kind: "image", name: "scan.png" }, document]);
  await view.run(api => api.chooseFiles([image("scan.png"), new File(["notes"], "notes.txt", { type: "text/plain" })]));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(view.read().attachments).toEqual([{ kind: "image", name: "scan.png", previewUrl: "blob:preview-1" }, document]);
  expect(view.read().attachments[1].previewUrl).toBeUndefined();
});
test("busy remains set until the asynchronous import settles", async () => {
  const view = tray(); let finish!: (rows: ComposerAttachment[]) => void;
  view.native.ingestDroppedFiles.mockImplementation(() => new Promise<ComposerAttachment[]>(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = view.read().chooseFiles([image("pending.png")]); });
  expect(view.read().attachmentBusy).toBe(true);
  await view.run(async () => { finish([]); await pending; });
  expect(view.read().attachmentBusy).toBe(false);
});
test("direct image delivery uses one patch and bypasses captioning", async () => {
  const view = tray(); view.native.getImageSendStrategy.mockResolvedValue({ mode: "direct" });
  const rows: ComposerAttachment[] = [{ kind: "image", name: "direct.png", filePath: "direct.png" }, { kind: "document", name: "keep.txt" }];
  await view.run(api => api.prepareImageAttachments("delivery-session", "delivery-message", rows));
  expect(view.native.captionImage.mock.calls).toEqual([]); expect(view.patch).toHaveBeenCalledTimes(1);
  const [session, message, apply] = view.patch.mock.calls[0];
  expect([session, message]).toEqual(["delivery-session", "delivery-message"]);
  expect(apply(rows)).toEqual([{ ...rows[0], imageSendMode: "direct", status: "done" }, rows[1]]);
});
test("caption delivery patches each image through processing and its individual terminal state", async () => {
  const view = tray(); view.native.getImageSendStrategy.mockResolvedValue({ mode: "caption" });
  view.native.captionImage.mockResolvedValueOnce({ ok: true, caption: "A copper telescope" }).mockResolvedValueOnce({ ok: false });
  const rows: ComposerAttachment[] = [{ kind: "image", name: "first.png", filePath: "first.png" }, { kind: "image", name: "second.png", filePath: "second.png" }];
  await view.run(api => api.prepareImageAttachments("delivery-session", "delivery-message", rows));
  expect(view.patch).toHaveBeenCalledTimes(4);
  const states = view.patch.mock.calls.map(([, , apply], index) => apply(rows)[Math.floor(index / 2)]);
  expect(states).toEqual([
    { ...rows[0], status: "processing", imageSendMode: "caption" },
    { ...rows[0], status: "done", imageSendMode: "caption", caption: "A copper telescope", reason: undefined },
    { ...rows[1], status: "processing", imageSendMode: "caption" },
    { ...rows[1], status: "error", imageSendMode: "caption", reason: t("chatPage.imageCaptionFailed") },
  ]);
});
test("nested file drags remain highlighted until their final leave and dropping resets depth", async () => {
  const view = tray(); const dispatch = (name: keyof ComposerAttachmentsApi["dragHandlers"], event = drag(["Files"])) => act(() => view.read().dragHandlers[name](event));
  dispatch("onDragEnter"); dispatch("onDragEnter"); expect(view.read().isDraggingFiles).toBe(true);
  dispatch("onDragLeave"); expect(view.read().isDraggingFiles).toBe(true);
  dispatch("onDragLeave"); expect(view.read().isDraggingFiles).toBe(false);
  dispatch("onDragEnter", drag(["text/plain"])); expect(view.read().isDraggingFiles).toBe(false);
  const hovering = drag(["Files"]); dispatch("onDragOver", hovering); expect(hovering.preventDefault).toHaveBeenCalled();
  dispatch("onDragEnter"); await view.run(api => api.dragHandlers.onDrop(drag(["Files"], [image("drop.png")])));
  expect(view.read().isDraggingFiles).toBe(false);
});
test("screenshot insertions follow active scope while removal, clearing and unrelated deletion stay scoped", async () => {
  const view = tray(); expect(view.native.onScreenshotInsert).toHaveBeenCalledTimes(1);
  view.capture("hidden.png", true); expect(view.read().attachments).toEqual([]);
  view.select(); view.capture("visible.png");
  expect(view.read().attachments).toEqual([expect.objectContaining({ filePath: "visible.png", previewUrl: "preview:visible.png", hasAnnotations: false })]);
  await view.run(api => api.removeAttachment(0)); expect(view.read().attachments).toEqual([]);
  view.capture("clear.png"); await view.run(api => api.clearScopeAttachments(api.attachments.map(row => ({ ...row }))));
  expect(view.read().attachments).toEqual([]);
  view.capture("remain.png"); await view.run(api => api.deleteScopeAttachments("mode:chat"));
  expect(view.read().attachments).toHaveLength(1);
});
test("a sent snapshot removes only submitted attachments and preserves later additions", async () => {
  const view = tray(); view.select(); view.capture("sent-one.png"); view.capture("sent-two.png");
  const submitted = view.read().attachments.map(row => ({ ...row })); view.capture("added-later.png");
  expect(view.read().attachments).toHaveLength(3);
  await view.run(api => api.clearScopeAttachments(submitted));
  expect(view.read().attachments).toEqual([expect.objectContaining({ filePath: "added-later.png" })]);
});
test("an empty sent snapshot preserves the full ordered list added during dispatch", async () => {
  const view = tray(); view.select(); const submitted: ComposerAttachment[] = [];
  view.capture("later-one.png"); view.capture("later-two.png"); await view.run(api => api.clearScopeAttachments(submitted));
  expect(view.read().attachments).toHaveLength(2);
  expect(view.read().attachments.map(row => row.filePath)).toEqual(["later-one.png", "later-two.png"]);
});
test("unmount revokes every object URL created for imports", async () => {
  const view = tray(); view.native.ingestDroppedFiles.mockResolvedValue([{ kind: "image", name: "owned.png" }]);
  await view.run(api => api.chooseFiles([image("owned.png")])); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
});
