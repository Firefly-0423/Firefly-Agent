import { randomUUID } from "node:crypto";
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
    | "openPluginWindow"
  > & Partial<Pick<PluginV2HostController, "listPendingCleanups">>;
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
    canOpen: Boolean(snap.manifest.ui?.windows?.length),
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
  controller: Pick<PluginV2HostController, "listPlugins"> & Partial<Pick<PluginV2HostController, "listPendingCleanups">>,
): PluginOverview {
  const pendingCleanups = controller.listPendingCleanups?.() ?? [];
  return {
    plugins: controller.listPlugins().map(snapshotToListEntry),
    issues: [],
    ...(pendingCleanups.length > 0 ? { pendingCleanups } : {}),
  };
}

export function notifyPluginOverviewChanged(
  controller: Pick<PluginV2HostController, "listPlugins"> & Partial<Pick<PluginV2HostController, "listPendingCleanups">>,
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

  // One pending replace confirmation: it remembers the exact path and package hash that were shown to the user.
  let pendingReplacement: { token: string; sourcePath: string; sha256: string } | undefined;

  const runImport = async (select: () => Promise<string | undefined>, rawToken: unknown) => {
    let sourcePath: string | undefined;
    let opts: { confirmedReplacement: { sha256: string } } | undefined;
    if (rawToken !== undefined) {
      const pending = pendingReplacement;
      pendingReplacement = undefined;
      if (typeof rawToken !== "string" || !pending || pending.token !== rawToken) {
        return { ok: false, error: "替换确认已失效，请重新导入", overview: overview() };
      }
      sourcePath = pending.sourcePath;
      opts = { confirmedReplacement: { sha256: pending.sha256 } };
    } else {
      pendingReplacement = undefined;
      sourcePath = await select();
      if (!sourcePath) return { ok: false, canceled: true };
    }
    const result = opts
      ? await controller.importFromPath(sourcePath, opts)
      : await controller.importFromPath(sourcePath);
    if (!result.ok && result.installation === "needs-confirmation") {
      const token = randomUUID();
      pendingReplacement = { token, sourcePath, sha256: result.replace.packageSha256 };
      return { ...result, confirmToken: token, overview: overview() };
    }
    return { ...result, overview: overview() };
  };

  ipc.handle(
    IPC.PLUGINS_IMPORT_ZIP,
    guardPluginIpcHandler(IPC.PLUGINS_IMPORT_ZIP, hosts, ([token]) => runImport(deps.selectPluginPackage, token)),
  );

  ipc.handle(
    IPC.PLUGINS_IMPORT_FOLDER,
    guardPluginIpcHandler(IPC.PLUGINS_IMPORT_FOLDER, hosts, ([token]) => runImport(deps.selectPluginFolder, token)),
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
        const result = await controller.uninstallPlugin(id, {
          ...(optsRecord.deleteSecrets !== undefined ? { deleteSecrets: Boolean(optsRecord.deleteSecrets) } : {}),
          ...(optsRecord.deleteData !== undefined ? { deleteData: Boolean(optsRecord.deleteData) } : {}),
        });
        return {
          ok: result.ok,
          cleanup: result.cleanup,
          ...(result.error ? { error: result.error } : {}),
          overview: overview(),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error), overview: overview() };
      }
    }),
  );

  ipc.handle(
    IPC.PLUGINS_OPEN,
    guardPluginIpcHandler(IPC.PLUGINS_OPEN, hosts, async ([id]) => {
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "参数格式非法" };
      }
      try {
        await controller.openPluginWindow(id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }),
  );
}
