// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { afterEach, expect, test, vi } from "vitest";
import { ModelEffortControl } from "./ModelEffortControl";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test("unmounts the effort bar when the panel closes, so its spark loop stops", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "chat", { configurable: true, value: {
    getReasoningState: vi.fn().mockResolvedValue({ providerKey: "deepseek", providerId: "deepseek", model: "deepseek-reasoner" }),
    setReasoning: vi.fn().mockResolvedValue(undefined),
  } });
  Object.defineProperty(window, "settings", { configurable: true, value: {
    listModelProfiles: vi.fn().mockResolvedValue({ profiles: [{ id: "ds", provider: "DeepSeek", model: "deepseek-reasoner" }] }),
  } });
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(
      // jsdom runs no CSS animations, so the popover's leave motion is switched off.
      React.createElement(ConfigProvider, { theme: { token: { motion: false } } },
        React.createElement(ModelEffortControl, { activeProfileId: "ds" }))));
    const trigger = host.querySelector<HTMLButtonElement>(".ff-model-effort")!;
    await React.act(async () => trigger.click());
    expect(document.querySelector(".ff-effort")).not.toBeNull();
    await React.act(async () => trigger.click());
    await vi.waitFor(() => expect(document.querySelector(".ff-effort")).toBeNull());
  } finally {
    await React.act(async () => root.unmount());
  }
});
