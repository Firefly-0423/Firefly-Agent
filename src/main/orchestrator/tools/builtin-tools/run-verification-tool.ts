import type { ToolDefinition } from "../registry/tool-registry";
import { resolveBuiltinExecutable, VerificationRunner } from "../../verification-runner";
import { resolveWorkspaceBuildCommand } from "../../workspace-build-command";

const LOG_PREFIX = "[BuiltinTools]";
type WorkVerificationCommand = {
  cmd: string; args: string[]; trust: "builtin" | "workspace_script";
  source: "tsconfig" | "vitest" | "package_script"; configPath?: string;
};
/** Cargo runs the project's build scripts, so it is a workspace script and follows the shell permission. */
const CARGO_ARGS: Record<string, string[]> = {
  typecheck: ["check"], test: ["test"], build: ["build"], lint: ["clippy", "--all-targets", "--", "-D", "warnings"],
};
function verificationFailure(kind: string, code: string, detail: string, stderr: string, directory?: { actualCwd: string | undefined }): string {
  return JSON.stringify({
    success: false, errorCode: code, error: detail, verificationType: kind,
    command: "", exitCode: -1, stdout: "", stderr,
    timedOut: false, passed: false, truncated: false, durationMs: 0, retryable: false, ...directory,
  });
}

async function executeVerification(input: Record<string, unknown>): Promise<string> {
  const kind = String(input.verificationType || "").trim();
  const directory = input.cwd ? String(input.cwd) : undefined;
  if (!kind) return verificationFailure("", "INVALID_INPUT", "verificationType 不能为空", "[错误] verificationType 不能为空");
  const filesystem = require("fs");
  const paths = require("path");
  let commands: Record<string, WorkVerificationCommand>;
  const workingDirectory = directory || process.cwd();
  const has = (name: string) => filesystem.existsSync(paths.join(workingDirectory, name));
  const javascript = has("package.json") || has("tsconfig.json") || has("tsconfig.main.json");
  if (!javascript && !has("Cargo.toml")) return verificationFailure(kind, "VERIFICATION_PROJECT_UNSUPPORTED",
    `run_verification 只支持 JavaScript/TypeScript（package.json 或 tsconfig）和 Rust（Cargo.toml）项目: ${workingDirectory}。请用 run_shell 运行该项目自己的测试或构建命令。`,
    `[VERIFICATION_PROJECT_UNSUPPORTED] no package.json, tsconfig or Cargo.toml in ${workingDirectory}`, { actualCwd: workingDirectory });
  if (!javascript) commands = CARGO_ARGS[kind] ? { [kind]: { cmd: "cargo", args: [...CARGO_ARGS[kind]], trust: "workspace_script", source: "package_script" } } : {};
  else switch (kind) {
    case "typecheck": {
      let configuration: string;
      if (directory) {
        const mainExists = filesystem.existsSync(paths.join(directory, "tsconfig.main.json"));
        const defaultExists = filesystem.existsSync(paths.join(directory, "tsconfig.json"));
        if (mainExists) configuration = paths.join(directory, "tsconfig.main.json");
        else if (defaultExists) configuration = paths.join(directory, "tsconfig.json");
        else return verificationFailure(kind, "VERIFICATION_CONFIG_NOT_FOUND",
          `cwd 下未找到 tsconfig.main.json 或 tsconfig.json: ${directory}`,
          `[错误] 未找到 TypeScript 配置文件: ${directory}`, { actualCwd: directory });
      } else configuration = "tsconfig.main.json";
      if (!resolveBuiltinExecutable("builtin:tsc", workingDirectory, configuration)) return verificationFailure(kind,
        "TYPESCRIPT_NOT_FOUND", `本地 TypeScript 未安装: ${workingDirectory}`,
        `[TYPESCRIPT_NOT_FOUND] local typescript CLI not found in ${workingDirectory}`, { actualCwd: directory });
      commands = { typecheck: { cmd: "builtin:tsc", args: ["-p", configuration, "--noEmit"], trust: "builtin", source: "tsconfig", configPath: configuration } };
      break;
    }
    case "build": {
      const build = await resolveWorkspaceBuildCommand(workingDirectory);
      if (!build.ok) return verificationFailure(kind, build.errorCode, build.error,
        `[${build.errorCode}] ${build.error}`, { actualCwd: workingDirectory });
      commands = { build: { cmd: build.command, args: build.args, trust: "workspace_script", source: "package_script" } };
      break;
    }
    default:
      commands = {
        test: { cmd: "builtin:vitest", args: ["--reporter=default"], trust: "builtin", source: "vitest" },
        lint: { cmd: process.execPath, args: [], trust: "workspace_script", source: "package_script" },
      };
  }
  const selected = commands[kind];
  if (!selected) return verificationFailure(kind, "INVALID_INPUT", `不支持的验证类型: ${kind}，支持: typecheck/test/build/lint`, `[错误] 不支持的验证类型: ${kind}`);
  if (javascript && kind === "test" && !resolveBuiltinExecutable("builtin:vitest", workingDirectory)) return verificationFailure(kind,
    "VITEST_NOT_FOUND", `本地 Vitest 未安装: ${workingDirectory}`,
    `[VITEST_NOT_FOUND] local vitest CLI not found in ${workingDirectory}`, { actualCwd: workingDirectory });
  if (javascript && kind === "lint") {
    try {
      const lintCli = require.resolve("eslint/bin/eslint.js", { paths: [workingDirectory] });
      if (!filesystem.existsSync(lintCli) || !paths.isAbsolute(lintCli)) throw new Error("invalid eslint path");
      selected.args = [lintCli, "src/main", "--max-warnings=0"];
    } catch {
      return verificationFailure(kind, "ESLINT_NOT_FOUND", `本地 ESLint 未安装: ${workingDirectory}`,
        `[ESLINT_NOT_FOUND] local eslint CLI not found in ${workingDirectory}`, { actualCwd: workingDirectory });
    }
  }
  const display = resolveBuiltinExecutable(selected.cmd, workingDirectory, selected.configPath);
  const executable = display?.executable ?? selected.cmd;
  const argv = [...(display?.args ?? []), ...selected.args];
  const started = Date.now();
  const invocation = `${executable} ${argv.join(" ")}`;
  console.log(LOG_PREFIX, "run_verification:", kind, invocation, directory ? "cwd=" + directory : "");
  const runner = new VerificationRunner();
  try {
    const outcome = await runner.runStep({
      id: `run_verification_${kind}`, type: kind as any,
      packageRoot: directory || process.cwd(), cwd: directory || process.cwd(),
      configPath: selected.configPath, trust: selected.trust, executable: selected.cmd,
      args: selected.args, source: selected.source,
    }, { permissionLevel: (await import("../../../permission/permission")).getCurrentLevel(), signal: undefined });
    const elapsed = Date.now() - started;
    const passed = outcome.passed;
    console.log(LOG_PREFIX, "run_verification 完成:", kind, "exitCode=" + outcome.exitCode, "passed=" + passed,
      "durationMs=" + elapsed, "stdoutLen=" + outcome.stdout.length, "stderrLen=" + outcome.stderr.length);
    const code = outcome.errorCode;
    const approval = code === "VERIFICATION_APPROVAL_REQUIRED";
    const timeout = code === "VERIFICATION_TIMEOUT" || outcome.timedOut;
    return JSON.stringify({
      success: !approval && !timeout, verificationType: kind, command: invocation,
      actualCwd: directory || process.cwd(), exitCode: outcome.exitCode ?? -1,
      stderr: outcome.stderr, stdout: outcome.stdout, spawnError: null, timedOut: outcome.timedOut,
      passed, truncated: outcome.stdout.includes("... (truncated") || outcome.stderr.includes("... (truncated"),
      durationMs: elapsed, errorCode: code, retryable: timeout, ...(approval ? { approvalRequired: true } : {}),
    });
  } catch (failure) {
    const elapsed = Date.now() - started;
    const detail = failure instanceof Error ? failure.message : String(failure);
    console.error(LOG_PREFIX, "run_verification 失败:", kind, "error:", detail);
    return JSON.stringify({
      success: false, errorCode: "VERIFICATION_SPAWN_FAILED", error: `命令启动失败: ${detail}`,
      verificationType: kind, command: invocation, actualCwd: directory || process.cwd(), exitCode: -1,
      stdout: "", stderr: `[VERIFICATION_SPAWN_FAILED] ${detail}`, spawnError: { code: undefined, message: detail },
      timedOut: false, passed: false, truncated: false, durationMs: elapsed, retryable: false,
    });
  }
}

export const runVerificationTool: ToolDefinition = {
  "id": "run_verification",
  "name": "运行验证",
  "description": "执行代码验证（类型检查/测试/构建/lint）。是唯一能产生可信验证证据的工具。\n\n何时用：\n- 代码修改后需要验证编译是否通过\n- 需要运行测试确认修改正确\n- 需要 lint 检查代码风格\n\n不要用于：\n- 读取文件内容 → read_file\n- 执行任意命令 → run_shell\n- 修改代码 → apply_patch/str_replace/write_file\n\n参数：verificationType（验证类型：typecheck/test/build/lint），cwd（可选工作目录）。",
  "enabled": true,
  "risk": "shell",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "verification",
  "ledgerPolicy": "bypass",
  "inputSchema": {
    "type": "object",
    "properties": {
      "verificationType": {
        "type": "string",
        "enum": [
          "typecheck",
          "test",
          "build",
          "lint"
        ],
        "description": "验证类型：typecheck=类型检查，test=运行测试，build=构建，lint=代码风格检查"
      },
      "cwd": {
        "type": "string",
        "description": "工作目录绝对路径，可选"
      }
    },
    "required": [
      "verificationType"
    ]
  },
  execute: executeVerification,
};
