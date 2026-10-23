import type { ToolSpec, ToolCall } from "../vendors/types";
import type { ToolObservation, TodoStatus, TodoItem, HarnessEvent, AgentState } from "./types";
import { tryParseToolCallArgs, invalidToolCallArguments } from "./types";
import { createAbortError, isAbortError, raceWithSignal } from "../../abort-utils";
import { resolveUncertainEffect } from "./uncertain-effect-guard";
import type { DelegationScope } from "../child-session-types";
import type { AgentExecuteResult, AgentExecuteRequest } from "../persistent-agent-runtime";
import { READ_TOOL_RESULT_TOOL_ID, readToolResultToolSpec } from "./tool-output/read-tool-result";
import { ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID, enterPlanModeToolSpec, writePlanToolSpec } from "./plan-tools";

export const UPDATE_TODO_TOOL_ID = "update_todo";
export const DELEGATE_AGENT_TOOL_ID = "delegate_agent";
export const delegateAgentToolSpec = {
  name: DELEGATE_AGENT_TOOL_ID,
  description: "委托已配置的持久专业 Agent。仅传 agent_id 与完整 prompt；运行时自动恢复当前会话和工作区下的该 Agent 上下文，不需要 task_id。父运行等待结果，子 Agent 不能再次委托；工具、Skills 与审批权限由运行时约束。",
  parameters: { type: "object", properties: {
    agent_id: { type: "string", description: "当前 Agent 目录中的准确 ID" },
    prompt: { type: "string", description: "本次完整委托指令" },
  }, required: ["agent_id", "prompt"], additionalProperties: false },
} satisfies ToolSpec;
export const updateTodoToolSpec: ToolSpec = {
  name: UPDATE_TODO_TOOL_ID,
  description: "更新可变工作笔记（Todo）。传入完整的新 TodoItem 数组（整表替换）。\n何时使用：预计任务需要至少 2 个 execution step（执行步骤）或 tool round（工具推进轮次）时，优先建立并持续更新清单；不按 LLM 调用次数计算。\n不要用于简单问答、纯闲聊或单次工具即可完成的任务。Todo 是可随事实和改变方向而重写的工作笔记，不是后续行动的强约束，也不是外部操作已经成功的证明。\n规则：\n- id 必须唯一\n- 同一时刻最多一个 in_progress\n- 状态转移：pending → in_progress → completed/cancelled；pending 也可直接 completed/cancelled（一轮内可批量收尾多条，无需逐条经过 in_progress）\n- 不要把已 completed/cancelled 的任务改回 pending\nRuntime 会校验并修正违规，修正后的实际列表会回告给你。",
  parameters: { type: "object", properties: { todos: {
    type: "array", description: "完整的新待办列表（替换旧列表）", items: { type: "object", properties: {
      id: { type: "string", description: "唯一标识" }, content: { type: "string", description: "任务描述" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "任务状态" },
      activeForm: { type: "string", description: "正在进行时的现在时描述（可选）" },
    }, required: ["id", "content", "status"] },
  } }, required: ["todos"] },
};
export const ASK_USER_TOOL_ID = "ask_user";
export const askUserToolSpec: ToolSpec = {
  name: ASK_USER_TOOL_ID,
  description: "在执行过程中需要用户提供偏好、澄清歧义、选择方向或补充自由文本时调用。这是排他工具：一轮里出现 ask_user 时，其他工具调用不执行。\n一次可问 1-3 个问题；支持单选、多选和自由填写。每题都必须回答，用户也可以自由填写“停止”等明确意图。不要用最终回复向用户提问；需要用户回答后继续当前任务时，应调用此工具。\n向用户征求**偏好/确认**时用本工具；不要用于出题测试用户的学习掌握程度（那是 pop_quiz 的职责：pop_quiz 是你考用户，ask_user 是你问用户）。",
  parameters: { type: "object", properties: { questions: {
    type: "array", minItems: 1, maxItems: 3, description: "要问用户的问题列表", items: { type: "object", properties: {
      id: { type: "string", description: "问题唯一标识" }, question: { type: "string", description: "问题文本" },
      type: { type: "string", enum: ["single_select", "multi_select", "text"], description: "single_select=单选；multi_select=多选；text=自由填写" },
      options: { type: "array", description: "单选/多选的可选项列表；text 类型不要传入", items: { type: "object", properties: {
        label: { type: "string", description: "选项显示文本" }, value: { type: "string", description: "选项值" },
        description: { type: "string", description: "选项补充说明（可选）" },
      }, required: ["label", "value"] } },
    }, required: ["id", "question", "type"] },
  } }, required: ["questions"] },
};
export const CONFIRM_UNCERTAIN_EFFECT_TOOL_ID = "confirm_uncertain_effect";
export const confirmUncertainEffectToolSpec: ToolSpec = {
  name: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  description: "当 Runtime 报告 unresolved uncertain effect 时，使用 effectId 请求用户明确确认是否允许再执行一次。确认文案和选项由 Runtime 固定生成，不能由模型提供。该工具与 ask_user 一样是排他工具。",
  parameters: { type: "object", properties: { effectId: { type: "string", description: "Runtime observation 给出的 effectId" } }, required: ["effectId"] },
};

