import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyHistoryHelpers } from "./history-helpers.mjs";
import { syntheticHistoryHelper } from "./history-helpers-fixture.mjs";

const names = ["firefly-history-read.exe", "firefly-history-presence.exe"];
async function fixture(context, selected = names) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "firefly-history-verify-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of selected) await writeFile(path.join(directory, name), syntheticHistoryHelper());
  return directory;
}

test("verifies both PE helpers without executing them", async context => {
  const directory = await fixture(context);
  const verified = await verifyHistoryHelpers(directory);
  assert.deepEqual(verified.map(helper => path.basename(helper.helperPath)), names);
  assert.deepEqual(verified.map(helper => helper.size), [1024, 1024]);
});

test("accepts valid PE32 headers as well as PE32+", async context => {
  const directory = await fixture(context);
  await writeFile(path.join(directory, names[0]), syntheticHistoryHelper({ pe32: true }));
  assert.equal((await verifyHistoryHelpers(directory)).length, 2);
});

for (const selected of [[], [names[0]], [names[1]]]) {
  test(`rejects missing helpers when only ${selected.join(", ") || "neither"} exists`, async context => {
    const directory = await fixture(context, selected);
    const missing = names.find(name => !selected.includes(name));
    await assert.rejects(verifyHistoryHelpers(directory), error => {
      assert.match(error.message, /missing/i);
      assert.ok(error.message.includes(missing));
      return true;
    });
  });
}

test("rejects a directory named like a helper", async context => {
  const directory = await fixture(context, [names[1]]);
  await mkdir(path.join(directory, names[0]));
  await assert.rejects(verifyHistoryHelpers(directory), /not a file/i);
});

for (const [label, corrupt] of [
  ["empty file", () => Buffer.alloc(0)],
  ["renamed non-PE binary", bytes => { bytes.write("ELF", 0); return bytes; }],
  ["DOS header without PE signature", bytes => { bytes.fill(0, 128, 132); return bytes; }],
  ["PE header offset outside the file", bytes => { bytes.writeUInt32LE(0xfffffff0, 60); return bytes; }],
  ["PE header overlapping DOS header", bytes => { bytes.writeUInt32LE(4, 60); return bytes; }],
  ["unsupported machine", bytes => { bytes.writeUInt16LE(0, 132); return bytes; }],
  ["no sections", bytes => { bytes.writeUInt16LE(0, 134); return bytes; }],
  ["truncated section table", bytes => { bytes.writeUInt16LE(96, 134); return bytes; }],
  ["invalid optional header", bytes => { bytes.writeUInt16LE(0, 152); return bytes; }],
  ["truncated optional header", bytes => { bytes.writeUInt16LE(8, 148); return bytes; }],
  ["non-executable image", bytes => { bytes.writeUInt16LE(0, 150); return bytes; }],
  ["DLL renamed as exe", bytes => { bytes.writeUInt16LE(0x2002, 150); return bytes; }],
]) {
  test(`rejects ${label}`, async context => {
    const directory = await fixture(context);
    await writeFile(path.join(directory, names[1]), corrupt(syntheticHistoryHelper()));
    await assert.rejects(verifyHistoryHelpers(directory), /not a Windows PE executable.*firefly-history-presence\.exe/);
  });
}

test("CLI fails if either packaged helper is absent", async context => {
  const directory = await fixture(context, [names[0]]);
  const script = fileURLToPath(new URL("./history-helpers.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /firefly-history-presence\.exe/);
  assert.doesNotMatch(result.stdout, /verified/);
});
