// Packaged & dev-build plugin smoke verification via CDP with strict temp isolation and PID-scoped cleanup.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");

export const SMOKE_PROFILE_NAME = "smoke";
export const PRODUCTION_DATA_DIR_NAMES = Object.freeze(["Firefly-1.2.0", "Firefly"]);

export class SmokeIsolationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SmokeIsolationError";
    this.code = code;
  }
}

/** Resolve existing ancestors through Windows junctions/symlinks, preserving non-existent tail segments. */
export function canonicalPath(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new SmokeIsolationError("ISOLATION_INVALID", "Isolation path must be a non-empty string");
  }
  let current = path.resolve(targetPath);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SmokeIsolationError("ISOLATION_INVALID", `Cannot resolve root ancestor for ${targetPath}`);
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}

function normalizeForCompare(targetPath, platform = process.platform) {
  const normalized = path.normalize(targetPath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `candidate` equals `parent` or resides strictly underneath `parent`. */
export function withinPath(parent, candidate, platform = process.platform) {
  const p = normalizeForCompare(parent, platform);
  const c = normalizeForCompare(candidate, platform);
  const relative = path.relative(p, c);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(a, b, platform = process.platform) {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

/**
 * Enforce strict temporary-directory isolation and explicitly reject `%APPDATA%\Firefly-1.2.0`,
 * `%APPDATA%`, or any non-temp production data root before launching the app.
 */
export function validateIsolationRoot(isolationRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const appData = options.appData !== undefined ? options.appData : process.env.APPDATA;
  const localAppData = options.localAppData !== undefined ? options.localAppData : process.env.LOCALAPPDATA;
  const userProfile = options.userProfile !== undefined ? options.userProfile : (process.env.USERPROFILE || os.homedir());
  const tempDir = options.tempDir !== undefined ? options.tempDir : os.tmpdir();

  if (typeof isolationRoot !== "string" || !isolationRoot.trim()) {
    throw new SmokeIsolationError("ISOLATION_INVALID", "Isolation root must be a non-empty absolute path");
  }
  if (!path.isAbsolute(isolationRoot)) {
    throw new SmokeIsolationError("ISOLATION_INVALID", `Isolation root must be absolute: ${isolationRoot}`);
  }

  const canonicalTarget = canonicalPath(isolationRoot);

  // Explicitly reject production AppData roots and any overlap/junction into them.
  if (typeof appData === "string" && appData.trim()) {
    const canonicalAppData = canonicalPath(appData);
    const forbiddenProductionRoots = [
      canonicalAppData,
      ...PRODUCTION_DATA_DIR_NAMES.map((dirName) => path.join(canonicalAppData, dirName)),
    ];
    for (const forbidden of forbiddenProductionRoots) {
      if (withinPath(forbidden, canonicalTarget, platform) || withinPath(canonicalTarget, forbidden, platform)) {
        throw new SmokeIsolationError(
          "ISOLATION_PRODUCTION_REJECTED",
          `Refusing production data root or overlap with ${forbidden}: ${isolationRoot}`,
        );
      }
    }
  }

  // Reject direct profile roots such as %LOCALAPPDATA% or %USERPROFILE% themselves.
  for (const baseRoot of [localAppData, userProfile]) {
    if (typeof baseRoot === "string" && baseRoot.trim()) {
      const canonicalBase = canonicalPath(baseRoot);
      if (samePath(canonicalTarget, canonicalBase, platform)) {
        throw new SmokeIsolationError(
          "ISOLATION_PRODUCTION_REJECTED",
          `Refusing user profile root as isolation directory: ${isolationRoot}`,
        );
      }
    }
  }

  if (typeof tempDir !== "string" || !tempDir.trim()) {
    throw new SmokeIsolationError("ISOLATION_NON_TEMP_REJECTED", "OS temp directory is unavailable");
  }
  const canonicalTemp = canonicalPath(tempDir);
  if (!withinPath(canonicalTemp, canonicalTarget, platform) || samePath(canonicalTarget, canonicalTemp, platform)) {
    throw new SmokeIsolationError(
      "ISOLATION_NON_TEMP_REJECTED",
      `Isolation root must be a dedicated subdirectory inside temp (${canonicalTemp}): ${isolationRoot}`,
    );
  }

  return { valid: true, canonicalIsolationRoot: canonicalTarget };
}

export function buildIsolatedEnv({ workRoot, baseEnv = process.env }) {
  const resolvedWorkRoot = path.resolve(workRoot);
  const dirs = {
    appdata: path.join(resolvedWorkRoot, "appdata"),
    localappdata: path.join(resolvedWorkRoot, "localappdata"),
    temp: path.join(resolvedWorkRoot, "temp"),
    cache: path.join(resolvedWorkRoot, "cache"),
  };
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const env = {
    ...baseEnv,
    VITE_DEV: "",
    FIREFLY_RUNTIME_PROFILE: SMOKE_PROFILE_NAME,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.localappdata,
    TEMP: dirs.temp,
    TMP: dirs.temp,
    TMPDIR: dirs.temp,
    XDG_CACHE_HOME: dirs.cache,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function findPackagedExecutable(unpackedDir) {
  const candidates = ["Firefly_Agent.exe", "Firefly.exe"];
  for (const name of candidates) {
    const candidate = path.join(unpackedDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  const rootExe = fs
    .readdirSync(unpackedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe") && !/unins/i.test(entry.name))
    .map((entry) => path.join(unpackedDir, entry.name));
  if (rootExe.length === 1) return rootExe[0];
  throw new Error(`Could not locate packaged Firefly executable in ${unpackedDir}`);
}

export function resolveLaunchTarget({
  unpackedDir,
  dryRun = false,
  repoRoot = DEFAULT_REPO_ROOT,
  isolationRoot,
  cdpPort,
  isolationOptions,
}) {
  const { canonicalIsolationRoot } = validateIsolationRoot(isolationRoot, isolationOptions);
  const portNum = Number(cdpPort);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`Invalid CDP port: ${cdpPort}`);
  }

  const smokeFlags = [
    `--firefly-profile=${SMOKE_PROFILE_NAME}`,
    `--firefly-isolation-root=${canonicalIsolationRoot}`,
    `--remote-debugging-port=${portNum}`,
  ];

  if (dryRun) {
    const mainEntry = path.join(repoRoot, "dist", "main", "main", "index.js");
    const preloadEntry = path.join(repoRoot, "dist", "preload", "preload", "index.js");
    const rendererEntry = path.join(repoRoot, "dist", "renderer", "react", "index.html");
    for (const requiredFile of [mainEntry, preloadEntry, rendererEntry]) {
      if (!fs.existsSync(requiredFile)) {
        throw new Error(`Dev build artifact missing (${requiredFile}); run "pnpm run build" first`);
      }
    }
    const electronExe = require(path.join(repoRoot, "node_modules", "electron"));
    if (typeof electronExe !== "string" || !fs.existsSync(electronExe)) {
      throw new Error(`Electron binary missing in ${repoRoot}`);
    }
    return {
      mode: "dry-run",
      executablePath: electronExe,
      args: [".", ...smokeFlags],
      cwd: repoRoot,
      isolationRoot: canonicalIsolationRoot,
      cdpPort: portNum,
    };
  }

  if (!unpackedDir || typeof unpackedDir !== "string") {
    throw new Error("Packaged win-unpacked directory is required unless --dry-run is specified");
  }
  const resolvedUnpacked = path.resolve(unpackedDir);
  if (!fs.existsSync(resolvedUnpacked) || !fs.statSync(resolvedUnpacked).isDirectory()) {
    throw new Error(`win-unpacked directory does not exist: ${resolvedUnpacked}`);
  }
  const executablePath = findPackagedExecutable(resolvedUnpacked);
  const resourcesAsar = path.join(resolvedUnpacked, "resources", "app.asar");
  const resourcesAppDir = path.join(resolvedUnpacked, "resources", "app");
  if (!fs.existsSync(resourcesAsar) && !fs.existsSync(resourcesAppDir)) {
    throw new Error(`Packaged resources missing app.asar/app under ${resolvedUnpacked}`);
  }
  return {
    mode: "packaged",
    executablePath,
    args: smokeFlags,
    cwd: resolvedUnpacked,
    isolationRoot: canonicalIsolationRoot,
    cdpPort: portNum,
  };
}

function defaultQueryProcesses() {
  if (process.platform !== "win32") return [];
  const raw = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
  ).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function defaultKillPid(pid, { tree = false } = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return;
  if (process.platform === "win32") {
    const taskkillExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const args = ["/PID", String(numericPid), ...(tree ? ["/T"] : []), "/F"];
    try {
      execFileSync(taskkillExe, args, { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } catch {
      // Process may have already exited.
    }
    return;
  }
  try {
    process.kill(numericPid, "SIGKILL");
  } catch {
    // Process may have already exited.
  }
}

/**
 * Tracks ONLY PIDs launched or owned by this script instance so cleanup never touches
 * unrelated `electron.exe` or host processes.
 */
export function createProcessTracker({
  queryProcesses = defaultQueryProcesses,
  killPid = defaultKillPid,
} = {}) {
  const rootPids = new Set();
  const helperPids = new Set();

  function recordRootPid(pid) {
    if (Number.isInteger(pid) && pid > 0) rootPids.add(pid);
  }

  function recordHelperPid(pid) {
    if (Number.isInteger(pid) && pid > 0) helperPids.add(pid);
  }

  function collectOwnedTree() {
    const snapshot = queryProcesses();
    const byParent = new Map();
    const byPid = new Map();
    for (const proc of snapshot) {
      const pid = Number(proc.ProcessId);
      const ppid = Number(proc.ParentProcessId);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      byPid.set(pid, proc);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(proc);
    }

    const ownedPids = new Set([...rootPids, ...helperPids]);
    const queue = [...rootPids];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift();
      const children = byParent.get(current) ?? [];
      for (const child of children) {
        const childPid = Number(child.ProcessId);
        ownedPids.add(childPid);
        if (!visited.has(childPid)) {
          visited.add(childPid);
          queue.push(childPid);
        }
      }
    }
    return { ownedPids, byPid, snapshot };
  }

  function findPluginUtilityProcessPids({ cdpProcessInfo = [], excludePids = new Set() } = {}) {
    const { ownedPids, byPid } = collectOwnedTree();
    const cdpNodeUtilityPids = new Set(
      cdpProcessInfo
        .filter((entry) => entry && entry.type === "node.mojom.NodeService")
        .map((entry) => Number(entry.id))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const result = [];
    for (const pid of ownedPids) {
      if (rootPids.has(pid) || excludePids.has(pid)) continue;
      const proc = byPid.get(pid);
      const cmd = typeof proc?.CommandLine === "string" ? proc.CommandLine : "";
      const isNodeUtilityCmd = cmd.includes("--type=utility") && cmd.includes("--utility-sub-type=node.mojom.NodeService");
      if (isNodeUtilityCmd || cdpNodeUtilityPids.has(pid)) {
        result.push(pid);
      }
    }
    return result;
  }

  function killPluginUtilityPids(pids) {
    const { ownedPids } = collectOwnedTree();
    const killed = [];
    for (const pid of pids) {
      if (!ownedPids.has(pid) || rootPids.has(pid)) {
        throw new Error(`Refusing to kill non-plugin or unowned PID ${pid}`);
      }
      killPid(pid, { tree: false });
      killed.push(pid);
    }
    return killed;
  }

  function cleanup() {
    let ownedPids;
    try {
      ({ ownedPids } = collectOwnedTree());
    } catch {
      ownedPids = new Set([...rootPids, ...helperPids]);
    }
    const killed = [];
    // Kill descendants first, then root PIDs, strictly scoped to script-owned PIDs.
    const ordered = [
      ...[...ownedPids].filter((pid) => !rootPids.has(pid)),
      ...[...rootPids],
    ];
    for (const pid of ordered) {
      killPid(pid, { tree: true });
      killed.push(pid);
    }
    return killed;
  }

  return {
    recordRootPid,
    recordHelperPid,
    collectOwnedTree,
    findPluginUtilityProcessPids,
    killPluginUtilityPids,
    cleanup,
    getRootPids: () => [...rootPids],
    getHelperPids: () => [...helperPids],
  };
}

export function parseSmokeArgs(argv) {
  const parsed = {
    unpackedDir: undefined,
    dryRun: false,
    isolationRoot: undefined,
    cdpPort: undefined,
    packagesDir: undefined,
    weatherPkg: undefined,
    reminderPkg: undefined,
    examplesDir: undefined,
    outputDir: undefined,
    keepIsolation: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--keep-isolation") {
      parsed.keepIsolation = true;
    } else if (arg.startsWith("--unpacked=")) {
      parsed.unpackedDir = arg.slice("--unpacked=".length);
    } else if (arg === "--unpacked") {
      parsed.unpackedDir = argv[++i];
    } else if (arg.startsWith("--isolation-root=")) {
      parsed.isolationRoot = arg.slice("--isolation-root=".length);
    } else if (arg === "--isolation-root") {
      parsed.isolationRoot = argv[++i];
    } else if (arg.startsWith("--cdp-port=")) {
      parsed.cdpPort = Number(arg.slice("--cdp-port=".length));
    } else if (arg === "--cdp-port") {
      parsed.cdpPort = Number(argv[++i]);
    } else if (arg.startsWith("--packages-dir=")) {
      parsed.packagesDir = arg.slice("--packages-dir=".length);
    } else if (arg === "--packages-dir") {
      parsed.packagesDir = argv[++i];
    } else if (arg.startsWith("--weather-pkg=")) {
      parsed.weatherPkg = arg.slice("--weather-pkg=".length);
    } else if (arg === "--weather-pkg") {
      parsed.weatherPkg = argv[++i];
    } else if (arg.startsWith("--reminder-pkg=")) {
      parsed.reminderPkg = arg.slice("--reminder-pkg=".length);
    } else if (arg === "--reminder-pkg") {
      parsed.reminderPkg = argv[++i];
    } else if (arg.startsWith("--examples-dir=")) {
      parsed.examplesDir = arg.slice("--examples-dir=".length);
    } else if (arg === "--examples-dir") {
      parsed.examplesDir = argv[++i];
    } else if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--output-dir") {
      parsed.outputDir = argv[++i];
    } else if (!arg.startsWith("-") && !parsed.unpackedDir) {
      parsed.unpackedDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

function listFilesRecursive(rootDir, baseDir = rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, full).replace(/\\/g, "/"));
    }
  }
  return files;
}

function packExampleDir(sourceDir, outFile, repoRoot) {
  const cliCandidates = [
    path.resolve(sourceDir, "../../dist/cli/firefly-plugin.mjs"),
    path.resolve(repoRoot, "plugin-sdk/dist/cli/firefly-plugin.mjs"),
  ];
  const cliPath = cliCandidates.find((p) => fs.existsSync(p));
  if (cliPath) {
    const res = spawnSync(process.execPath, [cliPath, "pack", sourceDir, "-o", outFile], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0) {
      throw new Error(`firefly-plugin pack failed for ${sourceDir}: ${res.stderr || res.stdout}`);
    }
    return outFile;
  }

  // Fallback: produce a deterministic .ffplugin ZIP directly via jszip when plugin-sdk CLI dist is absent.
  const JSZip = require(path.join(repoRoot, "node_modules", "jszip"));
  const zip = new JSZip();
  const entryDate = new Date(Date.UTC(2020, 0, 1));
  for (const relPath of listFilesRecursive(sourceDir)) {
    if (relPath.endsWith(".test.ts")) continue;
    zip.file(relPath, fs.readFileSync(path.join(sourceDir, relPath)), { date: entryDate, createFolders: false });
  }
  return zip
    .generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } })
    .then((buf) => {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, buf);
      return outFile;
    });
}

async function resolvePluginPackages({ weatherPkg, reminderPkg, packagesDir, examplesDir, repoRoot, tempWorkDir }) {
  const pkgOutDir = path.join(tempWorkDir, "packages");
  fs.mkdirSync(pkgOutDir, { recursive: true });

  const findInDir = (dir, prefix) => {
    const hit = fs
      .readdirSync(dir, { withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name.startsWith(prefix) && /\.(ffplugin|zip)$/i.test(entry.name));
    return hit ? path.join(dir, hit.name) : undefined;
  };

  let resolvedWeather = weatherPkg ? path.resolve(weatherPkg) : undefined;
  let resolvedReminder = reminderPkg ? path.resolve(reminderPkg) : undefined;

  if (packagesDir) {
    const resolvedDir = path.resolve(packagesDir);
    resolvedWeather = resolvedWeather ?? findInDir(resolvedDir, "dev.firefly.weather");
    resolvedReminder = resolvedReminder ?? findInDir(resolvedDir, "dev.firefly.reminder");
  }

  if (!resolvedWeather || !resolvedReminder) {
    const candidateExamples = [
      examplesDir ? path.resolve(examplesDir) : undefined,
      path.resolve(repoRoot, "..", "firefly-sdk-examples", "plugin-sdk", "examples"),
      path.resolve(repoRoot, "plugin-sdk", "examples"),
    ].filter(Boolean);
    const matchedExamples = candidateExamples.find(
      (dir) => fs.existsSync(path.join(dir, "dev.firefly.weather")) && fs.existsSync(path.join(dir, "dev.firefly.reminder")),
    );
    if (matchedExamples) {
      if (!resolvedWeather) {
        resolvedWeather = await packExampleDir(
          path.join(matchedExamples, "dev.firefly.weather"),
          path.join(pkgOutDir, "dev.firefly.weather.ffplugin"),
          repoRoot,
        );
      }
      if (!resolvedReminder) {
        resolvedReminder = await packExampleDir(
          path.join(matchedExamples, "dev.firefly.reminder"),
          path.join(pkgOutDir, "dev.firefly.reminder.ffplugin"),
          repoRoot,
        );
      }
    }
  }

  if (!resolvedWeather || !fs.existsSync(resolvedWeather)) {
    throw new Error("Missing dev.firefly.weather .ffplugin package (pass --weather-pkg, --packages-dir, or --examples-dir)");
  }
  if (!resolvedReminder || !fs.existsSync(resolvedReminder)) {
    throw new Error("Missing dev.firefly.reminder .ffplugin package (pass --reminder-pkg, --packages-dir, or --examples-dir)");
  }

  return { weatherPkg: resolvedWeather, reminderPkg: resolvedReminder };
}

function startMockOpenAiServer() {
  const state = {
    requests: [],
    toolOutputs: [],
    cancelledObserved: false,
  };
  let activeHoldRelease = null;
  let toolCallSeq = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /\/chat\/completions\/?$/.test(req.url || "")) {
      let bodyText = "";
      req.on("data", (chunk) => { bodyText += chunk; });
      req.on("end", () => {
        const body = JSON.parse(bodyText || "{}");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        state.requests.push({ model: body.model, messageCount: messages.length, stream: body.stream });

        const lastToolIndex = messages.findLastIndex((m) => m.role === "tool");
        const lastRealUserIndex = messages.findLastIndex((m) => {
          if (m.role !== "user") return false;
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
          return text.includes("SMOKE_");
        });
        const toolMsg = lastToolIndex > lastRealUserIndex ? messages[lastToolIndex] : undefined;
        const lastUser = lastRealUserIndex >= 0
          ? messages[lastRealUserIndex]
          : [...messages].reverse().find((m) => m.role === "user");
        const userText = typeof lastUser?.content === "string"
          ? lastUser.content
          : JSON.stringify(lastUser?.content ?? "");
        const usage = { prompt_tokens: 42, completion_tokens: 16, total_tokens: 58 };
        const chunk = (delta, finishReason = null) =>
          `data: ${JSON.stringify({
            id: "smoke-mock-chunk",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || "smoke-mock-model",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(finishReason ? { usage } : {}),
          })}\n\n`;

        if (toolMsg) {
          state.toolOutputs.push(toolMsg.content);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
          res.write(chunk({ role: "assistant", content: "已调用 list_reminders 并完成检查。" }));
          res.write(chunk({}, "stop"));
          res.end("data: [DONE]\n\n");
          return;
        }

        if (userText.includes("SMOKE_CANCEL_MID_FLIGHT")) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
          res.flushHeaders?.();
          res.write(chunk({ role: "assistant" }));
          res.write(chunk({ content: "正在处理可取消任务，请稍候…" }));
          const keepalive = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) {
              res.write(": keepalive\n\n");
            }
          }, 300);
          const safety = setTimeout(() => {
            clearInterval(keepalive);
            if (!res.writableEnded) {
              res.write(chunk({}, "stop"));
              res.end("data: [DONE]\n\n");
            }
          }, 30000);
          activeHoldRelease = () => {
            clearInterval(keepalive);
            clearTimeout(safety);
            if (!res.writableEnded) res.end();
          };
          const markAborted = () => {
            if (!res.writableEnded) {
              state.cancelledObserved = true;
            }
            clearInterval(keepalive);
            clearTimeout(safety);
          };
          req.on("aborted", markAborted);
          req.on("close", markAborted);
          res.on("close", markAborted);
          return;
        }

        // Default / SMOKE_LIST_REMINDERS turn: request plugin tool execution.
        const callId = `call_smoke_list_reminders_${++toolCallSeq}`;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.write(
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "plugin_dev_firefly_reminder__list_reminders", arguments: "{}" },
              },
            ],
          }),
        );
        res.write(chunk({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        state,
        close: () => {
          activeHoldRelease?.();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
    server.on("error", reject);
  });
}

function seedIsolatedProfile({ isolationRoot, workRoot, mockBaseUrl }) {
  const userDataDir = path.join(isolationRoot, `Firefly-${SMOKE_PROFILE_NAME}`);
  const workspaceDir = path.join(workRoot, "smoke-workspace");
  const sessionsDir = path.join(userDataDir, "firefly-chats", "sessions");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "README.txt"), "Smoke test workspace file.\n", "utf8");

  const modelConfig = {
    provider: "OpenRouter",
    baseUrl: mockBaseUrl,
    model: "openai/smoke-mock",
    apiKey: "synthetic-smoke-mock-key",
    explicitTransport: "openai",
    contextWindowTokens: 128000,
  };
  fs.writeFileSync(
    path.join(userDataDir, "model-settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      contextWindowVersion: 2,
      mode: "manual",
      ...modelConfig,
      perProvider: { OpenRouter: modelConfig },
      modelProfiles: [{ id: "smoke-mock-profile", ...modelConfig }],
      defaultModelProfileId: "smoke-mock-profile",
      chatRequestTimeoutSec: 30,
      rerankerMode: "none",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(userDataDir, "app-settings.json"),
    JSON.stringify({ locale: "zh-CN", autoCheckUpdates: false, petVisible: false }),
    "utf8",
  );

  const now = Date.now();
  const workSession = {
    id: "smoke-work",
    mode: "work",
    title: "Smoke Work Session",
    schemaVersion: 1,
    identityId: null,
    createdAt: now - 1000,
    updatedAt: now,
    messages: [],
    workspaceBinding: {
      workspaceRoot: workspaceDir,
      displayName: "smoke-workspace",
      boundAt: now,
    },
  };
  fs.writeFileSync(path.join(sessionsDir, "smoke-work.json"), JSON.stringify(workSession), "utf8");
  fs.writeFileSync(
    path.join(userDataDir, "firefly-chats", "index.json"),
    JSON.stringify([
      {
        id: workSession.id,
        mode: workSession.mode,
        title: workSession.title,
        identityId: null,
        createdAt: workSession.createdAt,
        updatedAt: workSession.updatedAt,
        messageCount: 0,
        workspaceRoot: workspaceDir,
        workspaceDisplayName: "smoke-workspace",
      },
    ]),
    "utf8",
  );

  return { userDataDir, workspaceDir, sessionId: workSession.id };
}

