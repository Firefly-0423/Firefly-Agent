import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const reviewedFiles = [
  {
    name: "index.cjs",
    input: "8e313da26ac724c90f1b7f89020c5637462b1b452f41118b07c9916d95729926",
    output: "95efda84835ae87a7efbf3fbbcc01cb29c9a44a0433dceee3242df34a0aeffc4",
    before: "function*Z(e){for(const t of Object.keys(e))if(U(t)){",
    after: 'function*Z(e){for(const t of Object.keys(e))if(U(t)&&!(process.platform==="win32"&&t==="git_config_global"&&e[t]==="NUL")){',
  },
  {
    name: "index.mjs",
    input: "963a4c217f8cbcf1727c4e380d4f495a82e6761d31b4f4e9d88720e5df89defe",
    output: "a0d24d12587feba5f02db9f28b61ed6500502670ec8ca46f6bb36a451024072c",
    before: "  for (const n of Object.keys(e))\n    if (_(n)) {",
    after: '  for (const n of Object.keys(e))\n    if (_(n) && !(process.platform === "win32" && n === "git_config_global" && e[n] === "NUL")) {',
  },
];
const digest = contents => createHash("sha256").update(contents).digest("hex");

export function applyGitNullConfigBackport(repository) {
  const repositoryRoot = fs.realpathSync.native(repository);
  const moduleRoot = path.join(repositoryRoot, "node_modules", "@simple-git", "argv-parser");
  if (fs.realpathSync.native(moduleRoot) !== moduleRoot) throw new Error("Git parser must not redirect outside the repository installation");
  const metadata = JSON.parse(fs.readFileSync(path.join(moduleRoot, "package.json"), "utf8"));
  if (metadata.name !== "@simple-git/argv-parser" || metadata.version !== "2.0.1") throw new Error("Git parser adaptation requires review for this package version");
  const files = reviewedFiles.map(record => {
    const file = path.join(moduleRoot, "dist", record.name);
    if (fs.realpathSync.native(file) !== file) throw new Error("Git parser source must not redirect outside the installed module");
    const contents = fs.readFileSync(file);
    const hash = digest(contents);
    if (hash === record.output) return { file, patched: null, output: record.output };
    if (hash !== record.input) throw new Error(`Git parser source hash mismatch: ${record.name}`);
    const source = contents.toString("utf8");
    if (source.split(record.before).length !== 2) throw new Error("Git parser adaptation target is not unique");
    const patched = Buffer.from(source.replace(record.before, record.after));
    if (digest(patched) !== record.output) throw new Error("Git parser adaptation output hash mismatch");
    return { file, patched, output: record.output };
  });
  for (const { file, patched, output } of files) {
    if (!patched) continue;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, patched, { flag: "wx", mode: fs.statSync(file).mode });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    if (digest(fs.readFileSync(file)) !== output) throw new Error("Git parser installed adaptation verification failed");
  }
  return files.some(record => record.patched) ? "applied" : "already-applied";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[Git parser] Windows null configuration adaptation: ${applyGitNullConfigBackport(fileURLToPath(new URL("../../", import.meta.url)))}`);
}
