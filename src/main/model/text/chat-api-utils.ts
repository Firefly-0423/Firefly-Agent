import { app } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeChatMessagesWithTime, type ChatContextMessage } from "./chat-time-context";

export function buildChatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  const endpoint = "/chat/completions";
  return root.endsWith(endpoint) ? root : `${root}${endpoint}`;
}

export function normalizeChatMessages(input: unknown): ChatContextMessage[] {
  const normalized = normalizeChatMessagesWithTime(input);
  return normalized;
}

export function getApiLogPath(): string {
  const dataDirectory = app.getPath("userData");
  return path.join(dataDirectory, "chat-api.log");
}

function logSection(name: string): string {
  const border = "-".repeat(40);
  return `${border} ${name} ${border}`;
}

export function appendApiLog(
  operation: string,
  requestMessages: Array<{ role: string; content: string }>,
  rawText: string,
  cleanedResponse: string,
): void {
  try {
    const instant = new Date().toISOString();
    const separator = "=".repeat(80);
    const record: string[] = [separator, `[${instant}] ${operation}`, logSection("REQUEST")];
    record.push(JSON.stringify(requestMessages, null, 2));
    record.push(logSection("RAW RESPONSE"), rawText);
    record.push(logSection("CLEANED"), cleanedResponse || "(empty)", separator, "");
    fs.appendFileSync(getApiLogPath(), record.join(os.EOL), "utf8");
  } catch {
    // Logging is best effort; it must not reject a completed model response.
  }
}
