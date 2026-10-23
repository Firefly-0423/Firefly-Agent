// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOfflineBrowserAvailability } from "../../../../../main/browser/browser-availability-ipc";
vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { OfflineBrowserTab } from "./OfflineBrowserTab";

afterEach(() => { delete window.manualBrowser; vi.unstubAllGlobals(); });
describe("joint Main availability and browser tab", () => {
  it("renders Main's unavailable state, permits an address draft, and cannot navigate", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.manualBrowser = { getAvailability: async () => getOfflineBrowserAvailability() };
    const host = document.createElement("div"), root = createRoot(host), close = vi.fn();
    document.body.append(host);
    await act(async () => root.render(createElement(OfflineBrowserTab, { sessionId: "s", onClose: close })));
    expect(host.textContent).toContain("browserWorkspace.unavailable");
    const input = host.querySelector("input"), set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || !set) throw new Error("address missing");
    act(() => { set.call(input, "https://example.com/anonymous-fixture"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(input.value).toBe("https://example.com/anonymous-fixture");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.go"]')?.disabled).toBe(true);
    expect(host.querySelector("iframe,webview,a[href]")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="browserWorkspace.close"]')?.click());
    expect(close).toHaveBeenCalledTimes(1);
    act(() => root.unmount()); host.remove();
  });
  it("remains unavailable without a bridge or when the bridge rejects", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const bridge of [undefined, { getAvailability: async () => { throw new Error("private"); } }]) {
      window.manualBrowser = bridge;
      const host = document.createElement("div"), root = createRoot(host);
      await act(async () => root.render(createElement(OfflineBrowserTab, { sessionId: "s", onClose: () => {} })));
      expect(host.textContent).toContain("browserWorkspace.unavailable");
      expect(host.textContent).not.toContain("private");
      act(() => root.unmount());
    }
  });
});
