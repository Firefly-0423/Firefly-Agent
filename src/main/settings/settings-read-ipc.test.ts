import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory, getAppPath: () => process.cwd() }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../startup/env", () => ({ isDev: true }));
beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-settings-ipc-"));
});
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));

it("rejects plugin enablement through general settings without changing disk or notifying consumers", async () => {
  const general = await import("./settings-facade");
  general.saveGeneralSettings({ plugins: { "fixture-plugin": false } });
  const file = path.join(state.directory, "app-settings.json");
  const before = fs.readFileSync(file, "utf8");
  const save = vi.fn(general.saveGeneralSettings);
  const { registerSettingsIpc } = await import("./settings-ipc");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
    getGeneralSettings: general.loadGeneralSettings, saveGeneralSettings: save,
  } as never);
  await expect(handlers.get(IPC.SETTINGS_SAVE_GENERAL)!(undefined, {
    plugins: { "fixture-plugin": true }, language: "en",
  })).rejects.toThrow("GENERAL_SETTINGS_PLUGINS_FORBIDDEN");
  expect(save).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("accepts settings and chat documents, but rejects foreign, child and navigated callers before saving", async () => {
  const windows = await import("../windows/window-state");
  const host = (page: string) => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false, mainFrame: { url: `http://localhost:5173/${page}/` },
  } });
  const settings = host("settings"), chat = host("react");
  windows.setSettingsWindow(settings as never);
  windows.setReactChatWindow(chat as never);
  const general = await import("./settings-facade");
  general.saveGeneralSettings({ plugins: { "fixture-plugin": false } });
  const save = vi.fn(general.saveGeneralSettings);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const { registerSettingsIpc } = await import("./settings-ipc");
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
    getGeneralSettings: general.loadGeneralSettings, saveGeneralSettings: save,
  } as never);
  const update = handlers.get(IPC.SETTINGS_SAVE_GENERAL)!;
  const from = (win: typeof settings) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  for (const win of [settings, chat]) await expect(update(from(win), { language: "en" })).resolves.toMatchObject({ plugins: { "fixture-plugin": false } });
  save.mockClear();
  const file = path.join(state.directory, "app-settings.json"), before = fs.readFileSync(file, "utf8");
  for (const event of [undefined, from(host("settings")), { ...from(settings), senderFrame: {} }]) {
    await expect(update(event, { language: "zh" })).rejects.toThrow("GENERAL_SETTINGS_FORBIDDEN");
  }
  settings.webContents.mainFrame.url = "https://example.com/settings/";
  await expect(update(from(settings), { language: "zh" })).rejects.toThrow("GENERAL_SETTINGS_FORBIDDEN");
  for (const value of [null, [], "invalid"]) await expect(update(from(chat), value)).rejects.toThrow("GENERAL_SETTINGS_INVALID");
  await expect(update(from(chat), { plugins: {} })).rejects.toThrow("GENERAL_SETTINGS_PLUGINS_FORBIDDEN");
  expect(save).not.toHaveBeenCalled();
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("rejects config and catalog IPC reads without exposing corrupt content or writing defaults", async () => {
  for (const filename of ["model-settings.json", "app-settings.json"]) fs.writeFileSync(path.join(state.directory, filename), "{broken");
  const model = await import("./model-settings");
  const general = await import("./settings-facade");
  const { registerSettingsIpc } = await import("./settings-ipc");
  const windows = await import("../windows/window-state");
  const webContents = { isDestroyed: () => false, mainFrame: { url: "http://localhost:5173/settings/" } };
  windows.setSettingsWindow({ isDestroyed: () => false, webContents } as never);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
    getModelSettings: model.loadModelSettings,
    getGeneralSettings: general.loadGeneralSettings,
  } as never);
  for (const channel of [IPC.SETTINGS_GET_CONFIG, IPC.SETTINGS_MODEL_PROFILES_LIST, IPC.MODEL_CONFIG_GET, IPC.SETTINGS_AGENT_ROUTING_GET, IPC.SETTINGS_AGENT_ROUTING_UPDATE]) {
    await expect(Promise.resolve().then(() => handlers.get(channel)!(event))).rejects.toThrow("MODEL_SETTINGS_READ_FAILED");
  }
  await expect(Promise.resolve().then(() => (handlers.get(IPC.SETTINGS_GET_GENERAL) as Function)({ sender: webContents, senderFrame: webContents.mainFrame }))).rejects.toThrow("GENERAL_SETTINGS_READ_FAILED");
  for (const filename of ["model-settings.json", "app-settings.json"]) expect(fs.readFileSync(path.join(state.directory, filename), "utf8")).toBe("{broken");
});

it("reads general settings only from live owned documents, including the pet", async () => {
  const windows = await import("../windows/window-state");
  const settings = { id: 1, isDestroyed: () => false, mainFrame: { url: "http://localhost:5173/settings/#plugins" } };
  const pet = { id: 2, isDestroyed: () => false, mainFrame: { url: "http://localhost:5173/" } };
  windows.setSettingsWindow({ isDestroyed: () => false, webContents: settings } as never);
  const read = vi.fn(() => ({ language: "en" }));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const { registerSettingsIpc } = await import("./settings-ipc");
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
    getGeneralSettings: read, windowManager: { isPetWindowSender: (id: number) => id === pet.id },
  } as never);
  const get = handlers.get(IPC.SETTINGS_GET_GENERAL)!;
  const from = (sender: typeof pet) => ({ sender, senderFrame: sender.mainFrame });
  expect(get(from(settings))).toEqual({ language: "en" });
  expect(get(from(pet))).toEqual({ language: "en" });
  read.mockClear();
  for (const event of [undefined, from({ ...pet, id: 3 }), { ...from(settings), senderFrame: {} }]) {
    expect(() => get(event)).toThrow("GENERAL_SETTINGS_FORBIDDEN");
  }
  pet.mainFrame.url = "https://example.com/";
  expect(() => get(from(pet))).toThrow("GENERAL_SETTINGS_FORBIDDEN");
  settings.isDestroyed = () => true;
  expect(() => get(from(settings))).toThrow("GENERAL_SETTINGS_FORBIDDEN");
  expect(read).not.toHaveBeenCalled();
});

it("persists individual routing identities through Main IPC without returning model secrets", async () => {
  const model = await import("./model-settings");
  model.saveModelSettings({ modelProfiles: [{ id: "public-local", provider: "test", model: "fixture", baseUrl: "http://127.0.0.1:12345", apiKey: "private-fixture" }] });
  const { registerSettingsIpc } = await import("./settings-ipc");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSettingsIpc({
    ipc: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() },
    getModelSettings: model.loadModelSettings, saveModelSettings: model.saveModelSettings,
  } as never);
  const update = handlers.get(IPC.SETTINGS_AGENT_ROUTING_UPDATE)!;
  update(undefined, { kind: "route", id: "reasoning", profileId: "public-local" });
  const result = update(undefined, { kind: "agent", id: "review", profileId: "public-local" });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|apiKey|baseUrl/);
  expect(model.loadModelSettings().specialistModelProfiles).toEqual({ review: "public-local" });
  model.saveModelSettings({ displayName: "unrelated fixture edit" });
  expect(model.loadModelSettings().specialistModelProfiles).toEqual({ review: "public-local" });
  const before = fs.readFileSync(path.join(state.directory, "model-settings.json"), "utf8");
  expect(() => update(undefined, { kind: "agent", id: "review", profileId: "missing" })).toThrow();
  expect(fs.readFileSync(path.join(state.directory, "model-settings.json"), "utf8")).toBe(before);
});
