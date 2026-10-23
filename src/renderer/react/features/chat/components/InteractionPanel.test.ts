import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type { AskUserInteraction, PermissionInteraction } from "./run-presentation";

vi.mock("./ChatMessageList", () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement("span", null, content),
}));
import { AskUserPanel, PermissionPanel } from "./InteractionPanel";
afterEach(() => vi.unstubAllGlobals());

test.each([false, true])("adapts a question to fixed-choice=%s without a skip action", (fixed) => {
  vi.stubGlobal("React", React);
  const options = fixed ? [{ id: "proceed", label: "Proceed" }, { id: "stop", label: "Stop" }] : [];
  const interaction: AskUserInteraction = {
    kind: "ask", id: "request-preferences", runId: "active-review", revision: 2,
    responseKind: "submission", question: "Select the next step", options,
    questions: [{ id: "next", question: "Select the next step", options,
      allowCustomInput: !fixed, multiple: false, freeTextPlaceholder: fixed ? undefined : "Describe the next step" }],
  };
  const markup = renderToStaticMarkup(React.createElement(AskUserPanel, { interaction }));
  for (const forbidden of ["忽略", "跳过"]) expect(markup).not.toContain(forbidden);
  if (fixed) {
    expect(markup).toContain('role="radiogroup"');
    expect(markup).not.toContain("其他回答");
    expect(markup).not.toContain("输入你的回答");
  } else {
    expect(markup).toContain("Describe the next step");
    expect(markup).not.toContain('role="radiogroup"');
  }
});

test("attributes delegated approvals while keeping primary-agent approvals unlabelled", () => {
  vi.stubGlobal("React", React);
  const permission: PermissionInteraction = { kind: "permission", id: "permit-edit", toolName: "write_file", summary: "Update guide" };
  const delegated = renderToStaticMarkup(React.createElement(PermissionPanel, { interaction: { ...permission, agentId: "documentation-worker" } }));
  expect(delegated).toContain("来自子任务");
  expect(delegated).toContain("documentation-worker");
  const primary = renderToStaticMarkup(React.createElement(PermissionPanel, { interaction: permission }));
  expect(primary).not.toContain("来自子任务");
});
