import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { benchmarkDirectory, stats, targets } from "./probe-runner-io.mjs";
import { formatSummary, parseVitestLog, summarize } from "./summarize-vitest-timing.mjs";

const ESC = String.fromCharCode(27);
const line = (state, file, name, ms) => `${ESC}[32m${state}${ESC}[39m ${file}${ESC}[2m > ${ESC}[22m${name}${ESC}[33m ${ms}${ESC}[2mms${ESC}[22m${ESC}[39m${ESC}[35m 18 MB heap used${ESC}[39m`;

test("parses coloured verbose lines, with or without an Actions timestamp or the escaped ^[ spelling", () => {
  const text = [
    line("✓", "src/a.test.ts", "suite > first", 812),
    "2026-10-10T10:53:29.4408242Z " + line("×", "src/b.test.ts", "second", 5221),
    line("✓", "src/a.test.ts", "third", 8).replaceAll(ESC, "^["),
    "stdout | src/a.test.ts > noise that is not a result line",
  ].join("\n");
  assert.deepEqual(parseVitestLog(text).map(item => [item.state, item.file, item.name, item.ms]), [
    ["pass", "src/a.test.ts", "suite > first", 812], ["fail", "src/b.test.ts", "second", 5221], ["pass", "src/a.test.ts", "third", 8],
  ]);
});

test("summarises slowest cases, files and timeout buckets", () => {
  const cases = [
    { state: "pass", file: "a", name: "x", ms: 12000 }, { state: "pass", file: "a", name: "y", ms: 400 },
    { state: "pass", file: "b", name: "z", ms: 5500 }, { state: "pass", file: "c", name: "w", ms: 1000 },
  ];
  const summary = summarize(cases, { topTests: 2, topFiles: 2 });
  assert.equal(summary.totalMs, 18900);
  assert.deepEqual([summary.over1s, summary.over5s, summary.over10s], [3, 2, 1]);
  assert.deepEqual(summary.slowestFiles.map(file => file.file), ["a", "b"]);
  assert.deepEqual(summary.slowestTests.map(item => item.name), ["x", "z"]);
  assert.match(formatSummary(summary), /\[timing\] 4 timed cases, 18\.9s summed; >=1s: 3, >=5s: 2, >=10s: 1/);
});

test("percentiles and an empty sample set", () => {
  assert.deepEqual(stats([]), { n: 0, mean: 0, p50: 0, p95: 0, max: 0 });
  const s = stats(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(s.p50, 51); assert.equal(s.p95, 96); assert.equal(s.max, 100); assert.equal(s.mean, 50.5);
});

test("probe targets are de-duplicated by real path and must exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-timing-"));
  try {
    const found = targets({ RUNNER_TEMP: dir, GITHUB_WORKSPACE: path.join(dir, "missing") }, dir);
    const real = found.map(([, target]) => fs.realpathSync.native(target).toLowerCase());
    assert.equal(new Set(real).size, real.length);
    assert.ok(real.includes(fs.realpathSync.native(dir).toLowerCase()));
    assert.ok(!found.some(([, target]) => target.endsWith("missing")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("benchmarks run to completion and leave no directory behind", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-timing-"));
  try {
    const results = benchmarkDirectory(base, 3);
    assert.ok(results["write+fsync 4KB"].n === 3 && results["sqlite commit sync=FULL"].n === 3);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
