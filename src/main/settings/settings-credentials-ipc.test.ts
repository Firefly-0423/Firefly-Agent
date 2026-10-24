import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const state = vi.hoisted(() => ({ directory: "", isDev: true }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory, getAppPath: () => state.directory }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../startup/env", () => ({ get isDev() { return state.isDev; } }));
beforeEach(() => {
  vi.resetModules();
  state.isDev = true;
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-secret-ipc-"));
});
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));

async function setup() {
  const model = await import("./model-settings");
  const general = await import("./settings-facade");
  model.saveModelSettings({ modelProfiles: [
    { id: "one", provider: "fixture", model: "one", apiKey: "model-secret" },
    { id: "two", provider: "fixture", model: "two", apiKey: "other-model-secret" },
  ] });
  general.saveGeneralSettings({ emailSmtpPass: "mail-secret", asrMosslandKey: "asr-secret", searchBochaKey: "search-secret", language: "en" });
  const windows = await import("../windows/window-state");
  const host = (page: string, id: number) => ({ isDestroyed: () => false, webContents: {
    id, isDestroyed: () => false, send: vi.fn(), mainFrame: { url: state.isDev
      ? `http://localhost:5173/${page ? page + "/" : ""}`
      : pathToFileURL(path.join(state.directory, "dist", "renderer", page, "index.html")).href },
  } });
  const settings = host("settings", 1), chat = host("react", 2), pet = host("", 3);
  windows.setSettingsWindow(settings as never);
  windows.setReactChatWindow(chat as never);
  const from = (win: typeof settings) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const handlers = new Map<string, (...args: any[]) => any>();
  const { registerSettingsIpc } = await import("./settings-ipc");
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler), on: vi.fn() },
    getModelSettings: model.loadModelSettings, saveModelSettings: model.saveModelSettings,
    getGeneralSettings: general.loadGeneralSettings, saveGeneralSettings: general.saveGeneralSettings,
    windowManager: { isPetWindowSender: (id: number) => id === pet.webContents.id },
  } as never);
  return { handlers, settings, chat, pet, from, host, model, general };
}

it.each([true, false])("returns editable credentials only to the settings document (development=%s)", async (isDev) => {
  state.isDev = isDev;
  const h = await setup();
  h.settings.webContents.mainFrame.url += "#api";
  expect(h.handlers.get(IPC.SETTINGS_MODEL_PROFILES_LIST)!(h.from(h.settings)).profiles[0].apiKey).toBe("model-secret");
  expect(h.handlers.get(IPC.SETTINGS_GET_GENERAL)!(h.from(h.settings))).toMatchObject({ emailSmtpPass: "mail-secret", asrMosslandKey: "asr-secret" });
  expect(h.handlers.get(IPC.SETTINGS_GET_CONFIG)!(h.from(h.settings)).modelProfiles[0].apiKey).toBe("model-secret");
  for (const win of [h.chat, h.pet]) {
    const view = h.handlers.get(IPC.SETTINGS_GET_GENERAL)!(h.from(win));
    expect(view).toMatchObject({ language: "en", emailSmtpPass: "********", asrMosslandKey: "********", searchBochaKey: "********" });
    expect(JSON.stringify(view)).not.toMatch(/mail-secret|asr-secret|search-secret/);
  }
  const catalog = h.handlers.get(IPC.SETTINGS_MODEL_PROFILES_LIST)!(h.from(h.chat));
  expect(catalog.profiles[0]).toMatchObject({ model: "one", apiKey: "********" });
  expect(JSON.stringify(catalog)).not.toContain("model-secret");
  expect(h.model.loadModelSettings().modelProfiles?.[0].apiKey).toBe("model-secret");
  expect(h.general.loadGeneralSettings().emailSmtpPass).toBe("mail-secret");
});

