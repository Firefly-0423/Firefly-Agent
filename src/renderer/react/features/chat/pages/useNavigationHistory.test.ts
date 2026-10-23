// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_HISTORY_LIMIT, useNavigationHistory, type NavLocation } from "./useNavigationHistory";

type Api = ReturnType<typeof useNavigationHistory>;
let root: Root;
let host: HTMLDivElement;
let api: Api;
let go: ReturnType<typeof vi.fn>;
let available: (location: NavLocation) => boolean;

function Probe({ current }: { current: NavLocation }) {
  api = useNavigationHistory({ current, go: go as never, isAvailable: location => available(location) });
  return null;
}
const session = (id: string, mode = "chat"): NavLocation => ({ mode, sessionId: id, panel: null });
const panel = (name: string, mode = "chat", sessionId?: string): NavLocation => ({ mode, sessionId, panel: name });
const show = (current: NavLocation) => act(() => { root.render(React.createElement(Probe, { current })); });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  go = vi.fn();
  available = () => true;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("navigation history", () => {
  it("starts with nothing to go back or forward to, and does not keep an empty new task", () => {
    show({ mode: "chat", panel: null });
    expect(api.canBack).toBe(false);
    expect(api.canForward).toBe(false);
    show(session("a"));
    expect(api.canBack).toBe(false);
  });

  it("goes back to the previous conversation and then forward again", () => {
    show(session("a"));
    show(session("b"));
    show(session("c"));
    expect(api.canBack).toBe(true);
    expect(api.canForward).toBe(false);
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("b"));
    show(session("b"));
    expect(api.canBack).toBe(true);
    expect(api.canForward).toBe(true);
    act(() => api.forward());
    expect(go).toHaveBeenLastCalledWith(session("c"));
  });

  it("walks through panels as well as conversations", () => {
    show(session("a"));
    show(panel("plugin", "chat", "a"));
    show(panel("skill", "chat", "a"));
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(panel("plugin", "chat", "a"));
    show(panel("plugin", "chat", "a"));
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("a"));
  });

  it("does not record the halfway states of a move, and a fresh visit drops the forward steps", () => {
    show(session("a"));
    show(session("b"));
    show(session("c"));
    act(() => api.back());
    // Panel closes first, the session follows: neither is a new step while the move is settling.
    show(panel("plugin", "chat", "c"));
    show(session("c"));
    show(session("b"));
    expect(api.canForward).toBe(true);
    show(session("d"));
    expect(api.canForward).toBe(false);
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("b"));
  });

  it("resumes recording if the target never opens", () => {
    show(session("a"));
    show(session("b"));
    act(() => api.back());
    // The move to "a" never lands; whatever shows up during the wait is not a step.
    show(session("x"));
    act(() => { vi.advanceTimersByTime(2500); });
    show(session("y"));
    expect(api.canForward).toBe(false);
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("a"));
  });

  it("skips a conversation that has since been deleted", () => {
    show(session("a"));
    show(session("b"));
    show(session("c"));
    available = location => location.sessionId !== "b";
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("a"));
  });

  it("has nothing to go back to when every earlier step is gone", () => {
    show(session("a"));
    show(session("b"));
    available = location => location.sessionId !== "a";
    show(session("b"));
    expect(api.canBack).toBe(false);
    go.mockClear();
    act(() => api.back());
    expect(go).not.toHaveBeenCalled();
  });

  it("keeps only the most recent steps", () => {
    for (let index = 0; index < NAVIGATION_HISTORY_LIMIT + 10; index += 1) show(session(`s${index}`));
    let steps = 0;
    while (api.canBack && steps < 200) {
      const before = go.mock.calls.length;
      act(() => api.back());
      show(go.mock.calls.at(-1)![0] as NavLocation);
      if (go.mock.calls.length === before) break;
      steps += 1;
    }
    expect(steps).toBe(NAVIGATION_HISTORY_LIMIT - 1);
  });

  it("answers the mouse back and forward buttons", () => {
    show(session("a"));
    show(session("b"));
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 3 })); });
    expect(go).toHaveBeenLastCalledWith(session("a"));
    show(session("a"));
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { button: 4 })); });
    expect(go).toHaveBeenLastCalledWith(session("b"));
  });

  it("returns the same back and forward functions on every render, and hands go the mode of the place it is going to", () => {
    show(session("a", "work"));
    show(session("b", "chat"));
    const { back, forward } = api;
    show(session("b", "chat"));
    show(session("b", "chat"));
    expect(api.back).toBe(back);
    expect(api.forward).toBe(forward);
    act(() => api.back());
    expect(go).toHaveBeenLastCalledWith(session("a", "work"));
  });
});
