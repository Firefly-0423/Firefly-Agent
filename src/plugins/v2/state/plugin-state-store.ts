import fs from "node:fs";
import { AtomicJsonStore } from "../../../main/base/storage/atomic-json-store";
import { getStorageContext } from "../../../main/base/storage/storage-context";
import { logger, LogTag } from "../../../main/base/logging/logger";
import {
  PLUGIN_PERMISSIONS,
  type PluginManifestV1,
  type PluginPermission,
} from "../../../shared/plugin-manifest";
import { PluginError } from "../../../shared/plugin-protocol";
import type { ServicePermission } from "../services";

export const PLUGIN_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_MODEL_RATE_LIMIT = 10;
export const MIN_MODEL_RATE_LIMIT = 1;
export const MAX_MODEL_RATE_LIMIT = 60;

export type ConfirmationPermission = "sessions.read" | "workspace.read" | "model.run";
export type PluginStateReadStatus = "ok" | "missing" | "corrupted";

const CONFIRMATION_PERMISSIONS = new Set<string>(["sessions.read", "workspace.read", "model.run"]);
const MANIFEST_PERMISSION_SET = new Set<string>(PLUGIN_PERMISSIONS);

export type PluginOrigin = "local" | "market";
export type PluginSourceKind = "curated-market" | "bundled" | "local-package" | "local-folder";

export interface StoredPluginState {
  version: string;
  main: string;
  installDir?: string;
  manifest: PluginManifestV1;
  enabled: boolean;
  grantedPermissions: string[];
  revision: number;
  confirmations: Partial<Record<ConfirmationPermission, number>>;
  modelRateLimit: number;
  origin?: PluginOrigin;
  sourceKind?: PluginSourceKind;
  sourceId?: string;
}

export interface PluginStateDocument {
  schemaVersion: 1;
  plugins: Record<string, StoredPluginState>;
}

export interface PluginStateStoreOptions {
  /** Overrides path resolution for unit/integration tests; defaults to `getStorageContext().files.pluginState`. */
  stateFile?: string;
}

export interface InstallPluginStateInput {
  manifest: PluginManifestV1;
  installDir?: string;
  enabled?: boolean;
  grantedPermissions?: readonly string[];
  origin?: PluginOrigin;
  sourceKind?: PluginSourceKind;
  sourceId?: string;
}

export function toolGrantKey(toolName: string): string {
  return `tool:${toolName}`;
}

function emptyDocument(): PluginStateDocument {
  return { schemaVersion: PLUGIN_STATE_SCHEMA_VERSION, plugins: {} };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidRateLimit(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_MODEL_RATE_LIMIT
    && value <= MAX_MODEL_RATE_LIMIT
  );
}

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidStoredPluginState(id: string, value: unknown): value is StoredPluginState {
  if (!isPlainRecord(value)) return false;
  if (typeof value.version !== "string" || value.version.trim().length === 0) return false;
  if (typeof value.main !== "string" || value.main.trim().length === 0) return false;
  if (value.installDir !== undefined && (typeof value.installDir !== "string" || value.installDir.trim().length === 0)) return false;
  if (!isPlainRecord(value.manifest) || value.manifest.id !== id) return false;
  if (typeof value.manifest.name !== "string" || typeof value.manifest.version !== "string" || typeof value.manifest.main !== "string") return false;
  if (typeof value.enabled !== "boolean") return false;
  if (!Array.isArray(value.grantedPermissions) || value.grantedPermissions.some((item) => typeof item !== "string" || item.length === 0)) return false;
  if (!isValidRevision(value.revision)) return false;
  if (!isPlainRecord(value.confirmations)) return false;
  for (const [key, rev] of Object.entries(value.confirmations)) {
    if (!CONFIRMATION_PERMISSIONS.has(key) || !isValidRevision(rev)) return false;
  }
  if (!isValidRateLimit(value.modelRateLimit)) return false;
  if (value.origin !== undefined && value.origin !== "local" && value.origin !== "market") return false;
  if (
    value.sourceKind !== undefined
    && value.sourceKind !== "curated-market"
    && value.sourceKind !== "bundled"
    && value.sourceKind !== "local-package"
    && value.sourceKind !== "local-folder"
  ) {
    return false;
  }
  if (value.sourceId !== undefined && (typeof value.sourceId !== "string" || value.sourceId.trim().length === 0)) return false;
  return true;
}

