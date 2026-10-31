// @vitest-environment jsdom
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./ModelEffortControl", () => ({ ModelEffortControl: () => null }));
vi.mock("./DesktopAsrButton", () => ({ DesktopAsrButton: () => null }));
vi.mock("./PermissionControl", () => ({ PermissionControl: () => null }));
vi.mock("./ContextUsageRing", () => ({ ContextUsageRing: () => null }));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (asset: string) => asset }));
import { ChatComposer } from "./ChatComposer";
import { t } from "../../../i18n";

let root: Root, host: HTMLElement;
type Props = React.ComponentProps<typeof ChatComposer>;
let settings: Partial<Props>;
const actions = {
  send: vi.fn(), queue: vi.fn(), stop: vi.fn(), remove: vi.fn(),
  edit: vi.fn().mockResolvedValue(true), adjust: vi.fn().mockResolvedValue(true),
};
beforeEach(() => {
  Object.values(actions).forEach(mock => mock.mockClear());
  vi.stubGlobal("React", React);
  vi.stubGlobal("chat", { getEnabledStickers: vi.fn().mockResolvedValue([]) });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("main"));
  root = createRoot(host);
  settings = {};
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function Controlled() {
  const [draft, change] = React.useState("");
  return React.createElement(ChatComposer, {
    mode: "chat", docked: true, attachments: [], modelBusy: false, ...settings,
    value: draft, onChange: change, onSubmit: actions.send, onQueueMessage: actions.queue, onCancel: actions.stop,
    onRemoveQueuedMessage: actions.remove, onEditQueuedMessage: actions.edit, onAdjustQueuedMessage: actions.adjust,
    onChooseWorkspace: vi.fn(), onChooseFiles: vi.fn(), onRemoveAttachment: vi.fn(), onScreenshot: vi.fn(), onChooseSticker: vi.fn(),
  });
}
async function update(patch: Partial<Props> = {}) {
  Object.assign(settings, patch);
  await React.act(async () => root.render(React.createElement(Controlled)));
}
const editor = () => host.querySelector("textarea")!;
const labelled = (label: string, scope: ParentNode = host) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === label);
async function type(node: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enter(extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...extra });
  await React.act(async () => editor().dispatchEvent(event));
  return event;
}

test.each([false, true])("routes plain Enter according to busy=%s with an editable draft", async (busy) => {
  await update({ modelBusy: busy });
  expect(editor().disabled).toBe(false);
  // The Firefly prompt stays while a run is busy; Enter queues instead of sending.
  if (busy) expect(editor().placeholder).not.toContain("Enter");
  await type(editor(), "Inspect release notes");
  expect(editor().value).toBe("Inspect release notes");
  await enter();
  expect((busy ? actions.queue : actions.send).mock.calls).toStrictEqual([["Inspect release notes"]]);
  expect(busy ? actions.send : actions.queue).not.toHaveBeenCalled();
  expect(actions.stop).not.toHaveBeenCalled();
});

test("sends from the built-in idle send button", async () => {
  await update();
  await type(editor(), "Publish the summary");
  const send = Array.from(host.querySelectorAll("button")).find(button => button.querySelector(".anticon-arrow-up"));
  expect(send).toBeTruthy();
  await React.act(async () => send!.click());
  expect(actions.send.mock.calls).toStrictEqual([["Publish the summary"]]);
});

test("keeps stop enabled and has no separate queue-send button during a run", async () => {
  await update({ modelBusy: true });
  await type(editor(), "Pending followup");
  expect(labelled(t("composer.queueSend"))).toBeUndefined();
  const stop = labelled(t("composer.stopRun"));
  expect(stop).toBeTruthy();
  expect(stop!.disabled).toBe(false);
  expect(actions.queue).not.toHaveBeenCalled();
  expect(actions.send).not.toHaveBeenCalled();
  await React.act(async () => stop!.click());
  expect(actions.stop).toHaveBeenCalledTimes(1);
  expect(actions.queue).not.toHaveBeenCalled();
});

test.each([false, true])("allows Shift+Enter without sending, queueing or cancellation; busy=%s", async (modelBusy) => {
  await update({ modelBusy });
  await type(editor(), "Multiline draft");
  const event = await enter({ shiftKey: true });
  expect(event.defaultPrevented).toBe(false);
  for (const mock of [actions.send, actions.queue, actions.stop]) expect(mock).not.toHaveBeenCalled();
});

