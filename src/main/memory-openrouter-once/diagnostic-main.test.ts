import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "E:/Codex/2026-10-01/task/firefly-memory-next-stage/output/openrouter-usd1";

const m = vi.hoisted(() => {
  const state: any = {
    app: {
      isReady: vi.fn(() => false),
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
      exit: vi.fn(),
      whenReady: vi.fn(async () => {}),
      on: vi.fn(),
      once: vi.fn(),
      quit: vi.fn(),
      commandLine: { hasSwitch: vi.fn(() => false) },
    },
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    buildFromTemplate: vi.fn((items: unknown) => ({ items })),
    trays: [] as any[],
    createController: vi.fn(),
    createConfigurationWindow: vi.fn(),
    createProbeRunner: vi.fn(),
    loadTrayIcon: vi.fn(() => "tray-icon"),
    initializeStorageContext: vi.fn(),
    applyElectronPaths: vi.fn(),
    resolveRuntimeProfile: vi.fn(),
    getFireflyApplicationDataPath: vi.fn(() => "C:/production-app-data"),
    profile: {
      kind: "smoke",
      applicationName: "Firefly-smoke",
      appData: "E:/isolated",
      userData: "E:/isolated/Firefly-smoke",
      sessionData: "E:/isolated/Firefly-smoke/session",
      logs: "E:/isolated/Firefly-smoke/logs",
      isolationRoot: "E:/isolated",
    },
    events: new Map<string, (...args: any[]) => unknown>(),
    ADMISSION_ROOT: "E:/firefly-admission",
  };
  state.Tray = class {
    toolTip = "";
    menu: unknown;
    destroyed = false;
    constructor(public icon: unknown) {
      state.trays.push(this);
    }
    setToolTip(value: string) {
      this.toolTip = value;
    }
    setContextMenu(value: unknown) {
      this.menu = value;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
  };
  return state;
});

vi.mock("electron", () => ({
  app: m.app,
  dialog: { showMessageBox: m.showMessageBox },
  Menu: { buildFromTemplate: m.buildFromTemplate },
  Tray: m.Tray,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: (...args: unknown[]) => m.existsSync(...args),
      mkdirSync: (...args: unknown[]) => m.mkdirSync(...args),
      writeFileSync: (...args: unknown[]) => m.writeFileSync(...args),
    },
  };
});
vi.mock("../runtime-profile", async importOriginal => {
  const actual = await importOriginal<typeof import("../runtime-profile")>();
  return {
    ...actual,
    canonicalPath: (value: string) => value,
    resolveRuntimeProfile: (...args: unknown[]) => m.resolveRuntimeProfile(...args),
    applyElectronPaths: (...args: unknown[]) => m.applyElectronPaths(...args),
  };
});
vi.mock("../app-identity", () => ({ getFireflyApplicationDataPath: () => m.getFireflyApplicationDataPath() }));
vi.mock("../storage-context", () => ({ initializeStorageContext: (...args: unknown[]) => m.initializeStorageContext(...args) }));
vi.mock("../windows/tray-icon", () => ({ loadTrayIcon: () => m.loadTrayIcon() }));
vi.mock("./controller", () => ({ createController: (...args: unknown[]) => m.createController(...args) }));
vi.mock("./configuration-window", () => ({ createConfigurationWindow: () => m.createConfigurationWindow() }));
vi.mock("./runner", () => ({ createProbeRunner: (...args: unknown[]) => m.createProbeRunner(...args), ADMISSION_ROOT: m.ADMISSION_ROOT }));

import { startOpenRouterDiagnosticMain } from "./diagnostic-main";

interface ListenerSnapshot {
  uncaughtException: Set<unknown>;
  unhandledRejection: Set<unknown>;
  stdout: Set<unknown>;
  stderr: Set<unknown>;
}

let snapshot: ListenerSnapshot;

function captureListeners(): ListenerSnapshot {
  return {
    uncaughtException: new Set(process.listeners("uncaughtException")),
    unhandledRejection: new Set(process.listeners("unhandledRejection")),
    stdout: new Set(process.stdout.listeners("error")),
    stderr: new Set(process.stderr.listeners("error")),
  };
}

