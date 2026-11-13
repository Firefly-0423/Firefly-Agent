import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export type HistoryEntry = { at: string; content: string; role: "user" | "assistant" };
const historyDirectory = () => path.join(app.getPath("userData"), "channels", "history");
const historyFile = (identifier: string) => path.join(historyDirectory(), `${identifier.replace(/[:/\\<>:"|?*]/g, "_")}.jsonl`);
const warning = (operation: string, identifier: string, failure: unknown) => {
  console.warn("[ChannelHistory]", operation, identifier, failure instanceof Error ? failure.message : failure);
};

export function appendHistory(sessionId: string, role: "user" | "assistant", content: string): void {
  if (!sessionId || !content) return;
  const record: HistoryEntry = { role, content, at: new Date().toISOString() };
  const destination = historyFile(sessionId);
  try {
    fs.mkdirSync(historyDirectory(), { recursive: true });
    fs.appendFileSync(destination, JSON.stringify(record) + "\n", "utf8");
    const persisted = fs.readFileSync(destination, "utf8").split("\n");
    if (persisted.length > 200 + 1) {
      const tail = persisted.slice(persisted.length - 200).join("\n");
      fs.writeFileSync(destination, tail.endsWith("\n") ? tail : tail + "\n", "utf8");
    }
  } catch (failure) { warning("appendHistory 失败:", sessionId, failure); }
}

export function loadRecentHistory(sessionId: string, limit: number): HistoryEntry[] {
  if (!sessionId || limit <= 0) return [];
  const source = historyFile(sessionId);
  if (!fs.existsSync(source)) return [];
  try {
    const rows = fs.readFileSync(source, "utf8").split("\n").filter((row) => row.length > 0);
    const accepted: HistoryEntry[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row) as HistoryEntry;
        if (record && (record.role === "user" || record.role === "assistant") && typeof record.content === "string") accepted.push(record);
      } catch { /* 损坏行不参与历史窗口。 */ }
    }
    return accepted.slice(-limit);
  } catch (failure) {
    warning("loadRecentHistory 失败:", sessionId, failure);
    return [];
  }
}

export function migrateHistory(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  const source = historyFile(fromSessionId);
  const destination = historyFile(toSessionId);
  try {
    if (!fs.existsSync(source) || fs.existsSync(destination)) return;
    fs.mkdirSync(historyDirectory(), { recursive: true });
    fs.copyFileSync(source, destination);
  } catch (failure) {
    console.warn("[ChannelHistory]", "migrateHistory 失败:", fromSessionId, "->", toSessionId, failure instanceof Error ? failure.message : failure);
  }
}

export function reloadAllHistory(): Map<string, HistoryEntry[]> {
  const histories = new Map<string, HistoryEntry[]>();
  try {
    fs.mkdirSync(historyDirectory(), { recursive: true });
    for (const filename of fs.readdirSync(historyDirectory())) {
      if (!filename.endsWith(".jsonl")) continue;
      const identifier = filename.replace(/\.jsonl$/, "").replace(/_/g, ":");
      histories.set(identifier, loadRecentHistory(identifier, 200));
    }
  } catch { /* 调试预读失败不阻止启动。 */ }
  return histories;
}
