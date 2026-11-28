import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runProcess = promisify(execFile);

type GitSource = "bundled" | "system";

export type ResolvedGitExecutable = {
  source: GitSource;
  version: string;
  command: string;
  env?: NodeJS.ProcessEnv;
};

export type ResolveGitExecutableDeps = {
  probe?: (command: string) => Promise<string | null>;
  bundledPath: string;
  systemCommand: string;
};

/** 运行 `<command> --version`，成功返回去空白的输出，失败或超时（3 秒）返回 null。 */
export async function probeGitExecutable(command: string): Promise<string | null> {
  try {
    const result = await runProcess(command, ["--version"], { windowsHide: true, timeout: 3_000 });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 优先使用系统 Git；系统不可用时回落到随应用打包的 MinGit，并隔离其系统级与全局配置，
 * 避免用户环境里的 Git 配置影响内置版本的行为。
 */
export async function resolveGitExecutable(
  deps: ResolveGitExecutableDeps,
): Promise<ResolvedGitExecutable | null> {
  const check = deps.probe ?? probeGitExecutable;

  const systemOutput = await check(deps.systemCommand);
  if (systemOutput) {
    return { command: deps.systemCommand, source: "system", version: parseGitVersion(systemOutput) };
  }

  const bundledOutput = await check(deps.bundledPath);
  if (!bundledOutput) return null;

  return {
    command: deps.bundledPath,
    source: "bundled",
    version: parseGitVersion(bundledOutput),
    env: isolatedBundledEnv(),
  };
}

function isolatedBundledEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
  };
}

/** 从 `git version X` 中取出版本号；无法识别时原样返回去空白的输出。 */
function parseGitVersion(output: string): string {
  const found = /git version\s+(.+)/i.exec(output);
  const captured = found ? found[1].trim() : "";
  return captured || output.trim();
}
