const { openSync, writeSync, closeSync } = require("node:fs");
const path = require("node:path");
const { ChildProcess } = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const output = process.env.FIREFLY_VITEST_DIAGNOSTICS;
// appendFileSync calls the mutable fs.writeFileSync export in Node. Capture the
// low-level operations before tests install I/O spies, and keep our own descriptor.
// Diagnostics are best-effort: a failed sink must not change the observed process.
let traceFd = null;
try { traceFd = openSync(path.join(output, `process-${process.pid}.jsonl`), "a"); }
catch { /* The runner owns the diagnostic directory; tests can still run without it. */ }
const closeTrace = () => {
  if (traceFd === null) return;
  const fd = traceFd;
  traceFd = null;
  try { closeSync(fd); } catch { /* Do not replace the worker's exit status. */ }
};
const write = (event, details = {}) => {
  if (traceFd === null) return;
  try {
    const data = Buffer.from(JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ppid: process.ppid, ...details }) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(traceFd, data, offset, data.length - offset);
      if (written <= 0) { closeTrace(); return; }
      offset += written;
    }
  } catch { closeTrace(); }
};
const stack = () => new Error().stack.split("\n").slice(2, 10);
write("process-start", { node: process.version, uv: process.versions.uv });
process.on("exit", code => {
  try { write("process-exit", { code }); }
  finally { closeTrace(); }
});
process.on("disconnect", () => write("process-disconnect"));
process.on("uncaughtExceptionMonitor", error => write("uncaught-exception", { name: error.name, code: error.code }));
for (const method of ["exit", "abort", "kill"]) {
  const original = process[method];
  process[method] = function (...args) {
    write(`process-${method}-request`, { values: args, stack: stack() });
    return original.apply(this, args);
  };
}
const originalSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (...args) {
  const result = originalSpawn.apply(this, args);
  const executable = args[0].file;
  const isBash = path.basename(executable) === "bash.exe";
  write("child-spawn", {
    childPid: this.pid,
    executable: isBash ? executable : path.basename(executable),
    ...(isBash ? { phase: args[0].args.at(-1) === "printf firefly-bash-probe" ? "probe" : "command" } : {}),
  });
  this.on("exit", (code, signal) => write("child-exit", { childPid: this.pid, code, signal }));
  this.on("close", (code, signal) => write("child-close", { childPid: this.pid, code, signal }));
  return result;
};
const originalKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
  write("child-kill", { childPid: this.pid, signal, stack: stack() });
  return originalKill.call(this, signal);
};
syncBuiltinESMExports();

// Sample only the failing fixture-heavy files. Durability calls still run unchanged;
// records contain phase labels/timings, never file contents, SQL, or key material.
const phaseFiles = new Set([
  "canonical-summary.test.ts", "main-s-runtime-port.test.ts",
  "history-migration.test.ts", "main-fact-selector.test.ts",
  "history-native-contract.test.ts",
  "runtime-summary.test.ts",
  "current-skills-compatibility.test.ts",
  "main-desktop-memory.test.ts", "storage-safety.test.ts",
]);
let phaseProbeEnabled = false;
let flushPhase = () => {};
const originalSend = process.send;
process.send = function (message, ...args) {
  if (message?.__vitest_worker_response__ && message.type === "testfileFinished") flushPhase();
  return originalSend.call(this, message, ...args);
};
process.on("message", message => {
  if (phaseProbeEnabled || !message?.__vitest_worker_request__ || message.type !== "run") return;
  const files = message.context.files.map(file => path.basename(file.filepath));
  if (!files.some(file => phaseFiles.has(file))) return;
  phaseProbeEnabled = true;
  installPhaseProbe(files);
});
function installPhaseProbe(files) {
  const fs = require("node:fs");
  const { performance } = require("node:perf_hooks");
  const { DatabaseSync } = require("node:sqlite");
  const databases = new WeakMap();
  let sample = { number: 0, started: performance.now(), phases: {} };
  const flush = boundary => write("phase-sample", {
    files, sample: sample.number, boundary, elapsedMs: performance.now() - sample.started,
    phases: sample.phases,
  });
  const measured = (label, run) => {
    const target = sample, started = performance.now(), cpu = process.cpuUsage();
    try { return run(); }
    finally {
      const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
      const phase = target.phases[label] ??= { calls: 0, wallMs: 0, cpuMs: 0, maxMs: 0 };
      phase.calls++; phase.wallMs += wallMs; phase.cpuMs += (used.user + used.system) / 1000;
      phase.maxMs = Math.max(phase.maxMs, wallMs);
    }
  };
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = function (...args) {
    if (sample.number) flush("next-fixture");
    sample = { number: sample.number + 1, started: performance.now(), phases: {} };
    return measured("fixture.directory", () => mkdtemp.apply(this, args));
  };
  for (const method of ["fsyncSync", "cpSync", "readFileSync", "writeFileSync", "rmSync"]) {
    const original = fs[method];
    let depth = 0;
    fs[method] = function (...args) {
      if (depth) return original.apply(this, args);
      depth++;
      try { return measured("fs." + method, () => original.apply(this, args)); }
      finally { depth--; if (method === "rmSync" && !depth) flush("cleanup"); }
    };
  }
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.exec = function (sql) {
    const state = databases.get(this) ?? { configured: false };
    databases.set(this, state);
    const configure = /journal_mode/i.test(sql);
    const label = configure ? "sqlite.WAL_FULL" : /\bCOMMIT\b/i.test(sql)
      ? (state.configured ? "transaction.commit" : "schema.commit")
      : /\bROLLBACK\b/i.test(sql) ? "sqlite.rollback" : "sqlite.other";
    const result = measured(label, () => exec.call(this, sql));
    if (configure) { state.configured = true; flush("database-ready"); }
    return result;
  };
  DatabaseSync.prototype.close = function () {
    try { return measured("database.close", () => close.call(this)); }
    finally { flush("database-close"); }
  };
  flushPhase = () => flush("file-finished");
  syncBuiltinESMExports();
  write("phase-probe-start", { files });
}
