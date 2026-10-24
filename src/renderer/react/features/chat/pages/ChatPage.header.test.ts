// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "../../../i18n";

// jsdom has no layout engine. Keep the page's state/actions real and replace only
// the third-party measured panel shell; browser lifecycle has its own real tests.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, elementRef }: { children: React.ReactNode; elementRef: React.Ref<HTMLDivElement> }) => createElement("div", { ref: elementRef }, children),
  Panel: ({ children }: { children: React.ReactNode }) => createElement("section", null, children),
  Separator: () => createElement("div", { role: "separator" }),
  useDefaultLayout: () => ({}),
  usePanelRef: () => useRef({ expand() {}, collapse() {} }),
}));
vi.mock("../components/ChatMessageList", () => ({ ChatMessageList: () => null }));
vi.mock("../components/ChatComposer", () => ({ ChatComposer: () => createElement("textarea", { defaultValue: "kept composer" }), parseComposerMessage: () => ({ text: "" }) }));
vi.mock("../components/ChatPageNavigation", () => ({ ChatPageNavigation: () => null }));
vi.mock("../components/ChatPageInspector", () => ({ ChatPageInspector: ({ visible, browserTabOpen }: { visible: boolean; browserTabOpen: boolean }) => createElement("aside", { hidden: !visible, "data-browser-open": browserTabOpen }, createElement("input", { defaultValue: "browser draft" })) }));
vi.mock("../components/ChatPagePanelHost", () => ({ ChatPagePanelHost: () => null }));
import { ChatPage } from "./ChatPage";
import { FeedbackProvider } from "../../../components/feedback/FeedbackProvider";

beforeEach(() => {
  localStorage.clear();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {} });
});
describe("chat header structure", () => {
  it("places a real conversation title and existing workspace actions before the composer", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(FeedbackProvider, null, createElement(ChatPage)));
    const main = host.querySelector("main.ff-workspace")!;
    const header = main.querySelector(":scope > header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("h1")?.textContent).toBe(t("chatPage.newTaskTitle"));
    expect(header?.querySelector(`[aria-label="${t("browserWorkspace.open")}"]`)).not.toBeNull();
    expect(header?.querySelector(`[aria-label="${t("fileTree.title")}"]`)).not.toBeNull();
    expect(main.querySelector("textarea")).not.toBeNull();
    expect(main.querySelector(".ff-inspector-toggle-float")).toBeNull();
  });
  it("keeps composer and browser draft nodes across repeated header collapse actions", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(FeedbackProvider, null, createElement(ChatPage))));
      const composer = host.querySelector("textarea")!;
      composer.value = "unsent text";
      const browserButton = host.querySelector<HTMLButtonElement>(`header [aria-label="${t("browserWorkspace.open")}"]`)!;
      await act(async () => browserButton.click());
      const browserDraft = host.querySelector<HTMLInputElement>("aside input")!;
      browserDraft.value = "unchanged page state";
      const toggle = host.querySelector<HTMLButtonElement>(`header [aria-label="${t("rightInspector.toggle")}"]`)!;
      for (let i = 0; i < 3; i++) {
        await act(async () => toggle.click());
        expect(host.querySelector("aside")?.hidden).toBe(true);
        await act(async () => toggle.click());
        expect(host.querySelector("aside")?.hidden).toBe(false);
        expect(host.querySelector("aside input")).toBe(browserDraft);
        expect(browserDraft.value).toBe("unchanged page state");
        expect(host.querySelector("textarea")).toBe(composer);
        expect(composer.value).toBe("unsent text");
      }
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it("uses a bounded header row whose line the inspector panel headers meet, without fake content padding", () => {
    const root = readFileSync(resolve(__dirname, "../../../styles/react-root.css"), "utf8");
    const right = readFileSync(resolve(__dirname, "../components/RightInspector.css"), "utf8");
    const sheet = document.createElement("style"); sheet.textContent = root + "\n" + right; document.head.append(sheet);
    const rules = Array.from(sheet.sheet!.cssRules) as CSSStyleRule[];
    const header = rules.find(rule => rule.selectorText === ".ff-workspace-header");
    const paneHead = rules.find(rule => rule.selectorText === ".ff-inspector-pane__head");
    const inspector = rules.find(rule => rule.selectorText === ".ff-right-inspector");
    expect(header?.style.position).toBe("relative");
    // jsdom drops Electron's nonstandard app-region declaration from CSSOM.
    // These are source contracts only; native hit testing still needs Electron QA.
    expect(root.match(/^\.ff-workspace-header \{([^}]+)\}/m)?.[1]).toMatch(/app-region:\s*drag/);
    expect(root.match(/^\.ff-workspace-header__actions \{([^}]+)\}/m)?.[1]).toMatch(/app-region:\s*no-drag/);
    expect(root).toMatch(/:root\[data-window-maximized="true"\] \.ff-workspace-header \{[^}]*app-region:\s*no-drag/);
    expect(header?.style.height).toBe("var(--ff-workspace-header-height)");
    // 8px inset + 1px frame + 38px header + 1px rule = the 48px header line.
    expect(Number.parseFloat(inspector!.style.padding) + 1 + Number.parseFloat(paneHead!.style.height) + 1).toBe(48);
    expect(rules.some(rule => rule.selectorText === ".ff-workspace .ff-workspace-composer" && rule.style.paddingTop === "56px")).toBe(false);
    expect(rules.some(rule => rule.selectorText === ".ff-workspace.has-messages .ff-message-list" && rule.style.paddingTop === "52px")).toBe(false);
    sheet.remove();
  });
});

it("uses a shared titlebar gutter and a solid workspace without an artwork overlay", () => {
  const css = readFileSync(resolve(__dirname, "../../../styles/react-root.css"), "utf8");
  const sheet = document.createElement("style"); sheet.textContent = css; document.head.append(sheet);
  try {
    const rules = Array.from(sheet.sheet!.cssRules) as CSSStyleRule[];
    const tokens = rules.find(rule => rule.selectorText === ":root")!.style;
    expect(tokens.getPropertyValue("--ff-app-titlebar-height").trim()).toBe("50px");
    expect(tokens.getPropertyValue("--ff-workspace-header-height").trim()).toBe("48px");
    const page = rules.find(rule => rule.selectorText === ".ff-page")!.style;
    expect(page.getPropertyValue("padding")).toContain("var(--ff-app-titlebar-height)");
    const titlebar = rules.find(rule => rule.selectorText === ".ff-page-titlebar")!.style;
    expect(titlebar.getPropertyValue("height")).toBe("var(--ff-app-titlebar-height)");
    expect(rules.filter(rule => rule.selectorText?.includes(".ff-workspace::before"))).toHaveLength(0);
    expect(rules.filter(rule => rule.selectorText === ".ff-workspace").some(rule => rule.style.overflowY === "auto")).toBe(false);
  } finally { sheet.remove(); }
});
