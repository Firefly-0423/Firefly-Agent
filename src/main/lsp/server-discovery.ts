import fs from "node:fs";
import path from "node:path";
import type { LspServerDefinition } from "./types";

export interface ResolvedLspServer {
  definition: LspServerDefinition;
  executablePath: string;
  args: string[];
}

export interface LspDiscoveryOptions {
  PATH?: string;
  PATHEXT?: string;
  platform?: NodeJS.Platform;
}

const FALLBACK_WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Windows 下对没有扩展名的命令逐个尝试 PATHEXT 中的后缀；其他平台只检查原名。
function namesToTry(command: string, platform: NodeJS.Platform, pathExt: string | undefined): string[] {
  if (platform !== "win32" || path.extname(command) !== "") return [command];
  const suffixes = (pathExt || FALLBACK_WINDOWS_EXTENSIONS)
    .split(";")
    .map((suffix) => suffix.trim())
    .filter((suffix) => suffix.length > 0);
  return suffixes.map((suffix) => command + suffix.toLowerCase());
}

function searchDirectory(
  command: string,
  directory: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): string | null {
  for (const name of namesToTry(command, platform, pathExt)) {
    const hit = path.join(directory, name);
    if (isFile(hit)) return hit;
  }
  return null;
}

interface SearchPlan {
  platform: NodeJS.Platform;
  pathExt: string | undefined;
  workspaceBin: string;
  pathDirectories: readonly string[];
}

// 查找顺序：绝对路径 -> 工作区 node_modules/.bin -> 系统 PATH 各目录。
function locate(command: string, plan: SearchPlan): string | null {
  if (path.isAbsolute(command)) return isFile(command) ? command : null;
  for (const directory of [plan.workspaceBin, ...plan.pathDirectories]) {
    const hit = searchDirectory(command, directory, plan.platform, plan.pathExt);
    if (hit) return hit;
  }
  return null;
}

/**
 * 按显式绝对路径、工作区 node_modules/.bin、系统 PATH 的固定顺序发现用户已安装的服务。
 * 不会执行任何命令，也不会拼接 shell 字符串。
 */
export function resolveLspServer(
  definition: LspServerDefinition,
  workspaceRoot: string,
  options: LspDiscoveryOptions = {},
): ResolvedLspServer | null {
  const rawPath = options.PATH ?? process.env.PATH ?? "";
  const plan: SearchPlan = {
    platform: options.platform ?? process.platform,
    pathExt: options.PATHEXT ?? process.env.PATHEXT,
    workspaceBin: path.join(workspaceRoot, "node_modules", ".bin"),
    pathDirectories: rawPath.split(path.delimiter).filter((entry) => entry.length > 0),
  };

  for (const spec of definition.commands) {
    const executablePath = locate(spec.command, plan);
    if (executablePath) return { definition, executablePath, args: [...spec.args] };
  }
  return null;
}
