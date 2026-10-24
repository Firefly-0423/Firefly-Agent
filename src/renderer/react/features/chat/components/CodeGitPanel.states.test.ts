// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ChatMessageList", () => ({ MarkdownContent: () => null }));

import { CodeGitPanel } from "./CodeGitPanel";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let rejectStatus: (reason?: unknown) => void;
const getStatus = vi.fn();
const refresh = () => host.querySelector<HTMLButtonElement>(".ff-code-git__refresh")!;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  getStatus.mockReset();
  getStatus.mockImplementation(() => new Promise((_resolve, reject) => { rejectStatus = reject; }));
  (window as Window & { codeGit?: unknown }).codeGit = {
    getStatus,
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    switchBranch: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as Window & { codeGit?: unknown }).codeGit;
  vi.unstubAllGlobals();
});

describe("CodeGitPanel refresh button states", () => {
  const mount = () => act(async () => root.render(React.createElement(CodeGitPanel, { sessionId: "s1", projectName: "firefly-project", todoState: null })));

  it("is a shared icon button with an accessible name", async () => {
    await mount();
    expect(refresh().classList.contains("ff-btn")).toBe(true);
    expect(refresh().classList.contains("ff-btn--icon")).toBe(true);
    expect(refresh().getAttribute("aria-label")).toBeTruthy();
  });

  it("shows a busy spinner and ignores clicks while the status is loading, without becoming disabled", async () => {
    await mount();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(refresh().getAttribute("aria-busy")).toBe("true");
    expect(refresh().disabled).toBe(false);
    expect(refresh().querySelector(".ff-btn__spinner")).not.toBeNull();
    await act(async () => { refresh().click(); });
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("returns to normal once the status request finishes", async () => {
    await mount();
    await act(async () => { rejectStatus(new Error("offline")); });
    await settle();
    expect(refresh().hasAttribute("aria-busy")).toBe(false);
    expect(refresh().querySelector(".ff-btn__spinner")).toBeNull();
    expect(refresh().textContent).toBe("↻");
  });
});