function addedListener(event: keyof ListenerSnapshot): (...args: any[]) => unknown {
  const stream = event === "stdout" ? process.stdout : process.stderr;
  const target = event === "uncaughtException" || event === "unhandledRejection" ? process : stream;
  const name = event === "stdout" || event === "stderr" ? "error" : event;
  const listeners = target.listeners(name as never) as unknown as Array<(...args: any[]) => unknown>;
  const added = listeners.filter(listener => !snapshot[event].has(listener));
  expect(added).toHaveLength(1);
  return added[0]!;
}

function eventHandler(name: string) {
  return m.events.get(name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = captureListeners();
  m.app.isReady.mockReturnValue(false);
  m.app.isPackaged = false;
  m.app.requestSingleInstanceLock.mockReturnValue(true);
  m.app.whenReady.mockResolvedValue(undefined);
  m.existsSync.mockReturnValue(false);
  m.profile = {
    kind: "smoke",
    applicationName: "Firefly-smoke",
    appData: "E:/isolated",
    userData: "E:/isolated/Firefly-smoke",
    sessionData: "E:/isolated/Firefly-smoke/session",
    logs: "E:/isolated/Firefly-smoke/logs",
    isolationRoot: "E:/isolated",
  };
  m.resolveRuntimeProfile.mockReturnValue(m.profile);
  m.initializeStorageContext.mockReset();
  m.applyElectronPaths.mockReset();
  m.getFireflyApplicationDataPath.mockReturnValue("C:/production-app-data");
  m.events.clear();
  m.app.on.mockImplementation((name: string, listener: (...args: any[]) => unknown) => {
    m.events.set(name, listener);
  });
  m.app.once.mockImplementation((name: string, listener: (...args: any[]) => unknown) => {
    m.events.set(`once:${name}`, listener);
  });
  m.trays.length = 0;
  m.loadTrayIcon.mockReturnValue("tray-icon");
  m.showMessageBox.mockResolvedValue({ response: 0 });
  m.buildFromTemplate.mockImplementation((items: unknown) => ({ items }));
  m.createConfigurationWindow.mockImplementation(() => ({ open: vi.fn(), close: vi.fn() }));
  m.createProbeRunner.mockImplementation(() => ({ cancel: vi.fn() }));
  m.createController.mockImplementation((deps: unknown) => {
    m.controllerDeps = deps;
    m.controller = { install: vi.fn(), configure: vi.fn(), cancel: vi.fn() };
    return m.controller;
  });
  delete process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT;
});

afterEach(() => {
  delete process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT;
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    for (const listener of process.listeners(event)) {
      if (!snapshot[event].has(listener)) process.removeListener(event, listener);
    }
  }
  for (const event of ["stdout", "stderr"] as const) {
    const stream = event === "stdout" ? process.stdout : process.stderr;
    for (const listener of stream.listeners("error")) {
      if (!snapshot[event].has(listener)) stream.removeListener("error", listener);
    }
  }
});

describe("root isolation", () => {
  it("refuses the base directory itself", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = BASE;
    await startOpenRouterDiagnosticMain();
    expect(m.app.exit).toHaveBeenCalledWith(1);
    expect(m.mkdirSync).not.toHaveBeenCalled();
    expect(m.createController).not.toHaveBeenCalled();
  });

  it.each([
    ["a relative path", "relative/runtime"],
    ["a sibling outside the base", "E:/Codex/other"],
    ["the parent of the base", "E:/Codex/2026-10-01/task/firefly-memory-next-stage/output"],
  ])("refuses %s", async (_label, root) => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = root;
    await startOpenRouterDiagnosticMain();
    expect(m.app.exit).toHaveBeenCalledWith(1);
    expect(m.mkdirSync).not.toHaveBeenCalled();
  });

  it("defaults to the live-runtime directory under the base", async () => {
    await startOpenRouterDiagnosticMain();
    expect(m.mkdirSync).toHaveBeenCalledWith(path.join(BASE, "live-runtime"), { recursive: true });
    expect(m.app.exit).not.toHaveBeenCalled();
  });

  it("refuses an empty configured root", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = "";
    await startOpenRouterDiagnosticMain();
    expect(m.app.exit).toHaveBeenCalledWith(1);
  });
});

