import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultOutDir = path.join(repoRoot, "resources", "plugin-marketplace");
const examplesDir = path.join(repoRoot, "examples");
// Every plugin shipped through the catalog, in catalog order. Adding one means adding its directory under examples/
// (firefly.plugin.json, index.mjs, README.md, LICENSE, plus catalog.json with the capability lines shown to users).
export const CATALOG_PLUGIN_IDS = ["text-stats", "json-tools", "timezone-tools", "code-language", "text-trim"];
const PACKAGE_FILES = ["LICENSE", "README.md", "index.mjs", "firefly.plugin.json"];
const REGISTRY_API_VERSION = 2;
const allowedOptions = new Set(["outDir", "repository", "tag", "registryRef"]);
const publicOptionNames = ["repository", "tag", "registryRef"];
const catalogPath = "marketplace/registry.json";

/**
 * The host's own v2 package code (manifest validation and the .ffplugin packer) is TypeScript, so it is bundled
 * once into a temporary CommonJS module instead of being re-implemented here: the catalog then ships exactly
 * the bytes the app's packer produces and enforces the manifest rules the app's importer enforces.
 */
async function loadHostPackaging() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "firefly-marketplace-host-"));
  try {
    const outfile = path.join(dir, "host-packaging.cjs");
    await bundle({
      stdin: {
        contents: [
          'export { packPackage } from "./src/plugins/v2/package/pack";',
          'export { validateManifest } from "./src/shared/plugin-manifest";',
          'export { PLUGIN_HOST_VERSION } from "./src/plugins/v2/package/importer";',
        ].join("\n"),
        resolveDir: repoRoot,
        loader: "ts",
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
    });
    return createRequire(import.meta.url)(outfile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validateRef(value, name) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
    || value.includes("..") || value.endsWith(".") || value.endsWith(".lock")) {
    throw new Error(`Invalid ${name}: use a safe single-segment Git tag/ref or full commit SHA`);
  }
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid build options");
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name)) throw new Error(`Unknown build option: ${name}`);
  }
  if (options.outDir !== undefined && (typeof options.outDir !== "string" || !options.outDir.trim() || options.outDir.includes("\0"))) {
    throw new Error("Invalid outDir: expected a nonempty directory path");
  }
  const publicMode = publicOptionNames.some(name => options[name] !== undefined);
  if (publicMode) {
    // tag is optional: without it every plugin uses its own release tag, <id>-<version>, one package per tag.
    if (options.repository === undefined || options.registryRef === undefined) {
      throw new Error("Public preparation requires repository and registryRef together (tag is optional)");
    }
    if (options.outDir === undefined) throw new Error("Public preparation requires an explicit outDir");
    const { repository } = options;
    if (typeof repository !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repository)) {
      throw new Error("Invalid repository: expected GitHub owner/repo, without a URL or extra path");
    }
    if (options.tag !== undefined) validateRef(options.tag, "tag");
    validateRef(options.registryRef, "registryRef");
  }
  const outDir = path.resolve(options.outDir ?? defaultOutDir);
  if (publicMode && outDir === defaultOutDir) throw new Error("Public artifacts cannot overwrite the bundled output directory");
  return { ...options, outDir, publicMode };
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Reads one catalog plugin from examples/<id>: validated v2 manifest, capability lines, and the fixed package files. */
async function readPlugin(id, host) {
  const dir = path.join(examplesDir, id);
  const manifestText = normalizeText(await readFile(path.join(dir, "firefly.plugin.json"), "utf8"));
  const checked = host.validateManifest(JSON.parse(manifestText), { hostVersion: host.PLUGIN_HOST_VERSION });
  if (!checked.ok) throw new Error(`Invalid ${id} manifest: ${JSON.stringify(checked.errors)}`);
  const manifest = checked.manifest;
  if (manifest.id !== `dev.firefly.${id}` || manifest.native !== false || manifest.main !== "index.mjs"
    || (manifest.permissions ?? []).length || manifest.ui !== undefined) {
    throw new Error(`Invalid ${id} manifest: expected the offline dev.firefly.${id} plugin without native code, permissions or UI`);
  }
  const catalog = JSON.parse(await readFile(path.join(dir, "catalog.json"), "utf8"));
  const capabilities = catalog?.capabilities;
  const catalogValid = typeof catalog === "object" && catalog !== null && !Array.isArray(catalog)
    && Object.keys(catalog).join() === "capabilities"
    && Array.isArray(capabilities) && capabilities.length >= 1 && capabilities.length <= 20
    && capabilities.every(line => typeof line === "string" && line.trim() && line.length <= 500);
  if (!catalogValid) throw new Error(`Invalid ${id} catalog.json: expected only capabilities, 1 to 20 nonempty lines`);
  const files = new Map();
  for (const name of PACKAGE_FILES) {
    const text = name === "firefly.plugin.json" ? manifestText : normalizeText(await readFile(path.join(dir, name), "utf8"));
    files.set(name, Buffer.from(text, "utf8"));
  }
  return { manifest, capabilities, files };
}

