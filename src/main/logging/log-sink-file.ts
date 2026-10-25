import { type LogEntry, addLogSink } from "../../shared/logger";
import path from "node:path";
import fs from "node:fs";

const fileLimit = 5 * 1024 * 1024;
const generations = 3;

export function formatTs(ts: number): string {
  const instant = new Date(ts);
  const digits = (value: number, count = 2): string => String(value).padStart(count, "0");
  const calendar = `${digits(instant.getFullYear(), 4)}-${digits(instant.getMonth() + 1)}-${digits(instant.getDate())}`;
  const wallClock = `${digits(instant.getHours())}:${digits(instant.getMinutes())}:${digits(instant.getSeconds())}`;
  return `${calendar} ${wallClock}.${digits(instant.getMilliseconds(), 3)}`;
}

function shiftLog(source: string, destination: string): void {
  try { fs.renameSync(source, destination); } catch { /* 下次写入时再试。 */ }
}

export function rotateIfNeeded(logPath: string, maxBytes = fileLimit): void {
  try {
    const length = fs.statSync(logPath).size;
    if (length < maxBytes) return;
  } catch { return; }
  let generation = generations - 2;
  while (generation >= 1) {
    shiftLog(`${logPath}.${generation}`, `${logPath}.${generation + 1}`);
    generation -= 1;
  }
  shiftLog(logPath, `${logPath}.1`);
}

export function createFileLogSink(
  logPath: string,
  maxBytes = fileLimit,
): (entry: LogEntry) => void {
  return (entry: LogEntry): void => {
    const formatted = `${formatTs(entry.ts)} ${entry.line}\n`;
    try {
      rotateIfNeeded(logPath, maxBytes);
      fs.appendFileSync(logPath, formatted, "utf8");
    } catch { /* 写日志失败不影响业务。 */ }
  };
}

export function installFileLogSink(
  userDataDir: string,
  maxBytes = fileLimit,
): () => void {
  const directory = path.join(userDataDir, "logs");
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, "firefly.log");
  return addLogSink(createFileLogSink(destination, maxBytes));
}
