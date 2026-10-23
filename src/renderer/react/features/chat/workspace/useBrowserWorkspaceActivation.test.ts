// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserPageDto } from "../../../../../shared/manual-browser";
import { useBrowserWorkspaceActivation } from "./useBrowserWorkspaceActivation";
const dto = (browserId = "b", conversationId = "s", loading = true): BrowserPageDto => ({ browserId, conversationId, requestId: loading ? 1 : 2, closed: false, loading, url: loading ? "" : "https://example.com/", pendingUrl: null, canGoBack: false, canGoForward: false, error: null });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, changed: (dto: BrowserPageDto) => void;
let execute: ReturnType<typeof vi.fn>; const activate = vi.fn();
function Harness({ sessionId }: { sessionId?: string }) { useBrowserWorkspaceActivation(sessionId, activate); return null; }
async function render(sessionId?: string) { await act(async () => root.render(React.createElement(Harness, { sessionId }))); }
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; activate.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); execute = vi.fn(async () => ({ ok: true, value: null })); window.manualBrowser = { execute, onChanged(fn) { changed = fn; return () => {}; } } as never; });
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.manualBrowser; });
it("activates each new Main page once, never reopens on its late load after collapse", async () => {
  await render("s");
  act(() => changed(dto())); expect(activate).toHaveBeenCalledTimes(1);
  act(() => changed(dto("b", "s", false))); expect(activate).toHaveBeenCalledTimes(1);
  act(() => changed({ ...dto(), closed: true })); expect(activate).toHaveBeenCalledTimes(1);
  act(() => changed(dto("next"))); expect(activate).toHaveBeenCalledTimes(2);
  act(() => changed(dto("foreign", "other"))); expect(activate).toHaveBeenCalledTimes(2);
});
it("ignores stale recovery after a current page event and previous-session callbacks", async () => {
  let recover!: (value: unknown) => void; execute.mockImplementation(() => new Promise(resolve => { recover = resolve; }));
  await render("s"); const oldChanged = changed;
  act(() => changed(dto("current")));
  await act(async () => recover({ ok: true, value: dto("old") }));
  expect(activate).toHaveBeenCalledTimes(1);
  await render("other"); act(() => oldChanged(dto("late")));
  expect(activate).toHaveBeenCalledTimes(1);
});
it("recovers the existing page only for the active conversation, with no invented welcome owner", async () => {
  execute.mockResolvedValue({ ok: true, value: dto("restored") });
  await render(); expect(execute).not.toHaveBeenCalled();
  await render("s"); expect(activate).toHaveBeenCalledTimes(1);
  await render("other"); expect(activate).toHaveBeenCalledTimes(1);
});
