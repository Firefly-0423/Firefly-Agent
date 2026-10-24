import { fireflyEnvironment } from "../shared/firefly-environment";

export function debugLogsEnabled(): boolean {
  const flag = fireflyEnvironment(process.env, "FIREFLY_DEBUG_LOGS");
  return flag === "1";
}

export function debugLog(...args: unknown[]): void {
  if (!debugLogsEnabled()) return;
  console.log(...args);
}

export function debugWarn(...args: unknown[]): void {
  if (!debugLogsEnabled()) return;
  console.warn(...args);
}

export function flowLog(message: string): void {
  console.log("[AgentFlow] " + message);
}

export function summarizeArgumentKeys(args: Record<string, unknown>): string {
  const names = Object.keys(args).sort();
  if (names.length === 0) return "无参数";
  return names.join(", ");
}

export function summarizeObjective(value: string, maxLength = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return flat.slice(0, maxLength - 1) + "…";
}
