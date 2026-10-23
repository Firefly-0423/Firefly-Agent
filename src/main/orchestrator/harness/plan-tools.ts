import * as fs from "fs";
import * as path from "path";
import type { AskClarificationCard } from "../../../shared/ask-clarification";
import type { ToolSpec, ToolCall } from "../vendors/types";
import type { ToolObservation, HarnessEvent } from "./types";
import { tryParseToolCallArgs } from "./types";
import type { ToolContext } from "../tools/registry/tool-context";
import { enterPlanDiscussing, getPlanPath, getPlanState, markPlanWritten } from "../plan-mode";

export const ENTER_PLAN_MODE_TOOL_ID = "enter_plan_mode";
export const WRITE_PLAN_TOOL_ID = "write_plan";
export const enterPlanModeToolSpec: ToolSpec = {
  name: ENTER_PLAN_MODE_TOOL_ID,
  description: "进入计划模式：与用户讨论方案并产出可审批的实施计划。\n\n何时必须用：\n- 用户明确要求进入计划模式 / 说\"做个计划\"/\"先别动手\"/\"我们先讨论\"等意图时，必须调用本工具，不要自行判断\"任务太简单\"而跳过。\n\n何时优先考虑：\n- 涉及代码/文件改动，且非单次工具调用即可完成的任务。\n\n何时不用：\n- 单纯问答（直接回答）；单步小任务（一次工具调用即可完成且无副作用）；用户只要一段文字内容（直接写）。\n\n进入后：只能读取信息与讨论方案，修改类工具全部禁用；讨论收敛后用 write_plan 提交计划，用户批准后才会开始执行。",
  parameters: { type: "object", properties: {
    reason: { type: "string", description: "一句话说明为什么这个请求值得先做计划（可选）" },
  }, required: [] },
};
export const writePlanToolSpec: ToolSpec = {
  name: WRITE_PLAN_TOOL_ID,
  description: "把完整实施计划写入计划文件（仅计划模式可用）。\n内容为 Markdown：目标、背景、任务清单（checkbox 列表，每项可独立验证）、风险与回退。\n整份计划经 content 参数传入，Runtime 落盘并提交用户审批；需要修改时再次调用整份覆盖。\n写入后本轮继续正常收尾，用户会在你回复结束后看到审批卡片。",
  parameters: { type: "object", properties: {
    content: { type: "string", description: "完整计划 Markdown 全文（含任务 checkbox 清单）" },
  }, required: ["content"] },
};
function conversationIdOf(context?: ToolContext): string { return context?.conversationId ?? "default"; }
async function ensureWorkspaceMetadataIgnored(workspaceRoot: string): Promise<void> {
  try {
    const filename = path.join(workspaceRoot, ".gitignore");
    let previous = "";
    try { previous = await fs.promises.readFile(filename, "utf8"); } catch { /* 缺失时按空文件补充规则。 */ }
    if (/(^|\n)\s*\.firefly\/?\s*(\n|$)/.test(previous)) return;
    const separator = previous.endsWith("\n") || previous === "" ? "" : "\n";
    await fs.promises.writeFile(filename, `${previous}${separator}\n# Firefly agent\n.firefly/\n`, "utf8");
  } catch { /* 忽略规则无法写入时仍允许保存计划。 */ }
}
export async function executeEnterPlanMode(call: ToolCall, ctx: ToolContext | undefined,
  onEvent?: (event: HarnessEvent) => void): Promise<ToolObservation> {
  const conversation = conversationIdOf(ctx);
  const entered = enterPlanDiscussing(conversation, ctx?.resolvedWorkspaceRoot);
  if (!entered.ok) return { outcome: "failure", category: "runtime_safety", tool: ENTER_PLAN_MODE_TOOL_ID, message: entered.reason ?? "当前状态不可进入计划模式" };
  onEvent?.({ type: "plan_mode_changed", state: "PLAN_DISCUSSING" });
  return { outcome: "success", tool: ENTER_PLAN_MODE_TOOL_ID,
    message: "已进入计划模式。后续只能读取信息、讨论方案，修改类工具已被禁用。请与用户讨论方案；讨论收敛后，将完整计划（目标、任务 checkbox 清单、风险）通过 write_plan 写入并提交审批。" };
}
export async function executeWritePlan(call: ToolCall, ctx: ToolContext | undefined,
  onEvent?: (event: HarnessEvent) => void): Promise<ToolObservation> {
  const conversation = conversationIdOf(ctx);
  if (getPlanState(conversation) !== "PLAN_DISCUSSING") return { outcome: "failure", category: "runtime_safety", tool: WRITE_PLAN_TOOL_ID, message: "write_plan 仅在计划讨论状态可用" };
  const parsed = tryParseToolCallArgs(call);
  const markdown = typeof parsed?.content === "string" ? parsed.content.trim() : "";
  if (!markdown) return { outcome: "failure", category: "invalid_arguments", tool: WRITE_PLAN_TOOL_ID, message: "content 必须是非空的计划 Markdown" };
  const destination = getPlanPath(conversation);
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (destination.includes(".firefly") && ctx?.resolvedWorkspaceRoot) await ensureWorkspaceMetadataIgnored(ctx.resolvedWorkspaceRoot);
    await fs.promises.writeFile(destination, markdown, "utf8");
  } catch (cause) {
    return { outcome: "failure", category: "runtime_safety", tool: WRITE_PLAN_TOOL_ID, message: `计划文件写入失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
  markPlanWritten(conversation);
  onEvent?.({ type: "plan_written", planPath: destination });
  return { outcome: "success", tool: WRITE_PLAN_TOOL_ID, target: destination,
    message: `计划已写入 ${destination}，本轮收尾后将提交用户审批。如需修改请再次调用整份覆盖。` };
}
export function buildPlanReviewCard(planPath: string): AskClarificationCard & { planPath: string } {
  const choices = [{ label: "批准计划，开始执行", value: "approve" }, { label: "我要修改 / 补充", value: "supplement" }];
  return { mode: "semantic_clarification", intro: "计划已生成，请审阅右侧计划内容后决定",
    questions: [{ field: "plan_decision", question: "是否批准此计划？", type: "single_select", options: choices, allowCustom: false, freeTextPlaceholder: "" }],
    deferredFields: [], planPath };
}
export function buildPlanSupplementCard(): AskClarificationCard {
  return { mode: "semantic_clarification", intro: "请在下方描述你想补充或修改的内容，我会更新计划后再次提交",
    questions: [{ field: "plan_supplement", question: "请描述你的补充：", type: "text", options: [], allowCustom: true,
      freeTextPlaceholder: "例如：第三步改成先写测试；补充一个回滚方案…" }], deferredFields: [] };
}
