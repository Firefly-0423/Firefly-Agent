import type { AskCardSubmission } from "../../../../../shared/ask-clarification";
import { t } from "../../../i18n";

export type AgentRunStageKind =
  | "understanding" | "planning" | "executing" | "waiting_permission" | "waiting_user"
  | "responding" | "completed" | "cancelled" | "timeout" | "failed";
export type AgentRunStage = { detail?: string; kind: AgentRunStageKind };
export type TaskPlanStep = { status?: "pending" | "running" | "completed" | "failed"; title: string; id: string };
export type TaskPlanPresentation = { steps: TaskPlanStep[]; title?: string };

type AskOption = { description?: string; label: string; id: string };
export type AskUserQuestion = {
  multiple?: boolean;
  freeTextPlaceholder?: string;
  allowCustomInput?: boolean;
  options: AskOption[];
  question: string;
  id: string;
};
export type AskUserInteraction = {
  totalQuestions?: number;
  currentQuestion?: number;
  responseKind?: "choice" | "clarification" | "submission";
  questions?: AskUserQuestion[];
  allowCustomInput?: boolean;
  options: AskOption[];
  question: string;
  intro?: string;
  revision?: number;
  runId?: string;
  source?: "agent";
  id: string;
  kind: "ask";
};
export type AskQuestionDraft = { customText: string; optionIds: string[]; source: "option" | "custom" | null };
export type AskDrafts = Record<string, AskQuestionDraft>;
export type PermissionInteraction = {
  childRunId?: string;
  toolCallId?: string;
  agentId?: string;
  targetPath?: string;
  workspaceName?: string;
  summary: string;
  toolName: string;
  sessionId?: string;
  source?: "agent";
  id: string;
  kind: "permission";
};
export type PopQuizInteraction = {
  questions: Array<{
    learningObjective: string;
    options: Array<{ label: string; id: string }>;
    question: string;
    type: "choice" | "multi" | "true_false" | "short_answer";
    id: string;
  }>;
  intro: string;
  runId?: string;
  id: string;
  kind: "quiz";
};
export type PermissionRequestDescription = { args: Record<string, unknown>; toolName: string; toolId: string };
export type ComposerInteraction = AskUserInteraction | PermissionInteraction | PopQuizInteraction;
export type ComposerSlotKind = "composer" | ComposerInteraction["kind"];

export function resolveComposerSlot(interaction?: ComposerInteraction): ComposerSlotKind {
  const selected = interaction?.kind;
  return selected ?? "composer";
}

export function resolveRunFinishedStage(result: { status?: string } | undefined | null): AgentRunStage {
  const outcome = result?.status;
  if (outcome === "cancelled") return { kind: "cancelled" };
  if (outcome === "timeout") return { kind: "timeout" };
  if (outcome === "runtime_error") return { kind: "failed" };
  return { kind: "completed" };
}

export function resolveTerminalContent(streamContent: string, status: string | undefined): string {
  const stripped = streamContent.trim();
  return status === "success" || status === "cancelled" || status === "timeout" ? stripped : streamContent;
}

export function isFormalAnswerCommitted(content: string, status: string | undefined, finalMessageCompleted: boolean): boolean {
  return status === "success" && finalMessageCompleted && content.trim().length > 0;
}

export function shouldClearComposerInteractionForTerminal(activeRunId: string | undefined, terminalRunId: string | undefined): boolean {
  if (!activeRunId || !terminalRunId) return true;
  return activeRunId === terminalRunId;
}

function readPermissionString(values: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const field of candidates) {
    const text = values[field];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return undefined;
}

function shortenPermissionText(text: string, limit = 48): string {
  if (text.length > limit) return text.slice(0, limit - 1) + "…";
  return text;
}

export function describePermissionRequest(request: PermissionRequestDescription): string {
  if (request.toolId === "weather") {
    const place = readPermissionString(request.args, ["city"]);
    return place ? t("runPresentation.permissionWeather", { city: shortenPermissionText(place, 24) }) : t("runPresentation.permissionWeatherPlain");
  }
  if (request.toolId === "web_search") {
    const phrase = readPermissionString(request.args, ["query", "keyword"]);
    return phrase ? t("runPresentation.permissionSearch", { query: shortenPermissionText(phrase) }) : t("runPresentation.permissionSearchPlain");
  }
  const documentKind = request.toolId === "write_word" ? "Word"
    : request.toolId === "write_excel" ? "Excel"
    : request.toolId === "write_powerpoint" ? "Powerpoint" : undefined;
  if (documentKind) {
    const name = readPermissionString(request.args, ["filename"]);
    return name ? t("runPresentation.permission" + documentKind, { filename: shortenPermissionText(name) })
      : t("runPresentation.permission" + documentKind + "Plain");
  }
  return t("runPresentation.permissionFallback", { toolName: request.toolName || request.toolId });
}

