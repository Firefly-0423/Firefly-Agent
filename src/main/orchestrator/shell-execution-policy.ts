export type ShellEffect = "read" | "write" | "unknown";
export interface ExecutionPolicyDecision { message?: string; errorCode?: string; allowed: boolean }

const readerCommands = new Set("ls cat head tail wc grep rg fd echo pwd which where type file stat du df uname hostname date id whoami env sort uniq cut tr sed awk dir tree ver vol".split(" "));
const gitReaders = new Set("status diff log show branch remote stash tag describe rev-parse ls-files ls-remote cat-file count-objects blame".split(" "));
const gitWriters = new Set("checkout reset rebase merge pull push commit add rm mv clean am apply cherry-pick revert init clone fetch archive".split(" "));
const branchFlags = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);
const stashWrites = new Set(["push", "pop", "drop", "clear", "apply", "create"]);
const remoteWrites = new Set(["add", "remove", "rename", "set-url", "prune", "update"]);
const findWrites = new Set(["-delete", "-exec", "-execdir", "-ok"]);
const catastrophic = new Set(["format", "mkfs", "fdisk", "shutdown", "reboot", "halt", "poweroff", "dd"]);

function executableName(token: string): string { return token.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, ""); }
export function isCatastrophicCommand(command: string): boolean {
  const stripped = command.trim().toLowerCase();
  return stripped ? catastrophic.has(executableName(stripped.split(/\s+/)[0])) : false;
}

function gitEffect(arguments_: string[]): ShellEffect {
  const verb = arguments_[0];
  if (!verb) return "unknown";
  switch (verb) {
    case "branch": return arguments_.some((flag) => branchFlags.has(flag)) ? "write" : "read";
    case "stash": return arguments_[1] && stashWrites.has(arguments_[1]) ? "write" : "read";
    case "remote": return arguments_[1] && remoteWrites.has(arguments_[1]) ? "write" : "read";
    default:
      if (gitWriters.has(verb)) return "write";
      return gitReaders.has(verb) ? "read" : "unknown";
  }
}

export function classifyShellEffect(command: string): ShellEffect {
  const stripped = command.trim();
  if (!stripped) return "unknown";
  if (/[<>]/.test(stripped) || /\|/.test(stripped) || /(&&|\|\||[&;])/.test(stripped)) return "write";
  const words = stripped.split(/\s+/);
  const executable = executableName(words[0].toLowerCase());
  const arguments_ = words.slice(1).map((word) => word.toLowerCase());
  if (readerCommands.has(executable)) return "read";
  if (executable === "git") return gitEffect(arguments_);
  if (executable === "find") return arguments_.some((flag) => findWrites.has(flag)) ? "write" : "read";
  if (["npm", "yarn", "pnpm", "npx"].includes(executable)) {
    const verb = arguments_[0];
    if (!verb) return "unknown";
    const writes = new Set(["install", "i", "add", "remove", "uninstall", "publish", "create", "init", "run", "run-script", "ci", "update", "audit", "fix"]);
    if (writes.has(verb)) return "write";
    const reads = new Set(["list", "ls", "view", "info", "outdated", "why", "config", "prefix", "root"]);
    return reads.has(verb) ? "read" : "unknown";
  }
  return "unknown";
}

export function checkExecutionPolicy(effectKind: string, verificationPolicy: string, toolId: string): ExecutionPolicyDecision {
  if (effectKind === "unknown") return {
    allowed: false, errorCode: "E_UNKNOWN_TOOL_EFFECT",
    message: `工具 ${toolId} 的 effectKind 为 unknown，系统无法确定工具效果类型，拒绝执行。请为该工具配置 effectKind。`,
  };
  if (effectKind === "mutation" && verificationPolicy === "unknown") return {
    allowed: false, errorCode: "E_UNKNOWN_VERIFICATION_POLICY",
    message: `工具 ${toolId} 的 verificationPolicy 为 unknown，系统无法确定验证策略，拒绝执行。请为该工具配置 verificationPolicy 或 verificationPolicyResolver。`,
  };
  return { allowed: true };
}
