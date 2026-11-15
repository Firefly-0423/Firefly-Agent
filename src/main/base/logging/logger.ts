/**
 * 主进程的日志门面，建立在 src/shared/logger.ts 之上。
 *
 * 本模块额外负责：
 *   - 模块加载时通过 setLogLevel() 设定默认级别（开发版 info，安装版 warn，环境变量优先）；
 *   - 把日志文件挂载为主日志 sink；
 *   - 转出 LogTag 等共享符号，调用方可以直接从本文件引入。
 */
import { setLogLevel, type LogLevel } from "../../../shared/logger";
import { logger } from "../../../shared/logger";
import { createFileLogSink } from "./log-sink-file";
import fs from "node:fs";
import { addLogSink } from "../../../shared/logger";
import { getStorageContext } from "../storage/storage-context";
import { fireflyEnvironment } from "../../../shared/firefly-environment";

/**
 * 默认日志级别：环境变量 FIREFLY_LOG_LEVEL 优先（大小写不敏感）；否则开发版用 info，安装版用 warn。
 * 拿不到 Electron 的 app（例如单元测试）时按安装版处理。负责人 2026-11-15 决定。
 */
export function resolveDefaultLogLevel(env: NodeJS.ProcessEnv, isPackaged: boolean | undefined): LogLevel {
  const requested = fireflyEnvironment(env, "FIREFLY_LOG_LEVEL")?.toLowerCase();
  if (requested === "debug" || requested === "info" || requested === "warn" || requested === "error") return requested;
  return isPackaged === false ? "info" : "warn";
}

function electronIsPackaged(): boolean | undefined {
  try {
    const electron = require("electron") as { app?: { isPackaged?: boolean } } | string;
    return typeof electron === "object" && typeof electron.app?.isPackaged === "boolean" ? electron.app.isPackaged : undefined;
  } catch {
    return undefined;
  }
}

setLogLevel(resolveDefaultLogLevel(process.env, electronIsPackaged()));

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

export { logger, setLogLevel, LogTag } from "../../../shared/logger";
export type { LogLevel } from "../../../shared/logger";
