import * as fs from "fs";
import * as path from "path";
import { logger, LogTag } from "../../logging/logger";
import { getCurrentLevel } from "../../permission/permission";
import type { AgentFileAccessLevel } from "../../permission/permission-policy";
import { fireflyEnvironment } from "../../../shared/firefly-environment";

type SrtModule = any;
let runtime: SrtModule | null = null;
let windowsRuntime: any = null;
let executablePath: string | null = null;
let ready = false;
let disabled = false;
let initialized = false;
let activeSession: string | null = null;
let failureCount = 0;
let failedSession: string | null = null;
const failureLimit = 3;

function isWindows(): boolean { return process.platform === "win32"; }
function isSrtDisabledByEnv(): boolean {
  const flag = fireflyEnvironment(process.env, "FIREFLY_SRT");
  return flag === "0" || flag === "false";
}
function toUnpackedSrtWinPath(p: string): string {
  const segment = `${path.sep}app.asar${path.sep}`;
  if (!p.includes(segment)) return p;
  return p.replace(segment, `${path.sep}app.asar.unpacked${path.sep}`);
}
function detectProjectRoot(cwd: string): string {
  const origin = path.resolve(cwd);
  let directory = origin;
  for (let depth = 0; depth < 20; depth += 1) {
    const git = fs.existsSync(path.join(directory, ".git"));
    const manifest = fs.existsSync(path.join(directory, "package.json"));
    const typescript = fs.existsSync(path.join(directory, "tsconfig.json"));
    if (git || manifest || typescript) {
      const markers = [git && ".git", manifest && "package.json", typescript && "tsconfig.json"].filter(Boolean).join(",");
      logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: ${origin} → ${directory} (found ${markers})`);
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: no project marker found from ${origin}, fallback to cwd`);
  return path.resolve(cwd);
}
function buildFilesystemConfigForLevel(cwd: string, level: AgentFileAccessLevel): { filesystem: any } | null {
  logger.info(LogTag.Runtime, `[Sandbox] buildFilesystemConfigForLevel: level=${level} cwd=${cwd}`);
  switch (level) {
    case "project-read-only": case "read-only": case "scoped":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [${level}]: per-exec denies only; grants were applied at session initialization`);
      return { filesystem: { denyRead: [], denyWrite: [] } };
    case "per-action":
      logger.info(LogTag.Runtime, "[Sandbox] fs config [per-action]: filesystem.disabled=true (user approved, fs unrestricted)");
      return { filesystem: { disabled: true } };
    case "full":
      logger.info(LogTag.Runtime, "[Sandbox] fs config [full]: null (no sandbox, direct spawn)");
      return null;
  }
}
export function resolveSandboxSessionFilesystem(level: AgentFileAccessLevel, workspaceRoot: string): { allowRead?: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[]; disabled?: boolean } {
  switch (level) {
    case "project-read-only": return { allowRead: [workspaceRoot], allowWrite: [], denyRead: [], denyWrite: [] };
    case "read-only": return { allowWrite: [], denyRead: [], denyWrite: [] };
    case "scoped": case "per-action": return { allowWrite: [workspaceRoot], denyRead: [], denyWrite: [] };
    case "full": return { allowWrite: [], denyRead: [], denyWrite: [], disabled: true };
  }
}
function buildSandboxConfig(level: AgentFileAccessLevel, workspaceRoot: string): SrtModule["SandboxRuntimeConfig"] {
  try { fs.mkdirSync(workspaceRoot, { recursive: true }); }
  catch (failure) { logger.warn(LogTag.Runtime, `[Sandbox] mkdir workspace root failed: ${workspaceRoot}`, failure); }
  return { network: { allowedDomains: [], deniedDomains: [] }, filesystem: resolveSandboxSessionFilesystem(level, workspaceRoot),
    windows: { srtWin: { path: executablePath ?? runtime.VENDORED_SRT_WIN_EXE } } };
}
async function initSandboxManager(level: AgentFileAccessLevel, workspaceRoot: string): Promise<void> {
  if (!runtime) throw new Error("SRT module not loaded");
  const configuration = buildSandboxConfig(level, workspaceRoot);
  logger.info(LogTag.Runtime, `[Sandbox] initSandboxManager: workspaceRoot=${workspaceRoot} allowWrite=${configuration.filesystem.allowWrite.join(",")} srtWin=${configuration.windows.srtWin.path}`);
  await runtime.SandboxManager.initialize(configuration);
  activeSession = JSON.stringify({ level, workspaceRoot });
  logger.info(LogTag.Runtime, "[Sandbox] SandboxManager.initialize completed");
}

export async function initSandbox(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (!isWindows()) { logger.info(LogTag.Runtime, "[Sandbox] non-Windows platform, skipping"); return; }
  if (isSrtDisabledByEnv()) { logger.info(LogTag.Runtime, "[Sandbox] disabled by FIREFLY_SRT env"); disabled = true; return; }
  try {
    runtime = await import("@anthropic-ai/sandbox-runtime");
    executablePath = toUnpackedSrtWinPath(runtime.VENDORED_SRT_WIN_EXE as string);
    windowsRuntime = runtime.resolveSrtWin({ path: executablePath });
    const status = await runtime.checkWindowsSandboxStatusAsync({ srtWin: windowsRuntime });
    logger.info(LogTag.Runtime, `[Sandbox] status: user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);
    if (!status.user.provisioned) { logger.info(LogTag.Runtime, "[Sandbox] not provisioned, will lazy-install on first workspace_mutation command"); return; }
    logger.info(LogTag.Runtime, "[Sandbox] provisioned; will initialize ACL for the active workspace on first sandboxed command");
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    logger.error(LogTag.Runtime, `[Sandbox] init failed, staying not-ready: ${detail}`);
  }
}
export function isSandboxReady(): boolean { return !!runtime && !disabled; }

