// 应用定位方案参考 deepseek-harness 的 catalog/resolver。
// 来源许可：MIT License, Copyright (c) 2026 DeepSeek。
import { app, shell } from "electron";
import { join } from "node:path";
import { homedir, platform as osPlatform } from "node:os";
import { access, constants as fsConstants, realpath, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import * as chatsStore from "./chats-store";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { OpenInAppEntry } from "../../shared/open-in-app-types";
import { IPC } from "../../shared/ipc-channels";

export type CommandRunner = (
  command: string, args: readonly string[], signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

type Environment = Readonly<Record<string, string | undefined>>;
export type DetectorInternals = {
  home?: string;
  platform?: NodeJS.Platform;
  probeTimeoutMs?: number;
  env?: Environment;
  resolveExecutable?: (name: string) => Promise<string | null>;
  run?: CommandRunner;
};
export type ResolvedInternals = {
  home: string;
  platform: NodeJS.Platform;
  probeTimeoutMs: number;
  env: Environment;
  resolveExecutable: (name: string) => Promise<string | null>;
  run: CommandRunner;
};
type Installation = {
  readonly displayName: string;
  readonly displayIcon?: string | undefined;
  readonly installLocation?: string | undefined;
};
export type WindowsRegistryView = {
  readonly installRecords: readonly Installation[];
  readonly appPaths: ReadonlyMap<string, string>;
};
export type ResolvedLaunch = { readonly args: readonly string[]; readonly command: string };
type AppLaunch = ResolvedLaunch & { id: string; name: string };

export const runCommand: CommandRunner = (executable, argv, abort) => new Promise((accept, fail) => {
  execFile(executable, [...argv], { encoding: "utf8", signal: abort, windowsHide: true }, (issue, out, err) => {
    if (issue !== null) {
      const wrapped = new Error(issue.message, { cause: issue });
      fail(Object.assign(wrapped, { code: issue.code, stdout: out, stderr: err }));
    } else {
      accept({ stdout: out, stderr: err });
    }
  });
});

async function pathExecutable(commandName: string, host: ResolvedInternals): Promise<string | null> {
  const searchPath = host.env.PATH ?? "";
  const suffixes = host.platform === "win32"
    ? (host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => suffix !== "") : [""];
  for (const folder of searchPath.split(host.platform === "win32" ? ";" : ":")) {
    if (folder === "") continue;
    for (const suffix of suffixes) {
      const filename = join(folder,
        commandName.endsWith(suffix) || suffix === "" ? commandName : commandName + suffix.toLowerCase());
      try {
        if ((await stat(filename)).isFile()) {
          if (host.platform !== "win32") await access(filename, fsConstants.X_OK);
          return filename;
        }
      } catch { /* 候选不可用时继续。 */ }
    }
  }
  return null;
}

export function resolveInternals(internals: DetectorInternals): ResolvedInternals {
  const userHome = internals.home ?? homedir();
  const host: ResolvedInternals = {
    platform: internals.platform ?? osPlatform(),
    env: internals.env ?? process.env,
    home: userHome,
    run: internals.run ?? runCommand,
    resolveExecutable: internals.resolveExecutable ?? ((commandName) => pathExecutable(commandName, host)),
    probeTimeoutMs: internals.probeTimeoutMs ?? 5000,
  };
  return host;
}

function substitute(text: string, pattern: RegExp, host: ResolvedInternals): string | null {
  let complete = true;
  const rendered = text.replace(pattern, (original, variable: string) => {
    const replacement = host.env[variable];
    if (replacement === undefined) complete = false;
    return replacement ?? original;
  });
  return complete ? rendered : null;
}

export function expandCandidate(template: string, internals: ResolvedInternals): string | null {
  const rendered = substitute(template, /\$\{([^}]+)\}/g, internals);
  if (rendered === null) return null;
  return rendered.startsWith("~/") ? join(internals.home, rendered.slice(2)) : rendered;
}

async function existsAs(filename: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await stat(filename);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch { return false; }
}

export function parseRegistryDump(dump: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let active: Map<string, string> | undefined;
  for (const row of dump.split(/\r?\n/)) {
    if (/^HK/.test(row)) {
      active = new Map<string, string>();
      sections.set(row.trim(), active);
    } else {
      const parts = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(row);
      if (parts === null || active === undefined) continue;
      const label = parts[1]!;
      active.set(/^\(.*\)$/.test(label) ? "(Default)" : label, parts[3]!.trim());
    }
  }
  return sections;
}

const applicationKeys = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];
const installationKeys = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
const unquote = (value: string): string => value.replace(/^"|"$/g, "");
const registryPath = (value: string, host: ResolvedInternals): string | null => substitute(value, /%([^%]+)%/g, host);

async function queryRegistry(key: string, host: ResolvedInternals): Promise<string | null> {
  try {
    const answer = await host.run("reg.exe", ["query", key, "/s"], AbortSignal.timeout(host.probeTimeoutMs));
    return answer.stdout;
  } catch { return null; }
}

