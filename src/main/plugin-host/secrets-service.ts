import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { PluginSecretsService } from "../../plugins/api";
import { pluginHostError } from "./errors";

/** key 规则与普通插件存储保持一致，在计算文件名之前先校验。 */
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Electron safeStorage 的最小接口：宿主注入真实现，测试注入假件。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface PluginSecretsServiceOptions {
  pluginId: string;
  /** 密钥目录，约定为 plugin-data/<pluginId>/secrets/。 */
  secretsRoot: string;
  storage: SafeStorageLike;
  /** 插件停止信号；触发后每次调用都以 E_PLUGIN_STOPPING 失败。 */
  signal?: AbortSignal;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 插件密钥服务：值经 safeStorage 加密后落盘，文件名是 key 的 SHA-256。
 * 由于文件名不含 key 原文，大小写不同的 key 彼此独立，
 * 也不会撞上 Windows 保留设备名。
 */
export function createPluginSecretsService(options: PluginSecretsServiceOptions): PluginSecretsService {
  const { pluginId, secretsRoot, storage, signal } = options;
  const logPrefix = `plugin:${pluginId}:secrets`;

  function ensureRunning(): void {
    if (signal?.aborted) {
      throw pluginHostError("E_PLUGIN_STOPPING", `插件 ${pluginId} 已停止，密钥服务不可用`);
    }
  }

  function ensureValidKey(key: string): void {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw pluginHostError("E_INVALID_ARGUMENT", `非法密钥 key: ${String(key)}`);
    }
  }

  function locate(key: string): string {
    const digest = createHash("sha256").update(key, "utf8").digest("hex");
    return path.join(secretsRoot, `${digest}.enc`);
  }

  return {
    async get(key) {
      ensureRunning();
      ensureValidKey(key);
      if (!storage.isEncryptionAvailable()) {
        throw pluginHostError("E_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法读取插件密钥");
      }
      let blob: Buffer;
      try {
        blob = await fs.readFile(locate(key));
      } catch (failure) {
        if (isMissingFile(failure)) return undefined;
        throw pluginHostError("E_INTERNAL", "读取密钥文件失败", { cause: failure, logPrefix });
      }
      try {
        return storage.decryptString(blob);
      } catch (failure) {
        throw pluginHostError("E_INTERNAL", "解密密钥失败", { cause: failure, logPrefix });
      }
    },

    async set(key, value) {
      ensureRunning();
      ensureValidKey(key);
      if (typeof value !== "string") {
        throw pluginHostError("E_INVALID_ARGUMENT", "密钥值必须是字符串");
      }
      // 安全存储不可用时直接拒绝，不写入任何弱保护的文件。
      if (!storage.isEncryptionAvailable()) {
        throw pluginHostError("E_STORAGE_UNAVAILABLE", "系统安全存储不可用，无法保存插件密钥");
      }
      const finalPath = locate(key);
      const stagingPath = `${finalPath}.tmp`;
      try {
        await fs.mkdir(secretsRoot, { recursive: true });
        // 先写临时文件再改名，进程中断时不会留下半截密钥。
        await fs.writeFile(stagingPath, storage.encryptString(value));
        await fs.rename(stagingPath, finalPath);
      } catch (failure) {
        throw pluginHostError("E_INTERNAL", "写入密钥文件失败", { cause: failure, logPrefix });
      }
    },

    async delete(key) {
      ensureRunning();
      ensureValidKey(key);
      try {
        await fs.unlink(locate(key));
        return true;
      } catch (failure) {
        // 删除是幂等的：文件本就不存在时返回 false 而非报错。
        if (isMissingFile(failure)) return false;
        throw pluginHostError("E_INTERNAL", "删除密钥文件失败", { cause: failure, logPrefix });
      }
    },
  };
}
