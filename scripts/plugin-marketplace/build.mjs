import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import JSZip from "jszip";

// Node 24 can require the host's erasable TypeScript contracts without bundling.
const require = createRequire(import.meta.url);
const { SEMVER_PATTERN } = require("../../src/shared/version.ts");
const { CURRENT_PLUGIN_API_VERSION } = require("../../src/plugins/api.ts");

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultOutDir = path.join(repoRoot, "resources", "plugin-marketplace");
const examplesDir = path.join(repoRoot, "examples");
// Every plugin shipped through the catalog, in catalog order. Adding one means adding its directory under examples/
// (manifest.json, index.cjs, README.md, LICENSE, plus catalog.json with the capability lines shown to users).
export const CATALOG_PLUGIN_IDS = ["text-stats", "json-tools", "timezone-tools", "code-language", "text-trim"];
const PACKAGE_FILES = ["LICENSE", "README.md", "index.cjs", "manifest.json"];
const allowedOptions = new Set(["outDir", "repository", "tag", "registryRef"]);
const publicOptionNames = ["repository", "tag", "registryRef"];
const catalogPath = "marketplace/registry.json";

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

/** Reads one catalog plugin from examples/<id>: validated manifest, capability lines, and the fixed package files. */
async function readPlugin(id, validate) {
  const dir = path.join(examplesDir, id);
  const manifestText = normalizeText(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const manifest = JSON.parse(manifestText);
  if (!validate(manifest)) throw new Error(`Invalid ${id} manifest: ${JSON.stringify(validate.errors)}`);
  if (manifest.id !== id || !SEMVER_PATTERN.test(manifest.version) || manifest.apiVersion !== CURRENT_PLUGIN_API_VERSION
    || manifest.entry !== "index.cjs" || manifest.defaultEnabled !== false || (manifest.deps ?? []).length) {
    throw new Error(`Invalid ${id} manifest: expected the disabled offline plugin with a valid SemVer and current host API`);
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
    const text = name === "manifest.json" ? manifestText : normalizeText(await readFile(path.join(dir, name), "utf8"));
    files.set(name, Buffer.from(text, "utf8"));
  }
  return { manifest, capabilities, files };
}

async function packPlugin(files) {
  const zip = new JSZip();
  // Fixed order, UTC timestamps, regular-file permissions, and STORE avoid ambient
  // filesystem metadata, local timezone, and compression-version differences.
  // JSZip 3.10.1 options: https://stuk.github.io/jszip/documentation/api_jszip/file_data.html
  for (const [name, bytes] of files) {
    zip.file(name, bytes, {
      date: new Date("1980-01-01T00:00:00.000Z"),
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  // https://stuk.github.io/jszip/documentation/api_jszip/generate_async.html
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "STORE" });
}

/**
 * Prepare local artifacts only; no network requests, publishing, or app configuration writes.
 * The result keeps `zipPath` and `sha256` for the first plugin (text-stats) and lists every plugin in `plugins`.
 */
export async function buildMarketplace(options = {}) {
  const { outDir, publicMode, repository, tag, registryRef } = validateOptions(options);
  const schema = JSON.parse(await readFile(path.join(repoRoot, "src/plugins/manifest.schema.json"), "utf8"));
  const validate = new Ajv({ strict: false }).compile(schema);
  const releasePrefix = publicMode ? `https://github.com/${repository}/releases/download/` : undefined;
  const built = [];
  for (const id of CATALOG_PLUGIN_IDS) {
    const { manifest, capabilities, files } = await readPlugin(id, validate);
    const zipName = `${manifest.id}-${manifest.version}.zip`;
    const zipBytes = await packPlugin(files);
    const sha256 = createHash("sha256").update(zipBytes).digest("hex");
    // One package per release tag unless the caller names a single tag for all of them.
    const releaseTag = tag ?? `${manifest.id}-${manifest.version}`;
    if (publicMode) validateRef(releaseTag, "tag");
    built.push({
      id: manifest.id,
      version: manifest.version,
      zipName,
      zipBytes,
      sha256,
      entry: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        downloads: 0,
        pluginApiVersion: manifest.apiVersion,
        capabilities,
        zip: publicMode ? `${releasePrefix}${encodeURIComponent(releaseTag)}/${zipName}` : `bundled:${zipName}`,
        sha256,
      },
    });
  }
  const registry = { apiVersion: 1, plugins: built.map(item => item.entry) };
  const registryPath = path.join(outDir, publicMode ? catalogPath : "registry.json");
  const configPath = publicMode ? path.join(outDir, "marketplace-config.json") : undefined;
  await mkdir(path.dirname(registryPath), { recursive: true });
  const plugins = [];
  for (const item of built) {
    const zipPath = path.join(outDir, item.zipName);
    await writeFile(zipPath, item.zipBytes);
    plugins.push({ id: item.id, version: item.version, zipPath, sha256: item.sha256, zip: item.entry.zip });
  }
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  if (configPath) {
    const config = {
      registryUrls: [`https://raw.githubusercontent.com/${repository}/${encodeURIComponent(registryRef)}/${catalogPath}`],
      zipUrlPrefixes: [releasePrefix],
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { outDir, registryPath, zipPath: plugins[0].zipPath, ...(configPath ? { configPath } : {}), sha256: plugins[0].sha256, plugins };
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
    for (const plugin of result.plugins) console.log(`[plugin-marketplace] ZIP ${plugin.zipPath} (SHA-256 ${plugin.sha256})`);
    if (result.configPath) console.log(`[plugin-marketplace] Public artifacts are not published. Review ${result.configPath}; verify hosted URLs before configuring Firefly.`);
  } catch (error) {
    console.error(`[plugin-marketplace] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
