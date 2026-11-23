import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import {
  HOST_TO_PLUGIN_METHODS as H,
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
  type ProtocolUiMessageEvent,
  type ProtocolUiTarget,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { buildPluginWindowUrl } from "./assets";

const DEFAULT_WINDOW_WIDTH = 640;
const DEFAULT_WINDOW_HEIGHT = 480;

export interface CreatePluginWindowOptions {
  pluginId: string;
  windowId: string;
  title: string;
  width: number;
  height: number;
  url: string;
  packageRoot: string;
}

export interface PluginUiWindowInstance {
  readonly webContentsId: number;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  sendMessage(msg: unknown): void;
  onClosed(listener: () => void): () => void;
  load(): Promise<void>;
}

export interface PluginUiResolvedPlugin {
  packageRoot: string;
  manifest: PluginManifestV1;
  isEnabled: boolean;
  hasWindowsPermission: boolean;
}

export interface PluginUiServiceDeps {
  resolvePlugin(pluginId: string): PluginUiResolvedPlugin | null;
  sendToPlugin(
    pluginId: string,
    method: typeof H.uiMessage,
    params: ProtocolUiMessageEvent,
  ): Promise<unknown>;
  createWindow(options: CreatePluginWindowOptions): PluginUiWindowInstance;
  onSettingsMessage?(pluginId: string, msg: unknown): void;
}

interface OpenWindowEntry {
  key: string;
  pluginId: string;
  windowId: string;
  window: PluginUiWindowInstance;
  state: unknown;
  ready: boolean;
  pendingMessages: unknown[];
  loadPromise: Promise<void>;
  offClosed: () => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Invalid UI RPC arguments");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new PluginError("ERR_INVALID_ARGUMENT", "Unexpected field in UI RPC arguments");
  }
  return value;
}

function assertNonEmptyId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginError("ERR_INVALID_ARGUMENT", `${label} must be a non-empty string`);
  }
  return value;
}

