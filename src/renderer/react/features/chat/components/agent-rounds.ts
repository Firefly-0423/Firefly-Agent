import { t } from "../../../i18n";
import type { AgentRoundRecord, ProcessMessageRecord, ReasoningBlock, TaskDelegationDisplayRecord, ToolExecutionRecord } from "../../../../../shared/chat-types";

// 保持工具顺序，文案在调用时求值。
const TOOL_LABEL_KEYS: Record<string, string> = Object.fromEntries([
  ["list_dir", "agentRounds.toolListDir"], ["read_file", "agentRounds.toolReadFile"],
  ["write_file", "agentRounds.toolWriteFile"], ["edit_file", "agentRounds.toolEditFile"],
  ["str_replace", "agentRounds.toolStrReplace"], ["apply_patch", "agentRounds.toolApplyPatch"],
  ["search_code", "agentRounds.toolSearchCode"], ["search_text", "agentRounds.toolSearchText"],
  ["run_shell", "agentRounds.toolRunShell"], ["ask_user", "agentRounds.toolAskUser"],
]);
const SUMMARY_TOOL_KEYS: Record<string, string> = Object.fromEntries([
  ["list_dir", "agentRounds.summaryListDir"], ["read_file", "agentRounds.summaryReadFile"],
  ["write_file", "agentRounds.summaryWriteFile"], ["edit_file", "agentRounds.summaryEditFile"],
  ["search_code", "agentRounds.summarySearchCode"], ["search_text", "agentRounds.summarySearchCode"],
  ["run_shell", "agentRounds.summaryRunShell"], ["update_todo", "agentRounds.summaryUpdateTodo"],
  ["read_tool_result", "agentRounds.summaryReadToolResult"],
]);

function translatedToolName(name: string, displayName: string | undefined, action: boolean): string {
  if (displayName) { return displayName; }
  const translation = TOOL_LABEL_KEYS[name];
  if (translation) { return t(translation); }
  return action ? t("agentRounds.fallbackAction") : name;
}

export interface ToolExecutionPresentation {
  label: string; statusText: string; detail?: string;
}

function toolObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch { return undefined; }
  }
  return undefined;
}

function targetArgument(record: Record<string, unknown> | undefined, shell: boolean): string | undefined {
  const fields = shell ? ["command"] : ["path", "filePath", "file_path", "directory", "dir"];
  for (const field of fields) {
    const candidate = record?.[field];
    if (typeof candidate !== "string" || !candidate.trim()) { continue; }
    return candidate.trim();
  }
  return undefined;
}

export function describeToolExecution(tool: ToolExecutionRecord): ToolExecutionPresentation {
  if (tool.name === "ask_user") {
    const stateKey = tool.status === "running" ? "agentRounds.askUserWaiting"
      : tool.status === "error" ? "agentRounds.askUserFailed" : "agentRounds.askUserAnswered";
    return { label: translatedToolName(tool.name, tool.displayName, false), statusText: t(stateKey), detail: undefined };
  }
  const input = toolObject(tool.argsText);
  const output = toolObject(tool.result);
  const detail = targetArgument(input, tool.name === "run_shell");
  const label = translatedToolName(tool.name, tool.displayName, false);
  const action = translatedToolName(tool.name, tool.displayName, true);
  let statusText: string;
  if (tool.name === "run_shell" && tool.status === "error" && output?.timedOut === true) {
    statusText = t("agentRounds.commandTimeout");
  } else {
    const stateKey = tool.status === "running" ? "agentRounds.statusRunning"
      : tool.status === "error" ? "agentRounds.statusFailed" : "agentRounds.statusDone";
    statusText = t(stateKey, { action });
  }
  return { label, statusText, detail };
}

export function createRoundProcessMessage(id: string, content: string, afterToolCount: number, roundId?: string, seq?: number): ProcessMessageRecord {
  const message: ProcessMessageRecord = { id, content, afterToolCount, roundId, seq };
  return message;
}

export function startAgentRound(rounds: readonly AgentRoundRecord[], roundId: string, startedAt = Date.now()): AgentRoundRecord[] {
  const alreadyStarted = rounds.some(({ id }) => id === roundId);
  const next = [...rounds];
  if (!alreadyStarted) {
    next.push({ id: roundId, status: "running", startedAt });
  }
  return next;
}

