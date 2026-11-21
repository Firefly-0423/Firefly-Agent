import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HOST_TO_PLUGIN_METHODS as H,
  PluginError,
} from "../../../shared/plugin-protocol";
import {
  createRpcEndpoint,
  type PluginRpc,
  type RpcTransport,
} from "../../../shared/plugin-rpc";
import {
  createPluginContextProxy,
  type PluginContextRuntime,
  type RuntimePluginContext,
} from "./context";

export interface RuntimePluginModule {
  activate(ctx: RuntimePluginContext): void | Promise<void>;
  deactivate?(reason: string): void | Promise<void>;
}

export interface PluginLoader {
  load(mainPath: string): Promise<RuntimePluginModule>;
}

export interface TransferredPortLike {
  postMessage(frame: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close?(): void;
}

export interface ParentPortLike {
  once(event: "message", listener: (event: { ports: TransferredPortLike[] }) => void): unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractPluginExport(loaded: unknown): RuntimePluginModule {
  const candidate = isPlainRecord(loaded)
    ? (typeof (loaded.default as { activate?: unknown } | undefined)?.activate === "function"
      ? loaded.default
      : typeof ((loaded.default as { default?: { activate?: unknown } } | undefined)?.default)?.activate === "function"
        ? (loaded.default as { default: unknown }).default
        : loaded)
    : loaded;

  if (
    !candidate
    || typeof candidate !== "object"
    || typeof (candidate as { activate?: unknown }).activate !== "function"
  ) {
    throw new PluginError("ERR_INTERNAL", "Plugin main module must export an object with activate(ctx)");
  }
  return candidate as RuntimePluginModule;
}

export const defaultPluginLoader: PluginLoader = {
  async load(mainPath: string): Promise<RuntimePluginModule> {
    const spec = mainPath.startsWith("file://")
      ? mainPath
      : pathToFileURL(path.resolve(mainPath)).href;
    let loaded: unknown;
    try {
      // Preserves native ESM import() in CommonJS tsc output (e.g. Electron utilityProcess).
      const dynamicImport = new Function("url", "return import(url);") as (url: string) => Promise<unknown>;
      loaded = await dynamicImport(spec);
    } catch {
      loaded = await import(/* @vite-ignore */ spec);
    }
    return extractPluginExport(loaded);
  },
};

export interface AttachPluginRuntimeOptions {
  loader?: PluginLoader;
  fallbackMain?: string;
}

export interface AttachedPluginRuntime {
  rpc: PluginRpc;
  dispose(): void;
}

/**
 * Attaches the child-process plugin runtime lifecycle (`activate` / `deactivate` + `ctx` proxy)
 * to a transport-neutral `RpcTransport`.
 */
export function attachPluginRuntime(
  transport: RpcTransport,
  options: AttachPluginRuntimeOptions = {},
): AttachedPluginRuntime {
  const loader = options.loader ?? defaultPluginLoader;
  const rpc = createRpcEndpoint(transport);

  let stopController: AbortController | undefined;
  let plugin: RuntimePluginModule | undefined;
  let ctxRuntime: PluginContextRuntime | undefined;
  let activated = false;

  const reset = () => {
    ctxRuntime?.dispose();
    ctxRuntime = undefined;
    plugin = undefined;
    stopController = undefined;
    activated = false;
  };

  rpc.handle(H.activate, async (params) => {
    if (activated) {
      throw new PluginError("ERR_INTERNAL", "Plugin is already activated");
    }
    if (!isPlainRecord(params) || typeof params.id !== "string" || typeof params.dataDir !== "string") {
      throw new PluginError("ERR_INVALID_ARGUMENT", "activate requires string id and dataDir");
    }
    const mainPath = typeof params.main === "string" && params.main.length > 0
      ? params.main
      : options.fallbackMain;
    if (!mainPath) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "activate requires a plugin main entry path");
    }
    const version = typeof params.version === "string" ? params.version : "0.0.0";
    const permissions = Array.isArray(params.permissions)
      ? params.permissions.filter((item): item is string => typeof item === "string")
      : [];

    const controller = new AbortController();
    const proxyRuntime = createPluginContextProxy({
      id: params.id,
      version,
      dataDir: params.dataDir,
      permissions,
      signal: controller.signal,
      rpc,
    });
    stopController = controller;
    ctxRuntime = proxyRuntime;
    activated = true;

    try {
      const loadedPlugin = await loader.load(mainPath);
      plugin = loadedPlugin;
      await loadedPlugin.activate(proxyRuntime.ctx);
      await proxyRuntime.awaitPendingRegistrations();
      return null;
    } catch (error) {
      controller.abort("fault");
      reset();
      throw error;
    }
  });

  rpc.handle(H.deactivate, async (params) => {
    const reason = typeof params === "string"
      ? params
      : isPlainRecord(params) && typeof params.reason === "string"
        ? params.reason
        : "disabled";
    stopController?.abort(reason);
    const activePlugin = plugin;
    try {
      await activePlugin?.deactivate?.(reason);
    } finally {
      reset();
    }
    return null;
  });

  return {
    rpc,
    dispose() {
      stopController?.abort("disposed");
      reset();
      rpc.dispose();
    },
  };
}

/**
 * Connects the child-process runtime to Electron utilityProcess `process.parentPort`.
 */
export function connectParentPortRuntime(
  parentPort: ParentPortLike,
  options: AttachPluginRuntimeOptions = {},
): Promise<AttachedPluginRuntime> {
  return new Promise((resolve) => {
    parentPort.once("message", ({ ports }) => {
      const port = ports[0];
      const transport: RpcTransport = {
        post: (frame) => port.postMessage(frame),
        onFrame: (callback) => {
          const listener = (event: { data: unknown }) => callback(event.data);
          port.on("message", listener);
          return () => {
            port.off("message", listener);
          };
        },
      };
      const attached = attachPluginRuntime(transport, options);
      port.start();
      resolve(attached);
    });
  });
}
