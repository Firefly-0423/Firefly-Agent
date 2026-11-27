// 校验 src/shared/plugin-manifest/manifest.schema.json 与 PluginManifest 类型是否一致。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const schemaFile = path.join(rootDir, "src/shared/plugin-manifest/manifest.schema.json");
const onlyCheck = process.argv.includes("--check");

const DRIFT_HINT = "manifest.schema.json 与 PluginManifestV1 类型不一致，请同步更新 src/shared/plugin-manifest/manifest.schema.json";
const IN_SYNC_NOTE = "manifest.schema.json 与类型一致";

const generated = createGenerator({
  path: path.join(rootDir, "src/shared/plugin-manifest/types.ts"),
  tsconfig: path.join(rootDir, "tsconfig.main.json"),
  skipTypeCheck: true,
  type: "PluginManifestV1",
  topRef: false,
}).createSchema("PluginManifestV1");

const diskSchema = JSON.parse((await readFile(schemaFile, "utf8")).replaceAll("\r\n", "\n"));
new Ajv({ strict: false }).compile(diskSchema);

const expectedKeys = Object.keys(generated.properties ?? {}).sort();
const actualKeys = Object.keys(diskSchema.properties ?? {}).sort();
const expectedReq = [...(generated.required ?? [])].sort();
const actualReq = [...(diskSchema.required ?? [])].sort();

const inSync =
  JSON.stringify(expectedKeys) === JSON.stringify(actualKeys) &&
  JSON.stringify(expectedReq) === JSON.stringify(actualReq);

if (!inSync) {
  console.error(DRIFT_HINT);
  console.error({ expectedKeys, actualKeys, expectedReq, actualReq });
  process.exit(1);
}
if (onlyCheck) {
  console.log(IN_SYNC_NOTE);
} else {
  console.log(`${IN_SYNC_NOTE}: ${path.relative(rootDir, schemaFile)}`);
}
