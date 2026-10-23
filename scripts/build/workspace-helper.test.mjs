import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildWorkspaceHelper } from "./workspace-helper.mjs";
import { verifyWorkspaceHelper } from "../verify/workspace-helper.mjs";
import { syntheticHistoryHelper } from "../verify/history-helpers-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "native", "target", "release"); await mkdir(release, { recursive: true });
  return { root, release, binary: path.join(release, "firefly-workspace.exe") };
}
test("workspace packaging uses a locked release build and verifies the newly emitted PE", async t => {
  const f = await fixture(t); await writeFile(f.binary, "stale");
  let call;
  const result = await buildWorkspaceHelper({ repoRoot: f.root, platform: "win32", run: (cmd, args, options) => {
    call = { cmd, args, options };
    assert.equal(existsSync(f.binary), false, "old artifact must be removed before Cargo runs");
    // Synthetic Cargo output; the downstream PE verification is real.
    writeFileSync(f.binary, syntheticHistoryHelper());
    return { status: 0 };
  } });
  assert.equal(result.helperPath, f.binary);
  assert.equal(call.cmd, "cargo");
  assert.deepEqual(call.args, ["build", "--release", "--locked", "--manifest-path", "native/Cargo.toml", "--features", "workspace-handle", "--bin", "firefly-workspace"]);
  assert.equal(call.options.env.CARGO_TARGET_DIR, path.join(f.root, "native", "target")); assert.equal(call.options.shell, false);
  assert.equal((await verifyWorkspaceHelper(f.release)).helperPath, f.binary);
  assert.deepEqual(await readFile(f.binary), syntheticHistoryHelper());
});
test("a successful Cargo exit cannot reuse a stale binary", async t => {
  const f = await fixture(t); await writeFile(f.binary, syntheticHistoryHelper());
  await assert.rejects(buildWorkspaceHelper({ repoRoot: f.root, platform: "win32", run: () => ({ status: 0 }) }), /missing/i);
});
test("missing, invalid PE and unsuccessful builds fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyWorkspaceHelper(f.release), /Workspace helper missing/);
  await writeFile(f.binary, "invalid"); await assert.rejects(verifyWorkspaceHelper(f.release), /Workspace helper is not a Windows PE/);
  await assert.rejects(buildWorkspaceHelper({ repoRoot: f.root, platform: "win32", run: () => ({ status: 1 }) }), /failed/i);
  await assert.rejects(buildWorkspaceHelper({ repoRoot: f.root, platform: "win32", run: () => ({ error: Error("cannot launch") }) }), /cannot launch/i);
});
test("non-Windows build is explicit and never launches Cargo", async () => {
  await assert.rejects(buildWorkspaceHelper({ platform: "linux", run: () => { throw Error("unexpected"); } }), /requires Windows/i);
});
