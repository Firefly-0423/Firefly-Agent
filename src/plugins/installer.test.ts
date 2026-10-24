import { beforeEach, afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { preparePluginZip, discardPreparedPlugin, commitPreparedPlugin, readHostMetadataSync } from "./installer";

let directory: string;
let root: string;
let archive: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "plugin-install-contract-"));
  root = join(directory, "programs");
  archive = join(directory, "candidate.zip");
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
const metadata = (id = "catalog-addon", version = "2.4.6") => ({
  apiVersion: 1, id, version, name: "Catalog addon", description: "Catalog installation fixture", author: "Contract team", entry: "entry.cjs",
});
async function zip(options: { prefix?: string; id?: string; version?: string; extras?: Record<string, string> } = {}) {
  const bundle = new JSZip();
  const prefix = options.prefix ?? "";
  bundle.file(prefix + "manifest.json", JSON.stringify(metadata(options.id, options.version)));
  bundle.file(prefix + "entry.cjs", "module.exports = { register(context) { context.log('catalog activation'); } };");
  for (const [name, contents] of Object.entries(options.extras ?? {})) bundle.file(name, contents);
  fs.writeFileSync(archive, await bundle.generateAsync({ type: "nodebuffer" }));
  return bundle;
}

it("installs a wrapped plugin under its manifest identity and removes staging data", async () => {
  await zip({ prefix: "distribution/" });
  const prepared = await preparePluginZip(archive, root);
  expect(prepared.manifest.id).toEqual("catalog-addon");
  const installed = await commitPreparedPlugin(prepared, root, false);
  expect(installed).toEqual(join(root, "catalog-addon"));
  expect(fs.readFileSync(join(installed, "manifest.json"), "utf8")).toContain("catalog-addon");
  expect(fs.existsSync(prepared.stagingDir)).toEqual(false);
});

it("accepts a root-level manifest and allows its prepared install to be discarded", async () => {
  await zip({ id: "root-catalog" });
  const prepared = await preparePluginZip(archive, root);
  expect(prepared.manifest.id).toEqual("root-catalog");
  await discardPreparedPlugin(prepared);
  expect(fs.existsSync(prepared.stagingDir)).toEqual(false);
});

it("rejects traversal entries without writing outside staging", async () => {
  await zip({ extras: { "../unowned.txt": "Traversal fixture" } });
  await expect(preparePluginZip(archive, root)).rejects.toThrow(/bound|不安全路径|invalid relative path/i);
  expect(fs.existsSync(join(directory, "unowned.txt"))).toEqual(false);
});

it("rejects Unix symbolic link entries", async () => {
  const bundle = await zip();
  bundle.file("linked-resource", "../unowned-target", { unixPermissions: 0o120777 });
  fs.writeFileSync(archive, await bundle.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  await expect(preparePluginZip(archive, root)).rejects.toThrow("不允许包含符号链接");
});

it("rejects filename collisions that differ only by case", async () => {
  await zip({ extras: { "MANIFEST.JSON": JSON.stringify(metadata("colliding-addon")) } });
  await expect(preparePluginZip(archive, root)).rejects.toThrow("大小写冲突路径");
});

it("rejects a declared expanded file size above fifty MiB before extracting it", async () => {
  const bundle = new JSZip();
  bundle.file("oversized-catalog.bin", "Compressed fixture");
  const bytes = await bundle.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const declaredSize = 52 * 1024 * 1024;
  bytes.writeUInt32LE(declaredSize, 22);
  const central = bytes.indexOf(Buffer.from([80, 75, 1, 2]));
  bytes.writeUInt32LE(declaredSize, central + 24);
  fs.writeFileSync(archive, bytes);
  await expect(preparePluginZip(archive, root)).rejects.toThrow("单文件解压后超过 50 MiB");
});

it("rejects an invalid manifest identity", async () => {
  await zip({ id: "Invalid Catalog" });
  await expect(preparePluginZip(archive, root)).rejects.toThrow("id 不符合小写连字符格式");
});

it("replaces the program directory while retaining unrelated plugin data", async () => {
  const data = join(directory, "plugin-data", "catalog-addon.json");
  fs.mkdirSync(join(directory, "plugin-data"));
  fs.writeFileSync(data, "Persistent catalog preferences");
  await zip({ version: "3.0.0" });
  await commitPreparedPlugin(await preparePluginZip(archive, root), root, false);
  const obsolete = join(root, "catalog-addon", "obsolete.txt");
  fs.writeFileSync(obsolete, "Old distribution content");
  await commitPreparedPlugin(await preparePluginZip(archive, root), root, true);
  expect(fs.existsSync(obsolete)).toEqual(false);
  expect(fs.readFileSync(data, "utf8")).toEqual("Persistent catalog preferences");
});

it.each([
  { id: "other-catalog", version: "2.4.6" }, { id: "catalog-addon", version: "9.8.7" },
])("rejects marketplace identity mismatch %j", async identity => {
  await zip(identity);
  await expect(preparePluginZip(archive, root, { expectedIdentity: { id: "catalog-addon", version: "2.4.6" } }))
    .rejects.toThrow("插件包与市场登记信息不符");
});

it("accepts the exact expected marketplace identity", async () => {
  await zip();
  const prepared = await preparePluginZip(archive, root, { expectedIdentity: { id: "catalog-addon", version: "2.4.6" } });
  expect(prepared.manifest.id).toEqual("catalog-addon");
  await discardPreparedPlugin(prepared);
});

it("refuses packages that attempt to provide the host's reserved metadata", async () => {
  await zip({ extras: { "firefly-market.json": JSON.stringify({ origin: "market", registryId: "forged" }) } });
  await expect(preparePluginZip(archive, root)).rejects.toThrow("宿主保留文件");
});

it("records marketplace origin and installed version after a market commit", async () => {
  await zip();
  await commitPreparedPlugin(await preparePluginZip(archive, root), root, false, { marketOrigin: { registryId: "contract-registry" } });
  expect(readHostMetadataSync(root, "catalog-addon")).toMatchObject({
    origin: "market", registryId: "contract-registry", installedVersion: "2.4.6",
  });
});

it("leaves a local installation without marketplace origin metadata", async () => {
  await zip();
  await commitPreparedPlugin(await preparePluginZip(archive, root), root, false);
  expect(readHostMetadataSync(root, "catalog-addon")).toBeUndefined();
});
