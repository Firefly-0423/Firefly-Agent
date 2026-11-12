import { describe, it, expect } from "vitest";
import type { AskClarificationOutput, AskClarificationCard } from "../../shared/ask-clarification";
import { buildAskCard, publishAskCard, resolveAskCardSubmission, validateAskUserAnswer } from "./ask-card";

const identity = { interactionId: "agenda-choice", runId: "agenda-run", revision: 3 };
const choices = [{ value: "ical", label: "Calendar file" }, { value: "html", label: "Web page" }, { value: "plain", label: "Plain text" }, { value: "csv", label: "Spreadsheet" }];
function draft(allowCustom = true): AskClarificationOutput {
  return { intro: "Choose an agenda export.", questions: [{ field: "encoding", question: "Which export do you need?", type: "single_select", options: choices, allowCustom, freeTextPlaceholder: "Enter another encoding" }], deferredFields: [] };
}
const publish = (allowCustom = true, mode: AskClarificationCard["mode"] = "semantic_clarification") => publishAskCard(buildAskCard(draft(allowCustom), mode), identity);

describe("Clarification cards crossing the renderer boundary", () => {
  it("limits visible suggestions to three and permits suggestion-free text input", () => {
    const card = buildAskCard(draft());
    expect(card.questions[0].options).toStrictEqual(choices.slice(0, 3));
    expect(card.questions[0].allowCustom).toEqual(true);
    const text = draft();
    text.questions[0] = { ...text.questions[0], type: "text", options: [] };
    expect(buildAskCard(text).questions[0]).toMatchObject({ type: "text", options: [] });
    text.questions[0] = { ...text.questions[0], type: "single_select", allowCustom: false, options: [choices[0]] };
    expect(() => buildAskCard(text)).toThrow("E_ASK_OPTIONS_INSUFFICIENT");
  });

  it("publishes the full public payload using option identities instead of canonical values", () => {
    const publication = publish(false);
    expect(publication.payload).toStrictEqual({
      ...identity, mode: "semantic_clarification", intro: "Choose an agenda export.",
      questions: [{ id: "question-1", prompt: "Which export do you need?", multiple: false, required: true,
        options: [{ id: "question-1-option-1", label: "Calendar file" }, { id: "question-1-option-2", label: "Web page" }, { id: "question-1-option-3", label: "Plain text" }],
        customInput: { enabled: false, placeholder: "Enter another encoding" },
      }],
    });
    expect(JSON.stringify(publication.payload)).not.toContain("ical");
    const parameters = publish(true, "action_parameters");
    expect(parameters.payload.mode).toEqual("action_parameters");
    for (const privateField of ["write_document", "argumentPath", "ical"]) expect(JSON.stringify(parameters.payload)).not.toContain(privateField);
  });

  it("maps selected opaque IDs and trims exclusive custom responses", () => {
    const publication = publish();
    expect(resolveAskCardSubmission(publication, { ...identity, answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-2" }] })).toStrictEqual({
      requestId: identity.interactionId, answers: [{ field: "encoding", selectedValues: ["html"] }],
    });
    expect(resolveAskCardSubmission(publication, { ...identity, answers: [{ questionId: "question-1", source: "custom", text: "  JSON  " }] })).toStrictEqual({
      requestId: identity.interactionId, answers: [{ field: "encoding", customText: "JSON" }],
    });
    expect(() => resolveAskCardSubmission(publication, { ...identity, answers: [{ questionId: "question-1", source: "option", optionId: "fabricated-choice" }] })).toThrow("E_ASK_ANSWER_INVALID");
    expect(() => validateAskUserAnswer(buildAskCard(draft()), identity.interactionId, { requestId: "fabricated", answers: [{ field: "encoding", selectedValues: ["executable"] }] })).toThrow("E_ASK_ANSWER_INVALID");
  });

  it("respects mixed question types and returns their ordered canonical answers", () => {
    const card: AskClarificationCard = { mode: "semantic_clarification", intro: "Configure the handout.", deferredFields: [], questions: [
      { ...draft().questions[0], options: choices.slice(0, 2) },
      { field: "days", question: "Include which days?", type: "multi_select", options: [{ value: "weekday", label: "Weekdays" }, { value: "weekend", label: "Weekend" }], allowCustom: true, freeTextPlaceholder: "Other days" },
      { field: "instructions", question: "Any other requirements?", type: "text", options: [], allowCustom: true, freeTextPlaceholder: "Add instructions" },
    ] };
    const publication = publishAskCard(card, identity);
    expect(publication.payload.questions).toMatchObject([
      { multiple: false, customInput: { enabled: true } }, { multiple: true, customInput: { enabled: true } }, { multiple: false, options: [], customInput: { enabled: true } },
    ]);
    expect(resolveAskCardSubmission(publication, { ...identity, answers: [
      { questionId: "question-1", source: "option", optionId: "question-1-option-1" },
      { questionId: "question-2", source: "option", optionIds: ["question-2-option-1", "question-2-option-2"] },
      { questionId: "question-3", source: "custom", text: "Cancel this export" },
    ] })).toStrictEqual({ requestId: identity.interactionId, answers: [
      { field: "encoding", selectedValues: ["ical"] }, { field: "days", selectedValues: ["weekday", "weekend"] }, { field: "instructions", customText: "Cancel this export" },
    ] });
  });

  it("rejects free text when the runtime issued a fixed-choice question", () => {
    const publication = publish(false);
    expect(publication.payload.questions[0].customInput.enabled).toEqual(false);
    expect(() => resolveAskCardSubmission(publication, { ...identity, answers: [{ questionId: "question-1", source: "custom", text: "Proceed anyway" }] })).toThrow("E_ASK_ANSWER_INVALID");
  });
});
