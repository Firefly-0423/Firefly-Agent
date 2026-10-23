import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import type { createPluginMarketplaceService } from "../plugin-marketplace";
import { isFromHostDocument } from "./plugin-management-ipc-guard";

export function registerPluginMarketplaceIpc(deps: {
  ipc: Pick<IpcScope, "handle">;
  getHostWebContents: () => WebContents | null;
  market: ReturnType<typeof createPluginMarketplaceService>;
}): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const owner = deps.getHostWebContents();
    return isFromHostDocument(event, owner, "react");
  };
  const forbidden = { ok: false, error: "插件市场调用来源窗口不受信任" } as const;
  deps.ipc.handle(IPC.PLUGINS_MARKET_LIST, (event: IpcMainInvokeEvent, preferred: unknown) => {
    if (!trusted(event)) return { ...forbidden, plugins: [], sources: [] };
    return deps.market.listMarket(typeof preferred === "string" ? preferred : undefined);
  });
  deps.ipc.handle(IPC.PLUGINS_MARKET_INSTALL, (event: IpcMainInvokeEvent, id: unknown) => {
    if (!trusted(event)) return forbidden;
    if (typeof id !== "string" || !id) return { ok: false, error: "id 必须是非空字符串" };
    return deps.market.installFromMarket(id);
  });
}
