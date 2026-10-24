import { describe, expect, it, vi } from "vitest";
const profile = vi.hoisted(() => ({ kind: "production" }));
vi.mock("../storage-context", () => ({ getStorageContext: () => ({ profile }) }));
import { syncLaunchAtLogin } from "../settings/launch-at-login";
import { startCore, type CoreDependencies, type CoreServices } from "./core-bootstrap";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator } from "./shutdown";
import { createWindowActivationBroker } from "./window-activation";
function fixture(petVisible = true, sidebarVisible = false) {
    const events: string[] = [];
    const note = (label: string) => vi.fn(() => { events.push(label); });
    const readiness = createStartupReadiness();
    readiness.transition("shell-ready");
    const windowManager = {
        createPetWindow: vi.fn(), createSidebarWindow: vi.fn(), setPetWindowAlwaysOnTop: vi.fn(), applyPetWindowZoom: vi.fn(), onPetWindowReady: vi.fn(), onPetWindowClosed: vi.fn(),
    };
    const services = { llm: {}, social: {}, embedding: {}, proactive: {}, git: { dispose: vi.fn() }, lsp: { disposeAll: vi.fn() }, screenshot: { shutdown: vi.fn() }, music: { shutdown: vi.fn() }, update: {} } as unknown as CoreServices;
    const runtime = { buildOptions: vi.fn() };
    const load = vi.fn(async () => { events.push("renderer"); });
    const deps: CoreDependencies = {
        readiness, shutdown: createShutdownCoordinator({ readiness }), activation: createWindowActivationBroker(),
        shell: { ipc: { handle: vi.fn(), on: vi.fn(), dispose: vi.fn() }, splashWindow: null, loadingShownAt: 600, windowManager, chat: { window: {}, load, show: vi.fn() }, tray: {}, live2dWindowLifecycle: { attach: vi.fn(), clear: vi.fn() } } as never,
        migrateStagedExternalContent: note("migration"), initSkills: note("skills"), createLowCostServices: () => services,
        initSandbox: note("sandbox"), initPlanMode: note("planning"), registerAllTools: note("tools"), initRag: async () => { events.push("rag"); },
        createRuntime: () => runtime as never,
        createChannels: () => ({ initialize: note("adapters"), adaptersRegistered: Promise.resolve(), start: note("network"), shutdown: note("channels-stop") }) as never,
        createScheduler: () => ({ initialize: note("schedule-store"), start: note("timer"), stop: vi.fn() }) as never,
        startPlugins: vi.fn(async () => { events.push("plugins"); return { stop: note("plugins-stop") } as never; }),
        registerCoreIpc: note("ipc"), wireToastCenter: note("toast"),
        loadGeneralSettings: () => ({ petVisible, sidebarVisible }) as never, applyGeneralSettings: note("preferences"),
        revealStartupWindows: async () => { events.push("reveal"); }, markStartupWindowsReady: note("windows-ready"), minimumSplashMs: 1800,
    };
    return { deps, events, windowManager, load, runtime };
}
describe("core startup boundaries", () => {
    it("assembles adapters, schedule storage, plugins, IPC and toast before loading a renderer", async () => {
        const { deps, events, runtime } = fixture();
        await startCore(deps);
        expect(events).toEqual(["migration", "skills", "sandbox", "planning", "tools", "rag", "adapters", "schedule-store", "plugins", "ipc", "toast", "renderer", "preferences", "reveal", "windows-ready"]);
        expect(events).not.toContain("network");
        expect(events).not.toContain("timer");
        expect(deps.startPlugins).toHaveBeenCalledWith(expect.anything(), expect.anything(), runtime);
        expect(deps.readiness.getPhase()).toEqual("core-ready");
        await deps.shutdown.requestControlledShutdown({ reason: "close", finalAction: vi.fn() });
        expect(events.slice(-2)).toEqual(["plugins-stop", "channels-stop"]);
    });
    it.each(["rag", "skills"] as const)("degrades %s without blocking chat", async (capability) => {
        const { deps, load } = fixture();
        const fail = () => { throw new Error("optional capability unavailable"); };
        if (capability === "rag")
            deps.initRag = async () => fail();
        else
            deps.initSkills = fail;
        await expect(startCore(deps)).resolves.toBeDefined();
        expect(deps.readiness.getDegradedReasons().has(capability)).toEqual(true);
        expect(load).toHaveBeenCalledTimes(1);
    });
    it("does not start plugins until builtin adapter registration settles", async () => {
        const { deps, events } = fixture();
        let release!: () => void;
        const adaptersRegistered = new Promise<void>(resolve => { release = resolve; });
        deps.createChannels = () => ({ initialize: () => { events.push("adapter-pending"); }, adaptersRegistered, start: vi.fn(), shutdown: vi.fn() }) as never;
        const starting = startCore(deps);
        await vi.waitFor(() => expect(events).toContain("adapter-pending"));
        expect(deps.startPlugins).not.toHaveBeenCalled();
        release();
        await starting;
        expect(deps.startPlugins).toHaveBeenCalledTimes(1);
    });
    it("does not signal core readiness after renderer failure", async () => {
        const { deps, load } = fixture();
        const ready = vi.spyOn(deps.activation, "markReady");
        load.mockRejectedValue(new Error("chat document failed"));
        await expect(startCore(deps)).rejects.toThrow("chat document failed");
        expect(deps.readiness.getPhase()).not.toBe("core-ready");
        expect(ready).not.toHaveBeenCalled();
    });
    it.each([true, false])("creates and wires the pet window with visibility %s without retired sidebar", async (visible) => {
        const { deps, windowManager } = fixture(visible, true);
        await startCore(deps);
        expect(windowManager.createPetWindow).toHaveBeenCalledExactlyOnceWith(visible);
        expect(windowManager.setPetWindowAlwaysOnTop).toHaveBeenCalled();
        expect(windowManager.applyPetWindowZoom).toHaveBeenCalled();
        expect(windowManager.onPetWindowReady).toHaveBeenCalled();
        expect(windowManager.createSidebarWindow).not.toHaveBeenCalled();
    });
    it.each(["production", "development", "test", "smoke"])("applies login ownership in %s profile", async (kind) => {
        profile.kind = kind;
        for (const enabled of [false, true]) {
            const { deps } = fixture();
            const setLoginItemSettings = vi.fn();
            deps.loadGeneralSettings = () => ({ petVisible: true, launchAtLogin: enabled }) as never;
            deps.applyGeneralSettings = settings => syncLaunchAtLogin(settings.launchAtLogin, { setLoginItemSettings });
            await startCore(deps);
            if (kind === "production")
                expect(setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: enabled });
            else
                expect(setLoginItemSettings).not.toHaveBeenCalled();
        }
    });
});
