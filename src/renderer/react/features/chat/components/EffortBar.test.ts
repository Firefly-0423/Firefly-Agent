// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffortBar, KNOB, nearestStop, stopFraction } from "./EffortBar";

describe("effort bar geometry", () => {
  it("spreads the stops evenly from end to end", () => {
    expect([0, 1, 2, 3].map(index => stopFraction(index, 4))).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(stopFraction(0, 1)).toBe(0);
  });
  it("snaps a pointer to the nearest stop, measured from the knob centre, skipping disabled ones", () => {
    const width = 240;
    const centre = (index: number) => 1 + KNOB / 2 + (width - KNOB - 2) * (index / 3);
    expect(nearestStop(0, width, 4)).toBe(0);
    expect(nearestStop(width, width, 4)).toBe(3);
    expect(nearestStop(centre(2) + 5, width, 4)).toBe(2);
    expect(nearestStop(centre(2), width, 4, [false, false, true, false])).toBe(1);
  });
});

describe("effort bar", () => {
  let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
  beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const bar = () => host.querySelector<HTMLDivElement>(".ff-effort-bar")!;

  it("commits the stop under the pointer on release, previewing while dragging", () => {
    const onCommit = vi.fn(), onPreview = vi.fn();
    act(() => root.render(React.createElement(EffortBar, { count: 4, value: 0, label: "effort", onCommit, onPreview })));
    bar().getBoundingClientRect = () => ({ left: 0, width: 240, top: 0, height: 28, right: 240, bottom: 28, x: 0, y: 0, toJSON() {} });
    act(() => { bar().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, pointerId: 1 })); });
    expect(bar().classList.contains("is-dragging")).toBe(true);
    act(() => { bar().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 235, pointerId: 1 })); });
    expect(onPreview).toHaveBeenLastCalledWith(3);
    expect(bar().getAttribute("aria-valuenow")).toBe("3");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => { bar().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 235, pointerId: 1 })); });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(3);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("moves one allowed stop per arrow key and jumps with Home / End", () => {
    const onCommit = vi.fn();
    act(() => root.render(React.createElement(EffortBar, { count: 4, value: 1, disabled: [false, false, true, false], label: "effort", onCommit })));
    act(() => { bar().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })); });
    expect(onCommit).toHaveBeenLastCalledWith(3);
    act(() => { bar().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })); });
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it("keeps the knob inside the bar at both ends", () => {
    act(() => root.render(React.createElement(EffortBar, { count: 4, value: 3, label: "effort", onCommit: vi.fn() })));
    expect(host.querySelector<HTMLElement>(".ff-effort-bar__knob")!.style.left).toMatch(/1px \+ 1 \* \(100% - 28px\)/);
    act(() => root.render(React.createElement(EffortBar, { count: 4, value: 0, label: "effort", onCommit: vi.fn() })));
    expect(host.querySelector<HTMLElement>(".ff-effort-bar__knob")!.style.left).toMatch(/1px \+ 0 \* \(100% - 28px\)/);
  });

  it("puts the level back when the drag is cancelled", () => {
    const onCommit = vi.fn(), onPreview = vi.fn();
    act(() => root.render(React.createElement(EffortBar, { count: 4, value: 0, label: "effort", onCommit, onPreview })));
    bar().getBoundingClientRect = () => ({ left: 0, width: 240, top: 0, height: 28, right: 240, bottom: 28, x: 0, y: 0, toJSON() {} });
    act(() => { bar().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 235, pointerId: 2 })); });
    act(() => { bar().dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 2 })); });
    expect(onCommit).not.toHaveBeenCalled();
    expect(bar().getAttribute("aria-valuenow")).toBe("0");
  });
});
