import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserToolsChange } from "../../shared/browser-tools";
import { createBrowserToolsHub, type StoredBrowserToolSettings } from "./browser-tools-hub";
import { createBrowserToolSettingsStore } from "./browser-tools-settings";
import type { BrowserGuestTools } from "./browser-guest-tools";
import type { BrowserHostPort, BrowserToolTarget } from "./browser-service";

const host = {} as BrowserHostPort;
let changes: BrowserToolsChange[], stored: StoredBrowserToolSettings, listener: (() => void) | undefined;
let downloads: Record<string, ReturnType<typeof vi.fn>>, dialogs: { saveScreenshot: ReturnType<typeof vi.fn>; chooseFolder: ReturnType<typeof vi.fn> };
let tools: Record<string, ReturnType<typeof vi.fn>>, target: BrowserToolTarget;
function makeHub() {
  return createBrowserToolsHub({
    downloads: downloads as never, dialogs,
    settings: { get: () => ({ ...stored }), update: patch => { stored = { ...stored, ...patch }; return { ...stored }; } },
    emit: (_host, change) => { changes.push(change); }, now: () => new Date(2026, 9, 15, 21, 5, 9),
  });
}
beforeEach(() => {
  changes = []; stored = { askWhereToSave: false, folder: null }; listener = undefined;
  downloads = { list: vi.fn(() => []), open: vi.fn(async () => true), reveal: vi.fn(() => true), cancel: vi.fn(() => true), remove: vi.fn(() => true), clear: vi.fn() };
  dialogs = { saveScreenshot: vi.fn(async () => true), chooseFolder: vi.fn(async () => path.resolve("Picked", "Folder")) };
  const state = { zoomPercent: 110, device: "off", find: null };
  tools = {
    state: vi.fn(() => state), find: vi.fn(() => state), stopFind: vi.fn(() => state), zoom: vi.fn(() => state), device: vi.fn(() => state),
    print: vi.fn(), capture: vi.fn(async () => Buffer.from("png")), history: vi.fn(() => []), cookies: vi.fn(async () => [{ domain: "a.test", count: 1 }]),
    clear: vi.fn(async () => {}), snapshot: vi.fn(async () => "data:image/jpeg;base64,AA=="), subscribe: vi.fn((l: () => void) => { listener = l; return () => {}; }),
  };
  target = { key: {}, tools: tools as unknown as BrowserGuestTools, host, url: "https://news.example/page" };
});

describe("browser tools hub: tab tools", () => {
  it("runs each tab tool on the tab's guest tools", async () => {
    const hub = makeHub();
    await hub.tab(target, { tool: "find", text: "x", forward: true, next: false }, "t1");
    expect(tools.find).toHaveBeenCalledWith("x", true, false);
    await hub.tab(target, { tool: "zoom", op: "in" }, "t1"); expect(tools.zoom).toHaveBeenCalledWith("in");
    await hub.tab(target, { tool: "device", preset: "phone" }, "t1"); expect(tools.device).toHaveBeenCalledWith("phone");
    await hub.tab(target, { tool: "stop-find" }, "t1"); expect(tools.stopFind).toHaveBeenCalled();
    expect(await hub.tab(target, { tool: "print" }, "t1")).toEqual({ started: true }); expect(tools.print).toHaveBeenCalled();
    expect(await hub.tab(target, { tool: "cookies" }, "t1")).toEqual({ domains: [{ domain: "a.test", count: 1 }] });
    await hub.tab(target, { tool: "clear-data", kinds: ["cookies"], domain: "a.test" }, "t1"); expect(tools.clear).toHaveBeenCalledWith(["cookies"], "a.test");
  });

  it("pushes tab changes with the tab id, subscribing once per guest", async () => {
    const hub = makeHub();
    await hub.tab(target, { tool: "state" }, "t1"); await hub.tab(target, { tool: "state" }, "t1");
    expect(tools.subscribe).toHaveBeenCalledTimes(1);
    listener!();
    expect(changes).toEqual([{ kind: "tab", tabId: "t1", state: { zoomPercent: 110, device: "off", find: null } }]);
  });

  it("returns a page snapshot for the menu stand-in", async () => {
    expect(await makeHub().tab(target, { tool: "snapshot" }, "t1")).toEqual({ image: "data:image/jpeg;base64,AA==" });
  });

  it("saves a screenshot through the native dialog under a sanitised, dated name", async () => {
    const hub = makeHub();
    expect(await hub.tab(target, { tool: "screenshot" }, "t1")).toEqual({ saved: true });
    expect(dialogs.saveScreenshot).toHaveBeenCalledWith(host, expect.any(Buffer), "firefly-news.example-20261015-210509.png");
    dialogs.saveScreenshot.mockResolvedValueOnce(false);
    expect(await hub.tab(target, { tool: "screenshot" }, "t1")).toEqual({ saved: false });
  });

  it("fails a screenshot when nothing could be captured", async () => {
    tools.capture.mockResolvedValueOnce(null);
    await expect(makeHub().tab(target, { tool: "screenshot" }, "t1")).rejects.toThrow();
    expect(dialogs.saveScreenshot).not.toHaveBeenCalled();
  });
});

