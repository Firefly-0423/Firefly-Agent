import { expect, it, vi } from "vitest";
import type { SettingsApprovalApi } from "./chat-page-bridge";
import { observePermissionEvents, observeQuizEvents } from "./interaction-events";

it("routes requests, retains submitted quizzes, and removes settled cards", () => {
  const handlers: Record<string, (value: never) => void> = {};
  const off = Array.from({ length: 4 }, () => vi.fn());
  const names = ["onPermissionApprovalRequest", "onPermissionApprovalSettled", "onPopQuizRequest", "onPopQuizSettled"] as const;
  const api = Object.fromEntries(names.map((name, i) => [name, (fn: (value: never) => void) => { handlers[name] = fn; return off[i]; }])) as unknown as SettingsApprovalApi;
  const deliver = vi.fn(); const remove = vi.fn();
  const stopPermission = observePermissionEvents(api, { deliver, remove });
  const stopQuiz = observeQuizEvents(api, { deliver, remove });
  handlers.onPermissionApprovalRequest({ id: "p", runId: "r", args: {}, risk: "safe", toolId: "t", toolName: "T", toolDescription: "" } as never);
  expect(deliver).toHaveBeenCalledWith("r", expect.any(Function), "waiting_permission");
  handlers.onPopQuizRequest({ quizId: "q", runId: "r", questions: [] } as never);
  expect(deliver).toHaveBeenCalledTimes(1);
  handlers.onPopQuizSettled({ quizId: "q", reason: "submitted" } as never);
  expect(remove).not.toHaveBeenCalled();
  handlers.onPopQuizSettled({ quizId: "q", reason: "cancelled" } as never);
  handlers.onPermissionApprovalSettled({ id: "p", reason: "cancelled" } as never);
  expect(remove.mock.calls).toEqual([["quiz", "q"], ["permission", "p"]]);
  stopPermission(); stopQuiz();
  off.forEach(fn => expect(fn).toHaveBeenCalledOnce());
});
