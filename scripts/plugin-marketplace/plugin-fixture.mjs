// Shared test fixture for the offline marketplace plugins. Not a *.test.mjs file, so `node --test` does not run it directly.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const examplesRoot = new URL("../../examples/", import.meta.url);

export function pluginPath(id, file) {
  return fileURLToPath(new URL(`${id}/${file}`, examplesRoot));
}

export function readManifest(id) {
  const file = pluginPath(id, "manifest.json");
  assert.ok(existsSync(file), `${id} manifest must exist`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function manifestErrors(manifest) {
  const schema = JSON.parse(readFileSync(new URL("../../src/plugins/manifest.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false }).compile(schema);
  return validate(manifest) ? [] : validate.errors;
}

/**
 * Evaluates the plugin entry in a fresh VM context that has only JavaScript built-ins: no `require`, `process`,
 * `Buffer`, `TextEncoder`, timers or network globals. If the plugin touches any of them the load or call throws.
 * Errors created inside the context belong to another realm, so tests match on messages instead of classes.
 */
export async function sandboxTools(id) {
  const entry = pluginPath(id, "index.cjs");
  assert.ok(existsSync(entry), `${id} entry must exist`);
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(readFileSync(entry, "utf8"), sandbox, { timeout: 1000 });
  const tools = new Map();
  const plugin = sandbox.module.exports;
  await plugin.register({
    registerTool(tool) {
      assert.equal(tools.has(tool.id), false, "duplicate tool registration");
      tools.set(tool.id, tool);
    },
    unregisterTool(toolId) {
      assert.equal(tools.delete(toolId), true, "unregister only an owned tool");
    },
  });
  return { plugin, tools, call: async (toolId, args) => JSON.parse(await tools.get(toolId).execute(args)) };
}
