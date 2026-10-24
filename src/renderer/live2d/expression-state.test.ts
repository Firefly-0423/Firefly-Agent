import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireflyExpressionState } from "./expression-state";

describe("Firefly expression state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restores the default expression when a temporary expression ends", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    const finished = vi.fn();
    state.trigger(5000, finished);
    expect(expression).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(expression).toHaveBeenLastCalledWith("expression00");
    expect(finished).toHaveBeenCalledWith(true);
    state.dispose();
  });

  it("clears a temporary restoration when the model is disposed", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    const finished = vi.fn();
    state.trigger(5000, finished);
    state.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).not.toHaveBeenCalled();
    expect(expression).not.toHaveBeenCalled();
  });

  it("holds the default expression restore during a manual motion and applies it afterward", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    state.suspend();
    expect(await state.resetNow()).toBe(false);
    expect(expression).not.toHaveBeenCalled();
    expect(await state.resume()).toBe(true);
    expect(expression).toHaveBeenCalledWith("expression00");
    state.dispose();
  });

  it("starts from expression00 as the base expression", () => {
    const state = new FireflyExpressionState({ expression: vi.fn(async () => true) } as never);
    expect(state.getBase()).toBe("expression00");
    state.dispose();
  });

  it("applies a new base expression immediately when nothing is playing", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    expect(await state.setBase("expression6")).toBe(true);
    expect(state.getBase()).toBe("expression6");
    expect(expression).toHaveBeenLastCalledWith("expression6");
    state.dispose();
  });

  it("records a new base expression without applying it during a temporary expression, then restores it", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    state.trigger(5000, vi.fn());
    expect(await state.setBase("expression6")).toBe(false);
    expect(expression).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(expression).toHaveBeenLastCalledWith("expression6");
    state.dispose();
  });

  it("does not apply a new base expression while a manual action holds the expression", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    state.suspend();
    expect(await state.setBase("expression6")).toBe(false);
    expect(expression).not.toHaveBeenCalled();
    expect(await state.resume()).toBe(true);
    expect(expression).toHaveBeenLastCalledWith("expression6");
    state.dispose();
  });

  it("switches back to expression00 after work ends", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    await state.setBase("expression6");
    await state.setBase("expression00");
    expect(expression).toHaveBeenLastCalledWith("expression00");
    state.dispose();
  });

  it("ignores base expression changes after disposal", async () => {
    const expression = vi.fn(async () => true);
    const state = new FireflyExpressionState({ expression } as never);
    state.dispose();
    expect(await state.setBase("expression6")).toBe(false);
    expect(expression).not.toHaveBeenCalled();
  });
});
