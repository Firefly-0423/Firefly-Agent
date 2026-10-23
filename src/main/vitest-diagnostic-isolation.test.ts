import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([0, 17])("worker diagnostics preserve source I/O spies and child exit %s", childExit => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-diagnostic-isolation-"));
  roots.push(root);
  const script = `
    const fs = require("node:fs");
    const {spawn} = require("node:child_process");
    const original = fs.writeFileSync;
    let sourceWrites = 0;
    fs.writeFileSync = function(...args) { sourceWrites++; return original.apply(this, args); };
    const child = spawn(process.execPath, ["-e", "process.exit(${childExit})"], {stdio:"ignore"});
    child.on("close", code => {
      const diagnosticSourceWrites = sourceWrites;
      fs.writeFileSync(require("node:path").join(process.env.FIREFLY_VITEST_DIAGNOSTICS, "public-fixture.txt"), "public fixture");
      console.log(JSON.stringify({sourceWrites:diagnosticSourceWrites, observedSourceWrite:sourceWrites-diagnosticSourceWrites, childExit:code}));
      process.exitCode = diagnosticSourceWrites ? 2 : 0;
    });
  `;
  const result = spawnSync(process.execPath, ["--require", path.resolve("scripts/ci/trace-worker-process.cjs"), "-e", script], {
    env: { ...process.env, FIREFLY_VITEST_DIAGNOSTICS: root },
    encoding: "utf8", windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ sourceWrites: 0, observedSourceWrite: 1, childExit });
  expect(fs.readFileSync(path.join(root, "public-fixture.txt"), "utf8")).toBe("public fixture");
  const events = fs.readdirSync(root).filter(name => name.endsWith(".jsonl")).flatMap(name => fs.readFileSync(path.join(root, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "child-spawn" }),
    expect.objectContaining({ event: "child-exit", code: childExit }),
    expect.objectContaining({ event: "child-close", code: childExit }),
    expect.objectContaining({ event: "process-exit", code: 0 }),
  ]));
});