describe("startup wiring", () => {
  it("resolves the smoke profile, applies it and starts the controller", async () => {
    const root = path.join(BASE, "test-runtime");
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = root;
    await startOpenRouterDiagnosticMain();

    expect(m.app.exit).not.toHaveBeenCalled();
    expect(m.mkdirSync).toHaveBeenCalledWith(root, { recursive: true });
    expect(m.resolveRuntimeProfile).toHaveBeenCalledWith({
      argv: ["--firefly-profile=smoke", `--firefly-isolation-root=${root}`],
      env: {},
      isPackaged: false,
      productionAppData: "C:/production-app-data",
    });
    expect(m.applyElectronPaths).toHaveBeenCalledWith(m.app, m.profile);
    expect(m.initializeStorageContext).toHaveBeenCalledWith(m.profile);
    expect(m.createProbeRunner).toHaveBeenCalledWith({
      root: m.ADMISSION_ROOT,
      resolveProfile: expect.any(Function),
      fetch: globalThis.fetch,
      now: Date.now,
    });
    expect(m.app.whenReady).toHaveBeenCalledTimes(1);
    expect(m.trays).toHaveLength(1);
    expect(m.trays[0].icon).toBe("tray-icon");
    expect(m.trays[0].toolTip).toBe("OpenRouter H：USD 1 受限测试");
    expect(m.createConfigurationWindow).toHaveBeenCalledTimes(1);
    expect(m.controller.install).toHaveBeenCalledTimes(1);
    expect(m.controller.configure).toHaveBeenCalledTimes(1);
  });

  it("registers a second-instance counter and a no-op window-all-closed handler", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    expect(m.events.has("window-all-closed")).toBe(true);
    expect(() => eventHandler("window-all-closed")()).not.toThrow();

    const second = eventHandler("second-instance");
    second();
    second();
    const calls = m.writeFileSync.mock.calls.filter(([file]) => String(file).endsWith("readiness.json"));
    expect(calls).toHaveLength(2);
    const saved = JSON.parse(String(calls.at(-1)![1]));
    expect(saved).toMatchObject({ pid: process.pid, isReady: false, menuReady: true, duplicateCount: 2 });
  });

  it("creates the probe runner with a resolver that stays empty until selected", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    const runnerArgs = m.createProbeRunner.mock.calls[0]![0];
    expect(runnerArgs.resolveProfile("model-a")).toBeUndefined();
    const selected = (id: string) => ({ id, kind: "cache" });
    expect(m.controllerDeps.createRunner(selected)).toBe(m.createProbeRunner.mock.results[0]!.value);
    expect(runnerArgs.resolveProfile("model-a")).toEqual({ id: "model-a", kind: "cache" });
  });

  it("bridges controller callbacks to dialogs, tray menu, readiness state and app quit", async () => {
    const root = path.join(BASE, "test-runtime");
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = root;
    await startOpenRouterDiagnosticMain();

    expect(m.controllerDeps.openForm).toBe(m.createConfigurationWindow.mock.results[0]!.value.open);
    expect(m.controllerDeps.closeForm).toBe(m.createConfigurationWindow.mock.results[0]!.value.close);

    const options = { type: "question", title: "Confirm" };
    await m.controllerDeps.show(options);
    expect(m.showMessageBox).toHaveBeenCalledWith(options);

    const items = [{ label: "Send" }];
    m.controllerDeps.setMenu(items);
    expect(m.buildFromTemplate).toHaveBeenCalledWith(items);
    expect(m.trays[0].menu).toEqual({ items });

    m.existsSync.mockImplementation((file: string) => /arm\.json|ledger\.json$/.test(String(file)));
    m.controllerDeps.writeState({ phase: "ready" });
    const [readinessFile, contents] = m.writeFileSync.mock.calls.at(-1)!;
    expect(readinessFile).toBe(path.join(root, "readiness.json"));
    expect(JSON.parse(String(contents))).toEqual({
      pid: process.pid,
      isReady: false,
      menuReady: true,
      duplicateCount: 0,
      phase: "ready",
      admission: { armed: true, bootBound: false, spent: false, ledger: true },
    });

    m.controllerDeps.quit();
    expect(m.app.quit).toHaveBeenCalledTimes(1);
  });

  it("cancels the controller and runner and destroys the tray on before-quit", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    const tray = m.trays[0];
    eventHandler("before-quit")();
    expect(m.controller.cancel).toHaveBeenCalledTimes(1);
    expect(m.createProbeRunner.mock.results[0]!.value.cancel).toHaveBeenCalledTimes(1);
    expect(tray.destroyed).toBe(true);
    expect(() => eventHandler("before-quit")()).not.toThrow();
    expect(tray.destroyed).toBe(true);
  });

  it("writes a secondary marker and exits zero when the single-instance lock is held elsewhere", async () => {
    const root = path.join(BASE, "test-runtime");
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = root;
    m.app.requestSingleInstanceLock.mockReturnValue(false);
    await startOpenRouterDiagnosticMain();
    expect(m.writeFileSync).toHaveBeenCalledWith(
      path.join(root, `secondary-${process.pid}.json`),
      JSON.stringify({ secondary: true, pid: process.pid }),
    );
    expect(m.app.exit).toHaveBeenCalledWith(0);
    expect(m.app.whenReady).not.toHaveBeenCalled();
    expect(m.createController).not.toHaveBeenCalled();
  });

  it("exits one when the profile or probe setup throws", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    m.resolveRuntimeProfile.mockImplementation(() => {
      throw new Error("boom");
    });
    await startOpenRouterDiagnosticMain();
    expect(m.app.exit).toHaveBeenCalledWith(1);
    expect(m.createController).not.toHaveBeenCalled();
  });

  it("exits one when Electron fails to become ready", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    m.app.whenReady.mockRejectedValue(new Error("no display"));
    await startOpenRouterDiagnosticMain();
    expect(m.app.exit).toHaveBeenCalledWith(1);
    expect(m.createController).not.toHaveBeenCalled();
  });
});

