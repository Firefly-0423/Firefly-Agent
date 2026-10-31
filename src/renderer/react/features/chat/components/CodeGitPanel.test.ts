// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));
vi.mock("antd", () => ({
  Input: () => null,
  Modal: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? React.createElement("section", { role: "dialog", "aria-label": title }, children) : null,
}));
import { CodeGitPanel } from "./CodeGitPanel";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
const render = (props: Partial<React.ComponentProps<typeof CodeGitPanel>>) => {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(CodeGitPanel, { sessionId: "git-session", todoState: null, ...props }));
};

test("places plan approval after the task list and keeps the Git controls visible", () => {
  const html = render({ projectName: "Documentation studio", planPhase: "review", onOpenPlan: vi.fn(),
    todoState: { updatedAt: 70, todos: [{ id: "review-docs", content: "Review the guide", status: "pending" }] } });
  document.body.innerHTML = html;
  for (const text of ["Coding", "Documentation studio", "分支切换", "提交或推送", "Review the guide"]) expect(html).toContain(text);
  const tasks = document.querySelector('[data-testid="code-todo-list"]')!;
  const plan = document.querySelector('[data-testid="code-plan-status"]')!;
  expect(tasks.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(plan.textContent).toContain("计划待审批 · 点击查看");
  expect(plan.querySelector(".ff-plan-entry")).not.toBeNull();
  expect(plan.querySelector(".ff-plan-control")).toBeNull();
  expect(html).not.toContain(">审阅<");
});

test("leaves the task list out when docked in the Code pane", () => {
  const html = render({ docked: true, expanded: true,
    todoState: { updatedAt: 70, todos: [{ id: "review-docs", content: "Review the guide", status: "pending" }] } });
  expect(html).not.toContain("code-todo-list");
  expect(html).not.toContain("Review the guide");
});

test("makes docked collapsed actions inert without offscreen positioning", () => {
  const html = render({ docked: true });
  for (const marker of ["ff-code-git--docked", 'aria-expanded="false"', 'inert=""']) expect(html).toContain(marker);
  expect(html).not.toContain('style="left:');
});

test("opens branch actions in an application dialog without native prompt", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const prompt = vi.spyOn(window, "prompt");
  const api = { getStatus: vi.fn().mockResolvedValue({
    sessionId: "git-session", state: "ready", branch: { current: "topic", branches: ["topic", "trunk"] },
    lines: { insertions: 0, deletions: 0 }, summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
    files: [], ahead: 0, behind: 0,
  }), watch: vi.fn().mockResolvedValue(undefined), unwatch: vi.fn().mockResolvedValue(undefined), onChanged: vi.fn(() => vi.fn()) };
  Object.defineProperty(window, "codeGit", { configurable: true, value: api });
  const host = document.body.appendChild(document.createElement("main"));
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(CodeGitPanel, { sessionId: "git-session", todoState: null })));
    const switchButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("分支切换"))!;
    await React.act(async () => switchButton.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  } finally { await React.act(async () => root.unmount()); prompt.mockRestore(); Reflect.deleteProperty(window, "codeGit"); }
});
