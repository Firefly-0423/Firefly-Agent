import {
  PLUGIN_CONTEXT_MODES,
  PLUGIN_RUN_SOURCES,
  type PluginContextMode,
  type PluginManifestV1,
  type PluginRunSource,
} from "../../../shared/plugin-manifest";
import {
  HOST_TO_PLUGIN_METHODS,
  PLUGIN_TO_HOST_METHODS,
  PluginError,
} from "../../../shared/plugin-protocol";
import type { PluginRpc } from "../../../shared/plugin-rpc";
import { logger, LogTag } from "../../../main/base/logging/logger";
import { wrapExternalData } from "./boundary";

export const PLUGIN_CONTEXT_TIMEOUT_MS = 1_500;
export const MAX_PLUGIN_CONTEXT_CHARS = 16_000;
export const MAX_PLUGIN_CONTEXT_TOTAL_CHARS = 32_000;

export interface PluginContextHost {
  call<T = unknown>(
    id: string,
    method: string,
    params: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
}

export interface RegisteredContextProvider {
  pluginId: string;
  pluginName: string;
  id: string;
  modes: PluginContextMode[];
  sources: PluginRunSource[];
}

export interface CollectPluginContextInput {
  sessionId: string;
  mode: PluginContextMode;
  source: PluginRunSource;
  signal?: AbortSignal;
}

export interface CollectedContextEntry {
  pluginId: string;
  pluginName: string;
  providerId: string;
  heading: string;
  content: string;
  wrapped: string;
}

export interface CollectPluginContextResult {
  blocks: string[];
  promptText: string;
  entries: CollectedContextEntry[];
}

export interface PluginContextServiceOptions {
  timeoutMs?: number;
  maxCharsPerProvider?: number;
  maxTotalChars?: number;
}

export interface PluginContextService {
  registerProvider(
    manifest: PluginManifestV1,
    registration: unknown,
    host: PluginContextHost,
  ): RegisteredContextProvider;
  unregisterProvider(pluginId: string, providerId: string): boolean;
  unregisterPlugin(pluginId: string): number;
  listProviders(pluginId?: string): RegisteredContextProvider[];
  collectContext(input: CollectPluginContextInput): Promise<CollectPluginContextResult>;
  bindRpc(manifest: PluginManifestV1, rpc: PluginRpc, host: PluginContextHost): () => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface StoredContextProvider {
  record: RegisteredContextProvider;
  host: PluginContextHost;
}

function linkAbortSignal(parent?: AbortSignal): { controller: AbortController; detach(): void } {
  const controller = new AbortController();
  if (!parent) return { controller, detach: () => {} };
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, detach: () => {} };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    detach: () => parent.removeEventListener("abort", onAbort),
  };
}

