// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BROWSER_PUBLIC_SCOPE, type ManualBrowserCommand } from "../../../../../shared/manual-browser";
vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));
vi.mock("shiki", () => ({ createHighlighter: async () => ({ codeToTokens: (text: string) => ({ tokens: text.split("\n").map(content => [{ content, offset: 0 }]) }) }) }));
vi.mock("./PlanReviewPanel", () => ({ PlanContent: () => null, planTabDotClass: () => "", planTabLabel: () => "plan" }));
vi.mock("./ReviewInspector", () => ({ ReviewDiffContent: () => null }));
import { ChatPageInspector, type ChatPageInspectorProps } from "./ChatPageInspector";
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, execute: ReturnType<typeof vi.fn>;
const props: ChatPageInspectorProps = { sessionId: "s", browserTabOpen: true, filesTabOpen: false, fileTabs: [], diffTabs: [], activePlan: null, planDrawerOpen: false, planTabId: "plan:s", activeTabId: "browser", onTabChange: vi.fn(), onCloseTab: vi.fn(), onOpenFile: vi.fn() };
/** Longer than the 220ms pane motion, so the settled state is observed. */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
beforeEach(() => {
  vi.stubGlobal("React", React);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 300, y: 80, left: 300, top: 80, width: 400, height: 300, right: 700, bottom: 380, toJSON() {} });
  execute = vi.fn(async (c: ManualBrowserCommand) => ({ ok: true, value: c.kind === "get" ? { browserId: "b", conversationId: "s", requestId: 1, closed: false, loading: false, url: "https://example.com/", pendingUrl: null, canGoBack: false, canGoForward: false, error: null } : null }));
  window.manualBrowser = { execute, onChanged() { return () => {}; }, getAvailability: async () => ({ available: true }), getPermission: async () => ({ ok: true, value: { conversationId: "s", status: "granted", scope: BROWSER_PUBLIC_SCOPE, requestId: null } }), requestPermission: vi.fn(), revokePermission: vi.fn(async () => ({ ok: true, value: { conversationId: "s", status: "required", scope: BROWSER_PUBLIC_SCOPE, requestId: null } })) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.manualBrowser; delete window.workspaceFiles; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(extra: Partial<ChatPageInspectorProps> = {}) { await act(async () => root.render(React.createElement(ChatPageInspector, { ...props, ...extra }))); }
it("hides the inspector without disposing its browser and resumes the same page on expand", async () => {
  await render(); const input = host.querySelector("input");
  await render({ visible: false });
  await settle();
  expect(host.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector("input")).toBe(input);
  expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "b", bounds: null });
  expect(execute.mock.calls.some(([c]) => c.kind === "close")).toBe(false);
  await render({ visible: true }); expect(host.querySelector("input")).toBe(input);
  expect(host.querySelector("aside")!.hasAttribute("hidden")).toBe(false);
});
it("fades the closing pane out while its width moves, and settles the motion afterwards", async () => {
  await render(); await settle();
  await render({ visible: false });
  // The hidden state is immediate; CSS keeps the pane painted until the width motion ends.
  expect(host.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector(".ff-chat-inspector")!.classList.contains("is-closed")).toBe(true);
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("inert")).toBe(true);
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(true);
  await settle();
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(false);
  expect(host.querySelector(".ff-chat-inspector")!.classList.contains("is-closed")).toBe(true);
});
it("keeps the native page detached while the pane opens and reattaches it once the width has settled", async () => {
  await render({ visible: false }); await settle();
  execute.mockClear();
  await render({ visible: true });
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(true);
  expect(execute.mock.calls.some(([c]) => c.kind === "layout" && c.bounds !== null)).toBe(false);
  await settle();
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(false);
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "layout", browserId: "b", bounds: expect.any(Object) }));
});
it("skips the motion and the delay under reduced motion", async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addListener() {}, removeListener() {} });
  await render(); await render({ visible: false });
  expect(host.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(false);
  expect(host.querySelector(".ff-chat-inspector")!.classList.contains("is-closed")).toBe(true);
});
it("does not show the content for a pane that starts closed", async () => {
  await render({ visible: false });
  expect(host.querySelector("aside")!.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector(".ff-chat-inspector")!.hasAttribute("data-dock-motion")).toBe(false);
});
it("mounts a nonactive browser for Main recovery without drawing it over another tab", async () => {
  await render({ filesTabOpen: true, activeTabId: "files" });
  expect(execute).toHaveBeenCalledWith({ kind: "get" });
  expect(execute).toHaveBeenCalledWith({ kind: "layout", browserId: "b", bounds: null });
  expect(execute.mock.calls.some(([c]) => c.kind === "layout" && c.bounds !== null)).toBe(false);
});