async function pickOpenFileDialogWin32(ownerPid, filePath) {
  if (process.platform !== "win32") {
    throw new Error("Native Open File dialog automation is only supported on Windows");
  }
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32SmokeDlg {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public static IntPtr FindDialog(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(64);
      GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindByIdAndClass(IntPtr hDlg, int ctrlId, string className) {
    IntPtr match = IntPtr.Zero;
    EnumChildWindows(hDlg, (h, _) => {
      if (GetDlgCtrlID(h) != ctrlId) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, cls.Capacity);
      if (className == null || cls.ToString() == className) { match = h; return false; }
      return true;
    }, IntPtr.Zero);
    return match;
  }
}
"@
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$hDlg = [IntPtr]::Zero
while ([DateTime]::UtcNow -lt $deadline) {
  $hDlg = [Win32SmokeDlg]::FindDialog([uint32]${ownerPid})
  if ($hDlg -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ($hDlg -eq [IntPtr]::Zero) { throw "Native Open File dialog not found for PID ${ownerPid}" }
$hEdit = [Win32SmokeDlg]::FindByIdAndClass($hDlg, 1148, "Edit")
if ($hEdit -eq [IntPtr]::Zero) { throw "Filename Edit (1148) not found in dialog" }
$hOk = [Win32SmokeDlg]::FindByIdAndClass($hDlg, 1, "Button")
if ($hOk -eq [IntPtr]::Zero) { throw "Open Button (1) not found in dialog" }
[Win32SmokeDlg]::SendMessage($hEdit, 0x000C, [IntPtr]::Zero, $env:SMOKE_PICK_FILE) | Out-Null
Start-Sleep -Milliseconds 150
[Win32SmokeDlg]::PostMessage($hOk, 0x0201, [IntPtr]1, [IntPtr]0x00050005) | Out-Null
Start-Sleep -Milliseconds 50
[Win32SmokeDlg]::PostMessage($hOk, 0x0202, [IntPtr]0, [IntPtr]0x00050005) | Out-Null
$closeDeadline = [DateTime]::UtcNow.AddSeconds(8)
while ([DateTime]::UtcNow -lt $closeDeadline) {
  if (-not [Win32SmokeDlg]::IsWindow($hDlg)) { break }
  Start-Sleep -Milliseconds 100
}
if ([Win32SmokeDlg]::IsWindow($hDlg)) { throw "Open File dialog failed to close after submit" }
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", psScript], {
      windowsHide: true,
      env: { ...process.env, SMOKE_PICK_FILE: filePath },
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Dialog helper timed out: ${output}`));
    }, 25000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Dialog helper failed (${code}): ${output}`));
    });
  });
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 150, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function runPackagedPluginSmoke(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const dryRun = Boolean(options.dryRun);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-packaged-smoke-"));
  const isolationRoot = options.isolationRoot
    ? path.resolve(options.isolationRoot)
    : path.join(workRoot, "profile");
  fs.mkdirSync(isolationRoot, { recursive: true });

  const cdpPort = options.cdpPort ?? await getFreeTcpPort();
  const launchSpec = resolveLaunchTarget({
    unpackedDir: options.unpackedDir,
    dryRun,
    repoRoot,
    isolationRoot,
    cdpPort,
  });

  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.join(workRoot, "report");
  fs.mkdirSync(outputDir, { recursive: true });

  const report = {
    ok: false,
    startedAt: new Date().toISOString(),
    mode: launchSpec.mode,
    cdpPort: launchSpec.cdpPort,
    isolationRoot: launchSpec.isolationRoot,
    outputDir,
    launchedPid: null,
    killedPluginUtilityPids: [],
    steps: [],
    screenshots: [],
    toolOutputs: [],
    cancelledObserved: false,
    errors: [],
  };

  const writeReport = () => {
    fs.writeFileSync(path.join(outputDir, "smoke-report.json"), JSON.stringify(report, null, 2), "utf8");
  };
  const recordStep = (name, details = {}) => {
    report.steps.push({ name, at: new Date().toISOString(), ...details });
    writeReport();
  };
  const takeScreenshot = async (page, filename) => {
    const filePath = path.join(outputDir, filename);
    await page.screenshot({ path: filePath, animations: "disabled" });
    report.screenshots.push(filename);
    writeReport();
  };

  const tracker = createProcessTracker();
  let mockServer = null;
  let browser = null;
  let cdpSession = null;

  try {
    const packages = await resolvePluginPackages({
      weatherPkg: options.weatherPkg,
      reminderPkg: options.reminderPkg,
      packagesDir: options.packagesDir,
      examplesDir: options.examplesDir,
      repoRoot,
      tempWorkDir: workRoot,
    });

    mockServer = await startMockOpenAiServer();
    const seeded = seedIsolatedProfile({
      isolationRoot: launchSpec.isolationRoot,
      workRoot,
      mockBaseUrl: mockServer.baseUrl,
    });

    const childEnv = buildIsolatedEnv({ workRoot });
    const appProc = spawn(launchSpec.executablePath, launchSpec.args, {
      cwd: launchSpec.cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    tracker.recordRootPid(appProc.pid);
    report.launchedPid = appProc.pid;
    const processLog = fs.createWriteStream(path.join(outputDir, "process.log"), { flags: "a" });
    appProc.stdout?.pipe(processLog);
    appProc.stderr?.pipe(processLog);

    const { chromium } = require(path.join(repoRoot, "node_modules", "playwright"));
    browser = await waitFor(
      async () => chromium.connectOverCDP(`http://127.0.0.1:${launchSpec.cdpPort}`),
      { timeoutMs: 30000, intervalMs: 250, label: "CDP connection" },
    );
    cdpSession = await browser.newBrowserCDPSession();

    const chatPage = await waitFor(
      async () => {
        for (const context of browser.contexts()) {
          const hit = context.pages().find((page) => page.url().includes("/react/index.html"));
          if (hit) return hit;
        }
        return null;
      },
      { timeoutMs: 25000, intervalMs: 200, label: "React chat page" },
    );
    chatPage.setDefaultTimeout(20000);
    await chatPage.waitForFunction(
      () => typeof window.plugins?.list === "function" && typeof window.chatStore?.openInReactChatWindow === "function",
      null,
      { timeout: 20000 },
    );

    const baselineSys = await cdpSession.send("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] }));
    const baselineUtilityPids = new Set(
      (baselineSys.processInfo ?? [])
        .filter((item) => item.type === "node.mojom.NodeService")
        .map((item) => Number(item.id)),
    );
    await takeScreenshot(chatPage, "01-launched-isolated.png");
    recordStep("launch-and-isolation", {
      launchedPid: appProc.pid,
      baselineUtilityPids: [...baselineUtilityPids],
    });

    // Step 2: Import both #133 .ffplugin packages and enable them via CDP UI.
    await chatPage.locator('[data-rail-item="plugin"]').click();
    await chatPage.locator(".plugin-panel").waitFor();

    for (const [pluginId, pkgPath] of [
      ["dev.firefly.weather", packages.weatherPkg],
      ["dev.firefly.reminder", packages.reminderPkg],
    ]) {
      await chatPage.locator(".ff-panel-sidebar__new").click();
      await pickOpenFileDialogWin32(appProc.pid, pkgPath);
      await waitFor(
        async () => {
          const overview = await chatPage.evaluate(() => window.plugins.list());
          return overview.plugins.some((p) => p.id === pluginId);
        },
        { timeoutMs: 20000, label: `import ${pluginId}` },
      );
    }
    await takeScreenshot(chatPage, "02-imported-disabled.png");

    for (const [pluginId, displayName] of [
      ["dev.firefly.weather", "天气查询"],
      ["dev.firefly.reminder", "定时提醒"],
    ]) {
      const card = chatPage.locator("article.plugin-card-ui").filter({
        has: chatPage.locator(".plugin-card-ui__name", { hasText: displayName }),
      });
      await card.getByRole("button", { name: "启用", exact: true }).click();
      await chatPage.getByRole("dialog").getByRole("button", { name: /信任并启用|确认启用|启用/ }).click();
      await waitFor(
        async () => {
          const overview = await chatPage.evaluate(() => window.plugins.list());
          const entry = overview.plugins.find((p) => p.id === pluginId);
          return entry && (entry.status === "enabled" || entry.status === "running");
        },
        { timeoutMs: 20000, label: `enable ${pluginId}` },
      );
    }
    await takeScreenshot(chatPage, "03-plugins-enabled.png");
    const sysAfterEnable = await cdpSession.send("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] }));
    const initialPluginPids = tracker.findPluginUtilityProcessPids({
      cdpProcessInfo: sysAfterEnable.processInfo ?? [],
      excludePids: baselineUtilityPids,
    });
    if (initialPluginPids.length === 0) {
      throw new Error("Expected at least one plugin utilityProcess PID after enabling plugins");
    }
    recordStep("import-and-enable", {
      plugins: ["dev.firefly.weather", "dev.firefly.reminder"],
      utilityPids: initialPluginPids,
    });

    // Step 3: In Work session, invoke list_reminders and verify output.
    await chatPage.locator('[data-rail-item="home"]').click();
    await chatPage.evaluate((id) => window.chatStore.openInReactChatWindow(id), seeded.sessionId);
    await chatPage.waitForSelector(`[data-session-id="${seeded.sessionId}"]`);
    const composer = chatPage.locator("textarea.ant-sender-input");
    await composer.waitFor();
    await composer.fill("SMOKE_LIST_REMINDERS");
    await chatPage.locator(".ant-sender-actions-btn").click();

    await waitFor(
      async () => {
        if (mockServer.state.toolOutputs.length > 0) return true;
        // Approve once if permission mode prompts for tool approval.
        const allowBtn = chatPage.getByRole("button", { name: /允许一次|允许/ }).first();
        if (await allowBtn.isVisible().catch(() => false)) {
          await allowBtn.click().catch(() => {});
        }
        return false;
      },
      { timeoutMs: 25000, intervalMs: 200, label: "list_reminders tool output" },
    );
    await waitFor(
      async () => !(await chatPage.getByRole("button", { name: "停止运行", exact: true }).isVisible().catch(() => false)),
      { timeoutMs: 20000, label: "Work run completion" },
    );

    const rawToolOutput = mockServer.state.toolOutputs[0];
    report.toolOutputs = [...mockServer.state.toolOutputs];
    let parsedOutput;
    try {
      parsedOutput = JSON.parse(rawToolOutput);
    } catch {
      parsedOutput = rawToolOutput;
    }
    const outputText = typeof rawToolOutput === "string" ? rawToolOutput : JSON.stringify(rawToolOutput);
    if (!outputText.includes("total") || !outputText.includes("tasks")) {
      throw new Error(`Unexpected list_reminders output: ${outputText}`);
    }
    await takeScreenshot(chatPage, "04-work-list-reminders.png");
    recordStep("work-list-reminders", { output: parsedOutput });

    // Step 4: Trigger and cancel a call mid-flight.
    await composer.fill("SMOKE_CANCEL_MID_FLIGHT");
    await chatPage.locator(".ant-sender-actions-btn").click();
    const stopButton = chatPage.getByRole("button", { name: "停止运行", exact: true });
    await stopButton.waitFor({ state: "visible", timeout: 15000 });
    await waitFor(
      async () => (await chatPage.locator("body").innerText()).includes("正在处理可取消任务"),
      { timeout: 15000, label: "mid-flight streaming text" },
    );
    await takeScreenshot(chatPage, "05-mid-flight-running.png");
    await stopButton.click();
    await stopButton.waitFor({ state: "detached", timeout: 15000 });
    await waitFor(() => mockServer.state.cancelledObserved, { timeoutMs: 10000, label: "server abort observation" });
    report.cancelledObserved = true;
    await takeScreenshot(chatPage, "06-call-cancelled.png");
    recordStep("cancel-mid-flight", { cancelledObserved: true });

    // Step 5: Kill ONLY plugin child utilityProcess PID(s) to trigger disabled-fault ("已停用（异常）"), then recover.
    await chatPage.locator('[data-rail-item="plugin"]').click();
    await chatPage.locator(".plugin-panel").waitFor();

    const reminderCard = chatPage.locator("article.plugin-card-ui").filter({
      has: chatPage.locator(".plugin-card-ui__name", { hasText: "定时提醒" }),
    });
    const killedPids = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const overview = await chatPage.evaluate(() => window.plugins.list());
      const reminderState = overview.plugins.find((p) => p.id === "dev.firefly.reminder");
      if (reminderState?.status === "disabled-fault") break;

      const sysInfo = await cdpSession.send("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] }));
      const livePluginPids = tracker.findPluginUtilityProcessPids({
        cdpProcessInfo: sysInfo.processInfo ?? [],
        excludePids: baselineUtilityPids,
      });
      if (livePluginPids.length > 0) {
        const justKilled = tracker.killPluginUtilityPids(livePluginPids);
        killedPids.push(...justKilled);
        await new Promise((r) => setTimeout(r, 900));
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    await waitFor(
      async () => {
        const overview = await chatPage.evaluate(() => window.plugins.list());
        return overview.plugins.some((p) => p.status === "disabled-fault");
      },
      { timeoutMs: 25000, intervalMs: 250, label: "disabled-fault status" },
    );
    await reminderCard.locator(".plugin-card-ui__status.is-disabled-fault", { hasText: "已停用（异常）" }).waitFor();
    report.killedPluginUtilityPids = [...new Set(killedPids)];
    await takeScreenshot(chatPage, "07-plugin-disabled-fault.png");
    recordStep("kill-plugin-fault", { killedPluginUtilityPids: report.killedPluginUtilityPids });

    // Recover / re-enable any faulted plugins.
    for (const [pluginId, displayName] of [
      ["dev.firefly.weather", "天气查询"],
      ["dev.firefly.reminder", "定时提醒"],
    ]) {
      const overview = await chatPage.evaluate(() => window.plugins.list());
      const entry = overview.plugins.find((p) => p.id === pluginId);
      if (entry && entry.status !== "enabled" && entry.status !== "running") {
        const card = chatPage.locator("article.plugin-card-ui").filter({
          has: chatPage.locator(".plugin-card-ui__name", { hasText: displayName }),
        });
        await card.getByRole("button", { name: /^(重试|启用)$/ }).click();
        await chatPage.getByRole("dialog").getByRole("button", { name: /信任并启用|确认启用|启用/ }).click();
        await waitFor(
          async () => {
            const next = (await chatPage.evaluate(() => window.plugins.list())).plugins.find((p) => p.id === pluginId);
            return next && (next.status === "enabled" || next.status === "running");
          },
          { timeoutMs: 20000, label: `recover ${pluginId}` },
        );
      }
    }
    await takeScreenshot(chatPage, "08-plugin-recovered.png");
    recordStep("recover-plugins", { recovered: true });

    // Step 6: Uninstall both plugins.
    for (const [pluginId, displayName] of [
      ["dev.firefly.weather", "天气查询"],
      ["dev.firefly.reminder", "定时提醒"],
    ]) {
      const card = chatPage.locator("article.plugin-card-ui").filter({
        has: chatPage.locator(".plugin-card-ui__name", { hasText: displayName }),
      });
      await card.getByRole("button", { name: "卸载", exact: true }).click();
      await chatPage.getByRole("dialog").getByRole("button", { name: "卸载", exact: true }).click();
      await card.waitFor({ state: "detached", timeout: 15000 });
      await waitFor(
        async () => !(await chatPage.evaluate(() => window.plugins.list())).plugins.some((p) => p.id === pluginId),
        { timeoutMs: 15000, label: `uninstall ${pluginId}` },
      );
    }
    await takeScreenshot(chatPage, "09-plugins-uninstalled.png");
    recordStep("uninstall-plugins", { uninstalled: ["dev.firefly.weather", "dev.firefly.reminder"] });

    report.ok = true;
    report.finishedAt = new Date().toISOString();
    writeReport();
    return report;
  } catch (error) {
    report.errors.push({ message: error instanceof Error ? error.message : String(error), stack: error?.stack });
    writeReport();
    throw error;
  } finally {
    if (cdpSession) await cdpSession.detach().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    tracker.cleanup();
    if (mockServer) await mockServer.close().catch(() => {});
    if (!options.keepIsolation) {
      // Remove isolated temp directory unless requested, keeping external --output-dir intact.
      const outputInsideWork = withinPath(workRoot, outputDir);
      if (!outputInsideWork) {
        try {
          fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
        } catch {
          // Windows may briefly hold handles on killed child dirs; ignore post-cleanup EPERM.
        }
      }
    }
  }
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/verify/packaged-plugin-smoke.mjs [<win-unpacked-dir> | --dry-run] " +
        "[--isolation-root <tempDir>] [--cdp-port <port>] [--packages-dir <dir>] " +
        "[--weather-pkg <file>] [--reminder-pkg <file>] [--examples-dir <dir>] [--output-dir <dir>] [--keep-isolation]",
    );
    return;
  }
  const report = await runPackagedPluginSmoke(args);
  console.log(
    `PACKAGED_PLUGIN_SMOKE_OK mode=${report.mode} steps=${report.steps.length} screenshots=${report.screenshots.length} report=${path.join(report.outputDir, "smoke-report.json")}`,
  );
}

const isEntryPoint =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`[packaged-plugin-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
