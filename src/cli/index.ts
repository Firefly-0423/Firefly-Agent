/**
 * Firefly CLI 入口。实际逻辑在 app.ts，便于测试直接导入 main()。
 * #!/usr/bin/env node 由 scripts/build/cli.mjs 经 esbuild 的 banner 选项加上，
 * 所以这里不带 shebang，vitest 才能正常加载。
 */
import { main } from "./app.js";

const reportFatal = (err: any): never => {
  process.stderr.write(`firefly: ${err?.stack ?? String(err)}\n`);
  return process.exit(1);
};

main(process.argv.slice(2)).then((code) => process.exit(code), reportFatal);
