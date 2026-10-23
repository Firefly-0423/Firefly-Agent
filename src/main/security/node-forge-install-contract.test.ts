import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(path.join(process.cwd(), "package.json"));
const roots: string[] = [];
const before = "            obj.value.length !== 2) {";
const after = "            obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {";
const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");
const load = () => import("../../../scripts/security/node-forge-backport.mjs");

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-forge-backport-")));
  roots.push(root);
  const moduleRoot = path.join(root, "node_modules", "node-forge");
  fs.mkdirSync(path.dirname(moduleRoot), { recursive: true });
  fs.cpSync(path.dirname(require.resolve("node-forge/package.json")), moduleRoot, { recursive: true });
  const file = path.join(moduleRoot, "lib", "rsa.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(after, before));
  return { root, moduleRoot, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("node-forge backport installation protection", () => {
  it("applies only the reviewed release and does not rewrite an already corrected file", async () => {
    const { applyNodeForgeBackport, upstreamRsaSha256, patchedRsaSha256 } = await load();
    const context = fixture();
    expect(digest(fs.readFileSync(context.file))).toBe(upstreamRsaSha256);
    expect(applyNodeForgeBackport(context.root)).toBe("applied");
    expect(digest(fs.readFileSync(context.file))).toBe(patchedRsaSha256);
    const modified = fs.statSync(context.file).mtimeMs;
    expect(applyNodeForgeBackport(context.root)).toBe("already-applied");
    expect(fs.statSync(context.file).mtimeMs).toBe(modified);
    expect(JSON.parse(fs.readFileSync(path.join(context.moduleRoot, "package.json"), "utf8")).version).toBe("1.4.0");
  });

  it("rejects unknown source bytes without overwriting them", async () => {
    const { applyNodeForgeBackport } = await load();
    const context = fixture();
    fs.appendFileSync(context.file, "\n");
    const original = fs.readFileSync(context.file);
    expect(() => applyNodeForgeBackport(context.root)).toThrow(/source hash/);
    expect(fs.readFileSync(context.file)).toEqual(original);
  });

  it("rejects a changed package version without applying a guessed correction", async () => {
    const { applyNodeForgeBackport } = await load();
    const context = fixture();
    const metadataFile = path.join(context.moduleRoot, "package.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    metadata.version = "0.0.0-public-fixture";
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const original = fs.readFileSync(context.file);
    expect(() => applyNodeForgeBackport(context.root)).toThrow(/package version/);
    expect(fs.readFileSync(context.file)).toEqual(original);
  });

  it("rejects a directory junction redirect instead of modifying another installation", async () => {
    const { applyNodeForgeBackport } = await load();
    const context = fixture();
    const redirectedRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-forge-redirect-")));
    roots.push(redirectedRoot);
    fs.mkdirSync(path.join(redirectedRoot, "node_modules"));
    fs.symlinkSync(context.moduleRoot, path.join(redirectedRoot, "node_modules", "node-forge"), "junction");
    const original = fs.readFileSync(context.file);
    expect(() => applyNodeForgeBackport(redirectedRoot)).toThrow(/redirect/);
    expect(fs.readFileSync(context.file)).toEqual(original);
  });

  it("keeps the correction in the normal install path without relaxing the audit command", () => {
    const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(metadata.scripts.postinstall).toBe("node scripts/security/node-forge-backport.mjs && node scripts/security/git-null-config-backport.mjs");
    expect(fs.readFileSync(".github/workflows/test.yml", "utf8")).toContain("npm audit --omit=dev --json > npm-audit-prod.json");
  });
});