export function createPluginContextService(options: PluginContextServiceOptions = {}): PluginContextService {
  const timeoutMs = options.timeoutMs ?? PLUGIN_CONTEXT_TIMEOUT_MS;
  const maxCharsPerProvider = options.maxCharsPerProvider ?? MAX_PLUGIN_CONTEXT_CHARS;
  const maxTotalChars = options.maxTotalChars ?? MAX_PLUGIN_CONTEXT_TOTAL_CHARS;
  const providers = new Map<string, StoredContextProvider>();

  const keyFor = (pluginId: string, providerId: string) => `${pluginId}\0${providerId}`;

  const registerProvider: PluginContextService["registerProvider"] = (manifest, registration, host) => {
    if (!isPlainRecord(registration)) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "context.register payload must be an object");
    }
    const id = typeof registration.id === "string" ? registration.id.trim() : "";
    if (!id || id !== registration.id) {
      throw new PluginError("ERR_INVALID_ARGUMENT", "context.register requires a non-empty provider id");
    }

    const declared = manifest.context?.find((entry) => entry.id === id);
    if (!declared) {
      throw new PluginError("ERR_UNDECLARED", `Context provider "${id}" is not declared in the manifest`);
    }

    if (!Array.isArray(registration.modes) || registration.modes.length === 0) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `context.register "${id}" requires a non-empty modes array`);
    }
    if (!Array.isArray(registration.sources) || registration.sources.length === 0) {
      throw new PluginError("ERR_INVALID_ARGUMENT", `context.register "${id}" requires a non-empty sources array`);
    }

    const modes: PluginContextMode[] = [];
    for (const candidate of registration.modes) {
      if (typeof candidate !== "string" || !PLUGIN_CONTEXT_MODES.includes(candidate as PluginContextMode)) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Unknown context mode: ${String(candidate)}`);
      }
      if (!declared.modes.includes(candidate as PluginContextMode)) {
        throw new PluginError("ERR_UNDECLARED", `Context mode "${candidate}" is not declared for "${id}"`);
      }
      if (!modes.includes(candidate as PluginContextMode)) {
        modes.push(candidate as PluginContextMode);
      }
    }

    const sources: PluginRunSource[] = [];
    for (const candidate of registration.sources) {
      if (typeof candidate !== "string" || !PLUGIN_RUN_SOURCES.includes(candidate as PluginRunSource)) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Unknown context source: ${String(candidate)}`);
      }
      if (!declared.sources.includes(candidate as PluginRunSource)) {
        throw new PluginError("ERR_UNDECLARED", `Context source "${candidate}" is not declared for "${id}"`);
      }
      if (!sources.includes(candidate as PluginRunSource)) {
        sources.push(candidate as PluginRunSource);
      }
    }

    const record: RegisteredContextProvider = {
      pluginId: manifest.id,
      pluginName: manifest.name,
      id,
      modes,
      sources,
    };
    providers.set(keyFor(manifest.id, id), { record, host });
    return record;
  };

  const unregisterProvider: PluginContextService["unregisterProvider"] = (pluginId, providerId) =>
    providers.delete(keyFor(pluginId, providerId));

  const unregisterPlugin: PluginContextService["unregisterPlugin"] = (pluginId) => {
    let removed = 0;
    for (const [key, entry] of [...providers.entries()]) {
      if (entry.record.pluginId !== pluginId) continue;
      providers.delete(key);
      removed += 1;
    }
    return removed;
  };

  const listProviders: PluginContextService["listProviders"] = (pluginId) =>
    [...providers.values()]
      .filter((entry) => pluginId === undefined || entry.record.pluginId === pluginId)
      .map((entry) => entry.record);

  const queryProvider = async (
    entry: StoredContextProvider,
    turn: { sessionId: string; mode: PluginContextMode; source: PluginRunSource },
    signal?: AbortSignal,
  ): Promise<{ heading: string; content: string } | null> => {
    if (signal?.aborted) {
      throw new PluginError("ERR_CANCELLED", "Context collection aborted");
    }
    const { controller, detach } = linkAbortSignal(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 每个插件只接收独立的最小 turn 元数据，绝不把其他插件或宿主系统提示词传给它。
      const pending = entry.host.call<unknown>(
        entry.record.pluginId,
        HOST_TO_PLUGIN_METHODS.contextProvide,
        {
          id: entry.record.id,
          turn: {
            sessionId: turn.sessionId,
            mode: turn.mode,
            source: turn.source,
          },
        },
        { signal: controller.signal, timeoutMs },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new PluginError("ERR_TIMEOUT", `Context provider ${entry.record.pluginId}:${entry.record.id} timed out after ${timeoutMs}ms`, true);
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      });
      const raw = await Promise.race([pending, timeoutPromise]);
      if (raw === null || raw === undefined) return null;
      if (!isPlainRecord(raw) || typeof raw.heading !== "string" || typeof raw.content !== "string") {
        throw new PluginError("ERR_INVALID_ARGUMENT", "Context provider must return { heading, content } or null");
      }
      const heading = raw.heading.trim();
      const content = raw.content.trim();
      if (!heading && !content) return null;
      return {
        heading,
        content: content.length > maxCharsPerProvider ? content.slice(0, maxCharsPerProvider) : content,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      detach();
    }
  };

  const collectContext: PluginContextService["collectContext"] = async (input) => {
    const eligible = [...providers.values()].filter(
      ({ record }) => record.modes.includes(input.mode) && record.sources.includes(input.source),
    );
    if (eligible.length === 0) {
      return { blocks: [], promptText: "", entries: [] };
    }

    const turnSnapshot = {
      sessionId: input.sessionId,
      mode: input.mode,
      source: input.source,
    };

    const settled = await Promise.allSettled(
      eligible.map((entry) => queryProvider(entry, turnSnapshot, input.signal)),
    );

    const blocks: string[] = [];
    const entries: CollectedContextEntry[] = [];
    let usedChars = 0;

    for (let i = 0; i < eligible.length; i++) {
      const result = settled[i];
      const { record } = eligible[i];
      if (result.status === "rejected") {
        logger.warn(
          LogTag.Plugins,
          `plugin context skipped (${record.pluginId}:${record.id}):`,
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
        continue;
      }
      if (!result.value) continue;

      const { heading, content } = result.value;
      const wrapped = wrapExternalData({
        source: `plugin:${record.pluginId}`,
        pluginName: record.pluginName,
        providerId: record.id,
        heading,
        content,
      });

      const separatorLen = blocks.length > 0 ? 2 : 0;
      if (usedChars + separatorLen + wrapped.length > maxTotalChars) {
        logger.warn(
          LogTag.Plugins,
          `plugin context total length exceeded ${maxTotalChars} chars; skipped (${record.pluginId}:${record.id})`,
        );
        break;
      }

      usedChars += separatorLen + wrapped.length;
      blocks.push(wrapped);
      entries.push({
        pluginId: record.pluginId,
        pluginName: record.pluginName,
        providerId: record.id,
        heading,
        content,
        wrapped,
      });
    }

    return {
      blocks,
      promptText: blocks.join("\n\n"),
      entries,
    };
  };

  const bindRpc: PluginContextService["bindRpc"] = (manifest, rpc, host) => {
    const offRegister = rpc.handle(PLUGIN_TO_HOST_METHODS.contextRegister, (params) => {
      registerProvider(manifest, params, host);
      return null;
    });
    const offUnregister = rpc.handle(PLUGIN_TO_HOST_METHODS.contextUnregister, (params) => {
      if (!isPlainRecord(params) || typeof params.id !== "string" || !params.id.trim()) {
        throw new PluginError("ERR_INVALID_ARGUMENT", "context.unregister requires a non-empty provider id");
      }
      unregisterProvider(manifest.id, params.id);
      return null;
    });
    return () => {
      offRegister();
      offUnregister();
    };
  };

  return {
    registerProvider,
    unregisterProvider,
    unregisterPlugin,
    listProviders,
    collectContext,
    bindRpc,
  };
}
