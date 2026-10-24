import path from "node:path";
import { getCachedSessionIdsForCoverage } from "../chats/chats-store";
import { getStorageContext, type StorageContext } from "../storage-context";
import { fireflyDataDirectory } from "../firefly-data-paths";

const MAX_SESSIONS = 10_000;
const BATCH_SIZE = 32;
const DEADLINE_MS = 30_000;
declare const selectionBrand: unique symbol;
/** Only this Main module can mint or consume this one-shot scope. */
export interface CoverageSelection { readonly [selectionBrand]: true }
interface Selection {
  context?: StorageContext;
  root?: string;
  ids?: readonly string[];
  unavailable?: string;
}
const selections = new WeakMap<CoverageSelection, Selection>();

export interface PresenceSession {
  /** Ordered, metadata-only results for this exact batch; no IDs or bodies in replies. */
  probe(ids: readonly string[], signal: AbortSignal): Promise<unknown>;
  /** Completion confirms this exact child exited/closed; reject or throw on failure.
   * A process endpoint must await its child's exit, not merely call kill(). */
  close(): void | Promise<void>;
}
/** Injection boundary only; this dormant capability has no production process caller. */
export interface PresenceEndpoint {
  open(root: string, deadlineMs: number, signal: AbortSignal): Promise<PresenceSession>;
}
export interface PresenceCoverage {
  status: "measured" | "not-measured";
  reason?: string;
  population: number | null;
  present: number | null;
  missing: number | null;
  unknownDenied: number | null;
  exactRatio: number | null;
  lowerRatio: number | null;
  upperRatio: number | null;
  reasons: Readonly<Record<string, number>>;
  evidence: { status: "not-evaluated"; eligible: null; ineligible: null; unknown: number | null; ratio: null };
}
export function selectCachedHistoryCoverage(): CoverageSelection {
  const token = Object.freeze({}) as CoverageSelection;
  let selection: Selection;
  try {
    const context = getStorageContext();
    const cache = getCachedSessionIdsForCoverage();
    if (cache.state !== "ready") selection = { unavailable: cache.state };
    else if (canonical(cache.rootDir) !== canonical(fireflyDataDirectory(context.dataRoot, "chats"))) {
      selection = { unavailable: "profile-mismatch" };
    } else if (cache.ids.length > MAX_SESSIONS) selection = { unavailable: "budget-exhausted" };
    else selection = { context, root: context.dataRoot, ids: Object.freeze([...new Set(cache.ids)]) };
  } catch { selection = { unavailable: "storage-unavailable" }; }
  selections.set(token, selection);
  return token;
}
function canonical(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toUpperCase() : normalized;
}
function validId(value: string): boolean {
  if (!value || value === "." || value === ".." || value.length > 255 || /[. ]$/.test(value) || /[\\/:*?"<>|\x00-\x1f]/.test(value)) return false;
  const stem = value.split(".")[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/.test(stem);
}
function report(n: number | null, p = 0, m = 0, u = 0, reasons: Record<string, number> = {}, reason?: string): PresenceCoverage {
  return {
    status: n === null ? "not-measured" : "measured", ...(reason ? { reason } : {}), population: n,
    present: n === null ? null : p, missing: n === null ? null : m, unknownDenied: n === null ? null : u,
    exactRatio: n && u === 0 ? p / n : null,
    lowerRatio: n ? p / n : null, upperRatio: n ? (p + u) / n : null,
    reasons: Object.freeze({ ...reasons }),
    evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: n, ratio: null },
  };
}
const nativeReasons = new Set([
  "history-invalid-root", "history-invalid-path", "history-invalid-budget", "history-unsupported-filesystem",
  "history-unsafe-attributes", "history-multiple-links", "history-source-changed", "history-native-open-failed", "history-native-io-failed",
]);
type Observation = { status: "present" } | { status: "missing"; component: "transcripts" | "session" | "snapshot" }
  | { status: "unknown-denied"; reason: string };
function observations(value: unknown, length: number): Observation[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const keys = Object.keys(item).sort().join(",");
    if (item.status === "present" && keys === "status") continue;
    if (item.status === "missing" && keys === "component,status" && ["transcripts", "session", "snapshot"].includes(item.component)) continue;
    if (item.status === "unknown-denied" && keys === "reason,status" && nativeReasons.has(item.reason)) continue;
    return null;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 8192 ? value as Observation[] : null;
}
function current(selection: Selection): boolean {
  try { const context = getStorageContext(); return context === selection.context && context.dataRoot === selection.root; }
  catch { return false; }
}
export async function measureHistoryPresence(
  token: CoverageSelection, endpoint: PresenceEndpoint, options: { signal?: AbortSignal } = {},
): Promise<PresenceCoverage> {
  const selection = selections.get(token);
  selections.delete(token);
  if (!selection || selection.unavailable || !selection.ids || !selection.root) return report(null, 0, 0, 0, {}, selection?.unavailable ?? "invalid-selection");
  if (!current(selection) || options.signal?.aborted) return report(null, 0, 0, 0, {}, "cancelled-or-profile-changed");
  const n = selection.ids.length;
  if (n === 0) return report(0);
  const deadlineAt = performance.now() + DEADLINE_MS;
  const expired = (): boolean => performance.now() >= deadlineAt;
  const reasons: Record<string, number> = {};
  const unknown = (reason: string, count: number): void => { if (count) reasons[reason] = (reasons[reason] ?? 0) + count; };
  const aliases = new Map<string, number>();
  for (const id of selection.ids) aliases.set(id.toUpperCase(), (aliases.get(id.toUpperCase()) ?? 0) + 1);
  const ids = selection.ids.filter((id) => validId(id) && aliases.get(id.toUpperCase()) === 1);
  let p = 0, m = 0, u = n - ids.length;
  unknown("invalid-or-aliased-id", u);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, DEADLINE_MS);
  const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("presence-stopped")), { once: true }));
  let session: PresenceSession | undefined;
  const close = async (value: PresenceSession): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => value.close()).then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 1000); }),
      ]);
    } catch { return false; }
    finally { if (timeout) clearTimeout(timeout); }
  };
  try {
    if (ids.length) {
      if (expired()) throw new Error("presence-deadline");
      session = await Promise.race([
        endpoint.open(selection.root, Math.max(1, Math.ceil(deadlineAt - performance.now())), controller.signal).then((value) => {
          if (controller.signal.aborted) void close(value);
          return value;
        }), stopped,
      ]);
      for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
        if (!current(selection) || options.signal?.aborted) return report(null, 0, 0, 0, {}, "cancelled-or-profile-changed");
        if (expired()) throw new Error("presence-deadline");
        const batch = ids.slice(offset, offset + BATCH_SIZE);
        // Bound the actual UTF-8 wire command, including JSON escaping.
        const request = JSON.stringify({ type: "probe", version: 1, sessionIds: batch });
        const reply = Buffer.byteLength(request, "utf8") <= 32768
          ? observations(await Promise.race([session.probe(batch, controller.signal), stopped]), batch.length) : null;
        if (!current(selection) || options.signal?.aborted) return report(null, 0, 0, 0, {}, "cancelled-or-profile-changed");
        if (expired()) throw new Error("presence-deadline");
        if (!reply) { u += batch.length; unknown("invalid-or-over-budget-reply", batch.length); continue; }
        for (const item of reply) {
          if (item.status === "present") p++;
          else if (item.status === "missing") m++;
          else { u++; unknown(item.reason, 1); }
        }
      }
    }
  } catch {
    if (!current(selection) || options.signal?.aborted) return report(null, 0, 0, 0, {}, "cancelled-or-profile-changed");
    const remaining = n - p - m - u;
    u += remaining; unknown(controller.signal.aborted || expired() ? "deadline" : "endpoint-unavailable", remaining);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (session && !(await close(session))) return report(null, 0, 0, 0, {}, "cleanup-failed");
  }
  if (!current(selection) || options.signal?.aborted) return report(null, 0, 0, 0, {}, "cancelled-or-profile-changed");
  if (expired() && !reasons.deadline) return report(n, 0, 0, n, { deadline: n });
  return report(n, p, m, u, reasons);
}