export function isValidPluginStateDocument(value: unknown): value is PluginStateDocument {
  if (!isPlainRecord(value)) return false;
  if (value.schemaVersion !== PLUGIN_STATE_SCHEMA_VERSION) return false;
  if (!isPlainRecord(value.plugins)) return false;
  return Object.entries(value.plugins).every(([id, entry]) => isValidStoredPluginState(id, entry));
}

function declaredGrantableKeys(manifest: PluginManifestV1): Set<string> {
  const allowed = new Set<string>(manifest.permissions ?? []);
  for (const tool of manifest.tools ?? []) {
    allowed.add(toolGrantKey(tool.name));
  }
  return allowed;
}

function normalizeGrantedPermissions(manifest: PluginManifestV1, permissions: readonly string[]): string[] {
  const allowed = declaredGrantableKeys(manifest);
  const filtered = permissions.filter((entry) => allowed.has(entry));
  return [...new Set(filtered)].sort();
}

function defaultGrantedPermissions(manifest: PluginManifestV1): string[] {
  return [...declaredGrantableKeys(manifest)].sort();
}

function cloneState(entry: StoredPluginState): StoredPluginState {
  return structuredClone(entry);
}

/**
 * Persistent state store for Firefly 1.2.0 v2 plugins (`%APPDATA%\Firefly-1.2.0\plugin-state.json`).
 * Resolves its path via `StorageContext` and persists atomically via `AtomicJsonStore`.
 */