describe("fatal handlers", () => {
  it.each(["uncaughtException", "unhandledRejection"])("cleans up and exits one on %s", async event => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    const tray = m.trays[0];
    const fatal = addedListener(event as keyof ListenerSnapshot);
    fatal(new Error("synthetic"));
    expect(m.controller.cancel).toHaveBeenCalledTimes(1);
    expect(m.createProbeRunner.mock.results[0]!.value.cancel).toHaveBeenCalledTimes(1);
    expect(tray.destroyed).toBe(true);
    expect(m.app.exit).toHaveBeenCalledWith(1);
  });

  it("still exits one when cleanup itself throws", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    m.controller.cancel.mockImplementation(() => {
      throw new Error("cancel failed");
    });
    m.createProbeRunner.mock.results[0]!.value.cancel.mockImplementation(() => {
      throw new Error("runner failed");
    });
    m.trays[0].destroy = () => {
      throw new Error("destroy failed");
    };
    const fatal = addedListener("uncaughtException");
    expect(() => fatal()).not.toThrow();
    expect(m.app.exit).toHaveBeenCalledWith(1);
  });

  it("registers stdout and stderr error listeners", async () => {
    process.env.FIREFLY_OPENROUTER_DIAGNOSTIC_ROOT = path.join(BASE, "test-runtime");
    await startOpenRouterDiagnosticMain();
    const stdout = addedListener("stdout");
    const stderr = addedListener("stderr");
    expect(() => stdout()).not.toThrow();
    expect(() => stderr()).not.toThrow();
  });
});
