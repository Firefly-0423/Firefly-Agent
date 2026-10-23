import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("./trace-worker-process.cjs", import.meta.url));
const trackedSink = `
  let traceFd;
  const counts = { opens: 0, writes: 0, closes: 0 };
  const originalOpen = fs.openSync, originalWrite = fs.writeSync, originalClose = fs.closeSync;
  fs.openSync = function (...args) {
    const fd = originalOpen.apply(this, args);
    if (args[0] === path.join(output, "process-" + process.pid + ".jsonl")) {
      traceFd = fd;
      counts.opens++;
    }
    return fd;
  };
  fs.closeSync = function (fd) {
    if (fd === traceFd) counts.closes++;
    return originalClose.call(this, fd);
  };
  const isClosed = () => {
    try { fs.fstatSync(traceFd); return false; }
    catch (error) { return error.code === "EBADF"; }
  };
`;

function runFixture(context, body, { setup = "", missingSink = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "firefly-worker-trace-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const output = missingSink ? path.join(root, "absent") : root;
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs");
    const path = require("node:path");
    const { spawn } = require("node:child_process");
    const output = process.env.FIREFLY_VITEST_DIAGNOSTICS;
    ${setup}
    require(${JSON.stringify(preload)});
    ${body}
  `], {
    env: { ...process.env, FIREFLY_VITEST_DIAGNOSTICS: output },
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.ifError(result.error);
  const tracePath = path.join(output, `process-${result.pid}.jsonl`);
  const events = existsSync(tracePath)
    ? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { ...result, events };
}

test("real child lifecycle diagnostics bypass fs observers while source I/O remains observable", context => {
  const result = runFixture(context, `
    const calls = [];
    for (const method of ["readFileSync", "writeFileSync", "readdirSync", "mkdirSync", "statSync",
      "openSync", "writeSync", "closeSync"]) {
      const original = fs[method];
      fs[method] = function (...args) {
        calls.push(method);
        return original.apply(this, args);
      };
    }
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("close", code => {
      const diagnosticCalls = calls.splice(0);
      fs.writeFileSync(path.join(output, "synthetic-source.txt"), "synthetic");
      console.log(JSON.stringify({ code, diagnosticCalls, sourceCalls: calls }));
    });
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events.map(row => row.event), [
    "process-start", "child-spawn", "child-exit", "child-close", "process-exit",
  ]);
  assert.deepEqual(JSON.parse(result.stdout), {
    code: 0, diagnosticCalls: [], sourceCalls: ["writeFileSync"],
  });
});

test("short writes retain complete UTF-8 events and the trace descriptor closes once at exit", context => {
  const result = runFixture(context, `
    process.emit("uncaughtExceptionMonitor", { name: "合成", code: "演示" });
    process.exitCode = 7;
    process.on("exit", () => console.log(JSON.stringify({ ...counts, closed: isClosed() })));
  `, { setup: trackedSink + `
    fs.writeSync = function (fd, buffer, offset, length, position) {
      if (fd === traceFd) {
        counts.writes++;
        length = Math.min(length, 7);
      }
      return originalWrite.call(this, fd, buffer, offset, length, position);
    };
  ` });
  assert.equal(result.status, 7, result.stderr);
  const counts = JSON.parse(result.stdout);
  assert.equal(counts.opens, 1);
  assert.equal(counts.closes, 1);
  assert.equal(counts.closed, true);
  assert.ok(counts.writes > 3, "the trace must finish partial writes");
  assert.deepEqual(result.events.map(row => row.event), ["process-start", "uncaught-exception", "process-exit"]);
  assert.equal(result.events[1].name, "合成");
  assert.equal(result.events[1].code, "演示");
  assert.equal(result.events[2].code, 7);
});

for (const failure of ["throw", "zero"]) {
  test(`${failure} write failure closes and disables diagnostics without changing the child result`, context => {
    const result = runFixture(context, `
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      child.on("close", code => console.log(JSON.stringify({ code, ...counts, closed: isClosed() })));
    `, { setup: trackedSink + `
      fs.writeSync = function (fd, buffer, ...args) {
        if (fd === traceFd) {
          counts.writes++;
          if (buffer.toString().includes('"event":"child-spawn"')) {
            ${failure === "throw" ? 'throw Object.assign(new Error("synthetic write failure"), { code: "ENOSPC" });' : "return 0;"}
          }
        }
        return originalWrite.call(this, fd, buffer, ...args);
      };
    ` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { code: 0, opens: 1, writes: 2, closes: 1, closed: true });
    assert.deepEqual(result.events.map(row => row.event), ["process-start"]);
  });
}

test("an unavailable diagnostic sink does not prevent a real child from finishing", context => {
  const result = runFixture(context, `
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("close", code => console.log(JSON.stringify({ code })));
  `, { missingSink: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 0 });
  assert.deepEqual(result.events, []);
});

test("a diagnostic close error cannot override the process exit status", context => {
  const result = runFixture(context, `
    process.on("exit", () => console.log(JSON.stringify({ ...counts, closed: isClosed() })));
    process.exit(9);
  `, { setup: trackedSink + `
    fs.closeSync = function (fd) {
      if (fd === traceFd) counts.closes++;
      originalClose.call(this, fd);
      throw new Error("synthetic close failure");
    };
  ` });
  assert.equal(result.status, 9, result.stderr);
  assert.equal(JSON.parse(result.stdout).closes, 1);
  assert.equal(JSON.parse(result.stdout).closed, true);
  assert.deepEqual(result.events.map(row => row.event), ["process-start", "process-exit-request", "process-exit"]);
});

for (const file of ["main-desktop-memory.test.ts", "storage-safety.test.ts"]) {
  test(`${file} receives aggregate phase diagnostics without recording fixture contents`, context => {
    const result = runFixture(context, `
      process.emit("message", { __vitest_worker_request__: true, type: "run",
        context: { files: [{ filepath: ${JSON.stringify(file)} }] } });
      const fixture = fs.mkdtempSync(path.join(output, "fixture-"));
      fs.writeFileSync(path.join(fixture, "synthetic.txt"), "SYNTHETIC_CONTENT_NOT_FOR_TRACE");
      fs.rmSync(fixture, { recursive: true });
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.find(row => row.event === "phase-probe-start")?.files, [file]);
    const cleanup = result.events.find(row => row.event === "phase-sample" && row.boundary === "cleanup");
    assert.equal(cleanup?.phases["fs.writeFileSync"].calls, 1);
    assert.equal(cleanup?.phases["fs.rmSync"].calls, 1);
    assert.doesNotMatch(JSON.stringify(result.events), /SYNTHETIC_CONTENT_NOT_FOR_TRACE|synthetic\.txt/);
  });
}