export function describeRunStage(stage: AgentRunStage): string {
  if (stage.kind === "executing" && stage.detail) {
    return t("runPresentation.stageExecutingDetail", { detail: stage.detail });
  }
  const keyByStage = {
    understanding: "stageUnderstanding", planning: "stagePlanning", executing: "stageExecuting",
    waiting_permission: "stageWaitingPermission", waiting_user: "stageWaitingUser", responding: "stageResponding",
    completed: "stageCompleted", cancelled: "stageCancelled", timeout: "stageTimeout", failed: "stageFailed",
  };
  if (Object.hasOwn(keyByStage, stage.kind)) return t("runPresentation." + keyByStage[stage.kind]);
  return undefined as never;
}

function asRecord(candidate: unknown): Record<string, unknown> | undefined {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  return candidate as Record<string, unknown>;
}

function asNonEmptyString(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  return candidate.trim() ? candidate.trim() : undefined;
}

function asPopQuizQuestionType(candidate: unknown): PopQuizInteraction["questions"][number]["type"] | undefined {
  switch (candidate) {
    case "choice": case "multi": case "true_false": case "short_answer": return candidate;
    default: return undefined;
  }
}

function readOptions(raw: unknown, key: "id" | "value"): AskUserQuestion["options"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    const fields = asRecord(candidate);
    const identifier = asNonEmptyString(fields?.[key]);
    const caption = asNonEmptyString(fields?.label);
    return identifier && caption
      ? [{ id: identifier, label: caption, description: asNonEmptyString(fields?.description) }]
      : [];
  });
}

function normalizeOptions(raw: unknown): AskUserQuestion["options"] { return readOptions(raw, "value"); }
function normalizePublicOptions(raw: unknown): AskUserQuestion["options"] { return readOptions(raw, "id"); }

function publicQuestion(raw: unknown): AskUserQuestion[] {
  const fields = asRecord(raw);
  if (!fields) return [];
  const custom = asRecord(fields.customInput);
  const identifier = asNonEmptyString(fields.id);
  const text = asNonEmptyString(fields.prompt);
  const choices = normalizePublicOptions(fields.options);
  const textOnly = choices.length === 0;
  if (!identifier || !text || typeof custom?.enabled !== "boolean") return [];
  if (!textOnly && choices.length < 2) return [];
  if (textOnly && custom.enabled !== true) return [];
  return [{
    id: identifier, question: text, options: choices,
    allowCustomInput: custom.enabled,
    freeTextPlaceholder: asNonEmptyString(custom.placeholder),
    multiple: fields.multiple === true,
  }];
}

function legacyQuestion(raw: unknown): AskUserQuestion[] {
  const fields = asRecord(raw);
  if (!fields) return [];
  const identifier = asNonEmptyString(fields.field);
  const text = asNonEmptyString(fields.question);
  if (!identifier || !text) return [];
  return [{
    id: identifier, question: text, options: normalizeOptions(fields.options),
    allowCustomInput: fields.allowCustom !== false,
    freeTextPlaceholder: asNonEmptyString(fields.freeTextPlaceholder),
    multiple: fields.type === "multi_select",
  }];
}

export function normalizeChoiceInteraction(value: unknown): AskUserInteraction | undefined {
  const payload = asRecord(value);
  if (!payload) return undefined;
  const interactionKey = asNonEmptyString(payload.interactionId);
  const runKey = asNonEmptyString(payload.runId);
  const version = typeof payload.revision === "number" && Number.isInteger(payload.revision) ? payload.revision : undefined;
  if (interactionKey && runKey && version !== undefined && Array.isArray(payload.questions)) {
    const normalized = payload.questions.flatMap(publicQuestion);
    if (normalized.length !== payload.questions.length || normalized.length === 0) return undefined;
    return {
      kind: "ask", id: interactionKey, runId: runKey, revision: version,
      intro: asNonEmptyString(payload.intro), responseKind: "submission",
      question: normalized[0].question, options: normalized[0].options, questions: normalized,
    };
  }
  const cardKey = asNonEmptyString(payload.id);
  if (!cardKey) return undefined;
  const legacy = Array.isArray(payload.questions) ? payload.questions.flatMap(legacyQuestion) : [];
  if (legacy.length > 0) {
    return {
      kind: "ask", id: cardKey, question: legacy[0].question, options: legacy[0].options,
      questions: legacy, responseKind: "clarification",
    };
  }
  const text = asNonEmptyString(payload.question);
  const choices = normalizeOptions(payload.options);
  if (!text || choices.length === 0) return undefined;
  return { kind: "ask", id: cardKey, question: text, options: choices, allowCustomInput: true, responseKind: "choice" };
}

export function normalizeDeferredPlanChoice(value: unknown, activeSessionId: string): AskUserInteraction | undefined {
  const fields = asRecord(value);
  return asNonEmptyString(fields?.sessionId) === activeSessionId ? normalizeChoiceInteraction(value) : undefined;
}

