import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createToastService, type ToastServiceDeps } from "./toast-service";
import { createToastEventBus } from "./toast-events";
import { TOAST_NOTIFY_TIMEOUT_MS, TOAST_SOUND_MERGE_MS } from "./types";
import type { IpcScope } from "../application/ipc-scope";
import type { ToastPushPayload } from "../../shared/toast-types";

function notificationDesk(options: Partial<ToastServiceDeps> = {}) {
  const events = createToastEventBus();
  const send = vi.fn();
  const activate = vi.fn();
  const resize = vi.fn();
  const visible = vi.fn();
  const routes = new Map<string, (...args: any[]) => unknown>();
  const listeners = new Map<string, (...args: any[]) => void>();
  const ipc: IpcScope = {
    handle: (channel, callback) => { routes.set(channel, callback); },
    on: (channel, callback) => { listeners.set(channel, callback); },
    dispose: vi.fn(), removeHandler: vi.fn(),
  };
  let serial = 130;
  const service = createToastService({
    bus: events, activate, newId: () => `notice-${++serial}`,
    window: { send, updateHeight: resize, syncVisibility: visible, owns: (sender) => sender.id === 106,
      preload: vi.fn(), dispose: vi.fn(), isVisible: () => false },
    ...options,
  });
  service.registerIpc(ipc);
  return { events, service, send, activate, resize,
    report: (channel: string, payload: unknown, sender = 106) => listeners.get(channel)!({ sender: { id: sender } }, payload),
    all: () => routes.get("toast:get-all")!(),
    sounds: () => send.mock.calls.filter(([channel]) => channel === "toast:push").map(([, data]) => (data as ToastPushPayload).sound),
  };
}

const approval = { id: "permission-93", toolId: "file_editor", toolName: "Edit workspace file" };
const review = { sessionId: "conversation-78", runId: "plan-run-54" };
const question = { cardId: "question-64", runId: review.runId, revision: 1, intro: "Choose an output directory" };
const job = { schedulerRunId: "scheduled-run-39", taskId: "job-83", taskTitle: "Workspace digest", status: "success", outputPreview: "Digest ready" };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(9000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Toast renderer messages", () => {
  it("returns visible entries and forwards owned height reports", () => {
    const desk = notificationDesk();
    desk.events.publishApprovalPending(approval);
    expect(desk.all()).toEqual(desk.service.getActiveToasts());
    expect(desk.all()).toHaveLength(1);
    desk.report("toast:resize", 146);
    expect(desk.resize).toHaveBeenCalledExactlyOnceWith(146);
    expect(desk.sounds()).toEqual([true]);
  });

  it("uses the stored session target on a review click and retains replay protection", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.report("toast:clicked", desk.service.getActiveToasts()[0].id);
    expect(desk.activate).toHaveBeenCalledExactlyOnceWith({ sessionId: review.sessionId, kind: "chat" });
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(true);
    expect(desk.service.getActiveToasts()).toEqual([]);
  });

  it("opens chat without a session target for an approval click", () => {
    const desk = notificationDesk();
    desk.events.publishApprovalPending(approval);
    desk.report("toast:clicked", desk.service.getActiveToasts()[0].id);
    expect(desk.activate).toHaveBeenCalledExactlyOnceWith({ kind: "chat" });
  });

  it.each(["toast:clicked", "toast:dismissed", "toast:resize"])("ignores %s from an unrelated renderer", (channel) => {
    const desk = notificationDesk();
    desk.events.publishApprovalPending(approval);
    const item = desk.service.getActiveToasts()[0];
    desk.report(channel, channel === "toast:resize" ? 146 : item.id, 907);
    expect(desk.activate).not.toHaveBeenCalled();
    expect(desk.resize).not.toHaveBeenCalled();
    expect(desk.service.getActiveToasts()).toEqual([item]);
  });
});

describe("Action notification lifetimes", () => {
  it("deduplicates approval replay both before and after visual dismissal", () => {
    const desk = notificationDesk();
    desk.events.publishApprovalPending(approval);
    desk.events.publishApprovalPending(approval);
    expect(desk.service.getActiveToasts()).toHaveLength(1);
    const item = desk.service.getActiveToasts()[0];
    expect(item).toMatchObject({ tier: "action-pending", kind: "approval", sourceId: approval.id });
    desk.report("toast:dismissed", item.id);
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("approval", approval.id)).toEqual(true);
    desk.events.publishApprovalPending(approval);
    expect(desk.service.getActiveToasts()).toEqual([]);
  });

  it("settles a visible approval synchronously and permits another pending cycle", () => {
    const desk = notificationDesk();
    desk.events.publishApprovalPending(approval);
    const id = desk.service.getActiveToasts()[0].id;
    desk.events.publishApprovalSettled({ id: approval.id, reason: "answered" });
    expect(desk.service.hasPendingSeen("approval", approval.id)).toEqual(false);
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.send).toHaveBeenCalledWith("toast:remove", id);
    desk.events.publishApprovalPending(approval);
    expect(desk.service.getActiveToasts()).toHaveLength(1);
  });

  it("shows and settles a normal choice independently of plan review", () => {
    const desk = notificationDesk();
    desk.events.publishChoiceCard(question);
    expect(desk.service.getActiveToasts()).toHaveLength(1);
    expect(desk.service.getActiveToasts()[0]).toMatchObject({ sourceId: question.cardId, kind: "ask-choice" });
    desk.events.publishChoiceDismiss({ ...question, reason: "answered" });
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("ask-choice", question.cardId)).toEqual(false);
  });

  it("removes both quiz visibility and replay memory when the quiz settles", () => {
    const desk = notificationDesk();
    const quiz = { quizId: "quiz-92", runId: "quiz-run-88" };
    desk.events.publishQuizPending({ ...quiz, firstQuestion: "What does an event loop do?" });
    expect(desk.service.getActiveToasts()[0]).toMatchObject({ sourceId: quiz.quizId, kind: "pop-quiz" });
    desk.events.publishQuizSettled({ ...quiz, reason: "submitted" });
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("pop-quiz", quiz.quizId)).toEqual(false);
  });
});

