/**
 * 用 esbuild 把 src/cli/index.ts 打成单文件 dist/cli/index.js。
 *
 * 产物约束：
 * - 输出 CJS，满足 npm bin 的要求，并带 `#!/usr/bin/env node` 首行
 * - 构建时把 package.json 的版本写入 __FIREFLY_VERSION__，运行时不再读文件
 * - 依赖全部打进产物，运行时不需要 node_modules
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));

await build({
  entryPoints: [path.join(rootDir, "src/cli/index.ts")],
  outfile: path.join(rootDir, "dist/cli/index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  define: { __FIREFLY_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});

console.log(`[cli] bundled dist/cli/index.js (v${version})`);
