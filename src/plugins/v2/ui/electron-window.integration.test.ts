import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
let electron: string | undefined;
try {
  electron = require("electron") as string;
} catch {
  /* Electron binary is optional on test-only machines. */
}

function writePluginPackage(root: string, id: string, title: string): string {
  const pkgDir = join(root, "plugins", id, "1.0.0");
  const uiDir = join(pkgDir, "ui");
  mkdirSync(uiDir, { recursive: true });

  writeFileSync(
    join(pkgDir, "index.mjs"),
    `const received = [];
let openHandle = null;
export default {
  activate(ctx) {
    ctx.ui.onMessage(async (e) => {
      received.push(e);
      if (e.method === "open_state_echo") {
        return { pluginId: ctx.id, receivedCount: received.length, event: e };
      }
      if (e.method === "push_to_window" && openHandle) {
        await openHandle.post({ fromPlugin: ctx.id, payload: e.params });
        return { pushed: true };
      }
      return { pluginId: ctx.id, receivedCount: received.length, event: e };
    });
    ctx.tools.register({
      name: "open_ui",
      description: "Open UI window",
      parameters: { type: "object", properties: { tag: { type: "string" } } },
      async execute(args) {
        openHandle = await ctx.ui.openWindow("panel", { plugin: ctx.id, tag: args.tag ?? "default" });
        return { status: "succeeded", output: { opened: true } };
      },
    });
    ctx.tools.register({
      name: "post_ui",
      description: "Post message to UI window",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args) {
        if (openHandle) {
          await openHandle.post({ fromPlugin: ctx.id, text: args.text });
        }
        return { status: "succeeded", output: { posted: Boolean(openHandle) } };
      },
    });
    ctx.tools.register({
      name: "stats",
      description: "Get received UI message count",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { status: "succeeded", output: { count: received.length, received } };
      },
    });
  },
};
`,
    "utf8",
  );

  writeFileSync(
    join(uiDir, "panel.html"),
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
</head>
<body>
  <h1 id="title">${title}</h1>
  <script>window.__INLINE_SCRIPT_RAN__ = true;</script>
  <script src="https://example.com/evil.js"></script>
  <script src="./panel.js"></script>
</body>
</html>
`,
    "utf8",
  );

  writeFileSync(
    join(uiDir, "panel.js"),
    `window.__SELF_SCRIPT_RAN__ = true;
window.__RECEIVED_MESSAGES__ = [];
if (window.fireflyPlugin) {
  window.fireflyPlugin.onMessage((msg) => {
    window.__RECEIVED_MESSAGES__.push(msg);
  });
}
`,
    "utf8",
  );

  return pkgDir;
}

it.skipIf(!electron || !existsSync(electron))(
  "enforces isolated BrowserWindow, strict CSP headers, external URL rejection, cross-plugin isolation, and lifecycle cleanup in real Electron",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-plugin-win-e2e-"));
    try {
      const dataRoot = join(dir, "data");
      mkdirSync(dataRoot, { recursive: true });
      const alphaDir = writePluginPackage(dataRoot, "dev.firefly.alpha", "Alpha");
      const betaDir = writePluginPackage(dataRoot, "dev.firefly.beta", "Beta");

      const runtimeBundle = join(dir, "runtime-entry.cjs");
      const preloadBundle = join(dir, "plugin-window-preload.cjs");
      const runner = join(dir, "runner.cjs");

      buildSync({
        entryPoints: ["src/plugins/v2/runtime/main.ts"],
        outfile: runtimeBundle,
        platform: "node",
        bundle: true,
        format: "cjs",
      });

      buildSync({
        entryPoints: ["src/preload/plugin-window.ts"],
        outfile: preloadBundle,
        platform: "node",
        bundle: true,
        external: ["electron"],
        format: "cjs",
      });

      const runnerSource = `
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { ToolRegistry } = require("./src/main/tooling/registry/tool-registry.ts");
const { pluginToolId } = require("./src/plugins/v2/tools/tool-service.ts");
const { createElectronPluginWindowFactory, registerPluginUiScheme, STRICT_PLUGIN_UI_CSP } = require("./src/plugins/v2/ui/index.ts");
const { createPluginV2HostController } = require("./src/main/features/plugins/host/plugin-v2-services.ts");
const { IPC } = require("./src/shared/ipc-channels.ts");

registerPluginUiScheme();
app.setPath("userData", ${JSON.stringify(dataRoot)});

app.whenReady().then(async () => {
  const toolRegistry = new ToolRegistry();
  const controller = createPluginV2HostController({
    dataRoot: ${JSON.stringify(dataRoot)},
    stateFile: join(${JSON.stringify(dataRoot)}, "plugin-state.json"),
    scheduleStateFile: join(${JSON.stringify(dataRoot)}, "plugin-schedules.json"),
    runtimeEntry: ${JSON.stringify(runtimeBundle)},
    toolRegistry,
    schedulerStore: {
      listTasksByOwner: () => [],
      getTask: () => null,
      createTask: () => { throw new Error("unused"); },
      updateTask: () => null,
      deleteTask: () => false,
      deleteTasksByOwner: () => 0,
      getHistory: () => [],
    },
    llmClient: { chatNonStream: async () => ({ text: "" }) },
    buildRunOptions: async () => { throw new Error("unused"); },
    loadModelSettings: () => ({}),
    loadGeneralSettings: () => ({}),
    listSessions: () => [],
    getSession: () => null,
    getActiveChatTarget: () => null,
    confirmFirstUse: async () => true,
    createPluginWindow: createElectronPluginWindowFactory({ preloadPath: ${JSON.stringify(preloadBundle)}, show: false }),
  });

  ipcMain.handle(IPC.PLUGIN_WINDOW_GET_STATE, (event) => controller.uiService.handleWindowGetState(event.sender.id));
  ipcMain.handle(IPC.PLUGIN_WINDOW_INVOKE, (event, payload) => controller.uiService.handleWindowInvoke(event.sender.id, payload));
  ipcMain.handle(IPC.PLUGIN_WINDOW_CLOSE, (event) => controller.uiService.handleWindowClose(event.sender.id));
  ipcMain.on(IPC.PLUGIN_WINDOW_READY, (event) => controller.uiService.handleWindowReady(event.sender.id));

  const installAndEnable = async (id, name, dir) => {
    controller.installPlugin({
      schemaVersion: 1,
      sdk: "^1.2.0",
      id,
      name,
      version: "1.0.0",
      main: "index.mjs",
      permissions: ["ui.windows"],
      tools: [
        { name: "open_ui", title: "Open UI", risk: ["network"], modes: ["work"] },
        { name: "post_ui", title: "Post UI", risk: ["network"], modes: ["work"] },
        { name: "stats", title: "Stats", risk: ["network"], modes: ["work"] },
      ],
      ui: { windows: [{ id: "panel", entry: "ui/panel.html", title: name + " Panel", width: 420, height: 300 }] },
    }, dir);
    await controller.enablePlugin(id, {
      grantedPermissions: ["ui.windows", "tool:open_ui", "tool:post_ui", "tool:stats"],
    });
  };

  try {
    await installAndEnable("dev.firefly.alpha", "Alpha", ${JSON.stringify(alphaDir)});
    await installAndEnable("dev.firefly.beta", "Beta", ${JSON.stringify(betaDir)});

    const openA = toolRegistry.getById(pluginToolId("dev.firefly.alpha", "open_ui"));
    const openB = toolRegistry.getById(pluginToolId("dev.firefly.beta", "open_ui"));
    const postA = toolRegistry.getById(pluginToolId("dev.firefly.alpha", "post_ui"));
    const statsA = toolRegistry.getById(pluginToolId("dev.firefly.alpha", "stats"));
    const statsB = toolRegistry.getById(pluginToolId("dev.firefly.beta", "stats"));

    await openA.execute({ tag: "alpha-tag" });
    await openB.execute({ tag: "beta-tag" });

    const allWins = BrowserWindow.getAllWindows();
    assert.equal(allWins.length, 2);
    const winA = allWins.find((w) => w.webContents.getURL().startsWith("firefly-plugin-ui://dev.firefly.alpha/"));
    const winB = allWins.find((w) => w.webContents.getURL().startsWith("firefly-plugin-ui://dev.firefly.beta/"));
    assert.ok(winA, "Alpha window must exist");
    assert.ok(winB, "Beta window must exist");

    // 1. Verify sandbox/isolation, self script execution, blocked inline/external scripts, and CSP response header.
    const envCheck = await winA.webContents.executeJavaScript(\`
      (async () => {
        const res = await fetch("./panel.html");
        const csp = res.headers.get("Content-Security-Policy");
        let externalBlocked = false;
        try {
          await fetch("https://example.com/");
        } catch {
          externalBlocked = true;
        }
        return {
          selfRan: window.__SELF_SCRIPT_RAN__ === true,
          inlineRan: window.__INLINE_SCRIPT_RAN__ === true,
          hasRequire: typeof window.require !== "undefined",
          hasProcess: typeof window.process !== "undefined",
          hasMainPlugins: typeof window.plugins !== "undefined",
          hasBridge: typeof window.fireflyPlugin === "object" && typeof window.fireflyPlugin.invoke === "function",
          state: await window.fireflyPlugin.getState(),
          csp,
          externalBlocked,
        };
      })()
    \`);
    assert.equal(envCheck.selfRan, true);
    assert.equal(envCheck.inlineRan, false);
    assert.equal(envCheck.hasRequire, false);
    assert.equal(envCheck.hasProcess, false);
    assert.equal(envCheck.hasMainPlugins, false);
    assert.equal(envCheck.hasBridge, true);
    assert.deepEqual(envCheck.state, { plugin: "dev.firefly.alpha", tag: "alpha-tag" });
    assert.equal(envCheck.csp, STRICT_PLUGIN_UI_CSP);
    assert.equal(envCheck.externalBlocked, true);

    // 2. Verify top-level navigation and window.open are blocked, and loading external URL / file: escape is rejected.
    await winA.webContents.executeJavaScript(\`
      window.__POPUP_RESULT__ = window.open("https://example.com/");
      try { window.location.assign("https://example.com/"); } catch {}
    \`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(winA.webContents.getURL(), "firefly-plugin-ui://dev.firefly.alpha/ui/panel.html");
    const popupResult = await winA.webContents.executeJavaScript("window.__POPUP_RESULT__");
    assert.equal(popupResult, null);

    // 3. Verify Plugin A window can message Plugin A ONLY, and cannot message Plugin B.
    const replyA = await winA.webContents.executeJavaScript(\`
      window.fireflyPlugin.invoke("ping", { from: "alpha-window" })
    \`);
    assert.equal(replyA.pluginId, "dev.firefly.alpha");
    assert.deepEqual(replyA.event, {
      from: { kind: "window", id: "panel" },
      method: "ping",
      params: { from: "alpha-window" },
    });

    // Cross-plugin spoofing attempt rejected and Beta receives 0 messages.
    await assert.rejects(
      () => controller.uiService.handleWindowInvoke(winA.webContents.id, { method: "ping", pluginId: "dev.firefly.beta" }),
      { code: "ERR_PERMISSION" },
    );
    const betaStats = JSON.parse(await statsB.execute({}));
    assert.equal(betaStats.count, 0);
    const alphaStats = JSON.parse(await statsA.execute({}));
    assert.equal(alphaStats.count, 1);

    // Plugin A post delivers ONLY to Win A, not Win B.
    await postA.execute({ text: "only-alpha" });
    await new Promise((r) => setTimeout(r, 80));
    const msgsA = await winA.webContents.executeJavaScript("window.__RECEIVED_MESSAGES__");
    const msgsB = await winB.webContents.executeJavaScript("window.__RECEIVED_MESSAGES__");
    assert.deepEqual(msgsA, [{ fromPlugin: "dev.firefly.alpha", text: "only-alpha" }]);
    assert.deepEqual(msgsB, []);

    // Verify programmatic loadURL to external URL or file: escape is rejected cleanly.
    await assert.rejects(() => winA.webContents.loadURL("https://example.com/"), /ERR_BLOCKED_BY_CLIENT/);
    await assert.rejects(() => winA.webContents.loadURL("file:///C:/Windows/win.ini"), /ERR_BLOCKED_BY_CLIENT/);
    const bodyAfterBlockedLoad = await winA.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
    assert.equal(bodyAfterBlockedLoad.includes("[fonts]"), false);

    // 4. Verify plugin deactivation closes all its windows while sibling remains open.
    await controller.disablePlugin("dev.firefly.alpha");
    assert.equal(winA.isDestroyed(), true);
    assert.deepEqual(controller.listOpenWindows("dev.firefly.alpha"), []);
    assert.equal(winB.isDestroyed(), false);
    assert.deepEqual(controller.listOpenWindows("dev.firefly.beta"), ["panel"]);

    // 5. Re-enable Alpha, open window, and verify uninstall closes all windows too.
    await controller.enablePlugin("dev.firefly.alpha", {
      grantedPermissions: ["ui.windows", "tool:open_ui", "tool:post_ui", "tool:stats"],
    });
    await openA.execute({ tag: "reopened" });
    assert.deepEqual(controller.listOpenWindows("dev.firefly.alpha"), ["panel"]);
    await controller.uninstallPlugin("dev.firefly.alpha");
    assert.deepEqual(controller.listOpenWindows("dev.firefly.alpha"), []);

    // Stop remaining Beta on quit.
    await controller.stopAll("quit");
    assert.equal(winB.isDestroyed(), true);
    assert.deepEqual(controller.listOpenWindows("dev.firefly.beta"), []);

    console.log("ELECTRON_PLUGIN_WINDOWS_E2E_OK");
  } finally {
    await controller.stopAll("quit");
    controller.dispose();
  }
}).then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });
`;

      buildSync({
        stdin: { contents: runnerSource, resolveDir: process.cwd() },
        outfile: runner,
        platform: "node",
        bundle: true,
        external: ["electron"],
        format: "cjs",
      });

      const env = { ...process.env };
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electron!, [runner], {
        env,
        timeout: 30_000,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(
        { status: result.status, error: result.error?.message },
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toEqual({ status: 0, error: undefined });
      expect(result.stdout).toContain("ELECTRON_PLUGIN_WINDOWS_E2E_OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  35_000,
);
