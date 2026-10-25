import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fireflyEnvironment } from "../../../shared/firefly-environment";
import { ephemeralConversations } from "../../chats/ephemeral-conversations";

const traceRoot = path.join(os.homedir(), ".firefly", "prompt-dumps");
let flag: boolean | null = null;
let serial = 0;
export type DumpRequestMeta = {
  body: Record<string, unknown>;
  endpoint: string;
  transport: "openai" | "anthropic" | "responses";
};
export type DumpResponseMeta = {
  error?: string;
  raw: unknown;
  usage?: unknown;
  toolCalls?: unknown[];
  thinking?: string;
  text?: string;
  ok: boolean;
  transport: "openai" | "anthropic" | "responses";
};

function tracing(): boolean {
  if (ephemeralConversations.any()) return false;
  if (flag !== null) return flag;
  try { flag = fireflyEnvironment(process.env, "FIREFLY_PROMPT_DUMP") === "1"; }
  catch { flag = false; }
  return flag;
}
const digits = (value: number, width = 2): string => String(value).padStart(width, "0");
function timePart(): string {
  const instant = new Date();
  const millis = digits(instant.getMilliseconds(), 3);
  return digits(instant.getHours()) + digits(instant.getMinutes()) + digits(instant.getSeconds()) + "-" + millis;
}
function nextPart(): string {
  serial++;
  return serial.toString(36).padStart(3, "0");
}
function dateDirectory(): string {
  const instant = new Date();
  return path.join(traceRoot, `${instant.getFullYear()}${digits(instant.getMonth() + 1)}${digits(instant.getDate())}`);
}
function ensureDirectory(directory: string): boolean {
  try { fs.mkdirSync(directory, { recursive: true }); return true; }
  catch { return false; }
}
function queueDump(directory: string, filename: string, data: unknown): void {
  const destination = path.join(directory, filename);
  try {
    fs.writeFile(destination, JSON.stringify(data, null, 2), (failure) => {
      if (failure) console.warn(`[prompt-dump] write failed: ${destination}`, failure.message);
    });
  } catch (failure) {
    console.warn(`[prompt-dump] queue failed: ${destination}`, (failure as Error).message);
  }
}
export function dumpRequest(meta: DumpRequestMeta, persistDiagnostics = true): string | null {
  if (!persistDiagnostics) return null;
  const identity = `${timePart()}_${meta.transport}_${nextPart()}`;
  if (!tracing()) return identity;
  const directory = dateDirectory();
  if (ensureDirectory(directory)) {
    queueDump(directory, `${identity}_req.json`, {
      traceId: identity, ts: new Date().toISOString(), phase: "request",
      transport: meta.transport, endpoint: meta.endpoint, body: meta.body,
    });
  }
  return identity;
}
export function dumpResponse(traceId: string | null, meta: DumpResponseMeta): void {
  if (traceId === null || !tracing()) return;
  const directory = dateDirectory();
  if (!ensureDirectory(directory)) return;
  queueDump(directory, `${traceId}_res.json`, {
    traceId, ts: new Date().toISOString(), phase: "response", transport: meta.transport,
    ok: meta.ok, text: meta.text, thinking: meta.thinking, toolCalls: meta.toolCalls,
    usage: meta.usage, raw: meta.raw, error: meta.error,
  });
}
