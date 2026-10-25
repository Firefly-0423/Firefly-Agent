import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    files: new Map<string, string>(),
    writes: [] as Array<{ file: string; content: string }>,
    mkdirs: [] as string[],
    trays: [] as Array<Record<string, unknown>>,
    appOn: new Map<string, (...args: unknown[]) => void>(),
    processOnce: new Map<string, (...args: unknown[]) => void>(),
    withinResult: true,
    configReady: true,
    prepared: { profileCount: 1, eligibleProfiles: 1, reasons: [] as unknown[] },
    model: { provider: "chatgpt" },
    vendorGetter: undefined as (() => unknown) | undefined,
    controllerDeps: undefined as Record<string, unknown> | undefined,
    entryDeps: undefined as Record<string, unknown> | undefined,
    app: {
      isReady: vi.fn(() => true),
      isPackaged: false,
      getPath: vi.fn(() => "C:/appdata"),
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { state.appOn.set(event, listener); }),
      whenReady: vi.fn(async () => {}),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    menu: { buildFromTemplate: vi.fn(() => ({ built: true })) },
    controller: {
      install: vi.fn(),
      prepare: vi.fn(async () => {}),
      cancel: vi.fn(),
    },
    createDiagnosticController: vi.fn((deps: Record<string, unknown>) => {
      state.controllerDeps = deps;
      return state.controller;
    }),
    createMainProbeEntry: vi.fn((_enabled: boolean, deps: Record<string, unknown>) => {
      state.entryDeps = deps;
      return { run: vi.fn(async () => {}), cancel: vi.fn() };
    }),
    loadTrayIcon: vi.fn(() => "icon"),
    prepareCache: vi.fn(() => state.configReady),
    resolveVendor: vi.fn((settings: Record<string, unknown>) => ({ resolvedFrom: settings.provider })),
    setVendorGetter: vi.fn((getter: () => unknown) => { state.vendorGetter = getter; }),
    inspectPreparedProfiles: vi.fn(() => state.prepared),
    resolveProfile: vi.fn(),
    listProfileIds: vi.fn(() => ["profile-1"]),
    getCachedProfile: vi.fn(),
    initializeStorageContext: vi.fn(),
    applyElectronPaths: vi.fn(),
    resolveRuntimeProfile: vi.fn(() => ({ kind: "smoke", userData: "C:/isolated", profile: true })),
    getFireflyApplicationDataPath: vi.fn(() => "C:/appdata"),
  };
  state.controller = Object.assign(state.controller, {});
  return state;
});

vi.mock("electron", () => ({
  app: h.app,
  dialog: h.dialog,
  Menu: h.menu,
  Tray: class {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    isDestroyed = vi.fn(() => false);
    destroy = vi.fn();
    constructor(readonly icon: unknown) {
      h.trays.push(this);
    }
  },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (file: string) => h.files.has(file),
    writeFileSync: (file: string, content: string) => {
      h.files.set(file, content);
      h.writes.push({ file, content });
    },
    mkdirSync: (directory: string) => {
      h.mkdirs.push(directory);
    },
  },
}));

vi.mock("../startup/runtime-profile", () => ({
  applyElectronPaths: h.applyElectronPaths,
  canonicalPath: (value: string) => value,
  resolveRuntimeProfile: h.resolveRuntimeProfile,
  within: () => h.withinResult,
}));

vi.mock("../startup/app-identity", () => ({
  getFireflyApplicationDataPath: h.getFireflyApplicationDataPath,
}));

vi.mock("../storage/storage-context", () => ({
  initializeStorageContext: h.initializeStorageContext,
}));

vi.mock("../windows/tray-icon", () => ({
  loadTrayIcon: h.loadTrayIcon,
}));

vi.mock("../settings/model-settings", () => ({
  getCachedSavedModelProfile: h.getCachedProfile,
  listCachedSavedModelProfileIds: h.listProfileIds,
  loadModelSettings: () => h.model,
  prepareReadOnlyDiagnosticModelCache: h.prepareCache,
}));

vi.mock("../orchestrator/vendors/runtime-settings", () => ({
  resolveVendorRuntimeSettings: h.resolveVendor,
  setVendorRuntimeSettingsGetter: h.setVendorGetter,
}));

vi.mock("./preparation-diagnostics", () => ({
  inspectPreparedProfiles: h.inspectPreparedProfiles,
}));

vi.mock("./diagnostic-controller", () => ({
  createDiagnosticController: h.createDiagnosticController,
}));

vi.mock("./main-entry", () => ({
  createMainProbeEntry: h.createMainProbeEntry,
}));

vi.mock("./runner", () => ({
  ADMISSION_ROOT: "C:\\admission",
}));

import { startDiagnosticMain } from "./diagnostic-main";
import { ADMISSION_ROOT } from "./runner";

