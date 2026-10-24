// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = () => host.querySelector<HTMLButtonElement>("button")!;
const render = (element: React.ReactElement) => act(async () => root.render(element));
const click = () => act(async () => { button().click(); });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Button", () => {
  it("defaults to a secondary, medium, non-submitting button", async () => {
    await render(React.createElement(Button, null, "Save"));
    expect(button().type).toBe("button");
    expect(button().classList.contains("ff-btn")).toBe(true);
    expect(button().classList.contains("ff-btn--secondary")).toBe(true);
    expect(button().classList.contains("ff-btn--md")).toBe(true);
    expect(button().hasAttribute("aria-busy")).toBe(false);
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    expect(host.querySelector(".ff-btn__spinner")).toBeNull();
  });

  it("applies variant, size, block and a caller class without losing the base classes", async () => {
    await render(React.createElement(Button, { variant: "primary", size: "sm", block: true, className: "mine" }, "Go"));
    expect([...button().classList]).toEqual(expect.arrayContaining(["ff-btn", "ff-btn--primary", "ff-btn--sm", "ff-btn--block", "mine"]));
  });

  it("honours an explicit submit type and forwards native attributes and the ref", async () => {
    const ref = createRef<HTMLButtonElement>();
    await render(React.createElement(Button, { type: "submit", ref, "data-testid": "go", title: "Send" }, "Send"));
    expect(button().type).toBe("submit");
    expect(button().dataset.testid).toBe("go");
    expect(button().title).toBe("Send");
    expect(ref.current).toBe(button());
  });

  it("calls onClick", async () => {
    const onClick = vi.fn();
    await render(React.createElement(Button, { onClick }, "Go"));
    await click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled, and uses the native disabled attribute", async () => {
    const onClick = vi.fn();
    await render(React.createElement(Button, { onClick, disabled: true }, "Go"));
    await click();
    expect(button().disabled).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  describe("loading", () => {
    it("reports busy, shows a decorative spinner and ignores clicks", async () => {
      const onClick = vi.fn();
      await render(React.createElement(Button, { onClick, loading: true }, "Save"));
      await click();
      expect(button().getAttribute("aria-busy")).toBe("true");
      expect(button().getAttribute("aria-disabled")).toBe("true");
      expect(button().dataset.loading).toBe("true");
      expect(host.querySelector(".ff-btn__spinner")?.getAttribute("aria-hidden")).toBe("true");
      expect(onClick).not.toHaveBeenCalled();
    });

    it("stays focusable, because a disabled button would drop keyboard focus mid-request", async () => {
      await render(React.createElement(Button, { loading: true }, "Save"));
      expect(button().disabled).toBe(false);
      button().focus();
      expect(document.activeElement).toBe(button());
    });

    it("keeps the label and returns to normal once loading ends", async () => {
      const onClick = vi.fn();
      await render(React.createElement(Button, { onClick, loading: true }, "Save"));
      expect(button().textContent).toBe("Save");
      await render(React.createElement(Button, { onClick, loading: false }, "Save"));
      await click();
      expect(button().hasAttribute("aria-busy")).toBe(false);
      expect(host.querySelector(".ff-btn__spinner")).toBeNull();
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});

describe("IconButton", () => {
  it("names itself from the required label for assistive technology and the tooltip", async () => {
    await render(React.createElement(IconButton, { label: "Refresh" }, "↻"));
    expect(button().getAttribute("aria-label")).toBe("Refresh");
    expect(button().title).toBe("Refresh");
    expect(button().classList.contains("ff-btn--icon")).toBe(true);
    expect(button().classList.contains("ff-btn--ghost")).toBe(true);
  });

  it("lets a caller supply a more descriptive tooltip but never drops the label", async () => {
    await render(React.createElement(IconButton, { label: "Refresh", title: "Refresh git status" }, "↻"));
    expect(button().title).toBe("Refresh git status");
    expect(button().getAttribute("aria-label")).toBe("Refresh");
  });

  it("supports loading like Button, with the spinner replacing the icon", async () => {
    const onClick = vi.fn();
    await render(React.createElement(IconButton, { label: "Refresh", loading: true, onClick }, "↻"));
    await click();
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().getAttribute("aria-label")).toBe("Refresh");
    expect(button().textContent).toBe("");
    expect(host.querySelector(".ff-btn__spinner")).not.toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("cannot be created without a label", () => {
    // @ts-expect-error label is required: an icon-only button must have an accessible name
    React.createElement(IconButton, {});
  });
});
