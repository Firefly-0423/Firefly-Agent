import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";
import type { ModelSettings } from "../settings/model-settings";
import { IPC } from "../../shared/ipc-channels";

const h = vi.hoisted(() => ({
  model: {} as Record<string, unknown>,
  profile: {} as Record<string, unknown>,
  general: {} as Record<string, unknown>,
  weather: {} as Record<string, unknown>,
  search: {} as Record<string, unknown>,
  timezone: undefined as (() => string | undefined) | undefined,
  travel: {} as Record<string, unknown>,
  email: {} as Record<string, unknown>,
  choiceCard: undefined as ((card: unknown) => void) | undefined,
  choiceDismiss: undefined as ((settlement: unknown) => void) | undefined,
  asr: undefined as (() => unknown) | undefined,
  sent: [] as unknown[][],
}));

vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => h.model,
}));

vi.mock("../settings-store", () => ({
  loadUserProfile: () => h.profile,
}));

vi.mock("../orchestrator/tools/built-in-tools", () => ({
  setWeatherConfig: (
    city: () => string,
    source: () => string,
    key: () => string,
    card: (value: unknown, context?: { runId?: string }) => void,
    enabled: () => boolean,
  ) => {
    h.weather = { city, source, key, card, enabled };
  },
  setUserTimezoneConfig: (getter: () => string | undefined) => {
    h.timezone = getter;
  },
  setSearchConfig: (
    engine: () => string,
    bocha: () => string,
    tavily: () => string,
    anySearch: () => string,
  ) => {
    h.search = { engine, bocha, tavily, anySearch };
  },
}));

vi.mock("../orchestrator/tools/travel-tools", () => ({
  setTravelConfig: (key: () => string, enabled: () => boolean) => {
    h.travel = { key, enabled };
  },
}));

vi.mock("../orchestrator/tools/email-tools", () => ({
  setEmailConfig: (
    enabled: () => boolean,
    host: () => string,
    port: () => number,
    secure: () => boolean,
    user: () => string,
    pass: () => string,
    fromName: () => string,
  ) => {
    h.email = { enabled, host, port, secure, user, pass, fromName };
  },
}));

vi.mock("../user-choice", () => ({
  setChoiceCardSender: (sender: (card: unknown) => void) => {
    h.choiceCard = sender;
  },
  setChoiceDismissSender: (sender: (settlement: unknown) => void) => {
    h.choiceDismiss = sender;
  },
}));

vi.mock("../asr/asr-config", () => ({
  setAsrConfig: (getter: () => unknown) => {
    h.asr = getter;
  },
}));

import { bootstrapConfigGetters } from "./bootstrap-config";
import { getVendorRuntimeSettings } from "../orchestrator/vendors/runtime-settings";
import { setReactChatWindow } from "../windows/window-state";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../../shared/custom-endpoint-state";

function general(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    weatherSource: "amap",
    amapKey: "amap-key",
    weatherEnabled: true,
    searchEngine: "bocha",
    searchBochaKey: "bocha-key",
    searchTavilyKey: "tavily-key",
    searchAnySearchKey: "any-key",
    travelEnabled: true,
    emailEnabled: true,
    emailSmtpHost: "smtp.example.com",
    emailSmtpPort: 587,
    emailSmtpSecure: false,
    emailSmtpUser: "user@example.com",
    emailSmtpPass: "pass",
    emailFromName: "Firefly",
    asrEngine: "mossland",
    asrMosslandKey: "moss-key",
    asrAliyunAppKey: "ali-app",
    asrAliyunAccessKeyId: "ali-id",
    asrAliyunAccessKeySecret: "ali-secret",
    asrLanguage: "zh",
    ...overrides,
  } as GeneralSettings;
}

function fakeWindow(destroyed = false) {
  const send = vi.fn((...args: unknown[]) => { h.sent.push(args); });
  return {
    isDestroyed: () => destroyed,
    webContents: { send },
  } as unknown as import("electron").BrowserWindow;
}

beforeEach(() => {
  h.model = {
    provider: "chatgpt",
    thinkingOverride: 1,
    disableMaxToken: true,
  };
  h.profile = { defaultCity: "Shanghai", timezone: "America/New_York" };
  h.general = general() as unknown as Record<string, unknown>;
  h.sent.length = 0;
  h.weather = {};
  h.search = {};
  h.timezone = undefined;
  h.travel = {};
  h.email = {};
  h.choiceCard = undefined;
  h.choiceDismiss = undefined;
  h.asr = undefined;
  setReactChatWindow(null);
});

function install(): void {
  bootstrapConfigGetters({ loadGeneralSettings: () => h.general as unknown as GeneralSettings });
}

