import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ISOLATION, launchPlan } from "./launch-electron.mjs";

function repo() { return fs.mkdtempSync(path.join(os.tmpdir(), "firefly-launch-")); }

test("a source checkout starts the development profile in the repository's own data folder", () => {
  const repoRoot = repo();
  try {
    const plan = launchPlan({ repoRoot, env: {}, vite: false });
    const root = path.resolve(repoRoot, DEFAULT_ISOLATION);
    assert.deepEqual(plan.args, [".", "--firefly-profile=development"]);
    assert.equal(plan.env.FIREFLY_ISOLATION_ROOT, root);
    assert.equal(fs.statSync(root).isDirectory(), true);
    assert.equal(plan.env.VITE_DEV, undefined);
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test("dev mode points Electron at the Vite server", () => {
  const repoRoot = repo();
  try { assert.equal(launchPlan({ repoRoot, env: {}, vite: true }).env.VITE_DEV, "1"); }
  finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test("an explicit root (current or legacy variable) is left to the app and no default folder is created", () => {
  const repoRoot = repo();
  try {
    const plan = launchPlan({ repoRoot, env: { FIREFLY_ISOLATION_ROOT: "D:\\elsewhere" }, vite: false });
    assert.deepEqual(plan.args, [".", "--firefly-profile=development"]);
    assert.equal(plan.env.FIREFLY_ISOLATION_ROOT, "D:\\elsewhere");
    const legacy = launchPlan({ repoRoot, env: { FIREFLY_ISOLATED_SMOKE_APPDATA: "D:\\legacy" }, vite: false });
    assert.equal(legacy.env.FIREFLY_ISOLATION_ROOT, undefined);
    assert.equal(fs.existsSync(path.resolve(repoRoot, DEFAULT_ISOLATION)), false);
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