export async function ensureSandboxReady(cwd: string = process.cwd(), level: AgentFileAccessLevel = getCurrentLevel(), trustedWorkspaceRoot?: string): Promise<boolean> {
  if (disabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: skip (sandboxDisabled=${disabled} isWindows=${isWindows()})`);
    return false;
  }
  const root = trustedWorkspaceRoot ? path.resolve(trustedWorkspaceRoot)
    : level === "project-read-only" ? detectProjectRoot(cwd) : path.resolve(cwd);
  const identity = JSON.stringify({ level, workspaceRoot: root });
  if (ready && activeSession === identity) { logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: already ready"); return true; }
  if (!runtime || !windowsRuntime) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: srtModule=${!!runtime} srtWin=${!!windowsRuntime}, cannot proceed`);
    return false;
  }
  if (failedSession !== null && failedSession !== identity) {
    failureCount = 0;
    failedSession = null;
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: session key changed, retry budget restored");
  }
  if (failureCount >= failureLimit) {
    logger.warn(LogTag.Runtime, `[Sandbox] ensureSandboxReady: ${failureCount} consecutive failures, stop retrying in this process (fail-closed)`);
    return false;
  }
  try {
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: checking status...");
    const status = await runtime.checkWindowsSandboxStatusAsync({ srtWin: windowsRuntime });
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: status user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);
    if (!status.user.provisioned) {
      logger.info(LogTag.Runtime, "[Sandbox] not provisioned, attempting install (UAC may prompt)");
      const installation = await runtime.installWindowsSandboxAsync({ srtWin: windowsRuntime });
      if (installation.cancelled) { logger.warn(LogTag.Runtime, "[Sandbox] install cancelled (UAC dismissed)"); return false; }
      logger.info(LogTag.Runtime, `[Sandbox] install completed: user.provisioned=${installation.user?.provisioned} wfp.state=${installation.wfp?.state}`);
    }
    if (ready) { await runtime.SandboxManager.reset(); ready = false; activeSession = null; }
    await initSandboxManager(level, root);
    ready = true;
    failureCount = 0;
    failedSession = null;
    logger.info(LogTag.Runtime, "[Sandbox] ready (lazy init)");
    return true;
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    failureCount += 1;
    failedSession = identity;
    logger.error(LogTag.Runtime, `[Sandbox] lazy init failed (${failureCount}/${failureLimit}), staying not-ready: ${detail}`);
    return false;
  }
}
export type SandboxWrapOutcome = { ok: true; argv: string[]; env: NodeJS.ProcessEnv }
  | { ok: false; reason: "disabled" | "not_ready" | "wrap_failed"; detail?: string };

export async function wrapWithSandbox(command: string, cwd?: string, binShell?: string, level: AgentFileAccessLevel = getCurrentLevel(), trustedWorkspaceRoot?: string): Promise<SandboxWrapOutcome> {
  logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: command="${command}" cwd=${cwd || "(undefined)"} level=${level}`);
  if (disabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: skip (sandboxDisabled=${disabled} isWindows=${isWindows()})`);
    return { ok: false, reason: "disabled", detail: `sandboxDisabled=${disabled} isWindows=${isWindows()}` };
  }
  if (level === "full") {
    logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: full level, skipping sandbox (direct spawn)");
    return { ok: false, reason: "disabled", detail: "full level" };
  }
  const directory = cwd || process.cwd();
  const available = await ensureSandboxReady(directory, level, trustedWorkspaceRoot);
  if (!available || !runtime) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: sandbox not ready (ready=${available} srtModule=${!!runtime}), returning not_ready`);
    return { ok: false, reason: "not_ready", detail: `ready=${available} srtModule=${!!runtime}` };
  }
  try {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: command="${command}" resolvedCwd=${directory}`);
    try { fs.mkdirSync(directory, { recursive: true }); }
    catch (failure) { logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: mkdir cwd failed: ${directory}`, failure); }
    const restrictions = buildFilesystemConfigForLevel(directory, level);
    if (!restrictions) {
      logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: customConfig is null (full level fallback), returning not_ready");
      return { ok: false, reason: "not_ready", detail: "customConfig is null" };
    }
    logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: calling wrapWithSandboxArgv...");
    const wrapped = await runtime.SandboxManager.wrapWithSandboxArgv(command, binShell, restrictions, undefined, directory, undefined);
    if (!wrapped || !Array.isArray(wrapped.argv) || wrapped.argv.length === 0) {
      logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap returned empty argv for: ${command} (wrapped=${JSON.stringify(wrapped)})`);
      return { ok: false, reason: "wrap_failed", detail: "empty argv" };
    }
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: success, argv.length=${wrapped.argv.length} argv[0]=${wrapped.argv[0]}`);
    return { ok: true, argv: wrapped.argv, env: wrapped.env };
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    logger.error(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap failed: ${detail}`);
    return { ok: false, reason: "wrap_failed", detail };
  }
}
export async function resetSandbox(): Promise<void> {
  if (!runtime || !ready) return;
  try { await runtime.SandboxManager.reset(); } catch { /* 关闭时保留原有容错。 */ }
}
