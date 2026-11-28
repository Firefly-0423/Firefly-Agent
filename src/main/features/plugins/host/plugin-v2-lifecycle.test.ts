import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonStore } from "../../../base/storage/atomic-json-store";
import { HOST_TO_PLUGIN_METHODS, type Frame } from "../../../../shared/plugin-protocol";
import { PLUGIN_ACTIVATE_ERROR_PREFIX } from "../../../../shared/plugin-activation-error";
import type { ImporterFsOps } from "../../../../plugins/v2/package/importer";
import { resolvePluginSecretsFile } from "../../../../plugins/v2/secrets/paths";
import type { SafeStorageLike } from "../../../../plugins/v2/secrets";
import { createPluginV2HostController, type PluginV2HostDependencies } from "./plugin-v2-services";
import type { HostChild, HostDependencies, HostPort } from "../../../../plugins/v2/host";
import { PluginHostManager } from "../../../../plugins/v2/host";
import { createPluginNotifications } from "../../../../plugins/v2/notifications";
import { createRpcEndpoint } from "../../../../shared/plugin-rpc";

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

type ActivateVerdict = { ok: boolean; error?: string };

function createFakeHostHarness(
  activateBehavior: (mainPath: string, version: string) => ActivateVerdict | Promise<ActivateVerdict>,
  onPluginRequest?: (method: string, params: unknown) => unknown,
) {
  const launched: FakeChildRecord[] = [];
  const managers: PluginHostManager[] = [];
  const createHostManager = (deps: HostDependencies) => {
    const manager = new PluginHostManager({
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
          childPort.on("message", async ({ data }) => {
            const frame = data as Frame;
            if (frame.type !== "req") return;
            if (frame.method === HOST_TO_PLUGIN_METHODS.activate) {
              const params = frame.params as { main: string; version: string };
              record.mainPath = params.main;
              record.version = params.version;
              const verdict = await activateBehavior(params.main, params.version);
              if (verdict.ok) {
                childPort?.postMessage({ type: "res", id: frame.id, ok: true, value: null });
              } else {
                childPort?.postMessage({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: { code: "ERR_INTERNAL", message: `${PLUGIN_ACTIVATE_ERROR_PREFIX}${verdict.error ?? "activation failed"}`, retryable: false },
                });
              }
            } else if (frame.method === HOST_TO_PLUGIN_METHODS.deactivate) {
              record.stopReasons.push(String(frame.params));
              childPort?.postMessage({ type: "res", id: frame.id, ok: true, value: null });
            } else if (onPluginRequest) {
              childPort?.postMessage({ type: "res", id: frame.id, ok: true, value: onPluginRequest(frame.method, frame.params) });
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
    managers.push(manager);
    return manager;
  };
  return { launched, managers, createHostManager };
}

function makeController(
  harness: ReturnType<typeof createFakeHostHarness>,
  deleteTasksSpy = vi.fn(() => 2),
  extra: { createPluginWindow?: PluginV2HostDependencies["createPluginWindow"]; packageFs?: Partial<ImporterFsOps>; createNotifications?: PluginV2HostDependencies["createNotifications"] } = {},
) {
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
    ...(extra.createPluginWindow ? { createPluginWindow: extra.createPluginWindow } : {}),
    ...(extra.packageFs ? { packageFs: extra.packageFs } : {}),
    ...(extra.createNotifications ? { createNotifications: extra.createNotifications } : {}),
  });
  return { controller, deleteTasksSpy };
}

type LifecycleController = ReturnType<typeof makeController>["controller"];

/** Imports a package and, for a local overwrite that asks for confirmation, confirms exactly what was shown. */
async function importConfirmed(
  controller: LifecycleController,
  sourcePath: string,
  opts: Parameters<LifecycleController["importFromPath"]>[1] = {},
) {
  const first = await controller.importFromPath(sourcePath, opts);
  if (first.ok || first.installation !== "needs-confirmation") return first;
  return controller.importFromPath(sourcePath, {
    ...opts,
    confirmedReplacement: { sha256: first.replace.packageSha256 },
  });
}

async function writeArchivePlugin(opts: {
  id: string;
  version: string;
  name?: string;
  permissions?: string[];
  ext?: ".ffplugin" | ".zip";
  mainCode?: string;
  native?: boolean;
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
    ...(opts.native ? { native: true } : {}),
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
    const badRes = await importConfirmed(controller, badPath);
    expect(badRes.ok).toBe(false);
    expect(badRes.error).toContain("0.x");
    expect(existsSync(path.join(dataRoot, "plugins"))).toBe(false);
    expect(existsSync(controller.stateStore.filePath)).toBe(false);

    // Valid import starts disabled
    const goodPath = await writeArchivePlugin({ id: "dev.firefly.alpha", version: "1.0.0" });
    const goodRes = await importConfirmed(controller, goodPath);
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

  it("rolls back and re-enables old version when upgraded version fails activation, rebinding prior confirmations (D3)", async () => {
    const harness = createFakeHostHarness((_mainPath, version) =>
      version === "2.0.0" ? { ok: false, error: "v2 activation boom" } : { ok: true },
    );
    const { controller } = makeController(harness);
    const v1Path = await writeArchivePlugin({
      id: "dev.firefly.up",
      version: "1.0.0",
      permissions: ["sessions.read", "model.run", "secrets", "schedules"],
      mainCode: "export default { version: '1.0.0', activate() {} };\n",
    });
    expect((await importConfirmed(controller, v1Path)).ok).toBe(true);

    await controller.enablePlugin("dev.firefly.up");
    controller.setModelRateLimit("dev.firefly.up", 25);
    const beforeUpgrade = controller.stateStore.get("dev.firefly.up")!;
    controller.stateStore.confirmations.set("dev.firefly.up", "sessions.read", beforeUpgrade.revision);
    expect(controller.status("dev.firefly.up")).toBe("enabled");

    const v1DataDir = path.join(dataRoot, "plugin-data", "dev.firefly.up");
    mkdirSync(v1DataDir, { recursive: true });
    writeFileSync(path.join(v1DataDir, "prefs.json"), '{"keep":true}', "utf8");

    const v2Path = await writeArchivePlugin({
      id: "dev.firefly.up",
      version: "2.0.0",
      permissions: ["sessions.read", "workspace.read", "model.run", "secrets", "schedules"],
      mainCode: "export default { version: '2.0.0', activate() {} };\n",
    });
    const upgradeRes = await importConfirmed(controller, v2Path);
    expect(upgradeRes).toEqual({
      ok: false,
      installation: "rejected",
      activation: "rolled-back",
      error: expect.stringContaining("v1.0.0"),
    });
    if (!upgradeRes.ok) {
      expect(upgradeRes.error).toBe("新版本启动失败，已回滚至 v1.0.0：插件自身报错：v2 activation boom");
      expect(upgradeRes.error).not.toContain("Internal plugin error");
    }

    // Old version is restored, re-enabled, grants/confirmations/rate limit preserved, failed v2 removed
    expect(controller.getPlugin("dev.firefly.up")!.error).toBeUndefined();
    expect(controller.status("dev.firefly.up")).toBe("enabled");
    const restored = controller.stateStore.get("dev.firefly.up")!;
    expect(restored.version).toBe("1.0.0");
    expect(restored.enabled).toBe(true);
    expect(restored.modelRateLimit).toBe(25);
    expect(restored.revision).toBeGreaterThan(beforeUpgrade.revision);
    expect(restored.grantedPermissions).toEqual(beforeUpgrade.grantedPermissions);
    expect(restored.grantedPermissions).not.toContain("workspace.read");
    expect(controller.stateStore.confirmations.get("dev.firefly.up", "sessions.read")).toBe(restored.revision);
    expect(controller.stateStore.confirmations.get("dev.firefly.up", "model.run")).toBeUndefined();
    expect(controller.stateStore.confirmations.get("dev.firefly.up", "workspace.read")).toBeUndefined();

    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins["dev.firefly.up"].version).toBe("1.0.0");
    expect(diskState.plugins["dev.firefly.up"].revision).toBe(restored.revision);
    expect(diskState.plugins["dev.firefly.up"].confirmations["sessions.read"]).toBe(restored.revision);

    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.up", "1.0.0"))).toBe(true);
    expect(readFileSync(path.join(dataRoot, "plugins", "dev.firefly.up", "1.0.0", "index.mjs"), "utf8")).toContain("1.0.0");
    expect(readFileSync(path.join(v1DataDir, "prefs.json"), "utf8")).toBe('{"keep":true}');
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.up", "2.0.0"))).toBe(false);

    // Old process stopped with reason "upgrade", v2 attempted and stopped, then old restarted
    expect(harness.launched[0].stopReasons).toEqual(["upgrade"]);
    expect(harness.launched[1].killCount).toBeGreaterThanOrEqual(1);
    expect(harness.launched.map((c) => c.version)).toEqual(["1.0.0", "2.0.0", "1.0.0"]);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("keeps a permission revoked and a rate limit changed during an upgrade when the upgrade rolls back", async () => {
    let releaseV2!: () => void;
    const v2Held = new Promise<void>((resolve) => { releaseV2 = resolve; });
    const harness = createFakeHostHarness(async (_mainPath, version) => {
      if (version !== "2.0.0") return { ok: true };
      await v2Held;
      return { ok: false, error: "v2 activation boom" };
    });
    const { controller } = makeController(harness);
    const id = "dev.firefly.revokeduring";
    const permissions = ["sessions.read", "secrets"];
    expect((await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", permissions }))).ok).toBe(true);
    await controller.enablePlugin(id);
    expect(controller.stateStore.get(id)!.grantedPermissions).toEqual(expect.arrayContaining(permissions));

    const upgrade = importConfirmed(controller, await writeArchivePlugin({ id, version: "2.0.0", permissions }));
    await vi.waitFor(() => expect(harness.launched.map((c) => c.version)).toContain("2.0.0"));
    controller.revokePermission(id, "secrets");
    controller.setModelRateLimit(id, 7);
    releaseV2();
    const res = await upgrade;

    expect(res).toMatchObject({ ok: false, activation: "rolled-back" });
    const restored = controller.stateStore.get(id)!;
    expect(restored.version).toBe("1.0.0");
    expect(restored.grantedPermissions).not.toContain("secrets");
    expect(restored.grantedPermissions).toContain("sessions.read");
    expect(restored.modelRateLimit).toBe(7);
    const disk = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(disk.plugins[id].grantedPermissions).not.toContain("secrets");
    expect(controller.stateStore.hasPermission(id, "secrets")).toBe(false);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("restores a grant the failed new version simply did not declare when the upgrade rolls back", async () => {
    const harness = createFakeHostHarness((_mainPath, version) => (version === "2.0.0" ? { ok: false, error: "boom" } : { ok: true }));
    const { controller } = makeController(harness);
    const id = "dev.firefly.dropdecl";
    expect((await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", permissions: ["sessions.read", "secrets"] }))).ok).toBe(true);
    await controller.enablePlugin(id);
    expect(controller.stateStore.hasPermission(id, "secrets")).toBe(true);

    const res = await importConfirmed(controller, await writeArchivePlugin({ id, version: "2.0.0", permissions: ["sessions.read"] }));

    expect(res).toMatchObject({ ok: false, activation: "rolled-back" });
    expect(controller.stateStore.get(id)!.version).toBe("1.0.0");
    expect(controller.stateStore.hasPermission(id, "secrets")).toBe(true);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("fault-injects state write failure during upgrade rollback and marks disabled-fault without restarting old (D2)", async () => {
    const harness = createFakeHostHarness((_mainPath, version) =>
      version === "2.0.0" ? { ok: false, error: "v2 boom" } : { ok: true },
    );
    const { controller } = makeController(harness);
    const v1Path = await writeArchivePlugin({ id: "dev.firefly.failstate", version: "1.0.0" });
    await importConfirmed(controller, v1Path);
    await controller.enablePlugin("dev.firefly.failstate");

    const origWrite = AtomicJsonStore.prototype.write;
    let writeCalls = 0;
    vi.spyOn(AtomicJsonStore.prototype, "write").mockImplementation(function (this: AtomicJsonStore<unknown>, data: unknown) {
      writeCalls += 1;
      // 1st write inside upgrade: v2 stateStore.install; 2nd write: restoreSnapshot -> fail it!
      if (writeCalls === 2) {
        throw new Error("injected state write failure");
      }
      return origWrite.call(this, data);
    });

    const v2Path = await writeArchivePlugin({ id: "dev.firefly.failstate", version: "2.0.0" });
    const res = await importConfirmed(controller, v2Path);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.activation).toBe("failed");
      expect(res.error).toContain("已停用（异常）");
    }

    // File rollback still ran despite state write failure; old version was NOT restarted
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.failstate", "2.0.0"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.failstate", "1.0.0"))).toBe(true);
    expect(harness.launched.map((c) => c.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(harness.launched[1].killCount).toBeGreaterThanOrEqual(1);
    expect(controller.status("dev.firefly.failstate")).toBe("disabled-fault");
    expect(controller.getPlugin("dev.firefly.failstate")?.status).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.failstate")).toBe(false);
    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins["dev.firefly.failstate"].enabled).toBe(false);

    controller.dispose();
  });

  it("fault-injects removing new package failure during upgrade rollback and marks disabled-fault (D2)", async () => {
    const harness = createFakeHostHarness((_mainPath, version) =>
      version === "2.0.0" ? { ok: false, error: "v2 boom" } : { ok: true },
    );
    const v2Dir = path.join(dataRoot, "plugins", "dev.firefly.failrm", "2.0.0");
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, opts) {
          if (path.resolve(String(target)) === path.resolve(v2Dir)) {
            throw new Error("EBUSY removing v2");
          }
          return fsPromises.rm(target, opts);
        },
      },
    });
    const v1Path = await writeArchivePlugin({ id: "dev.firefly.failrm", version: "1.0.0" });
    await importConfirmed(controller, v1Path);
    await controller.enablePlugin("dev.firefly.failrm");

    const v2Path = await writeArchivePlugin({ id: "dev.firefly.failrm", version: "2.0.0" });
    const res = await importConfirmed(controller, v2Path);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.activation).toBe("failed");
      expect(res.error).toContain("EBUSY removing v2");
    }

    expect(existsSync(v2Dir)).toBe(true);
    expect(harness.launched.map((c) => c.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(controller.status("dev.firefly.failrm")).toBe("disabled-fault");
    expect(controller.getPlugin("dev.firefly.failrm")?.status).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.failrm")).toBe(false);
    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins["dev.firefly.failrm"].enabled).toBe(false);

    controller.dispose();
  });

  it("fault-injects restoring backup failure during same-version overwrite rollback and marks disabled-fault (D2)", async () => {
    let failAttempt = false;
    const harness = createFakeHostHarness(() =>
      failAttempt ? { ok: false, error: "overwrite activation boom" } : { ok: true },
    );
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rename(oldPath, newPath) {
          if (failAttempt && path.basename(String(oldPath)).startsWith(".backup-")) {
            throw new Error("EPERM restoring backup");
          }
          return fsPromises.rename(oldPath, newPath);
        },
      },
    });
    const v1First = await writeArchivePlugin({
      id: "dev.firefly.failbackup",
      version: "1.0.0",
      mainCode: "export default { build: 'first' };\n",
    });
    await importConfirmed(controller, v1First);
    await controller.enablePlugin("dev.firefly.failbackup");

    failAttempt = true;
    const v1Overwrite = await writeArchivePlugin({
      id: "dev.firefly.failbackup",
      version: "1.0.0",
      mainCode: "export default { build: 'second' };\n",
    });
    const res = await importConfirmed(controller, v1Overwrite);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.activation).toBe("failed");
      expect(res.error).toContain("EPERM restoring backup");
    }

    const pluginIdDir = path.join(dataRoot, "plugins", "dev.firefly.failbackup");
    expect(existsSync(path.join(pluginIdDir, "1.0.0"))).toBe(false);
    expect(readdirSync(pluginIdDir).some((name) => name.startsWith(".backup-"))).toBe(true);
    expect(harness.launched).toHaveLength(2);
    expect(controller.status("dev.firefly.failbackup")).toBe("disabled-fault");
    expect(controller.getPlugin("dev.firefly.failbackup")?.status).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.failbackup")).toBe(false);
    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins["dev.firefly.failbackup"].enabled).toBe(false);

    controller.dispose();
  });

  it("persists a bystander plugin as disabled when it faults while another plugin is being upgraded", async () => {
    const bystanderId = "dev.firefly.bystander";
    const harness = createFakeHostHarness(async (mainPath, version) => {
      if (mainPath.includes(bystanderId)) return { ok: false, error: "bystander activation boom" };
      if (version === "2.0.0") {
        // Plugin B faults for real (host status -> disabled-fault) while A's upgrade activation is in flight.
        await harness.managers[0].start(bystanderId).catch(() => {});
      }
      return { ok: true };
    });
    const { controller } = makeController(harness);
    await importConfirmed(controller, await writeArchivePlugin({ id: "dev.firefly.upgrader", version: "1.0.0" }));
    await controller.enablePlugin("dev.firefly.upgrader");
    await importConfirmed(controller, await writeArchivePlugin({ id: bystanderId, version: "1.0.0" }));
    controller.stateStore.enable(bystanderId);
    expect(controller.stateStore.isEnabled(bystanderId)).toBe(true);

    const res = await importConfirmed(controller, await writeArchivePlugin({ id: "dev.firefly.upgrader", version: "2.0.0" }));

    expect(res).toMatchObject({ ok: true, activation: "running" });
    expect(controller.status(bystanderId)).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled(bystanderId)).toBe(false);
    const disk = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(disk.plugins[bystanderId].enabled).toBe(false);
    expect(controller.stateStore.isEnabled("dev.firefly.upgrader")).toBe(true);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("keeps the old files in place until the running old instance has stopped during a same-version overwrite", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    const pluginId = "dev.firefly.stopfirst";
    const installedMain = path.join(dataRoot, "plugins", pluginId, "1.0.0", "index.mjs");
    await importConfirmed(controller, await writeArchivePlugin({
      id: pluginId,
      version: "1.0.0",
      mainCode: "export default { build: 'old' };\n",
    }));
    await controller.enablePlugin(pluginId);

    const filesSeenAtStop: string[] = [];
    const realStop = harness.managers[0].stop.bind(harness.managers[0]);
    vi.spyOn(harness.managers[0], "stop").mockImplementation(async (id, reason) => {
      filesSeenAtStop.push(readFileSync(installedMain, "utf8"));
      return realStop(id, reason);
    });

    const res = await importConfirmed(controller, await writeArchivePlugin({
      id: pluginId,
      version: "1.0.0",
      mainCode: "export default { build: 'new' };\n",
    }));

    expect(res).toMatchObject({ ok: true, activation: "running" });
    expect(filesSeenAtStop).toEqual(["export default { build: 'old' };\n"]);
    expect(readFileSync(installedMain, "utf8")).toContain("'new'");
    expect(readdirSync(path.join(dataRoot, "plugins", pluginId))).toEqual(["1.0.0"]);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("keeps the old files and restarts the old instance when stopping it fails during a same-version overwrite", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    const pluginId = "dev.firefly.stopfails";
    const installedMain = path.join(dataRoot, "plugins", pluginId, "1.0.0", "index.mjs");
    await importConfirmed(controller, await writeArchivePlugin({
      id: pluginId,
      version: "1.0.0",
      mainCode: "export default { build: 'old' };\n",
    }));
    await controller.enablePlugin(pluginId);

    const realStop = harness.managers[0].stop.bind(harness.managers[0]);
    let stopCalls = 0;
    vi.spyOn(harness.managers[0], "stop").mockImplementation(async (id, reason) => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("stop boom");
      return realStop(id, reason);
    });

    const res = await importConfirmed(controller, await writeArchivePlugin({
      id: pluginId,
      version: "1.0.0",
      mainCode: "export default { build: 'new' };\n",
    }));

    expect(res).toMatchObject({ ok: false, installation: "rejected", activation: "rolled-back" });
    expect(readFileSync(installedMain, "utf8")).toContain("'old'");
    expect(readdirSync(path.join(dataRoot, "plugins", pluginId))).toEqual(["1.0.0"]);
    expect(controller.stateStore.isEnabled(pluginId)).toBe(true);
    expect(controller.status(pluginId)).toBe("enabled");

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("reports a disabled same-version overwrite as committed with the new files and state when only backup removal fails", async () => {
    let failCommit = false;
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, options) {
          if (failCommit && path.basename(String(target)).startsWith(".backup-")) {
            throw new Error("EPERM removing backup");
          }
          return fsPromises.rm(target, options);
        },
      },
    });
    const id = "dev.firefly.commitfail";
    expect((await importConfirmed(controller, await writeArchivePlugin({
      id,
      version: "1.0.0",
      name: "First Name",
      mainCode: "export default { build: 'first' };\n",
    }))).ok).toBe(true);

    failCommit = true;
    const res = await importConfirmed(controller, await writeArchivePlugin({
      id,
      version: "1.0.0",
      name: "Second Name",
      mainCode: "export default { build: 'second' };\n",
    }));

    expect(res).toEqual({
      ok: true,
      installation: "committed",
      activation: "not-requested",
      plugin: { id, name: "Second Name", version: "1.0.0" },
    });
    expect(controller.stateStore.get(id)?.manifest.name).toBe("Second Name");
    expect(controller.stateStore.get(id)?.enabled).toBe(false);
    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins[id].manifest.name).toBe("Second Name");
    expect(readFileSync(path.join(dataRoot, "plugins", id, "1.0.0", "index.mjs"), "utf8")).toContain("second");
    expect(harness.launched).toHaveLength(0);

    controller.dispose();
  });

  it("keeps the complete new package when backup removal deletes part of the backup and then throws", async () => {
    let failCommit = false;
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, options) {
          if (failCommit && path.basename(String(target)).startsWith(".backup-")) {
            await fsPromises.rm(path.join(String(target), "index.mjs"), { force: true });
            throw new Error("EPERM removing backup");
          }
          return fsPromises.rm(target, options);
        },
      },
    });
    const id = "dev.firefly.partialbackup";
    await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "First Name", mainCode: "export default { build: 'first' };\n" }));

    failCommit = true;
    const res = await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "Second Name", mainCode: "export default { build: 'second' };\n" }));

    expect(res).toMatchObject({ ok: true, installation: "committed" });
    expect(readFileSync(path.join(dataRoot, "plugins", id, "1.0.0", "index.mjs"), "utf8")).toContain("second");
    expect(controller.stateStore.get(id)?.manifest.name).toBe("Second Name");

    controller.dispose();
  });

  it("restores files and the previous state record when swapping a disabled same-version overwrite fails", async () => {
    let failSwap = false;
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rename(from, to) {
          if (failSwap && path.basename(String(from)).startsWith(".staging-")) {
            throw new Error("EPERM swapping package");
          }
          return fsPromises.rename(from, to);
        },
      },
    });
    const id = "dev.firefly.swapfail";
    await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "First Name", mainCode: "export default { build: 'first' };\n" }));
    const before = structuredClone(controller.stateStore.get(id));

    failSwap = true;
    const res = await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "Second Name", mainCode: "export default { build: 'second' };\n" }));

    expect(res).toMatchObject({ ok: false, installation: "rejected", error: expect.stringContaining("EPERM swapping package") });
    expect(controller.stateStore.get(id)).toMatchObject({
      manifest: before?.manifest,
      installDir: before?.installDir,
      enabled: false,
      grantedPermissions: before?.grantedPermissions,
    });
    expect(readFileSync(path.join(dataRoot, "plugins", id, "1.0.0", "index.mjs"), "utf8")).toContain("first");
    expect(readdirSync(path.join(dataRoot, "plugins", id))).toEqual(["1.0.0"]);

    controller.dispose();
  });

  it("commits a first install over a leftover same-version directory when only backup removal fails", async () => {
    let failCommit = false;
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, options) {
          if (failCommit && path.basename(String(target)).startsWith(".backup-")) {
            throw new Error("EPERM removing backup");
          }
          return fsPromises.rm(target, options);
        },
      },
    });
    const id = "dev.firefly.leftover";
    expect((await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0" }))).ok).toBe(true);
    // Simulate an uninstall that removed the record but could not delete the package directory.
    controller.stateStore.uninstall(id);

    failCommit = true;
    const res = await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "Again" }));

    expect(res).toMatchObject({ ok: true, installation: "committed", plugin: { id, name: "Again" } });
    expect(controller.stateStore.get(id)?.manifest.name).toBe("Again");
    expect(readFileSync(path.join(dataRoot, "plugins", id, "1.0.0", "index.mjs"), "utf8")).toContain("activate");
    expect(harness.launched).toHaveLength(0);

    controller.dispose();
  });

  it("reports an enabled same-version overwrite as committed and keeps the new instance when only backup removal fails", async () => {
    let failCommit = false;
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, options) {
          if (failCommit && path.basename(String(target)).startsWith(".backup-")) {
            throw new Error("EPERM removing backup");
          }
          return fsPromises.rm(target, options);
        },
      },
    });
    const id = "dev.firefly.activecommitfail";
    await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "First Name", mainCode: "export default { build: 'first' };\n" }));
    await controller.enablePlugin(id);

    failCommit = true;
    const res = await importConfirmed(controller, await writeArchivePlugin({ id, version: "1.0.0", name: "Second Name", mainCode: "export default { build: 'second' };\n" }));

    expect(res).toMatchObject({ ok: true, installation: "committed", activation: "running" });
    expect(controller.status(id)).toBe("enabled");
    expect(controller.stateStore.get(id)?.manifest.name).toBe("Second Name");
    expect(controller.stateStore.isEnabled(id)).toBe(true);
    const installed = path.join(dataRoot, "plugins", id, "1.0.0", "index.mjs");
    expect(readFileSync(installed, "utf8")).toContain("second");

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("rejects a marketplace import whose real manifest declares native: true and leaves no files or state", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    const nativePkg = await writeArchivePlugin({ id: "dev.firefly.nativemarket", version: "1.0.0", native: true });

    const res = await importConfirmed(controller, nativePkg, { origin: "market" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.installation).toBe("rejected");
      expect(res.error).toContain("原生");
    }
    expect(controller.stateStore.get("dev.firefly.nativemarket")).toBeUndefined();
    expect(existsSync(controller.stateStore.filePath)).toBe(false);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.nativemarket", "1.0.0"))).toBe(false);
    expect(harness.launched).toHaveLength(0);

    const local = await importConfirmed(controller, nativePkg, { origin: "local" });
    expect(local.ok).toBe(true);

    controller.dispose();
  });

  it("uninstall removes scheduled tasks and package dir while keeping secrets when requested", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const deleteTasksSpy = vi.fn(() => 1);
    const { controller } = makeController(harness, deleteTasksSpy);

    const pkgPath = await writeArchivePlugin({ id: "dev.firefly.keepsec", version: "1.0.0" });
    await importConfirmed(controller, pkgPath);
    await controller.enablePlugin("dev.firefly.keepsec");

    // Write a secret and plugin-data file
    await controller.secretsService.set("dev.firefly.keepsec", "api_key", "super-secret");
    const secretsFile = resolvePluginSecretsFile("dev.firefly.keepsec", dataRoot);
    const pluginDataDir = path.join(dataRoot, "plugin-data", "dev.firefly.keepsec");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "cache.json"), "{}", "utf8");
    expect(existsSync(secretsFile)).toBe(true);

    // Uninstall keeping secrets and data
    const keepResult = await controller.uninstallPlugin("dev.firefly.keepsec", { deleteSecrets: false, deleteData: false });
    expect(keepResult).toEqual({
      ok: true,
      uninstalled: true,
      cleanup: { secrets: "kept", data: "kept" },
    });

    expect(deleteTasksSpy).toHaveBeenCalledWith("dev.firefly.keepsec");
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.keepsec"))).toBe(false);
    expect(controller.stateStore.get("dev.firefly.keepsec")).toBeUndefined();
    expect(existsSync(secretsFile)).toBe(true);
    expect(existsSync(pluginDataDir)).toBe(true);
    expect(await controller.secretsService.get("dev.firefly.keepsec", "api_key")).toBe("super-secret");

    // Reinstall & uninstall deleting secrets and data; verify old grants are not reused
    await importConfirmed(controller, pkgPath);
    const reinstalled = controller.stateStore.get("dev.firefly.keepsec")!;
    expect(reinstalled.enabled).toBe(false);
    expect(reinstalled.grantedPermissions).toEqual([]);
    expect(reinstalled.revision).toBe(1);

    const deleteResult = await controller.uninstallPlugin("dev.firefly.keepsec", { deleteSecrets: true, deleteData: true });
    expect(deleteResult).toEqual({
      ok: true,
      uninstalled: true,
      cleanup: { secrets: "deleted", data: "deleted" },
    });
    expect(existsSync(secretsFile)).toBe(false);
    expect(existsSync(pluginDataDir)).toBe(false);

    controller.dispose();
  });

  it("reports partial uninstall cleanup failures, preserves retry metadata, and never reuses old grants on reinstall (D4)", async () => {
    let failDataRm = false;
    const pluginDataDir = path.join(dataRoot, "plugin-data", "dev.firefly.partialclean");
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness, undefined, {
      packageFs: {
        async rm(target, opts) {
          if (failDataRm && path.resolve(String(target)) === path.resolve(pluginDataDir)) {
            throw new Error("EBUSY data dir");
          }
          return fsPromises.rm(target, opts);
        },
      },
    });

    const pkgPath = await writeArchivePlugin({
      id: "dev.firefly.partialclean",
      version: "1.0.0",
      permissions: ["secrets", "schedules"],
    });
    await importConfirmed(controller, pkgPath);
    await controller.enablePlugin("dev.firefly.partialclean");
    controller.setModelRateLimit("dev.firefly.partialclean", 33);
    expect(controller.stateStore.get("dev.firefly.partialclean")!.grantedPermissions.length).toBeGreaterThan(0);

    await controller.secretsService.set("dev.firefly.partialclean", "token", "secret-val");
    const secretsFile = resolvePluginSecretsFile("dev.firefly.partialclean", dataRoot);
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "state.txt"), "keep", "utf8");

    // 1. Inject secrets deletion failure while data deletion succeeds
    const deleteAllSpy = vi.spyOn(controller.secretsService, "deleteAll").mockRejectedValueOnce(new Error("keyring locked"));
    const partialSecretsRes = await controller.uninstallPlugin("dev.firefly.partialclean", {
      deleteSecrets: true,
      deleteData: true,
    });
    expect(partialSecretsRes.ok).toBe(false);
    expect(partialSecretsRes.uninstalled).toBe(true);
    expect(partialSecretsRes.cleanup).toEqual({
      secrets: "delete_failed",
      secretsError: "keyring locked",
      data: "deleted",
    });
    expect(partialSecretsRes.error).toContain("keyring locked");
    expect(existsSync(secretsFile)).toBe(true);
    expect(existsSync(pluginDataDir)).toBe(false);
    expect(controller.stateStore.get("dev.firefly.partialclean")).toBeUndefined();
    expect(controller.listPendingCleanups()).toEqual([
      {
        id: "dev.firefly.partialclean",
        name: "Sample Plugin",
        secrets: "delete_failed",
        secretsError: "keyring locked",
        data: "deleted",
      },
    ]);

    // Retry succeeds and clears pending cleanup
    deleteAllSpy.mockRestore();
    const retrySecretsRes = await controller.uninstallPlugin("dev.firefly.partialclean", { deleteSecrets: true });
    expect(retrySecretsRes).toEqual({
      ok: true,
      uninstalled: true,
      cleanup: { secrets: "deleted", data: "deleted" },
    });
    expect(existsSync(secretsFile)).toBe(false);
    expect(controller.listPendingCleanups()).toEqual([]);

    // 2. Reinstall same ID: verify zero reused grants, rate limit reset, disabled by default
    await importConfirmed(controller, pkgPath);
    const fresh = controller.stateStore.get("dev.firefly.partialclean")!;
    expect(fresh.enabled).toBe(false);
    expect(fresh.grantedPermissions).toEqual([]);
    expect(fresh.modelRateLimit).toBe(10);
    expect(fresh.revision).toBe(1);

    // 3. Inject plugin-data directory deletion failure while secrets deletion succeeds
    await controller.secretsService.set("dev.firefly.partialclean", "token", "secret-val-2");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(path.join(pluginDataDir, "locked.txt"), "busy", "utf8");
    failDataRm = true;

    const partialDataRes = await controller.uninstallPlugin("dev.firefly.partialclean", {
      deleteSecrets: true,
      deleteData: true,
    });
    expect(partialDataRes.ok).toBe(false);
    expect(partialDataRes.cleanup).toEqual({
      secrets: "deleted",
      data: "delete_failed",
      dataError: "EBUSY data dir",
    });
    expect(existsSync(secretsFile)).toBe(false);
    expect(existsSync(pluginDataDir)).toBe(true);
    expect(controller.listPendingCleanups()).toEqual([
      {
        id: "dev.firefly.partialclean",
        name: "Sample Plugin",
        secrets: "deleted",
        data: "delete_failed",
        dataError: "EBUSY data dir",
      },
    ]);

    // Retry data cleanup succeeds
    failDataRm = false;
    const retryDataRes = await controller.uninstallPlugin("dev.firefly.partialclean", { deleteData: true });
    expect(retryDataRes).toEqual({
      ok: true,
      uninstalled: true,
      cleanup: { secrets: "deleted", data: "deleted" },
    });
    expect(existsSync(pluginDataDir)).toBe(false);
    expect(controller.listPendingCleanups()).toEqual([]);

    controller.dispose();
  });

  it("marks activation failure as disabled-fault and updates permissions/rate-limit immediately (D8)", async () => {
    const harness = createFakeHostHarness(() => ({ ok: false, error: "Activation timed out" }));
    const { controller } = makeController(harness);

    const pkgPath = await writeArchivePlugin({ id: "dev.firefly.faulty", version: "1.0.0" });
    await importConfirmed(controller, pkgPath);

    await expect(controller.enablePlugin("dev.firefly.faulty")).rejects.toMatchObject({
      code: "ERR_INTERNAL",
      message: `${PLUGIN_ACTIVATE_ERROR_PREFIX}Activation timed out`,
    });
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0].killCount).toBe(1);
    expect(controller.status("dev.firefly.faulty")).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.faulty")).toBe(false);
    const snap = controller.getPlugin("dev.firefly.faulty")!;
    expect(snap.status).toBe("disabled-fault");
    expect(snap.enabled).toBe(false);
    expect(snap.grantedPermissions).toEqual(["schedules", "secrets", "tool:ping"]);
    expect(snap.error).toBe("插件自身报错：Activation timed out");

    const diskAfterFault = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskAfterFault.plugins["dev.firefly.faulty"]).toMatchObject({
      version: "1.0.0",
      enabled: false,
      grantedPermissions: ["schedules", "secrets", "tool:ping"],
      modelRateLimit: 10,
    });

    // Permission toggle increments revision and rate limit enforces 1..60
    const rev1 = controller.stateStore.get("dev.firefly.faulty")!.revision;
    const rev2 = controller.revokePermission("dev.firefly.faulty", "secrets").revision;
    expect(rev2).toBeGreaterThan(rev1);
    const rev3 = controller.grantPermission("dev.firefly.faulty", "secrets").revision;
    expect(rev3).toBeGreaterThan(rev2);
    expect(controller.setModelRateLimit("dev.firefly.faulty", 42).modelRateLimit).toBe(42);
    const beforeInvalid = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8")).plugins["dev.firefly.faulty"];

    expect(() => controller.setModelRateLimit("dev.firefly.faulty", 0)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }),
    );
    expect(() => controller.setModelRateLimit("dev.firefly.faulty", 61)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }),
    );
    expect(() => controller.setModelRateLimit("dev.firefly.faulty", 10.5)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARGUMENT" }),
    );

    expect(controller.stateStore.getModelRateLimit("dev.firefly.faulty")).toBe(42);
    const afterInvalid = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8")).plugins["dev.firefly.faulty"];
    expect(afterInvalid).toEqual(beforeInvalid);

    controller.dispose();
  });

  it("closes open plugin UI windows on permission revocation, disable, fault, and stopAll", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    let nextWcId = 500;
    const closedCounts = new Map<string, number>();
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
      createHostManager: harness.createHostManager,
      createPluginWindow: (opts) => {
        let destroyed = false;
        const listeners = new Set<() => void>();
        return {
          webContentsId: nextWcId++,
          show: () => {},
          focus: () => {},
          close: () => {
            if (destroyed) return;
            destroyed = true;
            closedCounts.set(opts.pluginId, (closedCounts.get(opts.pluginId) ?? 0) + 1);
            for (const fn of [...listeners]) fn();
          },
          isDestroyed: () => destroyed,
          sendMessage: () => {},
          onClosed: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          load: async () => {},
        };
      },
    });

    const manifest = {
      schemaVersion: 1 as const,
      id: "dev.firefly.uiwin",
      name: "UI Win",
      version: "1.0.0",
      sdk: "^1.2.0",
      main: "index.mjs",
      permissions: ["ui.windows" as const],
      ui: { windows: [{ id: "panel", entry: "ui/panel.html", title: "Panel" }] },
    };
    const pkgDir = path.join(dataRoot, "plugins", "dev.firefly.uiwin", "1.0.0");
    mkdirSync(path.join(pkgDir, "ui"), { recursive: true });
    writeFileSync(path.join(pkgDir, "index.mjs"), "export default { activate() {} };\n", "utf8");
    writeFileSync(path.join(pkgDir, "ui", "panel.html"), "<html></html>", "utf8");
    controller.installPlugin(manifest, pkgDir);

    await controller.enablePlugin("dev.firefly.uiwin");
    await controller.openPluginWindow("dev.firefly.uiwin");
    expect(controller.listOpenWindows("dev.firefly.uiwin")).toEqual(["panel"]);

    // Revoking ui.windows closes open windows and blocks re-opening
    controller.revokePermission("dev.firefly.uiwin", "ui.windows");
    expect(controller.listOpenWindows("dev.firefly.uiwin")).toEqual([]);
    expect(closedCounts.get("dev.firefly.uiwin")).toBe(1);
    await expect(controller.openPluginWindow("dev.firefly.uiwin")).rejects.toMatchObject({ code: "ERR_PERMISSION" });

    // Re-grant and open, then disablePlugin closes windows
    controller.grantPermission("dev.firefly.uiwin", "ui.windows");
    await controller.openPluginWindow("dev.firefly.uiwin");
    expect(controller.listOpenWindows("dev.firefly.uiwin")).toEqual(["panel"]);
    await controller.disablePlugin("dev.firefly.uiwin");
    expect(controller.listOpenWindows("dev.firefly.uiwin")).toEqual([]);
    expect(closedCounts.get("dev.firefly.uiwin")).toBe(2);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("forwards a window invoke from a page loaded during activate, and rejects invokes once the plugin stops", async () => {
    let releaseActivate!: () => void;
    const activateGate = new Promise<void>((resolve) => { releaseActivate = resolve; });
    const received: Array<{ method: string; params: unknown }> = [];
    const harness = createFakeHostHarness(
      async () => { await activateGate; return { ok: true }; },
      (method, params) => { received.push({ method, params }); return { pong: true }; },
    );
    const { controller } = makeController(harness, undefined, {
      createPluginWindow: (opts) => {
        let destroyed = false;
        const listeners = new Set<() => void>();
        return {
          webContentsId: 700,
          show: () => {},
          focus: () => {},
          close: () => { if (destroyed) return; destroyed = true; for (const fn of [...listeners]) fn(); },
          isDestroyed: () => destroyed,
          sendMessage: () => {},
          onClosed: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
          load: async () => {},
        };
      },
    });
    const id = "dev.firefly.startui";
    const pkgDir = path.join(dataRoot, "plugins", id, "1.0.0");
    mkdirSync(path.join(pkgDir, "ui"), { recursive: true });
    writeFileSync(path.join(pkgDir, "index.mjs"), "export default { activate() {} };\n", "utf8");
    writeFileSync(path.join(pkgDir, "ui", "panel.html"), "<html></html>", "utf8");
    controller.installPlugin({
      schemaVersion: 1 as const, id, name: "Start UI", version: "1.0.0", sdk: "^1.2.0", main: "index.mjs",
      permissions: ["ui.windows" as const],
      ui: { windows: [{ id: "panel", entry: "ui/panel.html", title: "Panel" }] },
    }, pkgDir);

    const enabling = controller.enablePlugin(id);
    await vi.waitFor(() => expect(harness.managers[0]?.status(id)).toBe("starting"));
    await controller.openPluginWindow(id);

    await expect(controller.uiService.handleWindowInvoke(700, { method: "ping", params: { n: 1 } })).resolves.toEqual({ pong: true });
    expect(received).toEqual([{ method: HOST_TO_PLUGIN_METHODS.uiMessage, params: { from: { kind: "window", id: expect.any(String) }, method: "ping", params: { n: 1 } } }]);
    // Only window UI messages get the starting-state path; other callers stay enabled-only.
    await expect(harness.managers[0].call(id, "tool.execute", {})).rejects.toMatchObject({ code: "ERR_UNAVAILABLE" });

    releaseActivate();
    await enabling;
    await controller.disablePlugin(id);
    received.length = 0;
    await expect(controller.uiService.handleWindowInvoke(700, { method: "ping" })).rejects.toBeInstanceOf(Error);
    expect(received).toEqual([]);

    controller.dispose();
  });

  it.skipIf(process.platform !== "win32")(
    "handles Windows 8.3 short paths consistently and still blocks junction escapes via short aliases",
    async (ctx) => {
      const longDir = path.join(root, "very_long_plugin_source_directory");
      mkdirSync(path.join(longDir, "dist"), { recursive: true });
      writeFileSync(path.join(longDir, "firefly.plugin.json"), JSON.stringify({
        schemaVersion: 1,
        id: "dev.firefly.short83",
        name: "Short83",
        version: "1.0.0",
        sdk: "^1.2.0",
        main: "dist/index.mjs",
      }));
      writeFileSync(path.join(longDir, "dist", "index.mjs"), "export default { ok: true };\n");

      const shortDir = execSync(`cmd.exe /c for %I in ("${longDir}") do @echo %~sI`, {
        encoding: "utf8",
      }).trim();
      if (!shortDir || shortDir === longDir) {
        ctx.skip("Volume does not generate 8.3 short names for temp fixtures");
        return;
      }

      const harness = createFakeHostHarness(() => ({ ok: true }));
      const { controller } = makeController(harness);
      const imported = await importConfirmed(controller, shortDir);
      expect(imported.ok).toBe(true);
      expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.short83", "1.0.0", "dist", "index.mjs"))).toBe(true);

      // Verify a junction with a long name cannot bypass boundary checks when referenced by its 8.3 short alias
      const outsideDir = path.join(root, "outside_83_secret");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(path.join(outsideDir, "evil.mjs"), "export default {};\n");
      const badLongDir = path.join(root, "bad_short_junction_pkg");
      mkdirSync(badLongDir, { recursive: true });
      const junctionDir = path.join(badLongDir, "escaped_long_folder");
      symlinkSync(outsideDir, junctionDir, "junction");
      const shortJunctionName = path.basename(
        execSync(`cmd.exe /c for %I in ("${junctionDir}") do @echo %~sI`, {
          encoding: "utf8",
        }).trim(),
      );
      writeFileSync(path.join(badLongDir, "firefly.plugin.json"), JSON.stringify({
        schemaVersion: 1,
        id: "dev.firefly.bad83",
        name: "Bad83",
        version: "1.0.0",
        sdk: "^1.2.0",
        main: `${shortJunctionName}/evil.mjs`,
      }));
      const badRes = await importConfirmed(controller, badLongDir);
      expect(badRes.ok).toBe(false);
      expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.bad83"))).toBe(false);

      controller.dispose();
    },
  );
});


