import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packPackage } from "../../../../plugins/v2/package/pack";
import { PluginHostManager, type HostChild, type HostDependencies, type HostPort } from "../../../../plugins/v2/host";
import { HOST_TO_PLUGIN_METHODS, type Frame } from "../../../../shared/plugin-protocol";
import { createPluginV2HostController } from "./plugin-v2-services";
import { createPluginMarketplaceService } from "./plugin-marketplace";

const REGISTRY = "https://raw.githubusercontent.com/test/catalog/main/registry.json";
const PREFIX = "https://github.com/test/catalog/releases/download/";
const PLUGIN_ID = "dev.firefly.fixture";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

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

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-market-versions-v2-"));
  const dataRoot = path.join(root, "Firefly-1.2.0");
  mkdirSync(dataRoot, { recursive: true });
  const failingVersions = new Set<string>();

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
            if (frame.method === HOST_TO_PLUGIN_METHODS.activate) {
              const { version } = frame.params as { version: string };
              if (failingVersions.has(version)) {
                port.postMessage({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: { code: "ERR_INTERNAL", message: `version ${version} activation failed`, retryable: false },
                });
              } else {
                port.postMessage({ type: "res", id: frame.id, ok: true, value: null });
              }
            } else if (frame.method === HOST_TO_PLUGIN_METHODS.deactivate) {
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

  const controller = createPluginV2HostController({
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

  cleanup.push(async () => {
    await controller.stopAll("quit");
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const makePackage = async (version: string): Promise<Uint8Array> => {
    const src = path.join(root, `pkg-${version}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "firefly.plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Fixture",
      version,
      sdk: "^1.2.0",
      description: "Synthetic fixture",
      author: { name: "test" },
      license: "MIT",
      main: "index.cjs",
      native: false,
      permissions: ["secrets"],
      tools: [{ name: "ping", title: "Ping", risk: ["fs-read"], modes: ["work"] }],
    }));
    writeFileSync(path.join(src, "index.cjs"), "module.exports = { activate() {} };\n");
    const out = path.join(root, `${PLUGIN_ID}-${version}.ffplugin`);
    const packed = await packPackage(src, out, { hostVersion: "1.2.0" });
    expect(packed.ok).toBe(true);
    return new Uint8Array(readFileSync(out));
  };

  const onlineMarket = async (version: string, opts: { failActivation?: boolean; tamper?: boolean } = {}) => {
    if (opts.failActivation) failingVersions.add(version);
    const bytes = await makePackage(version);
    const pkgUrl = `${PREFIX}${PLUGIN_ID}-${version}/${PLUGIN_ID}-${version}.ffplugin`;
    const payload = opts.tamper ? Buffer.from("tampered") : bytes;
    const market = createPluginMarketplaceService({
      registryUrls: [REGISTRY],
      zipUrlPrefixes: [PREFIX],
      cacheDir: path.join(root, "cache"),
      installPackage: (file, importOpts) => controller.importFromPath(file, importOpts),
      fetchImpl: async (url) => {
        if (url === REGISTRY) {
          return new Response(JSON.stringify({
            apiVersion: 2,
            plugins: [{
              id: PLUGIN_ID,
              name: "Fixture",
              version,
              sdk: "^1.2.0",
              description: "Synthetic fixture",
              author: "test",
              native: false,
              permissions: ["secrets"],
              tools: [{ name: "ping", title: "Ping", risk: ["fs-read"], modes: ["work"] }],
              package: pkgUrl,
              sha256: sha(bytes),
            }],
          }));
        }
        if (url === pkgUrl) return new Response(new Uint8Array(payload));
        throw new Error("Unexpected request");
      },
    });
    await market.listMarket();
    return market;
  };

  return { root, dataRoot, controller, makePackage, onlineMarket };
}

describe("marketplace version upgrade and rollback integration (v2)", () => {
  it("rolls back to v1.0.0 and re-enables it when market v2.0.0 fails activation", async () => {
    const f = await setup();
    const v1Market = await f.onlineMarket("1.0.0");
    expect(await v1Market.installFromMarket(PLUGIN_ID)).toMatchObject({ ok: true });
    await f.controller.enablePlugin(PLUGIN_ID);
    expect(f.controller.status(PLUGIN_ID)).toBe("enabled");

    const dataDir = path.join(f.dataRoot, "plugin-data", PLUGIN_ID);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "keep.txt"), "private");

    const v2Market = await f.onlineMarket("2.0.0", { failActivation: true });
    const upgrade = await v2Market.installFromMarket(PLUGIN_ID);
    expect(upgrade).toMatchObject({ ok: false, installation: "rejected", activation: "rolled-back" });
    expect(f.controller.status(PLUGIN_ID)).toBe("enabled");
    expect(f.controller.stateStore.get(PLUGIN_ID)?.version).toBe("1.0.0");
    expect(existsSync(path.join(f.dataRoot, "plugins", PLUGIN_ID, "1.0.0"))).toBe(true);
    expect(existsSync(path.join(f.dataRoot, "plugins", PLUGIN_ID, "2.0.0"))).toBe(false);
    expect(readFileSync(path.join(dataDir, "keep.txt"), "utf8")).toBe("private");
  });

  it("refuses tampered market package before modifying installed plugin state", async () => {
    const f = await setup();
    const v1Market = await f.onlineMarket("1.0.0");
    await v1Market.installFromMarket(PLUGIN_ID);
    const v2Tampered = await f.onlineMarket("2.0.0", { tamper: true });
    expect(await v2Tampered.installFromMarket(PLUGIN_ID)).toMatchObject({
      ok: false,
      error: expect.stringContaining("SHA-256"),
    });
    expect(f.controller.stateStore.get(PLUGIN_ID)?.version).toBe("1.0.0");
  });
});
