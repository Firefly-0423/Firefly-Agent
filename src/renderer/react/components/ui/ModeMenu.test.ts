// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModeMenu } from "./ModeMenu";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const trigger = () => host.querySelector<HTMLButtonElement>(".ff-mode-menu__trigger")!;
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

async function render(value: string, onChange: (mode: string) => void) {
  await act(async () => root.render(React.createElement(ModeMenu, { value, onChange })));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("ModeMenu", () => {
  it("shows the current mode on a menu button and keeps the list closed", async () => {
    await render("chat", () => undefined);
    expect(trigger().textContent).toBe("Chat");
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-label")).toBe("切换模式，当前：Chat");
    expect(items()).toHaveLength(0);
  });

  it("lists the modes with a description and marks the current one", async () => {
    await render("code", () => undefined);
    await act(async () => trigger().click());
    await flush();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("会话模式");
    expect(items().map(node => node.querySelector(".ff-mode-menu__label")?.textContent)).toEqual(["Work", "Chat", "Code"]);
    expect(items().map(node => node.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    for (const node of items()) expect(node.querySelector("small")?.textContent?.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(items()[2]);
  });

  it("picks another mode, reports it once and closes the menu", async () => {
    const onChange = vi.fn();
    await render("chat", onChange);
    await act(async () => trigger().click());
    await flush();
    await act(async () => items().find(node => node.textContent?.includes("Work"))!.click());
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("work");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("does not report the mode that is already selected", async () => {
    const onChange = vi.fn();
    await render("chat", onChange);
    await act(async () => trigger().click());
    await flush();
    await act(async () => items().find(node => node.getAttribute("aria-checked") === "true")!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves focus with the arrow keys and closes on Escape", async () => {
    await render("work", () => undefined);
    await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await flush();
    expect(document.activeElement).toBe(items()[0]);
    await act(async () => items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items()[1]);
    await act(async () => items()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await act(async () => items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(items()[2]);
    await act(async () => items()[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await flush();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });
});
