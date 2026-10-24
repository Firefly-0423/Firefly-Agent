import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const checkerUrl = new URL("./storage-boundary.mjs", import.meta.url);
async function checker() { assert.ok(fs.existsSync(checkerUrl), "storage boundary checker unavailable"); return import(checkerUrl.href); }
test("rejects a new direct userData bypass and ignores comments", async () => {
  const { checkDirectAccess } = await checker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-path-gate-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/new.ts"), 'app.getPath("userData"); // app.getPath("sessionData")');
    assert.throws(() => checkDirectAccess(root, []), /UNAPPROVED_STORAGE_ACCESS/);
    const allowed = [{ file: "src/new.ts", method: "getPath", root: "userData", count: 1, category: "MIGRATE_LATER" }];
    assert.equal(checkDirectAccess(root, allowed).total, 1);
    fs.appendFileSync(path.join(root, "src/new.ts"), '\napp.getPath("userData");');
    assert.throws(() => checkDirectAccess(root, allowed), /UNAPPROVED_STORAGE_ACCESS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("rejects an unapproved dynamic path lookup", async () => {
  const { checkDirectAccess } = await checker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-path-gate-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/new.ts"), 'app["getPath"](kind);');
    assert.throws(() => checkDirectAccess(root, []), /UNAPPROVED_STORAGE_ACCESS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("does not classify local helpers or a typed home/desktop lookup as persistent storage", async () => {
  const { checkDirectAccess } = await checker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-path-gate-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/new.ts"), 'const getPath = () => "fixture"; getPath(); function safeGetPath(name: "home" | "desktop") { return app.getPath(name); }');
    assert.equal(checkDirectAccess(root, []).total, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
