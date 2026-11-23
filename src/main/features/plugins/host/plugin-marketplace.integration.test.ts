import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packPackage } from "../../../../plugins/v2/package/pack";
import { PluginHostManager, type HostChild, type HostDependencies, type HostPort } from "../../../../plugins/v2/host";
import { HOST_TO_PLUGIN_METHODS, type Frame } from "../../../../shared/plugin-protocol";
import { createPluginV2HostController } from "./plugin-v2-services";
import { createPluginMarketplaceService } from "./plugin-marketplace";

const registryUrl = "https://raw.githubusercontent.com/test/plugins/main/registry.json";
const prefix = "https://github.com/test/plugins/releases/download/";

let root: string;
let dataRoot: string;
let controller: ReturnType<typeof createPluginV2HostController>;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function createMemoryPortPair(): { port1: HostPort; port2: HostPort } {
  const mk = (): HostPort & { peer?: ReturnType<typeof mk>; emitter: EventEmitter; started: boolean; queue: unknown[] } => {
    const emitter = new EventEmitter();
    const self = {
      emitter,
      started: false,
      queue: [] as unknown[],
      peer: undefined as any,
      postMessage(frame: Frame) {
        if (!self.peer) return;
        queueMicrotask(() => {
          if (self.peer.started) self.peer.emitter.emit("message", { data: frame });
          else self.peer.queue.push(frame);
        });
      },
      on(event: "message", listener: (event: { data: unknown }) => void) { emitter.on(event, listener); },
      removeListener(event: "message", listener: (event: { data: unknown }) => void) { emitter.removeListener(event, listener); },
      start() {
        self.started = true;
        for (const item of self.queue.splice(0)) emitter.emit("message", { data: item });
      },
      close() { self.peer = undefined; },
    };
    return self;
  };
  const port1 = mk();
  const port2 = mk();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

async function packV2Plugin(version: string, id = "dev.firefly.text-stats", name = "文本统计"): Promise<Uint8Array> {
  const src = path.join(root, `src-${id}-${version}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, "firefly.plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name,
    version,
    sdk: "^1.2.0",
    description: "Offline text stats",
    author: { name: "Firefly-0423" },
    license: "MIT",
    main: "index.cjs",
    native: false,
    permissions: [],
    tools: [{ name: "count", title: "文本统计", risk: ["fs-read"], modes: ["work", "code"] }],
  }));
  writeFileSync(path.join(src, "index.cjs"), "module.exports = { activate() {} };\n");
  const out = path.join(root, `${id}-${version}.ffplugin`);
  const packed = await packPackage(src, out, { hostVersion: "1.2.0" });
  expect(packed.ok).toBe(true);
  return new Uint8Array(readFileSync(out));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "firefly-market-v2-loop-"));
  dataRoot = path.join(root, "Firefly-1.2.0");
  mkdirSync(dataRoot, { recursive: true });

  const createHostManager = (deps: HostDependencies) =>
    new PluginHostManager({
      ...deps,
      fork: () => {
        const child = new EventEmitter() as HostChild & { postMessage(m: unknown, p: HostPort[]): void; kill(): boolean };
        child.postMessage = (_msg, ports) => {
          const port = ports[0];
          port.on("message", ({ data }) => {
            const frame = data as Frame;
            if (frame.type !== "req") return;
            if (frame.method === HOST_TO_PLUGIN_METHODS.activate || frame.method === HOST_TO_PLUGIN_METHODS.deactivate) {
              port.postMessage({ type: "res", id: frame.id, ok: true, value: null });
            }
          });
          port.start();
        };
        child.kill = () => {
          queueMicrotask(() => child.emit("exit", 0));
          return true;
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      createChannel: createMemoryPortPair,
      getAppMetrics: () => [],
    });

  controller = createPluginV2HostController({
    dataRoot,
    stateFile: path.join(dataRoot, "plugin-state.json"),
    scheduleStateFile: path.join(dataRoot, "plugin-schedules.json"),
    schedulerStore: {
      listTasksByOwner: () => [],
      createTask: vi.fn() as never,
      updateTask: vi.fn() as never,
      deleteTask: vi.fn(() => true),
      deleteTasksByOwner: vi.fn(() => 0),
    },
    llmClient: { chatNonStream: vi.fn() as never },
    buildRunOptions: vi.fn() as never,
    loadModelSettings: () => ({} as never),
    loadGeneralSettings: () => ({}),
    listSessions: () => [],
    getSession: () => null,
    getActiveChatTarget: () => null,
    confirmFirstUse: async () => true,
    createHostManager,
  });
});

afterEach(async () => {
  await controller?.stopAll("quit");
  controller?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});

function onlineMarket(bytes: Uint8Array, version: string, extra: Record<string, unknown> = {}) {
  const pkgUrl = `${prefix}dev.firefly.text-stats-${version}/dev.firefly.text-stats-${version}.ffplugin`;
  const entry = {
    id: "dev.firefly.text-stats",
    name: "文本统计",
    version,
    sdk: "^1.2.0",
    description: "Offline text stats",
    author: "Firefly-0423",
    license: "MIT",
    native: false,
    permissions: [],
    tools: [{ name: "count", title: "文本统计", risk: ["fs-read"], modes: ["work", "code"] }],
    capabilities: ["Count Unicode characters"],
    package: pkgUrl,
    sha256: sha(bytes),
    ...extra,
  };
  return createPluginMarketplaceService({
    registryUrls: [registryUrl],
    zipUrlPrefixes: [prefix],
    cacheDir: path.join(root, "cache"),
    installPackage: (file, opts) => controller.importFromPath(file, opts),
    fetchImpl: async (url) => url === registryUrl
      ? new Response(JSON.stringify({ apiVersion: 2, plugins: [entry] }))
      : new Response(bytes),
  });
}

describe("real v2 marketplace / importer / lifecycle loop", () => {
  it("installs disabled from apiVersion 2 registry, enables, updates retaining plugin-data, then uninstalls", async () => {
    const v1Bytes = await packV2Plugin("2.0.0");
    const marketV1 = onlineMarket(v1Bytes, "2.0.0");
    expect(await marketV1.listMarket()).toMatchObject({ ok: true, mode: "online" });
    expect(await marketV1.installFromMarket("dev.firefly.text-stats")).toMatchObject({
      ok: true,
      installation: "committed",
      activation: "not-requested",
    });

    expect(controller.listPlugins()[0]).toMatchObject({
      id: "dev.firefly.text-stats",
      version: "2.0.0",
      origin: "market",
      status: "disabled",
      enabled: false,
    });

    await controller.enablePlugin("dev.firefly.text-stats");
    expect(controller.status("dev.firefly.text-stats")).toBe("enabled");

    const pluginDataDir = path.join(dataRoot, "plugin-data", "dev.firefly.text-stats");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "keep.txt"), "private preferences");

    const v2Bytes = await packV2Plugin("2.1.0");
    const marketV2 = onlineMarket(v2Bytes, "2.1.0");
    await marketV2.listMarket();
    expect(await marketV2.installFromMarket("dev.firefly.text-stats")).toMatchObject({
      ok: true,
      installation: "committed",
      activation: "running",
      plugin: { version: "2.1.0" },
    });

    expect(controller.listPlugins()[0]).toMatchObject({
      version: "2.1.0",
      status: "enabled",
      origin: "market",
    });
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.text-stats", "2.0.0"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.text-stats", "2.1.0"))).toBe(true);
    expect(readFileSync(path.join(pluginDataDir, "keep.txt"), "utf8")).toBe("private preferences");

    await controller.uninstallPlugin("dev.firefly.text-stats", { deleteSecrets: false, deleteData: false });
    expect(controller.listPlugins()).toEqual([]);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.text-stats"))).toBe(false);
    expect(readFileSync(path.join(pluginDataDir, "keep.txt"), "utf8")).toBe("private preferences");
    expect(readdirSync(path.join(root, "cache"))).toEqual([]);
  });

  it("rejects tampered package or identity mismatch without modifying installed plugin", async () => {
    const v1Bytes = await packV2Plugin("2.0.0");
    const marketV1 = onlineMarket(v1Bytes, "2.0.0");
    await marketV1.listMarket();
    await marketV1.installFromMarket("dev.firefly.text-stats");

    const wrongIdBytes = await packV2Plugin("2.1.0", "dev.firefly.other");
    const tampered = onlineMarket(wrongIdBytes, "2.1.0");
    await tampered.listMarket();
    expect(await tampered.installFromMarket("dev.firefly.text-stats")).toMatchObject({
      ok: false,
      installation: "rejected",
      error: expect.stringContaining("身份不匹配"),
    });
    expect(controller.listPlugins()[0].version).toBe("2.0.0");
  });
});
