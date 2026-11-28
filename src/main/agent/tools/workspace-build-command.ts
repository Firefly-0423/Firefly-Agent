import * as fs from "fs";
import * as path from "path";
import { detect, resolveCommand, type Agent } from "package-manager-detector";

export type WorkspaceBuildCommandResult =
  | { ok: true; command: string; args: string[]; agent: Agent }
  | {
    error: string;
    errorCode: "PACKAGE_JSON_NOT_FOUND" | "PACKAGE_JSON_INVALID" | "PACKAGE_SCRIPT_NOT_FOUND" | "PACKAGE_MANAGER_UNSUPPORTED";
    ok: false;
  };

export async function resolveWorkspaceBuildCommand(cwd: string): Promise<WorkspaceBuildCommandResult> {
  const manifestPath = path.join(cwd, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errorCode: "PACKAGE_JSON_NOT_FOUND", error: `工作区未找到 package.json: ${manifestPath}` };
  }
  let manifest: { scripts?: Record<string, unknown> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, errorCode: "PACKAGE_JSON_INVALID", error: `工作区 package.json 无法解析: ${manifestPath}` };
  }
  if (typeof manifest.scripts?.build !== "string" || !manifest.scripts.build.trim()) {
    return { ok: false, errorCode: "PACKAGE_SCRIPT_NOT_FOUND", error: `工作区 package.json 未定义 scripts.build: ${manifestPath}` };
  }
  const detection = await detect({ cwd, stopDir: cwd });
  const manager: Agent = detection?.agent ?? "npm";
  const invocation = resolveCommand(manager, "run", ["build"]);
  if (!invocation) {
    return { ok: false, errorCode: "PACKAGE_MANAGER_UNSUPPORTED", error: `检测到的包管理器不支持运行 build 脚本: ${manager}` };
  }
  return { ok: true, command: invocation.command, args: invocation.args, agent: manager };
}
