/**
 * 主进程的日志门面，建立在 src/shared/logger.ts 之上。
 *
 * 本模块额外负责：
 *   - 模块加载时通过 setLogLevel() 设定默认级别（开发与发布统一为 warn）；
 *   - 把日志文件挂载为主日志 sink；
 *   - 转出 LogTag 等共享符号，调用方可以直接从本文件引入。
 */
import { setLogLevel, type LogLevel } from "../shared/logger";
import { logger } from "../shared/logger";
import { createFileLogSink } from "./log-sink-file";
import fs from "node:fs";
import { addLogSink } from "../shared/logger";
import { getStorageContext } from "./storage-context";
import { fireflyEnvironment } from "../shared/firefly-environment";

function resolveDefaultLevel(): LogLevel {
  // 环境变量优先，大小写不敏感
  const requested = fireflyEnvironment(process.env, "FIREFLY_LOG_LEVEL")?.toLowerCase();
  if (requested === "debug" || requested === "info" || requested === "warn" || requested === "error") return requested;
  // Both dev and release: warn by default. Startup prints the banner plus
  // whatever warn/error fires during init; set FIREFLY_LOG_LEVEL=info to see
  // the full startup trace.
  return "warn";
}

setLogLevel(resolveDefaultLevel());

export function initializeMainFileLogging(): () => void {
  const storage = getStorageContext();
  try {
    fs.mkdirSync(storage.logsRoot, { recursive: true });
    return addLogSink(createFileLogSink(storage.files.mainLog));
  } catch {
    // userData 不可用时静默跳过，日志落盘只是增强项
    return () => {};
  }
}

export { logger, setLogLevel, LogTag } from "../shared/logger";
export type { LogLevel } from "../shared/logger";
