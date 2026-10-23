import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(path.join(process.cwd(), "package.json"));
const roots: string[] = [];
const load = () => import("../../../scripts/security/git-null-config-backport.mjs");
const digest = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

async function fixture() {
  const installer = await load();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-parser-")));
  roots.push(root);
  const moduleRoot = path.join(root, "node_modules", "@simple-git", "argv-parser");
  fs.mkdirSync(path.dirname(moduleRoot), { recursive: true });
  fs.cpSync(path.resolve(path.dirname(require.resolve("@simple-git/argv-parser")), ".."), moduleRoot, { recursive: true });
  for (const record of installer.reviewedFiles) {
    const file = path.join(moduleRoot, "dist", record.name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(record.after, record.before));
  }
  return { root, moduleRoot, installer };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Git null-device adaptation installation", () => {
  it("checks and adapts both distributions without rewriting completed output", async () => {
    const { root, moduleRoot, installer } = await fixture();
    for (const record of installer.reviewedFiles) expect(digest(fs.readFileSync(path.join(moduleRoot, "dist", record.name)))).toBe(record.input);
    expect(installer.applyGitNullConfigBackport(root)).toBe("applied");
    const times = installer.reviewedFiles.map(record => fs.statSync(path.join(moduleRoot, "dist", record.name)).mtimeMs);
    expect(installer.applyGitNullConfigBackport(root)).toBe("already-applied");
    installer.reviewedFiles.forEach((record, index) => {
      const file = path.join(moduleRoot, "dist", record.name);
      expect(digest(fs.readFileSync(file))).toBe(record.output);
      expect(fs.statSync(file).mtimeMs).toBe(times[index]);
    });
  });

  it("rejects an unknown second distribution before changing the first", async () => {
    const { root, moduleRoot, installer } = await fixture();
    const first = path.join(moduleRoot, "dist", "index.cjs");
    const second = path.join(moduleRoot, "dist", "index.mjs");
    fs.appendFileSync(second, "\n");
    const original = [fs.readFileSync(first), fs.readFileSync(second)];
    expect(() => installer.applyGitNullConfigBackport(root)).toThrow(/source hash/);
    expect(fs.readFileSync(first)).toEqual(original[0]);
    expect(fs.readFileSync(second)).toEqual(original[1]);
  });

  it("rejects another version and retains the original source", async () => {
    const { root, moduleRoot, installer } = await fixture();
    const metadataFile = path.join(moduleRoot, "package.json");
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    metadata.version = "0.0.0-public-fixture";
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const file = path.join(moduleRoot, "dist", "index.cjs");
    const original = fs.readFileSync(file);
    expect(() => installer.applyGitNullConfigBackport(root)).toThrow(/package version/);
    expect(fs.readFileSync(file)).toEqual(original);
  });

  it("rejects a redirected module rather than modifying another installation", async () => {
    const { moduleRoot, installer } = await fixture();
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "firefly-git-parser-redirect-")));
    roots.push(root);
    fs.mkdirSync(path.join(root, "node_modules", "@simple-git"), { recursive: true });
    fs.symlinkSync(moduleRoot, path.join(root, "node_modules", "@simple-git", "argv-parser"), "junction");
    const original = fs.readFileSync(path.join(moduleRoot, "dist", "index.cjs"));
    expect(() => installer.applyGitNullConfigBackport(root)).toThrow(/redirect/);
    expect(fs.readFileSync(path.join(moduleRoot, "dist", "index.cjs"))).toEqual(original);
  });

  it("resumes a partially applied known adaptation", async () => {
    const { root, moduleRoot, installer } = await fixture();
    const first = installer.reviewedFiles[0];
    const file = path.join(moduleRoot, "dist", first.name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(first.before, first.after));
    expect(installer.applyGitNullConfigBackport(root)).toBe("applied");
    for (const record of installer.reviewedFiles) expect(digest(fs.readFileSync(path.join(moduleRoot, "dist", record.name)))).toBe(record.output);
  });
});
