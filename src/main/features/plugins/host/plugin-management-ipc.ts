import type { IpcScope } from "../../../base/ipc/ipc-scope";
import { IPC } from "../../../../shared/ipc-channels";
import type {
  PluginListEntry,
  PluginOverview,
  UninstallPluginOptions,
} from "../../../../shared/plugin-management";
import { guardPluginIpcHandler, type PluginIpcHosts } from "./plugin-management-ipc-guard";
import type { PluginV2HostController, PluginV2Snapshot } from "./plugin-v2-services";

export interface PluginManagementIpcDeps {
  ipc: Pick<IpcScope, "handle">;
  hosts: PluginIpcHosts;
  controller: Pick<
    PluginV2HostController,
    | "listPlugins"
    | "enablePlugin"
    | "disablePlugin"
    | "grantPermission"
    | "revokePermission"
    | "setModelRateLimit"
    | "importFromPath"
    | "uninstallPlugin"
  >;
  selectPluginPackage: () => Promise<string | undefined>;
  selectPluginFolder: () => Promise<string | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function snapshotToListEntry(snap: PluginV2Snapshot): PluginListEntry {
  return {
    id: snap.id,
    name: snap.name,
    version: snap.version,
    sdk: snap.sdk,
    apiVersion: 2,
    description: snap.description,
    author: snap.author,
    native: snap.native,
    entry: snap.manifest.main,
    path: snap.installDir,
    source: "user",
    origin: snap.origin,
    sourceKind: snap.sourceKind,
    ...(snap.sourceId ? { sourceId: snap.sourceId } : {}),
    configuredEnabled: snap.enabled,
    defaultEnabled: false,
    enabled: snap.enabled,
    status: snap.status,
    hasUnregister: true,
    canOpen: false,
    grantedPermissions: [...snap.grantedPermissions],
    revision: snap.revision,
    modelRateLimit: snap.modelRateLimit,
    permissions: [...(snap.manifest.permissions ?? [])],
    tools: (snap.manifest.tools ?? []).map((t) => ({
      name: t.name,
      title: t.title,
      risk: [...t.risk],
      modes: [...t.modes],
    })),
    context: (snap.manifest.context ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      modes: [...c.modes],
      sources: [...c.sources],
    })),
    channels: (snap.manifest.channels ?? []).map((ch) => ({
      id: ch.id,
      title: ch.title,
    })),
    windows: (snap.manifest.ui?.windows ?? []).map((w) => ({
      id: w.id,
      title: w.title,
      entry: w.entry,
      ...(w.width !== undefined ? { width: w.width } : {}),
      ...(w.height !== undefined ? { height: w.height } : {}),
    })),
    hasSecrets: snap.hasSecrets,
    hasDataDir: snap.hasDataDir,
    ...(snap.error ? { error: snap.error } : {}),
  };
}

export function buildPluginOverview(
  controller: Pick<PluginV2HostController, "listPlugins">,
): PluginOverview {
  return {
    plugins: controller.listPlugins().map(snapshotToListEntry),
    issues: [],
  };
}

export function notifyPluginOverviewChanged(
  controller: Pick<PluginV2HostController, "listPlugins">,
  hosts: PluginIpcHosts,
): void {
  const overview = buildPluginOverview(controller);
  for (const recipient of new Set([hosts.getManagementHost(), hosts.getPanelHost()])) {
    if (recipient && !recipient.isDestroyed()) {
      try {
        recipient.send(IPC.PLUGINS_CHANGED, overview);
      } catch {
        /* Host window may have closed concurrently. */
      }
    }
  }
}

export function registerPluginManagementIpc(deps: PluginManagementIpcDeps): void {
  const { ipc, hosts, controller } = deps;
  const overview = () => buildPluginOverview(controller);

  ipc.handle(IPC.PLUGINS_LIST, guardPluginIpcHandler(IPC.PLUGINS_LIST, hosts, () => overview()));
  ipc.handle(IPC.PLUGINS_RESCAN, guardPluginIpcHandler(IPC.PLUGINS_RESCAN, hosts, () => overview()));

  ipc.handle(
    IPC.PLUGINS_SET_ENABLED,
    guardPluginIpcHandler(IPC.PLUGINS_SET_ENABLED, hosts, async ([id, enabled]) => {
      if (typeof id !== "string" || !id || typeof enabled !== "boolean") {
        return { ok: false, error: "参数格式非法" };
      }
      try {
        if (enabled) await controller.enablePlugin(id);
        else await controller.disablePlugin(id);
        return { ok: true, overview: overview() };
      } catch (error) {
        return { ok: false, error: errorMessage(error), overview: overview() };
      }
    }),
  );

  ipc.handle(
    IPC.PLUGINS_SET_PERMISSION,
    guardPluginIpcHandler(IPC.PLUGINS_SET_PERMISSION, hosts, ([id, permission, granted]) => {
      if (typeof id !== "string" || !id || typeof permission !== "string" || !permission || typeof granted !== "boolean") {
        return { ok: false, error: "参数格式非法" };
      }
      try {
        if (granted) controller.grantPermission(id, permission);
        else controller.revokePermission(id, permission);
        return { ok: true, overview: overview() };
      } catch (error) {
        return { ok: false, error: errorMessage(error), overview: overview() };
      }
    }),
  );

  ipc.handle(
    IPC.PLUGINS_SET_MODEL_RATE_LIMIT,
    guardPluginIpcHandler(IPC.PLUGINS_SET_MODEL_RATE_LIMIT, hosts, ([id, limit]) => {
      if (typeof id !== "string" || !id || typeof limit !== "number") {
        return { ok: false, error: "参数格式非法" };
      }
      try {
        controller.setModelRateLimit(id, limit);
        return { ok: true, overview: overview() };
      } catch (error) {
        return { ok: false, error: errorMessage(error), overview: overview() };
      }
    }),
  );

  ipc.handle(
    IPC.PLUGINS_IMPORT_ZIP,
    guardPluginIpcHandler(IPC.PLUGINS_IMPORT_ZIP, hosts, async () => {
      const selected = await deps.selectPluginPackage();
      if (!selected) return { ok: false, canceled: true };
      const result = await controller.importFromPath(selected);
      return { ...result, overview: overview() };
    }),
  );

  ipc.handle(
    IPC.PLUGINS_IMPORT_FOLDER,
    guardPluginIpcHandler(IPC.PLUGINS_IMPORT_FOLDER, hosts, async () => {
      const selected = await deps.selectPluginFolder();
      if (!selected) return { ok: false, canceled: true };
      const result = await controller.importFromPath(selected);
      return { ...result, overview: overview() };
    }),
  );

  ipc.handle(
    IPC.PLUGINS_UNINSTALL,
    guardPluginIpcHandler(IPC.PLUGINS_UNINSTALL, hosts, async ([id, rawOptions]) => {
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "参数格式非法" };
      }
      const optsRecord = rawOptions && typeof rawOptions === "object"
        ? rawOptions as UninstallPluginOptions
        : {};
      try {
        await controller.uninstallPlugin(id, {
          deleteSecrets: Boolean(optsRecord.deleteSecrets),
          deleteData: Boolean(optsRecord.deleteData),
        });
        return { ok: true, overview: overview() };
      } catch (error) {
        return { ok: false, error: errorMessage(error), overview: overview() };
      }
    }),
  );

  ipc.handle(
    IPC.PLUGINS_OPEN,
    guardPluginIpcHandler(IPC.PLUGINS_OPEN, hosts, () => ({ ok: false, error: "独立窗口尚未启用" })),
  );
}
