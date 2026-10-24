import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { getAsrConfig } from "./asr-config";
import { createAsrStream } from "./asr-dispatcher";
import { DesktopAsrService } from "./desktop-asr-service";

export function registerDesktopAsrIpc(deps: {
  ipc: Pick<IpcScope, "handle">;
  getChatContents: () => WebContents | null | undefined;
  service?: DesktopAsrService;
}): { cancelAll(): void; dispose(): void } {
  const service = deps.service ?? new DesktopAsrService({ getConfig: getAsrConfig, createStream: config => createAsrStream(config, () => {}, () => {}) });
  const owners = new Map<WebContents, () => void>();
  const ownerFor = (event: IpcMainInvokeEvent): WebContents | undefined => {
    const owner = deps.getChatContents();
    if (!owner || owner.isDestroyed() || event.sender !== owner || !event.senderFrame || event.senderFrame !== owner.mainFrame) return;
    return owner;
  };
  const bind = (owner: WebContents): void => {
    if (owners.has(owner)) return;
    const cancel = (): void => service.cancelOwner(owner.id);
    // Electron 43 supplies navigation details on the event itself.
    const navigate = (event: { isMainFrame: boolean }): void => { if (event.isMainFrame) cancel(); };
    const destroyed = (): void => { cancel(); owners.get(owner)?.(); };
    owner.on("did-start-navigation", navigate); owner.on("render-process-gone", cancel); owner.on("destroyed", destroyed);
    owners.set(owner, () => { owner.removeListener("did-start-navigation", navigate); owner.removeListener("render-process-gone", cancel); owner.removeListener("destroyed", destroyed); owners.delete(owner); });
  };
  const forbidden = { ok: false, code: "forbidden" } as const;
  deps.ipc.handle(IPC.DESKTOP_ASR_START, (event: IpcMainInvokeEvent, id: unknown) => {
    const owner = ownerFor(event); if (!owner) return forbidden; bind(owner); return service.start(owner.id, id);
  });
  deps.ipc.handle(IPC.DESKTOP_ASR_FRAME, (event: IpcMainInvokeEvent, id: unknown, frame: unknown) => {
    const owner = ownerFor(event); return owner ? service.frame(owner.id, id, frame) : forbidden;
  });
  deps.ipc.handle(IPC.DESKTOP_ASR_STOP, (event: IpcMainInvokeEvent, id: unknown) => {
    const owner = ownerFor(event); return owner ? service.stop(owner.id, id) : forbidden;
  });
  deps.ipc.handle(IPC.DESKTOP_ASR_CANCEL, (event: IpcMainInvokeEvent, id: unknown) => {
    const owner = ownerFor(event); return owner ? service.cancel(owner.id, id) : forbidden;
  });
  return { cancelAll: () => service.cancelAll(), dispose: () => { service.dispose(); for (const unbind of owners.values()) unbind(); } };
}
