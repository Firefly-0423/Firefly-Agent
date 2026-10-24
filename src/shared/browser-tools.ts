/** Window-browser tools: the "more" menu, find, zoom, device preview, print, screenshot, history, cookies,
 * browsing-data clearing and downloads. Presentation contract only: Main owns every authority decision and
 * answers only for an ordinary-browsing (`web`) workspace tab it owns. */

export const BROWSER_ZOOM_STEPS: readonly number[] = Object.freeze([25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]);
export const BROWSER_FIND_MAX_LENGTH = 200;
export const BROWSER_DOMAIN_MAX_LENGTH = 253;
export const BROWSER_DOWNLOAD_LIST_LIMIT = 50;
export const BROWSER_COOKIE_DOMAIN_LIMIT = 200;
export const BROWSER_HISTORY_LIMIT = 100;
export const BROWSER_SNAPSHOT_MAX_CHARS = 1_500_000;

export type BrowserZoomOp = "in" | "out" | "reset";
export type BrowserDevicePreset = "off" | "phone" | "tablet";
export type BrowserClearKind = "cookies" | "cache" | "storage";
export type BrowserDownloadOp = "list" | "open" | "reveal" | "cancel" | "remove" | "clear";
export type BrowserDownloadState = "progressing" | "completed" | "failed" | "cancelled";

export interface BrowserToolSettings {
  /** True: the system "save as" dialog is shown for every download. False: saved straight into the folder. */
  askWhereToSave: boolean;
  /** Display name of the save folder (the folder's own name, never a full path); null means the system Downloads folder. */
  downloadFolderName: string | null;
}
export interface BrowserTabToolState {
  zoomPercent: number;
  device: BrowserDevicePreset;
  find: { query: string; active: number; matches: number } | null;
}
export interface BrowserDownloadDto {
  id: string;
  fileName: string;
  /** Host the file came from; the full URL is never sent to the renderer. */
  host: string;
  state: BrowserDownloadState;
  receivedBytes: number;
  /** 0 when the server did not announce a size. */
  totalBytes: number;
  /** False for file types that can run code: they can be shown in their folder but not opened from here. */
  openable: boolean;
  startedAt: number;
}
export interface BrowserCookieDomainDto { domain: string; count: number }
export interface BrowserHistoryEntryDto { index: number; url: string; title: string; current: boolean }

export type BrowserToolRequest =
  | { tool: "state" }
  | { tool: "find"; text: string; forward: boolean; next: boolean }
  | { tool: "stop-find" }
  | { tool: "zoom"; op: BrowserZoomOp }
  | { tool: "device"; preset: BrowserDevicePreset }
  | { tool: "print" }
  | { tool: "screenshot" }
  | { tool: "snapshot" }
  | { tool: "history" }
  | { tool: "cookies" }
  | { tool: "clear-data"; kinds: readonly BrowserClearKind[]; domain?: string }
  | { tool: "download"; op: BrowserDownloadOp; id?: string }
  | { tool: "settings"; patch?: { askWhereToSave?: boolean }; chooseFolder?: boolean; resetFolder?: boolean };

export interface BrowserToolValues {
  state: BrowserTabToolState;
  find: BrowserTabToolState;
  "stop-find": BrowserTabToolState;
  zoom: BrowserTabToolState;
  device: BrowserTabToolState;
  print: { started: true };
  screenshot: { saved: boolean };
  /** A small JPEG of the visible page as a data URL, or null. Used as a stand-in while a menu covers the native page. */
  snapshot: { image: string | null };
  history: { entries: readonly BrowserHistoryEntryDto[] };
  cookies: { domains: readonly BrowserCookieDomainDto[] };
  "clear-data": { cleared: true };
  download: { downloads: readonly BrowserDownloadDto[] };
  settings: { settings: BrowserToolSettings };
}
export type BrowserToolErrorCode = "permission_denied" | "owner_mismatch" | "closed" | "unsupported" | "cancelled" | "failed";
export type BrowserToolReply<T> = { ok: true; value: T } | { ok: false; code: BrowserToolErrorCode };

/** Pushed by Main. Tab events carry the workspace tab id; the rest are window-wide. */
export type BrowserToolsChange =
  | { kind: "tab"; tabId: string; state: BrowserTabToolState }
  | { kind: "downloads"; downloads: readonly BrowserDownloadDto[] }
  | { kind: "settings"; settings: BrowserToolSettings };

export interface BrowserToolsApi {
  tool<K extends BrowserToolRequest["tool"]>(request: Extract<BrowserToolRequest, { tool: K }>, tabId?: string): Promise<BrowserToolReply<BrowserToolValues[K]>>;
  onToolsChanged(listener: (change: BrowserToolsChange) => void): () => void;
}

export const DEFAULT_BROWSER_TOOL_STATE: BrowserTabToolState = Object.freeze({ zoomPercent: 100, device: "off", find: null });
export const DEFAULT_BROWSER_TOOL_SETTINGS: BrowserToolSettings = Object.freeze({ askWhereToSave: false, downloadFolderName: null });

