import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./PlanReviewPanel", () => ({ PlanContent: () => null, planTabDotClass: () => "is-review", planTabLabel: () => "Review pending" }));
vi.mock("./ReviewInspector", () => ({ ReviewDiffContent: () => null }));
vi.mock("./ChatMessageList", () => ({ MarkdownContent: ({ content }: { content: string }) => createElement("p", null, content) }));
import { ChatPageInspector, type ChatPageInspectorProps } from "./ChatPageInspector";

const display = (patch: Partial<ChatPageInspectorProps>) => renderToStaticMarkup(createElement(ChatPageInspector, {
  filesTabOpen: false, fileTabs: [], diffTabs: [], activePlan: null, planDrawerOpen: false,
  planTabId: "plan:inspection", activeTabId: null, onTabChange: vi.fn(), onCloseTab: vi.fn(), onOpenFile: vi.fn(), ...patch,
}));

test("omits the workspace pane when no tab is available", () => expect(display({})).toBe(""));

test.each([undefined, "inspection-session"])("offers browser navigation without embedding a page for session %s", (sessionId) => {
  const html = display({ sessionId, browserTabOpen: true, activeTabId: "browser" });
  expect(html).not.toMatch(/<(iframe|webview)\b/);
  expect(html.match(/<aside\b/g) ?? []).toStrictEqual(["<aside"]);
  for (const required of ['inputMode="url"', 'class="ff-inspector-pane"']) {
    expect(html).toContain(required);
  }
});

test("offers workspace selection in the file tab before a session is created", () => {
  const html = display({ filesTabOpen: true, activeTabId: "files", onChooseWorkspace: vi.fn() });
  for (const required of ['class="ff-inspector-pane"', 'class="ff-workspace-empty"', 'data-workspace-choose="true"']) {
    expect(html).toContain(required);
  }
  const selected = display({ filesTabOpen: true, activeTabId: "files", pendingWorkspaceName: "Documentation vault" });
  expect(selected).toContain("Documentation vault");
  expect(selected).not.toContain("{name}");
});

test("hosts supplied task content inside the right inspector", () => {
  const html = display({ tasksTabOpen: true, activeTabId: "tasks",
    taskPanel: createElement("output", { "data-review-task": "current" }, "Review") });
  expect(html).toContain('data-review-task="current"');
  expect(html).toContain('class="ff-right-inspector');
});

test.each([false, true])("offers pane close only for a sole browser tab; files=%s", (filesTabOpen) => {
  const html = display({ browserTabOpen: true, activeTabId: "browser", filesTabOpen });
  if (filesTabOpen) {
    expect(html).not.toContain("is-browser-only");
    expect(html).not.toContain("data-browser-close-pane");
  } else {
    expect(html).toContain("is-browser-only");
    expect(html).toContain("data-browser-close-pane");
  }
});