const REQUESTED_ROOT = "C:\\diagnostics\\run";
const READINESS = path.join(REQUESTED_ROOT, "readiness.json");

function readinessWrites(): Array<Record<string, unknown>> {
  return h.writes
    .filter((entry) => entry.file === READINESS)
    .map((entry) => JSON.parse(entry.content) as Record<string, unknown>);
}

function lastReadiness(): Record<string, unknown> | undefined {
  return readinessWrites().at(-1);
}

beforeEach(() => {
  process.env.FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT = REQUESTED_ROOT;
  h.files.clear();
  h.writes.length = 0;
  h.mkdirs.length = 0;
  h.trays.length = 0;
  h.appOn.clear();
  h.processOnce.clear();
  h.withinResult = true;
  h.configReady = true;
  h.prepared = { profileCount: 1, eligibleProfiles: 1, reasons: [] };
  h.model = { provider: "chatgpt" };
  h.vendorGetter = undefined;
  h.controllerDeps = undefined;
  h.entryDeps = undefined;
  h.app.exit.mockClear();
  h.app.quit.mockClear();
  h.app.requestSingleInstanceLock.mockReset().mockReturnValue(true);
  h.app.whenReady.mockReset().mockResolvedValue(undefined);
  h.dialog.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  h.menu.buildFromTemplate.mockClear();
  h.controller.install.mockClear();
  h.controller.prepare.mockClear();
  h.controller.cancel.mockClear();
  h.createDiagnosticController.mockClear();
  h.createMainProbeEntry.mockClear();
  h.loadTrayIcon.mockClear();
  h.prepareCache.mockReset().mockReturnValue(true);
  h.resolveVendor.mockClear();
  h.setVendorGetter.mockClear();
  h.inspectPreparedProfiles.mockClear();
  h.getCachedProfile.mockClear();
  h.listProfileIds.mockClear();
  h.initializeStorageContext.mockClear();
  h.applyElectronPaths.mockClear();
  h.resolveRuntimeProfile.mockClear();

  vi.spyOn(process, "once").mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
    h.processOnce.set(event, listener);
    return process;
  }) as never);
  vi.spyOn(process.stdout, "on").mockImplementation((() => process.stdout) as never);
  vi.spyOn(process.stderr, "on").mockImplementation((() => process.stderr) as never);
});

afterEach(() => {
  delete process.env.FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT;
  vi.restoreAllMocks();
});

describe("startDiagnosticMain root admission", () => {
  it("refuses a relative diagnostic root without touching the runtime", async () => {
    process.env.FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT = "relative-root";
    await startDiagnosticMain();

    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(h.app.whenReady).not.toHaveBeenCalled();
    expect(h.mkdirs).toEqual([]);
    expect(h.trays).toEqual([]);
  });

  it("refuses a root outside the fixed diagnostic base", async () => {
    h.withinResult = false;
    await startDiagnosticMain();

    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(h.mkdirs).toEqual([]);
    expect(h.app.whenReady).not.toHaveBeenCalled();
  });

  it("writes a secondary marker and exits 0 when another instance holds the lock", async () => {
    h.app.requestSingleInstanceLock.mockReturnValue(false);
    await startDiagnosticMain();

    const secondary = path.join(REQUESTED_ROOT, `secondary-${process.pid}.json`);
    expect(JSON.parse(h.files.get(secondary)!)).toEqual({
      pid: process.pid,
      secondary: true,
      configurationPrepared: false,
      permitCreated: false,
    });
    expect(h.app.exit).toHaveBeenCalledWith(0);
    expect(h.app.whenReady).not.toHaveBeenCalled();
    expect(h.trays).toEqual([]);
  });

  it("records the admission markers in readiness", async () => {
    h.files.set(path.join(ADMISSION_ROOT, "arm.json"), "{}");
    h.files.set(path.join(ADMISSION_ROOT, "boot.json"), "{}");
    await startDiagnosticMain();

    expect(lastReadiness()).toMatchObject({
      pid: process.pid,
      isReady: true,
      menuReady: false,
      duplicateCount: 0,
      admission: { armed: true, bootBound: true, spent: false, ledger: false },
    });
  });
});

