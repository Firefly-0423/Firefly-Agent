import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { GeneralSettings } from "./general-settings";
import type { WindowManager } from "../windows/window-manager";
import { applyGeneralSettings, handleGeneralSettingsChanged } from "./general-settings-lifecycle";

const environment = vi.hoisted(() => ({ profile: "production" }));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ profile: { kind: environment.profile } }) }));
vi.mock("electron", () => ({ nativeImage: {}, app: { setLoginItemSettings: vi.fn() } }));
vi.mock("../locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../windows/window-state", () => ({ setGetCurrentAppIconPath: vi.fn() }));
vi.mock("../windows/broadcast", () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock("../windows/app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("./model-settings", () => ({ getPublicModelConfig: vi.fn(), loadModelSettings: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ syncBuiltInToolToggles: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({ listMcpServers: () => [], removeMcpServer: vi.fn(), addMcpServer: vi.fn() }));

function desktop(savedVisibility: boolean, actualVisibility = savedVisibility) {
  let onScreen = actualVisibility;
  const preferences = {
    petZoom: 1, petVisible: savedVisibility, petAlwaysOnTop: true,
    searchEngine: "off", asrEngine: "off", launchAtLogin: false,
  } as GeneralSettings;
  const windows = {
    applyPetWindowZoom: vi.fn(), setPetWindowAlwaysOnTop: vi.fn(), broadcast: vi.fn(),
    hidePetWindow: vi.fn(() => { onScreen = false; }),
    showPetWindow: vi.fn(() => { onScreen = true; }),
  };
  const dependencies = {
    windowManager: windows as unknown as WindowManager, screenshotService: null, tray: null,
    proactiveLifecycle: { getProactiveChatService: () => null }, broadcastToAuxWindows: vi.fn(),
  };
  return { preferences, windows, dependencies, visible: () => onScreen };
}

beforeEach(() => {
  environment.profile = "production";
  vi.clearAllMocks();
});

describe("Restoring desktop preferences", () => {
  it.each([false, true])("restores every window setting at startup, visibility=%s", (shown) => {
    const d = desktop(shown, !shown);
    applyGeneralSettings(d.preferences, d.dependencies);
    expect(d.visible()).toBe(shown);
    expect(d.windows.showPetWindow).toHaveBeenCalledTimes(shown ? 1 : 0);
    expect(d.windows.hidePetWindow).toHaveBeenCalledTimes(shown ? 0 : 1);
    expect(d.windows.applyPetWindowZoom.mock.calls).toEqual([[1]]);
    expect(d.windows.setPetWindowAlwaysOnTop.mock.calls).toEqual([[true]]);
    expect(vi.mocked(app.setLoginItemSettings).mock.calls).toEqual([[{ openAtLogin: false }]]);
  });

  it.each([false, true])("applies a saved visibility transition to %s once", (shown) => {
    const d = desktop(!shown);
    handleGeneralSettingsChanged(d.preferences, { ...d.preferences, petVisible: shown }, d.dependencies);
    expect(d.visible()).toBe(shown);
    expect(d.windows.hidePetWindow).toHaveBeenCalledTimes(Number(!shown));
    expect(d.windows.showPetWindow).toHaveBeenCalledTimes(Number(shown));
  });

  for (const profile of ["test", "smoke", "development"]) {
    it.each([false, true])(`restores window zoom without login writes in ${profile} (%s)`, (flag) => {
      environment.profile = profile;
      const d = desktop(true);
      applyGeneralSettings({ ...d.preferences, launchAtLogin: flag }, d.dependencies);
      expect(app.setLoginItemSettings).toHaveBeenCalledTimes(0);
      expect(d.windows.applyPetWindowZoom.mock.calls).toEqual([[1]]);
    });

    it.each([false, true])(`ignores OS login changes when saving ${profile} (%s)`, (flag) => {
      environment.profile = profile;
      const d = desktop(true);
      handleGeneralSettingsChanged(
        { ...d.preferences, launchAtLogin: !flag },
        { ...d.preferences, launchAtLogin: flag }, d.dependencies,
      );
      expect(app.setLoginItemSettings).toHaveBeenCalledTimes(0);
    });
  }
});

describe("Saving settings while visibility differs from disk", () => {
  it("preserves a tray-hidden pet during an ASR provider change", () => {
    const d = desktop(true, false);
    handleGeneralSettingsChanged(d.preferences, { ...d.preferences, asrEngine: "aliyun" }, d.dependencies);
    expect(d.visible()).toBe(false);
    expect(d.windows.showPetWindow.mock.calls).toEqual([]);
    expect(d.windows.setPetWindowAlwaysOnTop.mock.calls).toEqual([]);
    expect(d.windows.applyPetWindowZoom.mock.calls).toEqual([]);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(0);
  });

  it("preserves a manually revealed pet during an unrelated save", () => {
    const d = desktop(false, true);
    handleGeneralSettingsChanged(d.preferences, { ...d.preferences, asrEngine: "local" }, d.dependencies);
    expect(d.visible()).toBe(true);
    expect(d.windows.hidePetWindow.mock.calls).toEqual([]);
  });

  it("updates zoom, stacking and login without revealing a hidden window", () => {
    const d = desktop(true, false);
    handleGeneralSettingsChanged(d.preferences, {
      ...d.preferences, petZoom: 1.5, launchAtLogin: true, petAlwaysOnTop: false,
    }, d.dependencies);
    expect(d.visible()).toBe(false);
    expect(d.windows.showPetWindow.mock.calls).toEqual([]);
    expect(d.windows.setPetWindowAlwaysOnTop.mock.calls).toEqual([[false]]);
    expect(d.windows.applyPetWindowZoom.mock.calls).toEqual([[1.5]]);
    expect(vi.mocked(app.setLoginItemSettings).mock.calls).toEqual([[{ openAtLogin: true }]]);
  });

  it("emits one color payload and treats a value-identical copy as unchanged", () => {
    const d = desktop(true);
    const palette = { enabled: true, accent: "#925bdb", background: "#faf7ef", foreground: "#231d31" };
    const saved = { ...d.preferences, uiColors: palette };
    handleGeneralSettingsChanged(d.preferences, saved, d.dependencies);
    expect(d.windows.broadcast.mock.calls).toEqual([[IPC.UI_COLORS_CHANGED, palette]]);
    d.windows.broadcast.mockClear();
    handleGeneralSettingsChanged(saved, { ...saved, uiColors: { ...palette } }, d.dependencies);
    expect(d.windows.broadcast.mock.calls).toEqual([]);
  });
});