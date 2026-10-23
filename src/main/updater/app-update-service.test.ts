import { EventEmitter } from "node:events";
import { it, expect, vi } from "vitest";
import { createAppUpdateService } from "./app-update-service";

function desktopUpdater() {
  return Object.assign(new EventEmitter(), { autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true,
    checkForUpdates: vi.fn(async () => null), downloadUpdate: vi.fn(async () => []), quitAndInstall: vi.fn() });
}
it("requires explicit download and publishes checking then available release information", async () => {
  const transport = desktopUpdater(), phases: string[] = [];
  const service = createAppUpdateService({ updater: transport, isPackaged: true, currentVersion: "1.3.2",
    onStateChanged: state => { phases.push(state.phase); } });
  expect([transport.autoDownload, transport.autoInstallOnAppQuit, transport.allowPrerelease]).toEqual([false, false, false]);
  const checking = service.check();
  transport.emit("checking-for-update");
  transport.emit("update-available", { version: "1.4.3", releaseNotes: "Improved startup" });
  await checking;
  expect(transport.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(service.getState()).toMatchObject({ currentVersion: "1.3.2", phase: "available",
    availableVersion: "1.4.3", releaseNotes: "Improved startup" });
  expect(phases).toEqual(["checking", "available"]);
});
it("reports progress and installs a completed download silently with restart", async () => {
  const transport = desktopUpdater();
  const service = createAppUpdateService({ updater: transport, isPackaged: true, currentVersion: "1.3.2" });
  expect(service.install()).toBe(false);
  await service.download();
  expect(transport.downloadUpdate).toHaveBeenCalledTimes(1);
  transport.emit("download-progress", { percent: 63.7, bytesPerSecond: 2048, transferred: 637, total: 1000 });
  expect(service.getState()).toMatchObject({ phase: "downloading", percent: 63.7, bytesPerSecond: 2048, transferred: 637, total: 1000 });
  transport.emit("update-downloaded", { version: "1.4.3", releaseNotes: null });
  expect(service.getState()).toMatchObject({ phase: "downloaded", percent: 100, availableVersion: "1.4.3" });
  expect(service.install()).toBe(true);
  expect(transport.quitAndInstall).toHaveBeenCalledWith(true, true);
});
it.each([{ isPackaged: false }, { isPackaged: true, updatesEnabled: false }])(
  "blocks remote operations for disabled update configuration %j", async settings => {
    const transport = desktopUpdater();
    const service = createAppUpdateService({ updater: transport, currentVersion: "1.3.2", ...settings });
    await service.check();
    await service.download();
    expect(transport.checkForUpdates).not.toHaveBeenCalled();
    expect(transport.downloadUpdate).not.toHaveBeenCalled();
    expect(service.install()).toBe(false);
    expect(service.getState().phase).toBe("not_available");
  });
it("replaces stale progress with a user-facing error message", () => {
  const transport = desktopUpdater();
  const service = createAppUpdateService({ updater: transport, isPackaged: true, currentVersion: "1.3.2" });
  transport.emit("download-progress", { percent: 17 });
  transport.emit("error", new Error("private upstream detail"));
  expect(service.getState()).toMatchObject({ phase: "error", error: "暂时无法检查更新，请稍后再试。" });
  expect(service.getState().percent).toBeUndefined();
});
