// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// Only the browser's attachment flag matters here: record what the inspector hands the browser workspace.
let lastActive: boolean | undefined;
vi.mock("../workspace/BrowserWorkspaceTabs", () => ({
  BrowserWorkspaceTabs: ({ active }: { active: boolean }) => { lastActive = active; return null; },
}));
vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));
vi.mock("./ReviewInspector", () => ({ ReviewDiffContent: () => null }));
vi.mock("./FileTreePanel", () => ({ FileTreePanel: () => null }));

import { ChatPageInspector } from "./ChatPageInspector";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps the tiled browser's page attached while another panel has focus", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const props = {
    sessionId: "session-a", browserTabOpen: true, filesTabOpen: true, workspaceRoot: "E:/fixture",
    fileTabs: [], diffTabs: [], activePlan: null, planDrawerOpen: false,
    planTabId: "plan:session-a", onTabChange: () => undefined, onCloseTab: () => undefined, onOpenFile: () => undefined,
  };
  act(() => root.render(createElement(ChatPageInspector, { ...props, activeTabId: "browser" })));
  // Let the dock's width animation settle; the page is detached only while the dock is moving.
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(lastActive).toBe(true);
  act(() => root.render(createElement(ChatPageInspector, { ...props, activeTabId: "files" })));
  expect(lastActive).toBe(true);
  act(() => root.unmount()); host.remove();
});