it("masks chat save, default selection and deletion responses while keeping catalog operations working", async () => {
  const h = await setup();
  const saved = await h.handlers.get(IPC.SETTINGS_SAVE_GENERAL)!(h.from(h.chat), { language: "zh-CN" });
  expect(saved).toMatchObject({ language: "zh-CN", emailSmtpPass: "********" });
  const selected = h.handlers.get(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT)!(h.from(h.chat), "two");
  expect(selected.defaultModelProfileId).toBe("two");
  expect(JSON.stringify(selected)).not.toContain("model-secret");
  const deleted = h.handlers.get(IPC.SETTINGS_MODEL_PROFILE_DELETE)!(h.from(h.chat), "one");
  expect(deleted.profiles).toHaveLength(1);
  expect(deleted.profiles[0]).toMatchObject({ id: "two", apiKey: "********" });
  expect(h.model.loadModelSettings().modelProfiles?.[0].apiKey).toBe("other-model-secret");
});

it("rejects foreign windows, subframes, navigated and destroyed hosts before secret reads or writes", async () => {
  const h = await setup();
  const calls = [
    [IPC.SETTINGS_GET_CONFIG], [IPC.SETTINGS_MODEL_PROFILES_LIST], [IPC.SETTINGS_SAVE_CONFIG, { apiKey: "replacement" }],
    [IPC.SETTINGS_MODEL_PROFILE_SAVE, { id: "one", provider: "fixture", model: "edited", apiKey: "replacement" }],
    [IPC.SETTINGS_MODEL_PROFILE_DELETE, "one"], [IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, "two"],
  ] as const;
  const before = fs.readFileSync(path.join(state.directory, "model-settings.json"), "utf8");
  const reject = (event: unknown) => {
    for (const [channel, input] of calls) expect(() => h.handlers.get(channel)!(event, input)).toThrow("MODEL_SETTINGS_FORBIDDEN");
    expect(() => h.handlers.get(IPC.SETTINGS_GET_GENERAL)!(event)).toThrow("GENERAL_SETTINGS_FORBIDDEN");
  };
  reject(undefined);
  reject(h.from(h.host("settings", 99)));
  reject({ ...h.from(h.settings), senderFrame: { url: h.settings.webContents.mainFrame.url } });
  h.settings.webContents.mainFrame.url = "https://example.test/settings/";
  reject(h.from(h.settings));
  h.settings.webContents.mainFrame.url = "http://localhost:5173/settings/?untrusted=1";
  reject(h.from(h.settings));
  h.settings.webContents.mainFrame.url = "http://localhost:5173/settings/";
  h.settings.isDestroyed = () => true;
  reject(h.from(h.settings));
  h.settings.isDestroyed = () => false;
  h.settings.webContents.isDestroyed = () => true;
  reject(h.from(h.settings));
  expect(fs.readFileSync(path.join(state.directory, "model-settings.json"), "utf8")).toBe(before);
});

it("keeps full config and profile saves confined to settings while preserving its editor responses", async () => {
  const h = await setup();
  for (const channel of [IPC.SETTINGS_GET_CONFIG, IPC.SETTINGS_SAVE_CONFIG, IPC.SETTINGS_MODEL_PROFILE_SAVE]) {
    expect(() => h.handlers.get(channel)!(h.from(h.chat), {})).toThrow("MODEL_SETTINGS_FORBIDDEN");
  }
  const saved = h.handlers.get(IPC.SETTINGS_MODEL_PROFILE_SAVE)!(h.from(h.settings), { id: "one", provider: "fixture", model: "edited", apiKey: "new-model-secret" });
  expect(saved.profiles[0]).toMatchObject({ id: "one", model: "edited", apiKey: "new-model-secret" });
  const config = h.handlers.get(IPC.SETTINGS_SAVE_CONFIG)!(h.from(h.settings), { stickerEnabled: true });
  expect(config).toMatchObject({ stickerEnabled: true, modelProfiles: expect.any(Array) });
  expect(config.modelProfiles[0].apiKey).toBe("new-model-secret");
  const general = await h.handlers.get(IPC.SETTINGS_SAVE_GENERAL)!(h.from(h.settings), { language: "zh-CN" });
  expect(general.emailSmtpPass).toBe("mail-secret");
});