describe("Plugin V2 local replacement confirmation", () => {
  const pluginId = "dev.firefly.replace";

  async function installEnabled(harness: ReturnType<typeof createFakeHostHarness>) {
    const { controller } = makeController(harness);
    const first = await writeArchivePlugin({
      id: pluginId,
      version: "1.0.0",
      name: "Old Name",
      permissions: ["secrets"],
      mainCode: "export default { build: 'old' };\n",
    });
    expect((await controller.importFromPath(first, { origin: "market", sourceId: "official" })).ok).toBe(true);
    await controller.enablePlugin(pluginId);
    return controller;
  }

  it("asks for confirmation instead of swapping or restarting an enabled plugin when a local package has the same id", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabled(harness);
    const before = structuredClone(controller.stateStore.get(pluginId));
    const installedMain = path.join(dataRoot, "plugins", pluginId, "1.0.0", "index.mjs");

    const res = await controller.importFromPath(await writeArchivePlugin({
      id: pluginId,
      version: "2.0.0",
      name: "New Name",
      permissions: ["secrets", "schedules"],
      native: true,
      mainCode: "export default { build: 'new' };\n",
    }));

    expect(res).toEqual({
      ok: false,
      installation: "needs-confirmation",
      error: expect.any(String),
      replace: {
        current: {
          name: "Old Name",
          version: "1.0.0",
          origin: "market",
          enabled: true,
          native: false,
          grantedPermissions: ["secrets", "tool:ping"],
        },
        incoming: {
          name: "New Name",
          version: "2.0.0",
          origin: "local",
          native: true,
          permissions: ["secrets", "schedules"],
          tools: [{ name: "ping", title: "Ping", risk: ["network"], modes: ["work"] }],
        },
        addedPermissions: ["schedules"],
        nativeEscalation: true,
        packageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(readFileSync(installedMain, "utf8")).toContain("'old'");
    expect(readdirSync(path.join(dataRoot, "plugins", pluginId))).toEqual(["1.0.0"]);
    expect(controller.stateStore.get(pluginId)).toEqual(before);
    expect(controller.status(pluginId)).toBe("enabled");
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0].stopReasons).toEqual([]);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("upgrades once the confirmation carries the hash of the package that was shown", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabled(harness);
    const next = await writeArchivePlugin({ id: pluginId, version: "2.0.0", mainCode: "export default { build: 'new' };\n" });
    const asked = await controller.importFromPath(next);
    if (asked.ok || asked.installation !== "needs-confirmation") throw new Error("expected needs-confirmation");

    const res = await controller.importFromPath(next, { confirmedReplacement: { sha256: asked.replace.packageSha256 } });

    expect(res).toMatchObject({ ok: true, installation: "committed", activation: "running", plugin: { id: pluginId, version: "2.0.0" } });
    expect(controller.stateStore.get(pluginId)).toMatchObject({ version: "2.0.0", origin: "local", enabled: true });
    expect(readFileSync(path.join(dataRoot, "plugins", pluginId, "2.0.0", "index.mjs"), "utf8")).toContain("'new'");

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("rejects a confirmation for a different package and leaves the installed plugin untouched", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabled(harness);
    const shown = await writeArchivePlugin({ id: pluginId, version: "2.0.0", mainCode: "export default { build: 'shown' };\n" });
    const asked = await controller.importFromPath(shown);
    if (asked.ok || asked.installation !== "needs-confirmation") throw new Error("expected needs-confirmation");
    const before = structuredClone(controller.stateStore.get(pluginId));

    const swapped = await writeArchivePlugin({ id: pluginId, version: "2.0.0", mainCode: "export default { build: 'swapped' };\n", ext: ".zip" });
    const res = await controller.importFromPath(swapped, { confirmedReplacement: { sha256: asked.replace.packageSha256 } });

    expect(res).toEqual({ ok: false, installation: "rejected", error: expect.stringContaining("确认") });
    expect(readFileSync(path.join(dataRoot, "plugins", pluginId, "1.0.0", "index.mjs"), "utf8")).toContain("'old'");
    expect(readdirSync(path.join(dataRoot, "plugins", pluginId))).toEqual(["1.0.0"]);
    expect(controller.stateStore.get(pluginId)).toEqual(before);
    expect(harness.launched[0].stopReasons).toEqual([]);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("does not ask when a market import updates a market plugin", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabled(harness);
    const res = await controller.importFromPath(
      await writeArchivePlugin({ id: pluginId, version: "2.0.0" }),
      { origin: "market", sourceId: "official" },
    );
    expect(res).toMatchObject({ ok: true, installation: "committed" });
    await controller.stopAll("quit");
    controller.dispose();
  });
});

describe("Plugin V2 desktop notifications wiring", () => {
  const pluginId = "dev.firefly.notify";

  function setup() {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    let hostDeps: HostDependencies | undefined;
    const created: Array<EventEmitter & { show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const create = vi.fn((_options: { title: string; body: string }) => {
      const notice = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() });
      created.push(notice);
      return notice;
    });
    const focusMainWindow = vi.fn();
    const { controller } = makeController(
      { ...harness, createHostManager: (deps: HostDependencies) => { hostDeps = deps; return harness.createHostManager(deps); } },
      undefined,
      {
        createNotifications: (access) => createPluginNotifications({
          ...access,
          isSupported: () => true,
          create,
          focusMainWindow,
        }),
      },
    );
    // Connects a plugin-side endpoint to the host rpc the same way the host manager does when it starts a plugin.
    const connect = () => {
      let hostReceive = (_v: unknown) => {}, clientReceive = (_v: unknown) => {};
      const host = createRpcEndpoint({ post: (f) => clientReceive(f), onFrame: (fn) => { hostReceive = fn; return () => {}; } });
      const client = createRpcEndpoint({ post: (f) => hostReceive(f), onFrame: (fn) => { clientReceive = fn; return () => {}; } });
      const dispose = hostDeps!.configureRpc!(pluginId, host);
      return { client, close: () => { dispose(); client.close(); host.close(); } };
    };
    return { controller, create, created, focusMainWindow, connect };
  }

  async function install(controller: ReturnType<typeof setup>["controller"], permissions: string[]) {
    await controller.importFromPath(await writeArchivePlugin({ id: pluginId, version: "1.0.0", name: "Notifier", permissions }));
  }

  it("shows a notification titled with the installed plugin name when the permission is granted", async () => {
    const t = setup();
    await install(t.controller, ["notifications"]);
    await t.controller.enablePlugin(pluginId);
    const link = t.connect();

    const pending = link.client.call("notifications.show", { title: "Done", body: "Finished" });
    await vi.waitFor(() => expect(t.created).toHaveLength(1));
    t.created[0].emit("show");

    await expect(pending).resolves.toEqual({ shown: true });
    expect(t.create).toHaveBeenCalledExactlyOnceWith({ title: "〔Notifier〕Done", body: "Finished" });
    t.created[0].emit("click");
    expect(t.focusMainWindow).toHaveBeenCalledTimes(1);

    link.close();
    t.controller.dispose();
  });

  it("refuses a plugin whose notifications permission is not granted, without creating a notification", async () => {
    const t = setup();
    await install(t.controller, ["notifications"]);
    await t.controller.enablePlugin(pluginId, { grantedPermissions: [] });
    const link = t.connect();

    await expect(link.client.call("notifications.show", { title: "Done", body: "x" })).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(t.create).not.toHaveBeenCalled();

    link.close();
    t.controller.dispose();
  });

  it("refuses a plugin that does not declare the permission", async () => {
    const t = setup();
    await install(t.controller, ["secrets"]);
    await t.controller.enablePlugin(pluginId);
    const link = t.connect();

    await expect(link.client.call("notifications.show", { title: "Done", body: "x" })).rejects.toMatchObject({ code: "ERR_UNDECLARED" });
    expect(t.create).not.toHaveBeenCalled();

    link.close();
    t.controller.dispose();
  });

  it("stops a pending notification and refuses new ones as soon as the permission is revoked while the plugin runs", async () => {
    const t = setup();
    await install(t.controller, ["notifications"]);
    await t.controller.enablePlugin(pluginId);
    const link = t.connect();

    const pending = link.client.call("notifications.show", { title: "Done", body: "x" });
    await vi.waitFor(() => expect(t.created).toHaveLength(1));
    t.controller.revokePermission(pluginId, "notifications");

    await expect(pending).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(t.created[0].close).toHaveBeenCalled();
    await expect(link.client.call("notifications.show", { title: "Again", body: "x" })).rejects.toMatchObject({ code: "ERR_PERMISSION" });
    expect(t.create).toHaveBeenCalledTimes(1);
    t.created[0].emit("click");
    expect(t.focusMainWindow).not.toHaveBeenCalled();

    link.close();
    t.controller.dispose();
  });
});

describe("Plugin V2 lifecycle serialization per plugin id", () => {
  const pluginId = "dev.firefly.serial";

  async function installEnabledV1(harness: ReturnType<typeof createFakeHostHarness>) {
    const { controller } = makeController(harness);
    const first = await writeArchivePlugin({ id: pluginId, version: "1.0.0" });
    expect((await controller.importFromPath(first, { origin: "market", sourceId: "official" })).ok).toBe(true);
    await controller.enablePlugin(pluginId);
    return controller;
  }

  function liveVersions(harness: ReturnType<typeof createFakeHostHarness>): string[] {
    return harness.launched.filter((child) => child.killCount === 0 && child.stopReasons.length === 0).map((child) => child.version);
  }

  it("two overlapping imports of one id end with the persisted version equal to the single running version", async () => {
    let releaseFirstStart!: () => void;
    const firstStartGate = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    let gated = false;
    const harness = createFakeHostHarness(async (_main, version) => {
      // Hold whichever upgrade starts first; staging order is not deterministic, the lock order is.
      if (version !== "1.0.0" && !gated) {
        gated = true;
        await firstStartGate;
      }
      return { ok: true };
    });
    const controller = await installEnabledV1(harness);
    const v2 = await writeArchivePlugin({ id: pluginId, version: "2.0.0" });
    const v3 = await writeArchivePlugin({ id: pluginId, version: "3.0.0" });

    const imports = Promise.all([
      controller.importFromPath(v2, { origin: "market", sourceId: "official" }),
      controller.importFromPath(v3, { origin: "market", sourceId: "official" }),
    ]);
    await vi.waitFor(() => expect(harness.launched).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The other import must wait instead of reading the old state and stopping/swapping in between.
    expect(harness.launched).toHaveLength(2);
    releaseFirstStart();
    const results = await imports;

    for (const result of results) expect(result).toMatchObject({ ok: true, activation: "running" });
    const persisted = controller.stateStore.get(pluginId)?.version;
    expect(persisted).toBe(harness.launched[2]?.version);
    expect(liveVersions(harness)).toEqual([persisted]);
    expect(controller.status(pluginId)).toBe("enabled");
  });

  it("a local import queued behind another sees the first result as the existing plugin", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    const v1 = await writeArchivePlugin({ id: pluginId, version: "1.0.0" });
    const v2 = await writeArchivePlugin({ id: pluginId, version: "2.0.0" });

    const results = await Promise.all([controller.importFromPath(v1), controller.importFromPath(v2)]);

    const committed = results.filter((result) => result.ok);
    const asked = results.filter((result) => !result.ok);
    expect(committed).toHaveLength(1);
    expect(asked).toHaveLength(1);
    const winner = committed[0]!.ok ? committed[0]!.plugin.version : "";
    expect(asked[0]).toMatchObject({ installation: "needs-confirmation", replace: { current: { version: winner } } });
    expect(controller.stateStore.get(pluginId)?.version).toBe(winner);
  });

  it("an import racing an uninstall ends either fully installed or fully removed", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabledV1(harness);
    const v2 = await writeArchivePlugin({ id: pluginId, version: "2.0.0" });

    const [imported, removed] = await Promise.all([
      controller.importFromPath(v2, { origin: "market", sourceId: "official" }),
      controller.uninstallPlugin(pluginId),
    ]);

    // Staging finishes after the uninstall took the lock, so the import lands on a fresh install; either way state and files agree.
    expect(removed.ok).toBe(true);
    expect(imported.ok).toBe(true);
    const stored = controller.stateStore.get(pluginId);
    expect(stored?.version).toBe("2.0.0");
    expect(existsSync(path.join(dataRoot, "plugins", pluginId, "2.0.0", "index.mjs"))).toBe(true);
    expect(liveVersions(harness)).toEqual([]);
  });

  it("an uninstall followed by an import of the same id leaves a consistent fresh install", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const controller = await installEnabledV1(harness);
    const v2 = await writeArchivePlugin({ id: pluginId, version: "2.0.0" });

    const [removed, imported] = await Promise.all([
      controller.uninstallPlugin(pluginId),
      controller.importFromPath(v2, { origin: "market", sourceId: "official" }),
    ]);

    expect(removed.ok).toBe(true);
    expect(imported).toMatchObject({ ok: true, activation: "not-requested", plugin: { version: "2.0.0" } });
    expect(controller.stateStore.get(pluginId)?.version).toBe("2.0.0");
    expect(existsSync(path.join(dataRoot, "plugins", pluginId, "2.0.0", "index.mjs"))).toBe(true);
    expect(liveVersions(harness)).toEqual([]);
  });

  it("different plugin ids still start concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = createFakeHostHarness(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { ok: true };
    });
    const { controller } = makeController(harness);
    for (const id of ["dev.firefly.one", "dev.firefly.two"]) {
      await controller.importFromPath(await writeArchivePlugin({ id, version: "1.0.0" }));
    }

    const enabling = Promise.all([controller.enablePlugin("dev.firefly.one"), controller.enablePlugin("dev.firefly.two")]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxInFlight).toBe(2);
    release();
    await enabling;
  });

  it("a failed task releases the lock so the next lifecycle call proceeds", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    await expect(controller.enablePlugin("dev.firefly.missing")).rejects.toThrow();
    const res = await controller.importFromPath(await writeArchivePlugin({ id: "dev.firefly.missing", version: "1.0.0" }));
    expect(res.ok).toBe(true);
  });
});
