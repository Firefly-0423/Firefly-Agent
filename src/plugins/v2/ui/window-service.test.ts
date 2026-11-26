import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestV1 } from "../../../shared/plugin-manifest";
import {
  HOST_TO_PLUGIN_METHODS as H,
  PLUGIN_TO_HOST_METHODS as P,
  PluginError,
  type Frame,
} from "../../../shared/plugin-protocol";
import { createRpcEndpoint, type RpcTransport } from "../../../shared/plugin-rpc";
import { IPC } from "../../../shared/ipc-channels";
import {
  buildPluginWindowUrl,
  createPluginUiProtocolHandler,
  createPluginUiService,
  isAllowedPluginUiUrl,
  PLUGIN_UI_SCHEME,
  resolvePluginUiAsset,
  STRICT_PLUGIN_UI_CSP,
  type CreatePluginWindowOptions,
  type PluginUiWindowInstance,
} from "./index";

function createMemoryRpcPair(): { hostTransport: RpcTransport; pluginTransport: RpcTransport } {
  const hostListeners = new Set<(frame: unknown) => void>();
  const pluginListeners = new Set<(frame: unknown) => void>();
  return {
    hostTransport: {
      post(frame: Frame) {
        queueMicrotask(() => {
          for (const listener of pluginListeners) listener(frame);
        });
      },
      onFrame(cb) {
        hostListeners.add(cb);
        return () => {
          hostListeners.delete(cb);
        };
      },
    },
    pluginTransport: {
      post(frame: Frame) {
        queueMicrotask(() => {
          for (const listener of hostListeners) listener(frame);
        });
      },
      onFrame(cb) {
        pluginListeners.add(cb);
        return () => {
          pluginListeners.delete(cb);
        };
      },
    },
  };
}

function makeManifest(id: string, patch: Partial<PluginManifestV1> = {}): PluginManifestV1 {
  return {
    schemaVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    sdk: "^1.2.0",
    main: "index.mjs",
    permissions: ["ui.windows"],
    ui: {
      windows: [{ id: "panel", entry: "ui/panel.html", title: "Panel", width: 500, height: 320 }],
    },
    ...patch,
  };
}

