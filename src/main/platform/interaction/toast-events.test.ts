import { afterEach, expect, it, vi } from "vitest";
import { createToastEventBus, toastEvents } from "./toast-events";
afterEach(() => vi.restoreAllMocks());
it.each(["ApprovalPending", "ApprovalSettled", "ChoiceCard", "ChoiceDismiss", "PlanReview", "PlanApproved", "PlanReviewEnded", "QuizPending", "QuizSettled", "SchedulerFinished"] as const)("delivers %s only to its own subscribers and unsubscribes idempotently", name => {
  // The event bus intentionally transports payloads unchanged; producers own their shape.
  const bus = createToastEventBus(), listener = vi.fn(), other = vi.fn(), payload = { id: "event" };
  const subscribe = bus[`on${name}`] as (fn: (event: unknown) => void) => () => void;
  const publish = bus[`publish${name}`] as (event: unknown) => void;
  const off = subscribe(listener); toastEvents.onPlanReview(other)();
  publish(payload); expect(listener).toHaveBeenCalledExactlyOnceWith(payload); expect(other).not.toHaveBeenCalled();
  off(); off(); publish(payload); expect(listener).toHaveBeenCalledOnce();
});
it("uses a snapshot in registration order and isolates listener errors", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const bus = createToastEventBus(), calls: string[] = []; let off = () => {};
  bus.onPlanReview(() => { calls.push("first"); off(); bus.onPlanReview(() => calls.push("late")); throw Error("listener"); });
  off = bus.onPlanReview(() => calls.push("second"));
  bus.publishPlanReview({ sessionId: "s", runId: "r" }); expect(calls).toEqual(["first", "second"]);
  calls.length = 0; bus.publishPlanReview({ sessionId: "s", runId: "r" }); expect(calls).toEqual(["first", "late"]);
});
it("deduplicates repeated subscriptions and keeps bus instances independent", () => {
  const bus = createToastEventBus(), other = createToastEventBus(), listener = vi.fn();
  bus.onPlanReview(listener); bus.onPlanReview(listener); other.publishPlanReview({ sessionId: "s", runId: "r" });
  expect(listener).not.toHaveBeenCalled(); bus.publishPlanReview({ sessionId: "s", runId: "r" }); expect(listener).toHaveBeenCalledOnce();
});
