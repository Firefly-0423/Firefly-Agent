import type { AskCardPayload, AskCardSubmission, AskClarificationCard, AskClarificationOutput, AskUserAnswer } from "../../shared/ask-clarification";

function invalidAnswer(): never { throw new Error("E_ASK_ANSWER_INVALID"); }
interface PublishedQuestion {
  allowCustom: boolean;
  options: Map<string, string>;
  type: AskClarificationCard["questions"][number]["type"];
  field: string;
}
export interface AskCardPublication {
  privateQuestions: Map<string, PublishedQuestion>;
  payload: AskCardPayload;
}

export function buildAskCard(output: AskClarificationOutput, mode: AskClarificationCard["mode"] = "semantic_clarification"): AskClarificationCard {
  return {
    mode,
    intro: output.intro,
    questions: output.questions.slice(0, 3).map((entry) => {
      const usable = entry.options.filter((choice) => choice.value !== "__custom__").slice(0, 3);
      if (entry.type !== "text" && usable.length < 2) throw new Error("E_ASK_OPTIONS_INSUFFICIENT");
      return { ...entry, options: usable, allowCustom: entry.allowCustom };
    }),
    deferredFields: output.deferredFields,
  };
}

export function publishAskCard(card: AskClarificationCard, identity: Pick<AskCardPayload, "interactionId" | "runId" | "revision">): AskCardPublication {
  const privateQuestions = new Map<string, PublishedQuestion>();
  const publicQuestions = card.questions.map((entry, position) => {
    const questionKey = `question-${position + 1}`;
    const choices = entry.options.filter((choice) => choice.value !== "__custom__");
    const values = new Map<string, string>();
    const publicChoices = choices.map((choice, ordinal) => {
      const key = `${questionKey}-option-${ordinal + 1}`;
      values.set(key, choice.value);
      return { id: key, label: choice.label, ...(choice.description ? { description: choice.description } : {}) };
    });
    const custom = entry.type === "text" || entry.allowCustom;
    privateQuestions.set(questionKey, { field: entry.field, type: entry.type, options: values, allowCustom: custom });
    return {
      id: questionKey,
      prompt: entry.question,
      multiple: entry.type === "multi_select",
      required: true as const,
      options: publicChoices,
      customInput: { enabled: custom, ...(entry.freeTextPlaceholder ? { placeholder: entry.freeTextPlaceholder } : {}) },
    };
  });
  return {
    payload: { ...identity, mode: card.mode ?? "semantic_clarification", intro: card.intro, questions: publicQuestions },
    privateQuestions,
  };
}

export function resolveAskCardSubmission(publication: AskCardPublication, submission: AskCardSubmission): AskUserAnswer {
  const published = publication.payload;
  if (submission.interactionId !== published.interactionId || submission.runId !== published.runId
    || submission.revision !== published.revision || !Array.isArray(submission.answers)
    || submission.answers.length !== published.questions.length) invalidAnswer();
  const visited = new Set<string>();
  const resolved = submission.answers.map((response) => {
    if (!response || visited.has(response.questionId)) invalidAnswer();
    visited.add(response.questionId);
    const definition = publication.privateQuestions.get(response.questionId);
    if (!definition) invalidAnswer();
    if (response.source === "custom") {
      if ("optionId" in response || "optionIds" in response) invalidAnswer();
      const text = response.text?.trim();
      if (!definition.allowCustom || !text) invalidAnswer();
      return { field: definition.field, customText: text };
    }
    if (response.source !== "option" || "text" in response) invalidAnswer();
    const ids = response.optionIds ?? (response.optionId ? [response.optionId] : []);
    if (ids.length === 0 || (!definition.type.startsWith("multi") && ids.length !== 1)) invalidAnswer();
    const decoded = ids.map((key) => definition.options.get(key));
    if (decoded.some((value) => value === undefined)) invalidAnswer();
    const selected = decoded as string[];
    if (definition.type === "text") return { field: definition.field, customText: selected[0] };
    return { field: definition.field, selectedValues: selected };
  });
  return { requestId: published.interactionId, answers: resolved };
}

export function validateAskUserAnswer(card: AskClarificationCard, requestId: string, answer: AskUserAnswer): AskUserAnswer {
  if (!answer || !Array.isArray(answer.answers)) invalidAnswer();
  const definitions = new Map(card.questions.map((entry) => [entry.field, entry]));
  const visited = new Set<string>();
  const resolved = answer.answers.map((response) => {
    if (!response || typeof response.field !== "string" || visited.has(response.field)) invalidAnswer();
    const definition = definitions.get(response.field);
    if (!definition) invalidAnswer();
    visited.add(response.field);
    const typed = response.customText?.trim();
    const selected = response.selectedValues?.filter((value) => value !== "__custom__");
    if (definition.type === "text") {
      if (!definition.allowCustom || !typed) invalidAnswer();
      return { field: response.field, customText: typed };
    }
    const permitted = new Set(definition.options.filter((choice) => choice.value !== "__custom__").map((choice) => choice.value));
    if (selected?.some((value) => !permitted.has(value))) invalidAnswer();
    if (definition.type === "single_select" && (selected?.length ?? 0) > 1) invalidAnswer();
    if (typed && !definition.allowCustom) invalidAnswer();
    if ((!selected || selected.length === 0) && !typed) invalidAnswer();
    return { field: response.field, ...(selected?.length ? { selectedValues: selected } : {}), ...(typed ? { customText: typed } : {}) };
  });
  if (resolved.length !== card.questions.length) invalidAnswer();
  return { requestId, answers: resolved };
}