export function finishAgentRound(rounds: readonly AgentRoundRecord[], roundId: string, completedAt = Date.now()): AgentRoundRecord[] {
  return rounds.map((record) => {
    if (record.id !== roundId) { return record; }
    return { ...record, status: "completed", completedAt };
  });
}

export interface AgentRoundBoundaryState {
  rounds: AgentRoundRecord[]; activeRoundId?: string;
}

export function applyAgentRoundBoundary(state: AgentRoundBoundaryState, action: "start" | "end", roundId: string, now = Date.now()): AgentRoundBoundaryState {
  switch (action) {
    case "start": return { rounds: startAgentRound(state.rounds, roundId, now), activeRoundId: roundId };
    default: return {
      rounds: finishAgentRound(state.rounds, roundId, now),
      activeRoundId: state.activeRoundId === roundId ? undefined : state.activeRoundId,
    };
  }
}

/** One fact per summary line: both search tools share "searched N times". */
export function summarizeToolFacts(records: readonly ToolExecutionRecord[]): string[] {
  const successful = records.filter(({ status }) => status === "success");
  const totals = new Map<string, number>();
  successful.forEach(({ name }) => {
    const key = SUMMARY_TOOL_KEYS[name];
    if (key) { totals.set(key, (totals.get(key) ?? 0) + 1); }
  });
  const facts = [...new Set(Object.values(SUMMARY_TOOL_KEYS))].flatMap((key) => totals.has(key) ? [t(key, { count: totals.get(key) })] : []);
  if (facts.length === 0 && successful.length > 0) {
    facts.push(t("agentRounds.summaryFallback", { count: successful.length }));
  }
  return facts;
}

const LOOK_AROUND_TOOLS = new Set(["list_dir", "read_file", "search_code", "search_text"]);
/** Bookkeeping steps: they keep the run on track but change nothing the user needs to see. */
const BOOKKEEPING_TOOLS = new Set(["update_todo", "read_tool_result"]);
/** A finished step that changes nothing: it folds into the quiet stretch around it. */
const quietTool = (tool: ToolExecutionRecord) => tool.status === "success" && (LOOK_AROUND_TOOLS.has(tool.name) || BOOKKEEPING_TOOLS.has(tool.name)) && !tool.changes?.length;
/** Steps worth counting in a run's one-line summary; bookkeeping is left out. */
export const countedTools = (tools: readonly ToolExecutionRecord[]) => tools.filter((tool) => !BOOKKEEPING_TOOLS.has(tool.name));
export type ToolStep = { kind: "single"; tool: ToolExecutionRecord } | { kind: "group"; tools: ToolExecutionRecord[] };
/** Consecutive successful reads, searches and listings fold into one step; edits, commands, failures and running steps stay on their own. */
export function groupToolSteps(tools: readonly ToolExecutionRecord[]): ToolStep[] {
  const steps: ToolStep[] = [];
  let run: ToolExecutionRecord[] = [];
  const flush = () => {
    if (run.length > 1) { steps.push({ kind: "group", tools: run }); } else if (run.length === 1) { steps.push({ kind: "single", tool: run[0] }); }
    run = [];
  };
  for (const tool of tools) {
    if (quietTool(tool)) { run.push(tool); continue; }
    flush();
    steps.push({ kind: "single", tool });
  }
  flush();
  return steps;
}

export function countRoundChangedFiles(tools: readonly ToolExecutionRecord[]): number {
  const unique = new Set<string>();
  for (const execution of tools) {
    const reported = execution.changes ?? [];
    for (const edit of reported) { unique.add(edit.file); }
  }
  return unique.size;
}

export interface FlatRunTimelineEntry {
  kind: "reasoning" | "process" | "tool" | "task"; key: string; seq?: number;
  reasoning?: ReasoningBlock; process?: ProcessMessageRecord;
  tool?: ToolExecutionRecord; task?: TaskDelegationDisplayRecord;
}
interface FlatRunTimelineInput {
  processMessages: ProcessMessageRecord[]; reasoningBlocks: ReasoningBlock[];
  tools: ToolExecutionRecord[]; taskDelegations: TaskDelegationDisplayRecord[];
}

