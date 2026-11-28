// Contract shared by every plugin shipped through the offline marketplace catalog (not the text-stats specifics).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { pluginPath, readManifest, sandboxTools } from "./plugin-fixture.mjs";

const ported = {
  "json-tools": ["json-tools_validate", "json-tools_compare"],
  "timezone-tools": ["timezone-tools_canonicalize", "timezone-tools_convert"],
  "code-language": ["code-language_detect"],
  "text-trim": ["text-trim_cap"],
};
const DEEPSEEK_NOTICE = "Copyright (c) 2026 DeepSeek";
const FORBIDDEN_SOURCE = /\b(?:require|process|Buffer|TextEncoder|TextDecoder|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate|globalThis|eval|Function|import)\b\s*[(.[]?/;

for (const [id, toolIds] of Object.entries(ported)) {
  test(`${id}: manifest is an offline v2 package without native code, permissions or UI, and its tools match what the entry registers`, async () => {
    const manifest = readManifest(id);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.id, `dev.firefly.${id}`);
    assert.equal(manifest.version, "1.0.1");
    assert.equal(manifest.main, "index.mjs");
    assert.equal(manifest.native, false);
    assert.deepEqual(manifest.permissions ?? [], []);
    assert.equal(manifest.ui, undefined);
    assert.match(manifest.author.name, /Firefly-0423/);
    assert.match(manifest.author.name, /deepseek-harness/, "author must name the adapted source");
    assert.deepEqual(manifest.tools.map(tool => tool.name).sort(), [...toolIds].sort());
    const { raw } = await sandboxTools(id);
    assert.deepEqual([...raw.keys()].sort(), [...toolIds].sort());
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

  test(`${id}: registers only the declared tools, each with a described object schema whose required fields exist`, async () => {
    const { raw } = await sandboxTools(id);
    for (const tool of raw.values()) {
      assert.ok(tool.name.startsWith(`${id}_`));
      assert.ok(tool.description);
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.required.length > 0);
      for (const name of tool.parameters.required) assert.ok(name in tool.parameters.properties);
      assert.equal(typeof tool.execute, "function");
    }
  });

  test(`${id}: source uses no Node, network, timer or dynamic-code facilities`, () => {
    const source = readFileSync(pluginPath(id, "index.mjs"), "utf8")
      .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    assert.doesNotMatch(source, FORBIDDEN_SOURCE);
  });

  test(`${id}: deactivate releases every tool, is idempotent, and allows re-activation`, async () => {
    const { plugin, raw } = await sandboxTools(id);
    assert.equal(raw.size, toolIds.length);
    await plugin.deactivate();
    assert.equal(raw.size, 0);
    await plugin.deactivate();
    assert.equal(raw.size, 0);
    const again = await sandboxTools(id);
    assert.equal(again.raw.size, toolIds.length);
    await again.plugin.deactivate();
    assert.equal(again.raw.size, 0);
  });
}
