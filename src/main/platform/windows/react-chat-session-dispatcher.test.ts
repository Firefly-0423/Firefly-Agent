import { it, expect, describe } from "vitest";
import { createReactChatSessionDispatcher as dispatcher } from "./react-chat-session-dispatcher";

describe("chat navigation across renderer readiness", () => {
  it("buffers only the latest destination, survives loading, and flushes once", () => {
    const navigation = dispatcher();
    expect([navigation.isReady(), navigation.getPending()]).toEqual([false, null]);
    expect(navigation.queueOrTake("session:notes")).toBeNull();
    expect(navigation.getPending()).toBe("session:notes");
    expect(navigation.queueOrTake("session:review")).toBeNull();
    expect(navigation.getPending()).toBe("session:review");
    navigation.markLoading();
    expect([navigation.isReady(), navigation.getPending()]).toEqual([false, "session:review"]);
    expect(navigation.markReady()).toBe("session:review");
    expect([navigation.isReady(), navigation.getPending()]).toEqual([true, null]);
    expect(navigation.markReady()).toBeNull();
  });
  it("delivers immediately while ready and starts buffering again after reload", () => {
    const navigation = dispatcher();
    navigation.markReady();
    expect(navigation.queueOrTake("session:calendar")).toBe("session:calendar");
    expect(navigation.getPending()).toBeNull();
    navigation.markLoading();
    expect([navigation.isReady(), navigation.getPending()]).toEqual([false, null]);
  });
  it("reset discards queued and ready state and permits another cycle", () => {
    const navigation = dispatcher();
    expect(navigation.queueOrTake("session:draft")).toBeNull();
    expect(navigation.getPending()).toBe("session:draft");
    navigation.reset();
    expect([navigation.isReady(), navigation.getPending()]).toEqual([false, null]);
    navigation.markReady();
    navigation.queueOrTake("session:sent");
    navigation.reset();
    expect(navigation.queueOrTake("session:new")).toBeNull();
    expect(navigation.getPending()).toBe("session:new");
  });
});