async function collectRegistry(host: ResolvedInternals): Promise<WindowsRegistryView> {
  const executables = new Map<string, string>();
  const installations: Installation[] = [];
  for (const key of applicationKeys) {
    const output = await queryRegistry(key, host);
    if (output === null) continue;
    for (const [subkey, fields] of parseRegistryDump(output)) {
      const basename = subkey.slice(subkey.lastIndexOf("\\") + 1).toLowerCase();
      const registeredPath = fields.get("(Default)");
      if (!basename.endsWith(".exe") || registeredPath === undefined || executables.has(basename)) continue;
      const filename = registryPath(unquote(registeredPath), host);
      if (filename !== null) executables.set(basename, filename);
    }
  }
  for (const key of installationKeys) {
    const output = await queryRegistry(key, host);
    if (output === null) continue;
    for (const fields of parseRegistryDump(output).values()) {
      const title = fields.get("DisplayName");
      if (title === undefined) continue;
      installations.push({ displayName: title, installLocation: fields.get("InstallLocation"), displayIcon: fields.get("DisplayIcon") });
    }
  }
  return { appPaths: executables, installRecords: installations };
}

type Probe =
  | { via: "executable"; value: string }
  | { via: "paths"; values: readonly string[] }
  | { via: "registry"; value: string }
  | { via: "installation"; prefix: string; launcher?: string }
  | { via: "bundle"; names: readonly string[] };
type AppSpec = { id: string; name: string; win32: readonly Probe[]; darwin: readonly Probe[]; linux: readonly Probe[] };
const applications: readonly AppSpec[] = [
  {
    id: "vscode", name: "VSCode",
    win32: [
      { via: "registry", value: "Code.exe" },
      { via: "installation", prefix: "Microsoft Visual Studio Code", launcher: "Code.exe" },
      { via: "paths", values: ["${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe", "${ProgramFiles}/Microsoft VS Code/Code.exe"] },
    ],
    darwin: [{ via: "bundle", names: ["Visual Studio Code.app"] }],
    linux: [{ via: "executable", value: "code" }],
  },
  {
    id: "vscode-insiders", name: "VSCode Insiders",
    win32: [
      { via: "registry", value: "Code - Insiders.exe" },
      { via: "installation", prefix: "Microsoft Visual Studio Code Insiders", launcher: "Code - Insiders.exe" },
      { via: "paths", values: ["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"] },
    ],
    darwin: [{ via: "bundle", names: ["Visual Studio Code - Insiders.app"] }],
    linux: [{ via: "executable", value: "code-insiders" }],
  },
  {
    id: "cursor", name: "Cursor",
    win32: [
      { via: "registry", value: "Cursor.exe" },
      { via: "installation", prefix: "Cursor" },
      { via: "paths", values: ["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"] },
    ],
    darwin: [{ via: "bundle", names: ["Cursor.app"] }],
    linux: [{ via: "executable", value: "cursor" }],
  },
];

async function fromInstallation(row: Installation, launcher: string | undefined, host: ResolvedInternals): Promise<string | null> {
  if (launcher !== undefined && row.installLocation !== undefined && row.installLocation !== "") {
    const directory = registryPath(unquote(row.installLocation), host);
    if (directory !== null) {
      const filename = join(directory, launcher);
      if (await existsAs(filename, "file")) return filename;
    }
  }
  if (row.displayIcon !== undefined) {
    const icon = unquote(row.displayIcon.replace(/,-?\d+$/, "")).trim();
    const filename = registryPath(icon, host);
    if (filename !== null && filename.toLowerCase().endsWith(".exe") && await existsAs(filename, "file")) return filename;
  }
  return null;
}

type ReadRegistry = () => Promise<WindowsRegistryView>;
async function probeLaunch(probe: Probe, readRegistry: ReadRegistry, host: ResolvedInternals): Promise<ResolvedLaunch | null> {
  if (probe.via === "executable") {
    const filename = await host.resolveExecutable(probe.value);
    return filename === null ? null : { command: filename, args: [] };
  }
  if (probe.via === "paths") {
    for (const template of probe.values) {
      const filename = expandCandidate(template, host);
      if (filename !== null && await existsAs(filename, "file")) return { command: filename, args: [] };
    }
    return null;
  }
  if (probe.via === "registry") {
    const filename = (await readRegistry()).appPaths.get(probe.value.toLowerCase());
    if (filename === undefined || !(await existsAs(filename, "file"))) return null;
    return { command: filename, args: [] };
  }
  if (probe.via === "installation") {
    for (const row of (await readRegistry()).installRecords) {
      if (!row.displayName.startsWith(probe.prefix)) continue;
      const filename = await fromInstallation(row, probe.launcher, host);
      if (filename !== null) return { command: filename, args: [] };
    }
    return null;
  }
  for (const template of ["/Applications", "~/Applications"]) {
    const directory = expandCandidate(template, host);
    if (directory === null) continue;
    for (const name of probe.names) {
      const bundlePath = join(directory, name);
      if (await existsAs(bundlePath, "directory")) return { command: "open", args: ["-a", bundlePath] };
    }
  }
  return null;
}

