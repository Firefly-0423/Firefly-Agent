import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const upstreamRsaSha256 = "fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50";
export const patchedRsaSha256 = "c9b1e3799e230528b6d6815c1f6cd3c6058b9d45975264b55d995abb976589af";
const before = "            obj.value.length !== 2) {";
const after = "            obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {";
const digest = contents => createHash("sha256").update(contents).digest("hex");

export function applyNodeForgeBackport(repository) {
  const moduleRoot = path.join(repository, "node_modules", "node-forge");
  const repositoryRoot = fs.realpathSync.native(repository);
  if (fs.realpathSync.native(moduleRoot) !== path.join(repositoryRoot, "node_modules", "node-forge")) throw new Error("node-forge module must not redirect outside the repository installation");
  const metadata = JSON.parse(fs.readFileSync(path.join(moduleRoot, "package.json"), "utf8"));
  if (metadata.name !== "node-forge" || metadata.version !== "1.4.0") throw new Error("node-forge backport requires review for this package version");
  const file = path.join(moduleRoot, "lib", "rsa.js");
  if (fs.realpathSync.native(file) !== path.join(fs.realpathSync.native(moduleRoot), "lib", "rsa.js")) throw new Error("node-forge RSA source must not redirect outside the installed module");
  const contents = fs.readFileSync(file);
  const hash = digest(contents);
  if (hash === patchedRsaSha256) return "already-applied";
  if (hash !== upstreamRsaSha256) throw new Error("node-forge RSA source hash does not match the reviewed release");
  const source = contents.toString("utf8");
  if (source.split(before).length !== 2) throw new Error("node-forge RSA patch target is not unique");
  const patched = Buffer.from(source.replace(before, after));
  if (digest(patched) !== patchedRsaSha256) throw new Error("node-forge RSA backport output hash mismatch");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, patched, { flag: "wx", mode: fs.statSync(file).mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (digest(fs.readFileSync(file)) !== patchedRsaSha256) throw new Error("node-forge RSA installed backport verification failed");
  return "applied";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  console.log(`[node-forge] CVE-2026-85393 backport: ${applyNodeForgeBackport(repository)}`);
}
