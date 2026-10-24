// Contract shared by every plugin shipped through the offline marketplace catalog (not the text-stats specifics).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { manifestErrors, pluginPath, readManifest, sandboxTools } from "./plugin-fixture.mjs";

const ported = {
  "json-tools": ["json-tools_validate", "json-tools_compare"],
  "timezone-tools": ["timezone-tools_canonicalize", "timezone-tools_convert"],
  "code-language": ["code-language_detect"],
  "text-trim": ["text-trim_cap"],
};
const DEEPSEEK_NOTICE = "Copyright (c) 2026 DeepSeek";
const FORBIDDEN_SOURCE = /\b(?:require|process|Buffer|TextEncoder|TextDecoder|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate|globalThis|eval|Function|import)\b\s*[(.[]?/;

for (const [id, toolIds] of Object.entries(ported)) {
  test(`${id}: manifest matches the host schema as a disabled offline API v1 plugin without host deps`, () => {
    const manifest = readManifest(id);
    assert.deepEqual(manifestErrors(manifest), []);
    assert.equal(manifest.id, id);
    assert.equal(manifest.version, "1.0.1");
    assert.equal(manifest.apiVersion, 1);
    assert.equal(manifest.entry, "index.cjs");
    assert.equal(manifest.defaultEnabled, false);
    assert.deepEqual(manifest.deps ?? [], []);
    assert.match(manifest.author, /Firefly-0423/);
    assert.match(manifest.author, /deepseek-harness/, "author must name the adapted source");
  });

  test(`${id}: ships a README and a LICENSE that keeps the DeepSeek MIT notice alongside the Firefly copyright`, () => {
    const license = readFileSync(pluginPath(id, "LICENSE"), "utf8");
    assert.match(license, /^MIT License/);
    assert.ok(license.includes(DEEPSEEK_NOTICE), "DeepSeek copyright notice must be retained");
    assert.ok(license.includes("https://github.com/deepseek-ai/deepseek-harness"));
    assert.ok(license.includes("Copyright (c) 2026 Firefly-0423"));
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.deepEqual(license.match(/^Copyright .+$/gm), ["Copyright (c) 2026 Firefly-0423", `${DEEPSEEK_NOTICE}, used under the MIT License.`], "retain exactly the Firefly and DeepSeek copyright notices");
    assert.ok(existsSync(pluginPath(id, "README.md")));
    assert.ok(existsSync(pluginPath(id, "catalog.json")));
    const catalog = JSON.parse(readFileSync(pluginPath(id, "catalog.json"), "utf8"));
    assert.ok(Array.isArray(catalog.capabilities) && catalog.capabilities.length > 0);
    assert.ok(catalog.capabilities.every(line => typeof line === "string" && line.trim()));
  });

  test(`${id}: registers only safe read-only tools namespaced by the plugin id`, async () => {
    const { tools } = await sandboxTools(id);
    assert.deepEqual([...tools.keys()].sort(), [...toolIds].sort());
    for (const tool of tools.values()) {
      assert.ok(tool.id.startsWith(`${id}_`));
      assert.equal(tool.risk, "safe");
      assert.equal(tool.effectKind, "read");
      assert.equal(tool.verificationPolicy, "none");
      assert.equal(tool.enabled, true);
      assert.ok(tool.name && tool.description);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.required.length > 0);
      for (const name of tool.inputSchema.required) assert.ok(name in tool.inputSchema.properties);
      assert.equal(tool.needsContext, undefined);
    }
  });

  test(`${id}: source uses no Node, network, timer or dynamic-code facilities`, () => {
    const source = readFileSync(pluginPath(id, "index.cjs"), "utf8")
      .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    assert.doesNotMatch(source, FORBIDDEN_SOURCE);
  });

  test(`${id}: unregister releases every tool, is idempotent, and allows re-enable`, async () => {
    const { plugin, tools } = await sandboxTools(id);
    assert.equal(tools.size, toolIds.length);
    await plugin.unregister();
    assert.equal(tools.size, 0);
    await plugin.unregister();
    const ctx = { registerTool: tool => tools.set(tool.id, tool), unregisterTool: toolId => tools.delete(toolId) };
    await plugin.register(ctx);
    assert.equal(tools.size, toolIds.length);
    await assert.rejects(async () => plugin.register(ctx), /already registered/);
    await plugin.unregister();
    assert.equal(tools.size, 0);
  });
}
