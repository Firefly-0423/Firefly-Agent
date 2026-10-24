import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import JSZip from "jszip";

const builderUrl = new URL("./build.mjs", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginIds = ["text-stats", "json-tools", "timezone-tools", "code-language", "text-trim"];
const zipName = id => `${id}-1.0.0.zip`;
// Pin the reviewed local package bytes; building does not publish a hosted release.
const TEXT_STATS_SHA256 = "b0294a0535b0cd34ff4ba28735fdb0e762805ecdece23639133eec7a111eb84b";

async function builder() {
  assert.ok(existsSync(builderUrl), "marketplace artifact builder must exist");
  const module = await import(builderUrl.href);
  assert.equal(typeof module.buildMarketplace, "function");
  return module.buildMarketplace;
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "firefly-marketplace-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
const lf = text => text.replace(/\r\n/g, "\n");

test("bundled catalog lists every plugin with a checksummed disabled API v1 package and root manifest", async t => {
  const build = await builder();
  const outDir = await fixture(t);
  const result = await build({ outDir });
  const registry = await json(path.join(outDir, "registry.json"));
  assert.equal(result.registryPath, path.join(outDir, "registry.json"));
  assert.deepEqual((await readdir(outDir)).sort(), ["registry.json", ...pluginIds.map(zipName)].sort());
  assert.equal(registry.apiVersion, 1);
  assert.deepEqual(registry.plugins.map(entry => entry.id), pluginIds);
  assert.deepEqual(result.plugins.map(plugin => plugin.id), pluginIds);
  // Compatibility for callers that only know the first plugin.
  assert.equal(result.zipPath, path.join(outDir, zipName("text-stats")));
  assert.equal(result.sha256, registry.plugins[0].sha256);
  const schema = await json(path.join(repoRoot, "src/plugins/manifest.schema.json"));
  const validate = new Ajv({ strict: false }).compile(schema);
  const seenHashes = new Set();
  for (const entry of registry.plugins) {
    const bytes = await readFile(path.join(outDir, zipName(entry.id)));
    assert.equal(entry.zip, `bundled:${zipName(entry.id)}`);
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    seenHashes.add(entry.sha256);
    assert.equal(entry.downloads, 0);
    assert.equal(entry.pluginApiVersion, 1);
    const catalog = await json(path.join(repoRoot, "examples", entry.id, "catalog.json"));
    assert.deepEqual(entry.capabilities, catalog.capabilities);
    assert.ok(entry.capabilities.length > 0 && entry.capabilities.every(x => typeof x === "string" && x.trim()));
    const zip = await JSZip.loadAsync(bytes);
    assert.deepEqual(Object.keys(zip.files), ["LICENSE", "README.md", "index.cjs", "manifest.json"]);
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    for (const key of ["id", "name", "version", "description", "author"]) assert.equal(entry[key], manifest[key]);
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.defaultEnabled, false);
    assert.equal(manifest.apiVersion, entry.pluginApiVersion);
    assert.equal(manifest.entry, "index.cjs");
    assert.deepEqual(manifest.deps ?? [], []);
    for (const name of ["index.cjs", "LICENSE", "README.md"]) {
      assert.equal(await zip.file(name).async("string"), lf(await readFile(path.join(repoRoot, "examples", entry.id, name), "utf8")));
    }
    for (const file of Object.values(zip.files)) {
      assert.equal(file.dir, false);
      assert.equal(file.date.toISOString(), "1980-01-01T00:00:00.000Z");
      assert.equal(file.unixPermissions, 0o100644);
    }
  }
  assert.equal(seenHashes.size, pluginIds.length, "every package must be distinct");
});

test("text-stats 1.0.0 stays byte-identical to the reviewed local package", async t => {
  const build = await builder();
  const result = await build({ outDir: await fixture(t) });
  assert.equal(result.plugins.find(plugin => plugin.id === "text-stats").sha256, TEXT_STATS_SHA256);
});

test("repeated builds in different directories and time zones are byte-for-byte identical", async t => {
  const build = await builder();
  const root = await fixture(t);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await build({ outDir: first });
  const cli = spawnSync(process.execPath, [fileURLToPath(builderUrl), "--out-dir", second], {
    cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, TZ: "Pacific/Honolulu" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  for (const id of pluginIds) assert.match(cli.stdout, new RegExp(`${zipName(id)} \\(SHA-256 [0-9a-f]{64}\\)`));
  for (const name of [...pluginIds.map(zipName), "registry.json"]) {
    assert.deepEqual(await readFile(path.join(first, name)), await readFile(path.join(second, name)));
  }
});

test("public mode gives each plugin its own <id>-<version> release tag unless one tag is named", async t => {
  const build = await builder();
  const root = await fixture(t);
  const options = { outDir: path.join(root, "per-plugin"), repository: "example-owner/example-repo", registryRef: "catalog-v1" };
  const result = await build(options);
  const registry = await json(path.join(options.outDir, "marketplace/registry.json"));
  const config = await json(path.join(options.outDir, "marketplace-config.json"));
  assert.equal(result.registryPath, path.join(options.outDir, "marketplace/registry.json"));
  assert.equal(result.configPath, path.join(options.outDir, "marketplace-config.json"));
  assert.deepEqual(registry.plugins.map(entry => entry.zip), pluginIds.map(id =>
    `https://github.com/example-owner/example-repo/releases/download/${id}-1.0.0/${zipName(id)}`));
  assert.deepEqual(config, {
    registryUrls: ["https://raw.githubusercontent.com/example-owner/example-repo/catalog-v1/marketplace/registry.json"],
    zipUrlPrefixes: ["https://github.com/example-owner/example-repo/releases/download/"],
  });
  assert.equal(existsSync(path.join(options.outDir, "registry.json")), false);
  const firstRegistry = await readFile(result.registryPath);
  await build(options);
  assert.deepEqual(await readFile(result.registryPath), firstRegistry);

  const single = await build({ ...options, outDir: path.join(root, "single"), tag: "plugins-v1.0.0" });
  const singleRegistry = await json(single.registryPath);
  assert.deepEqual(singleRegistry.plugins.map(entry => entry.zip), pluginIds.map(id =>
    `https://github.com/example-owner/example-repo/releases/download/plugins-v1.0.0/${zipName(id)}`));
});

test("public text-stats URL formatting preserves the repository settings", async t => {
  const build = await builder();
  const result = await build({ outDir: await fixture(t), repository: "Firefly-0423/firefly-plugins", registryRef: "plugin-catalog" });
  const registry = await json(result.registryPath);
  const textStats = registry.plugins.find(entry => entry.id === "text-stats");
  assert.equal(textStats.zip, "https://github.com/Firefly-0423/firefly-plugins/releases/download/text-stats-1.0.0/text-stats-1.0.0.zip");
  assert.equal(textStats.sha256, TEXT_STATS_SHA256);
});

test("public and bundled modes use identical ZIP bytes and SHA-256 for every plugin", async t => {
  const build = await builder();
  const root = await fixture(t);
  const bundled = await build({ outDir: path.join(root, "bundled") });
  const published = await build({ outDir: path.join(root, "public"), repository: "owner/repo", tag: "v1.0.0", registryRef: "main" });
  for (const [index, plugin] of bundled.plugins.entries()) {
    assert.deepEqual(await readFile(plugin.zipPath), await readFile(published.plugins[index].zipPath));
  }
  assert.deepEqual((await json(bundled.registryPath)).plugins.map(entry => entry.sha256),
    (await json(published.registryPath)).plugins.map(entry => entry.sha256));
});

test("rejects incomplete or unsafe public options before creating outputs", async t => {
  const build = await builder();
  const root = await fixture(t);
  const valid = { repository: "owner/repo", tag: "v1.0.0", registryRef: "main" };
  const invalid = [
    { repository: "owner/repo" }, { tag: "v1" }, { registryRef: "main" }, { repository: "owner/repo", tag: "v1" },
    { ...valid, repository: "https://github.com/owner/repo" },
    { ...valid, repository: "owner/repo/extra" }, { ...valid, repository: "../repo" },
    { ...valid, repository: "owner/repo?token=secret" },
    { ...valid, tag: "../escape" }, { ...valid, tag: "v1?token=secret" },
    { ...valid, tag: "refs//tags/v1" }, { ...valid, tag: "tag.lock" }, { ...valid, tag: "" },
    { ...valid, registryRef: "main#fragment" }, { ...valid, registryRef: "/main" },
    { ...valid, registryRef: "main\\evil" }, { ...valid, registryRef: "a/../main" },
    { ...valid, registryRef: "main " }, { ...valid, registryRef: "" },
    { unexpected: true },
  ];
  for (const [index, options] of invalid.entries()) {
    const outDir = path.join(root, String(index));
    await assert.rejects(build({ outDir, ...options }), /invalid|requires|unknown/i);
    assert.equal(existsSync(outDir), false);
  }
  for (const outDir of ["", " ", 123, null]) await assert.rejects(build({ outDir }), /outDir/i);
  await assert.rejects(build(valid), /outDir/i);
  await assert.rejects(build({ ...valid, outDir: path.join(repoRoot, "resources/plugin-marketplace") }), /bundled/i);
});

test("CLI rejects unknown, duplicate, and missing arguments without success claims", async t => {
  await builder();
  const root = await fixture(t);
  for (const args of [["--unknown"], ["--out-dir"], ["--tag", "--repository", "owner/repo"], ["--out-dir", root, "--out-dir", root]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(builderUrl), ...args], { encoding: "utf8", cwd: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown|requires|duplicate/i);
    assert.doesNotMatch(result.stdout, /ready|built|published/i);
  }
  assert.deepEqual(await readdir(root), []);
});

test("public CLI explicitly reports preparation without claiming hosted availability", async t => {
  await builder();
  const outDir = await fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(builderUrl), "--out-dir", outDir,
    "--repository", "owner/repo", "--registry-ref", "main"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prepared/i);
  assert.match(result.stdout, /not published/i);
  assert.doesNotMatch(result.stdout, /online ready|marketplace is live/i);
});

// Isolate source changes under the owned script directory; parent node_modules stays resolvable.
async function sourceFixture(t) {
  const root = await mkdtemp(path.join(repoRoot, "scripts/plugin-marketplace/.test-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["scripts/plugin-marketplace/build.mjs", "src/plugins/manifest.schema.json", "src/shared/version.ts", "src/plugins/api.ts"]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(root, file));
  }
  for (const id of pluginIds) await cp(path.join(repoRoot, "examples", id), path.join(root, "examples", id), { recursive: true });
  const { buildMarketplace } = await import(pathToFileURL(path.join(root, "scripts/plugin-marketplace/build.mjs")).href);
  return { root, build: buildMarketplace };
}

test("rejects slash-bearing tags and registry refs rather than generating forbidden encoded separators", async t => {
  const build = await builder();
  const root = await fixture(t);
  for (const [key, value] of [["tag", "plugins/v1"], ["registryRef", "catalog/main"], ["tag", "v1%2Fescape"]]) {
    const outDir = path.join(root, key + value.replace(/\W/g, "-"));
    await assert.rejects(build({ outDir, repository: "owner/repo", tag: "v1", registryRef: "main", [key]: value }), /invalid/i);
    assert.equal(existsSync(outDir), false);
  }
  const result = await build({ outDir: path.join(root, "sha"), repository: "owner/repo", tag: "v1.0.0", registryRef: "a".repeat(40) });
  const config = await json(result.configPath);
  assert.equal(config.registryUrls[0], `https://raw.githubusercontent.com/owner/repo/${"a".repeat(40)}/marketplace/registry.json`);
});

test("bumping a source manifest to another valid SemVer determines the filename and catalog version", async t => {
  const { root, build } = await sourceFixture(t);
  const manifestPath = path.join(root, "examples/json-tools/manifest.json");
  const manifest = await json(manifestPath);
  manifest.version = "1.2.3-beta.1+Build.2";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await build({ outDir: path.join(root, "output") });
  const bumped = result.plugins.find(plugin => plugin.id === "json-tools");
  assert.equal(path.basename(bumped.zipPath), "json-tools-1.2.3-beta.1+Build.2.zip");
  const catalog = await json(result.registryPath);
  const entry = catalog.plugins.find(item => item.id === "json-tools");
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.zip, "bundled:json-tools-1.2.3-beta.1+Build.2.zip");
  assert.equal(catalog.plugins.find(item => item.id === "text-stats").version, "1.0.0");
  for (const version of ["01.2.3", "1.2", "1.2.3 ", "../evil", "1.0.0-beta.01"]) {
    manifest.version = version;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(build({ outDir: path.join(root, "invalid") }), /invalid/i);
  }
  assert.equal(existsSync(path.join(root, "invalid")), false);
});

test("refuses plugins whose manifest or catalog.json breaks the catalog contract, without creating outputs", async t => {
  const { root, build } = await sourceFixture(t);
  const manifestPath = path.join(root, "examples/text-trim/manifest.json");
  const catalogPath = path.join(root, "examples/text-trim/catalog.json");
  const manifest = await json(manifestPath);
  const catalog = await json(catalogPath);
  const outDir = path.join(root, "output");
  const manifestCases = [
    { ...manifest, id: "other-id" }, { ...manifest, defaultEnabled: true }, { ...manifest, deps: ["llm"] },
    { ...manifest, entry: "main.cjs" }, { ...manifest, apiVersion: 2 }, { ...manifest, extra: true },
  ];
  for (const bad of manifestCases) {
    await writeFile(manifestPath, JSON.stringify(bad));
    await assert.rejects(build({ outDir }), /text-trim manifest/);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const catalogCases = [{}, { capabilities: [] }, { capabilities: [""] }, { capabilities: [1] }, { capabilities: Array(21).fill("x") },
    { capabilities: ["x".repeat(501)] }, { ...catalog, extra: 1 }, []];
  for (const bad of catalogCases) {
    await writeFile(catalogPath, JSON.stringify(bad));
    await assert.rejects(build({ outDir }), /text-trim catalog\.json/);
  }
  assert.equal(existsSync(outDir), false);
});

test("the publishing guide lists every catalog package with its current tag and SHA-256", async t => {
  const build = await builder();
  const result = await build({ outDir: await fixture(t) });
  const guide = await readFile(path.join(repoRoot, "docs/plugin-catalog-publishing.md"), "utf8");
  assert.equal(result.plugins.length, pluginIds.length);
  for (const plugin of result.plugins) {
    assert.ok(guide.includes(`\`${plugin.id}-${plugin.version}\` | \`${plugin.sha256}\``), `${plugin.id} row with its current hash`);
  }
});