export function normalizePopQuizCard(value: unknown): PopQuizInteraction | undefined {
  const payload = asRecord(value);
  if (!payload) return undefined;
  const identifier = asNonEmptyString(payload.quizId);
  const runKey = asNonEmptyString(payload.runId);
  if (!identifier || !runKey || !Array.isArray(payload.questions)) return undefined;
  const entries = payload.questions.flatMap((raw) => {
    const fields = asRecord(raw);
    if (!fields) return [];
    const questionKey = asNonEmptyString(fields.id);
    const questionType = asPopQuizQuestionType(fields.type);
    const text = asNonEmptyString(fields.question);
    if (!questionKey || !text || !questionType) return [];
    const choices = Array.isArray(fields.options) ? fields.options.flatMap((rawOption) => {
      const optionFields = asRecord(rawOption);
      const optionKey = asNonEmptyString(optionFields?.id);
      const caption = asNonEmptyString(optionFields?.label);
      return optionKey && caption ? [{ id: optionKey, label: caption }] : [];
    }) : [];
    if ((questionType === "choice" || questionType === "multi") && choices.length < 2) return [];
    return [{
      id: questionKey, type: questionType, question: text, options: choices,
      learningObjective: asNonEmptyString(fields.learningObjective) ?? "",
    }];
  });
  if (entries.length === 0 || entries.length !== payload.questions.length) return undefined;
  return { kind: "quiz", id: identifier, runId: runKey, intro: asNonEmptyString(payload.intro) ?? "", questions: entries };
}

export function createAskDrafts(questions: AskUserQuestion[]): AskDrafts {
  const entries = questions.map((item) => [item.id, { source: null, optionIds: [], customText: "" } satisfies AskQuestionDraft]);
  return Object.fromEntries(entries);
}

export function selectAskOption(drafts: AskDrafts, question: AskUserQuestion, optionId: string): AskDrafts {
  if (!question.options.some((choice) => choice.id === optionId)) return drafts;
  const previous = drafts[question.id] ?? { source: null, optionIds: [], customText: "" };
  let selected: string[];
  if (!question.multiple) selected = [optionId];
  else if (previous.optionIds.includes(optionId)) selected = previous.optionIds.filter((key) => key !== optionId);
  else selected = [...previous.optionIds, optionId];
  return { ...drafts, [question.id]: { source: selected.length > 0 ? "option" : null, optionIds: selected, customText: "" } };
}

export function updateAskCustomText(drafts: AskDrafts, questionId: string, text: string): AskDrafts {
  return { ...drafts, [questionId]: { source: text.trim() ? "custom" : null, optionIds: [], customText: text } };
}

export function isAskComplete(questions: AskUserQuestion[], drafts: AskDrafts): boolean {
  return questions.every((item) => {
    const answer = drafts[item.id];
    return answer?.source === "option" && answer.optionIds.length > 0
      || answer?.source === "custom" && Boolean(answer.customText.trim());
  });
}

export function buildAskSubmission(interaction: AskUserInteraction, drafts: AskDrafts): AskCardSubmission {
  const fields = interaction.questions ?? [];
  if (interaction.responseKind !== "submission" || !interaction.runId || interaction.revision === undefined || !isAskComplete(fields, drafts)) {
    throw new Error("E_ASK_SUBMISSION_INCOMPLETE");
  }
  return {
    interactionId: interaction.id, runId: interaction.runId, revision: interaction.revision,
    answers: fields.map((item) => {
      const answer = drafts[item.id];
      if (answer.source === "custom") return { questionId: item.id, source: "custom" as const, text: answer.customText.trim() };
      if (item.multiple) return { questionId: item.id, source: "option" as const, optionIds: answer.optionIds };
      return { questionId: item.id, source: "option" as const, optionId: answer.optionIds[0] };
    }),
  };
}

export function shouldDismissAsk(interaction: AskUserInteraction, value: unknown): boolean {
  const terminal = asRecord(value);
  if (asNonEmptyString(terminal?.id) !== interaction.id) return false;
  if (!interaction.runId || interaction.revision === undefined) return true;
  return asNonEmptyString(terminal?.runId) === interaction.runId && terminal?.revision === interaction.revision;
}

export function normalizeTaskPlanPresentation(value: unknown): TaskPlanPresentation | undefined {
  const payload = asRecord(value);
  const entries = Array.isArray(payload?.steps) ? payload.steps.flatMap((raw) => {
    const fields = asRecord(raw);
    if (!fields) return [];
    const identifier = asNonEmptyString(fields.stepId);
    const text = asNonEmptyString(fields.objective);
    if (!identifier || !text) return [];
    const state = asNonEmptyString(fields.status);
    const normalized: TaskPlanStep["status"] = state === "running" || state === "completed" || state === "failed" ? state : "pending";
    return [{ id: identifier, title: text, status: normalized }];
  }) : [];
  if (entries.length === 0) return undefined;
  return { title: asNonEmptyString(payload?.goal), steps: entries };
}
