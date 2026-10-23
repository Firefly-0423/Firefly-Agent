import { describe, expect, it, vi } from "vitest";
import { createApplication, type ApplicationDependencies } from "./application";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator } from "./shutdown";
import { createWindowActivationBroker } from "./window-activation";
function setup() {
    const readiness = createStartupReadiness();
    const steps: string[] = [];
    const splash = { isDestroyed: () => false, close: vi.fn() };
    const deps: ApplicationDependencies = {
        readiness, activation: createWindowActivationBroker(), shutdown: createShutdownCoordinator({ readiness }),
        app: { whenReady: vi.fn(), quit: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
        dialog: { showErrorBox: vi.fn() }, logFatal: vi.fn(),
        prepare: () => { steps.push("prepare"); return { isPrimaryProcess: true }; },
        startShell: vi.fn(async () => { steps.push("shell"); readiness.transition("shell-ready"); return { splashWindow: splash } as never; }),
        startCore: vi.fn(async () => { steps.push("core"); readiness.transition("core-ready"); return {} as never; }),
        startBackground: vi.fn(() => { steps.push("background"); return { settled: Promise.resolve(), stop: vi.fn() }; }),
    };
    return { deps, steps, splash, app: createApplication(deps) };
}
describe("application composition", () => {
    it("discovers process ownership during preparation then starts stages sequentially", async () => {
        const { app, steps } = setup();
        expect(app.isPrimaryProcess()).toEqual(false);
        app.prepareBeforeReady();
        expect(app.isPrimaryProcess()).toEqual(true);
        await app.start();
        expect(steps).toEqual(["prepare", "shell", "core", "background"]);
    });
    it("closes the loading window and reports a fatal startup error only once", async () => {
        const { deps, app, splash } = setup();
        vi.mocked(deps.startCore).mockRejectedValue(new Error("core initialization refused"));
        app.prepareBeforeReady();
        await expect(app.start()).rejects.toThrow("core initialization refused");
        await app.handleFatalStartup(new Error("core initialization refused"));
        await app.handleFatalStartup(new Error("ignored duplicate"));
        expect(splash.close).toHaveBeenCalledTimes(1);
        expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
        expect(deps.app.quit).toHaveBeenCalledTimes(1);
        expect(deps.logFatal).toHaveBeenCalled();
        expect(deps.readiness.getPhase()).toEqual("stopped");
    });
    it("installs all application lifecycle callbacks", () => {
        const { app, deps } = setup();
        app.installLifecycleHandlers();
        expect(vi.mocked(deps.app.on).mock.calls.map(([event]) => event)).toEqual(["before-quit", "window-all-closed", "activate"]);
    });
});