const transitions: Record<TodoStatus, TodoStatus[]> = {
  pending: ["in_progress", "completed", "cancelled"], in_progress: ["completed", "cancelled"], completed: [], cancelled: [],
};
type TodoValidationResult = { corrections: string[]; items: TodoItem[] };
function validateAndCorrectTodos(newItems: TodoItem[], oldItems: TodoItem[]): TodoValidationResult {
  const corrections: string[] = [];
  const accepted: TodoItem[] = [];
  const identifiers = new Set<string>();
  const previous = new Map<string, TodoStatus>();
  for (const entry of oldItems) previous.set(entry.id, entry.status);
  let activeCount = 0;
  for (const entry of newItems) {
    if (identifiers.has(entry.id)) { corrections.push(`ID "${entry.id}" 重复，跳过后续重复项`); continue; }
    identifiers.add(entry.id);
    const statuses: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
    if (!statuses.includes(entry.status)) {
      corrections.push(`ID "${entry.id}" 状态 "${entry.status}" 无效，降级为 pending`);
      accepted.push({ ...entry, status: "pending" });
      continue;
    }
    const before = previous.get(entry.id);
    if (before && before !== entry.status && !transitions[before].includes(entry.status)) {
      corrections.push(`ID "${entry.id}" 非法状态转移 ${before} → ${entry.status}，保持原状态 ${before}`);
      accepted.push({ ...entry, status: before });
      continue;
    }
    if (entry.status === "in_progress") {
      activeCount++;
      if (activeCount > 1) {
        corrections.push(`ID "${entry.id}" 被降级为 pending（已有 in_progress 任务，最多一个）`);
        accepted.push({ ...entry, status: "pending" });
        continue;
      }
    }
    accepted.push(entry);
  }
  return { items: accepted, corrections };
}
export async function executeUpdateTodo(call: ToolCall, state: AgentState, onEvent?: (event: HarnessEvent) => void): Promise<ToolObservation> {
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return invalidToolCallArguments(call);
  const supplied = (parsed.todos as unknown) ?? [];
  if (!Array.isArray(supplied)) return { outcome: "failure", category: "invalid_arguments", tool: UPDATE_TODO_TOOL_ID, message: "todos 参数必须是数组" };
  const converted = supplied.map((value: unknown): TodoItem => {
    const entry = value as Record<string, unknown>;
    return { id: String(entry.id ?? ""), content: String(entry.content ?? ""), status: String(entry.status ?? "pending") as TodoStatus,
      ...(entry.activeForm ? { activeForm: String(entry.activeForm) } : {}) };
  });
  const checked = validateAndCorrectTodos(converted, state.todoItems);
  state.todoItems = checked.items;
  onEvent?.({ type: "todo_update", items: checked.items });
  const note = checked.corrections.length > 0 ? `\n\n⚠️ Runtime 修正了以下违规：\n${checked.corrections.map((line) => `- ${line}`).join("\n")}`
    : "\n\n✅ 所有 invariant 检查通过，列表已原样接受。";
  const summary = checked.items.map((entry) => `  [${entry.status}] ${entry.id}: ${entry.content}`).join("\n");
  return { outcome: "success", tool: UPDATE_TODO_TOOL_ID, message: `待办列表已更新（${checked.items.length} 项）：\n${summary}${note}`,
    output: JSON.stringify({ items: checked.items, corrections: checked.corrections }) };
}
export async function executeDelegateAgent(call: ToolCall,
  executor: ((request: AgentExecuteRequest, scope?: DelegationScope) => Promise<AgentExecuteResult>) | undefined,
  scope?: DelegationScope, onExecutionStarted?: () => void): Promise<ToolObservation> {
  if (!executor) return { outcome: "failure", category: "runtime_safety", tool: DELEGATE_AGENT_TOOL_ID, message: "当前运行未配置持久 Agent 委托" };
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return { outcome: "failure", category: "invalid_arguments", tool: DELEGATE_AGENT_TOOL_ID, message: "delegate_agent 参数必须是对象" };
  const roleId = typeof parsed.agent_id === "string" ? parsed.agent_id.trim() : "";
  const instruction = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (!roleId || !instruction || Object.keys(parsed).some((name) => name !== "agent_id" && name !== "prompt")) return {
    outcome: "failure", category: "invalid_arguments", tool: DELEGATE_AGENT_TOOL_ID, message: "delegate_agent 仅接受非空 agent_id 与 prompt",
  };
  let terminal: AgentExecuteResult;
  try {
    onExecutionStarted?.();
    terminal = scope ? await executor({ agentId: roleId, prompt: instruction }, scope) : await executor({ agentId: roleId, prompt: instruction });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    return { outcome: "failure", category: "runtime_safety", tool: DELEGATE_AGENT_TOOL_ID, message: cause instanceof Error ? cause.message : String(cause) };
  }
  return { outcome: terminal.status === "completed" ? "success" : "failure", tool: DELEGATE_AGENT_TOOL_ID,
    message: `Agent ${terminal.agentId}: ${terminal.status}`, output: JSON.stringify(terminal) };
}