describe("bootstrapConfigGetters", () => {
  it("wires every configuration getter", () => {
    install();
    expect(h.weather.city).toEqual(expect.any(Function));
    expect(h.weather.source).toEqual(expect.any(Function));
    expect(h.weather.key).toEqual(expect.any(Function));
    expect(h.weather.card).toEqual(expect.any(Function));
    expect(h.weather.enabled).toEqual(expect.any(Function));
    expect(h.timezone).toEqual(expect.any(Function));
    expect(h.choiceCard).toEqual(expect.any(Function));
    expect(h.choiceDismiss).toEqual(expect.any(Function));
    expect(h.search.engine).toEqual(expect.any(Function));
    expect(h.travel.key).toEqual(expect.any(Function));
    expect(h.email.host).toEqual(expect.any(Function));
    expect(h.asr).toEqual(expect.any(Function));
  });

  it("reads the user profile and general settings lazily", () => {
    install();
    const city = h.weather.city as () => string;
    const source = h.weather.source as () => string;
    const key = h.weather.key as () => string;
    const enabled = h.weather.enabled as () => boolean;
    expect(city()).toBe("Shanghai");
    expect(source()).toBe("amap");
    expect(key()).toBe("amap-key");
    expect(enabled()).toBe(true);

    h.profile = { defaultCity: "Beijing", timezone: "UTC" };
    h.general = general({ weatherSource: "open-meteo", amapKey: "", weatherEnabled: false }) as unknown as Record<string, unknown>;
    expect(city()).toBe("Beijing");
    expect(source()).toBe("open-meteo");
    expect(key()).toBe("");
    expect(enabled()).toBe(false);
  });

  it("sends weather cards with the run id when a live chat window exists", () => {
    install();
    setReactChatWindow(fakeWindow());
    const card = { source: "amap", location: { province: "上海", city: "上海" }, temp: 25, humidity: 60 };
    (h.weather.card as (value: unknown, context?: { runId?: string }) => void)(card, { runId: "run-1" });

    expect(h.sent).toEqual([[IPC.AGUI_EVENT, {
      type: "CUSTOM",
      name: "firefly.weather",
      value: card,
      runId: "run-1",
    }]]);
  });

  it("omits the run id when no context run is supplied and skips missing windows", () => {
    install();
    (h.weather.card as (value: unknown, context?: { runId?: string }) => void)({ temp: 1 });
    expect(h.sent).toEqual([]);

    setReactChatWindow(fakeWindow(true));
    (h.weather.card as (value: unknown, context?: { runId?: string }) => void)({ temp: 1 }, { runId: "run-2" });
    expect(h.sent).toEqual([]);

    setReactChatWindow(fakeWindow());
    (h.weather.card as (value: unknown, context?: { runId?: string }) => void)({ temp: 1 });
    expect(h.sent).toEqual([[IPC.AGUI_EVENT, {
      type: "CUSTOM",
      name: "firefly.weather",
      value: { temp: 1 },
    }]]);
  });

  it("sends choice cards and dismissals to the live chat window", () => {
    install();
    setReactChatWindow(fakeWindow());
    (h.choiceCard as (card: unknown) => void)({ id: "card-1" });
    (h.choiceDismiss as (settlement: unknown) => void)({ id: "card-1", revision: 2, reason: "timeout" });

    expect(h.sent).toEqual([
      [IPC.AGUI_EVENT, { type: "CUSTOM", name: "firefly.choice", value: { id: "card-1" } }],
      [IPC.AGUI_EVENT, {
        type: "CUSTOM",
        name: "firefly.choice.dismiss",
        value: { id: "card-1", revision: 2, reason: "timeout" },
      }],
    ]);
  });

  it("uses the profile timezone and search, travel and email settings", () => {
    install();
    expect((h.timezone as () => string)()).toBe("America/New_York");
    expect((h.search.engine as () => string)()).toBe("bocha");
    expect((h.search.bocha as () => string)()).toBe("bocha-key");
    expect((h.search.tavily as () => string)()).toBe("tavily-key");
    expect((h.search.anySearch as () => string)()).toBe("any-key");
    expect((h.travel.key as () => string)()).toBe("amap-key");
    expect((h.travel.enabled as () => boolean)()).toBe(true);
    expect((h.email.enabled as () => boolean)()).toBe(true);
    expect((h.email.host as () => string)()).toBe("smtp.example.com");
    expect((h.email.port as () => number)()).toBe(587);
    expect((h.email.secure as () => boolean)()).toBe(false);
    expect((h.email.user as () => string)()).toBe("user@example.com");
    expect((h.email.pass as () => string)()).toBe("pass");
    expect((h.email.fromName as () => string)()).toBe("Firefly");
  });

  it("resolves the ASR config for mossland, aliyun and disabled engines", () => {
    install();
    expect((h.asr as () => unknown)()).toEqual({ engine: "mossland", apiKey: "moss-key" });

    h.general = general({ asrEngine: "aliyun" }) as unknown as Record<string, unknown>;
    expect((h.asr as () => unknown)()).toEqual({
      engine: "aliyun",
      appKey: "ali-app",
      accessKeyId: "ali-id",
      accessKeySecret: "ali-secret",
      language: "zh",
    });

    h.general = general({ asrEngine: "off" }) as unknown as Record<string, unknown>;
    expect((h.asr as () => unknown)()).toBeNull();
  });

  it("returns sanitized runtime settings for preset vendors and passes custom values through", () => {
    install();
    expect(getVendorRuntimeSettings()).toEqual({ thinkingOverride: 0, disableMaxToken: false });

    h.model = {
      provider: CUSTOM_ENDPOINT_PROVIDERS.cloud,
      thinkingOverride: 1,
      disableMaxToken: true,
    };
    expect(getVendorRuntimeSettings()).toEqual({ thinkingOverride: 1, disableMaxToken: true });
  });
});