test("ignores Ctrl+Enter, empty drafts and IME confirmation until composition ends", async () => {
  await update();
  await enter();
  expect(actions.send).not.toHaveBeenCalled();
  await type(editor(), "Modified shortcut");
  await enter({ ctrlKey: true });
  expect(actions.send).not.toHaveBeenCalled();
  await update({ modelBusy: true });
  await type(editor(), "pinyin");
  await React.act(async () => editor().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await enter();
  expect(actions.queue).not.toHaveBeenCalled();
  await React.act(async () => editor().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await enter();
  expect(actions.queue.mock.calls).toStrictEqual([["pinyin"]]);
});

test("returns a finished Work run to idle without replacing the editor", async () => {
  await update({ mode: "work", workspaceName: "Report workspace", modelBusy: true });
  const original = editor();
  expect(original.placeholder).toBe(t("composer.placeholderTask"));
  expect(labelled(t("composer.stopRun"))).toBeTruthy();
  await update({ modelBusy: false });
  expect(editor()).toBe(original);
  expect(original.placeholder).toBe(t("composer.placeholderTask"));
  expect(original.disabled).toBe(false);
  expect(labelled(t("composer.stopRun"))).toBeUndefined();
  await type(original, "Review another section");
  await enter();
  expect(actions.send).toHaveBeenCalledExactlyOnceWith("Review another section");
  expect(actions.queue).not.toHaveBeenCalled();
});

test("retains a long Work draft and keyboard access to stop as a run starts", async () => {
  await update({ mode: "work", workspaceName: "Report workspace" });
  const original = editor(), draft = "Review another paragraph\n".repeat(14);
  await type(original, draft);
  await update({ modelBusy: true });
  expect(editor()).toBe(original);
  expect(editor().value).toBe(draft);
  const stop = labelled(t("composer.stopRun"))!;
  expect(stop.disabled).toBe(false);
  stop.focus();
  expect(document.activeElement).toBe(stop);
  await React.act(async () => stop.click());
  expect(actions.stop).toHaveBeenCalledTimes(1);
  expect(actions.send).not.toHaveBeenCalled();
});

test("lists queued messages above the composer in order and removes by identity", async () => {
  await update({ modelBusy: true, pendingQueue: [
    { id: "queued-review", content: "Review the guide" }, { id: "queued-export", content: "Export the result" },
  ] });
  const dock = host.querySelector(".ff-queue-dock")!, shell = host.querySelector(".ff-composer-shell")!;
  expect(dock.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await React.act(async () => (dock.querySelector(".ff-queue-dock__header") as HTMLButtonElement).click());
  const rows = Array.from(host.querySelectorAll(".ff-queue-dock__row"));
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.textContent)).toEqual([
    expect.stringContaining("Review the guide"), expect.stringContaining("Export the result"),
  ]);
  await React.act(async () => labelled(t("composer.removeQueuedMessage"))!.click());
  expect(actions.remove.mock.calls).toStrictEqual([["queued-review"]]);
});

test("edits and adjusts queued content while attachments and upload remain available", async () => {
  await update({ modelBusy: true, pendingQueue: [{ id: "queued-draft", content: "Draft notes", attachmentCount: 2 }],
    attachments: [{ kind: "document", name: "notes.md" }] });
  await React.act(async () => labelled(t("composer.queueEdit"))!.click());
  await type(host.querySelector<HTMLInputElement>(".ff-queue-dock__editor")!, "Revised notes");
  await React.act(async () => labelled(t("composer.queueSave"))!.click());
  expect(actions.edit.mock.calls).toStrictEqual([["queued-draft", "Revised notes"]]);
  await React.act(async () => labelled(t("composer.queueAdjust"))!.click());
  expect(actions.adjust.mock.calls).toStrictEqual([["queued-draft"]]);
  expect(host.querySelector(".ff-composer__attachment")?.textContent).toContain("notes.md");
  const add = labelled(t("composer.addMenuTitle"))!;
  expect(add.disabled).toBe(false);
  await React.act(async () => add.click());
  const upload = labelled(t("composer.uploadFile"), document.body);
  expect(upload).toBeTruthy();
  expect(upload!.disabled).toBe(false);
});
