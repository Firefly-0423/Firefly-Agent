// 档位 × 风险 → 放行/询问/拒绝 的纯函数。无 Electron、磁盘、IPC 依赖，
// 验证流水线等核心模块可以直接引用而不必拉起权限宿主。
import type { ToolRiskLevel } from "../shared/permission-approval";

export type AgentFileAccessLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";

// 风险类型的权威定义在 shared，这里转出，旧的引用路径继续可用。
export type { ToolRiskLevel };

type Verdict = "allow" | "ask" | "deny";

// 受限档位各自直接放行的风险。shell 在所有受限档位都列入：
// 真正的文件系统边界由沙箱按档位收口，这里不再充当 shell 的闸门。
const OPEN_RISKS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["project-read-only", new Set(["fs-read", "network", "shell"])],
  ["read-only", new Set(["fs-read", "network", "shell"])],
  ["scoped", new Set(["fs-read", "fs-write", "network", "shell"])],
]);

export function policyFor(level: AgentFileAccessLevel, risk: ToolRiskLevel): Verdict {
  if (risk === "safe") return "allow";
  if (level === "full") return "allow";
  if (level === "per-action") return "ask";
  // 受限档位按清单放行；清单外的风险，以及无法识别的档位，一律拒绝。
  return OPEN_RISKS.get(level)?.has(risk) ? "allow" : "deny";
}