describe("startDiagnosticMain startup flow", () => {
  it("applies the isolated profile, installs the controller and shows the entry dialog", async () => {
    await startDiagnosticMain();

    expect(h.resolveRuntimeProfile).toHaveBeenCalledTimes(2);
    expect(h.applyElectronPaths).toHaveBeenCalledWith(h.app, expect.objectContaining({ kind: "smoke" }));
    expect(h.initializeStorageContext).toHaveBeenCalledWith(expect.objectContaining({ kind: "smoke" }));
    expect(h.loadTrayIcon).toHaveBeenCalledTimes(1);
    expect(h.trays).toHaveLength(1);
    expect(h.trays[0].setToolTip).toHaveBeenCalledWith("Firefly H：受限测试");
    expect(h.createDiagnosticController).toHaveBeenCalledTimes(1);
    expect(h.controller.install).toHaveBeenCalledTimes(1);
    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(h.controller.prepare).not.toHaveBeenCalled();
    expect(h.app.exit).not.toHaveBeenCalled();
  });

  it("prepares the existing configuration when the user chooses the first button", async () => {
    h.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await startDiagnosticMain();

    expect(h.controller.prepare).toHaveBeenCalledTimes(1);
  });

  it("exposes a menu and state writer that update readiness through the controller", async () => {
    await startDiagnosticMain();
    const deps = h.controllerDeps as {
      setMenu: (items: unknown[]) => void;
      writeState: (state: Record<string, unknown>) => void;
    };
    deps.setMenu([{ label: "one" }]);
    expect(h.menu.buildFromTemplate).toHaveBeenCalledWith([{ label: "one" }]);
    expect(h.trays[0].setContextMenu).toHaveBeenCalledWith({ built: true });

    deps.writeState({ phase: "ready-to-test", configurationPrepared: true });
    expect(lastReadiness()).toMatchObject({
      menuReady: true,
      phase: "ready-to-test",
      configurationPrepared: true,
    });
  });

  it("loads the existing configuration only when the preparation cache is ready", async () => {
    await startDiagnosticMain();
    const deps = h.controllerDeps as { loadExistingConfiguration: () => boolean };

    h.prepareCache.mockReturnValue(false);
    expect(deps.loadExistingConfiguration()).toBe(false);
    expect(h.setVendorGetter).not.toHaveBeenCalled();

    h.prepareCache.mockReturnValue(true);
    expect(deps.loadExistingConfiguration()).toBe(true);
    expect(h.prepareCache).toHaveBeenCalledWith(expect.objectContaining({ kind: "smoke" }));
    expect(h.setVendorGetter).toHaveBeenCalledTimes(1);
    expect(h.vendorGetter?.()).toEqual({ resolvedFrom: "chatgpt" });
    expect(h.resolveVendor).toHaveBeenCalledWith(h.model);
  });

  it("creates the probe entry only with a receipt callback and fixed admission root", async () => {
    await startDiagnosticMain();
    const deps = h.controllerDeps as { createEntry: (cb: (receipt: unknown) => void) => unknown };
    const receipt = vi.fn();
    const entry = deps.createEntry(receipt);

    expect(entry).toBeTruthy();
    expect(h.createMainProbeEntry).toHaveBeenCalledWith(true, expect.objectContaining({
      root: ADMISSION_ROOT,
      resolveProfile: h.getCachedProfile,
      listProfileIds: h.listProfileIds,
      fetch: globalThis.fetch,
      now: Date.now,
      onReceipt: receipt,
    }));
    expect(h.entryDeps?.show).toEqual(expect.any(Function));
  });
});

describe("startDiagnosticMain window callbacks", () => {
  it("counts a second instance and persists the count", async () => {
    await startDiagnosticMain();
    h.writes.length = 0;
    h.appOn.get("second-instance")?.({}, [], "cwd");
    expect(lastReadiness()).toMatchObject({ duplicateCount: 1 });
  });

  it("cancels the controller and destroys the tray before quitting", async () => {
    await startDiagnosticMain();
    h.appOn.get("before-quit")?.();
    expect(h.controller.cancel).toHaveBeenCalledTimes(1);
    expect(h.trays[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("marks startup refused and exits 1 when app readiness fails", async () => {
    h.app.whenReady.mockRejectedValueOnce(new Error("no ready"));
    await startDiagnosticMain();

    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(lastReadiness()).toMatchObject({ phase: "startup-refused" });
    expect(h.controller.install).not.toHaveBeenCalled();
  });

  it("marks startup refused, cancels and destroys the tray when controller setup fails", async () => {
    h.createDiagnosticController.mockImplementationOnce(() => {
      throw new Error("controller failed");
    });
    await startDiagnosticMain();

    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(h.trays[0].destroy).toHaveBeenCalledTimes(1);
    expect(lastReadiness()).toMatchObject({ phase: "startup-refused" });
  });

  it("routes an uncaught exception to the same refusal path", async () => {
    await startDiagnosticMain();
    h.controller.cancel.mockClear();
    h.processOnce.get("uncaughtException")?.(new Error("boom"));

    expect(h.controller.cancel).toHaveBeenCalledTimes(1);
    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(lastReadiness()).toMatchObject({ phase: "startup-refused" });
  });

  it("routes an unhandled rejection to the same refusal path", async () => {
    await startDiagnosticMain();
    h.processOnce.get("unhandledRejection")?.("reason");
    expect(h.app.exit).toHaveBeenCalledWith(1);
    expect(lastReadiness()).toMatchObject({ phase: "startup-refused" });
  });
});
