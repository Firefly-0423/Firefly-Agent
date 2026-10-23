import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { RunRecoveryNotices } from "./ChatWorkspaceNotices";

const view = (patch: Partial<Parameters<typeof RunRecoveryNotices>[0]>) =>
  renderToStaticMarkup(createElement(RunRecoveryNotices, {
    interruptedRun: null, sessionTakeover: null, isRunning: false,
    onResume: vi.fn(), onTakeover: vi.fn(), ...patch,
  }));

test("shows interrupted progress and a resume control when idle", () => {
  const markup = view({ activeSessionId: "desk-session", interruptedRun: { runId: "interrupted-job", rounds: 3, todoCount: 5 } });
  expect(markup).toContain("已进行 3 轮");
  expect(markup).toContain("继续任务");
});

test("has no takeover warning on the welcome screen or for another session", () => {
  expect(view({})).not.toContain("正在运行的任务");
  expect(view({ activeSessionId: "current", sessionTakeover: { sessionId: "different" } })).toBe("");
});

test("suppresses recovery controls during an active run", () => {
  expect(view({ isRunning: true, interruptedRun: { runId: "paused", rounds: 6, todoCount: 1 } })).toBe("");
});
