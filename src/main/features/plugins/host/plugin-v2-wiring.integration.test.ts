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
  "wires a real v2 plugin through PluginV2HostController end-to-end",
  () => {
    expect(
      existsSync(compiledRuntimeEntry),
      "Compiled runtime missing at dist/main/plugins/v2/runtime/main.js; run pnpm run build:main first",
    ).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), "firefly-plugin-wiring-e2e-"));
    try {
      const pluginId = "dev.firefly.e2e";
      const pluginDir = join(directory, "plugins", pluginId, "1.0.0");
      const dataRoot = join(directory, "data");
      const pluginEntry = join(pluginDir, "index.mjs");
      const runner = join(directory, "runner.cjs");
      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(dataRoot, { recursive: true });

      writeFileSync(
        pluginEntry,
        `export default {
  activate(ctx) {
    ctx.context.register({
      id: "e2e-ctx",
      modes: ["work"],
      sources: ["user"],
      async provide() {
        return { heading: "E2E Context", content: "Note from e2e plugin" };
      },
    });
    ctx.tools.register({
      name: "sync",
      description: "Sync target with progress",
      risks: ["network"],
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      describeApproval(args) {
        return { summary: "Sync workspace", target: String(args.target ?? "") };
      },
      async execute(args, call) {
        call.progress("Syncing chunk", 75);
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: "succeeded", output: { synced: args.target } };
      },
    });
    ctx.tools.register({
      name: "read_sessions",
      description: "List sessions",
      risks: ["network"],
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const page = await ctx.sessions.list();
          return { status: "succeeded", output: page };
        } catch (err) {
          return { status: "failed", error: String(err && err.code ? err.code : err) };
        }
      },
    });
    ctx.tools.register({
      name: "borrow_model",
      description: "Borrow host model",
      risks: ["network"],
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const out = await ctx.model.generate({ prompt: "hello" });
          return { status: "succeeded", output: out };
        } catch (err) {
          return { status: "failed", error: String(err && err.code ? err.code : err) };
        }
      },
    });
  },
};
`,
        "utf8",
      );

      const source = `
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { app } = require("electron");
const { ToolRegistry } = require("./src/main/tooling/registry/tool-registry.ts");
const { pluginToolId } = require("./src/plugins/v2/tools/tool-service.ts");
const { createPluginV2HostController } = require("./src/main/features/plugins/host/plugin-v2-services.ts");

app.setPath("userData", ${JSON.stringify(dataRoot)});
app.whenReady().then(async () => {
  const progressEvents = [];
  const confirmCalls = [];
  const borrowingSnapshots = [];
  let holdModelResolve;
  let modelAborted = false;

  const toolRegistry = new ToolRegistry();
  const controller = createPluginV2HostController({
    dataRoot: ${JSON.stringify(dataRoot)},
    stateFile: join(${JSON.stringify(dataRoot)}, "plugin-state.json"),
    scheduleStateFile: join(${JSON.stringify(dataRoot)}, "plugin-schedules.json"),
    runtimeEntry: ${JSON.stringify(compiledRuntimeEntry)},
    toolRegistry,
    schedulerStore: {
      listTasksByOwner: () => [],
      getTask: () => null,
      createTask: () => { throw new Error("unused"); },
      updateTask: () => null,
      deleteTask: () => false,
      getHistory: () => [],
    },
    llmClient: {
      chatNonStream(_settings, _messages, _tools, _timeout, _tag, _stream, _opts, signal) {
        return new Promise((resolve, reject) => {
          holdModelResolve = resolve;
          signal?.addEventListener("abort", () => {
            modelAborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      },
    },
    buildRunOptions: async () => { throw new Error("unused"); },
    loadModelSettings: () => ({
      mode: "auto",
      schemaVersion: 2,
      provider: "OpenAI",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-test",
      apiKey: "sk-secret-value-1234",
      perProvider: {},
      modelProfiles: [],
      agentModelProfiles: {},
      specialistModelProfiles: {},
      stickerEnabled: false,
      stickerSize: "standard",
      stickerSimilarityThreshold: 0.55,
      chatRequestTimeoutSec: 60,
      rerankerMode: "standard",
      embeddingModel: "bgem3",
      multimodal: false,
      contextWindowTokens: 128000,
    }),
    loadGeneralSettings: () => ({}),
    protectedRoots: [${JSON.stringify(dataRoot)}],
    listSessions: () => [{
      id: "sess-1",
      mode: "work",
      title: "Secret sk-secret-value-1234 session",
      createdAt: 1000,
      updatedAt: 2000,
      workspaceRoot: "C:/work/demo",
    }],
    getSession: () => ({
      id: "sess-1",
      mode: "work",
      title: "Session",
      createdAt: 1000,
      updatedAt: 2000,
      messages: [],
      workspaceBinding: { workspaceRoot: "C:/work/demo", displayName: "demo", boundAt: 1000 },
    }),
    getActiveChatTarget: () => ({ sessionId: "sess-1", mode: "work" }),
    confirmFirstUse: async (req) => {
      confirmCalls.push({ pluginId: req.pluginId, permission: req.permission });
      return true;
    },
    onBorrowingChanged: (entries) => {
      borrowingSnapshots.push(entries);
    },
    onToolProgress: (progress) => {
      progressEvents.push(progress);
    },
  });

  try {
    controller.installPlugin({
      schemaVersion: 1,
      sdk: "^1.2.0",
      id: ${JSON.stringify(pluginId)},
      name: "E2E Plugin",
      version: "1.0.0",
      main: "index.mjs",
      tools: [
        { name: "sync", title: "Sync", risk: ["network"], modes: ["work"] },
        { name: "read_sessions", title: "Read Sessions", risk: ["network"], modes: ["work"] },
        { name: "borrow_model", title: "Borrow Model", risk: ["network"], modes: ["work"] },
      ],
      context: [
        { id: "e2e-ctx", title: "E2E Context", modes: ["work"], sources: ["user"] },
      ],
      permissions: ["sessions.read", "model.generate"],
    }, ${JSON.stringify(pluginDir)});

    // Disabled plugins must NOT start at app startup.
    await controller.startEnabled();
    assert.equal(controller.status(${JSON.stringify(pluginId)}), "disabled");

    await controller.enablePlugin(${JSON.stringify(pluginId)}, {
      grantedPermissions: ["tool:sync", "tool:read_sessions", "tool:borrow_model", "sessions.read", "model.generate"],
    });
    assert.equal(controller.status(${JSON.stringify(pluginId)}), "enabled");

    const syncTool = toolRegistry.getById(pluginToolId(${JSON.stringify(pluginId)}, "sync"));
    assert.ok(syncTool, "sync tool must be registered");
    assert.deepEqual(await syncTool.describeApproval({ target: "repo-a" }), {
      summary: "Sync workspace",
      target: "repo-a",
    });

    const syncOut = await syncTool.execute(
      { target: "repo-a" },
      { userQuery: "sync", toolCallId: "call-sync-1", conversationId: "sess-1", runId: "run-1", caller: "firefly" },
    );
    assert.equal(JSON.parse(syncOut).synced, "repo-a");
    assert.equal(progressEvents.length, 1);
    assert.deepEqual(progressEvents[0], {
      pluginId: ${JSON.stringify(pluginId)},
      callId: "call-sync-1",
      message: "Syncing chunk",
      percent: 75,
      runId: "run-1",
      sessionId: "sess-1",
    });

    const turnCtx = await controller.collectTurnPluginContext({
      source: "user",
      mode: "work",
      sessionId: "sess-1",
    });
    assert.ok(turnCtx.includes("Note from e2e plugin"), "turn plugin context should include plugin text");

    const readSessionsTool = toolRegistry.getById(pluginToolId(${JSON.stringify(pluginId)}, "read_sessions"));
    assert.ok(readSessionsTool);
    const sessionsOut = JSON.parse(await readSessionsTool.execute({}));
    assert.equal(sessionsOut.items[0].id, "sess-1");
    assert.ok(!sessionsOut.items[0].title.includes("sk-secret-value-1234"), "secret must be redacted");
    assert.equal(confirmCalls.length, 1);
    assert.equal(confirmCalls[0].permission, "sessions.read");

    // Second call within same revision must NOT re-confirm.
    await readSessionsTool.execute({});
    assert.equal(confirmCalls.length, 1);

    // Model borrowing banner & stop button abort active plugin model call.
    const borrowTool = toolRegistry.getById(pluginToolId(${JSON.stringify(pluginId)}, "borrow_model"));
    assert.ok(borrowTool);
    const borrowPromise = borrowTool.execute({});
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(controller.getBorrowingEntries().length >= 1, "borrowing entry should be active");
    assert.equal(controller.stopBorrowing({ pluginId: ${JSON.stringify(pluginId)} }), 1);
    await assert.rejects(borrowPromise, /ERR_CANCELLED/);
    assert.equal(modelAborted, true);
    assert.equal(controller.getBorrowingEntries().length, 0);

    // Revoke sessions.read -> subsequent call rejected with ERR_PERMISSION.
    controller.stateStore.revokePermission(${JSON.stringify(pluginId)}, "sessions.read");
    await assert.rejects(readSessionsTool.execute({}), /ERR_PERMISSION/);

    // Revoke tools -> subsequent tool call rejected with ERR_PERMISSION.
    controller.stateStore.revokePermission(${JSON.stringify(pluginId)}, "tools");
    await assert.rejects(syncTool.execute({ target: "repo-b" }), /ERR_PERMISSION/);

    await controller.disablePlugin(${JSON.stringify(pluginId)});
    assert.equal(controller.status(${JSON.stringify(pluginId)}), "disabled");
    await controller.stopAll("quit");
    controller.dispose();
    console.log("WIRING_E2E_OK");
  } finally {
    await controller.stopAll("quit");
    controller.dispose();
  }
}).then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });
`;

      buildSync({
        stdin: { contents: source, resolveDir: process.cwd() },
        outfile: runner,
        platform: "node",
        bundle: true,
        external: ["electron"],
        format: "cjs",
      });

      const env = { ...process.env };
      delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
      const result = spawnSync(electron!, [runner], { env, timeout: 30_000, encoding: "utf8", windowsHide: true });
      expect(
        { status: result.status, error: result.error?.message },
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toEqual({ status: 0, error: undefined });
      expect(result.stdout).toContain("WIRING_E2E_OK");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  35_000,
);
