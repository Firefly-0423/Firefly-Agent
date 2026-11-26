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
import type { ImporterFsOps } from "../../../../plugins/v2/package/importer";
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

type ActivateVerdict = { ok: boolean; error?: string };

function createFakeHostHarness(
  activateBehavior: (mainPath: string, version: string) => ActivateVerdict | Promise<ActivateVerdict>,
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
    managers.push(manager);
    return manager;
  };
  return { launched, managers, createHostManager };
}

function makeController(
  harness: ReturnType<typeof createFakeHostHarness>,
  deleteTasksSpy = vi.fn(() => 2),
  extra: { packageFs?: Partial<ImporterFsOps> } = {},
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
    ...(extra.packageFs ? { packageFs: extra.packageFs } : {}),
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
    expect((await controller.importFromPath(v1Path)).ok).toBe(true);

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
    const upgradeRes = await controller.importFromPath(v2Path);
    expect(upgradeRes).toEqual({
      ok: false,
      installation: "rejected",
      activation: "rolled-back",
      error: expect.stringContaining("v1.0.0"),
    });
    if (!upgradeRes.ok) {
      expect(upgradeRes.error).toContain("v2 activation boom");
    }

    // Old version is restored, re-enabled, grants/confirmations/rate limit preserved, failed v2 removed
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

  it("fault-injects state write failure during upgrade rollback and marks disabled-fault without restarting old (D2)", async () => {
    const harness = createFakeHostHarness((_mainPath, version) =>
      version === "2.0.0" ? { ok: false, error: "v2 boom" } : { ok: true },
    );
    const { controller } = makeController(harness);
    const v1Path = await writeArchivePlugin({ id: "dev.firefly.failstate", version: "1.0.0" });
    await controller.importFromPath(v1Path);
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
    const res = await controller.importFromPath(v2Path);
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
    await controller.importFromPath(v1Path);
    await controller.enablePlugin("dev.firefly.failrm");

    const v2Path = await writeArchivePlugin({ id: "dev.firefly.failrm", version: "2.0.0" });
    const res = await controller.importFromPath(v2Path);
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
    await controller.importFromPath(v1First);
    await controller.enablePlugin("dev.firefly.failbackup");

    failAttempt = true;
    const v1Overwrite = await writeArchivePlugin({
      id: "dev.firefly.failbackup",
      version: "1.0.0",
      mainCode: "export default { build: 'second' };\n",
    });
    const res = await controller.importFromPath(v1Overwrite);
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
    await controller.importFromPath(await writeArchivePlugin({ id: "dev.firefly.upgrader", version: "1.0.0" }));
    await controller.enablePlugin("dev.firefly.upgrader");
    await controller.importFromPath(await writeArchivePlugin({ id: bystanderId, version: "1.0.0" }));
    controller.stateStore.enable(bystanderId);
    expect(controller.stateStore.isEnabled(bystanderId)).toBe(true);

    const res = await controller.importFromPath(await writeArchivePlugin({ id: "dev.firefly.upgrader", version: "2.0.0" }));

    expect(res).toMatchObject({ ok: true, activation: "running" });
    expect(controller.status(bystanderId)).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled(bystanderId)).toBe(false);
    const disk = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(disk.plugins[bystanderId].enabled).toBe(false);
    expect(controller.stateStore.isEnabled("dev.firefly.upgrader")).toBe(true);

    await controller.stopAll("quit");
    controller.dispose();
  });

  it("restores files and the previous state record when committing a disabled same-version overwrite fails", async () => {
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
    const first = await writeArchivePlugin({
      id: "dev.firefly.commitfail",
      version: "1.0.0",
      name: "First Name",
      mainCode: "export default { build: 'first' };\n",
    });
    expect((await controller.importFromPath(first)).ok).toBe(true);
    const before = structuredClone(controller.stateStore.get("dev.firefly.commitfail"));

    failCommit = true;
    const second = await writeArchivePlugin({
      id: "dev.firefly.commitfail",
      version: "1.0.0",
      name: "Second Name",
      mainCode: "export default { build: 'second' };\n",
    });
    const res = await controller.importFromPath(second);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.installation).toBe("rejected");
      expect(res.error).toContain("EPERM removing backup");
    }
    const after = controller.stateStore.get("dev.firefly.commitfail");
    expect(after?.manifest).toEqual(before?.manifest);
    expect(after?.manifest.name).toBe("First Name");
    expect(after?.enabled).toBe(false);
    expect(after?.installDir).toBe(before?.installDir);
    const diskState = JSON.parse(readFileSync(controller.stateStore.filePath, "utf8"));
    expect(diskState.plugins["dev.firefly.commitfail"].manifest.name).toBe("First Name");
    const installed = path.join(dataRoot, "plugins", "dev.firefly.commitfail", "1.0.0", "index.mjs");
    expect(readFileSync(installed, "utf8")).toContain("first");
    expect(harness.launched).toHaveLength(0);

    controller.dispose();
  });

  it("rejects a marketplace import whose real manifest declares native: true and leaves no files or state", async () => {
    const harness = createFakeHostHarness(() => ({ ok: true }));
    const { controller } = makeController(harness);
    const nativePkg = await writeArchivePlugin({ id: "dev.firefly.nativemarket", version: "1.0.0", native: true });

    const res = await controller.importFromPath(nativePkg, { origin: "market" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.installation).toBe("rejected");
      expect(res.error).toContain("原生");
    }
    expect(controller.stateStore.get("dev.firefly.nativemarket")).toBeUndefined();
    expect(existsSync(controller.stateStore.filePath)).toBe(false);
    expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.nativemarket", "1.0.0"))).toBe(false);
    expect(harness.launched).toHaveLength(0);

    const local = await controller.importFromPath(nativePkg, { origin: "local" });
    expect(local.ok).toBe(true);

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
    await controller.importFromPath(pkgPath);
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
    await controller.importFromPath(pkgPath);
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
    await controller.importFromPath(pkgPath);
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
    await controller.importFromPath(pkgPath);

    await expect(controller.enablePlugin("dev.firefly.faulty")).rejects.toMatchObject({
      code: "ERR_INTERNAL",
      message: "Activation timed out",
    });
    expect(harness.launched).toHaveLength(1);
    expect(harness.launched[0].killCount).toBe(1);
    expect(controller.status("dev.firefly.faulty")).toBe("disabled-fault");
    expect(controller.stateStore.isEnabled("dev.firefly.faulty")).toBe(false);
    const snap = controller.getPlugin("dev.firefly.faulty")!;
    expect(snap.status).toBe("disabled-fault");
    expect(snap.enabled).toBe(false);
    expect(snap.grantedPermissions).toEqual(["schedules", "secrets", "tool:ping"]);
    expect(snap.error).toContain("Activation timed out");

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
      const imported = await controller.importFromPath(shortDir);
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
      const badRes = await controller.importFromPath(badLongDir);
      expect(badRes.ok).toBe(false);
      expect(existsSync(path.join(dataRoot, "plugins", "dev.firefly.bad83"))).toBe(false);

      controller.dispose();
    },
  );
});
