import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ForksPoolWorker } from "vitest/node";

const output = process.env.FIREFLY_VITEST_DIAGNOSTICS;
if (!output) throw new Error("FIREFLY_VITEST_DIAGNOSTICS is required");
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const installed = require("vitest/package.json").version;
const locked = JSON.parse(readFileSync("package-lock.json", "utf8")).packages["node_modules/vitest"].version;
if (installed !== "4.1.11" || installed !== locked) throw new Error("Review the Vitest worker diagnostic contract for this installed version");
const states = new WeakMap();
const trace = (event, details) => appendFileSync(path.join(output, "workers.jsonl"), JSON.stringify({ time: new Date().toISOString(), event, ...details }) + "\n");
const originalStart = ForksPoolWorker.prototype.start;
const originalSend = ForksPoolWorker.prototype.send;
const originalStop = ForksPoolWorker.prototype.stop;
trace("runner", { pid: process.pid, ppid: process.ppid, node: process.version, uv: process.versions.uv, vitest: installed, cwd: process.cwd() });

ForksPoolWorker.prototype.start = async function () {
  this.execArgv = [...this.execArgv, "--require", fileURLToPath(new URL("./trace-worker-process.cjs", import.meta.url)), "--report-on-fatalerror", "--report-exclude-env", "--report-exclude-network", `--report-directory=${output}`];
  this.env = { ...this.env, FIREFLY_VITEST_DIAGNOSTICS: output };
  await originalStart.call(this);
  const child = this.fork;
  const state = { pid: child.pid, ppid: process.pid, files: [], tasks: new Map(), stopping: false };
  states.set(this, state);
  const record = (event, details = {}) => trace(event, { pid: state.pid, ppid: state.ppid, files: state.files, stopping: state.stopping, ...details });
  const unfinished = () => [...state.tasks.values()].filter(task => !["pass", "fail", "skip", "todo"].includes(task.state));
  record("worker-start");
  child.on("exit", (code, signal) => record("worker-exit", { code, signal, unfinished: unfinished() }));
  child.on("close", (code, signal) => record("worker-close", { code, signal }));
  child.on("disconnect", () => record("worker-disconnect", { unfinished: unfinished() }));
  child.on("error", error => record("worker-error", { name: error.name, code: error.code }));
  child.stderr.on("data", chunk => appendFileSync(path.join(output, `worker-${child.pid}.stderr.log`), chunk));
  child.on("message", message => {
    if (message?.__vitest_worker_response__) {
      record("worker-response", { type: message.type, errorName: message.error?.name });
      if (message.type === "testfileFinished") state.files = [];
    }
    if (message?.t !== "q") return;
    if (message.m === "onCollected") {
      const visit = (task, file) => {
        if (task.type === "test") state.tasks.set(task.id, { id: task.id, file, name: task.name, state: task.result?.state ?? "queued" });
        for (const nested of task.tasks ?? []) visit(nested, file);
      };
      for (const file of message.a[0]) visit(file, file.filepath);
      record("collected", { tasks: [...state.tasks.values()] });
    }
    if (message.m === "onTaskUpdate") {
      for (const [id, result] of message.a[0]) {
        const task = state.tasks.get(id);
        if (task) task.state = result?.state ?? task.state;
      }
      record("task-update", { events: message.a[1], unfinished: unfinished() });
    }
  });
};

ForksPoolWorker.prototype.send = function (message) {
  const state = states.get(this);
  if (state && message?.__vitest_worker_request__) {
    if (message.type === "run" || message.type === "collect") {
      state.files = message.context.files.map(file => file.filepath);
      state.tasks.clear();
    }
    trace("worker-request", { pid: state.pid, ppid: state.ppid, type: message.type, files: state.files });
  }
  return originalSend.call(this, message);
};

ForksPoolWorker.prototype.stop = function (...args) {
  const state = states.get(this);
  if (state) {
    state.stopping = true;
    trace("worker-stop-request", { pid: state.pid, ppid: state.ppid, files: state.files });
  }
  return originalStop.apply(this, args);
};
