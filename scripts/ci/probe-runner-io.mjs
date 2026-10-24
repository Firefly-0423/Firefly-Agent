// Measures how fast the machine really is at the operations the slow integration tests repeat: durable small writes,
// atomic renames, tree create/remove, and SQLite commits with the production pragmas. It is read-only diagnostics for
// CI: it writes only inside throw-away directories and always exits 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function stats(samples) {
  if (samples.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { n: sorted.length, mean: samples.reduce((sum, value) => sum + value, 0) / samples.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function time(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function repeat(count, fn) {
  const samples = [];
  for (let index = 0; index < count; index++) samples.push(time(() => fn(index)));
  return stats(samples);
}

/** Runs every benchmark inside one fresh directory and removes it afterwards. */
export function benchmarkDirectory(base, iterations = 60) {
  const dir = fs.mkdtempSync(path.join(base, "firefly-io-probe-"));
  const payload = Buffer.alloc(4096, 1);
  try {
    const results = {};
    results["write+fsync 4KB"] = repeat(iterations, index => {
      const fd = fs.openSync(path.join(dir, `f${index}`), "w");
      try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    });
    results["write+rename"] = repeat(iterations, index => {
      const tmp = path.join(dir, `t${index}.tmp`);
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, path.join(dir, `t${index}.json`));
    });
    results["mkdir+write+rm"] = repeat(Math.max(10, iterations / 3), index => {
      const sub = path.join(dir, `d${index}`);
      fs.mkdirSync(sub);
      for (let file = 0; file < 10; file++) fs.writeFileSync(path.join(sub, `x${file}`), payload);
      fs.rmSync(sub, { recursive: true, force: true });
    });
    for (const sync of ["FULL", "NORMAL"]) {
      const db = new DatabaseSync(path.join(dir, `bench-${sync}.sqlite`));
      try {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${sync}; CREATE TABLE t(id INTEGER PRIMARY KEY, payload BLOB)`);
        const insert = db.prepare("INSERT INTO t(payload) VALUES (?)");
        results[`sqlite commit sync=${sync}`] = repeat(iterations, () => { db.exec("BEGIN"); insert.run(payload); db.exec("COMMIT"); });
      } finally { db.close(); }
    }
    results["sqlite open+schema+close"] = repeat(Math.max(8, iterations / 6), index => {
      const db = new DatabaseSync(path.join(dir, `open-${index}.sqlite`));
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
        for (let table = 0; table < 12; table++) db.exec(`CREATE TABLE t${table}(id INTEGER PRIMARY KEY, payload BLOB)`);
      } finally { db.close(); }
    });
    return results;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function defender() {
  if (process.platform !== "win32") return "n/a";
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$p = Get-MpPreference; \"realtime-monitoring-disabled=$($p.DisableRealtimeMonitoring); exclusions=$(@($p.ExclusionPath).Count)\""],
    { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim();
  } catch (error) {
    return `unavailable (${String(error.message).split("\n")[0]})`;
  }
}

function spawnLatency() {
  const samples = [];
  for (let index = 0; index < 5; index++) samples.push(time(() => execFileSync(process.execPath, ["-e", "0"], { windowsHide: true })));
  return stats(samples);
}

const row = (label, s) => `[io-probe]   ${label.padEnd(26)} mean ${s.mean.toFixed(2).padStart(8)} ms  p50 ${s.p50.toFixed(2).padStart(8)}  p95 ${s.p95.toFixed(2).padStart(8)}  max ${s.max.toFixed(2).padStart(8)}  (n=${s.n})`;

export function targets(env = process.env, cwd = process.cwd()) {
  const labelled = [["os.tmpdir() (TEMP, used by the tests)", os.tmpdir()], ["RUNNER_TEMP", env.RUNNER_TEMP], ["workspace", env.GITHUB_WORKSPACE ?? cwd]];
  const seen = new Set();
  return labelled.filter(([, dir]) => {
    if (!dir || !fs.existsSync(dir)) return false;
    const real = fs.realpathSync.native(dir).toLowerCase();
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const cpus = os.cpus();
    console.log(`[io-probe] ${os.type()} ${os.release()}  node ${process.version}  ${cpus.length} x ${cpus[0]?.model ?? "cpu"}  mem ${(os.freemem() / 2 ** 30).toFixed(1)}/${(os.totalmem() / 2 ** 30).toFixed(1)} GiB free`);
    console.log(`[io-probe] defender: ${defender()}`);
    console.log(row("spawn node -e 0", spawnLatency()));
    const report = { generatedAt: new Date().toISOString(), directories: {} };
    for (const [label, dir] of targets()) {
      console.log(`[io-probe] ${label}: ${dir}`);
      const results = benchmarkDirectory(dir);
      report.directories[`${label}: ${dir}`] = results;
      for (const [name, s] of Object.entries(results)) console.log(row(name, s));
    }
    const out = process.env.FIREFLY_VITEST_DIAGNOSTICS;
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "io-probe.json"), JSON.stringify(report, null, 2)); }
  } catch (error) {
    console.log(`[io-probe] probe unavailable: ${error.stack ?? error}`);
  }
}
