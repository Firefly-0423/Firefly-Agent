import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const entry = new URL("../../examples/text-stats/index.cjs", import.meta.url);
const manifestPath = new URL("../../examples/text-stats/manifest.json", import.meta.url);
const require = createRequire(import.meta.url);

function pluginWithContext() {
  assert.ok(existsSync(entry), "text-stats plugin entry must exist");
  const plugin = require(fileURLToPath(entry));
  const tools = new Map();
  const ctx = {
    registerTool(tool) {
      assert.equal(tools.has(tool.id), false, "duplicate tool registration");
      tools.set(tool.id, tool);
    },
    unregisterTool(id) {
      assert.equal(tools.delete(id), true, "unregister only an owned tool");
    },
  };
  return { plugin, ctx, tools };
}

async function toolFixture(t) {
  const fixture = pluginWithContext();
  t.after(() => fixture.plugin.unregister());
  await fixture.plugin.register(fixture.ctx);
  assert.equal(fixture.tools.size, 1);
  return fixture.tools.get("text-stats_count");
}

test("text-stats manifest matches the actual host schema and disabled API v1 contract", () => {
  assert.ok(existsSync(manifestPath), "text-stats manifest must exist");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../../src/plugins/manifest.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.id, "text-stats");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.defaultEnabled, false);
  assert.equal(manifest.entry, "index.cjs");
  assert.deepEqual(manifest.deps ?? [], []);
});

test("registers a safe read-only SDK-shaped text tool", async t => {
  const tool = await toolFixture(t);
  assert.equal(tool.risk, "safe");
  assert.equal(tool.effectKind, "read");
  assert.equal(tool.verificationPolicy, "none");
  assert.equal(tool.enabled, true);
  assert.ok(tool.name && tool.description);
  assert.deepEqual(tool.inputSchema.required, ["text"]);
  assert.equal(tool.inputSchema.properties.text.type, "string");
  const result = await tool.execute({ text: "Hello world\nSecond line" });
  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), { characters: 23, words: 4, nonEmptyLines: 2 });
});

test("counts Unicode code points, whitespace-separated words, and nonempty lines", async t => {
  const tool = await toolFixture(t);
  assert.deepEqual(JSON.parse(await tool.execute({ text: "A😀 e\u0301\r\n\t\r世界\u2028x\u2029 " })), {
    characters: 15, words: 4, nonEmptyLines: 3,
  });
  assert.deepEqual(JSON.parse(await tool.execute({ text: "" })), { characters: 0, words: 0, nonEmptyLines: 0 });
  assert.deepEqual(JSON.parse(await tool.execute({ text: " \t\r\n" })), { characters: 4, words: 0, nonEmptyLines: 0 });
});

test("rejects missing or non-string text rather than coercing data", async t => {
  const tool = await toolFixture(t);
  for (const args of [{}, { text: 3 }, { text: null }, null, undefined, { text: ["hello"] }]) {
    await assert.rejects(tool.execute(args), /text must be a string/);
  }
});

test("unregister is idempotent, releases the tool, and allows re-enable", async () => {
  const { plugin, ctx, tools } = pluginWithContext();
  await plugin.register(ctx);
  await plugin.unregister();
  assert.equal(tools.size, 0);
  await plugin.unregister();
  await plugin.register(ctx);
  assert.equal(tools.size, 1);
  await plugin.unregister();
  assert.equal(tools.size, 0);
});

test("plugin loads and counts without any Node, network, filesystem, or timer globals", async () => {
  assert.ok(existsSync(entry), "text-stats plugin entry must exist");
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(readFileSync(entry, "utf8"), sandbox, { timeout: 1000 });
  const tools = new Map();
  await sandbox.module.exports.register({
    registerTool: tool => tools.set(tool.id, tool),
    unregisterTool: id => tools.delete(id),
  });
  assert.deepEqual(JSON.parse(await tools.get("text-stats_count").execute({ text: "offline 😀" })), {
    characters: 9, words: 2, nonEmptyLines: 1,
  });
  await sandbox.module.exports.unregister();
  assert.equal(tools.size, 0);
});