it("keeps a dirty file mounted beside browser/task/diff panes and guards keyboard close", async () => {
  window.workspaceFiles = { list: vi.fn(), read: vi.fn().mockResolvedValue({ ok: true, content: "original", size: 8, editVersion: "a".repeat(64) }), save: vi.fn() };
  const onCloseTab = vi.fn();
  const fileId = "file:coexist/notes.md";
  const extra: Partial<ChatPageInspectorProps> = { sessionId: "coexist", workspaceRoot: "/synthetic", activeTabId: fileId, fileTabs: [{ id: fileId, relPath: "coexist/notes.md" }], tasksTabOpen: true, taskPanel: React.createElement("div", { "data-task-content": true }, "Task"), diffTabs: [{ id: "diff:a", runId: "r", fileIndex: 0, filePath: "coexist/notes.md" }], onCloseTab };
  await render(extra);
  await act(async () => host.querySelector<HTMLButtonElement>(".ff-file-editor__toolbar button")!.click());
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "unsaved notes");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector('[data-inspector-dirty="true"]')).not.toBeNull();
  await render({ ...extra, activeTabId: "tasks" });
  expect(host.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("unsaved notes");
  expect(host.querySelector('[data-task-content]')).not.toBeNull();
  await render(extra);
  const fileTab = Array.from(host.querySelectorAll<HTMLElement>(".ff-inspector-pane__head")).find(head => head.textContent?.includes("notes.md"))!;
  await act(async () => fileTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
  expect(onCloseTab).not.toHaveBeenCalled();
  expect(host.querySelector(".ff-file-editor__decision")).not.toBeNull();
  expect(textarea.value).toBe("unsaved notes");
  const decisions = host.querySelectorAll<HTMLButtonElement>(".ff-file-editor__decision button");
  await act(async () => decisions[1]!.click());
  expect(onCloseTab).toHaveBeenCalledExactlyOnceWith(fileId);
});

it("routes the outer browser tab close through confirmed Main cleanup and keeps failures visible", async () => {
  let finish!: (value: unknown) => void;
  const onCloseTab = vi.fn();
  const revoke = vi.fn().mockResolvedValue({ ok: false, code: "cleanup_failed" }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  window.manualBrowser!.revokePermission = revoke;
  await render({ onCloseTab });
  await act(async () => host.querySelector<HTMLButtonElement>(".ff-right-inspector__close")!.click());
  expect(onCloseTab).not.toHaveBeenCalled();
  expect(host.querySelector(".ff-browser-tab")).not.toBeNull();
  await act(async () => finish({ ok: false, code: "cleanup_failed" }));
  expect(onCloseTab).not.toHaveBeenCalled();
  expect(host.querySelector(".ff-browser-workspace__notice")?.textContent).toMatch(/清理|cleanup/);
  await act(async () => host.querySelector<HTMLButtonElement>(".ff-right-inspector__close")!.click());
  expect(onCloseTab).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("s");
  expect(host.querySelector(".ff-browser-workspace__notice")?.textContent).toMatch(/手动重启|restart.*manually/i);
});

it("marks a browser-only pane and closes it from the browser's own strip through Main cleanup", async () => {
  const onCloseTab = vi.fn();
  const revoke = vi.fn(async () => ({ ok: true, value: { conversationId: "s", status: "required", scope: BROWSER_PUBLIC_SCOPE, requestId: null } }));
  window.manualBrowser!.revokePermission = revoke;
  await render({ onCloseTab });
  expect(host.querySelector(".ff-chat-inspector")!.classList.contains("is-browser-only")).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-close-pane]")!.click());
  expect(revoke).toHaveBeenCalledExactlyOnceWith("s");
  expect(onCloseTab).toHaveBeenCalledExactlyOnceWith("browser");
});

it("keeps panel headers when another panel shares the inspector", async () => {
  await render({ filesTabOpen: true, activeTabId: "browser" });
  expect(host.querySelector(".ff-chat-inspector")!.classList.contains("is-browser-only")).toBe(false);
  expect(host.querySelector("[data-browser-close-pane]")).toBeNull();
  expect(host.querySelectorAll(".ff-inspector-pane__head")).toHaveLength(2);
});
