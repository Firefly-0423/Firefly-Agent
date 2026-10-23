import { beforeEach, afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateManifestData } from "./manifest-validation";
import { inspectPluginDir } from "./loader";

const metadata = { apiVersion: 1, id: "catalog-addon", name: "Catalog", version: "2.4.6",
  author: "Contract team", description: "Catalog lookup", entry: "entry.cjs", defaultEnabled: true };
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), "manifest-schema-contract-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
function inspect(value: unknown) {
  fs.writeFileSync(join(directory, "manifest.json"), JSON.stringify(value));
  fs.writeFileSync(join(directory, "entry.cjs"), "module.exports = { register(context) { context.log('catalog loaded'); } };");
  return inspectPluginDir(directory);
}

it("accepts a structurally valid manifest through schema and directory inspection", () => {
  expect(validateManifestData(metadata).ok).toEqual(true);
  expect(inspect(metadata).manifest).not.toBeNull();
});

it.each([
  { ...metadata, deps: ["unavailable-capability"] }, { ...metadata, author: undefined },
  { ...metadata, defaultEnabled: "enabled" }, { ...metadata, customProperty: 7 }, "scalar manifest",
  { ...metadata, settingsPanel: "preferences.html", settingsSection: "unrecognized" },
  { ...metadata, deps: ["speech-input"] },
])("rejects invalid manifest data in both schema and loader: %j", value => {
  expect(validateManifestData(value).ok).toEqual(false);
  expect(inspect(value).manifest).toBeNull();
});

it.each(["plugins", undefined, "channels"])("accepts settings section %s in the schema", settingsSection => {
  expect(validateManifestData({ ...metadata, settingsPanel: "preferences.html", settingsSection }).ok).toEqual(true);
});

it("accepts each supported service and preserves dependency list ordering on inspection", () => {
  for (const capability of ["secrets", "workspace", "conversations", "scheduler"]) {
    expect(validateManifestData({ ...metadata, deps: [capability] }).ok).toEqual(true);
  }
  expect(inspect({ ...metadata, deps: ["secrets", "conversations"] }).manifest?.deps).toStrictEqual(["secrets", "conversations"]);
});

it("lets the loader enforce semantic version syntax beyond structural schema validation", () => {
  const value = { ...metadata, version: "development" };
  expect(validateManifestData(value).ok).toEqual(true);
  expect(inspect(value).manifest).toBeNull();
});
