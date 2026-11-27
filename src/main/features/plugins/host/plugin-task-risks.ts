import type { ToolRisk } from "../../../../plugins/v2/schedules/types";
import type { ToolRegistry } from "../../../tooling/registry/tool-registry";

/**
 * 计划任务实际会用到的工具风险，来自工具注册表的 `risk` / `risks`，不信任插件自己声明的 requiredRisks。
 * 允许清单里注册表不认识的工具（拼写错误、尚未启动的 MCP 或插件工具）按最高风险 shell 处理，
 * 因为它之后可能出现在注册表里，而计划任务以 allow_all 无人值守运行。
 */
const UNKNOWN_TOOL_RISK: ToolRisk = "shell";

export function createPluginTaskRiskResolver(
  registry: Pick<ToolRegistry, "getById"> | undefined,
): (task: { allowedToolIds: readonly string[] }) => ToolRisk[] {
  return (task) => {
    const risks = new Set<ToolRisk>();
    for (const toolId of task.allowedToolIds) {
      const definition = registry?.getById(toolId);
      if (!definition) {
        risks.add(UNKNOWN_TOOL_RISK);
        continue;
      }
      for (const risk of [definition.risk, ...(definition.risks ?? [])]) {
        if (risk && risk !== "safe") risks.add(risk);
      }
    }
    return Array.from(risks);
  };
}
