// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./use-presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, state: { mounted: boolean; leaving: boolean };
function Probe({ open }: { open: boolean }) {
  state = usePresence(open, 200);
  return null;
}
const render = (open: boolean) => act(() => root.render(createElement(Probe, { open })));
const motion = (reduce: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));

describe("usePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("React", React);
    motion(false);
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is mounted while open and stays mounted, leaving, for the exit time", async () => {
    await render(true);
    expect(state).toEqual({ mounted: true, leaving: false });
    await render(false);
    expect(state).toEqual({ mounted: true, leaving: true });
    await act(() => { vi.advanceTimersByTime(200); });
    expect(state).toEqual({ mounted: false, leaving: false });
  });

  it("cancels the exit when reopened", async () => {
    await render(true);
    await render(false);
    await render(true);
    await act(() => { vi.advanceTimersByTime(400); });
    expect(state).toEqual({ mounted: true, leaving: false });
  });

  it("never mounts something that starts closed, and unmounts at once under reduced motion", async () => {
    await render(false);
    expect(state.mounted).toBe(false);
    motion(true);
    await render(true);
    await render(false);
    expect(state.mounted).toBe(false);
  });
});
