import { afterEach, expect, test } from "vitest";
import type { ChatMessage, ChatSession } from "../../../../../shared/chat-types";
import type { RunStatusItem } from "../../../../../shared/run-status";
import { setUiLocale, t } from "../../../i18n";
import { toUiMessages } from "./chat-page-normalizers";

afterEach(() => setUiLocale("zh-CN"));

const checkpoint: ChatMessage = { id: "a", role: "model", at: 1, content: "partial",
  runSnapshot: { runId: "r", status: "waiting_user", updatedAt: 10 },
  toolExecutions: [{ id: "t", name: "ask_user", status: "running" }],
  agentRounds: [{ id: "round", status: "running", startedAt: 1 }] };
const session: ChatSession = { schemaVersion: 1, id: "s", identityId: null, mode: "work", title: "test", createdAt: 1, updatedAt: 1,
  messages: [{ id: "u", role: "user", at: 0, content: "task" }, checkpoint] };
const status = (phase: "running" | "settling" | "interrupted"): RunStatusItem => ({ sessionId: "s", assistantTurnId: "a", runId: "r", seq: 1, phase });

test.each(["running", "settling"] as const)("%s preserves active tool and round before interrupted projection", phase => {
  const [, view] = toUiMessages(session, [status(phase)]);
  expect(view.content).toBe("partial");
  expect(view.toolExecutions).toEqual(checkpoint.toolExecutions);
  expect(view.agentRounds).toEqual(checkpoint.agentRounds);
  expect(view.loading).toBe(true);
  expect(view.runStage).toEqual({ kind: "executing", detail: t(phase === "settling" ? "runPresentation.observedSettling" : "runPresentation.observedRunning") });
});

test("confirmed interruption settles #100 activity; unavailable and legacy records preserve evidence", () => {
  const [, stopped] = toUiMessages(session, [status("interrupted")]);
  expect(stopped.toolExecutions?.[0].status).toBe("error");
  expect(stopped.agentRounds?.[0].status).toBe("completed");
  for (const statuses of [[], [{ assistantTurnId: "a", phase: "unavailable" } as const]]) {
    const [, unknown] = toUiMessages(session, statuses);
    expect(unknown.toolExecutions).toEqual(checkpoint.toolExecutions);
    expect(unknown.agentRounds).toEqual(checkpoint.agentRounds);
    expect(unknown.content).toBe("partial");
  }
});

test.each(["success", "cancelled", "timeout", "runtime_error"] as const)("finished %s replaces exactly its assistant row including tools, rounds and insertion ownership", terminalStatus => {
  const final: ChatMessage = { ...checkpoint, content: "final", toolExecutions: [{ id: "t", name: "ask_user", status: "success", result: "answered" }],
    agentRounds: [{ id: "round", status: "completed", startedAt: 1, completedAt: 20 }],
    runSnapshot: { runId: "r", status: "terminal", terminalStatus, updatedAt: 20 } };
  const insertion: ChatMessage = { id: "i", role: "user", at: 5, content: "also check",
    runInsertion: { version: 1, assistantTurnId: "a", runId: "r", sequence: 1, revision: 1, delivery: { round: 1, order: 1 } } };
  const result = toUiMessages({ ...session, messages: [...session.messages, insertion] },
    [{ ...status("running"), phase: "finished", message: final }]);
  expect(result.map(row => [row.id, row.content])).toEqual([["u", "task"], ["a", "final"], ["i", "also check"]]);
  expect(result[1].toolExecutions).toEqual(final.toolExecutions);
  expect(result[1].agentRounds).toEqual(final.agentRounds);
  expect(result[2].runInsertion).toEqual(insertion.runInsertion);
  expect(result[1].runStage?.kind).toBe(terminalStatus === "success" ? "completed" : terminalStatus === "runtime_error" ? "failed" : terminalStatus);
});

test.each(["en", "zh-CN"])("%s uses localized recovery hints and unknown status only marks an incomplete checkpoint", locale => {
  setUiLocale(locale);
  const [, view] = toUiMessages(session, [{ assistantTurnId: "a", phase: "unavailable" }]);
  expect(view.loading).toBe(false);
  expect(view.runStatusNotice).toBe(t("runPresentation.observedUnavailable"));
  expect(view.toolExecutions).toEqual(checkpoint.toolExecutions);
  expect(view.agentRounds).toEqual(checkpoint.agentRounds);
  const [, live] = toUiMessages(session, [status("settling")]);
  expect(live.runStage?.detail).toBe(locale === "en" ? "Finishing up" : "正在收尾");
  const [legacy] = toUiMessages({ ...session, messages: [{ id: "old", role: "model", at: 1, content: "old answer" }] },
    [{ assistantTurnId: "old", phase: "unavailable" }]);
  expect(legacy.runStatusNotice).toBeUndefined();
});

test("finished hydration preserves canonical settlement metadata from the latest saved assistant row", () => {
  const sSettlement: NonNullable<ChatMessage["sSettlement"]> = {
    state: "success", runId: "r", assistantEntryId: "entry-a", originalText: "canonical answer",
  };
  const saved = { ...session, messages: [{ ...checkpoint, sSettlement }] };
  const [view] = toUiMessages(saved, [{ ...status("running"), phase: "finished", message: {
    ...checkpoint, content: "terminal snapshot", runSnapshot: { runId: "r", status: "terminal", terminalStatus: "success", updatedAt: 20 },
  } }]);
  expect(view.sSettlement).toEqual(sSettlement);
  expect(view.content).toBe("canonical answer");
  expect(view.loading).toBe(false);
});