const CLEAR_KINDS: readonly string[] = ["cookies", "cache", "storage"];
const DOWNLOAD_OPS: readonly string[] = ["list", "open", "reveal", "cancel", "remove", "clear"];
const DEVICE_PRESETS: readonly string[] = ["off", "phone", "tablet"];
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

/** A cookie domain as the renderer may name it: a plain host name, never a URL, path or pattern. */
export function normalizeBrowserCookieDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const host = input.startsWith(".") ? input.slice(1) : input;
  if (!host || host.length > BROWSER_DOMAIN_MAX_LENGTH || !HOST_PATTERN.test(host)) return null;
  return host.toLowerCase();
}

/** Strict parse of an untrusted renderer payload. Unknown keys, wrong types and oversize values are refused. */
export function parseBrowserToolRequest(value: unknown): BrowserToolRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.tool) {
    case "state": case "stop-find": case "print": case "screenshot": case "snapshot": case "history": case "cookies":
      return onlyKeys(v, ["tool"]) ? { tool: v.tool } : null;
    case "find": {
      if (!onlyKeys(v, ["tool", "text", "forward", "next"]) || typeof v.text !== "string") return null;
      const text = v.text.trim();
      if (!text || text.length > BROWSER_FIND_MAX_LENGTH || typeof v.forward !== "boolean" || typeof v.next !== "boolean") return null;
      return { tool: "find", text, forward: v.forward, next: v.next };
    }
    case "zoom":
      return onlyKeys(v, ["tool", "op"]) && (v.op === "in" || v.op === "out" || v.op === "reset") ? { tool: "zoom", op: v.op } : null;
    case "device":
      return onlyKeys(v, ["tool", "preset"]) && typeof v.preset === "string" && DEVICE_PRESETS.includes(v.preset)
        ? { tool: "device", preset: v.preset as BrowserDevicePreset } : null;
    case "clear-data": {
      if (!onlyKeys(v, ["tool", "kinds", "domain"]) || !Array.isArray(v.kinds) || v.kinds.length === 0 || v.kinds.length > CLEAR_KINDS.length
        || !v.kinds.every(kind => typeof kind === "string" && CLEAR_KINDS.includes(kind))) return null;
      const kinds = [...new Set(v.kinds as BrowserClearKind[])];
      if (v.domain === undefined) return { tool: "clear-data", kinds };
      const domain = normalizeBrowserCookieDomain(v.domain);
      // A single site can only be cleared for its cookies; cache and site storage are cleared for the whole tab.
      return domain && kinds.length === 1 && kinds[0] === "cookies" ? { tool: "clear-data", kinds, domain } : null;
    }
    case "download": {
      if (!onlyKeys(v, ["tool", "op", "id"]) || typeof v.op !== "string" || !DOWNLOAD_OPS.includes(v.op)) return null;
      const needsId = v.op === "open" || v.op === "reveal" || v.op === "cancel" || v.op === "remove";
      if (needsId !== (v.id !== undefined)) return null;
      if (v.id !== undefined && (typeof v.id !== "string" || !v.id || v.id.length > 64)) return null;
      return { tool: "download", op: v.op as BrowserDownloadOp, ...(v.id === undefined ? {} : { id: v.id as string }) };
    }
    case "settings": {
      if (!onlyKeys(v, ["tool", "patch", "chooseFolder", "resetFolder"])) return null;
      if (v.chooseFolder !== undefined && v.chooseFolder !== true) return null;
      if (v.resetFolder !== undefined && v.resetFolder !== true) return null;
      if (v.chooseFolder === true && v.resetFolder === true) return null;
      let patch: { askWhereToSave?: boolean } | undefined;
      if (v.patch !== undefined) {
        if (!v.patch || typeof v.patch !== "object" || Array.isArray(v.patch) || !onlyKeys(v.patch as Record<string, unknown>, ["askWhereToSave"])) return null;
        const ask = (v.patch as Record<string, unknown>).askWhereToSave;
        if (ask !== undefined && typeof ask !== "boolean") return null;
        patch = ask === undefined ? {} : { askWhereToSave: ask };
      }
      return { tool: "settings", ...(patch ? { patch } : {}), ...(v.chooseFolder === true ? { chooseFolder: true } : {}), ...(v.resetFolder === true ? { resetFolder: true } : {}) };
    }
    default: return null;
  }
}

/** The next preset zoom stop in the given direction (percentages). */
export function nextBrowserZoomPercent(current: number, op: BrowserZoomOp): number {
  if (op === "reset") return 100;
  const steps = BROWSER_ZOOM_STEPS;
  if (op === "in") return steps.find(step => step > current + 0.5) ?? steps[steps.length - 1];
  for (let index = steps.length - 1; index >= 0; index--) if (steps[index] < current - 0.5) return steps[index];
  return steps[0];
}
