import fs from "node:fs";
import path from "node:path";
import type { Session } from "electron";
import { registerBrowserGuestRouting } from "../../../main/platform/browser/browser-guest-routing";
import { PluginError } from "../../../shared/plugin-protocol";
import { IPC } from "../../../shared/ipc-channels";
import {
  createPluginUiProtocolHandler,
  isAllowedPluginUiUrl,
  PLUGIN_UI_SCHEME,
  STRICT_PLUGIN_UI_CSP,
} from "./assets";
import type { CreatePluginWindowOptions, PluginUiWindowInstance } from "./window-service";

export interface ElectronPluginWindowFactoryOptions {
  preloadPath?: string;
  show?: boolean;
}

const configuredSessions = new WeakSet<Session>();
const pluginPackageRoots = new Map<string, string>();

export function resolveDefaultPluginWindowPreloadPath(): string {
  const fromDist = path.join(__dirname, "..", "..", "..", "..", "preload", "preload", "plugin-window.js");
  if (fs.existsSync(fromDist)) return fromDist;
  const { app } = require("electron") as typeof import("electron");
  const fromAppPath = typeof app?.getAppPath === "function"
    ? path.join(app.getAppPath(), "dist", "preload", "preload", "plugin-window.js")
    : "";
  if (fromAppPath && fs.existsSync(fromAppPath)) return fromAppPath;
  return path.resolve(process.cwd(), "dist", "preload", "preload", "plugin-window.js");
}

/**
 * Registers the `firefly-plugin-ui://` scheme for standalone Electron runners.
 * In the main application, `src/main/app/protocols-bootstrap.ts` calls `registerSchemesAsPrivileged` once.
 */
export function registerPluginUiScheme(): void {
  const { protocol } = require("electron") as typeof import("electron");
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_UI_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

function getIsolatedPluginSession(pluginId: string, packageRoot: string): Session {
  const { session } = require("electron") as typeof import("electron");
  pluginPackageRoots.set(pluginId, packageRoot);
  const ses = session.fromPartition(`firefly-plugin-ui:${pluginId}`, { cache: false });
  if (configuredSessions.has(ses)) {
    return ses;
  }
  configuredSessions.add(ses);

  ses.protocol.handle(
    PLUGIN_UI_SCHEME,
    createPluginUiProtocolHandler((requestedId) => pluginPackageRoots.get(requestedId), pluginId),
  );

  ses.webRequest.onBeforeRequest((details, callback) => {
    const isSafeInlineImage =
      (details.url.startsWith("data:") || details.url.startsWith("blob:"))
      && details.resourceType === "image";
    const allowed = isAllowedPluginUiUrl(details.url, pluginId) || isSafeInlineImage;
    callback({ cancel: !allowed });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      const lower = key.toLowerCase();
      if (lower === "content-security-policy" || lower === "x-content-type-options" || lower === "cache-control") {
        continue;
      }
      headers[key] = value;
    }
    headers["Content-Security-Policy"] = [STRICT_PLUGIN_UI_CSP];
    headers["X-Content-Type-Options"] = ["nosniff"];
    headers["Cache-Control"] = ["no-store"];
    callback({ responseHeaders: headers });
  });

  return ses;
}

export function createElectronPluginWindowFactory(
  factoryOptions: ElectronPluginWindowFactoryOptions = {},
): (options: CreatePluginWindowOptions) => PluginUiWindowInstance {
  const showWindow = factoryOptions.show ?? true;

  return (options: CreatePluginWindowOptions): PluginUiWindowInstance => {
    const { BrowserWindow } = require("electron") as typeof import("electron");
    const preloadPath = factoryOptions.preloadPath ?? resolveDefaultPluginWindowPreloadPath();
    const ses = getIsolatedPluginSession(options.pluginId, options.packageRoot);

    const win = new BrowserWindow({
      width: options.width,
      height: options.height,
      title: options.title,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      },
    });

    const contents = win.webContents;
    const webContentsId = contents.id;
    const offRouting = registerBrowserGuestRouting(contents, () => false);
    const closedListeners = new Set<() => void>();

    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());

    win.on("closed", () => {
      offRouting();
      for (const listener of [...closedListeners]) {
        try {
          listener();
        } catch {
          /* Closed listener failure cannot interrupt cleanup. */
        }
      }
      closedListeners.clear();
    });

    return {
      webContentsId,
      show() {
        if (showWindow && !win.isDestroyed()) {
          win.show();
        }
      },
      focus() {
        if (showWindow && !win.isDestroyed()) {
          win.focus();
        }
      },
      close() {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      },
      isDestroyed() {
        return win.isDestroyed();
      },
      sendMessage(msg: unknown) {
        if (!win.isDestroyed() && !contents.isDestroyed()) {
          contents.send(IPC.PLUGIN_WINDOW_MESSAGE, msg);
        }
      },
      onClosed(listener: () => void) {
        closedListeners.add(listener);
        return () => {
          closedListeners.delete(listener);
        };
      },
      async load() {
        if (!isAllowedPluginUiUrl(options.url, options.pluginId)) {
          throw new PluginError("ERR_INVALID_ARGUMENT", `Disallowed plugin window URL: ${options.url}`);
        }
        if (win.isDestroyed()) {
          throw new PluginError("ERR_UNAVAILABLE", "Plugin window was closed before load");
        }
        await win.loadURL(options.url);
      },
    };
  };
}
