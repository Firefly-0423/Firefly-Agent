import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginHostManager, type HostChild, type HostDependencies, type HostPort } from "../../../../plugins/v2/host";
import { HOST_TO_PLUGIN_METHODS, type Frame } from "../../../../shared/plugin-protocol";
import { createPluginV2HostController } from "./plugin-v2-services";
import { createPluginMarketplaceService, MARKET_REGISTRY_URLS, MARKET_V2_REPOSITORY_ROOT } from "./plugin-marketplace";

// The real catalog builder (scripts/plugin-marketplace/build.mjs) feeds the real marketplace service and importer.
interface BuiltCatalog {
  outDir: string;
  registryPath: string;
  configPath?: string;
  plugins: Array<{ id: string; version: string; packagePath: string; sha256: string; package: string }>;
}
type Build = (options: Record<string, unknown>) => Promise<BuiltCatalog>;

const builderUrl = pathToFileURL(path.resolve(__dirname, "../../../../../scripts/plugin-marketplace/build.mjs")).href;
const onlineRegistry = "https://raw.githubusercontent.com/test/plugins/main/marketplace/registry.json";
const CATALOG_IDS = [
  "dev.firefly.text-stats",
  "dev.firefly.json-tools",
  "dev.firefly.timezone-tools",
  "dev.firefly.code-language",
  "dev.firefly.text-trim",
];

let root: string;
let dataRoot: string;
let controller: ReturnType<typeof createPluginV2HostController>;

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

async function buildCatalog(options: Record<string, unknown>): Promise<BuiltCatalog> {
  const { buildMarketplace } = (await import(/* @vite-ignore */ builderUrl)) as { buildMarketplace: Build };
  return buildMarketplace(options);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "firefly-market-builder-"));
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

describe("plugin catalog builder output against the real marketplace service", () => {
  it("imports the v2 repository package through the real installer as disabled", async () => {
    const built = await buildCatalog({ outDir: path.join(root, "repository") });
    const selected = built.plugins.find(plugin => plugin.id === "dev.firefly.text-stats")!;
    const catalog = JSON.parse(readFileSync(built.registryPath, "utf8"));
    const entry = catalog.plugins.find((plugin: { id: string }) => plugin.id === selected.id);
    const url = new URL("packages/" + path.basename(selected.packagePath), MARKET_V2_REPOSITORY_ROOT).href;
    const fetchImpl = vi.fn(async (input: string) => {
      if (input === MARKET_REGISTRY_URLS[0]) return Response.json({ apiVersion: 2, plugins: [{ ...entry, package: url }] });
      if (input === url) return new Response(readFileSync(selected.packagePath));
      return new Response(null, { status: 404 });
    });
    const market = createPluginMarketplaceService({
      registryUrls: MARKET_REGISTRY_URLS,
      zipUrlPrefixes: [],
      cacheDir: path.join(root, "cache"),
      installPackage: (file, opts) => controller.importFromPath(file, opts),
      fetchImpl,
    });
    expect(await market.listMarket()).toMatchObject({ ok: true, mode: "online", plugins: [{ id: selected.id, source: "remote" }] });
    expect(await market.installFromMarket(selected.id)).toMatchObject({ ok: true, installation: "committed", activation: "not-requested" });
    expect(controller.listPlugins()).toMatchObject([{ id: selected.id, origin: "market", enabled: false, status: "disabled" }]);
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([MARKET_REGISTRY_URLS[0], url]);
  });

  it("lists every built plugin from the bundled catalog and installs one disabled through the importer", async () => {
    const built = await buildCatalog({ outDir: path.join(root, "bundled") });
    const market = createPluginMarketplaceService({
      registryUrls: [],
      zipUrlPrefixes: [],
      bundledDir: built.outDir,
      cacheDir: path.join(root, "cache"),
      installPackage: (file, opts) => controller.importFromPath(file, opts),
    });

    const listed = await market.listMarket();
    expect(listed).toMatchObject({ ok: true, mode: "bundled" });
    expect(listed.plugins.map((plugin) => plugin.id).sort()).toEqual([...CATALOG_IDS].sort());
    expect(listed.plugins.every((plugin) => plugin.compatible === true && plugin.native === false)).toBe(true);

    expect(await market.installFromMarket("dev.firefly.json-tools")).toMatchObject({
      ok: true,
      installation: "committed",
      activation: "not-requested",
    });
    expect(controller.listPlugins()).toMatchObject([{
      id: "dev.firefly.json-tools",
      version: "1.0.1",
      origin: "market",
      status: "disabled",
      enabled: false,
    }]);
  });

  it("falls back to the built bundled catalog when the online registry cannot be fetched, and still installs", async () => {
    const built = await buildCatalog({ outDir: path.join(root, "bundled") });
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const market = createPluginMarketplaceService({
      registryUrls: [onlineRegistry],
      zipUrlPrefixes: ["https://github.com/test/plugins/releases/download/"],
      bundledDir: built.outDir,
      cacheDir: path.join(root, "cache"),
      installPackage: (file, opts) => controller.importFromPath(file, opts),
      fetchImpl,
    });

    const listed = await market.listMarket();
    expect(fetchImpl).toHaveBeenCalledWith(onlineRegistry, expect.anything());
    expect(listed).toMatchObject({
      ok: true,
      mode: "offline-fallback",
      sources: [{ url: onlineRegistry, ok: false, used: false }, { url: "bundled:registry", ok: true, used: true }],
    });
    expect(listed.plugins).toHaveLength(CATALOG_IDS.length);
    expect(await market.installFromMarket("dev.firefly.text-stats")).toMatchObject({ ok: true, installation: "committed" });
    expect(controller.listPlugins().map((plugin) => plugin.id)).toEqual(["dev.firefly.text-stats"]);
  });

  it("serves a public-mode build online: package URLs sit under the generated prefix and install after the SHA-256 check", async () => {
    const built = await buildCatalog({
      outDir: path.join(root, "public"),
      repository: "test/plugins",
      registryRef: "main",
    });
    const config = JSON.parse(readFileSync(built.configPath as string, "utf8")) as { registryUrls: string[]; zipUrlPrefixes: string[] };
    const byUrl = new Map(built.plugins.map((plugin) => [plugin.package, plugin.packagePath]));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === config.registryUrls[0]) return new Response(readFileSync(built.registryPath));
      const file = byUrl.get(url);
      return file ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
    });
    const market = createPluginMarketplaceService({
      registryUrls: config.registryUrls,
      zipUrlPrefixes: config.zipUrlPrefixes,
      cacheDir: path.join(root, "cache"),
      installPackage: (file, opts) => controller.importFromPath(file, opts),
      fetchImpl,
    });

    const listed = await market.listMarket();
    expect(listed).toMatchObject({ ok: true, mode: "online" });
    expect(listed.plugins).toHaveLength(CATALOG_IDS.length);
    expect(await market.installFromMarket("dev.firefly.text-trim")).toMatchObject({ ok: true, installation: "committed" });
    expect(controller.listPlugins()).toMatchObject([{ id: "dev.firefly.text-trim", origin: "market", enabled: false }]);
  });
});
