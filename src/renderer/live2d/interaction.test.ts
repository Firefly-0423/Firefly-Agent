import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { InteractionController, pickDoubleClickTarget, type HitAreaDef } from "./interaction";
import { FireflyActionController } from "./action-controller";
import { FireflyExpressionState } from "./expression-state";

const AREAS: HitAreaDef[] = [
  { name: "Head", id: "ArtMesh23" },
  { name: "Body", id: "ArtMesh154" },
];

function setup(options: { random?: () => number; hit?: string[] } = {}) {
  const listeners = new Map<string, (event: PointerEvent) => void>();
  const canvas = {
    addEventListener: vi.fn((name: string, listener: (event: PointerEvent) => void) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  } as unknown as HTMLCanvasElement;
  let hit = options.hit ?? ["Head"];
  const hitTest = vi.fn(() => hit);
  const model = { hitTest } as never;
  const playAction = vi.fn(async () => true);
  const onTrigger = vi.fn();
  const onMiss = vi.fn();
  const controller = new InteractionController(canvas, model, AREAS, {
    playAction,
    onTrigger,
    onMiss,
    random: options.random ?? (() => 0),
  });
  const emit = (name: string, screenX: number, screenY: number, pointerId = 1, button = 0) => {
    listeners.get(name)?.({ clientX: 100, clientY: 100, screenX, screenY, pointerId, button } as PointerEvent);
  };
  const click = (x = 100, y = 100) => {
    emit("pointerdown", x, y);
    emit("pointerup", x, y);
  };
  return {
    controller,
    emit,
    click,
    playAction,
    onTrigger,
    onMiss,
    hitTest,
    listeners,
    setHit: (next: string[]) => { hit = next; },
  };
}

describe("pickDoubleClickTarget", () => {
  it("picks expression2 for 75% of head double-clicks and expression1 for the remaining 25%", () => {
    expect(pickDoubleClickTarget("Head", () => 0)).toEqual({ kind: "expression", name: "expression2" });
    expect(pickDoubleClickTarget("Head", () => 0.7499)).toEqual({ kind: "expression", name: "expression2" });
    expect(pickDoubleClickTarget("Head", () => 0.75)).toEqual({ kind: "expression", name: "expression1" });
    expect(pickDoubleClickTarget("Head", () => 0.9999)).toEqual({ kind: "expression", name: "expression1" });
  });

  it("splits body double-clicks evenly between expression9 and expression10", () => {
    expect(pickDoubleClickTarget("Body", () => 0)).toEqual({ kind: "expression", name: "expression9" });
    expect(pickDoubleClickTarget("Body", () => 0.4999)).toEqual({ kind: "expression", name: "expression9" });
    expect(pickDoubleClickTarget("Body", () => 0.5)).toEqual({ kind: "expression", name: "expression10" });
    expect(pickDoubleClickTarget("Body", () => 0.9999)).toEqual({ kind: "expression", name: "expression10" });
  });

  it("returns nothing for areas without a double-click rule", () => {
    expect(pickDoubleClickTarget("Other", () => 0)).toBeUndefined();
  });

  it("uses Math.random when no random source is injected", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      expect(pickDoubleClickTarget("Head")).toEqual({ kind: "expression", name: "expression1" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Firefly hit-area interaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps double-click to the confirmed cat-ear resource and its existing reset parameter", () => {
    const modelRoot = "src/renderer/public/models/firefly/";
    const manifest = JSON.parse(readFileSync(modelRoot + "Firefly.model3.json", "utf8"));
    const resource = manifest.FileReferences.Expressions.find((entry: { Name: string }) => entry.Name === "expression2");
    expect(resource.File).toBe("Expressions/Expressions_2_File_0.json");
    const expression = JSON.parse(readFileSync(modelRoot + resource.File, "utf8"));
    const resetResource = manifest.FileReferences.Expressions.find((entry: { Name: string }) => entry.Name === "expression00");
    const reset = JSON.parse(readFileSync(modelRoot + resetResource.File, "utf8"));
    expect(expression.Parameters).toContainEqual({ Id: "Param40", Value: 1, Blend: "Add" });
    expect(reset.Parameters).toContainEqual({ Id: "Param40", Value: 0, Blend: "Add" });
  });

  it("plays the weighted head expression on a double-click and reports the trigger", async () => {
    vi.useFakeTimers();
    const state = setup({ random: () => 0.8 });
    state.click();
    state.click();
    expect(state.playAction).toHaveBeenCalledOnce();
    expect(state.playAction).toHaveBeenCalledWith({ kind: "expression", name: "expression1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.onTrigger).toHaveBeenCalledWith({ name: "Head", id: "ArtMesh23" }, { kind: "expression", name: "expression1" });
    state.controller.dispose();
  });

  it("plays a body expression on a body double-click", async () => {
    vi.useFakeTimers();
    const state = setup({ random: () => 0.6, hit: ["Body"] });
    state.click();
    state.click();
    expect(state.playAction).toHaveBeenCalledWith({ kind: "expression", name: "expression10" });
    await vi.advanceTimersByTimeAsync(0);
    state.controller.dispose();
  });

  it("does nothing on a single click, even after the double-click window closes", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.playAction).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("uses an injected region resolver instead of model.hitTest", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: PointerEvent) => void>();
    const canvas = {
      addEventListener: vi.fn((name: string, listener: (event: PointerEvent) => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    } as unknown as HTMLCanvasElement;
    const modelHitTest = vi.fn(() => ["Head"]);
    const resolveRegions = vi.fn(() => ["Body"]);
    const playAction = vi.fn(async () => true);
    const controller = new InteractionController(canvas, { hitTest: modelHitTest } as never, AREAS, {
      playAction,
      random: () => 0.6,
      resolveRegions,
    });
    const emit = (name: string) => listeners.get(name)?.({ clientX: 50, clientY: 60, screenX: 50, screenY: 60, pointerId: 1, button: 0 } as PointerEvent);
    emit("pointerdown");
    emit("pointerup");
    emit("pointerdown");
    emit("pointerup");
    expect(resolveRegions).toHaveBeenCalledWith(50, 60);
    expect(modelHitTest).not.toHaveBeenCalled();
    expect(playAction).toHaveBeenCalledWith({ kind: "expression", name: "expression10" });
    controller.dispose();
    vi.useRealTimers();
  });

  it("ignores double-clicks on areas without a rule", async () => {
    vi.useFakeTimers();
    const state = setup({ hit: ["Other"] });
    state.click();
    state.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.playAction).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("does not combine clicks on different areas into a double-click", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.click();
    state.setHit(["Body"]);
    state.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.playAction).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("does not combine clicks separated by more than the double-click window", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.click();
    await vi.advanceTimersByTimeAsync(400);
    state.click();
    expect(state.playAction).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("ignores drag release, right-click, unmatched pointer, and cancel", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.emit("pointerdown", 100, 100);
    state.emit("pointerup", 120, 100);
    state.emit("pointerdown", 100, 100, 1, 2);
    state.emit("pointerup", 100, 100, 1, 2);
    state.emit("pointerdown", 100, 100);
    state.emit("pointerup", 100, 100, 2);
    state.emit("pointercancel", 100, 100);
    state.emit("pointerup", 100, 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.playAction).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("does not stack simultaneous double-clicks or act on disposed listeners", async () => {
    vi.useFakeTimers();
    const state = setup();
    let release!: (started: boolean) => void;
    state.playAction.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve; }));
    state.click();
    state.click();
    state.click();
    state.click();
    expect(state.playAction).toHaveBeenCalledOnce();
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.onTrigger).toHaveBeenCalledOnce();
    state.controller.dispose();
    expect(state.listeners.size).toBe(0);
  });

  it("reports a miss when the expression could not start", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.playAction.mockResolvedValueOnce(false);
    state.click();
    state.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.onMiss).toHaveBeenCalledWith({ name: "Head", id: "ArtMesh23" }, { kind: "expression", name: "expression2" });
    expect(state.onTrigger).not.toHaveBeenCalled();
    state.controller.dispose();
  });

  it("rejects repeated double-click playback until the expression timer restores the base expression", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout });
    const expression = vi.fn(async (_name: string) => true);
    const model = { expression } as never;
    const expressions = new FireflyExpressionState(model);
    const manager = {
      hasAction: () => true,
      playAction: vi.fn(async (target: { kind: string; name?: string }) => target.kind === "expression" && expression(target.name!)),
    };
    const actions = new FireflyActionController(manager, expressions);
    const state = setup({ random: () => 0 });
    state.playAction.mockImplementation(async (target) => actions.play(target, 5000));
    try {
      state.click();
      state.click();
      await vi.advanceTimersByTimeAsync(100);
      state.click();
      state.click();
      await vi.advanceTimersByTimeAsync(100);
      expect(manager.playAction).toHaveBeenCalledOnce();
      expect(expression).toHaveBeenCalledWith("expression2");
      expect(actions.isBusy()).toBe(true);
      await vi.advanceTimersByTimeAsync(4800);
      expect(expression).toHaveBeenLastCalledWith("expression00");
      expect(actions.isBusy()).toBe(false);
      state.click();
      state.click();
      await vi.advanceTimersByTimeAsync(5000);
      expect(manager.playAction).toHaveBeenCalledTimes(2);
      expect(expression).toHaveBeenLastCalledWith("expression00");
      expect(actions.isBusy()).toBe(false);
    } finally {
      state.controller.dispose();
      actions.dispose();
      expressions.dispose();
      vi.unstubAllGlobals();
    }
  });
});
