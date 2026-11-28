import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
let electron: string | undefined;
try { electron = require("electron") as string; } catch { /* Electron binary is optional on test-only machines. */ }
const compiledRuntimeEntry = resolve(process.cwd(), "dist/main/plugins/v2/runtime/main.js");

it.skipIf(!electron || !existsSync(electron))(
  "real Electron utilityProcess with compiled plugin runtime (skipped when Electron binary is unavailable)",
  () => {
    expect(
      existsSync(compiledRuntimeEntry),
      "Compiled runtime missing at dist/main/plugins/v2/runtime/main.js; run pnpm run build:main first",
    ).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), "firefly-plugin-host-"));
    try {
      const pluginEntry = join(directory, "plugin.mjs");
      const runner = join(directory, "runner.cjs");
      const dataDir = join(directory, "data");
      mkdirSync(dataDir);
      writeFileSync(
        pluginEntry,
        `let cancelledObserved = false;
export default {
  activate(ctx) {
    ctx.tools.register({
      name: "probe",
      description: "Probe child-process environment and context",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          status: "succeeded",
          output: {
            cwd: process.cwd(),
            secret: process.env.FIREFLY_TEST_SECRET ?? null,
            version: ctx.version,
            hasSecrets: ctx.has("secrets"),
            hasSchedules: ctx.has("schedules"),
          },
        };
      },
    });
    ctx.tools.register({
      name: "wait",
      description: "Wait for abort signal",
      parameters: { type: "object", properties: {} },
      async execute(_args, call) {
        await new Promise((resolvePromise) => {
          if (call.signal.aborted) {
            cancelledObserved = true;
            resolvePromise();
            return;
          }
          call.signal.addEventListener("abort", () => {
            cancelledObserved = true;
            resolvePromise();
          }, { once: true });
        });
        return { status: "not_executed", reason: "cancelled" };
      },
    });
    ctx.tools.register({
      name: "cancel_observed",
      description: "Report whether wait observed cancellation",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { status: "succeeded", output: cancelledObserved };
      },
    });
    ctx.tools.register({
      name: "crash",
      description: "Simulate process crash during tool execution",
      parameters: { type: "object", properties: {} },
      async execute() {
        process.exit(23);
      },
    });
  },
};
`,
        "utf8",
      );
      const source = `
const assert = require("node:assert/strict");
const { app } = require("electron");
const { createElectronPluginHost } = require("./src/plugins/v2/host/index.ts");
const { HOST_TO_PLUGIN_METHODS, PLUGIN_TO_HOST_METHODS } = require("./src/shared/plugin-protocol.ts");

app.setPath("userData", ${JSON.stringify(dataDir)});
app.whenReady().then(async () => {
  const registeredTools = [];
  const host = createElectronPluginHost({
    resolvePlugin: () => ({
      entry: ${JSON.stringify(compiledRuntimeEntry)},
      main: ${JSON.stringify(pluginEntry)},
      version: "1.2.0",
      permissions: ["secrets"],
      dataDir: ${JSON.stringify(dataDir)},
    }),
    configureRpc: (_id, rpc) => {
      rpc.handle(PLUGIN_TO_HOST_METHODS.toolsRegister, (params) => {
        registeredTools.push(params);
        return null;
      });
    },
  });
  try {
    await host.start("dev.firefly.fixture");
    assert.equal(host.status("dev.firefly.fixture"), "enabled");
    assert.equal(registeredTools.length, 4);
    assert.deepEqual(
      await host.call("dev.firefly.fixture", HOST_TO_PLUGIN_METHODS.toolExecute, {
        name: "probe",
        args: {},
        callId: "c-probe",
        sessionId: "s-1",
        mode: "work",
        caller: "firefly",
      }),
      {
        status: "succeeded",
        output: {
          cwd: ${JSON.stringify(dataDir)},
          secret: null,
          version: "1.2.0",
          hasSecrets: true,
          hasSchedules: false,
        },
      },
    );
    const cancel = new AbortController();
    const requested = host.call(
      "dev.firefly.fixture",
      HOST_TO_PLUGIN_METHODS.toolExecute,
      {
        name: "wait",
        args: {},
        callId: "c-wait",
        sessionId: "s-1",
        mode: "work",
        caller: "firefly",
      },
      { signal: cancel.signal },
    );
    cancel.abort();
    await assert.rejects(requested, { code: "ERR_CANCELLED" });
    assert.deepEqual(
      await host.call("dev.firefly.fixture", HOST_TO_PLUGIN_METHODS.toolExecute, {
        name: "cancel_observed",
        args: {},
        callId: "c-cancel-check",
        sessionId: "s-1",
        mode: "work",
        caller: "firefly",
      }),
      { status: "succeeded", output: true },
    );
    assert.deepEqual(
      await host.call("dev.firefly.fixture", HOST_TO_PLUGIN_METHODS.toolExecute, {
        name: "crash",
        args: {},
        callId: "c-crash",
        sessionId: "s-1",
        mode: "work",
        caller: "firefly",
      }),
      { status: "unknown", reason: "Plugin process exited during tool execution" },
    );
    assert.equal(host.status("dev.firefly.fixture"), "restarting");
    console.log("UTILITY_PROCESS_OK");
  } finally {
    await host.stop("dev.firefly.fixture");
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
`;
      buildSync({
        stdin: { contents: source, resolveDir: process.cwd() },
        outfile: runner,
        platform: "node",
        bundle: true,
        external: ["electron"],
        format: "cjs",
      });
      const env = { ...process.env, FIREFLY_TEST_SECRET: "fixture-secret" };
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electron!, [runner], { env, timeout: 20_000, encoding: "utf8", windowsHide: true });
      expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
      expect(result.stdout).toContain("UTILITY_PROCESS_OK");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
