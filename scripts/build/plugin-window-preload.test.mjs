import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { buildPluginWindowPreload } from "./plugin-window-preload.mjs";

test("plugin window preload bundle only requires electron and exposes fireflyPlugin under a sandbox-style require", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "plugin-window-preload-"));
  try {
    const outfile = path.join(dir, "plugin-window.js");
    await buildPluginWindowPreload({ outfile });
    const source = await readFile(outfile, "utf8");
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(required)], ["electron"]);

    const exposed = {};
    const requested = [];
    const sandboxRequire = id => {
      requested.push(id);
      if (id !== "electron") throw new Error(`sandboxed preload cannot require ${id}`);
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
        ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
      };
    };
    vm.runInNewContext(source, { require: sandboxRequire, module: { exports: {} }, exports: {}, console });
    assert.deepEqual(requested, ["electron"]);
    assert.deepEqual(Object.keys(exposed), ["fireflyPlugin"]);
    assert.deepEqual(Object.keys(exposed.fireflyPlugin).sort(), ["close", "getState", "invoke", "onMessage"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
