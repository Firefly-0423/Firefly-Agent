// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCompactDock } from "./useCompactDock";

it("stacks the inspector for a narrow reading area and restores the wide dock", () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let reportResize: ResizeObserverCallback;
  const disconnect = vi.fn();
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { reportResize = callback; }
    observe() {} unobserve() {} disconnect = disconnect;
  };
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    const compact = useCompactDock(ref);
    return createElement("div", { ref, "data-compact": compact }, createElement("textarea", { defaultValue: "saved draft" }));
  }
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  const input = host.querySelector("textarea")!;
  input.value = "still typing";
  for (const [width, compact] of [[580, true], [620, false], [720, false], [1100, false]] as const) {
    act(() => reportResize!([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(host.firstElementChild?.getAttribute("data-compact")).toBe(String(compact));
    expect(host.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("still typing");
  }
  act(() => root.unmount()); host.remove(); expect(disconnect).toHaveBeenCalledOnce();
});