function legacyTimeline(input: FlatRunTimelineInput): FlatRunTimelineEntry[] {
  const output: FlatRunTimelineEntry[] = [];
  const { tools, processMessages, reasoningBlocks, taskDelegations } = input;
  for (let slot = 0; slot <= tools.length; slot += 1) {
    processMessages.forEach((process) => {
      if ((process.afterToolCount ?? 0) === slot) { output.push({ kind: "process", key: process.id, process }); }
    });
    reasoningBlocks.forEach((reasoning) => {
      if ((reasoning.afterToolCount ?? 0) === slot) { output.push({ kind: "reasoning", key: reasoning.id, reasoning }); }
    });
    if (slot < tools.length) {
      const tool = tools[slot];
      output.push({ kind: "tool", key: tool.id, tool });
    }
  }
  for (const task of taskDelegations) {
    output.push({ kind: "task", key: `task-${task.invocationId}`, task });
  }
  return output;
}

/**
 * Where a delegation sits in a sequenced timeline: right after the delegate_agent call that ran it,
 * else after the round's first delegate_agent call, else at the start of its round; unanchored ones go last.
 */
function delegationSeq(task: TaskDelegationDisplayRecord, input: FlatRunTimelineInput): number | undefined {
  const delegates = input.tools.filter((tool) => tool.name === "delegate_agent" && tool.seq !== undefined);
  const own = delegates.find((tool) => tool.taskResult?.sessionId === task.taskId)
    ?? delegates.find((tool) => task.roundId !== undefined && tool.roundId === task.roundId);
  if (own) { return own.seq! + 0.5; }
  if (task.roundId === undefined) { return undefined; }
  const round = [...input.processMessages, ...input.reasoningBlocks, ...input.tools]
    .filter((entry) => entry.roundId === task.roundId && entry.seq !== undefined).map((entry) => entry.seq!);
  return round.length > 0 ? Math.min(...round) - 0.5 : undefined;
}

export function buildFlatRunTimeline(input: FlatRunTimelineInput): FlatRunTimelineEntry[] {
  const { processMessages, reasoningBlocks, tools, taskDelegations } = input;
  const sequenced = [...processMessages, ...reasoningBlocks, ...tools].some(({ seq }) => seq !== undefined);
  if (!sequenced) { return legacyTimeline(input); }
  const output: FlatRunTimelineEntry[] = [];
  reasoningBlocks.forEach((reasoning) => output.push({ kind: "reasoning", key: reasoning.id, seq: reasoning.seq, reasoning }));
  processMessages.forEach((process) => output.push({ kind: "process", key: process.id, seq: process.seq, process }));
  tools.forEach((tool) => output.push({ kind: "tool", key: tool.id, seq: tool.seq, tool }));
  output.push(...taskDelegations.map((task) => ({ kind: "task" as const, key: `task-${task.invocationId}`, seq: delegationSeq(task, input), task })));
  const ranked = output.map((value, order) => ({ value, order }));
  ranked.sort((left, right) => {
    const delta = (left.value.seq ?? Number.MAX_SAFE_INTEGER) - (right.value.seq ?? Number.MAX_SAFE_INTEGER);
    return delta !== 0 ? delta : left.order - right.order;
  });
  return ranked.map(({ value }) => value);
}

export type RunTimelineRow = FlatRunTimelineEntry | { kind: "group"; key: string; entries: FlatRunTimelineEntry[]; tools: ToolExecutionRecord[] };
const quietStep = (entry: FlatRunTimelineEntry) => entry.kind === "tool" ? quietTool(entry.tool!) : entry.kind === "reasoning" && !entry.reasoning?.streaming;
/**
 * Folds every quiet stretch of the timeline (quiet steps and the finished thinking around them) into one row.
 * Narration, edits, commands, failures, delegations and live thinking stay on their own rows.
 */
export function foldRunTimeline(entries: readonly FlatRunTimelineEntry[]): RunTimelineRow[] {
  const rows: RunTimelineRow[] = [];
  let run: FlatRunTimelineEntry[] = [];
  const flush = () => {
    const tools = run.filter((entry) => entry.kind === "tool").map((entry) => entry.tool!);
    if (tools.length > 0 && run.length > 1) { rows.push({ kind: "group", key: `group-${run[0].key}`, entries: run, tools }); } else { rows.push(...run); }
    run = [];
  };
  for (const entry of entries) {
    if (quietStep(entry)) { run.push(entry); continue; }
    flush();
    rows.push(entry);
  }
  flush();
  return rows;
}

export function buildAskUserQa(tool: ToolExecutionRecord): string[] {
  if (tool.name !== "ask_user" || !tool.result) { return []; }
  const lines = tool.result.split("\n").map((text) => text.trim());
  return lines.filter((text) => text.includes("→"));
}
