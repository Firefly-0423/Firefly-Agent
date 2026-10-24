// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.settings;
  delete window.user;
  document.body.replaceChildren();
});

function input(id: string): HTMLInputElement {
  const element = document.createElement("input");
  element.id = id;
  document.body.append(element);
  return element;
}

it("keeps email fields independently debounced and reads the bound input at save time", async () => {
  const host = input("email-smtp-host");
  const port = input("email-smtp-port");
  const secure = input("email-smtp-secure");
  const saveGeneral = vi.fn(async () => ({}));
  Object.assign(window, { settings: { getGeneral: async () => ({}), saveGeneral } });
  await import("./email/panel");
  host.value = " first.invalid ";
  host.dispatchEvent(new Event("input"));
  port.value = "587";
  port.dispatchEvent(new Event("input"));
  host.value = " final.invalid ";
  secure.checked = false;
  secure.dispatchEvent(new Event("change"));
  await vi.advanceTimersByTimeAsync(799);
  expect(saveGeneral.mock.calls).toEqual([[{ emailSmtpSecure: false }]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saveGeneral.mock.calls).toEqual([
    [{ emailSmtpSecure: false }],
    [{ emailSmtpHost: "final.invalid" }],
    [{ emailSmtpPort: 587 }],
  ]);
});

it("keeps plugin toggle and delayed input values on their own event targets", async () => {
  const weather = input("plugin-weather-enabled");
  const key = input("amap-key");
  const travelKey = input("travel-amap-key");
  const browser = input("plugin-playwright-mcp-enabled");
  const saveGeneral = vi.fn(async () => ({}));
  Object.assign(window, { settings: { getGeneral: async () => ({}), saveGeneral } });
  await import("./plugins/panel");
  weather.checked = true;
  weather.dispatchEvent(new Event("change"));
  key.value = " synthetic-weather-fixture ";
  key.dispatchEvent(new Event("input"));
  travelKey.value = " synthetic-travel-fixture ";
  travelKey.dispatchEvent(new Event("input"));
  browser.checked = true;
  browser.dispatchEvent(new Event("change"));
  await vi.advanceTimersByTimeAsync(800);
  expect(saveGeneral.mock.calls).toEqual([
    [{ weatherEnabled: true }],
    [{ playwrightMcpEnabled: true }],
    [{ amapKey: "synthetic-weather-fixture" }],
    [{ amapKey: "synthetic-travel-fixture" }],
  ]);
});

it("saves the trimmed default city on change and blur through the shared guarded binding", async () => {
  const city = input("user-default-city");
  const saveProfile = vi.fn(async () => ({}));
  Object.assign(window, { user: { getAvatar: async () => null, getProfile: async () => ({}), saveProfile } });
  await import("./user/panel");
  city.value = " fixture-city ";
  city.dispatchEvent(new Event("change"));
  city.dispatchEvent(new Event("blur"));
  expect(saveProfile.mock.calls).toEqual([
    [{ defaultCity: "fixture-city" }],
    [{ defaultCity: "fixture-city" }],
  ]);
});

it("loads optional panels safely with absent controls and bridges", async () => {
  delete window.settings;
  delete window.user;
  await expect(import("./email/panel")).resolves.toBeDefined();
  await expect(import("./plugins/panel")).resolves.toBeDefined();
  await expect(import("./user/panel")).resolves.toBeDefined();
});
