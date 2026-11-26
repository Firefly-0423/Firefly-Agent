import assert from "node:assert/strict";
import test from "node:test";
import { readManifest, sandboxTools } from "./plugin-fixture.mjs";

async function toolFixture() {
  const { tools, raw } = await sandboxTools("text-stats");
  assert.equal(tools.size, 1);
  return { tool: tools.get("text-stats_count"), raw: raw.get("text-stats_count") };
}

test("text-stats manifest is an offline v2 package with no permissions", () => {
  const manifest = readManifest("text-stats");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "dev.firefly.text-stats");
  assert.equal(manifest.version, "1.0.1");
  assert.equal(manifest.main, "index.mjs");
  assert.equal(manifest.native, false);
  assert.deepEqual(manifest.permissions ?? [], []);
  assert.deepEqual(manifest.tools.map(tool => tool.name), ["text-stats_count"]);
});

test("registers a text tool whose schema requires text and that reports a succeeded result", async () => {
  const { tool, raw } = await toolFixture();
  assert.ok(raw.name && raw.description);
  assert.deepEqual(JSON.parse(JSON.stringify(raw.parameters.required)), ["text"]);
  assert.equal(raw.parameters.properties.text.type, "string");
  const result = await raw.execute({ text: "Hello world\nSecond line" });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: "succeeded", output: { characters: 23, words: 4, nonEmptyLines: 2 } });
  assert.deepEqual(JSON.parse(await tool.execute({ text: "Hello world\nSecond line" })), { characters: 23, words: 4, nonEmptyLines: 2 });
});

test("counts Unicode code points, whitespace-separated words, and nonempty lines", async () => {
  const { tool } = await toolFixture();
  assert.deepEqual(JSON.parse(await tool.execute({ text: "A😀 é\r\n\t\r世界 x  " })), {
    characters: 15, words: 4, nonEmptyLines: 3,
  });
  assert.deepEqual(JSON.parse(await tool.execute({ text: "" })), { characters: 0, words: 0, nonEmptyLines: 0 });
  assert.deepEqual(JSON.parse(await tool.execute({ text: " \t\r\n" })), { characters: 4, words: 0, nonEmptyLines: 0 });
});

test("missing or non-string text is reported as not executed rather than coerced", async () => {
  const { tool, raw } = await toolFixture();
  for (const args of [{}, { text: 3 }, { text: null }, null, undefined, { text: ["hello"] }]) {
    assert.deepEqual(JSON.parse(JSON.stringify(await raw.execute(args))), { status: "not_executed", reason: "text must be a string" });
    await assert.rejects(tool.execute(args), /text must be a string/);
  }
});

test("deactivate releases the tool, and the plugin can activate again", async () => {
  const first = await sandboxTools("text-stats");
  await first.plugin.deactivate();
  assert.equal(first.raw.size, 0);
  const second = await sandboxTools("text-stats");
  assert.equal(second.raw.size, 1);
  await second.plugin.deactivate();
  assert.equal(second.raw.size, 0);
});

test("plugin loads and counts without any Node, network, filesystem, or timer globals", async () => {
  const { call, plugin, raw } = await sandboxTools("text-stats");
  assert.deepEqual(await call("text-stats_count", { text: "offline 😀" }), { characters: 9, words: 2, nonEmptyLines: 1 });
  await plugin.deactivate();
  assert.equal(raw.size, 0);
});