async function locateApplication(spec: AppSpec, readRegistry: ReadRegistry, host: ResolvedInternals): Promise<ResolvedLaunch | null> {
  const os = host.platform;
  const probes = os === "win32" || os === "darwin" || os === "linux" ? spec[os] : undefined;
  if (probes === undefined) return null;
  for (const probe of probes) {
    const launch = await probeLaunch(probe, readRegistry, host);
    if (launch !== null) return launch;
  }
  return null;
}

export async function resolveOpenInApps(internals: DetectorInternals = {}): Promise<Map<string, ResolvedLaunch & { id: string; name: string }>> {
  const host = resolveInternals(internals);
  let registryJob: Promise<WindowsRegistryView> | null = null;
  const readRegistry: ReadRegistry = () => (registryJob ??= collectRegistry(host));
  const located = await Promise.all(applications.map(async (spec): Promise<AppLaunch | null> => {
    const launch = await locateApplication(spec, readRegistry, host);
    return launch === null ? null : { id: spec.id, name: spec.name, ...launch };
  }));
  const found = new Map<string, AppLaunch>();
  for (const launch of located) if (launch !== null) found.set(launch.id, launch);
  return found;
}

let detection: Promise<Map<string, AppLaunch>> | null = null;
let lastOpened: string | null = null;
const icons = new Map<string, string | undefined>();
const detectedApps = (): Promise<Map<string, AppLaunch>> => (detection ??= resolveOpenInApps().catch(() => new Map()));

async function extractLauncherIcon(executable: string): Promise<string | undefined> {
  try {
    const extracted = await app.getFileIcon(executable, { size: "small" });
    return extracted.isEmpty() ? undefined : extracted.toDataURL();
  } catch { return undefined; }
}

async function systemExplorerIcon(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  return launcherIcon(join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"));
}

async function launcherIcon(executable: string): Promise<string | undefined> {
  if (!executable.toLowerCase().endsWith(".exe")) return undefined;
  if (!icons.has(executable)) {
    icons.set(executable, await extractLauncherIcon(executable));
  }
  return icons.get(executable);
}

export function launchDetachedApp(command: string, args: readonly string[], watchMs = 1500): Promise<void> {
  return new Promise((accept, fail) => {
    const processHandle = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
    let finished = false;
    const complete = (next: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      processHandle.unref();
      next();
    };
    const deadline = setTimeout(() => complete(accept), watchMs);
    processHandle.on("error", (issue) => complete(() => fail(issue)));
    processHandle.on("exit", (status) => {
      if (status === 0) complete(accept);
      else complete(() => fail(new Error(`launcher exited with code ${String(status)}`)));
    });
  });
}

async function workspaceFor(id: string): Promise<{ root: string } | { code: string }> {
  const binding = chatsStore.getWorkspaceBinding(id);
  if (!binding) return { code: "NO_WORKSPACE" };
  try {
    const canonical = await realpath(binding.workspaceRoot);
    return { root: canonical };
  } catch { return { code: "WORKSPACE_MISSING" }; }
}

export function registerOpenInAppIpc(ipcOption?: IpcScope): void {
  const scope = ipcOption ?? createIpcScope();
  scope.handle(IPC.WORKSPACE_OPEN_IN_LIST_APPS, async (_event, payload: { sessionId?: string }) => {
    if (!payload?.sessionId) return { ok: false as const, code: "NO_WORKSPACE" as const };
    const workspace = await workspaceFor(payload.sessionId);
    if ("code" in workspace) return { ok: false as const, code: workspace.code as "NO_WORKSPACE" };
    const found = await detectedApps();
    const explorer = await systemExplorerIcon();
    const menu: OpenInAppEntry[] = [{ id: "explorer", name: "资源管理器", icon: explorer }];
    for (const launch of found.values()) {
      menu.push({ id: launch.id, name: launch.name, icon: await launcherIcon(launch.command) });
    }
    return { ok: true as const, apps: menu, preferred: lastOpened ?? "explorer" };
  });
  scope.handle(IPC.WORKSPACE_OPEN_IN, async (_event, payload: { sessionId?: string; appId?: string }) => {
    if (!payload?.sessionId || !payload?.appId) return { ok: false as const, code: "WORKSPACE_MISSING" as const };
    const workspace = await workspaceFor(payload.sessionId);
    if ("code" in workspace) return { ok: false as const, code: workspace.code as "NO_WORKSPACE" };
    if (payload.appId === "explorer") {
      const failure = await shell.openPath(workspace.root);
      if (failure) return { ok: false as const, code: "LAUNCH_FAILED" as const, error: failure };
      lastOpened = "explorer";
      return { ok: true as const };
    }
    const found = await detectedApps();
    const launch = found.get(payload.appId);
    if (!launch) return { ok: false as const, code: "APP_NOT_FOUND" as const };
    try {
      await launchDetachedApp(launch.command, [...launch.args, workspace.root]);
      lastOpened = payload.appId;
      return { ok: true as const };
    } catch (failure) {
      detection = null;
      return { ok: false as const, code: "LAUNCH_FAILED" as const, error: failure instanceof Error ? failure.message : String(failure) };
    }
  });
}
