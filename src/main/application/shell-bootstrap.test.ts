import { describe, it, expect, vi } from "vitest";
import { startShell, type ShellDependencies } from "./shell-bootstrap";
import { createStartupReadiness } from "./readiness";
import { createShutdownCoordinator } from "./shutdown";
import { createWindowActivationBroker } from "./window-activation";
function shellEnvironment(immediateShown = true) {
    const readiness = createStartupReadiness();
    const activation = createWindowActivationBroker();
    const loading = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn() };
    const chat = { on: vi.fn(), isDestroyed: () => false };
    const windows = { dispose: vi.fn(), createPetWindow: vi.fn(), createSidebarWindow: vi.fn(), openReactChatWindow: vi.fn(), createSettingsWindow: vi.fn() };
    const deps: ShellDependencies = {
        readiness, activation, shutdown: createShutdownCoordinator({ readiness }),
        createIpcScope: () => ({ handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), dispose: vi.fn() }),
        onWillQuit: vi.fn(),
        createSplashWindow: vi.fn(({ onShown }) => { if (immediateShown)
            onShown(310); return loading as never; }),
        createWindowManager: () => windows as never,
        createChatShell: vi.fn(() => ({ window: chat as never, load: vi.fn(), show: vi.fn() })),
        registerProtocolHandlers: vi.fn(), registerShellIpc: vi.fn(),
        createTray: vi.fn(() => ({ isDestroyed: () => false, destroy: vi.fn() }) as never),
        flushTokenUsage: vi.fn(), writeStartupLog: vi.fn(),
    };
    return { deps, loading, windows, chat };
}
describe("minimal desktop shell", () => {
    it("creates Loading first and does not load chat or create a pet", async () => {
        const { deps, windows, chat } = shellEnvironment();
        const result = await startShell(deps);
        expect(deps.createSplashWindow).toHaveBeenCalledBefore(deps.createChatShell);
        expect(result.chat.load).not.toHaveBeenCalled();
        expect(windows.createPetWindow).not.toHaveBeenCalled();
        expect(deps.readiness.getPhase()).toEqual("shell-ready");
        expect(result.loadingShownAt).toEqual(310);
        expect(chat.on.mock.calls.map(([name]) => name)).toEqual(["query-session-end", "session-end"]);
    });
    it("observes the asynchronous actual Loading display time", async () => {
        const { deps } = shellEnvironment(false);
        const result = await startShell(deps);
        expect(result.loadingShownAt).toBeUndefined();
        vi.mocked(deps.createSplashWindow).mock.calls[0][0].onShown(920);
        expect(result.loadingShownAt).toEqual(920);
    });
    it("routes tray chat through activation and focuses Loading while startup is pending", async () => {
        const { deps, loading, windows } = shellEnvironment();
        await startShell(deps);
        const requested = vi.spyOn(deps.activation, "request");
        vi.mocked(deps.createTray).mock.calls[0][0].requestActivation({ kind: "chat" });
        expect(requested).toHaveBeenCalledWith({ kind: "chat" });
        deps.activation.request({ kind: "settings" });
        expect(loading.focus).toHaveBeenCalled();
        expect(windows.openReactChatWindow).not.toHaveBeenCalled();
        deps.activation.request({ kind: "chat", sessionId: "session-to-open" });
        await deps.activation.markReady();
        expect(windows.openReactChatWindow).toHaveBeenCalledExactlyOnceWith("session-to-open");
    });
    it("flushes usage once in an emergency and retains IPC until will-quit", async () => {
        const { deps } = shellEnvironment();
        const result = await startShell(deps);
        deps.shutdown.emergencyFlush();
        expect(deps.flushTokenUsage).toHaveBeenCalledTimes(1);
        deps.shutdown.emergencyFlush();
        expect(deps.flushTokenUsage).toHaveBeenCalledTimes(1);
        const exit = vi.fn();
        await deps.shutdown.requestControlledShutdown({ reason: "close", finalAction: exit });
        expect(exit).toHaveBeenCalledTimes(1);
        expect(result.ipc.dispose).not.toHaveBeenCalled();
        const willQuit = vi.mocked(deps.onWillQuit).mock.calls[0][0];
        expect(willQuit).toBeTypeOf("function");
        willQuit();
        expect(result.ipc.dispose).toHaveBeenCalledTimes(1);
    });
    it("ignores retired sidebar navigation without flushing usage", async () => {
        const { deps, windows } = shellEnvironment();
        await startShell(deps);
        deps.activation.request({ kind: "sidebar" });
        await deps.activation.markReady();
        expect(windows.createSidebarWindow).not.toHaveBeenCalled();
        expect(deps.flushTokenUsage).not.toHaveBeenCalled();
    });
});
