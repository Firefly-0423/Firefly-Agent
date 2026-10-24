import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireflyActionController } from "./action-controller";

describe("Firefly action controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a double-click expression, holds the busy state, and frees it after the playback window", async () => {
    const manager = { hasAction: vi.fn(() => true), playAction: vi.fn(async () => true) };
    let finish!: (restored: boolean) => void;
    const expressions = {
      trigger: vi.fn((_duration: number, callback: (restored: boolean) => void) => { finish = callback; }),
      suspend: vi.fn(),
      resume: vi.fn(async () => true),
    };
    const controller = new FireflyActionController(manager, expressions);
    const target = { kind: "expression" as const, name: "expression2" };
    expect(await controller.play(target, 5000)).toBe(true);
    expect(manager.playAction).toHaveBeenCalledWith(target);
    expect(expressions.suspend).toHaveBeenCalledOnce();
    expect(expressions.trigger).toHaveBeenCalledWith(5000, expect.any(Function));
    expect(controller.isBusy()).toBe(true);
    expect(await controller.play({ kind: "expression", name: "expression9" }, 5000)).toBe(false);
    expect(manager.playAction).toHaveBeenCalledOnce();
    finish(true);
    expect(controller.isBusy()).toBe(false);
    controller.dispose();
  });

  it("refuses a target the model does not have", async () => {
    const manager = { hasAction: vi.fn(() => false), playAction: vi.fn() };
    const expressions = { trigger: vi.fn(), suspend: vi.fn(), resume: vi.fn(async () => true) };
    const controller = new FireflyActionController(manager, expressions);
    expect(await controller.play({ kind: "expression", name: "missing" }, 5000)).toBe(false);
    expect(manager.playAction).not.toHaveBeenCalled();
    expect(expressions.suspend).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("resumes the base expression and releases the busy state when playback is refused", async () => {
    const manager = { hasAction: vi.fn(() => true), playAction: vi.fn(async () => false) };
    const expressions = { trigger: vi.fn(), suspend: vi.fn(), resume: vi.fn(async () => true) };
    const controller = new FireflyActionController(manager, expressions);
    expect(await controller.play({ kind: "expression", name: "expression1" }, 5000)).toBe(false);
    expect(expressions.resume).toHaveBeenCalledOnce();
    expect(expressions.trigger).not.toHaveBeenCalled();
    expect(controller.isBusy()).toBe(false);
    controller.dispose();
  });

  it("refuses new playback after disposal", async () => {
    const manager = { hasAction: vi.fn(() => true), playAction: vi.fn(async () => true) };
    const expressions = { trigger: vi.fn(), suspend: vi.fn(), resume: vi.fn(async () => true) };
    const controller = new FireflyActionController(manager, expressions);
    controller.dispose();
    expect(await controller.play({ kind: "expression", name: "expression2" }, 5000)).toBe(false);
    expect(manager.playAction).not.toHaveBeenCalled();
  });
});
