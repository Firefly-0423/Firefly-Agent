// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ModelModePanel } from "./ModelModePanel";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test("lists saved models in provider order with file-safe icons and invokes default/delete APIs", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const profiles = [
    { id: "router", provider: "OpenRouter", model: "router-model", displayName: "Router profile" },
    { id: "local", provider: "Local", model: "offline-model", displayName: "Local profile" },
    { id: "openai", provider: "OpenAI", model: "api-model", displayName: "API profile" },
  ];
  const settings = { listModelProfiles: vi.fn().mockResolvedValue({ profiles }),
    setDefaultModelProfile: vi.fn().mockResolvedValue({}), deleteModelProfile: vi.fn().mockResolvedValue({}) };
  Object.defineProperty(window, "settings", { configurable: true, value: settings });
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(ModelModePanel)));
    expect(settings.listModelProfiles.mock.calls).toStrictEqual([[]]);
    const cards = Array.from(host.querySelectorAll(".model-card"));
    expect(cards.map(card => card.querySelector(".model-card__provider")?.textContent)).toStrictEqual(["OpenAI", "OpenRouter", "Local"]);
    const icons = cards.map(card => card.querySelector("img")?.getAttribute("src"));
    expect(icons).toStrictEqual(["../icons/providers/openai.svg", "../icons/providers/custom-endpoint.svg", undefined]);
    expect(icons.some(url => url?.startsWith("/icons/providers/"))).toBe(false);
    await React.act(async () => (cards[1].querySelector(".model-card__pill") as HTMLButtonElement).click());
    expect(settings.setDefaultModelProfile.mock.calls).toStrictEqual([["router"]]);
    await React.act(async () => (host.querySelectorAll(".model-card__delete")[1] as HTMLButtonElement).click());
    expect(settings.deleteModelProfile.mock.calls).toStrictEqual([["router"]]);
    expect(settings.listModelProfiles).toHaveBeenCalledTimes(3);
  } finally { await React.act(async () => root.unmount()); Reflect.deleteProperty(window, "settings"); }
});
