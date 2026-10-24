import { expect, it, vi } from "vitest";
import { registerAppUpdateIpc, type RequestControlledShutdown } from "./app-update-ipc";
import { IPC } from "../../shared/ipc-channels";
import type { AppUpdateService } from "./app-update-service";
import type { AppUpdateState } from "../../shared/app-update";

function setup(shutdown?: RequestControlledShutdown, ready = true) {
  const state: AppUpdateState = { phase: "downloaded", currentVersion: "1.3.2", availableVersion: "1.4.3" };
  const service = { getState: vi.fn(() => state), check: vi.fn(async () => state), download: vi.fn(async () => state),
    canInstall: vi.fn(() => ready), install: vi.fn(() => true), onStateChanged: vi.fn(() => () => {}) };
  const handlers = new Map<string, (...args: any[]) => any>(), send = vi.fn(), closedSend = vi.fn();
  registerAppUpdateIpc({ service: service as AppUpdateService, requestControlledShutdown: shutdown,
    ipcMain: { handle: (name, action) => { handlers.set(name, action); } },
    getWindows: () => [{ isDestroyed: () => false, webContents: { send } }, { isDestroyed: () => true, webContents: { send: closedSend } }] });
  return { service, state, handlers, send, closedSend };
}
it("forwards state, download and install requests and publishes changes to usable windows", async () => {
  const fixture = setup(), { service, handlers, state } = fixture;
  expect(await handlers.get(IPC.APP_UPDATE_GET_STATE)!({})).toEqual(service.getState());
  expect(await handlers.get(IPC.APP_UPDATE_DOWNLOAD)!({})).toEqual(state);
  expect(await handlers.get(IPC.APP_UPDATE_INSTALL)!({})).toBe(true);
  expect(service.download).toHaveBeenCalledTimes(1);
  expect(service.install).toHaveBeenCalledTimes(1);
  const publish = service.onStateChanged.mock.calls[0][0] as (state: AppUpdateState) => void;
  publish(state);
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith(IPC.APP_UPDATE_STATE, state);
  expect(fixture.closedSend).not.toHaveBeenCalled();
});
it("performs controlled cleanup before its installation final action", async () => {
  const sequence: string[] = [];
  const shutdown = vi.fn<RequestControlledShutdown>(async request => {
    sequence.push("cleanup");
    request.finalAction();
    return true;
  });
  const { service, handlers } = setup(shutdown);
  service.install.mockImplementation(() => { sequence.push("installer"); return true; });
  expect(await handlers.get(IPC.APP_UPDATE_INSTALL)!({})).toBe(true);
  expect(sequence).toEqual(["cleanup", "installer"]);
  expect(shutdown).toHaveBeenCalledWith(expect.objectContaining({ reason: "update-install" }));
});
it.each([false, true])("does not install when %s indicates a blocked shutdown path", async ready => {
  const shutdown = vi.fn(async () => false);
  const { service, handlers } = setup(shutdown, ready);
  expect(await handlers.get(IPC.APP_UPDATE_INSTALL)!({})).toBe(false);
  expect(service.install).not.toHaveBeenCalled();
  if (!ready) expect(shutdown).not.toHaveBeenCalled();
});
