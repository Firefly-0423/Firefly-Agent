import { expect, test, vi } from "vitest";
import { Live2DRendererLifecycleTracker } from "./lifecycle-diagnostics";

test("reports registrations in order and disposes each registration once", () => {
  const tracker = new Live2DRendererLifecycleTracker();
  const detach = vi.fn(), unsubscribe = vi.fn(), release = vi.fn();
  const stop = tracker.track("listener", "canvas:pointerup", detach);
  tracker.track("subscription", "speech:ended", unsubscribe);
  expect(tracker.getDiagnostics()).toStrictEqual({ labels: ["canvas:pointerup", "speech:ended"],
    activeDisposers: 2, listenerCount: 1, subscriptionCount: 1, resourceCount: 0 });
  stop();
  stop();
  expect(detach.mock.calls).toStrictEqual([[]]);
  expect(tracker.getDiagnostics()).toStrictEqual({ labels: ["speech:ended"],
    activeDisposers: 1, listenerCount: 0, subscriptionCount: 1, resourceCount: 0 });
  tracker.track("resource", "texture:atlas", release);
  tracker.disposeAll();
  tracker.disposeAll();
  expect(unsubscribe.mock.calls).toStrictEqual([[]]);
  expect(release.mock.calls).toStrictEqual([[]]);
  expect(tracker.getDiagnostics()).toStrictEqual({ labels: [], activeDisposers: 0,
    listenerCount: 0, subscriptionCount: 0, resourceCount: 0 });
});
