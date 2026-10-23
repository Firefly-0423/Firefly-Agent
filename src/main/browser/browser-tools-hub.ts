import path from "node:path";
import type {
  BrowserCookieDomainDto, BrowserHistoryEntryDto, BrowserTabToolState, BrowserToolRequest, BrowserToolSettings, BrowserToolsChange,
} from "../../shared/browser-tools";
import type { BrowserDownloads } from "./browser-downloads";
import type { BrowserHostPort, BrowserToolTarget } from "./browser-service";
import { sanitizeDownloadFileName } from "./browser-download-policy";

export interface StoredBrowserToolSettings { askWhereToSave: boolean; folder: string | null }
export interface BrowserToolsHubDeps {
  downloads: BrowserDownloads;
  settings: { get(): StoredBrowserToolSettings; update(patch: Partial<StoredBrowserToolSettings>): StoredBrowserToolSettings };
  dialogs: {
    /** Native "save as" for the screenshot. False when the user cancelled. */
    saveScreenshot(host: BrowserHostPort, png: Buffer, suggestedName: string): Promise<boolean>;
    /** Native folder picker for the download folder. Null when cancelled. */
    chooseFolder(host: BrowserHostPort): Promise<string | null>;
  };
  emit(host: BrowserHostPort, change: BrowserToolsChange): void;
  now(): Date;
}

export const toSettingsDto = (stored: StoredBrowserToolSettings): BrowserToolSettings => ({
  askWhereToSave: stored.askWhereToSave, downloadFolderName: stored.folder ? path.basename(stored.folder) || stored.folder : null,
});

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Executes already-authorised tool requests. It never sees the renderer: Main's workspace has parsed the payload,
 * verified the sender and picked the tab. Window-wide results are pushed so every open view stays in step. */
export function createBrowserToolsHub(deps: BrowserToolsHubDeps) {
  const subscribed = new WeakSet<object>();
  const settingsDto = () => toSettingsDto(deps.settings.get());

  async function tab(target: BrowserToolTarget, request: BrowserToolRequest, tabId: string): Promise<unknown> {
    const tools = target.tools;
    if (!subscribed.has(target.key)) {
      subscribed.add(target.key);
      tools.subscribe(() => deps.emit(target.host, { kind: "tab", tabId, state: tools.state() }));
    }
    switch (request.tool) {
      case "state": return tools.state();
      case "find": return tools.find(request.text, request.forward, request.next);
      case "stop-find": return tools.stopFind();
      case "zoom": return tools.zoom(request.op);
      case "device": return tools.device(request.preset);
      case "print": tools.print(); return { started: true };
      case "screenshot": {
        const png = await tools.capture();
        if (!png) throw new Error("nothing captured");
        let hostname = "page";
        try { hostname = new URL(target.url).hostname || "page"; } catch { /* keep the default */ }
        const name = sanitizeDownloadFileName(`firefly-${hostname}-${stamp(deps.now())}.png`);
        return { saved: await deps.dialogs.saveScreenshot(target.host, png, name) };
      }
      case "snapshot": return { image: await tools.snapshot() };
      case "history": return { entries: tools.history() satisfies BrowserHistoryEntryDto[] };
      case "cookies": return { domains: (await tools.cookies()) satisfies BrowserCookieDomainDto[] };
      case "clear-data": await tools.clear(request.kinds, request.domain); return { cleared: true };
      default: throw new Error("not a tab tool");
    }
  }

  async function global(host: BrowserHostPort, request: BrowserToolRequest): Promise<unknown> {
    if (request.tool === "download") {
      const id = request.id ?? "";
      switch (request.op) {
        case "list": break;
        case "open": if (!(await deps.downloads.open(id))) throw new Error("cannot open"); break;
        case "reveal": if (!deps.downloads.reveal(id)) throw new Error("cannot reveal"); break;
        case "cancel": if (!deps.downloads.cancel(id)) throw new Error("cannot cancel"); break;
        case "remove": if (!deps.downloads.remove(id)) throw new Error("cannot remove"); break;
        case "clear": deps.downloads.clear(); break;
      }
      return { downloads: deps.downloads.list() };
    }
    if (request.tool === "settings") {
      let next = deps.settings.get();
      if (request.patch?.askWhereToSave !== undefined) next = deps.settings.update({ askWhereToSave: request.patch.askWhereToSave });
      if (request.resetFolder) next = deps.settings.update({ folder: null });
      if (request.chooseFolder) {
        const folder = await deps.dialogs.chooseFolder(host);
        if (folder && path.isAbsolute(folder)) next = deps.settings.update({ folder });
      }
      const settings = toSettingsDto(next);
      deps.emit(host, { kind: "settings", settings });
      return { settings };
    }
    throw new Error("not a window tool");
  }
  return Object.freeze({ tab, global, settingsDto });
}
export type BrowserToolsHub = ReturnType<typeof createBrowserToolsHub>;
export type { BrowserTabToolState };