export function createPluginStateStore(options: PluginStateStoreOptions = {}) {
  const stateFile = options.stateFile ?? getStorageContext().files.pluginState;
  const atomicStore = new AtomicJsonStore<PluginStateDocument>(stateFile, isValidPluginStateDocument);
  const listeners = new Set<(pluginId: string) => void>();

  let readStatus: PluginStateReadStatus = fs.existsSync(stateFile) ? "ok" : "missing";
  let document: PluginStateDocument;
  try {
    document = atomicStore.read(emptyDocument());
  } catch (error) {
    readStatus = "corrupted";
    document = emptyDocument();
    logger.warn(LogTag.Plugins, "plugin-state.json read failed; starting with empty fail-closed state", error);
  }

  const notify = (pluginId: string): void => {
    for (const listener of [...listeners]) {
      try { listener(pluginId); } catch { /* Observer failure cannot interrupt state transitions. */ }
    }
  };

  const mutate = <R>(pluginId: string, apply: (draft: PluginStateDocument) => R): R => {
    if (readStatus === "corrupted") {
      throw new PluginError("ERR_INTERNAL", "Plugin state store is corrupted on disk; preserving existing file");
    }
    const previous = structuredClone(document);
    const draft = structuredClone(document);
    const outcome = apply(draft);
    try {
      atomicStore.write(draft);
      document = draft;
      readStatus = "ok";
    } catch (cause) {
      document = previous;
      throw new PluginError("ERR_INTERNAL", "Failed to persist plugin state", { cause });
    }
    notify(pluginId);
    return outcome;
  };

  const requireEntry = (draft: PluginStateDocument, pluginId: string): StoredPluginState => {
    const entry = draft.plugins[pluginId];
    if (!entry) throw new PluginError("ERR_UNAVAILABLE", `Plugin "${pluginId}" is not installed`);
    return entry;
  };

  return {
    get filePath(): string {
      return stateFile;
    },
    getReadStatus(): PluginStateReadStatus {
      return readStatus;
    },
    list(): StoredPluginState[] {
      return Object.values(document.plugins).map(cloneState);
    },
    get(pluginId: string): StoredPluginState | undefined {
      const entry = document.plugins[pluginId];
      return entry ? cloneState(entry) : undefined;
    },
    verifyOnDisk(pluginId: string): StoredPluginState | undefined {
      try {
        if (!fs.existsSync(stateFile)) return undefined;
        const onDisk = atomicStore.read(emptyDocument());
        const entry = onDisk.plugins[pluginId];
        return entry ? cloneState(entry) : undefined;
      } catch {
        return undefined;
      }
    },
    isEnabled(pluginId: string): boolean {
      return document.plugins[pluginId]?.enabled === true;
    },
    isToolGranted(pluginId: string, toolName: string): boolean {
      const entry = document.plugins[pluginId];
      if (!entry || !entry.enabled) return false;
      return entry.grantedPermissions.includes(toolGrantKey(toolName));
    },
    hasPermission(pluginId: string, permission: string): boolean {
      const entry = document.plugins[pluginId];
      if (!entry || !entry.enabled) return false;
      return entry.grantedPermissions.includes(permission);
    },
    getModelRateLimit(pluginId: string): number {
      return document.plugins[pluginId]?.modelRateLimit ?? DEFAULT_MODEL_RATE_LIMIT;
    },
    onChange(listener: (pluginId: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    confirmations: {
      get(pluginId: string, permission: ServicePermission): number | undefined {
        if (!CONFIRMATION_PERMISSIONS.has(permission)) return undefined;
        return document.plugins[pluginId]?.confirmations[permission as ConfirmationPermission];
      },
      set(pluginId: string, permission: ServicePermission, revision: number): void {
        if (!CONFIRMATION_PERMISSIONS.has(permission)) return;
        const current = document.plugins[pluginId];
        if (!current || current.revision !== revision) return;
        if (current.confirmations[permission as ConfirmationPermission] === revision) return;
        mutate(pluginId, (draft) => {
          const entry = draft.plugins[pluginId];
          if (!entry || entry.revision !== revision) return;
          entry.confirmations[permission as ConfirmationPermission] = revision;
        });
      },
    },
    install(input: InstallPluginStateInput): StoredPluginState {
      const manifest = structuredClone(input.manifest);
      const id = manifest.id;
      return mutate(id, (draft) => {
        const existing = draft.plugins[id];
        const upgraded = Boolean(existing && (
          existing.version !== manifest.version
          || existing.main !== manifest.main
          || JSON.stringify(existing.manifest) !== JSON.stringify(manifest)
        ));
        const nextRevision = existing ? (upgraded ? existing.revision + 1 : existing.revision) : 1;
        const nextEnabled = input.enabled ?? (existing ? existing.enabled : false);
        const granted = input.grantedPermissions !== undefined
          ? normalizeGrantedPermissions(manifest, input.grantedPermissions)
          : existing
            ? normalizeGrantedPermissions(manifest, existing.grantedPermissions)
            : (nextEnabled ? defaultGrantedPermissions(manifest) : []);
        const next: StoredPluginState = {
          version: manifest.version,
          main: manifest.main,
          ...(input.installDir !== undefined
            ? { installDir: input.installDir }
            : existing?.installDir !== undefined
              ? { installDir: existing.installDir }
              : {}),
          manifest,
          enabled: nextEnabled,
          grantedPermissions: granted,
          revision: nextRevision,
          confirmations: upgraded ? {} : structuredClone(existing?.confirmations ?? {}),
          modelRateLimit: existing?.modelRateLimit ?? DEFAULT_MODEL_RATE_LIMIT,
          ...(input.origin !== undefined
            ? { origin: input.origin }
            : existing?.origin !== undefined
              ? { origin: existing.origin }
              : {}),
          ...(input.sourceKind !== undefined
            ? { sourceKind: input.sourceKind }
            : existing?.sourceKind !== undefined
              ? { sourceKind: existing.sourceKind }
              : {}),
          ...(input.sourceId !== undefined
            ? { sourceId: input.sourceId }
            : existing?.sourceId !== undefined
              ? { sourceId: existing.sourceId }
              : {}),
        };
        draft.plugins[id] = next;
        return cloneState(next);
      });
    },
    restoreSnapshot(snapshot: StoredPluginState): StoredPluginState {
      const manifest = structuredClone(snapshot.manifest);
      const id = manifest.id;
      return mutate(id, (draft) => {
        const current = draft.plugins[id];
        const nextRevision = Math.max(current?.revision ?? 0, snapshot.revision) + 1;
        const grantedPermissions = normalizeGrantedPermissions(manifest, snapshot.grantedPermissions);
        const grantedSet = new Set(grantedPermissions);
        const restoredConfirmations: Partial<Record<ConfirmationPermission, number>> = {};
        for (const [permission, rev] of Object.entries(snapshot.confirmations ?? {})) {
          if (
            CONFIRMATION_PERMISSIONS.has(permission)
            && rev === snapshot.revision
            && grantedSet.has(permission)
          ) {
            restoredConfirmations[permission as ConfirmationPermission] = nextRevision;
          }
        }
        const restored: StoredPluginState = {
          version: manifest.version,
          main: manifest.main,
          ...(snapshot.installDir !== undefined ? { installDir: snapshot.installDir } : {}),
          manifest,
          enabled: snapshot.enabled,
          grantedPermissions,
          revision: nextRevision,
          confirmations: restoredConfirmations,
          modelRateLimit: isValidRateLimit(snapshot.modelRateLimit)
            ? snapshot.modelRateLimit
            : DEFAULT_MODEL_RATE_LIMIT,
          ...(snapshot.origin !== undefined ? { origin: snapshot.origin } : {}),
          ...(snapshot.sourceKind !== undefined ? { sourceKind: snapshot.sourceKind } : {}),
          ...(snapshot.sourceId !== undefined ? { sourceId: snapshot.sourceId } : {}),
        };
        draft.plugins[id] = restored;
        return cloneState(restored);
      });
    },
    enable(pluginId: string, opts?: { grantedPermissions?: readonly string[] }): StoredPluginState {
      return mutate(pluginId, (draft) => {
        const entry = requireEntry(draft, pluginId);
        let changedGrant = false;
        if (opts?.grantedPermissions !== undefined) {
          const nextGrants = normalizeGrantedPermissions(entry.manifest, opts.grantedPermissions);
          changedGrant = JSON.stringify(nextGrants) !== JSON.stringify(entry.grantedPermissions);
          entry.grantedPermissions = nextGrants;
        } else if (entry.grantedPermissions.length === 0 && entry.revision === 1) {
          const defaults = defaultGrantedPermissions(entry.manifest);
          changedGrant = defaults.length > 0;
          entry.grantedPermissions = defaults;
        }
        entry.enabled = true;
        if (changedGrant) {
          entry.revision += 1;
          entry.confirmations = {};
        }
        return cloneState(entry);
      });
    },
    disable(pluginId: string): StoredPluginState {
      return mutate(pluginId, (draft) => {
        const entry = requireEntry(draft, pluginId);
        entry.enabled = false;
        entry.revision += 1;
        entry.confirmations = {};
        return cloneState(entry);
      });
    },
    grantPermission(pluginId: string, permission: string): StoredPluginState {
      return mutate(pluginId, (draft) => {
        const entry = requireEntry(draft, pluginId);
        const allowed = declaredGrantableKeys(entry.manifest);
        const target = allowed.has(permission)
          ? permission
          : allowed.has(toolGrantKey(permission))
            ? toolGrantKey(permission)
            : undefined;
        if (!target) {
          throw new PluginError("ERR_UNDECLARED", `Permission "${permission}" is not declared by "${pluginId}"`);
        }
        if (!entry.grantedPermissions.includes(target)) {
          entry.grantedPermissions = [...entry.grantedPermissions, target].sort();
        }
        entry.revision += 1;
        entry.confirmations = {};
        return cloneState(entry);
      });
    },
    revokePermission(pluginId: string, permission: string): StoredPluginState {
      return mutate(pluginId, (draft) => {
        const entry = requireEntry(draft, pluginId);
        const before = entry.grantedPermissions;
        let next: string[];
        if (permission === "tools") {
          next = before.filter((item) => !item.startsWith("tool:"));
        } else {
          const toolTarget = toolGrantKey(permission);
          next = before.filter((item) => item !== permission && item !== toolTarget);
        }
        const declaredTool = entry.manifest.tools?.some((tool) => tool.name === permission || toolGrantKey(tool.name) === permission);
        const declaredPerm = MANIFEST_PERMISSION_SET.has(permission) && (entry.manifest.permissions ?? []).includes(permission as PluginPermission);
        if (!declaredTool && !declaredPerm && permission !== "tools" && next.length === before.length) {
          throw new PluginError("ERR_UNDECLARED", `Permission "${permission}" is not declared by "${pluginId}"`);
        }
        entry.grantedPermissions = next;
        entry.revision += 1;
        if (CONFIRMATION_PERMISSIONS.has(permission)) {
          delete entry.confirmations[permission as ConfirmationPermission];
        } else {
          entry.confirmations = {};
        }
        return cloneState(entry);
      });
    },
    setModelRateLimit(pluginId: string, limit: number): StoredPluginState {
      if (!isValidRateLimit(limit)) {
        throw new PluginError("ERR_INVALID_ARGUMENT", `Model rate limit must be an integer between ${MIN_MODEL_RATE_LIMIT} and ${MAX_MODEL_RATE_LIMIT}`);
      }
      return mutate(pluginId, (draft) => {
        const entry = requireEntry(draft, pluginId);
        entry.modelRateLimit = limit;
        return cloneState(entry);
      });
    },
    uninstall(pluginId: string): boolean {
      if (!document.plugins[pluginId]) return false;
      return mutate(pluginId, (draft) => {
        const existed = Boolean(draft.plugins[pluginId]);
        delete draft.plugins[pluginId];
        return existed;
      });
    },
  };
}

export type PluginStateStore = ReturnType<typeof createPluginStateStore>;
