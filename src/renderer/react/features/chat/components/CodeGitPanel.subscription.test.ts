// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));
vi.mock("antd", () => ({ Input: () => null, Modal: () => null }));
import { CodeGitPanel } from "./CodeGitPanel";

it("watches the selected session and ignores change events for other sessions", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let receive: ((event: { sessionId: string }) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = {
    getStatus: vi.fn().mockResolvedValue({ state: "unavailable", lines: {}, summary: {}, files: [] }),
    watch: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn((listener) => { receive = listener; return unsubscribe; }),
  };
  Object.defineProperty(window, "codeGit", { configurable: true, value: api });
  const root = createRoot(document.body.appendChild(document.createElement("main")));
  try {
    await React.act(async () => root.render(React.createElement(CodeGitPanel, { sessionId: "first", todoState: null })));
    expect(api.watch).toHaveBeenCalledWith("first");
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    await React.act(async () => { receive?.({ sessionId: "other" }); });
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    await React.act(async () => { receive?.({ sessionId: "first" }); });
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    await React.act(async () => root.render(React.createElement(CodeGitPanel, { sessionId: "second", todoState: null })));
    expect(api.unwatch).toHaveBeenCalledWith("first");
    expect(api.watch).toHaveBeenCalledWith("second");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  } finally {
    await React.act(async () => root.unmount());
    Reflect.deleteProperty(window, "codeGit");
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  }
  expect(api.unwatch).toHaveBeenCalledWith("second");
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});
