// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { PluginOverview } from "../../shared/plugin-management";

it("destroys stopped panels and rejects messages from their former frames", async () => {
  document.body.innerHTML = '<section class="plugin-panels" id="plugin-panels-plugins"></section>';
  let changed: (value: PluginOverview) => void = () => {};
  const plugin = { id: "fixture", name: "Fixture", version: "1", enabled: true, settingsPanel: "ui.html" };
  window.plugins = { list: async () => ({ plugins: [plugin], issues: [] }), onChanged: (callback: typeof changed) => { changed = callback; return () => {}; } } as never;
  const invoke = vi.fn(async () => ({ ok: true }));
  window.pluginPanel = { invoke };
  const { mountPluginPanels } = await import("./plugin-panels");
  await mountPluginPanels();
  const frame = document.querySelector("iframe")!;
  frame.dispatchEvent(new Event("load"));
  const oldWindow = frame.contentWindow!;
  changed({ plugins: [{ ...plugin, enabled: false }] as never, issues: [] });
  expect(document.querySelector("iframe")).toBeNull();
  window.dispatchEvent(new MessageEvent("message", { source: oldWindow, origin: "firefly-plugin://fixture", data: {
    protocol: "firefly-panel/1", kind: "invoke", channel: "fixture", seq: 1, args: [],
  } }));
  expect(invoke).not.toHaveBeenCalled();
});
