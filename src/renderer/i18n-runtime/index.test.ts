// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initWindowI18n, setLocale, useTranslation } from "./index";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  initWindowI18n({ resources: {
    "zh-CN": { translation: { greeting: "你好" } },
    en: { translation: { greeting: "Hello" } },
  } });
  setLocale("zh-CN");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("cleans up the exact locale subscription when the translation hook unmounts", () => {
  const subscribe = vi.spyOn(i18next, "on");
  const unsubscribe = vi.spyOn(i18next, "off");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Translation() {
    const { t } = useTranslation();
    return createElement("span", null, t("greeting"));
  }

  act(() => root.render(createElement(Translation)));
  expect(host.textContent).toBe("你好");
  const listener = subscribe.mock.calls.find(([event]) => event === "languageChanged")?.[1];
  expect(listener).toBeTypeOf("function");
  expect(() => act(() => root.unmount())).not.toThrow();
  expect(unsubscribe).toHaveBeenCalledWith("languageChanged", listener);
});

it("updates translated content after a locale change and still unmounts cleanly", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Translation() {
    const { t } = useTranslation();
    return createElement("span", null, t("greeting"));
  }
  act(() => root.render(createElement(Translation)));
  await act(async () => setLocale("en"));
  expect(host.textContent).toBe("Hello");
  expect(() => act(() => root.unmount())).not.toThrow();
});
