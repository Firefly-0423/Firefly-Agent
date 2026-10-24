// @vitest-environment jsdom
import React, { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntry, WorkspaceListResult, WorkspaceReadResult } from "../../../../../shared/workspace-files-types";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("article", null, content),
}));
const highlight = vi.hoisted(() => ({ codeToTokens: vi.fn() }));
vi.mock("shiki", () => ({ createHighlighter: async () => highlight }));

import { FilePreviewContent, FileTreePanel } from "./FileTreePanel";
import { applyUiColors } from "../../../../ui/colors";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const file = (relPath: string): WorkspaceFileEntry => ({ name: relPath.split("/").at(-1)!, relPath, isDir: false });
const directory = (relPath: string): WorkspaceFileEntry => ({ ...file(relPath), isDir: true });
const listing = (...entries: WorkspaceFileEntry[]): WorkspaceListResult => ({ ok: true, entries });
const content = (text: string): WorkspaceReadResult => ({ ok: true, content: text, size: text.length });
let host: HTMLDivElement;
let root: Root;
let list: ReturnType<typeof vi.fn<(session: string, relPath: string) => Promise<WorkspaceListResult>>>;
let read: ReturnType<typeof vi.fn<(session: string, relPath: string) => Promise<WorkspaceReadResult>>>;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
  list = vi.fn(async () => listing());
  read = vi.fn(async () => content("initial"));
  window.workspaceFiles = { list, read };
  highlight.codeToTokens.mockReset().mockImplementation((text: string) => ({
    tokens: text.split("\n").map((line) => [{ content: line, offset: 0, color: "#123456" }]),
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.workspaceFiles;
  applyUiColors(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function renderTree(props: Partial<ComponentProps<typeof FileTreePanel>> & { refreshRevision?: number | string } = {}) {
  await act(async () => root.render(createElement(FileTreePanel, {
    sessionId: "session-1", workspaceRoot: "/workspace", onOpenFile: vi.fn(), ...props,
  })));
}
async function renderPreview(props: Partial<ComponentProps<typeof FilePreviewContent>> & { refreshRevision?: number | string } = {}) {
  await act(async () => root.render(createElement(FilePreviewContent, {
    sessionId: "session-1", relPath: "notes.md", ...props,
  })));
}
function button(label: string) {
  const result = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(result, `expected ${label} button`).not.toBeNull();
  return result!;
}
async function expand(name: string) {
  const title = [...host.querySelectorAll<HTMLElement>(".ant-tree-title")].find((node) => node.textContent === name);
  expect(title, `directory ${name}`).toBeDefined();
  await act(async () => title!.click());
}

describe("workspace file refresh", () => {
  it("does not revive the first root request during StrictMode effect replay", async () => {
    const stale = deferred<WorkspaceListResult>();
    list.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(listing(file("current.txt")));
    await act(async () => root.render(createElement(React.StrictMode, null,
      createElement(FileTreePanel, { sessionId: "session-1", workspaceRoot: "/workspace", onOpenFile: vi.fn() }))));
    expect(host.textContent).toContain("current.txt");
    await act(async () => stale.resolve(listing(file("stale.txt"))));
    expect(host.textContent).toContain("current.txt");
    expect(host.textContent).not.toContain("stale.txt");
  });

  it("keeps directory refresh visible but disabled while a request is pending", async () => {
    const pending = deferred<WorkspaceListResult>();
    list.mockReturnValueOnce(pending.promise);
    await renderTree();
    expect(button("fileTree.refresh").disabled).toBe(true);
    expect(host.textContent).toContain("fileTree.loading");
    await act(async () => pending.resolve(listing()));
    expect(button("fileTree.refresh").disabled).toBe(false);
  });

  it("re-reads the root when refreshRevision changes and replaces deleted entries", async () => {
    list.mockResolvedValueOnce(listing(file("old.txt"))).mockResolvedValueOnce(listing(file("new.txt")));
    await renderTree({ refreshRevision: 0 });
    expect(host.textContent).toContain("old.txt");
    await renderTree({ refreshRevision: 1 });
    expect(host.textContent).toContain("new.txt");
    expect(host.textContent).not.toContain("old.txt");
  });

  it("refreshes expanded descendants and clears their antd loaded cache", async () => {
    let fresh = false;
    list.mockImplementation(async (_session, path) => path === ""
      ? listing(directory("src"))
      : listing(file(fresh ? "src/new.txt" : "src/old.txt")));
    await renderTree({ refreshRevision: 0 });
    await expand("src");
    expect(host.textContent).toContain("old.txt");
    fresh = true;
    await renderTree({ refreshRevision: 1 });
    expect(host.textContent).toContain("new.txt");
    expect(host.textContent).not.toContain("old.txt");
  });

  it.each([listing(), { ok: false, code: "LIST_FAILED" } satisfies WorkspaceListResult])(
    "keeps manual refresh usable after an empty or failed directory read (%j)", async (initial) => {
      list.mockResolvedValueOnce(initial).mockResolvedValueOnce(listing(file("recovered.txt")));
      await renderTree();
      const refresh = button("fileTree.refresh");
      expect(refresh.disabled).toBe(false);
      await act(async () => refresh.click());
      expect(host.textContent).toContain("recovered.txt");
    },
  );

  it("does not query an unbound workspace and explains its disabled refresh", async () => {
    await renderTree({ workspaceRoot: undefined });
    expect(host.textContent).toContain("fileTree.errNoWorkspace");
    expect(button("fileTree.refresh").disabled).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it("discards a late old-session directory expansion and its truncation flag", async () => {
    const oldChildren = deferred<WorkspaceListResult>();
    list.mockImplementation(async (session, path) => {
      if (path === "") return listing(directory("src"));
      return session === "session-1" ? oldChildren.promise : listing(file("src/current.txt"));
    });
    await renderTree();
    await expand("src");
    await renderTree({ sessionId: "session-2" });
    await expand("src");
    expect(host.textContent).toContain("current.txt");
    await act(async () => oldChildren.resolve({ ok: true, entries: [file("src/stale.txt")], truncated: true }));
    expect(host.textContent).toContain("current.txt");
    expect(host.textContent).not.toContain("stale.txt");
    expect(host.textContent).not.toContain("fileTree.truncated");
  });

  it("discards a late root response from an older refresh revision", async () => {
    const stale = deferred<WorkspaceListResult>();
    list.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(listing(file("current.txt")));
    await renderTree({ refreshRevision: 0 });
    await renderTree({ refreshRevision: 1 });
    await act(async () => stale.resolve({ ok: true, entries: [file("stale.txt")], truncated: true }));
    expect(host.textContent).toContain("current.txt");
    expect(host.textContent).not.toContain("stale.txt");
    expect(host.textContent).not.toContain("fileTree.truncated");
  });
});

describe("file preview refresh", () => {
  it("adapts low-contrast syntax to live dark and light colors without rereading the file", async () => {
    highlight.codeToTokens.mockReturnValue({ tokens: [[{ content: "console.log", offset: 0, color: "#24292e" }]] });
    applyUiColors({ enabled: true, background: "#121212", foreground: "#ffffff" });
    await renderPreview({ relPath: "app.ts" });
    const token = () => host.querySelector<HTMLElement>(".ff-file-preview__text span")!;
    expect(token().style.color).toBe("rgb(255, 255, 255)");
    await act(async () => applyUiColors({ enabled: true, background: "#ffffff", foreground: "#0d0d0d" }));
    expect(token().style.color).toBe("rgb(36, 41, 46)");
    await act(async () => applyUiColors(undefined));
    expect(token().style.color).toBe("rgb(36, 41, 46)");
    expect(read).toHaveBeenCalledOnce();
    expect(highlight.codeToTokens).toHaveBeenCalledOnce();
  });

  it("retains readable syntax accents and falls back only when their contrast is low", async () => {
    highlight.codeToTokens.mockReturnValue({ tokens: [[{ content: "literal", offset: 0, color: "#ffcc00" }]] });
    applyUiColors({ enabled: true, background: "#121212", foreground: "#ffffff" });
    await renderPreview({ relPath: "app.ts" });
    const token = () => host.querySelector<HTMLElement>(".ff-file-preview__text span")!;
    expect(token().style.color).toBe("rgb(255, 204, 0)");
    await act(async () => applyUiColors({ enabled: true, background: "#ffffff", foreground: "#0d0d0d" }));
    expect(token().style.color).toBe("rgb(13, 13, 13)");
    await act(async () => applyUiColors(undefined));
    expect(token().style.color).toBe("rgb(255, 204, 0)");
    expect(read).toHaveBeenCalledOnce();
  });

  it("disconnects the custom-color observer when a preview is closed", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    await renderPreview({ relPath: "app.ts" });
    expect(observe).toHaveBeenCalledWith(document.documentElement, { attributes: true, attributeFilter: ["data-ui-colors"] });
    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps preview refresh visible but disabled while a read is pending", async () => {
    const pending = deferred<WorkspaceReadResult>();
    read.mockReturnValueOnce(pending.promise);
    await renderPreview();
    expect(button("fileTree.refreshPreview").disabled).toBe(true);
    expect(host.textContent).toContain("fileTree.previewLoading");
    await act(async () => pending.resolve(content("")));
    expect(button("fileTree.refreshPreview").disabled).toBe(false);
    expect(host.querySelector("article")?.textContent).toBe("");
  });

  it("discards a read from the previous session", async () => {
    const stale = deferred<WorkspaceReadResult>();
    read.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(content("current session"));
    await renderPreview();
    await renderPreview({ sessionId: "session-2" });
    await act(async () => stale.resolve(content("old session")));
    expect(host.textContent).toContain("current session");
    expect(host.textContent).not.toContain("old session");
  });

  it("refreshes read content and highlighting without resetting the selected Markdown view", async () => {
    read.mockResolvedValueOnce(content("# Before")).mockResolvedValueOnce(content("# After"));
    await renderPreview({ refreshRevision: 0 });
    await act(async () => button("fileTree.viewSource").click());
    await renderPreview({ refreshRevision: 1 });
    expect(host.querySelector(".ff-file-preview__code")?.textContent).toContain("# After");
    expect(host.querySelector("article")).toBeNull();
    expect(host.querySelector(".ff-file-preview__text span")?.getAttribute("style")).toContain("rgb(18, 52, 86)");
  });

  it("keeps its refresh button and chosen view after a read failure", async () => {
    read.mockResolvedValueOnce(content("# Before"))
      .mockResolvedValueOnce({ ok: false, code: "NOT_FOUND" })
      .mockResolvedValueOnce(content("# Recovered"));
    await renderPreview();
    await act(async () => button("fileTree.viewSource").click());
    await act(async () => button("fileTree.refreshPreview").click());
    expect(host.textContent).toContain("fileTree.errNotFound");
    expect(button("fileTree.refreshPreview").disabled).toBe(false);
    await act(async () => button("fileTree.refreshPreview").click());
    expect(host.querySelector(".ff-file-preview__code")?.textContent).toContain("# Recovered");
  });

  it("ignores late read content from an older revision", async () => {
    const stale = deferred<WorkspaceReadResult>();
    read.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(content("current"));
    await renderPreview({ refreshRevision: "old" });
    await renderPreview({ refreshRevision: "new" });
    await act(async () => stale.resolve(content("stale")));
    expect(host.textContent).toContain("current");
    expect(host.textContent).not.toContain("stale");
  });

  it("ignores late highlighting from an older read after refresh", async () => {
    const stale = deferred<{ tokens: { content: string; offset: number }[][] }>();
    highlight.codeToTokens.mockReturnValueOnce(stale.promise);
    read.mockResolvedValueOnce(content("old"));
    await renderPreview({ refreshRevision: 0 });
    await act(async () => button("fileTree.viewSource").click());
    read.mockResolvedValueOnce(content("current"));
    await renderPreview({ refreshRevision: 1 });
    await act(async () => stale.resolve({ tokens: [[{ content: "stale highlight", offset: 0 }]] }));
    expect(host.textContent).toContain("current");
    expect(host.textContent).not.toContain("stale highlight");
  });
});
