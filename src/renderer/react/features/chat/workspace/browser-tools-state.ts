import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_BROWSER_TOOL_STATE,
  type BrowserDownloadDto, type BrowserTabToolState, type BrowserToolErrorCode, type BrowserToolRequest, type BrowserToolSettings, type BrowserToolValues,
} from "../../../../../shared/browser-tools";

export interface BrowserToolsState {
  /** The bridge exists and this is a window tab: the menu and its tools are offered. */
  available: boolean;
  tab: BrowserTabToolState;
  downloads: readonly BrowserDownloadDto[];
  settings: BrowserToolSettings | null;
  /** Runs one request. Resolves with the value, or with the error code when Main refused or failed it. */
  run<K extends BrowserToolRequest["tool"]>(request: Extract<BrowserToolRequest, { tool: K }>): Promise<{ ok: true; value: BrowserToolValues[K] } | { ok: false; code: BrowserToolErrorCode }>;
}

/** Tool state of one window tab plus the window-wide downloads and settings. Everything shown comes from Main:
 * replies update the state at once and Main's pushed changes keep every part in step. */
export function useBrowserToolsState(tabId: string | undefined, pageLoaded: boolean): BrowserToolsState {
  const api = typeof window === "undefined" ? undefined : window.manualBrowserWorkspace;
  const bridge = api?.tool && api.onToolsChanged ? api : undefined;
  const available = !!bridge && !!tabId;
  const [tab, setTab] = useState<BrowserTabToolState>(DEFAULT_BROWSER_TOOL_STATE);
  const [downloads, setDownloads] = useState<readonly BrowserDownloadDto[]>([]);
  const [settings, setSettings] = useState<BrowserToolSettings | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = useCallback(async <K extends BrowserToolRequest["tool"]>(request: Extract<BrowserToolRequest, { tool: K }>) => {
    if (!bridge?.tool || !tabId) return { ok: false, code: "unsupported" } as const;
    try {
      const reply = await bridge.tool(request, tabId);
      if (!reply.ok) return { ok: false, code: reply.code } as const;
      const value = reply.value;
      if (alive.current) {
        if (request.tool === "state" || request.tool === "find" || request.tool === "stop-find" || request.tool === "zoom" || request.tool === "device") setTab(value as BrowserTabToolState);
        else if (request.tool === "download") setDownloads((value as BrowserToolValues["download"]).downloads);
        else if (request.tool === "settings") setSettings((value as BrowserToolValues["settings"]).settings);
      }
      return { ok: true, value } as { ok: true; value: BrowserToolValues[K] };
    } catch { return { ok: false, code: "failed" } as const; }
  }, [bridge, tabId]);

  useEffect(() => {
    if (!bridge?.onToolsChanged || !tabId) return;
    const off = bridge.onToolsChanged(change => {
      if (change.kind === "tab") { if (change.tabId === tabId) setTab(change.state); }
      else if (change.kind === "downloads") setDownloads(change.downloads);
      else setSettings(change.settings);
    });
    void run({ tool: "download", op: "list" });
    void run({ tool: "settings" });
    return off;
  }, [bridge, tabId, run]);

  // The page's own state (zoom, device preview) is read once a page exists, and reset when it goes.
  useEffect(() => {
    if (!available) return;
    if (pageLoaded) void run({ tool: "state" }); else setTab(DEFAULT_BROWSER_TOOL_STATE);
  }, [available, pageLoaded, run]);

  return { available, tab, downloads, settings, run };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
