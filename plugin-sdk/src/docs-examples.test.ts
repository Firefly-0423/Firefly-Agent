import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { transformSync } from "esbuild";
import * as vitest from "vitest";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../src/shared/plugin-manifest";
import * as sdk from "./index";
import * as sdkTesting from "./testing/index";

const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const repoRoot = path.resolve(__dirname, "..", "..");

interface DocBlock {
  kind: string;
  id: string;
  manifestRef?: string;
  pluginRef?: string;
  lang: string;
  code: string;
  sourceFile: string;
}

function extractDocBlocks(relativePath: string): DocBlock[] {
  const fullPath = path.join(repoRoot, relativePath);
  const content = readFileSync(fullPath, "utf8");
  const pattern = /<!--\s*doc-example:\s*([^\r\n]+?)\s*-->\s*\r?\n```([a-zA-Z0-9_-]+)\r?\n([\s\S]*?)\r?\n```/g;
  const blocks: DocBlock[] = [];

  for (const match of content.matchAll(pattern)) {
    const metaTokens = match[1].trim().split(/\s+/);
    const kind = metaTokens[0];
    const attrs: Record<string, string> = {};
    for (const token of metaTokens.slice(1)) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        attrs[token.slice(0, eq)] = token.slice(eq + 1);
      }
    }
    if (!kind || !attrs.id) {
      throw new Error(`Invalid doc-example header in ${relativePath}: ${match[1]}`);
    }
    blocks.push({
      kind,
      id: attrs.id,
      manifestRef: attrs.manifest,
      pluginRef: attrs.plugin,
      lang: match[2],
      code: match[3],
      sourceFile: relativePath,
    });
  }
  return blocks;
}

function evaluateDocModule(block: DocBlock): Record<string, unknown> {
  const loader = block.lang === "ts" ? "ts" : "js";
  const transformed = transformSync(block.code, {
    loader,
    format: "cjs",
    target: "node20",
  });
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const localRequire = (specifier: string): unknown => {
    if (specifier === "@firefly_wu/plugin-sdk") return sdk;
    if (specifier === "@firefly_wu/plugin-sdk/testing") return sdkTesting;
    if (specifier === "vitest") return vitest;
    throw new Error(`Unexpected import "${specifier}" in doc example ${block.sourceFile}#${block.id}`);
  };
  const fn = new Function("exports", "require", "module", transformed.code);
  fn(moduleObj.exports, localRequire, moduleObj);
  return moduleObj.exports;
}

describe("SDK 1.2.0 documentation executable examples", () => {
  const docFiles = [
    "plugin-sdk/README.md",
    "plugin-sdk/LIFECYCLE.md",
    "docs/plugins/plugin-authoring.md",
    "docs/plugins/plugin-dev-guide.md",
  ];

  const readmeBlocks = extractDocBlocks("plugin-sdk/README.md");
  const guideBlocks = extractDocBlocks("docs/plugins/plugin-dev-guide.md");
  const allBlocks = [...readmeBlocks, ...guideBlocks];

  const manifests = new Map<string, sdkTesting.TestHostManifest>();
  for (const block of allBlocks.filter((b) => b.kind === "manifest")) {
    manifests.set(block.id, JSON.parse(block.code) as sdkTesting.TestHostManifest);
  }

  it("extracts expected manifest, plugin, snippet, and test blocks from README and dev guide", () => {
    expect(readmeBlocks.map((b) => `${b.kind}:${b.id}`)).toEqual([
      "manifest:readme-minimal",
      "plugin:readme-minimal",
      "snippet:readme-tool-results",
      "test:readme-testhost",
    ]);
    expect(guideBlocks.map((b) => `${b.kind}:${b.id}`)).toEqual([
      "manifest:guide-notes",
      "plugin:guide-notes",
      "test:guide-notes",
    ]);
  });

  it("validates every documented firefly.plugin.json against manifest.schema.json and validateManifest", () => {
    const schema = JSON.parse(
      readFileSync(path.join(repoRoot, "src/shared/plugin-manifest/manifest.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const ajv = new AjvCtor({ allErrors: true });
    const checkSchema = ajv.compile(schema);

    expect(manifests.size).toBeGreaterThanOrEqual(2);
    for (const [id, manifest] of manifests.entries()) {
      expect(checkSchema(manifest), `schema validation failed for ${id}: ${ajv.errorsText(checkSchema.errors)}`).toBe(true);
      const checked = validateManifest(manifest, { hostVersion: "1.2.0" });
      expect(checked.ok, `validateManifest failed for ${id}: ${JSON.stringify(checked.errors)}`).toBe(true);
    }
  });

  it("executes all documented plugin and createTestHost test blocks end-to-end", async () => {
    const plugins = new Map<string, Record<string, unknown>>();
    for (const block of allBlocks.filter((b) => b.kind === "plugin")) {
      plugins.set(block.id, evaluateDocModule(block));
    }

    const testBlocks = allBlocks.filter((b) => b.kind === "test");
    expect(testBlocks.length).toBeGreaterThanOrEqual(2);

    for (const testBlock of testBlocks) {
      const manifest = manifests.get(testBlock.manifestRef ?? "");
      const pluginMod = plugins.get(testBlock.pluginRef ?? "");
      expect(manifest, `missing manifest ${testBlock.manifestRef}`).toBeDefined();
      expect(pluginMod, `missing plugin ${testBlock.pluginRef}`).toBeDefined();

      const plugin = (pluginMod?.default ?? pluginMod) as sdk.PluginDefinition;
      const testMod = evaluateDocModule(testBlock);
      const runner = Object.values(testMod).find((v) => typeof v === "function") as
        | ((m: sdkTesting.TestHostManifest, p: sdk.PluginDefinition) => Promise<void>)
        | undefined;
      expect(typeof runner, `no exported test runner in ${testBlock.id}`).toBe("function");
      await runner!(manifest!, plugin);
    }
  });

  it("executes the ToolResult four-state snippet from README.md", () => {
    const block = readmeBlocks.find((b) => b.kind === "snippet" && b.id === "readme-tool-results");
    expect(block).toBeDefined();
    const mod = evaluateDocModule(block!);
    const formatResultExample = mod.formatResultExample as (kind: sdk.ToolResult["status"]) => sdk.ToolResult;

    expect(formatResultExample("succeeded").status).toBe("succeeded");
    expect(formatResultExample("failed")).toMatchObject({ status: "failed", retryable: true });
    expect(formatResultExample("unknown")).toMatchObject({ status: "unknown" });
    expect(formatResultExample("not_executed").status).toBe("not_executed");
  });

  it("keeps relative markdown links valid and avoids forbidden legacy naming", () => {
    const forbidden = new RegExp(["cy", "rene"].join(""), "i");
    for (const rel of docFiles) {
      const full = path.join(repoRoot, rel);
      const text = readFileSync(full, "utf8");
      expect(forbidden.test(text), `forbidden term found in ${rel}`).toBe(false);

      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        const resolved = path.resolve(repoRoot, path.dirname(rel), decodeURIComponent(target));
        expect(existsSync(resolved), `broken link in ${rel}: ${target}`).toBe(true);
      }
    }
  });
});
