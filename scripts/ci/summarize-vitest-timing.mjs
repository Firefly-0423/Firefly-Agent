// Summarises where a verbose Vitest log spent its time: slowest tests, slowest files, and how many tests passed the
// usual timeout marks. Read-only diagnostics: it never changes the test result and always exits 0.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Colour codes: the real ESC byte, or its "^[" spelling when a log was fetched through `gh run view --log`.
// eslint-disable-next-line no-control-regex
const ANSI = /(?:\u001b|\^\[)\[[0-9;]*m/g;
// "✓ src/main/a.test.ts > suite > name 365ms 20 MB heap used" (the heap suffix only appears with --logHeapUsage).
const LINE = /^\s*([✓×↓])\s+(\S+?\.test\.[mc]?[jt]sx?)\s+>\s+(.*?)\s+(\d+)ms(?:\s+\d+\s*MB heap used)?\s*$/u;

export function parseVitestLog(text) {
  const cases = [];
  for (const raw of text.split(/\r?\n/)) {
    // Downloaded Actions logs prefix every line with an ISO timestamp (and the first one with a BOM).
    const match = LINE.exec(raw.replace(ANSI, "").replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, ""));
    if (!match) continue;
    cases.push({ state: match[1] === "✓" ? "pass" : match[1] === "×" ? "fail" : "skip", file: match[2], name: match[3], ms: Number(match[4]) });
  }
  return cases;
}

export function summarize(cases, { topTests = 25, topFiles = 15 } = {}) {
  const byFile = new Map();
  for (const item of cases) {
    const entry = byFile.get(item.file) ?? { file: item.file, ms: 0, count: 0, slowest: 0 };
    entry.ms += item.ms; entry.count += 1; entry.slowest = Math.max(entry.slowest, item.ms);
    byFile.set(item.file, entry);
  }
  const total = cases.reduce((sum, item) => sum + item.ms, 0);
  const over = limit => cases.filter(item => item.ms >= limit).length;
  return {
    totalCases: cases.length, totalMs: total, over1s: over(1000), over5s: over(5000), over10s: over(10000),
    slowestTests: [...cases].sort((a, b) => b.ms - a.ms).slice(0, topTests),
    slowestFiles: [...byFile.values()].sort((a, b) => b.ms - a.ms).slice(0, topFiles),
  };
}

export function formatSummary(summary) {
  const sec = ms => (ms / 1000).toFixed(1) + "s";
  const lines = [
    `[timing] ${summary.totalCases} timed cases, ${sec(summary.totalMs)} summed; >=1s: ${summary.over1s}, >=5s: ${summary.over5s}, >=10s: ${summary.over10s}`,
    `[timing] slowest files (summed case time):`,
    ...summary.slowestFiles.map(file => `[timing]   ${sec(file.ms).padStart(7)}  ${String(file.count).padStart(3)} cases  max ${sec(file.slowest).padStart(6)}  ${file.file}`),
    `[timing] slowest cases:`,
    ...summary.slowestTests.map(item => `[timing]   ${sec(item.ms).padStart(7)}  ${item.file} > ${item.name.slice(0, 110)}`),
  ];
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error("usage: node summarize-vitest-timing.mjs <vitest-log>");
    console.log(formatSummary(summarize(parseVitestLog(fs.readFileSync(file, "utf8")))));
  } catch (error) {
    console.log(`[timing] summary unavailable: ${error.message}`);
  }
}
