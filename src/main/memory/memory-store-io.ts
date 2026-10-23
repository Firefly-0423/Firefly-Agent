import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { MemoryStore } from "./memory-types"
import { AtomicJsonStore } from "../atomic-json-store"
import { isCurrentMemoryStore } from "./memory-store-defaults"

const MEMORY_FILE_NAME = "memory.json"

// 非 Electron 主进程（例如单测）取不到 userData，返回 null 表示不持久化
export function resolveMemoryPath(): string | null {
  try {
    return path.join(app.getPath("userData"), MEMORY_FILE_NAME)
  } catch {
    return null
  }
}

export const memoryFileExists = (filePath: string): boolean => fs.existsSync(filePath)

export const readMemoryFile = (filePath: string): Partial<MemoryStore> =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryStore>

export function writeMemoryFile(filePath: string, store: MemoryStore): void {
  // 沿用 PMRS 的 schema 校验与读失败保护：上一份有效内容保存在 memory.json.bak，
  // 恢复必须显式进行，加载时不会用默认值或备份覆盖已损坏的源文件。
  const target = new AtomicJsonStore<MemoryStore>(filePath, isCurrentMemoryStore)
  target.write(store)
}