function cloneState(value: unknown): unknown {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function windowKey(pluginId: string, windowId: string): string {
  return `${pluginId}\0${windowId}`;
}

function normalizeWindowTarget(to: unknown): ProtocolUiTarget {
  const record = assertObject(to, ["kind", "id"]);
  if (record.kind !== "window" && record.kind !== "settings") {
    throw new PluginError("ERR_INVALID_ARGUMENT", "UI target kind must be 'window' or 'settings'");
  }
  const id = assertNonEmptyId(record.id, "UI target id");
  return { kind: record.kind, id };
}

export function createPluginUiService(deps: PluginUiServiceDeps) {
  const windowsByKey = new Map<string, OpenWindowEntry>();
  const windowsByWebContentsId = new Map<number, OpenWindowEntry>();
  const accessWatchers = new Map<string, Set<() => void>>();

  const requirePlugin = (pluginId: string): PluginUiResolvedPlugin => {
    const resolved = deps.resolvePlugin(pluginId);
    if (!resolved) {
      throw new PluginError("ERR_UNAVAILABLE", `Plugin "${pluginId}" is not installed`);
    }
    if (!resolved.isEnabled) {
      throw new PluginError("ERR_UNAVAILABLE", `Plugin "${pluginId}" is not active`);
    }
    return resolved;
  };

  const requireWindowPermissionAndDeclaration = (pluginId: string, windowId: string) => {
    const plugin = requirePlugin(pluginId);
    const declaredWindow = plugin.manifest.ui?.windows?.find((w) => w.id === windowId);
    const declaredPerm = (plugin.manifest.permissions ?? []).includes("ui.windows");
    if (!declaredPerm) {
      throw new PluginError("ERR_UNDECLARED", 'Permission "ui.windows" is not declared in manifest');
    }
    if (!plugin.hasWindowsPermission) {
      throw new PluginError("ERR_PERMISSION", 'Permission "ui.windows" is not granted');
    }
    if (!declaredWindow) {
      throw new PluginError("ERR_UNDECLARED", `UI window "${windowId}" is not declared in manifest`);
    }
    return { plugin, declaredWindow };
  };

  const detachEntry = (entry: OpenWindowEntry): void => {
    if (windowsByKey.get(entry.key) === entry) {
      windowsByKey.delete(entry.key);
    }
    if (windowsByWebContentsId.get(entry.window.webContentsId) === entry) {
      windowsByWebContentsId.delete(entry.window.webContentsId);
    }
    entry.offClosed();
  };

  const closeEntry = (entry: OpenWindowEntry): void => {
    detachEntry(entry);
    if (!entry.window.isDestroyed()) {
      entry.window.close();
    }
  };

  const openWindow = async (pluginId: string, windowId: string, state?: unknown): Promise<void> => {
    assertNonEmptyId(windowId, "Window id");
    const { plugin, declaredWindow } = requireWindowPermissionAndDeclaration(pluginId, windowId);
    const key = windowKey(pluginId, windowId);

    const existing = windowsByKey.get(key);
    if (existing && !existing.window.isDestroyed()) {
      existing.state = cloneState(state);
      await existing.loadPromise;
      if (!existing.window.isDestroyed()) {
        existing.window.show();
        existing.window.focus();
      }
      return;
    }
    if (existing) {
      detachEntry(existing);
    }

    const url = buildPluginWindowUrl(pluginId, declaredWindow.entry);
    const instance = deps.createWindow({
      pluginId,
      windowId,
      title: declaredWindow.title,
      width: declaredWindow.width ?? DEFAULT_WINDOW_WIDTH,
      height: declaredWindow.height ?? DEFAULT_WINDOW_HEIGHT,
      url,
      packageRoot: plugin.packageRoot,
    });

    const entry: OpenWindowEntry = {
      key,
      pluginId,
      windowId,
      window: instance,
      state: cloneState(state),
      ready: false,
      pendingMessages: [],
      loadPromise: Promise.resolve(),
      offClosed: () => {},
    };

    entry.offClosed = instance.onClosed(() => {
      detachEntry(entry);
    });
    windowsByKey.set(key, entry);
    windowsByWebContentsId.set(instance.webContentsId, entry);

    entry.loadPromise = instance.load().catch((error) => {
      closeEntry(entry);
      throw error instanceof PluginError
        ? error
        : new PluginError("ERR_INTERNAL", "Failed to load plugin window", { cause: error });
    });

    await entry.loadPromise;
    if (!instance.isDestroyed()) {
      instance.show();
    }
  };

  const closeWindow = async (pluginId: string, windowId: string): Promise<void> => {
    assertNonEmptyId(windowId, "Window id");
    requireWindowPermissionAndDeclaration(pluginId, windowId);
    const entry = windowsByKey.get(windowKey(pluginId, windowId));
    if (entry) {
      closeEntry(entry);
    }
  };

  const postMessage = async (pluginId: string, to: ProtocolUiTarget, msg: unknown): Promise<void> => {
    const target = normalizeWindowTarget(to);
    if (target.kind === "window") {
      requireWindowPermissionAndDeclaration(pluginId, target.id);
      const entry = windowsByKey.get(windowKey(pluginId, target.id));
      if (!entry || entry.window.isDestroyed()) return;
      const payload = cloneState(msg);
      if (entry.ready) {
        entry.window.sendMessage(payload);
      } else {
        entry.pendingMessages.push(payload);
      }
      return;
    }

    const plugin = requirePlugin(pluginId);
    if (!plugin.manifest.ui?.settings) {
      throw new PluginError("ERR_UNDECLARED", "UI settings panel is not declared in manifest");
    }
    deps.onSettingsMessage?.(pluginId, cloneState(msg));
  };

  const handleWindowInvoke = async (senderWebContentsId: number, payload: unknown): Promise<unknown> => {
    const entry = windowsByWebContentsId.get(senderWebContentsId);
    if (!entry || entry.window.isDestroyed()) {
      throw new PluginError("ERR_UNAVAILABLE", "Plugin window is not active");
    }
    if (!isPlainRecord(payload)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "Window message payload must be an object");
    }
    if ("pluginId" in payload || "targetPluginId" in payload || "to" in payload || "from" in payload) {
      throw new PluginError("ERR_PERMISSION", "Cross-plugin window messaging is forbidden");
    }
    const keys = Object.keys(payload);
    if (keys.some((key) => key !== "method" && key !== "params")) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "Unexpected field in window message payload");
    }
    const method = assertNonEmptyId(payload.method, "method");

    const plugin = requirePlugin(entry.pluginId);
    if (!plugin.hasWindowsPermission) {
      throw new PluginError("ERR_PERMISSION", 'Permission "ui.windows" is not granted');
    }

    return deps.sendToPlugin(entry.pluginId, H.uiMessage, {
      from: { kind: "window", id: entry.windowId },
      method,
      params: payload.params,
    });
  };

  const handleWindowGetState = (senderWebContentsId: number): unknown => {
    const entry = windowsByWebContentsId.get(senderWebContentsId);
    if (!entry || entry.window.isDestroyed()) return undefined;
    return cloneState(entry.state);
  };

  const handleWindowReady = (senderWebContentsId: number): void => {
    const entry = windowsByWebContentsId.get(senderWebContentsId);
    if (!entry || entry.window.isDestroyed()) return;
    entry.ready = true;
    while (entry.pendingMessages.length > 0 && !entry.window.isDestroyed()) {
      entry.window.sendMessage(entry.pendingMessages.shift());
    }
  };

  const handleWindowClose = async (senderWebContentsId: number): Promise<void> => {
    const entry = windowsByWebContentsId.get(senderWebContentsId);
    if (entry) {
      closeEntry(entry);
    }
  };

  const closePluginWindows = (pluginId: string): number => {
    let closed = 0;
    for (const entry of [...windowsByKey.values()]) {
      if (entry.pluginId !== pluginId) continue;
      closeEntry(entry);
      closed += 1;
    }
    return closed;
  };

  const closeAllWindows = (): number => {
    let closed = 0;
    for (const entry of [...windowsByKey.values()]) {
      closeEntry(entry);
      closed += 1;
    }
    return closed;
  };

  const listOpenWindowIds = (pluginId: string): string[] => {
    const ids: string[] = [];
    for (const entry of windowsByKey.values()) {
      if (entry.pluginId === pluginId && !entry.window.isDestroyed()) {
        ids.push(entry.windowId);
      }
    }
    return ids;
  };

  const notifyAccessChanged = (pluginId: string): void => {
    const watchers = accessWatchers.get(pluginId);
    if (!watchers) return;
    for (const wake of [...watchers]) {
      wake();
    }
  };

  const assertOnMessageAllowed = (pluginId: string): void => {
    const plugin = requirePlugin(pluginId);
    const perms = plugin.manifest.permissions ?? [];
    const hasUi =
      perms.includes("ui.windows")
      || Boolean(plugin.manifest.ui?.settings)
      || Boolean(plugin.manifest.ui?.windows?.length);
    if (!hasUi) {
      throw new PluginError("ERR_UNDECLARED", "UI capability is not declared in manifest");
    }
    if (perms.includes("ui.windows") && !plugin.hasWindowsPermission) {
      throw new PluginError("ERR_PERMISSION", 'Permission "ui.windows" is not granted');
    }
  };

  const bindRpc = (pluginId: string, rpc: PluginRpc): (() => void) => {
    const stopController = new AbortController();
    const stops = [
      rpc.handle(P.uiOpenWindow, async (params) => {
        const input = assertObject(params, ["id", "state"]);
        const id = assertNonEmptyId(input.id, "Window id");
        await openWindow(pluginId, id, input.state);
      }),
      rpc.handle(P.uiCloseWindow, async (params) => {
        const input = assertObject(params, ["id"]);
        const id = assertNonEmptyId(input.id, "Window id");
        await closeWindow(pluginId, id);
      }),
      rpc.handle(P.uiPost, async (params) => {
        const input = assertObject(params, ["to", "msg"]);
        await postMessage(pluginId, input.to as ProtocolUiTarget, input.msg);
      }),
      rpc.handle(P.uiOnMessage, (params, { signal }) => {
        assertObject(params ?? {}, []);
        assertOnMessageAllowed(pluginId);
        return (async function* (): AsyncIterable<ProtocolUiMessageEvent> {
          let wake = () => {};
          let closed = false;
          const wakeUp = () => wake();
          const onAbort = () => {
            closed = true;
            wake();
          };
          let watchers = accessWatchers.get(pluginId);
          if (!watchers) {
            watchers = new Set();
            accessWatchers.set(pluginId, watchers);
          }
          watchers.add(wakeUp);
          signal.addEventListener("abort", onAbort, { once: true });
          stopController.signal.addEventListener("abort", onAbort, { once: true });
          try {
            while (!closed && !signal.aborted && !stopController.signal.aborted) {
              assertOnMessageAllowed(pluginId);
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          } finally {
            watchers.delete(wakeUp);
            if (watchers.size === 0) accessWatchers.delete(pluginId);
            signal.removeEventListener("abort", onAbort);
            stopController.signal.removeEventListener("abort", onAbort);
          }
        })();
      }),
    ];

    return () => {
      stopController.abort("disposed");
      for (const stop of stops) stop();
      closePluginWindows(pluginId);
    };
  };

  return {
    openWindow,
    closeWindow,
    postMessage,
    handleWindowInvoke,
    handleWindowGetState,
    handleWindowReady,
    handleWindowClose,
    closePluginWindows,
    closeAllWindows,
    listOpenWindowIds,
    notifyAccessChanged,
    bindRpc,
  };
}

export type PluginUiService = ReturnType<typeof createPluginUiService>;
