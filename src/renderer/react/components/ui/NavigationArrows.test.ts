// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavigationArrows } from "./NavigationArrows";

vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

it("offers back then forward, each calling its own handler", () => {
  const onBack = vi.fn(), onForward = vi.fn();
  act(() => root.render(React.createElement(NavigationArrows, { canBack: true, canForward: true, onBack, onForward })));
  expect(buttons().map(button => button.getAttribute("aria-label"))).toEqual(["ui.navBack", "ui.navForward"]);
  act(() => buttons()[0]!.click());
  expect(onBack).toHaveBeenCalledOnce();
  expect(onForward).not.toHaveBeenCalled();
  act(() => buttons()[1]!.click());
  expect(onForward).toHaveBeenCalledOnce();
});

it("disables an arrow that has nowhere to go, so clicking it does nothing", () => {
  const onBack = vi.fn(), onForward = vi.fn();
  act(() => root.render(React.createElement(NavigationArrows, { canBack: false, canForward: true, onBack, onForward })));
  expect(buttons().map(button => button.disabled)).toEqual([true, false]);
  act(() => buttons()[0]!.click());
  expect(onBack).not.toHaveBeenCalled();
});
