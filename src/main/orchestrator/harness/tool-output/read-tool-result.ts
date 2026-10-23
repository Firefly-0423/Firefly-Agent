import type { ToolSpec, ToolCall } from "../../vendors/types";
import type { ToolContext } from "../../tools/registry/tool-context";
import type { ToolObservation } from "../types";
import { tryParseToolCallArgs, invalidToolCallArguments } from "../types";
import { ToolOutputCorruptError, ToolOutputInvalidInputError, toolOutputRecordId, toolOutputResultRef } from "./file-tool-output-store";
import type { ToolOutputStore } from "./tool-output-store";

export const READ_TOOL_RESULT_TOOL_ID = "read_tool_result";
export const readToolResultToolSpec: ToolSpec = {
  name: READ_TOOL_RESULT_TOOL_ID,
  description: "按需读取此前工具调用保存的完整结果。\n仅当上一轮 preview 不足以完成当前决策时使用；不要习惯性重读全部结果。\n提供 result_ref 可读取当前会话的任意已保存结果；只提供 tool_call_id 时只读取当前 Run 的对应结果。\noffset 和返回的 query 匹配位置均按 Unicode 码点计数；每次读取最多 8192 个码点。\nquery 是纯文本查找，不支持正则表达式。不要提供文件系统路径。",
  parameters: { type: "object", properties: {
    result_ref: { type: "string", description: "上一轮 observation 中的 tool-result:// 引用" }, tool_call_id: { type: "string", description: "当前 Run 中要读取的工具调用 ID" },
    offset: { type: "number", description: "读取起点；Unicode 码点坐标，默认 0" },
    length: { type: "number", description: "读取长度；默认 4096，最大 8192" },
    query: { type: "string", description: "可选纯文本查找词；返回匹配位置和附近片段" },
  } },
};
function invalidArguments(message: string): ToolObservation {
  return { outcome: "failure", category: "invalid_arguments", tool: READ_TOOL_RESULT_TOOL_ID, message };
}
function runtimeSafety(message: string): ToolObservation {
  return { outcome: "failure", category: "runtime_safety", tool: READ_TOOL_RESULT_TOOL_ID, message };
}
function notFound(): ToolObservation {
  return { outcome: "failure", category: "not_found", tool: READ_TOOL_RESULT_TOOL_ID, message: "未找到可读取的工具结果" };
}
function resolveResultRef(args: Record<string, unknown>, toolContext: ToolContext | undefined): { value: string } | { error: ToolObservation } {
  const reference = typeof args.result_ref === "string" ? args.result_ref.trim() : "";
  if (reference) return toolContext?.conversationId ? { value: reference } : { error: runtimeSafety("读取工具结果缺少当前会话标识") };
  const callId = typeof args.tool_call_id === "string" ? args.tool_call_id.trim() : "";
  if (!callId) return { error: invalidArguments("result_ref 与 tool_call_id 至少提供一个") };
  if (!toolContext?.conversationId || !toolContext.runId) return { error: runtimeSafety("按 tool_call_id 读取需要当前会话和运行标识") };
  return { value: toolOutputResultRef(toolOutputRecordId(toolContext.conversationId, toolContext.runId, callId)) };
}
export async function executeReadToolResult(call: ToolCall, store: ToolOutputStore | undefined,
  toolContext: ToolContext | undefined): Promise<ToolObservation> {
  if (!store) return runtimeSafety("工具结果存储未注入，当前运行无法读取完整结果");
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return invalidToolCallArguments(call);
  const reference = resolveResultRef(parsed, toolContext);
  if ("error" in reference) return reference.error;
  const needle = typeof parsed.query === "string" ? parsed.query : undefined;
  try {
    if (needle !== undefined) {
      const matches = await store.find({ conversationId: toolContext!.conversationId!, ownerSessionId: toolContext?.ownerSessionId,
        resultRef: reference.value, query: needle });
      if (!matches) return notFound();
      return { outcome: "success", tool: READ_TOOL_RESULT_TOOL_ID,
        message: matches.matches.length > 0 ? `在完整工具结果中找到 ${matches.matches.length} 处匹配` : "完整工具结果中没有匹配内容",
        output: JSON.stringify(matches) };
    }
    const from = parsed.offset === undefined ? 0 : parsed.offset;
    const count = parsed.length === undefined ? 4_096 : parsed.length;
    if (typeof from !== "number" || typeof count !== "number") return invalidArguments("offset 和 length 必须是数字");
    const page = await store.read({ conversationId: toolContext!.conversationId!, ownerSessionId: toolContext?.ownerSessionId,
      resultRef: reference.value, offset: from, length: count });
    if (!page) return notFound();
    return { outcome: "success", tool: READ_TOOL_RESULT_TOOL_ID,
      message: `已读取完整工具结果的第 ${page.offset} 个码点起内容`, output: JSON.stringify(page) };
  } catch (cause) {
    if (cause instanceof ToolOutputInvalidInputError) return invalidArguments(cause.message);
    return runtimeSafety(cause instanceof ToolOutputCorruptError ? "工具结果记录损坏，无法安全读取" : "工具结果读取失败");
  }
}