type HarnessAskQuestionType = "text" | "multi_select" | "single_select";
type HarnessAskQuestion = { options: Array<{ description?: string; value: string; label: string }>; type: HarnessAskQuestionType; question: string; id: string };
type AskAnswer = { customInput?: string; selectedLabels?: string[]; selectedValues?: string[]; questionId: string };
const optionBounds: Record<HarnessAskQuestionType, { min: number; max: number }> = {
  single_select: { min: 2, max: 6 }, multi_select: { min: 2, max: 8 }, text: { min: 0, max: 0 },
};
function parseAskQuestions(raw: unknown): { questions?: HarnessAskQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return { error: "questions 必须是包含 1-3 个问题的数组" };
  const used = new Set<string>();
  const questions: HarnessAskQuestion[] = [];
  for (const [position, value] of raw.entries()) {
    const ordinal = position + 1;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `第 ${ordinal} 个问题必须是对象` };
    const entry = value as Record<string, unknown>;
    const id = String(entry.id ?? "").trim();
    const question = String(entry.question ?? "").trim();
    const type = String(entry.type ?? "");
    if (!id || used.has(id)) return { error: `第 ${ordinal} 个问题的 id 必须非空且唯一` };
    if (!question) return { error: `第 ${ordinal} 个问题文本不能为空` };
    if (type !== "single_select" && type !== "multi_select" && type !== "text") return { error: `第 ${ordinal} 个问题 type 必须是 single_select、multi_select 或 text` };
    const suppliedOptions = entry.options;
    if (suppliedOptions !== undefined && !Array.isArray(suppliedOptions)) return { error: `第 ${ordinal} 个问题的 options 必须是数组` };
    const candidates = (suppliedOptions ?? []) as unknown[];
    const bounds = optionBounds[type];
    if (candidates.length < bounds.min || candidates.length > bounds.max) return { error: `第 ${ordinal} 个 ${type} 问题必须有 ${bounds.min}-${bounds.max} 个选项` };
    const values = new Set<string>();
    const options: HarnessAskQuestion["options"] = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { error: `第 ${ordinal} 个问题含有无效选项` };
      const option = candidate as Record<string, unknown>;
      const label = String(option.label ?? "").trim();
      const value = String(option.value ?? "").trim();
      if (!label || !value || values.has(value)) return { error: `第 ${ordinal} 个问题的选项 label/value 必须非空，且 value 不可重复` };
      values.add(value);
      const description = typeof option.description === "string" ? option.description.trim() : "";
      options.push({ label, value, ...(description ? { description } : {}) });
    }
    used.add(id);
    questions.push({ id, question, type, options });
  }
  return { questions };
}
export function formatAskUserPreview(parsed: { questions?: HarnessAskQuestion[] }, observation: ToolObservation): string[] | string {
  if (observation.outcome !== "success") return observation.message;
  let replies: AskAnswer[] = [];
  try {
    const decoded = JSON.parse(observation.output ?? "{}") as { answers?: AskAnswer[] };
    if (Array.isArray(decoded.answers)) replies = decoded.answers;
  } catch { /* 无可读答案时为每题显示未回答。 */ }
  return (parsed.questions ?? []).map((question) => {
    const reply = replies.find((entry) => entry.questionId === question.id);
    const custom = reply?.customInput?.trim();
    const text = custom || (reply?.selectedLabels ?? []).filter(Boolean).join("、");
    return `${question.question} → ${text || "未回答"}`;
  });
}
export async function executeAskUser(call: ToolCall, requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined,
  onEvent?: (event: HarnessEvent) => void): Promise<ToolObservation> {
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return invalidToolCallArguments(call);
  const validated = parseAskQuestions((parsed.questions as unknown) ?? []);
  if (!validated.questions) return { outcome: "failure", category: "invalid_arguments", tool: ASK_USER_TOOL_ID, message: validated.error ?? "questions 参数无效" };
  const questions = validated.questions;
  if (!requestUserClarification) return { outcome: "failure", category: "runtime_safety", tool: ASK_USER_TOOL_ID, message: "requestUserClarification 函数未注入，无法向用户提问" };
  const card = { mode: "semantic_clarification" as const, intro: "任务需要补全信息",
    questions: questions.map((entry) => ({ field: entry.id, question: entry.question, type: entry.type, options: entry.options,
      allowCustom: true, freeTextPlaceholder: entry.type === "text" ? "请输入回答" : "或填写其他回答" })), deferredFields: [] };
  onEvent?.({ type: "ask_user", card });
  try {
    const answer = await requestUserClarification(card);
    const received = (answer as { answers?: Array<{ field?: string; selectedValues?: string[]; customText?: string }> })?.answers ?? [];
    if (received.length === 0) return { outcome: "success", tool: ASK_USER_TOOL_ID,
      message: "系统提示：用户未在时限内回答问题。请停止等待用户补充；若现有信息已足够完成当前任务，可基于现有信息继续执行。" };
    const answers: AskAnswer[] = [];
    for (const question of questions) {
      const matched = received.find((entry) => entry.field === question.id);
      const custom = matched?.customText?.trim();
      const selected = Array.isArray(matched?.selectedValues) ? matched.selectedValues : [];
      const known = selected.every((choice) => question.options.some((option) => option.value === choice));
      const required = question.type === "single_select" ? 1 : question.type === "multi_select" ? 1 : 0;
      if (!matched || (custom && selected.length > 0) || (!custom && selected.length < required)
        || !known || (question.type !== "multi_select" && selected.length > required)) return {
        outcome: "failure", category: "timeout", tool: ASK_USER_TOOL_ID, message: "未收到每个问题的有效回答，不能把空回答当作用户选择",
      };
      if (custom) { answers.push({ questionId: question.id, customInput: custom }); continue; }
      const labels = selected.map((choice) => question.options.find((option) => option.value === choice)?.label ?? choice);
      answers.push({ questionId: question.id, selectedValues: selected, selectedLabels: labels });
    }
    const observed: ToolObservation = { outcome: "success", tool: ASK_USER_TOOL_ID,
      message: `用户已回答 ${answers.length} 个问题`, output: JSON.stringify({ answers }) };
    const rows = formatAskUserPreview({ questions }, observed);
    return { ...observed, message: Array.isArray(rows) ? `${observed.message}\n${rows.join("\n")}` : observed.message };
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    return { outcome: "failure", category: "timeout", tool: ASK_USER_TOOL_ID, message: `用户回答超时或失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
export async function executeConfirmUncertainEffect(call: ToolCall, state: AgentState,
  requestUserClarification: ((card: unknown) => Promise<unknown>) | undefined, signal?: AbortSignal): Promise<ToolObservation> {
  const parsed = tryParseToolCallArgs(call);
  if (parsed === undefined) return invalidToolCallArguments(call);
  const id = String(parsed.effectId ?? "").trim();
  const pending = state.uncertainEffects.find((entry) => entry.id === id);
  if (!pending) return { outcome: "failure", category: "invalid_arguments", tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID, message: `未找到 unresolved uncertain effect: ${id || "(empty)"}` };
  if (!requestUserClarification) return { outcome: "failure", category: "runtime_safety", tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID, message: "requestUserClarification 函数未注入，无法取得用户确认" };
  const card = { mode: "semantic_clarification" as const, intro: `前一次 ${pending.toolName} 的结果无法确认。再次执行可能产生重复副作用。`,
    questions: [{ field: "decision", question: "是否仍要允许下一次相同操作？", type: "single_select" as const,
      options: [{ value: "allow_repeat", label: "仍然允许一次" }, { value: "do_not_repeat", label: "不要重复执行" }],
      allowCustom: false, freeTextPlaceholder: "" }], deferredFields: [] };
  try {
    const response = await raceWithSignal(requestUserClarification(card), signal) as { answers?: Array<{ field?: string; selectedValues?: string[] }> };
    if (signal?.aborted) throw createAbortError();
    const choice = response.answers?.find((entry) => entry.field === "decision")?.selectedValues?.[0];
    const current = state.uncertainEffects.find((entry) => entry.id === id);
    const allowed = choice === "allow_repeat" && Boolean(current);
    if (allowed && current) resolveUncertainEffect(state, current.toolCallId);
    return { outcome: "success", tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
      message: allowed ? "用户已明确授权下一次匹配操作；授权只消费一次。" : "用户未授权重复操作；uncertain effect 保持 unresolved。",
      output: JSON.stringify({ effectId: id, authorized: allowed }) };
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    return { outcome: "failure", category: "timeout", tool: CONFIRM_UNCERTAIN_EFFECT_TOOL_ID, message: `用户确认超时或失败：${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
export const HARNESS_BUILTIN_TOOL_IDS = new Set([DELEGATE_AGENT_TOOL_ID, UPDATE_TODO_TOOL_ID, ASK_USER_TOOL_ID,
  CONFIRM_UNCERTAIN_EFFECT_TOOL_ID, READ_TOOL_RESULT_TOOL_ID, ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID]);
export function isHarnessBuiltin(toolName: string): boolean { return HARNESS_BUILTIN_TOOL_IDS.has(toolName); }
export function isInteractiveHarnessBuiltin(toolName: string): boolean {
  return toolName === ASK_USER_TOOL_ID || toolName === CONFIRM_UNCERTAIN_EFFECT_TOOL_ID;
}
function planToolSpecsFor(planState: import("../plan-mode").PlanStateName | undefined): ToolSpec[] {
  if (planState === "NORMAL") return [enterPlanModeToolSpec, writePlanToolSpec];
  return planState === "PLAN_DISCUSSING" ? [writePlanToolSpec] : [];
}
export function getHarnessBuiltinToolSpecs(options?: {
  includeInteractive?: boolean; includeAgent?: boolean;
  agentDefinitions?: readonly { id: string; nickname: string; description: string }[];
  planState?: import("../plan-mode").PlanStateName;
}): ToolSpec[] {
  const interactive = options?.includeInteractive !== false ? [askUserToolSpec, confirmUncertainEffectToolSpec] : [];
  const roles = options?.agentDefinitions;
  const delegation = options?.includeAgent === true ? [{ ...delegateAgentToolSpec,
    description: delegateAgentToolSpec.description + (roles?.length ? `\n可用角色：${roles.map((entry) => `${entry.id}（${entry.nickname}）：${entry.description}`).join("；")}` : ""),
    parameters: roles?.length ? { ...delegateAgentToolSpec.parameters, properties: { ...delegateAgentToolSpec.parameters.properties,
      agent_id: { type: "string", enum: roles.map((entry) => entry.id) } } } : delegateAgentToolSpec.parameters,
  }] : [];
  const planning = planToolSpecsFor(options?.planState);
  return [updateTodoToolSpec, ...interactive, ...delegation, readToolResultToolSpec, ...planning];
}
