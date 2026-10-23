import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { prepareMpv } from "./prepare-mpv.mjs";

async function installation(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "mpv-install-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("contract media archive");
  return {
    manifest: { binaryPath: "mpv.exe", assetName: "contract-player.7z", url: "https://downloads.invalid/player.7z",
      sha256: createHash("sha256").update(bytes).digest("hex") },
    outputDir: join(root, "player"), cacheDir: join(root, "archives"),
    download: async (_address, destination) => fs.writeFile(destination, bytes),
    extract: async () => {}, probe: async () => false,
  };
}

test("a working installed player is reused without a download", async t => {
  const options = await installation(t);
  await fs.mkdir(options.outputDir);
  await fs.writeFile(join(options.outputDir, "mpv.exe"), "installed player fixture");
  let requests = 0;
  assert.equal(await prepareMpv({ ...options, probe: async () => true, download: async () => { requests++; } }), "cached");
  assert.equal(requests, 0);
});

test("download integrity failure stops the player installer", async t => {
  const options = await installation(t);
  await assert.rejects(prepareMpv({ ...options, manifest: { ...options.manifest, sha256: "e".repeat(64) } }), /SHA-256 mismatch/);
});

test("a verified archive must supply the declared executable", async t => {
  const options = await installation(t);
  await assert.rejects(prepareMpv(options), /未找到 mpv\.exe/);
});
