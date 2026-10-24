import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "./types";

const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** 每个 key 对应一个 JSON 文件：<rootDir>/<key>.json */
export function createPluginStorage(rootDir: string): PluginStorage {
  mkdirSync(rootDir, { recursive: true });

  const resolveFile = (key: string): string => {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error(`非法存储 key: ${key}`);
    return path.join(rootDir, `${key}.json`);
  };

  return {
    get<T>(key: string): T | undefined {
      const file = resolveFile(key);
      if (!existsSync(file)) return undefined;
      try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      const file = resolveFile(key);
      // 先写临时文件再改名，崩溃时不会留下半截 JSON
      const staging = `${file}.tmp`;
      writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
      renameSync(staging, file);
    },
    rootDir: () => rootDir,
  };
}
