// 由 src/plugins/api.ts 中的 PluginManifestInput 生成 Manifest 的 JSON Schema。
// 生成结果提交进仓库，CI 与本地校验用 --check 重新生成并对比，
// 以免公开类型和 Schema 悄悄不一致。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const schemaFile = path.join(rootDir, "src/plugins/manifest.schema.json");
const onlyCheck = process.argv.includes("--check");

const DRIFT_HINT = "manifest.schema.json 与 PluginManifestInput 类型不一致，请运行 npm run generate:plugin-schema";
const IN_SYNC_NOTE = "manifest.schema.json 与类型一致";

function buildSchemaText() {
  const generator = createGenerator({
    path: path.join(rootDir, "src/plugins/api.ts"),
    tsconfig: path.join(rootDir, "tsconfig.main.json"),
    skipTypeCheck: true,
    type: "PluginManifestInput",
    topRef: false,
  });
  return JSON.stringify(generator.createSchema("PluginManifestInput"), null, 2) + "\n";
}

const expected = buildSchemaText();

if (onlyCheck) {
  // Windows 的 CI 可能因 git autocrlf 以 CRLF 检出，先统一成 LF 再比较
  const onDisk = (await readFile(schemaFile, "utf8")).replaceAll("\r\n", "\n");
  const drifted = onDisk !== expected;
  if (drifted) {
    console.error(DRIFT_HINT);
    process.exit(1);
  }
  console.log(IN_SYNC_NOTE);
} else {
  await writeFile(schemaFile, expected, "utf8");
  console.log(`已生成 ${path.relative(rootDir, schemaFile)}`);
}
