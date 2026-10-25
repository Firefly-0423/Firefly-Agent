// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_FOLD_MS, useSidebarFold, type SidebarFoldPhase } from "./use-sidebar-fold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root, seen: SidebarFoldPhase[];
function Probe({ collapsed }: { collapsed: boolean }) {
  seen.push(useSidebarFold(collapsed));
  return null;
}
const render = (collapsed: boolean) => act(() => root.render(createElement(Probe, { collapsed })));
const last = () => seen[seen.length - 1];
const motion = (reduce: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));

describe("useSidebarFold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("React", React);
    motion(false);
    seen = [];
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts in the state it is given, without animating", async () => {
    await render(true);
    expect(seen).toEqual(["floating"]);
  });

  it("slides out while still docked, then floats", async () => {
    await render(false);
    await render(true);
    expect(last()).toBe("closing");
    await act(() => { vi.advanceTimersByTime(SIDEBAR_FOLD_MS); });
    expect(last()).toBe("floating");
  });

  it("docks folded first, then slides back in on a later frame", async () => {
    await render(true);
    await render(false);
    expect(last()).toBe("opening");
    await act(() => { vi.advanceTimersByTime(50); });
    expect(last()).toBe("docked");
  });

  it("jumps straight to the end state under reduced motion", async () => {
    motion(true);
    await render(false);
    await render(true);
    expect(last()).toBe("floating");
    expect(seen).not.toContain("closing");
  });
});
