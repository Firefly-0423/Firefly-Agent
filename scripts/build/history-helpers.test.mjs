import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildHistoryHelpers } from "./history-helpers.mjs";
import { syntheticHistoryHelper } from "../verify/history-helpers-fixture.mjs";

async function fixture(context, names = []) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "firefly-history-build-"));
  context.after(() => rm(repoRoot, { recursive: true, force: true }));
  const release = path.join(repoRoot, "native", "target", "release");
  await mkdir(release, { recursive: true });
  for (const name of names) await writeFile(path.join(release, name), syntheticHistoryHelper());
  return repoRoot;
}

test("Windows build requests both locked release binaries with the history-read feature", async context => {
  const repoRoot = await fixture(context, ["firefly-history-read.exe", "firefly-history-presence.exe"]);
  const commands = [];
  const result = await buildHistoryHelpers({
    repoRoot,
    platform: "win32",
    run(command, args, options) {
      commands.push({ command, args, options });
      for (const name of ["firefly-history-read.exe", "firefly-history-presence.exe"])
        writeFileSync(path.join(repoRoot, "native", "target", "release", name), syntheticHistoryHelper());
      return { status: 0 };
    },
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "cargo");
  assert.deepEqual(commands[0].args, [
    "build", "--release", "--locked", "--manifest-path", "native/Cargo.toml",
    "--features", "history-read", "--bin", "firefly-history-read", "--bin", "firefly-history-presence",
  ]);
  assert.equal(commands[0].options.cwd, repoRoot);
  assert.equal(commands[0].options.shell, false);
  assert.equal(commands[0].options.env.CARGO_TARGET_DIR, path.join(repoRoot, "native", "target"));
  assert.deepEqual(result.map(helper => path.basename(helper.helperPath)), ["firefly-history-read.exe", "firefly-history-presence.exe"]);
});

for (const platform of ["linux", "darwin"]) {
  test(`rejects ${platform} before launching Cargo even if stale exe files exist`, async context => {
    const repoRoot = await fixture(context, ["firefly-history-read.exe", "firefly-history-presence.exe"]);
    let calls = 0;
    await assert.rejects(buildHistoryHelpers({ repoRoot, platform, run() { calls++; return { status: 0 }; } }), /requires Windows.*not built/i);
    assert.equal(calls, 0);
  });
}

for (const [label, result, error] of [
  ["launch error", { error: new Error("Cargo unavailable"), status: null }, /failed to launch Cargo: Cargo unavailable/],
  ["nonzero exit", { status: 101 }, /Cargo.*101/],
  ["termination", { status: null, signal: "SIGTERM" }, /Cargo.*SIGTERM/],
]) {
  test(`fails on Cargo ${label} despite pre-existing helpers`, async context => {
    const repoRoot = await fixture(context, ["firefly-history-read.exe", "firefly-history-presence.exe"]);
    await assert.rejects(buildHistoryHelpers({ repoRoot, platform: "win32", run: () => result }), error);
  });
}

test("Cargo success cannot conceal a missing presence binary", async context => {
  const repoRoot = await fixture(context, ["firefly-history-read.exe"]);
  await assert.rejects(buildHistoryHelpers({ repoRoot, platform: "win32", run() {
    writeFileSync(path.join(repoRoot, "native", "target", "release", "firefly-history-read.exe"), syntheticHistoryHelper());
    return { status: 0 };
  } }), /missing.*firefly-history-presence\.exe/i);
});

test("Cargo success cannot conceal a malformed binary", async context => {
  const repoRoot = await fixture(context, ["firefly-history-read.exe", "firefly-history-presence.exe"]);
  await assert.rejects(buildHistoryHelpers({ repoRoot, platform: "win32", run() {
    writeFileSync(path.join(repoRoot, "native", "target", "release", "firefly-history-read.exe"), "not PE");
    return { status: 0 };
  } }), /not a Windows PE executable/);
});

test("a successful Cargo invocation producing no artifacts cannot reuse stale helpers", async context => {
  const repoRoot = await fixture(context, ["firefly-history-read.exe", "firefly-history-presence.exe"]);
  await assert.rejects(buildHistoryHelpers({ repoRoot, platform: "win32", run: () => ({ status: 0 }) }), /missing.*firefly-history-read\.exe/i);
});

test("non-Windows CLI reports an unsupported native build instead of success", { skip: process.platform === "win32" }, () => {
  const script = fileURLToPath(new URL("./history-helpers.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Windows.*not built/i);
  assert.doesNotMatch(result.stdout, /built|verified/);
});
