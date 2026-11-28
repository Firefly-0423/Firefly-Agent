import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLive2dWorkRunTracker,
  getActiveLive2dWorkRunCount,
  setLive2dWorkSignalSender,
} from "./live2d-work-signal";

describe("live2d work signal", () => {
  afterEach(() => {
    setLive2dWorkSignalSender(null);
  });

  it("sends true when the first run starts its first tool call and false when it finishes", () => {
    const send = vi.fn();
    setLive2dWorkSignalSender(send);
    const run = createLive2dWorkRunTracker();
    run.markToolStarted();
    expect(send.mock.calls).toEqual([[true]]);
    expect(getActiveLive2dWorkRunCount()).toBe(1);
    run.finish();
    expect(send.mock.calls).toEqual([[true], [false]]);
    expect(getActiveLive2dWorkRunCount()).toBe(0);
  });

  it("does not signal work for a run that never calls a tool", () => {
    const send = vi.fn();
    setLive2dWorkSignalSender(send);
    const run = createLive2dWorkRunTracker();
    run.finish();
    expect(send).not.toHaveBeenCalled();
    expect(getActiveLive2dWorkRunCount()).toBe(0);
  });

  it("counts a run once even when several tool calls start inside it", () => {
    const send = vi.fn();
    setLive2dWorkSignalSender(send);
    const run = createLive2dWorkRunTracker();
    run.markToolStarted();
    run.markToolStarted();
    run.markToolStarted();
    expect(getActiveLive2dWorkRunCount()).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    run.finish();
    expect(getActiveLive2dWorkRunCount()).toBe(0);
  });

  it("finish is idempotent so a run that ends twice does not drive the count negative", () => {
    const send = vi.fn();
    setLive2dWorkSignalSender(send);
    const run = createLive2dWorkRunTracker();
    run.markToolStarted();
    run.finish();
    run.finish();
    expect(getActiveLive2dWorkRunCount()).toBe(0);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps working true while any concurrent run is still active", () => {
    const send = vi.fn();
    setLive2dWorkSignalSender(send);
    const first = createLive2dWorkRunTracker();
    const second = createLive2dWorkRunTracker();
    first.markToolStarted();
    second.markToolStarted();
    expect(getActiveLive2dWorkRunCount()).toBe(2);
    first.finish();
    expect(getActiveLive2dWorkRunCount()).toBe(1);
    expect(send.mock.calls).toEqual([[true]]);
    second.finish();
    expect(getActiveLive2dWorkRunCount()).toBe(0);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("does not signal when a run ends with no sender installed, and keeps counting", () => {
    const run = createLive2dWorkRunTracker();
    run.markToolStarted();
    expect(getActiveLive2dWorkRunCount()).toBe(1);
    run.finish();
    expect(getActiveLive2dWorkRunCount()).toBe(0);
  });

  it("survives a throwing sender without corrupting the count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setLive2dWorkSignalSender(() => {
        throw new Error("pet window gone");
      });
      const run = createLive2dWorkRunTracker();
      run.markToolStarted();
      expect(getActiveLive2dWorkRunCount()).toBe(1);
      expect(warn).toHaveBeenCalled();
      run.finish();
      expect(getActiveLive2dWorkRunCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
