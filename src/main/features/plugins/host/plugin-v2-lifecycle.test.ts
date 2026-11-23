import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_TO_PLUGIN_METHODS, type Frame } from "../../../../shared/plugin-protocol";
import { resolvePluginSecretsFile } from "../../../../plugins/v2/secrets/paths";
import type { SafeStorageLike } from "../../../../plugins/v2/secrets";
import { createPluginV2HostController } from "./plugin-v2-services";
import type { HostChild, HostDependencies, HostPort } from "../../../../plugins/v2/host";
import { PluginHostManager } from "../../../../plugins/v2/host";

let root: string;
let dataRoot: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ff-v2-lifecycle-"));
  dataRoot = path.join(root, "Firefly-1.2.0");
  mkdirSync(dataRoot, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function createFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`, "utf8"),
    decryptString: (buf) => {
      const s = buf.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
      return s.slice(4);
    },
  };
}

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
        const deliver = () => {
          if (self.peer.started) self.peer.emitter.emit("message", { data: frame });
          else self.peer.queue.push(frame);
        };
        queueMicrotask(deliver);
      },
      on(event: "message", listener: (event: { data: unknown }) => void) {
        emitter.on(event, listener);
      },
      removeListener(event: "message", listener: (event: { data: unknown }) => void) {
        emitter.removeListener(event, listener);
      },
      start() {
        self.started = true;
        for (const item of self.queue.splice(0)) {
          emitter.emit("message", { data: item });
        }
      },
      close() {
        self.peer = undefined;
      },
    };
    return self;
  };
  const port1 = mk();
  const port2 = mk();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

interface FakeChildRecord {
  mainPath: string;
  version: string;
  stopReasons: string[];
  killCount: number;
}

function createFakeHostHarness(activateBehavior: (mainPath: string, version: string) => { ok: boolean; error?: string }) {
  const launched: FakeChildRecord[] = [];
  const createHostManager = (deps: HostDependencies) => {
    return new PluginHostManager({
      ...deps,
      fork: (_entry, _args, _opts) => {
        const child = new EventEmitter() as HostChild & {
          postMessage(message: unknown, ports: HostPort[]): void;
          kill(): boolean;
        };
        const record: FakeChildRecord = { mainPath: "", version: "", stopReasons: [], killCount: 0 };
        launched.push(record);
        let childPort: HostPort | undefined;
        child.postMessage = (_msg, ports) => {
          childPort = ports[0];
          childPort.on("message", ({ data }) => {
            const frame = data as Frame;
            if (frame.type !== "req") return;
            if (frame.method === HOST_TO_PLUGIN_METHODS.activate) {
              const params = frame.params as { main: string; version: string };
              record.mainPath = params.main;
              record.version = params.version;
              const verdict = activateBehavior(params.main, params.version);
              if (verdict.ok) {
                childPort?.postMessage({ type: "res", id: frame.id, ok: true, value: null });
              } else {
                childPort?.postMessage({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: { code: "ERR_INTERNAL", message: verdict.error ?? "activation failed", retryable: false },
                });
              }
            } else if (frame.method === HOST_TO_PLUGIN_METHODS.deactivate) {
              record.stopReasons.push(String(frame.params));
              childPort?.postMessage({ type: "res", id: frame.id, ok: true, value: null });
            }
          });
          childPort.start();
        };
        child.kill = () => {
          record.killCount += 1;
          queueMicrotask(() => child.emit("exit", 0));
          return true;
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      createChannel: createMemoryPortPair,
      getAppMetrics: () => [],
    });
  };
  return { launched, createHostManager };
}

function makeController(harness: ReturnType<typeof createFakeHostHarness>, deleteTasksSpy = vi.fn(() => 2)) {
  const controller = createPluginV2HostController({
    dataRoot,
    stateFile: path.join(dataRoot, "plugin-state.json"),
    scheduleStateFile: path.join(dataRoot, "plugin-schedules-state.json"),
    safeStorage: createFakeSafeStorage(),
    schedulerStore: {
      listTasksByOwner: () => [],
      createTask: vi.fn() as never,
      updateTask: vi.fn() as never,
      deleteTask: vi.fn(() => true),
      deleteTasksByOwner: deleteTasksSpy,
    },
    llmClient: { chatNonStream: vi.fn() as never },
    buildRunOptions: vi.fn() as never,
    loadModelSettings: () => ({} as never),
    loadGeneralSettings: () => ({}),
    listSessions: () => [],
    getSession: () => null,
    getActiveChatTarget: () => null,
    confirmFirstUse: async () => true,
    createHostManager: harness.createHostManager,
  });
  return { controller, deleteTasksSpy };
}

async function writeArchivePlugin(opts: {
  id: string;
  version: string;
  name?: string;
  permissions?: string[];
  ext?: ".ffplugin" | ".zip";
  mainCode?: string;
}) {
  const zip = new JSZip();
  zip.file("firefly.plugin.json", JSON.stringify({
    schemaVersion: 1,
    id: opts.id,
    name: opts.name ?? "Sample Plugin",
    version: opts.version,
    sdk: "^1.2.0",
    main: "index.mjs",
    permissions: opts.permissions ?? ["secrets", "schedules"],
    tools: [{ name: "ping", title: "Ping", risk: ["network"], modes: ["work"] }],
  }));
  zip.file("index.mjs", opts.mainCode ?? "export default { activate() {} };\n");
  const filePath = path.join(root, `${opts.id}-${opts.version}${opts.ext ?? ".ffplugin"}`);
  writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
  return filePath;
}

describe("Plugin V2 Lifecycle (Import, Upgrade Rollback, Uninstall, Permissions & Rate Limit)", () => {
  it("imports package as disabled, rejects invalid/0.x with zero files written", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);

    // Reject 0.x archive before writing anything
    const badZip = new JSZip();
    badZip.file("manifest.json", JSON.stringify({ apiVersion: 1, id: "old", name: "Old", version: "1.0.0", entry: "index.cjs" }));
    badZip.file("index.cjs", "module.exports={};");
    const badPath = path.join(root, "old.zip");
    writeFileSync(badPath, await badZip.generateAsync({ type: "nodebuffer" }));
    const badRes = await controller.importFromPath(badPath);
    expect(badRes.ok).toBe(false);
    expect(badRes.error).toContain("0.x");
    expect(existsSync(path.join(dataRoot, "plugins"))).toBe(false);
    expect(existsSync(controller.stateStore.filePath)).toBe(false);

    // Valid import starts disabled
    const goodPath = await writeArchivePlugin({ id: "dev.firefly.alpha", version: "1.0.0" });
    const goodRes = await controller.importFromPath(goodPath);
    expect(goodRes).toEqual({
      ok: true,
      installation: "committed",
      activation: "not-requested",
      plugin: { id: "dev.firefly.alpha", name: "Sample Plugin", version: "1.0.0" },
    });
    expect(controller.status("dev.firefly.alpha")).toBe("disabled");
    expect(controller.stateStore.isEnabled("dev.firefly.alpha")).toBe(false);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.alpha", "1.0.0", "index.mjs"))).toBe(true);
    expect(harness.launched).toHaveLength(0);

    controller.dispose();
  });

  it("rolls back and re-enables old version when upgraded version fails activation", async () => {
    const harness = createFakeHostHarness((_mainPath, version) =>
      version === "2.0.0" ? { ok: false, error: "v2 activation boom" } : { ok: true },
    );
    const { controller } = makeController(harness);
    const v1Path = await writeArchivePlugin({ id: "dev.firefly.up", version: "1.0.0" });
    expect((await controller.importFromPath(v1Path)).ok).toBe(true);

    await controller.enablePlugin("dev.firefly.up");
    controller.setModelRateLimit("dev.firefly.up", 25);
    const revBeforeUpgrade = controller.stateStore.get("dev.firefly.up")!.revision;
    expect(controller.status("dev.firefly.up")).toBe("enabled");

    const v2Path = await writeArchivePlugin({ id: "dev.firefly.up", version: "2.0.0" });
    const upgradeRes = await controller.importFromPath(v2Path);
    expect(upgradeRes.ok).toBe(false);
    if (!upgradeRes.ok) {
      expect(upgradeRes.activation).toBe("rolled-back");
      expect(upgradeRes.error).toContain("v1.0.0");
      expect(upgradeRes.error).toContain("v2 activation boom");
    }

    // Old version is restored, re-enabled, and rate limit preserved; failed v2 dir removed
    expect(controller.status("dev.firefly.up")).toBe("enabled");
    const restored = controller.stateStore.get("dev.firefly.up")!;
    expect(restored.version).toBe("1.0.0");
    expect(restored.enabled).toBe(true);
    expect(restored.modelRateLimit).toBe(25);
    expect(restored.revision).toBeGreaterThan(revBeforeUpgrade);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.up", "1.0.0"))).toBe(true);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.up", "2.0.0"))).toBe(false);

    // Old process stopped with reason "upgrade", then v2 attempted, then old restarted
    expect(harness.launched[0].stopReasons).toEqual(["upgrade"]);
    expect(harness.launched.map((c) => c.version)).toEqual(["1.0.0", "2.0.0", "1.0.0"]);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("uninstall removes scheduled tasks and package dir while keeping secrets when requested", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const deleteTasksSpy = vi.fn(() => 1);
    const { controller } = makeController(harness, deleteTasksSpy);

    const pkgPath = await writeArchivePlugin({ id: "dev.firefly.keepsec", version: "1.0.0" });
    await controller.importFromPath(pkgPath);
    await controller.enablePlugin("dev.firefly.keepsec");

    // Write a secret and plugin-data file
    await controller.secretsService.set("dev.firefly.keepsec", "api_key", "super-secret");
    const secretsFile = resolvePluginSecretsFile("dev.firefly.keepsec", dataRoot);
    const pluginDataDir = path.join(dataRoot, "plugin-data", "dev.firefly.keepsec");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "cache.json"), "{}", "utf8");
    expect(existsSync(secretsFile)).toBe(true);

    // Uninstall keeping secrets and data
    await controller.uninstallPlugin("dev.firefly.keepsec", { deleteSecrets: false, deleteData: false });

    expect(deleteTasksSpy).toHaveBeenCalledWith("dev.firefly.keepsec");
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.keepsec"))).toBe(false);
    expect(controller.stateStore.get("dev.firefly.keepsec")).toBeUndefined();
    expect(existsSync(secretsFile)).toBe(true);
    expect(existsSync(pluginDataDir)).toBe(true);
    expect(await controller.secretsService.get("dev.firefly.keepsec", "api_key")).toBe("super-secret");

    // Reinstall & uninstall deleting secrets and data
    await controller.importFromPath(pkgPath);
    await controller.uninstallPlugin("dev.firefly.keepsec", { deleteSecrets: true, deleteData: true });
    expect(existsSync(secretsFile)).toBe(false);
    expect(existsSync(pluginDataDir)).toBe(false);

    controller.dispose();
  });

  it("marks activation failure as disabled-fault and updates permissions/rate-limit immediately", async () => {
    const harness = createFakeHostHarness(() => ({ ok: false, error: "Activation timed out" }));
    const { controller } = makeController(harness);

    const pkgPath = await writeArchivePlugin({ id: "dev.firefly.faulty", version: "1.0.0" });
    await controller.importFromPath(pkgPath);

    await expect(controller.enablePlugin("dev.firefly.faulty")).rejects.toThrow();
    expect(controller.status("dev.firefly.faulty")).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.faulty")).toBe(false);
    const snap = controller.getPlugin("dev.firefly.faulty")!;
    expect(snap.status).toBe("disabled-fault");
    expect(snap.error).toContain("Activation timed out");

    // Permission toggle increments revision and rate limit enforces 1..60
    const rev1 = controller.stateStore.get("dev.firefly.faulty")!.revision;
    const rev2 = controller.revokePermission("dev.firefly.faulty", "secrets").revision;
    expect(rev2).toBeGreaterThan(rev1);
    const rev3 = controller.grantPermission("dev.firefly.faulty", "secrets").revision;
    expect(rev3).toBeGreaterThan(rev2);
    expect(controller.setModelRateLimit("dev.firefly.faulty", 42).modelRateLimit).toBe(42);
    expect(() => controller.setModelRateLimit("dev.firefly.faulty", 0)).toThrow();
    expect(() => controller.setModelRateLimit("dev.firefly.faulty", 61)).toThrow();

    controller.dispose();
  });
});
