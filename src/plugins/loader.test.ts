import { beforeEach, afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readManifest, scanPluginDir, loadPlugin } from "./loader";

const metadata = { apiVersion: 1, id: "catalog-addon", name: "Catalog contract", version: "2.4.6",
  author: "Contract suite", description: "Catalog fixture", entry: "entry.cjs", defaultEnabled: true };
let directory: string;
let counter: number;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), "plugin-loader-contract-")); counter = 0; });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function plugin(overrides: Record<string, unknown> = {}, files: Record<string, string> = {}, target = join(directory, `candidate-${++counter}`)) {
  fs.mkdirSync(target, { recursive: true });
  const contents = { "manifest.json": JSON.stringify({ ...metadata, ...overrides }),
    "entry.cjs": "module.exports = { register(context) { context.log('catalog ready'); } };", ...files };
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(join(target, name), bytes);
  return target;
}

it("reads valid metadata and supported dependencies in their declared order", () => {
  expect(readManifest(plugin())).toMatchObject({ id: "catalog-addon" });
  expect(readManifest(plugin({ deps: ["secrets", "workspace", "conversations", "scheduler"] }))?.deps)
    .toStrictEqual(["secrets", "workspace", "conversations", "scheduler"]);
  expect(readManifest(plugin({ deps: ["llm", "llm"] }))?.deps).toStrictEqual(["llm"]);
});

it.each([
  { id: "Invalid Identifier", entry: "absent.js" }, { entry: "subdirectory/entry.js" },
  { entry: "payload.json" }, { deps: ["channels", "llm", "unknown-service"] },
  { unexpectedField: true }, { apiVersion: 3 }, { version: "development" },
])("rejects invalid plugin contract %j", overrides => {
  expect(readManifest(plugin(overrides, { "payload.json": "{}" }))).toBeNull();
});

it("does not invent metadata for a directory without a manifest", () => {
  const empty = join(directory, "empty-candidate");
  fs.mkdirSync(empty);
  fs.writeFileSync(join(empty, "notes.txt"), "No plugin metadata here");
  expect(readManifest(empty)).toBeNull();
});

it("retains a valid icon while dropping missing, executable and traversing icon paths", () => {
  expect(readManifest(plugin({ icon: "badge.png" }, { "badge.png": "contract image bytes" }))?.icon).toEqual("badge.png");
  expect(readManifest(plugin({ icon: "absent.png" }))?.icon).toBeUndefined();
  expect(readManifest(plugin({ icon: "badge.exe" }, { "badge.exe": "unsupported image" }))?.icon).toBeUndefined();
  const traversal = readManifest(plugin({ icon: "../badge.png" }));
  expect(traversal).not.toBeNull();
  expect(traversal?.icon).toBeUndefined();
});

it("keeps a valid settings panel and its section, dropping the section if the panel is missing", () => {
  const valid = readManifest(plugin({ settingsPanel: "preferences.html", settingsSection: "channels" }, { "preferences.html": "<p>Catalog preferences</p>" }));
  expect(valid?.settingsPanel).toEqual("preferences.html");
  expect(valid?.settingsSection).toEqual("channels");
  const missing = readManifest(plugin({ settingsPanel: "preferences.html", settingsSection: "channels" }));
  expect(missing?.settingsPanel).toBeUndefined();
  expect(missing?.settingsSection).toBeUndefined();
});

it("ignores invalid panel paths, non-HTML files and panels above one MiB", () => {
  expect(readManifest(plugin({ settingsPanel: "preferences.js" }, { "preferences.js": "untrusted script" }))?.settingsPanel).toBeUndefined();
  const traversal = readManifest(plugin({ settingsPanel: "../preferences.html" }));
  expect(traversal).not.toBeNull();
  expect(traversal?.settingsPanel).toBeUndefined();
  expect(readManifest(plugin({ settingsPanel: "large.html" }, { "large.html": "p".repeat(1024 * 1024 + 1) }))?.settingsPanel).toBeUndefined();
});

it("rejects invalid panel sections but drops a valid section without a panel", () => {
  expect(readManifest(plugin({ settingsPanel: "preferences.html", settingsSection: "unrecognized" }, { "preferences.html": "<p>Preferences</p>" }))).toBeNull();
  const noPanel = readManifest(plugin({ settingsSection: "channels" }));
  expect(noPanel).not.toBeNull();
  expect(noPanel?.settingsSection).toBeUndefined();
});

it("scans only valid first-level plugin directories", () => {
  const root = join(directory, "collection");
  fs.mkdirSync(root);
  plugin({}, {}, join(root, "catalog"));
  fs.mkdirSync(join(root, "broken"));
  fs.writeFileSync(join(root, "broken", "manifest.json"), "[invalid");
  fs.mkdirSync(join(root, "not-a-plugin"));
  fs.writeFileSync(join(root, "not-a-plugin", "notes.txt"), "Read me");
  expect(scanPluginDir(root).map(record => record.manifest.id)).toStrictEqual(["catalog-addon"]);
});

it("reports a non-directory scan root without throwing", () => {
  const file = join(directory, "collection.txt");
  fs.writeFileSync(file, "Not a directory");
  const issues: string[] = [];
  expect(scanPluginDir(file, "user", issue => issues.push(issue.message))).toStrictEqual([]);
  expect(issues[0]).toMatch(/无法扫描插件目录/);
});

it.each([
  ["entry.cjs", "module.exports = { register(context) { context.log('CJS catalog'); } };"],
  ["entry.mjs", "export default { register(context) { context.log('ESM catalog'); } };"],
  ["entry.mjs", "export function register(context) { context.log('Named catalog'); }"],
])("loads a register function from %s", async (entry, code) => {
  const target = plugin({ entry }, { [entry]: code });
  const record = scanPluginDir(directory).find(candidate => candidate.dir === target)!;
  expect(typeof (await loadPlugin(record)).register).toEqual("function");
});

it("rejects an entry module lacking register", async () => {
  const target = plugin({}, { "entry.cjs": "module.exports = { description: 'No registration entry' };" });
  const record = scanPluginDir(directory).find(candidate => candidate.dir === target)!;
  await expect(loadPlugin(record)).rejects.toThrow(/register/);
});
