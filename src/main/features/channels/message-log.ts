import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export type LogEntry = {
  hasAttachments?: boolean;
  text: string;
  chatId: string;
  senderName?: string;
  senderId: string;
  channel: string;
  dir: "incoming" | "outgoing" | "error";
  at: string;
};
const recent: LogEntry[] = [];
const location = () => path.join(app.getPath("userData"), "channels", "log.jsonl");

function readRecords(): LogEntry[] {
  const rows = fs.readFileSync(location(), "utf8").split("\n").filter((row) => row.length > 0);
  const records: LogEntry[] = [];
  for (const row of rows) {
    try { records.push(JSON.parse(row) as LogEntry); }
    catch { /* 其余有效行仍可供查看。 */ }
  }
  return records;
}

export function appendLog(entry: Omit<LogEntry, "at">): void {
  const record: LogEntry = { at: new Date().toISOString(), ...entry };
  recent.push(record);
  if (recent.length > 200) recent.splice(0, recent.length - 200);
  try {
    const directory = path.dirname(location());
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(location(), JSON.stringify(record) + "\n", "utf8");
    const rows = fs.readFileSync(location(), "utf8").split("\n");
    if (rows.length > 1000) fs.writeFileSync(location(), rows.slice(rows.length - 1000).join("\n") + "\n", "utf8");
  } catch (failure) {
    console.warn("[ChannelLog]", "写日志失败:", failure instanceof Error ? failure.message : failure);
  }
}

export function getRecentLog(limit = 100): LogEntry[] {
  const count = Math.max(1, Math.min(200, limit));
  if (recent.length > 0) return [...recent].slice(-count).reverse();
  try { return readRecords().slice(-count).reverse(); }
  catch { return []; }
}

export function clearLog(): void {
  recent.length = 0;
  try { fs.unlinkSync(location()); }
  catch { /* 文件缺失时也已经完成清理。 */ }
}

export function reloadLogFromDisk(): void {
  try { recent.push(...readRecords().slice(-200)); }
  catch (failure) {
    if (failure instanceof Error && "code" in failure && (failure as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[ChannelLog]", "从磁盘 reload 失败:", failure.message);
    }
  }
}
