// Obsidian vault 绑定信息的持久化（userData/obsidian-vault-config.json）

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { logger, LogTag } from "../logger";

export type ObsidianVaultConfig = {
  /** 最近一次同步的毫秒时间戳，仅供界面展示 */
  lastSyncAt: number;
  /** 为 true 时记忆写入后自动增量同步 */
  autoSync: boolean;
  /** vault 目录，空串即未绑定 */
  vaultPath: string;
};

// 缺省值的键顺序即首次落盘时的键顺序，不要调整
const DEFAULT_CONFIG: ObsidianVaultConfig = { vaultPath: "", autoSync: false, lastSyncAt: 0 };

const configFilePath = (): string => path.join(app.getPath("userData"), "obsidian-vault-config.json");

export function loadObsidianVaultConfig(): ObsidianVaultConfig {
  try {
    const file = configFilePath();
    if (!fs.existsSync(file)) {
      return { ...DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ObsidianVaultConfig>;
    const { vaultPath, autoSync, lastSyncAt } = parsed;
    return {
      vaultPath: typeof vaultPath === "string" ? vaultPath : "",
      autoSync: typeof autoSync === "boolean" ? autoSync : false,
      lastSyncAt: typeof lastSyncAt === "number" ? lastSyncAt : 0,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(LogTag.Firefly, `[obsidian-config] load failed: ${reason}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveObsidianVaultConfig(patch: Partial<ObsidianVaultConfig>): ObsidianVaultConfig {
  const next = { ...loadObsidianVaultConfig(), ...patch };
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function isVaultBound(): boolean {
  return loadObsidianVaultConfig().vaultPath.length > 0;
}

export function unbindVault(): ObsidianVaultConfig {
  return saveObsidianVaultConfig({ vaultPath: "", autoSync: false, lastSyncAt: 0 });
}
