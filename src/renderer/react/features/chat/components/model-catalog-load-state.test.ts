import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelModePanel } from "./ModelModePanel";
import { ModelEffortControl } from "./ModelEffortControl";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({ Popover: ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) => createElement("div", null, content, children), Slider: () => null }));

let dom: JSDOM;
let root: Root;
let host: HTMLElement;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.getElementById("root")!;
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

for (const component of ["panel", "selector"] as const) {
  describe(`${component} catalog load states`, () => {
    const render = () => root.render(component === "panel" ? createElement(ModelModePanel) : createElement(ModelEffortControl, { onSelectModelProfile: vi.fn() }));
    const emptyKey = component === "panel" ? "modelPanel.emptyHint" : "modelSelector.emptyHint";
    /** The control opens on its effort panel; the model list is one click away. */
    const show = async () => {
      await act(async () => render());
      if (component === "selector") await act(async () => { host.querySelector<HTMLButtonElement>(".ff-effort__model")!.click(); });
    };
    function bridge(listModelProfiles: () => Promise<unknown>) {
      Object.assign(window, { settings: { listModelProfiles } });
    }

    it("keeps pending and rejected loads distinct from an empty catalog", async () => {
      let reject!: (reason: Error) => void;
      bridge(() => new Promise((_resolve, fail) => { reject = fail; }));
      await show();
      expect(host.textContent).toContain("common.loading");
      expect(host.textContent).not.toContain(emptyKey);
      await act(async () => reject(new Error("MODEL_SETTINGS_READ_FAILED")));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("modelPanel.loadFailed");
      expect(host.textContent).not.toContain(emptyKey);
    });

    it("shows a real empty result only after a successful load", async () => {
      bridge(async () => ({ profiles: [] }));
      await show();
      expect(host.textContent).toContain(emptyKey);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it("renders successful nonempty results", async () => {
      bridge(async () => ({ profiles: [{ id: "test", provider: "openai", model: "test-model", displayName: "Public test" }] }));
      await show();
      expect(host.textContent).toContain("Public test");
      expect(host.textContent).not.toContain(emptyKey);
    });

    it("treats a missing bridge as a failure, not an empty catalog", async () => {
      await show();
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("modelPanel.loadFailed");
      expect(host.textContent).not.toContain(emptyKey);
    });
  });
}
