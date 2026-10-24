/**
 * 不依赖 Electron 的分级日志器，主进程与纯模块（如 skill-scanner）共用。
 *
 * 行格式：LEVEL Tag(16 列) message
 * 级别：debug < info < warn < error
 * stdout 是 TTY 且未设置 NO_COLOR 时着色；可用 FIREFLY_LOG_LEVEL 覆盖默认级别。
 *
 * 这里是日志格式的唯一出处；src/main/logger.ts 在其上按 app.isPackaged
 * 设置默认级别，只调用一次 setLogLevel()。
 */
import process from "node:process";
import { fireflyEnvironment } from "./firefly-environment";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const ESC = "\x1b[";
const COLOR_RESET = `${ESC}0m`;
const COLOR_OF: Record<LogLevel, string> = {
  debug: `${ESC}90m`,
  info: `${ESC}37m`,
  warn: `${ESC}33m`,
  error: `${ESC}31m`,
};

function levelFromEnv(): LogLevel | null {
  const raw = fireflyEnvironment(process.env, "FIREFLY_LOG_LEVEL")?.toLowerCase();
  return LEVELS.find((lv) => lv === raw) ?? null;
}

let activeLevel: LogLevel = levelFromEnv() ?? "info";

/**
 * 额外的日志出口（sink）。默认只写 stdout/stderr，而打包版 Electron 的
 * stdout 在用户机器上往往看不到，所以主进程可以注册落盘等出口。
 * sink 抛出的异常一律吞掉，不影响主流程。
 */
export interface LogEntry {
  /** 事件时间（epoch ms），格式化交给落盘方 */
  ts: number;
  level: LogLevel;
  tag: string;
  /** 已拼接好的消息：多参数合并，非字符串转 JSON */
  message: string;
  /** 与 stdout 相同的纯文本行（无 ANSI），可直接落盘或转发 */
  line: string;
}

export type LogSink = (entry: LogEntry) => void;

const sinks = new Set<LogSink>();

/** 注册接收器，返回用于注销的函数 */
export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function removeLogSink(sink: LogSink): void {
  sinks.delete(sink);
}

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

const colorEnabled = (): boolean => (process.env.NO_COLOR ? false : Boolean(process.stdout.isTTY));

const TAG_WIDTH = 16;

function fitTag(tag: string): string {
  return tag.length >= TAG_WIDTH ? tag.slice(0, TAG_WIDTH) : tag + " ".repeat(TAG_WIDTH - tag.length);
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, tag: string, args: unknown[]): void {
  if (SEVERITY[level] < SEVERITY[activeLevel]) return;

  const message = args.map(render).join(" ");
  const levelCol = level.toUpperCase().padEnd(5);
  const tagCol = fitTag(tag);
  const rest = `${tagCol} ${message}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

  const head = colorEnabled() ? `${COLOR_OF[level]}${levelCol}${COLOR_RESET}` : levelCol;
  stream.write(`${head} ${rest}\n`);

  // 写完标准流之后再通知 sink，保持原有输出行为
  if (sinks.size === 0) return;
  const entry: LogEntry = { ts: Date.now(), level, tag, message, line: `${levelCol} ${rest}` };
  sinks.forEach((sink) => {
    try {
      sink(entry);
    } catch {
      // sink 故障不能拖垮业务日志
    }
  });
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => write("debug", tag, args),
  info: (tag: string, ...args: unknown[]) => write("info", tag, args),
  warn: (tag: string, ...args: unknown[]) => write("warn", tag, args),
  error: (tag: string, ...args: unknown[]) => write("error", tag, args),
};

export { LogTag, type LogTagKey } from "./logger-tags";
