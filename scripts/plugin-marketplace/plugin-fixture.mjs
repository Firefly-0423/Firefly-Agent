// Shared test fixture for the offline marketplace plugins. Not a *.test.mjs file, so `node --test` does not run it directly.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const examplesRoot = new URL("../../examples/", import.meta.url);

export function pluginPath(id, file) {
  return fileURLToPath(new URL(`${id}/${file}`, examplesRoot));
}

export function readManifest(id) {
  const file = pluginPath(id, "firefly.plugin.json");
  assert.ok(existsSync(file), `${id} manifest must exist`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Evaluates the plugin entry in a fresh VM context that has only JavaScript built-ins: no `require`, `process`,
 * `Buffer`, `TextEncoder`, timers or network globals. If the plugin touches any of them the load or call throws.
 * The entry is an ES module with a default export, so that export is turned into a CommonJS assignment for the VM.
 * Errors created inside the context belong to another realm, so tests match on messages instead of classes.
 *
 * `raw` holds the tool definitions exactly as the plugin registered them (v2 ToolResult). `tools` holds the same
 * tools with `execute` adapted for terse assertions: a succeeded result comes back as its output serialised to
 * JSON, anything else throws an Error carrying the reason.
 */
export async function sandboxTools(id) {
  const entry = pluginPath(id, "index.mjs");
  assert.ok(existsSync(entry), `${id} entry must exist`);
  const source = readFileSync(entry, "utf8");
  assert.equal(source.match(/^export default /gm)?.length, 1, "entry must have exactly one default export");
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source.replace(/^export default /m, "module.exports = "), sandbox, { timeout: 1000 });
  const raw = new Map();
  const tools = new Map();
  const plugin = sandbox.module.exports;
  await plugin.activate({
    tools: {
      register(tool) {
        assert.equal(raw.has(tool.name), false, "duplicate tool registration");
        raw.set(tool.name, tool);
        tools.set(tool.name, {
          ...tool,
          async execute(args) {
            const result = await tool.execute(args, undefined);
            if (result.status !== "succeeded") throw new Error(result.reason ?? result.error);
            return JSON.stringify(result.output);
          },
        });
        return {
          dispose() {
            assert.equal(raw.delete(tool.name), true, "dispose only an owned tool");
            tools.delete(tool.name);
          },
        };
      },
    },
  });
  return { plugin, raw, tools, call: async (toolId, args) => JSON.parse(await tools.get(toolId).execute(args)) };
}
