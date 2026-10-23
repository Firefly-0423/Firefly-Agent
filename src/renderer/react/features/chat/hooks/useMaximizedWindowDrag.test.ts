// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { isWindowDragSurface, useMaximizedWindowDrag } from "./useMaximizedWindowDrag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useMaximizedWindowDrag();
  return createElement(
    "div",
    { className: "ff-page" },
    createElement("header", { className: "ff-page-titlebar" }, createElement("button", { id: "tab" }, "Work")),
    createElement("div", { className: "ff-workspace-header" }, createElement("button", { id: "act" }, "x")),
    createElement("div", { id: "body" }, "messages"),
  );
}

function fire(target: Element, type: string, init: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "screenX", { value: init.screenX ?? 0 });
  Object.defineProperty(event, "screenY", { value: init.screenY ?? 0 });
  target.dispatchEvent(event);
}

describe("isWindowDragSurface", () => {
  it("accepts blank title areas only", () => {
    document.body.innerHTML = '<div class="ff-page"><header class="ff-page-titlebar"><button>t</button><span id="blank"></span></header><div class="ff-workspace-header"><h1 id="title">t</h1><button id="b">b</button></div><p id="msg">m</p></div>';
    expect(isWindowDragSurface(document.getElementById("blank"), 20)).toBe(true);
    expect(isWindowDragSurface(document.querySelector(".ff-page-titlebar button"), 20)).toBe(false);
    expect(isWindowDragSurface(document.getElementById("title"), 80)).toBe(true);
    expect(isWindowDragSurface(document.getElementById("b"), 80)).toBe(false);
    expect(isWindowDragSurface(document.getElementById("msg"), 300)).toBe(false);
    expect(isWindowDragSurface(document.querySelector(".ff-page"), 20)).toBe(true);
    expect(isWindowDragSurface(document.querySelector(".ff-page"), 400)).toBe(false);
  });
});

describe("useMaximizedWindowDrag", () => {
  let host: HTMLDivElement;
  let root: Root;
  const chat = {
    isMaximized: vi.fn(async () => true),
    startWindowDrag: vi.fn(),
    endWindowDrag: vi.fn(),
    toggleMaximize: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    chat.isMaximized.mockResolvedValue(true);
    (window as unknown as { chat: typeof chat }).chat = chat;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(Probe)); });
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    delete (window as unknown as { chat?: unknown }).chat;
  });

  it("marks the document while maximized and clears it on unmount", async () => {
    expect(document.documentElement.dataset.windowMaximized).toBe("true");
    await act(async () => { root.unmount(); });
    expect(document.documentElement.dataset.windowMaximized).toBeUndefined();
    root = createRoot(host);
  });

  it("starts the window drag only after the pointer moves past the threshold, and ends on release", () => {
    const body = document.querySelector(".ff-workspace-header")!;
    fire(body, "pointerdown", { button: 0, buttons: 1, clientY: 80, screenX: 100, screenY: 100 });
    fire(body, "pointermove", { buttons: 1, screenX: 102, screenY: 101 });
    expect(chat.startWindowDrag).not.toHaveBeenCalled();
    fire(body, "pointermove", { buttons: 1, screenX: 120, screenY: 110 });
    expect(chat.startWindowDrag).toHaveBeenCalledTimes(1);
    fire(body, "pointermove", { buttons: 1, screenX: 200, screenY: 200 });
    expect(chat.startWindowDrag).toHaveBeenCalledTimes(1);
    fire(body, "pointerup", { button: 0 });
    expect(chat.endWindowDrag).toHaveBeenCalledTimes(1);
  });

  it("ignores drags that start on controls or in the message area", () => {
    fire(document.getElementById("act")!, "pointerdown", { button: 0, buttons: 1, clientY: 80, screenX: 0, screenY: 0 });
    fire(document.getElementById("act")!, "pointermove", { buttons: 1, screenX: 50, screenY: 50 });
    fire(document.getElementById("body")!, "pointerdown", { button: 0, buttons: 1, clientY: 400, screenX: 0, screenY: 0 });
    fire(document.getElementById("body")!, "pointermove", { buttons: 1, screenX: 50, screenY: 50 });
    expect(chat.startWindowDrag).not.toHaveBeenCalled();
  });

  it("restores on double click of the title area", () => {
    fire(document.querySelector(".ff-workspace-header")!, "dblclick", { clientY: 80 });
    expect(chat.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
