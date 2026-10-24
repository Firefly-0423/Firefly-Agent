import path from "node:path";
import { BROWSER_DOWNLOAD_LIST_LIMIT, type BrowserDownloadDto, type BrowserDownloadState } from "../../shared/browser-tools";
import { downloadHost, isRiskyDownloadName, sanitizeDownloadFileName, uniqueDownloadPath } from "./browser-download-policy";

export interface DownloadItemLike {
  getURLChain(): string[];
  getFilename(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  hasUserGesture(): boolean;
  setSavePath(savePath: string): void;
  getSavePath(): string;
  cancel(): void;
  on(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  on(event: "done", listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void): unknown;
}

export interface BrowserDownloadsDeps {
  /** Settings as stored: `folder` is the full path of the chosen folder, which never leaves Main. */
  getSettings(): { askWhereToSave: boolean; folder: string | null };
  defaultDirectory(): string;
  exists(candidate: string): boolean;
  ensureDirectory(directory: string): void;
  openPath(target: string): Promise<string>;
  showInFolder(target: string): void;
  now(): number;
  newId(): string;
  onChange(downloads: readonly BrowserDownloadDto[]): void;
  maxConcurrent?: number;
  maxBytes?: number;
}

interface Entry { dto: BrowserDownloadDto; item: DownloadItemLike | null; savePath: string | null; askedWhere: boolean }
const PROGRESS_INTERVAL_MS = 250;

/** Restricted downloads for the window browser. A download is accepted only when the user triggered it, every URL
 * in its chain is plain HTTPS, and the concurrent and size limits hold. Names are sanitised, nothing is opened
 * automatically, and file types that can run code can only be shown in their folder. */
export function createBrowserDownloads(deps: BrowserDownloadsDeps) {
  const maxConcurrent = deps.maxConcurrent ?? 3, maxBytes = deps.maxBytes ?? 2 * 1024 ** 3;
  const entries = new Map<string, Entry>();
  let lastEmit = 0;
  const snapshot = (): BrowserDownloadDto[] => [...entries.values()].map(entry => ({ ...entry.dto })).reverse();
  function emit(force = true): void {
    const now = deps.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    try { deps.onChange(snapshot()); } catch { /* presentation only */ }
  }
  function trim(): void {
    while (entries.size > BROWSER_DOWNLOAD_LIST_LIMIT) {
      const finished = [...entries.entries()].find(([, entry]) => entry.dto.state !== "progressing");
      if (!finished) return;
      entries.delete(finished[0]);
    }
  }
  const active = () => [...entries.values()].filter(entry => entry.dto.state === "progressing").length;
  function finish(entry: Entry, state: BrowserDownloadState): void {
    entry.dto = { ...entry.dto, state, receivedBytes: entry.item ? entry.item.getReceivedBytes() : entry.dto.receivedBytes };
    if (entry.askedWhere && entry.item) {
      const chosen = entry.item.getSavePath();
      if (chosen) { entry.savePath = chosen; entry.dto.fileName = path.basename(chosen); entry.dto.openable = !isRiskyDownloadName(entry.dto.fileName); }
    }
    entry.item = null;
    emit();
  }

  /** True: the download continues. False: the caller must prevent it. */
  function handle(item: DownloadItemLike): boolean {
    try {
      const host = downloadHost(item.getURLChain());
      if (!host || !item.hasUserGesture() || active() >= maxConcurrent) return false;
      const total = item.getTotalBytes();
      if (total > maxBytes) return false;
      const settings = deps.getSettings(), fileName = sanitizeDownloadFileName(item.getFilename());
      let savePath: string | null = null;
      if (!settings.askWhereToSave) {
        const directory = settings.folder ?? deps.defaultDirectory();
        deps.ensureDirectory(directory);
        savePath = uniqueDownloadPath(directory, fileName, deps.exists);
        item.setSavePath(savePath);
      }
      const id = deps.newId();
      const entry: Entry = { item, savePath, askedWhere: savePath === null,
        dto: { id, fileName: savePath ? path.basename(savePath) : fileName, host, state: "progressing", receivedBytes: 0,
          totalBytes: total > 0 ? total : 0, openable: !isRiskyDownloadName(fileName), startedAt: deps.now() } };
      entries.set(id, entry); trim();
      item.on("updated", (_event, state) => {
        if (entry.item !== item) return;
        const received = item.getReceivedBytes();
        if (received > maxBytes) { item.cancel(); return; }
        entry.dto = { ...entry.dto, receivedBytes: received, totalBytes: Math.max(entry.dto.totalBytes, item.getTotalBytes(), 0) };
        if (state === "interrupted") { finish(entry, "failed"); return; }
        emit(false);
      });
      item.on("done", (_event, state) => finish(entry, state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed"));
      emit();
      return true;
    } catch { return false; }
  }

  const completed = (id: string): Entry | undefined => {
    const entry = entries.get(id);
    return entry && entry.dto.state === "completed" && entry.savePath ? entry : undefined;
  };
  return Object.freeze({
    handle,
    list: snapshot,
    async open(id: string): Promise<boolean> {
      const entry = completed(id);
      // Re-judged on the final name: the user may have picked a different one in the save dialog.
      if (!entry || !entry.dto.openable || isRiskyDownloadName(path.basename(entry.savePath!)) || !deps.exists(entry.savePath!)) return false;
      return (await deps.openPath(entry.savePath!)) === "";
    },
    reveal(id: string): boolean {
      const entry = completed(id);
      if (!entry || !deps.exists(entry.savePath!)) return false;
      deps.showInFolder(entry.savePath!); return true;
    },
    cancel(id: string): boolean {
      const entry = entries.get(id);
      if (!entry || entry.dto.state !== "progressing" || !entry.item) return false;
      try { entry.item.cancel(); } catch { return false; }
      return true;
    },
    remove(id: string): boolean {
      const entry = entries.get(id);
      if (!entry || entry.dto.state === "progressing") return false;
      entries.delete(id); emit(); return true;
    },
    clear(): void {
      for (const [id, entry] of entries) if (entry.dto.state !== "progressing") entries.delete(id);
      emit();
    },
    /** Window or app is going away: stop everything still in flight. The files already written are left alone. */
    dispose(): void {
      for (const entry of entries.values()) if (entry.dto.state === "progressing" && entry.item) { try { entry.item.cancel(); } catch { /* closing */ } }
    },
  });
}
export type BrowserDownloads = ReturnType<typeof createBrowserDownloads>;
