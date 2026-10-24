import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import type { SidebarLayoutStore } from "./sidebar-layout-store";
import { SIDEBAR_LAYOUT_IPC } from "../../shared/sidebar-layout";

export function registerSidebarLayoutIpc(scope: Pick<IpcScope, "handle">, options: {
  store: SidebarLayoutStore;
  getChatContents(): WebContents | null | undefined;
  onChanged(): void;
}): void {
  function owns(event: IpcMainInvokeEvent): boolean {
    try {
      const contents = options.getChatContents();
      return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
    } catch { return false; }
  }
  scope.handle(SIDEBAR_LAYOUT_IPC.get, (event: IpcMainInvokeEvent) => {
    if (!owns(event)) return { ok: false, code: "owner_mismatch" };
    try { return { ok: true, snapshot: options.store.getSnapshot() }; }
    catch { return { ok: false, code: "storage_error" }; }
  });
  scope.handle(SIDEBAR_LAYOUT_IPC.mutate, (event: IpcMainInvokeEvent, mutation) => {
    if (!owns(event)) return { ok: false, code: "owner_mismatch" };
    try {
      const result = options.store.applyPatch(mutation);
      if (result.ok) options.onChanged();
      return result;
    } catch { return { ok: false, code: "storage_error" }; }
  });
}