function createFakeWindowFactory() {
  let nextId = 100;
  const created: Array<{
    options: CreatePluginWindowOptions;
    webContentsId: number;
    destroyed: boolean;
    shown: number;
    focused: number;
    closed: number;
    messages: unknown[];
    emitClosed: () => void;
  }> = [];

  const createWindow = (options: CreatePluginWindowOptions): PluginUiWindowInstance => {
    const closedListeners = new Set<() => void>();
    const record = {
      options,
      webContentsId: nextId++,
      destroyed: false,
      shown: 0,
      focused: 0,
      closed: 0,
      messages: [] as unknown[],
      emitClosed: () => {
        if (record.destroyed) return;
        record.destroyed = true;
        for (const listener of [...closedListeners]) listener();
      },
    };
    created.push(record);
    return {
      webContentsId: record.webContentsId,
      show: () => { record.shown += 1; },
      focus: () => { record.focused += 1; },
      close: () => {
        record.closed += 1;
        record.emitClosed();
      },
      isDestroyed: () => record.destroyed,
      sendMessage: (msg) => { record.messages.push(msg); },
      onClosed: (listener) => {
        closedListeners.add(listener);
        return () => { closedListeners.delete(listener); };
      },
      load: async () => {},
    };
  };

  return { created, createWindow };
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "ff-plugin-ui-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("plugin v2 UI asset protocol & CSP", () => {
  it("serves static assets inside package root with strict CSP headers", async () => {
    const pkgRoot = path.join(tempRoot, "pkg");
    const uiDir = path.join(pkgRoot, "ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, "panel.html"), "<!doctype html><html><body>OK</body></html>", "utf8");
    writeFileSync(path.join(uiDir, "panel.js"), "console.log('ok');", "utf8");

    const url = buildPluginWindowUrl("dev.firefly.alpha", "ui\\panel.html");
    expect(url).toBe(`${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.html`);

    const asset = await resolvePluginUiAsset(url, "dev.firefly.alpha", pkgRoot);
    expect(asset.status).toBe(200);
    if (asset.status === 200) {
      expect(asset.contentType).toBe("text/html; charset=utf-8");
      expect(asset.headers["Content-Security-Policy"]).toBe(STRICT_PLUGIN_UI_CSP);
      expect(asset.headers["Content-Security-Policy"]).toContain("script-src 'self'");
      expect(asset.headers["Content-Security-Policy"]).toContain("default-src 'self'");
      expect(asset.headers["Content-Security-Policy"]).toContain("object-src 'none'");
      expect(asset.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(asset.body.toString("utf8")).toContain("OK");
    }

    const handler = createPluginUiProtocolHandler((id) => (id === "dev.firefly.alpha" ? pkgRoot : undefined), "dev.firefly.alpha");
    const res = await handler(new Request(`${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.js`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(STRICT_PLUGIN_UI_CSP);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  });

  it("rejects external URLs, file: escapes, traversal, cross-plugin origins, and symlink/junction escapes", async () => {
    const pkgRoot = path.join(tempRoot, "pkg");
    const outsideDir = path.join(tempRoot, "outside");
    mkdirSync(path.join(pkgRoot, "ui"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(pkgRoot, "ui", "panel.html"), "<html></html>", "utf8");
    writeFileSync(path.join(outsideDir, "secret.txt"), "TOP_SECRET", "utf8");
    writeFileSync(path.join(pkgRoot, "ui", "binary.exe"), "MZ", "utf8");

    const junctionPath = path.join(pkgRoot, "ui", "escape-dir");
    symlinkSync(outsideDir, junctionPath, process.platform === "win32" ? "junction" : "dir");

    expect(isAllowedPluginUiUrl("https://example.com/evil.html", "dev.firefly.alpha")).toBe(false);
    expect(isAllowedPluginUiUrl("http://localhost:5173/", "dev.firefly.alpha")).toBe(false);
    expect(isAllowedPluginUiUrl("file:///C:/Windows/win.ini", "dev.firefly.alpha")).toBe(false);
    expect(isAllowedPluginUiUrl(`${PLUGIN_UI_SCHEME}://dev.firefly.beta/ui/panel.html`, "dev.firefly.alpha")).toBe(false);
    expect(isAllowedPluginUiUrl(`${PLUGIN_UI_SCHEME}://dev.firefly.alpha/../outside/secret.txt`, "dev.firefly.alpha")).toBe(false);
    expect(isAllowedPluginUiUrl(`${PLUGIN_UI_SCHEME}://dev.firefly.alpha/%2e%2e/outside/secret.txt`, "dev.firefly.alpha")).toBe(false);

    for (const badUrl of [
      "https://example.com/evil.html",
      "file:///C:/Windows/win.ini",
      `${PLUGIN_UI_SCHEME}://dev.firefly.beta/ui/panel.html`,
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/%2e%2e/outside/secret.txt`,
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/escape-dir/secret.txt`,
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/binary.exe`,
    ]) {
      const res = await resolvePluginUiAsset(badUrl, "dev.firefly.alpha", pkgRoot);
      expect(res.status, badUrl).toBe(403);
    }

    expect(() => buildPluginWindowUrl("dev.firefly.alpha", "../outside.html")).toThrow(PluginError);
    expect(() => buildPluginWindowUrl("dev.firefly.alpha", "C:\\outside.html")).toThrow(PluginError);
  });

  it("rejects symlinked/junctioned packageRoot or ancestors without opening asset files (D5)", async () => {
    const outsideDir = path.join(tempRoot, "outside-pkg");
    mkdirSync(path.join(outsideDir, "ui"), { recursive: true });
    writeFileSync(path.join(outsideDir, "ui", "panel.html"), "<html>secret</html>", "utf8");

    const linkedRoot = path.join(tempRoot, "linked-pkg-root");
    symlinkSync(outsideDir, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const openSpy = vi.fn(fsPromises.open);
    const res1 = await resolvePluginUiAsset(
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.html`,
      "dev.firefly.alpha",
      linkedRoot,
      { fs: { open: openSpy } },
    );
    expect(res1.status).toBe(403);
    expect("body" in res1).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();

    const linkedParent = path.join(tempRoot, "linked-parent");
    symlinkSync(outsideDir, linkedParent, process.platform === "win32" ? "junction" : "dir");
    mkdirSync(path.join(outsideDir, "nested", "ui"), { recursive: true });
    writeFileSync(path.join(outsideDir, "nested", "ui", "panel.html"), "<html>nested</html>", "utf8");
    const res2 = await resolvePluginUiAsset(
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.html`,
      "dev.firefly.alpha",
      path.join(linkedParent, "nested"),
      { fs: { open: openSpy } },
    );
    expect(res2.status).toBe(403);
    expect("body" in res2).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("returns zero bytes when target file or ancestor is replaced between validation and open/fstat (D5)", async () => {
    const pkgRoot = path.join(tempRoot, "pkg-toctou");
    const uiDir = path.join(pkgRoot, "ui");
    mkdirSync(uiDir, { recursive: true });
    const panelPath = path.join(uiDir, "panel.html");
    const decoyPath = path.join(tempRoot, "decoy.html");
    writeFileSync(panelPath, "<html>original</html>", "utf8");
    writeFileSync(decoyPath, "<html>attacker-payload</html>", "utf8");

    // 1. Replace file right before open() (inode mismatch between lstat and handle.stat)
    const readFileSpy = vi.fn();
    const closeSpy = vi.fn(async () => {});
    const handler = createPluginUiProtocolHandler(
      (id) => (id === "dev.firefly.alpha" ? pkgRoot : undefined),
      "dev.firefly.alpha",
      {
        fs: {
          async open() {
            const decoyHandle = await fsPromises.open(decoyPath, "r");
            const origStat = decoyHandle.stat.bind(decoyHandle);
            return {
              stat: origStat,
              readFile: readFileSpy,
              close: async () => {
                await decoyHandle.close();
                await closeSpy();
              },
            } as unknown as Awaited<ReturnType<typeof fsPromises.open>>;
          },
        },
      },
    );

    const res = await handler(new Request(`${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.html`));
    expect(res.status).toBe(403);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // 2. Replace ancestor into symlink between open() and post-open re-check
    let openedOnce = false;
    const readFileSpy2 = vi.fn();
    const closeSpy2 = vi.fn(async () => {});
    const resAfterOpen = await resolvePluginUiAsset(
      `${PLUGIN_UI_SCHEME}://dev.firefly.alpha/ui/panel.html`,
      "dev.firefly.alpha",
      pkgRoot,
      {
        fs: {
          async lstat(target, opts) {
            const info = await fsPromises.lstat(target, opts);
            if (openedOnce && path.resolve(String(target)) === path.resolve(uiDir)) {
              return {
                ...info,
                isSymbolicLink: () => true,
                isDirectory: () => false,
              } as unknown as Awaited<ReturnType<typeof fsPromises.lstat>>;
            }
            return info;
          },
          async open(target, flags) {
            const realHandle = await fsPromises.open(target, flags);
            openedOnce = true;
            return {
              stat: realHandle.stat.bind(realHandle),
              readFile: readFileSpy2,
              close: async () => {
                await realHandle.close();
                await closeSpy2();
              },
            } as unknown as Awaited<ReturnType<typeof fsPromises.open>>;
          },
        },
      },
    );
    expect(resAfterOpen.status).toBe(403);
    expect("body" in resAfterOpen).toBe(false);
    expect(readFileSpy2).not.toHaveBeenCalled();
    expect(closeSpy2).toHaveBeenCalledTimes(1);
  });
});

describe("plugin v2 UI RPC, cross-plugin isolation, and lifecycle cleanup", () => {
  it("validates ui.windows permission and declared window IDs with ERR_PERMISSION / ERR_UNDECLARED", async () => {
    const factory = createFakeWindowFactory();
    const state = {
      "dev.firefly.alpha": {
        packageRoot: path.join(tempRoot, "alpha"),
        manifest: makeManifest("dev.firefly.alpha"),
        isEnabled: true,
        hasWindowsPermission: false,
      },
      "dev.firefly.undeclared": {
        packageRoot: path.join(tempRoot, "undeclared"),
        manifest: makeManifest("dev.firefly.undeclared", { permissions: [], ui: undefined }),
        isEnabled: true,
        hasWindowsPermission: false,
      },
    };
    const sendToPlugin = vi.fn(async () => ({ ok: true }));
    const service = createPluginUiService({
      resolvePlugin: (id) => (state as Record<string, typeof state["dev.firefly.alpha"]>)[id] ?? null,
      sendToPlugin,
      createWindow: factory.createWindow,
    });

    const { hostTransport, pluginTransport } = createMemoryRpcPair();
    const hostRpc = createRpcEndpoint(hostTransport);
    const pluginRpc = createRpcEndpoint(pluginTransport);
    const offAlpha = service.bindRpc("dev.firefly.alpha", hostRpc);

    // Permission not granted -> ERR_PERMISSION and no window created
    await expect(pluginRpc.call(P.uiOpenWindow, { id: "panel" })).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(factory.created).toHaveLength(0);

    // Grant permission, undeclared window id -> ERR_UNDECLARED
    state["dev.firefly.alpha"].hasWindowsPermission = true;
    await expect(pluginRpc.call(P.uiOpenWindow, { id: "missing" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(pluginRpc.call(P.uiCloseWindow, { id: "missing" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(pluginRpc.call(P.uiPost, { to: { kind: "window", id: "missing" }, msg: "hi" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect(pluginRpc.call(P.uiPost, { to: { kind: "settings", id: "settings" }, msg: "hi" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(factory.created).toHaveLength(0);

    // Permission not declared in manifest -> ERR_UNDECLARED
    const { hostTransport: ht2, pluginTransport: pt2 } = createMemoryRpcPair();
    const hostRpc2 = createRpcEndpoint(ht2);
    const pluginRpc2 = createRpcEndpoint(pt2);
    const offUndeclared = service.bindRpc("dev.firefly.undeclared", hostRpc2);
    await expect(pluginRpc2.call(P.uiOpenWindow, { id: "panel" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    await expect((async () => {
      for await (const _chunk of pluginRpc2.stream(P.uiOnMessage, {})) {
        // Should throw ERR_UNDECLARED before yielding.
      }
    })()).rejects.toMatchObject({ code: "ERR_UNDECLARED" });

    offUndeclared();
    offAlpha();
    hostRpc.dispose();
    pluginRpc.dispose();
    hostRpc2.dispose();
    pluginRpc2.dispose();
  });

  it("isolates window <-> plugin messaging per plugin and blocks cross-plugin targeting", async () => {
    const factory = createFakeWindowFactory();
    const plugins: Record<string, { packageRoot: string; manifest: PluginManifestV1; isEnabled: boolean; hasWindowsPermission: boolean }> = {
      "dev.firefly.alpha": {
        packageRoot: path.join(tempRoot, "alpha"),
        manifest: makeManifest("dev.firefly.alpha"),
        isEnabled: true,
        hasWindowsPermission: true,
      },
      "dev.firefly.beta": {
        packageRoot: path.join(tempRoot, "beta"),
        manifest: makeManifest("dev.firefly.beta", {
          ui: { windows: [{ id: "panel", entry: "ui/panel.html", title: "Beta Panel" }, { id: "beta-only", entry: "ui/only.html", title: "Only" }] },
        }),
        isEnabled: true,
        hasWindowsPermission: true,
      },
    };
    const sendToPlugin = vi.fn(async (pluginId: string, _method: typeof H.uiMessage, params: unknown) => ({
      handledBy: pluginId,
      params,
    }));
    const service = createPluginUiService({
      resolvePlugin: (id) => plugins[id] ?? null,
      sendToPlugin,
      createWindow: factory.createWindow,
    });

    await service.openWindow("dev.firefly.alpha", "panel", { owner: "alpha" });
    await service.openWindow("dev.firefly.beta", "panel", { owner: "beta" });
    expect(factory.created).toHaveLength(2);
    const [winA, winB] = factory.created;

    expect(service.handleWindowGetState(winA.webContentsId)).toEqual({ owner: "alpha" });
    expect(service.handleWindowGetState(winB.webContentsId)).toEqual({ owner: "beta" });

    // Buffered post before ready flushes on ready ONLY to target plugin's window
    await service.postMessage("dev.firefly.alpha", { kind: "window", id: "panel" }, { hello: "a1" });
    expect(winA.messages).toEqual([]);
    service.handleWindowReady(winA.webContentsId);
    expect(winA.messages).toEqual([{ hello: "a1" }]);
    expect(winB.messages).toEqual([]);

    // Window A invoke routes strictly to Plugin A, never Plugin B
    const replyA = await service.handleWindowInvoke(winA.webContentsId, { method: "ping", params: { n: 1 } });
    expect(replyA).toEqual({
      handledBy: "dev.firefly.alpha",
      params: { from: { kind: "window", id: "panel" }, method: "ping", params: { n: 1 } },
    });
    expect(sendToPlugin).toHaveBeenCalledTimes(1);
    expect(sendToPlugin).toHaveBeenCalledWith("dev.firefly.alpha", H.uiMessage, expect.anything());

    // Spoofed cross-plugin target fields are rejected with zero calls to Plugin B
    await expect(
      service.handleWindowInvoke(winA.webContentsId, { method: "ping", pluginId: "dev.firefly.beta" }),
    ).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    await expect(
      service.handleWindowInvoke(winA.webContentsId, { method: "ping", targetPluginId: "dev.firefly.beta" }),
    ).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(sendToPlugin).toHaveBeenCalledTimes(1);

    // Plugin A cannot post to Plugin B's window id
    await expect(
      service.postMessage("dev.firefly.alpha", { kind: "window", id: "beta-only" }, { hi: "beta" }),
    ).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(winB.messages).toEqual([]);

    // Unknown webContentsId cannot invoke any plugin
    await expect(service.handleWindowInvoke(999999, { method: "ping" })).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" });
  });

  it("closes all windows of a plugin on deactivate/stop/fault without touching sibling plugins", async () => {
    const factory = createFakeWindowFactory();
    const plugins: Record<string, { packageRoot: string; manifest: PluginManifestV1; isEnabled: boolean; hasWindowsPermission: boolean }> = {
      "dev.firefly.alpha": {
        packageRoot: path.join(tempRoot, "alpha"),
        manifest: makeManifest("dev.firefly.alpha", {
          ui: {
            windows: [
              { id: "w1", entry: "ui/w1.html", title: "W1" },
              { id: "w2", entry: "ui/w2.html", title: "W2" },
            ],
          },
        }),
        isEnabled: true,
        hasWindowsPermission: true,
      },
      "dev.firefly.beta": {
        packageRoot: path.join(tempRoot, "beta"),
        manifest: makeManifest("dev.firefly.beta"),
        isEnabled: true,
        hasWindowsPermission: true,
      },
    };
    const service = createPluginUiService({
      resolvePlugin: (id) => plugins[id] ?? null,
      sendToPlugin: async () => null,
      createWindow: factory.createWindow,
    });

    const { hostTransport: htA, pluginTransport: ptA } = createMemoryRpcPair();
    const { hostTransport: htB, pluginTransport: ptB } = createMemoryRpcPair();
    const hostRpcA = createRpcEndpoint(htA);
    const pluginRpcA = createRpcEndpoint(ptA);
    const hostRpcB = createRpcEndpoint(htB);
    const pluginRpcB = createRpcEndpoint(ptB);

    const disposeA = service.bindRpc("dev.firefly.alpha", hostRpcA);
    const disposeB = service.bindRpc("dev.firefly.beta", hostRpcB);

    await pluginRpcA.call(P.uiOpenWindow, { id: "w1" });
    await pluginRpcA.call(P.uiOpenWindow, { id: "w2" });
    await pluginRpcB.call(P.uiOpenWindow, { id: "panel" });
    expect(service.listOpenWindowIds("dev.firefly.alpha")).toEqual(["w1", "w2"]);
    expect(service.listOpenWindowIds("dev.firefly.beta")).toEqual(["panel"]);

    // Deactivating/faulting Alpha closes both of Alpha's windows, leaves Beta's open
    disposeA();
    expect(service.listOpenWindowIds("dev.firefly.alpha")).toEqual([]);
    expect(factory.created[0].destroyed).toBe(true);
    expect(factory.created[1].destroyed).toBe(true);
    expect(service.listOpenWindowIds("dev.firefly.beta")).toEqual(["panel"]);
    expect(factory.created[2].destroyed).toBe(false);

    disposeB();
    expect(service.listOpenWindowIds("dev.firefly.beta")).toEqual([]);
    expect(factory.created[2].destroyed).toBe(true);

    hostRpcA.dispose();
    pluginRpcA.dispose();
    hostRpcB.dispose();
    pluginRpcB.dispose();
  });

  it("exposes scoped window.fireflyPlugin preload API and cleans up listeners with removeListener", async () => {
    vi.resetModules();
    const exposed = new Map<string, unknown>();
    const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
    const invokeMock = vi.fn(async () => ({ ok: true }));
    const sendMock = vi.fn();
    const onMock = vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    });
    const removeListenerMock = vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    });

    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld: (name: string, api: unknown) => {
          exposed.set(name, api);
        },
      },
      ipcRenderer: {
        invoke: invokeMock,
        send: sendMock,
        on: onMock,
        removeListener: removeListenerMock,
      },
    }));

    const { createFireflyPluginWindowApi } = await import("../../../preload/plugin-window");
    const api = exposed.get("fireflyPlugin") as ReturnType<typeof createFireflyPluginWindowApi>;
    expect(api).toBeDefined();

    await api.getState();
    expect(invokeMock).toHaveBeenCalledWith(IPC.PLUGIN_WINDOW_GET_STATE);

    await api.invoke("save", { value: 42 });
    expect(invokeMock).toHaveBeenCalledWith(IPC.PLUGIN_WINDOW_INVOKE, { method: "save", params: { value: 42 } });

    await expect(api.invoke("   ")).rejects.toThrow(/non-empty string/);

    const received: unknown[] = [];
    const unsub = api.onMessage((msg) => received.push(msg));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(IPC.PLUGIN_WINDOW_READY);

    for (const listener of [...(listeners.get(IPC.PLUGIN_WINDOW_MESSAGE) ?? [])]) {
      listener({}, { kind: "ping" });
    }
    expect(received).toEqual([{ kind: "ping" }]);
    unsub();
    expect(removeListenerMock).toHaveBeenCalledTimes(1);

    await api.close();
    expect(invokeMock).toHaveBeenCalledWith(IPC.PLUGIN_WINDOW_CLOSE);
  });
});
