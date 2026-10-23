import { expect, it, vi } from "vitest";
import { isPluginHostError, type PluginHostError, type PluginTurnStartedEvent, type PluginTurnFinishedEvent,
  type PluginMessagePageInput, type PluginMessagePage, type PluginConversationMessage, type PluginConversationSummary } from "./api";

it("recognizes a real Error carrying a supported host error code", () => {
  const error: PluginHostError = Object.assign(new Error("Requested conversation was removed"), { code: "E_NOT_FOUND" as const });
  expect(isPluginHostError(error)).toEqual(true);
});

it.each([new Error("Unclassified failure"), "E_NOT_FOUND", undefined, Object.assign(new Error("Unsupported code"), { code: "E_UNRECOGNIZED" })])(
  "does not mistake an arbitrary value for a host error: %s", value => {
    expect(isPluginHostError(value)).toEqual(false);
  },
);

function summarize(start: PluginTurnStartedEvent, finish: PluginTurnFinishedEvent) {
  const started = start.source === "desktop" ? `desktop:${start.conversationId}:${start.inputMessageId}`
    : start.source === "channel" ? `channel:${start.channel}:${start.conversationId ?? "none"}`
    : `scheduler:${start.taskId}:${start.schedulerRunId}`;
  const finished = finish.source === "desktop" ? `desktop:${finish.status}:${finish.finalMessageId ?? "unset"}`
    : finish.source === "channel" ? `channel:${finish.status}:${finish.channel}`
    : `scheduler:${finish.status}:${finish.taskId}`;
  return [started, finished];
}
const event = { eventId: "contract-event", timestamp: "2025-06-07T08:09:10Z", runId: "contract-run", mode: "chat" as const };

it("supports discriminated field access for desktop and scheduled turns", () => {
  expect(summarize(
    { ...event, source: "desktop", conversationId: "review-conversation", inputMessageId: "question-boundary" },
    { ...event, source: "scheduler", taskId: "review-task", schedulerRunId: "review-execution", status: "success" },
  )).toStrictEqual(["desktop:review-conversation:question-boundary", "scheduler:success:review-task"]);
});

function readFinishedRange(finished: PluginTurnFinishedEvent, getMessages: (input: PluginMessagePageInput) => Promise<PluginMessagePage>) {
  if (finished.source !== "desktop" || !finished.finalMessageId) return undefined;
  return getMessages({ conversationId: finished.conversationId, fromMessageId: finished.inputMessageId, throughMessageId: finished.finalMessageId });
}

it("uses desktop event boundaries directly as the inclusive message page range", async () => {
  const page: PluginMessagePage = {
    items: [{ id: "question-boundary", role: "user", text: "Review this", at: event.timestamp }] satisfies PluginConversationMessage[],
    range: { fromMessageId: "question-boundary", throughMessageId: "answer-boundary" },
  };
  const getMessages = vi.fn(async (_input: PluginMessagePageInput) => page);
  const result = await readFinishedRange({
    ...event, source: "desktop", conversationId: "review-conversation", inputMessageId: "question-boundary",
    finalMessageId: "answer-boundary", status: "success",
  }, getMessages);
  expect(result?.range).toStrictEqual({ fromMessageId: "question-boundary", throughMessageId: "answer-boundary" });
  expect(getMessages).toHaveBeenCalledWith({ conversationId: "review-conversation", fromMessageId: "question-boundary", throughMessageId: "answer-boundary" });
});

it("keeps the public conversation summary field set stable", () => {
  const summary: PluginConversationSummary = {
    title: "Review", updatedAt: event.timestamp, id: "review-conversation", createdAt: event.timestamp, mode: "chat",
  };
  expect(Object.keys(summary).sort()).toStrictEqual(["createdAt", "id", "mode", "title", "updatedAt"]);
});