/** Stages the fixed file list (LF-normalised, no catalog.json) and packs it with the host's packer. */
async function packPlugin(files, host, outFile) {
  const stage = await mkdtemp(path.join(os.tmpdir(), "firefly-marketplace-stage-"));
  try {
    for (const [name, bytes] of files) await writeFile(path.join(stage, name), bytes);
    const packed = await host.packPackage(stage, outFile, { hostVersion: host.PLUGIN_HOST_VERSION });
    if (!packed.ok) throw new Error(`Packing failed: ${JSON.stringify(packed.errors)}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Prepare local artifacts only; no network requests, publishing, or app configuration writes.
 * The registry is protocol v2 and every package is a .ffplugin built by the app's own packer.
 * The result keeps `packagePath` and `sha256` for the first plugin (text-stats) and lists every plugin in `plugins`.
 * Nothing is written to outDir unless every plugin built.
 */
export async function buildMarketplace(options = {}) {
  const { outDir, publicMode, repository, tag, registryRef } = validateOptions(options);
  const host = await loadHostPackaging();
  const releasePrefix = publicMode ? `https://github.com/${repository}/releases/download/` : undefined;
  const registryPath = path.join(outDir, publicMode ? catalogPath : "registry.json");
  const configPath = publicMode ? path.join(outDir, "marketplace-config.json") : undefined;
  const staging = await mkdtemp(path.join(os.tmpdir(), "firefly-marketplace-out-"));
  try {
    const built = [];
    for (const id of CATALOG_PLUGIN_IDS) {
      const { manifest, capabilities, files } = await readPlugin(id, host);
      const fileName = `${manifest.id}-${manifest.version}.ffplugin`;
      const packagePath = path.join(staging, fileName);
      await packPlugin(files, host, packagePath);
      const sha256 = createHash("sha256").update(await readFile(packagePath)).digest("hex");
      // One package per release tag unless the caller names a single tag for all of them.
      const releaseTag = tag ?? `${manifest.id}-${manifest.version}`;
      if (publicMode) validateRef(releaseTag, "tag");
      built.push({
        id: manifest.id,
        version: manifest.version,
        fileName,
        packagePath,
        sha256,
        entry: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          sdk: manifest.sdk,
          description: manifest.description,
          author: manifest.author.name,
          license: manifest.license,
          native: false,
          permissions: manifest.permissions ?? [],
          tools: manifest.tools ?? [],
          capabilities,
          package: publicMode ? `${releasePrefix}${encodeURIComponent(releaseTag)}/${fileName}` : `bundled:${fileName}`,
          sha256,
        },
      });
    }
    const registry = { apiVersion: REGISTRY_API_VERSION, plugins: built.map(item => item.entry) };
    await mkdir(path.dirname(registryPath), { recursive: true });
    const plugins = [];
    for (const item of built) {
      const target = path.join(outDir, item.fileName);
      await copyFile(item.packagePath, target);
      plugins.push({ id: item.id, version: item.version, packagePath: target, sha256: item.sha256, package: item.entry.package });
    }
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    if (configPath) {
      const config = {
        registryUrls: [`https://raw.githubusercontent.com/${repository}/${encodeURIComponent(registryRef)}/${catalogPath}`],
        zipUrlPrefixes: [releasePrefix],
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    return { outDir, registryPath, packagePath: plugins[0].packagePath, ...(configPath ? { configPath } : {}), sha256: plugins[0].sha256, plugins };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const names = new Map([["--out-dir", "outDir"], ["--repository", "repository"], ["--tag", "tag"], ["--registry-ref", "registryRef"]]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = names.get(args[i]);
    if (!name) throw new Error(`Unknown argument: ${args[i]}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate argument: ${args[i]}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${args[i - 1]} requires a value`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildMarketplace(parseArgs(process.argv.slice(2)));
    console.log(`[plugin-marketplace] Prepared ${result.registryPath}`);
    for (const plugin of result.plugins) console.log(`[plugin-marketplace] Package ${plugin.packagePath} (SHA-256 ${plugin.sha256})`);
    if (result.configPath) console.log(`[plugin-marketplace] Public artifacts are not published. Review ${result.configPath}; verify hosted URLs before configuring Firefly.`);
  } catch (error) {
    console.error(`[plugin-marketplace] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
