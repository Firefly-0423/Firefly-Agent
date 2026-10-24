import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { prepareMinGit } from "./prepare-mingit.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function installation(t, bytes) {
  const root = await fs.mkdtemp(join(tmpdir(), "mingit-install-contract-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return {
    outputDir: join(root, "installed"), cacheDir: join(root, "archives"),
    manifest: { assetName: "contract-git.zip", url: "https://downloads.invalid/contract-git.zip", sha256: digest(bytes) },
    download: async (_address, destination) => fs.writeFile(destination, bytes),
    probe: async () => false,
  };
}

test("a runnable installed Git bypasses all download work", async t => {
  const options = await installation(t, "unused archive payload");
  await fs.mkdir(join(options.outputDir, "cmd"), { recursive: true });
  await fs.writeFile(join(options.outputDir, "cmd", "git.exe"), "installed executable fixture");
  let downloads = 0;
  const result = await prepareMinGit({ ...options, probe: async () => true, download: async () => { downloads++; } });
  assert.equal(downloads, 0);
  assert.equal(result, "cached");
});

test("an untrusted archive digest prevents extraction", async t => {
  const options = await installation(t, "unexpected download payload");
  let extractions = 0;
  await assert.rejects(prepareMinGit({
    ...options, manifest: { ...options.manifest, sha256: "f".repeat(64) },
    extract: async () => { extractions++; }, probe: async () => true,
  }), /SHA-256 mismatch/);
  assert.equal(extractions, 0);
});

test("a verified ZIP containing a symbolic link cannot replace an existing installation", async t => {
  const zip = new JSZip();
  zip.file("shortcut-entry", "../unowned-target", { unixPermissions: 0o120777 });
  const options = await installation(t, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  await fs.mkdir(options.outputDir);
  const marker = join(options.outputDir, "preserved-installation.txt");
  await fs.writeFile(marker, "existing distribution remains");
  await assert.rejects(prepareMinGit(options), /ZIP_SYMLINK_FORBIDDEN/);
  assert.equal(await fs.readFile(marker, "utf8"), "existing distribution remains");
  await assert.rejects(fs.access(options.outputDir + ".tmp-" + process.pid), { code: "ENOENT" });
});
