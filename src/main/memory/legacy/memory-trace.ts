import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

export interface MemoryTraceEvent {
  op: string
  status: "ok" | "error" | "skip"
  ts?: number
  layer?: "L0" | "L1" | "L2" | "store" | "reflection" | "migration"
  ragId?: string
  l2Id?: string
  details?: Record<string, unknown>
  error?: string | null
}

const TRACE_FILE_NAME = "memory-trace.log"

// 单测等没有 Electron app 的环境取不到 userData，此时不落盘
function locateTraceFile(): string | null {
  try {
    return path.join(app.getPath("userData"), TRACE_FILE_NAME)
  } catch {
    return null
  }
}

export function appendMemoryTrace(event: MemoryTraceEvent): void {
  try {
    const target = locateTraceFile()
    if (target === null) return
    const folder = path.dirname(target)
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })
    const record = { ts: event.ts ?? Date.now(), ...event, error: event.error ?? null }
    fs.appendFileSync(target, JSON.stringify(record) + "\n", "utf8")
  } catch (err) {
    console.warn("[PMRS/Trace] 写入失败:", err)
  }
}
