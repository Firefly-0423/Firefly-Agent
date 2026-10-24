import path from "node:path";
import { assertRuntimePathsOwned, canonicalPath, within, type RuntimeProfile } from "./runtime-profile";

export interface StorageContext {
  readonly profile: RuntimeProfile;
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly logsRoot: string;
  readonly sessionRoot: string;
  readonly memory: Readonly<{ dataRoot: string; indexRoot: string; tempRoot: string }>;
  readonly files: Readonly<{ mcp: string; tokenUsage: string; contentManifest: string; historyBudgetStats: string; chatWindowState: string; skillDescriptionsZh: string; mainLog: string }>;
}
/** Logical ownership only: config/data/state retain the existing production layout. */
export function createStorageContext(profile: RuntimeProfile): StorageContext {
  const memoryRoot = path.join(profile.userData, "memory");
  const memory = Object.freeze({ dataRoot: path.join(memoryRoot, "data"), indexRoot: path.join(memoryRoot, "index"), tempRoot: path.join(memoryRoot, "temp") });
  assertRuntimePathsOwned(profile, [profile.appData, profile.userData, profile.sessionData, profile.logs, path.join(profile.userData, "cache"), ...Object.values(memory)]);
  const canonicalMemory = Object.values(memory).map((root) => process.platform === "win32" ? canonicalPath(root).toLowerCase() : canonicalPath(root));
  for (let left = 0; left < canonicalMemory.length; left++) {
    for (let right = left + 1; right < canonicalMemory.length; right++) {
      if (within(canonicalMemory[left], canonicalMemory[right]) || within(canonicalMemory[right], canonicalMemory[left])) {
        throw new Error("FIREFLY_MEMORY_ROOT_ALIAS");
      }
    }
  }
  const ownedFile = (root: string, name: string): string => {
    const file = path.join(root, name);
    assertRuntimePathsOwned(profile, [file]);
    return file;
  };
  return Object.freeze({
    profile,
    configRoot: profile.userData,
    dataRoot: profile.userData,
    stateRoot: profile.userData,
    cacheRoot: path.join(profile.userData, "cache"),
    logsRoot: profile.logs,
    sessionRoot: profile.sessionData,
    memory,
    files: Object.freeze({
      get mcp() { return ownedFile(profile.userData, "mcp-servers.json"); },
      get tokenUsage() { return ownedFile(profile.userData, "token-usage.json"); },
      get contentManifest() { return ownedFile(profile.userData, "content-manifest.json"); },
      get historyBudgetStats() { return ownedFile(profile.userData, "memory-history-budget.json"); },
      get chatWindowState() { return ownedFile(profile.userData, "chat-window-state.json"); },
      get skillDescriptionsZh() { return ownedFile(profile.userData, "skill-descriptions-zh.json"); },
      get mainLog() { return ownedFile(profile.logs, "firefly.log"); },
    }),
  });
}
let installed: StorageContext | undefined;
export function initializeStorageContext(profile: RuntimeProfile): StorageContext {
  if (installed) throw new Error("FIREFLY_STORAGE_ALREADY_INITIALIZED");
  installed = createStorageContext(profile);
  return installed;
}
export function getStorageContext(): StorageContext {
  if (!installed) throw new Error("FIREFLY_STORAGE_NOT_INITIALIZED");
  assertRuntimePathsOwned(installed.profile, [installed.configRoot, installed.cacheRoot, installed.logsRoot, installed.sessionRoot, ...Object.values(installed.memory)]);
  return installed;
}