describe("Plan review classification and settlement", () => {
  it("represents review and its choice card with a single plan item", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.events.publishChoiceCard(question);
    expect(desk.service.getActiveToasts()).toHaveLength(1);
    expect(desk.service.getActiveToasts()[0]).toMatchObject({ sourceId: review.runId, kind: "plan-review" });
  });

  it("keeps replay memory through the supplemental card and clears it after revision two", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.events.publishChoiceDismiss({ ...question, reason: "answered" });
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(true);
    const supplement = { ...question, cardId: "followup-96", revision: 2 };
    desk.events.publishChoiceCard(supplement);
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(true);
    desk.events.publishChoiceDismiss({ ...supplement, reason: "timeout" });
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(false);
    desk.events.publishPlanReview(review);
    expect(desk.service.getActiveToasts()).toHaveLength(1);
  });

  it("clears a review immediately when the plan is approved", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.events.publishPlanApproved(review);
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(false);
    expect(desk.service.getActiveToasts()).toEqual([]);
  });

  it("ends a cancelled first revision and tolerates a repeated end event", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.events.publishChoiceDismiss({ ...question, reason: "cancelled" });
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(false);
    expect(() => desk.events.publishPlanReviewEnded(review)).not.toThrow();
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(false);
  });

  it("releases plan classification after the flow ends without a supplemental card", () => {
    const desk = notificationDesk();
    desk.events.publishPlanReview(review);
    desk.events.publishChoiceDismiss({ ...question, reason: "timeout" });
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(true);
    desk.events.publishPlanReviewEnded(review);
    expect(desk.service.hasPendingSeen("plan-review", review.runId)).toEqual(false);
    expect(desk.service.getActiveToasts()).toEqual([]);
    desk.events.publishChoiceCard({ ...question, cardId: "later-choice-97" });
    expect(desk.service.getActiveToasts()[0]).toMatchObject({ sourceId: "later-choice-97", kind: "ask-choice" });
  });
});

describe("Scheduled completion notices", () => {
  it("expires at the notify deadline and never enters the action replay set", () => {
    const desk = notificationDesk();
    desk.events.publishSchedulerFinished(job);
    const item = desk.service.getActiveToasts()[0];
    expect(item).toMatchObject({ tier: "notify", sourceId: job.schedulerRunId, kind: "task-finished" });
    expect(desk.service.hasPendingSeen("task-finished", job.schedulerRunId)).toEqual(false);
    vi.advanceTimersByTime(TOAST_NOTIFY_TIMEOUT_MS - 1);
    expect(desk.service.getActiveToasts()).toEqual([item]);
    vi.advanceTimersByTime(1);
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.send).toHaveBeenCalledWith("toast:remove", item.id);
  });

  it("does not display unsuccessful jobs", () => {
    const desk = notificationDesk();
    desk.events.publishSchedulerFinished({ ...job, status: "runtime_error" });
    expect(desk.service.getActiveToasts()).toEqual([]);
  });

  it("drops a focused completion without leaving state behind", () => {
    const desk = notificationDesk({ shouldSuppressNotify: () => true });
    desk.events.publishSchedulerFinished(job);
    expect(desk.service.getActiveToasts()).toEqual([]);
    expect(desk.service.hasPendingSeen("task-finished", job.schedulerRunId)).toEqual(false);
  });

  it.each(["toast:dismissed", "toast:clicked"])("finishes a notice immediately after %s", (channel) => {
    const desk = notificationDesk();
    desk.events.publishSchedulerFinished(job);
    desk.report(channel, desk.service.getActiveToasts()[0].id);
    if (channel === "toast:clicked") expect(desk.activate).toHaveBeenCalledExactlyOnceWith({ kind: "chat" });
    expect(desk.service.getActiveToasts()).toEqual([]);
    vi.advanceTimersByTime(TOAST_NOTIFY_TIMEOUT_MS * 2);
    expect(desk.service.getActiveToasts()).toEqual([]);
  });
});

describe("Toast sound policy", () => {
  it("merges consecutive action sounds within the same instant", () => {
    const desk = notificationDesk({ now: () => 9000 });
    desk.events.publishApprovalPending(approval);
    desk.events.publishApprovalPending({ ...approval, id: "permission-94" });
    expect(desk.sounds()).toEqual([true, false]);
  });

  it.each([true, false])("gives action sounds priority when notify comes first: %s", (notifyFirst) => {
    let stamp = 9000;
    const desk = notificationDesk({ now: () => stamp });
    const action = () => desk.events.publishApprovalPending(approval);
    const notify = () => desk.events.publishSchedulerFinished(job);
    (notifyFirst ? notify : action)();
    stamp += TOAST_SOUND_MERGE_MS - 1;
    (notifyFirst ? action : notify)();
    expect(desk.sounds()).toEqual([true, notifyFirst]);
  });

  it("respects the global sound setting", () => {
    const desk = notificationDesk({ isSoundEnabled: () => false });
    desk.events.publishApprovalPending(approval);
    expect(desk.sounds()).toEqual([false]);
  });
});