describe("browser tools hub: window tools", () => {
  it("drives the downloads and reports failures", async () => {
    const hub = makeHub();
    await hub.global(host, { tool: "download", op: "open", id: "d1" }); expect(downloads.open).toHaveBeenCalledWith("d1");
    await hub.global(host, { tool: "download", op: "reveal", id: "d1" }); expect(downloads.reveal).toHaveBeenCalledWith("d1");
    await hub.global(host, { tool: "download", op: "clear" }); expect(downloads.clear).toHaveBeenCalled();
    downloads.cancel.mockReturnValueOnce(false);
    await expect(hub.global(host, { tool: "download", op: "cancel", id: "gone" })).rejects.toThrow();
    expect(await hub.global(host, { tool: "download", op: "list" })).toEqual({ downloads: [] });
  });

  it("updates settings, shows only the folder's own name, and pushes the result", async () => {
    const hub = makeHub();
    expect(await hub.global(host, { tool: "settings", patch: { askWhereToSave: true } })).toEqual({ settings: { askWhereToSave: true, downloadFolderName: null } });
    const result = await hub.global(host, { tool: "settings", chooseFolder: true }) as { settings: { downloadFolderName: string } };
    expect(result.settings.downloadFolderName).toBe("Folder");
    expect(stored.folder).toBe(path.resolve("Picked", "Folder"));
    expect(JSON.stringify(changes)).not.toContain("Picked");
    expect(await hub.global(host, { tool: "settings", resetFolder: true })).toEqual({ settings: { askWhereToSave: true, downloadFolderName: null } });
    expect(changes.at(-1)).toEqual({ kind: "settings", settings: { askWhereToSave: true, downloadFolderName: null } });
  });

  it("keeps the folder when the picker is cancelled or returns a relative path", async () => {
    const hub = makeHub();
    dialogs.chooseFolder.mockResolvedValueOnce(null); await hub.global(host, { tool: "settings", chooseFolder: true });
    dialogs.chooseFolder.mockResolvedValueOnce("relative/dir"); await hub.global(host, { tool: "settings", chooseFolder: true });
    expect(stored.folder).toBeNull();
  });
});

describe("browser tool settings store", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-browser-tools-")); });

  it("starts from the defaults and persists updates across a restart", () => {
    const file = path.join(dir, "browser", "tools.json");
    const first = createBrowserToolSettingsStore(file);
    expect(first.get()).toEqual({ askWhereToSave: false, folder: null });
    first.update({ askWhereToSave: true, folder: path.resolve(dir, "dl") });
    expect(createBrowserToolSettingsStore(file).get()).toEqual({ askWhereToSave: true, folder: path.resolve(dir, "dl") });
  });

  it("ignores an invalid update and falls back to defaults for an unreadable file without overwriting it", () => {
    const file = path.join(dir, "tools.json");
    fs.writeFileSync(file, "{ not json");
    const store = createBrowserToolSettingsStore(file);
    expect(store.get()).toEqual({ askWhereToSave: false, folder: null });
    expect(store.update({ folder: "relative" })).toEqual({ askWhereToSave: false, folder: null });
    store.update({ askWhereToSave: true });
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });
});
