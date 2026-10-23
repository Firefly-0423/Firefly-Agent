// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_TIMEOUT_SETTINGS } from "../../shared/timeout-types";
import { SPECIALIST_AGENTS } from "../../shared/specialist-agents";
import type { SettingsApi } from "./shared/types";
import { t } from "./i18n";
import { MODEL_PRESETS } from "./api/presets";
import { CUSTOM_ENDPOINT_GUIDE_BODY } from "./mcp/panel";

const readAsset = (name: string) => readFileSync(resolve(__dirname, name), "utf8");
const page = new JSDOM(readAsset("index.html")).window.document;

test("custom endpoints expose explicit cloud/local choices, help, field hints and no automatic transport", () => {
  const controls = page.getElementById("custom-endpoint-controls");
  expect(controls).not.toBeNull();
  for (const mode of ["cloud", "local"]) expect(page.querySelector(`[data-custom-endpoint-mode="${mode}"]`)).not.toBeNull();
  for (const id of ["custom-endpoint-guide-btn", "api-key-label", "api-key-hint", "transport-hint", "endpoint-preview"]) expect(page.getElementById(id), id).not.toBeNull();
  expect(page.querySelector('#transport-select [value="auto"]')).toBeNull();
});

test("the bundled provider artwork is an SVG with the custom endpoint title", () => {
  const svg = new JSDOM(readAsset("../public/icons/providers/custom-endpoint.svg"), { contentType: "image/svg+xml" }).window.document;
  expect(svg.documentElement.localName).toBe("svg");
  expect(svg.querySelector("title")?.textContent).toEqual("自定义端点");
});

test("the endpoint guide discloses the support boundary and provider-specific FAQ", () => {
  for (const copy of ["本地模型与自定义端点不在官方技术支持范围内", "本地模型回复格式异常", "MiniMax 思考模式失效", "Claude 配置项比其他厂商少"]) {
    expect(CUSTOM_ENDPOINT_GUIDE_BODY.includes(copy), copy).toBe(true);
  }
});

test("confirmed Anthropic URLs remain available in the actual presets", () => {
  const urls = MODEL_PRESETS.map(preset => preset.anthropicBaseUrl);
  for (const url of ["https://api.minimaxi.com/anthropic", "https://api.deepseek.com/anthropic", "https://open.bigmodel.cn/api/anthropic", "https://api.xiaomimimo.com/anthropic"]) expect(urls).toContain(url);
});

test("field layout aligns differing hint heights at the top", () => {
  const fieldRule = readAsset("settings.css").match(/\.field\s*\{([^}]*)\}/s)?.[1];
  expect(fieldRule).toMatch(/align-content:\s*start;/);
});


afterEach(() => { window.dispatchEvent(new Event("pagehide")); });
const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
async function openSettings() {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = readAsset("index.html");
  const provider = MODEL_PRESETS.find(preset => preset.shortName === "DeepSeek")!.providerName;
  let catalog = [
    { id: "daily-profile", provider, displayName: "Daily", model: "daily-model", baseUrl: "https://daily.example/v1", apiKey: "daily-secret", explicitTransport: "openai" },
    { id: "backup-profile", provider, displayName: "Backup", model: "backup-model", baseUrl: "https://backup.example/v1", apiKey: "backup-secret", explicitTransport: "responses" },
  ];
  const save = vi.fn(async (entry: typeof catalog[number]) => {
    catalog = catalog.map(profile => profile.id === entry.id ? entry : profile);
    return { profiles: catalog, added: false, defaultModelProfileId: "daily-profile" };
  });
  Object.assign(window, { settings: {
    getConfig: async () => ({ ...catalog[0], stickerEnabled: false }), getGeneral: async () => ({ language: "zh-CN" }),
    saveGeneral: async (patch: unknown) => patch, saveConfig: async (patch: unknown) => patch,
    listModelProfiles: async () => ({ profiles: catalog, defaultModelProfileId: "daily-profile" }), saveModelProfile: save,
    getTimeoutSettings: async () => DEFAULT_TIMEOUT_SETTINGS, saveTimeoutSettings: async (patch: unknown) => patch,
    getAgentRouting: async () => ({ profiles: [], routes: [], agents: SPECIALIST_AGENTS.map(agent => ({ ...agent })) }),
    channelsGetConfig: async () => ({ wechat: {}, feishu: {}, qq: {} }), channelsGetStatus: async () => ({}), channelsLogGet: async () => [],
    channelsContextBindingsGet: async () => ({ externalChats: [], bindings: [], conversations: [] }),
    onChannelsStatusChanged: () => () => undefined, onChannelsWechatQrcode: () => () => undefined,
    onChannelsWechatLoginDone: () => () => undefined, onChannelsInstallProgress: () => () => undefined,
  } as unknown as SettingsApi });
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".provider-row")).toHaveLength(2));
  await vi.waitFor(() => expect(field("save-status").textContent).toBe("等待保存"));
  return { save, profiles: () => catalog };
}

test("editing one of two same-provider profiles saves its catalog id and preserves the other profile", async () => {
  const app = await openSettings();
  document.querySelector<HTMLButtonElement>('[data-profile-id="backup-profile"] [data-profile-action="edit"]')!.click();
  expect(field<HTMLInputElement>("api-key").value).toEqual("backup-secret");
  field<HTMLInputElement>("model-input").value = "revised-backup-model";
  field("api-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(app.save).toHaveBeenCalledTimes(1));
  expect(app.save.mock.calls[0][0]).toMatchObject({ id: "backup-profile", model: "revised-backup-model", apiKey: "backup-secret" });
  expect(app.profiles()).toHaveLength(2);
  expect(app.profiles().find(profile => profile.id === "daily-profile")).toMatchObject({ model: "daily-model", apiKey: "daily-secret", baseUrl: "https://daily.example/v1" });
  await vi.waitFor(() => expect(field("save-status").classList.contains("is-ok")).toEqual(true));
});

test("vendor selection and cloud/local endpoint buttons update the displayed form and active mode", async () => {
  await openSettings();
  field("add-profile-btn").click();
  // Select a provider by its exported catalog identity rather than an internal state variable.
  const kimi = MODEL_PRESETS.find(preset => preset.shortName === "Kimi")!;
  const card = [...document.querySelectorAll<HTMLButtonElement>("#preset-cards .preset-card")].find(button => button.dataset.provider === kimi.providerName)!;
  card.click();
  expect(field<HTMLInputElement>("base-url").value).toEqual(kimi.baseUrl);
  document.querySelector<HTMLButtonElement>('#transport-select [data-value="anthropic"]')!.click();
  expect(field("transport-hint").textContent).toEqual(t("settings.api.anthropicHintMissing"));
  // Restore the protocol before changing drafts so the form stays clean.
  document.querySelector<HTMLButtonElement>('#transport-select [data-value="openai"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-provider-tab="custom"]')!.click();
  for (const mode of ["local", "cloud"] as const) {
    document.querySelector<HTMLButtonElement>(`[data-custom-endpoint-mode="${mode}"]`)!.click();
    expect([...document.querySelectorAll<HTMLElement>("[data-custom-endpoint-mode]")].filter(button => button.classList.contains("is-active")).map(button => button.dataset.customEndpointMode)).toEqual([mode]);
    expect(document.querySelector(`[data-custom-endpoint-mode="${mode}"]`)!.getAttribute("aria-pressed")).toEqual("true");
    expect(field<HTMLInputElement>("base-url").placeholder).toBe(mode === "local" ? "http://127.0.0.1:11434/v1" : "https://your-provider.example/v1");
  }
});
