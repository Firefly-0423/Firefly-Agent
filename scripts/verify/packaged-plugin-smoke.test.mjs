import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SmokeIsolationError,
  buildIsolatedEnv,
  createProcessTracker,
  parseSmokeArgs,
  resolveLaunchTarget,
  validateIsolationRoot,
} from "./packaged-plugin-smoke.mjs";

function withTempWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-smoke-unit-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("validateIsolationRoot accepts a dedicated subdirectory inside temp", () => {
  withTempWorkspace((root) => {
    const tempBase = path.join(root, "temp");
    const appData = path.join(root, "roaming");
    const isolation = path.join(tempBase, "smoke-run-1");
    fs.mkdirSync(tempBase, { recursive: true });
    fs.mkdirSync(appData, { recursive: true });

    const result = validateIsolationRoot(isolation, {
      appData,
      localAppData: path.join(root, "local"),
      userProfile: path.join(root, "home"),
      tempDir: tempBase,
    });
    assert.equal(result.valid, true);
    assert.equal(result.canonicalIsolationRoot, path.join(fs.realpathSync.native(tempBase), "smoke-run-1"));
  });
});

test("validateIsolationRoot explicitly rejects %APPDATA%\\Firefly-1.2.0 and production overlaps", () => {
  withTempWorkspace((root) => {
    const appData = path.join(root, "AppData", "Roaming");
    const prod12 = path.join(appData, "Firefly-1.2.0");
    const prod11 = path.join(appData, "Firefly");
    const nested = path.join(prod12, "nested");
    const tempBase = path.join(root, "Local", "Temp");
    for (const d of [prod12, prod11, nested, tempBase]) fs.mkdirSync(d, { recursive: true });

    const opts = {
      appData,
      localAppData: path.join(root, "Local"),
      userProfile: root,
      tempDir: tempBase,
    };

    for (const badPath of [prod12, prod11, appData, nested, path.dirname(appData)]) {
      assert.throws(
        () => validateIsolationRoot(badPath, opts),
        (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_PRODUCTION_REJECTED",
        `Expected rejection for ${badPath}`,
      );
    }

    if (process.platform === "win32") {
      const upperProd12 = prod12.toUpperCase();
      assert.throws(
        () => validateIsolationRoot(upperProd12, opts),
        (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_PRODUCTION_REJECTED",
      );

      const junctionAlias = path.join(tempBase, "prod-junction");
      fs.symlinkSync(prod12, junctionAlias, "junction");
      assert.throws(
        () => validateIsolationRoot(junctionAlias, opts),
        (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_PRODUCTION_REJECTED",
      );
    }
  });
});

test("validateIsolationRoot rejects relative paths, temp root itself, and non-temp directories", () => {
  withTempWorkspace((root) => {
    const tempBase = path.join(root, "Temp");
    const nonTemp = path.join(root, "workspace-data");
    const appData = path.join(root, "Roaming");
    for (const d of [tempBase, nonTemp, appData]) fs.mkdirSync(d, { recursive: true });

    const opts = {
      appData,
      localAppData: path.join(root, "Local"),
      userProfile: path.join(root, "User"),
      tempDir: tempBase,
    };

    for (const invalid of ["", "   ", "relative/smoke"]) {
      assert.throws(
        () => validateIsolationRoot(invalid, opts),
        (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_INVALID",
      );
    }

    for (const nonTempPath of [tempBase, nonTemp]) {
      assert.throws(
        () => validateIsolationRoot(nonTempPath, opts),
        (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_NON_TEMP_REJECTED",
      );
    }
  });
});

test("resolveLaunchTarget enforces smoke profile, temp isolation root, and CDP port for packaged dir", () => {
  withTempWorkspace((root) => {
    const unpacked = path.join(root, "win-unpacked");
    const tempBase = path.join(root, "Temp");
    const appData = path.join(root, "Roaming");
    const isolation = path.join(tempBase, "smoke-case");
    fs.mkdirSync(path.join(unpacked, "resources"), { recursive: true });
    fs.writeFileSync(path.join(unpacked, "Firefly_Agent.exe"), "MZ-stub");
    fs.writeFileSync(path.join(unpacked, "resources", "app.asar"), "asar-stub");
    fs.mkdirSync(tempBase, { recursive: true });
    fs.mkdirSync(appData, { recursive: true });

    const isolationOptions = {
      appData,
      localAppData: path.join(root, "Local"),
      userProfile: path.join(root, "User"),
      tempDir: tempBase,
    };

    const spec = resolveLaunchTarget({
      unpackedDir: unpacked,
      dryRun: false,
      isolationRoot: isolation,
      cdpPort: 9333,
      isolationOptions,
    });
    assert.equal(spec.mode, "packaged");
    assert.equal(spec.executablePath, path.join(unpacked, "Firefly_Agent.exe"));
    assert.deepEqual(spec.args, [
      "--firefly-profile=smoke",
      `--firefly-isolation-root=${spec.isolationRoot}`,
      "--remote-debugging-port=9333",
    ]);

    // Must refuse launching if isolation points to production %APPDATA%\Firefly-1.2.0.
    assert.throws(
      () =>
        resolveLaunchTarget({
          unpackedDir: unpacked,
          dryRun: false,
          isolationRoot: path.join(appData, "Firefly-1.2.0"),
          cdpPort: 9333,
          isolationOptions,
        }),
      (err) => err instanceof SmokeIsolationError && err.code === "ISOLATION_PRODUCTION_REJECTED",
    );
  });
});

test("buildIsolatedEnv strips ELECTRON_RUN_AS_NODE and isolates AppData/Temp", () => {
  withTempWorkspace((root) => {
    const env = buildIsolatedEnv({
      workRoot: root,
      baseEnv: { PATH: "ok", ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
    assert.equal(env.FIREFLY_RUNTIME_PROFILE, "smoke");
    assert.equal(env.APPDATA, path.join(root, "appdata"));
    assert.equal(env.LOCALAPPDATA, path.join(root, "localappdata"));
    assert.equal(env.TEMP, path.join(root, "temp"));
  });
});

test("createProcessTracker isolates plugin utilityProcess PIDs and cleans up ONLY script-owned PIDs", () => {
  const killedCalls = [];
  const processes = [
    // Unrelated electron.exe processes running elsewhere on the machine: MUST NEVER BE KILLED.
    { ProcessId: 1001, ParentProcessId: 500, Name: "electron.exe", CommandLine: "electron.exe ." },
    { ProcessId: 1002, ParentProcessId: 1001, Name: "electron.exe", CommandLine: "electron.exe --type=utility --utility-sub-type=node.mojom.NodeService" },
    // Script-launched Firefly root process and its children:
    { ProcessId: 2000, ParentProcessId: 999, Name: "Firefly_Agent.exe", CommandLine: "Firefly_Agent.exe --firefly-profile=smoke" },
    { ProcessId: 2001, ParentProcessId: 2000, Name: "Firefly_Agent.exe", CommandLine: "Firefly_Agent.exe --type=gpu-process" },
    { ProcessId: 2002, ParentProcessId: 2000, Name: "Firefly_Agent.exe", CommandLine: "Firefly_Agent.exe --type=utility --utility-sub-type=network.mojom.NetworkService" },
    { ProcessId: 2003, ParentProcessId: 2000, Name: "Firefly_Agent.exe", CommandLine: "Firefly_Agent.exe --type=utility --utility-sub-type=node.mojom.NodeService" },
    { ProcessId: 2004, ParentProcessId: 2003, Name: "helper.exe", CommandLine: "helper.exe" },
  ];

  const tracker = createProcessTracker({
    queryProcesses: () => processes,
    killPid: (pid, opts) => {
      killedCalls.push({ pid, tree: Boolean(opts?.tree) });
    },
  });
  tracker.recordRootPid(2000);

  const pluginUtilityPids = tracker.findPluginUtilityProcessPids({
    cdpProcessInfo: [
      { id: 2002, type: "network.mojom.NetworkService" },
      { id: 2003, type: "node.mojom.NodeService" },
    ],
  });
  assert.deepEqual(pluginUtilityPids, [2003]);

  // Refuses killing unowned or root PIDs via plugin-kill helper.
  assert.throws(() => tracker.killPluginUtilityPids([1002]), /Refusing/);
  assert.throws(() => tracker.killPluginUtilityPids([2000]), /Refusing/);

  assert.deepEqual(tracker.killPluginUtilityPids([2003]), [2003]);
  assert.deepEqual(killedCalls, [{ pid: 2003, tree: false }]);

  killedCalls.length = 0;
  const cleaned = tracker.cleanup();
  assert.equal(cleaned.includes(1001), false);
  assert.equal(cleaned.includes(1002), false);
  assert.deepEqual(new Set(cleaned), new Set([2000, 2001, 2002, 2003, 2004]));
  assert.equal(killedCalls.at(-1)?.pid, 2000);
});

test("parseSmokeArgs parses dry-run, unpacked path, and options", () => {
  const dry = parseSmokeArgs(["--dry-run", "--cdp-port=9229", "--keep-isolation"]);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.cdpPort, 9229);
  assert.equal(dry.keepIsolation, true);

  const pkg = parseSmokeArgs(["release/win-unpacked", "--output-dir", "out/smoke"]);
  assert.equal(pkg.dryRun, false);
  assert.equal(pkg.unpackedDir, "release/win-unpacked");
  assert.equal(pkg.outputDir, "out/smoke");
});
