import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestUserClarification, requestUserChoice, registerChoiceIpc, cancelPendingChoicesForRun,
  setChoiceCardSender, setChoiceDismissSender, type ChoiceCardData } from "./user-choice";
import type { AskCardPayload, AskCardSubmission, AskClarificationCard } from "../shared/ask-clarification";

const desktop = vi.hoisted(() => ({ profile: "", handle: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => desktop.profile }, ipcMain: { handle: desktop.handle } }));
desktop.profile = mkdtempSync(join(tmpdir(), "ff-user-answers-"));
afterAll(() => rmSync(desktop.profile, { recursive: true, force: true }));
beforeEach(() => { desktop.handle.mockReset(); vi.useFakeTimers(); });
afterEach(() => {
  for (const run of ["legacy", "garden:opaque", "garden:cancel", "garden:keep", "garden:simple"]) cancelPendingChoicesForRun(run);
  vi.useRealTimers();
});
const inquiry = (text = false): AskClarificationCard => ({
  intro: "Choose how to organize the garden notes.",
  questions: [{ field: "layout", question: "Which layout should the notes use?", type: text ? "text" : "single_select",
    options: text ? [] : [{ value: "garden-private-markdown", label: "Markdown notes" }, { value: "garden-private-plain", label: "Plain notes" }],
    allowCustom: false, freeTextPlaceholder: text ? "Describe the layout" : "" }], deferredFields: [],
});
function handler() {
  registerChoiceIpc();
  return desktop.handle.mock.calls.at(-1)![1] as (event: unknown, payload: unknown) => { ok: boolean };
}
function submission(card: AskCardPayload, custom?: string): AskCardSubmission {
  return { interactionId: card.interactionId, runId: card.runId, revision: card.revision,
    answers: [custom === undefined ? { questionId: card.questions[0].id, source: "option", optionId: card.questions[0].options[0].id }
      : { questionId: card.questions[0].id, source: "custom", text: custom }] };
}
it("round-trips custom structured text through the existing IPC handler", async () => {
  const sent: AskCardPayload[] = [];
  setChoiceCardSender(card => { if ("interactionId" in card) sent.push(card); });
  const pending = requestUserClarification(inquiry(true));
  const card = sent[0];
  handler()({}, { id: card.interactionId, answer: submission(card, "Organize by planting month") });
  await expect(pending).resolves.toEqual({ requestId: card.interactionId, answers: [{ field: "layout", customText: "Organize by planting month" }] });
});
it("uses a run-scoped sender instead of the global card sender", async () => {
  const global = vi.fn(), scoped = vi.fn();
  setChoiceCardSender(global);
  const pending = requestUserClarification(inquiry(), scoped);
  expect(global).not.toHaveBeenCalled();
  expect(scoped).toHaveBeenCalledTimes(1);
  const card = scoped.mock.calls[0][0] as AskCardPayload;
  handler()({}, { id: card.interactionId, answer: submission(card) });
  await expect(pending).resolves.toEqual({ requestId: card.interactionId, answers: [{ field: "layout", selectedValues: ["garden-private-markdown"] }] });
});
it("expires a structured card with an empty answer and exact settlement identity", async () => {
  const send = vi.fn(), settle = vi.fn();
  const pending = requestUserClarification({ intro: "Waiting for garden details", questions: [], deferredFields: [] }, send, settle);
  const card = send.mock.calls[0][0] as AskCardPayload;
  await vi.advanceTimersByTimeAsync(120000);
  await expect(pending).resolves.toEqual({ requestId: card.interactionId, answers: [] });
  expect(settle).toHaveBeenCalledWith({ id: card.interactionId, runId: card.runId, revision: card.revision, reason: "timeout" });
});
it("publishes opaque option ids, refuses stale and duplicate answers, and settles the current answer once", async () => {
  const send = vi.fn(), settle = vi.fn();
  const pending = requestUserClarification(inquiry(), send, settle, { runId: "garden:opaque", revision: 7 });
  const card = send.mock.calls[0][0] as AskCardPayload;
  expect(card).toMatchObject({ interactionId: expect.any(String), runId: "garden:opaque", revision: 7 });
  expect(JSON.stringify(card)).not.toContain("garden-private-markdown");
  const answer = submission(card), resolve = handler();
  expect(resolve({}, { id: card.interactionId, answer: { ...answer, revision: 6 } })).toEqual({ ok: false });
  expect(resolve({}, { id: card.interactionId, answer })).toEqual({ ok: true });
  expect(resolve({}, { id: card.interactionId, answer })).toEqual({ ok: false });
  await expect(pending).resolves.toEqual({ requestId: card.interactionId, answers: [{ field: "layout", selectedValues: ["garden-private-markdown"] }] });
  expect(settle).toHaveBeenCalledExactlyOnceWith({ id: card.interactionId, runId: "garden:opaque", revision: 7, reason: "answered" });
});
it("rejects a cancelled structured card exactly once even after its timeout passes", async () => {
  const send = vi.fn(), settle = vi.fn();
  const pending = requestUserClarification(inquiry(), send, settle, { runId: "garden:cancel", revision: 4 });
  const outcome = pending.then(value => ({ resolved: value }), error => ({ status: "rejected", name: error.name }));
  cancelPendingChoicesForRun("garden:cancel");
  expect(await outcome).toEqual({ status: "rejected", name: "AbortError" });
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ runId: "garden:cancel", reason: "cancelled" }));
  await vi.advanceTimersByTimeAsync(120000);
  expect(settle).toHaveBeenCalledTimes(1);
});
it("cancels only the matching structured run and leaves its sibling unresolved", async () => {
  const firstSettled = vi.fn(), otherSettled = vi.fn();
  let sibling: unknown;
  const first = requestUserClarification(inquiry(), vi.fn(), firstSettled, { runId: "garden:cancel", revision: 4 })
    .then(value => ({ resolved: value }), error => ({ status: "rejected", name: error.name }));
  const second = requestUserClarification(inquiry(), vi.fn(), otherSettled, { runId: "garden:keep", revision: 4 })
    .then(value => { sibling = value; }, error => { sibling = error; });
  cancelPendingChoicesForRun("garden:cancel");
  expect(await first).toEqual({ status: "rejected", name: "AbortError" });
  expect(firstSettled).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
  expect(sibling).toBeUndefined();
  expect(otherSettled).not.toHaveBeenCalled();
  cancelPendingChoicesForRun("garden:keep");
  await second;
});
const choices = [{ label: "Water now", value: "water" }, { label: "Wait", value: "wait" }];
function simpleCards() {
  const cards: Array<{ id: string }> = [], dismiss = vi.fn();
  setChoiceCardSender((card: ChoiceCardData) => { if ("id" in card) cards.push(card); });
  setChoiceDismissSender(dismiss);
  return { cards, dismiss, resolve: handler() };
}
it("dismisses cancelled legacy cards and refuses later clicks", async () => {
  const h = simpleCards(), pending = requestUserChoice("Water the garden?", choices, "wait", { runId: "garden:simple" });
  const outcome = pending.then(() => "answered", error => error.name);
  expect(h.cards).toHaveLength(1);
  cancelPendingChoicesForRun("garden:simple");
  await expect(outcome).resolves.toBe("AbortError");
  expect(h.dismiss).toHaveBeenCalledWith(expect.objectContaining({ id: h.cards[0].id, reason: "cancelled" }));
  expect(h.resolve({}, { id: h.cards[0].id, value: "water" })).toEqual({ ok: false });
});
it("cancels on a signal and rejects an already-aborted signal without publishing another card", async () => {
  const h = simpleCards(), controller = new AbortController();
  const pending = requestUserChoice("Water the garden?", choices, "wait", { runId: "garden:simple", signal: controller.signal });
  const outcome = pending.then(() => "answered", error => error.name);
  controller.abort();
  await expect(outcome).resolves.toBe("AbortError");
  expect(h.dismiss).toHaveBeenCalledWith(expect.objectContaining({ id: h.cards[0].id, reason: "cancelled" }));
  expect(h.resolve({}, { id: h.cards[0].id, value: "water" })).toEqual({ ok: false });
  const count = h.cards.length;
  await expect(requestUserChoice("Water the garden?", choices, "wait", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(h.cards).toHaveLength(count);
});
it("resolves a valid legacy answer before later cancellation and signal abortion", async () => {
  const h = simpleCards(), controller = new AbortController();
  const pending = requestUserChoice("Water the garden?", choices, "wait", { runId: "garden:simple", signal: controller.signal });
  expect(h.resolve({}, { id: h.cards[0].id, value: "water" })).toEqual({ ok: true });
  await expect(pending).resolves.toBe("water");
  cancelPendingChoicesForRun("garden:simple");
  controller.abort();
});
