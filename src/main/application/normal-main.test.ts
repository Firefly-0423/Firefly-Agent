import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  primary: true, start: vi.fn(async () => undefined), fatal: vi.fn(),
  ready: vi.fn(async () => undefined), select: vi.fn(() => ({ scope: "opaque" })),
  endpoint: vi.fn(() => ({ open: () => {} })),
  measure: vi.fn(async () => ({ status: "measured", population: 0, present: 0, missing: 0, unknownDenied: 0, evidence: { status: "not-evaluated" } })),
  log: vi.fn(), beforeQuit: undefined as (() => void) | undefined,
}));
vi.mock("../identity-preflight", () => ({}));
vi.mock("electron", () => ({ app: {
  whenReady: () => mocks.ready(), once: (_event: string, listener: () => void) => { mocks.beforeQuit = listener; },
  removeListener: () => { mocks.beforeQuit = undefined; },
} }));
vi.mock("./application", () => ({ createApplication: () => ({
  installLifecycleHandlers() {}, prepareBeforeReady() {}, isPrimaryProcess: () => mocks.primary,
  start: () => mocks.start(), handleFatalStartup: (error: unknown) => mocks.fatal(error),
}) }));
vi.mock("./default-dependencies", () => ({ createDefaultApplicationDependencies: () => ({}) }));
vi.mock("../plugin-panel-protocol", () => ({ registerPluginPanelScheme() {} }));
vi.mock("../windows/external-link", () => ({ installGlobalNavigationGuard() {} }));
vi.mock("../logger", () => ({ initializeMainFileLogging() {}, logger: { warn: (...args: unknown[]) => mocks.log(...args) }, LogTag: { Runtime: "Runtime" } }));
vi.mock("../memory-sources/native-history-coverage", () => ({ selectCachedHistoryCoverage: () => mocks.select(), measureHistoryPresence: (...args: unknown[]) => mocks.measure(...args as []) }));
vi.mock("../memory-sources/native-history-presence-process", () => ({ createNativeHistoryPresenceEndpoint: (...args: unknown[]) => mocks.endpoint(...args as []) }));
let stdoutListeners: Function[], stderrListeners: Function[];
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs();
  mocks.primary = true; mocks.beforeQuit = undefined;
  mocks.start.mockImplementation(async () => undefined);
  mocks.measure.mockImplementation(async () => ({ status: "measured", population: 0, present: 0, missing: 0, unknownDenied: 0, evidence: { status: "not-evaluated" } }));
  stdoutListeners = process.stdout.listeners("error"); stderrListeners = process.stderr.listeners("error");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const [stream, previous] of [[process.stdout, stdoutListeners], [process.stderr, stderrListeners]] as const) {
    for (const listener of stream.listeners("error")) if (!previous.includes(listener)) stream.removeListener("error", listener);
  }
});
async function load() { await import("./normal-main"); await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(mocks.primary ? 1 : 0)); }
function enable() { vi.stubEnv("FIREFLY_HISTORY_PRESENCE_ONCE", "1"); vi.stubEnv("FIREFLY_HISTORY_PRESENCE_HELPER", "E:\\synthetic\\firefly-history-presence.exe"); }
describe("one-time Main metadata entry", () => {
  it("remains off by default", async () => {
    vi.stubEnv("FIREFLY_HISTORY_PRESENCE_ONCE", undefined); await load();
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.endpoint).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
  });
  it("runs once in primary Main after startup and outputs aggregates", async () => {
    enable(); await load(); await vi.waitFor(() => expect(mocks.measure).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]);
    expect(mocks.endpoint).toHaveBeenCalledWith("E:\\synthetic\\firefly-history-presence.exe");
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.log.mock.calls[0][2]).toMatchObject({ status: "measured", evidence: { status: "not-evaluated" } });
    expect(mocks.beforeQuit).toBeUndefined();
  });
  it("does not run in a secondary process", async () => {
    enable(); mocks.primary = false; await load(); expect(mocks.select).not.toHaveBeenCalled();
  });
  it("reports an explicitly enabled but unconfigured helper without a fatal startup", async () => {
    enable(); vi.stubEnv("FIREFLY_HISTORY_PRESENCE_HELPER", undefined); await load();
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.log.mock.calls[0][2]).toMatchObject({ status: "not-measured", reason: "helper-not-configured" });
    expect(mocks.measure).not.toHaveBeenCalled(); expect(mocks.fatal).not.toHaveBeenCalled();
  });
  it("preserves cache-unavailable reports without initializing or replacing the cache", async () => {
    enable(); mocks.measure.mockResolvedValueOnce({ status: "not-measured", reason: "not-ready", population: null } as never);
    await load(); await vi.waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.log.mock.calls[0][2]).toMatchObject({ status: "not-measured", reason: "not-ready", population: null });
  });
  it("cancels on shutdown and isolates a measurement failure from ordinary startup", async () => {
    enable(); let reject!: (error: Error) => void;
    mocks.measure.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await load(); await vi.waitFor(() => expect(mocks.measure).toHaveBeenCalledTimes(1));
    mocks.beforeQuit!(); expect(mocks.measure.mock.calls[0][2].signal.aborted).toBe(true);
    reject(new Error("synthetic detail must not be logged"));
    await vi.waitFor(() => expect(mocks.log).toHaveBeenCalled());
    expect(mocks.log.mock.calls[0][2]).toMatchObject({ status: "not-measured", reason: "measurement-failed" });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("synthetic detail"); expect(mocks.fatal).not.toHaveBeenCalled();
  });
});
