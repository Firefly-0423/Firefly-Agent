import { afterEach, describe, expect, it, vi } from "vitest";
import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { BlinkController } from "./blink";

type Listener = () => void;

function createModel(options: {
  hooks?: boolean;
  onOnly?: boolean;
  core?: boolean;
  setThrows?: boolean;
} = {}) {
  const listeners = new Map<string, Listener>();
  const on = vi.fn((event: string, listener: Listener) => {
    listeners.set(event, listener);
  });
  const off = vi.fn((event: string, listener: Listener) => {
    if (listeners.get(event) === listener) listeners.delete(event);
  });
  const setParameterValueById = vi.fn(() => {
    if (options.setThrows) throw new Error("synthetic missing parameter");
  });
  const internalModel = {
    ...(options.hooks === false ? {} : options.onOnly ? { on } : { on, off }),
    ...(options.core === false ? {} : { coreModel: { setParameterValueById } }),
  };
  const model = { internalModel } as unknown as Live2DModel;
  return {
    model,
    on,
    off,
    setParameterValueById,
    trigger: () => listeners.get("beforeModelUpdate")?.(),
    listener: () => listeners.get("beforeModelUpdate"),
  };
}

let clock = 0;

function setupTime(random = 0) {
  clock = 1000;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(random);
  return { now, randomSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BlinkController", () => {
  it("registers a beforeModelUpdate hook and starts with eyes open", () => {
    setupTime(0);
    const fake = createModel();
    const controller = new BlinkController(fake.model);

    expect(fake.on).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function));
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenCalledWith("ParamEyeLOpen", 1);
    expect(fake.setParameterValueById).toHaveBeenCalledWith("ParamEyeROpen", 1);
    controller.dispose();
  });

  it("runs close and ease-in-out open phases at the documented timings", () => {
    setupTime(0);
    const fake = createModel();
    new BlinkController(fake.model);

    clock = 3499;
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 1);

    fake.setParameterValueById.mockClear();
    clock = 3500; // blink starts
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 1);

    clock = 3535; // halfway through closing
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 0.5);

    clock = 3570; // fully closed
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 0);

    clock = 3610; // 40ms into opening
    fake.trigger();
    const open = 40 / 140;
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith(
      "ParamEyeROpen",
      open * open * (3 - 2 * open),
    );
  });

  it("finishes after 210ms, resets eyes and schedules the next blink", () => {
    setupTime(0);
    const fake = createModel();
    new BlinkController(fake.model);

    clock = 3500;
    fake.trigger();
    clock = 3710; // 210ms elapsed
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 1);

    clock = 6209; // next interval is 2500ms from finish
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 1);

    fake.setParameterValueById.mockClear();
    clock = 6210;
    fake.trigger();
    expect(fake.setParameterValueById).toHaveBeenCalledTimes(2);
    expect(fake.setParameterValueById).toHaveBeenLastCalledWith("ParamEyeROpen", 1);
  });

  it("dispose detaches the exact hook once and is idempotent", () => {
    setupTime();
    const fake = createModel();
    const controller = new BlinkController(fake.model);
    const hook = fake.on.mock.calls[0][1];

    controller.dispose();
    expect(fake.off).toHaveBeenCalledWith("beforeModelUpdate", hook);
    controller.dispose();
    expect(fake.off).toHaveBeenCalledTimes(1);
  });

  it("does not throw when detaching or writing parameters fails", () => {
    setupTime();
    const fake = createModel({ setThrows: true });
    fake.off.mockImplementation(() => {
      throw new Error("synthetic detached event");
    });
    const controller = new BlinkController(fake.model);

    expect(() => fake.trigger()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });

  it("skips hook registration when the internal model has no on/off pair", () => {
    setupTime();
    const noHooks = createModel({ hooks: false });
    const controller = new BlinkController(noHooks.model);
    expect(noHooks.on).not.toHaveBeenCalled();
    expect(() => controller.dispose()).not.toThrow();

    const onOnly = createModel({ onOnly: true });
    new BlinkController(onOnly.model);
    expect(onOnly.on).not.toHaveBeenCalled();
  });

  it("tolerates a model without a coreModel or parameter setter", () => {
    setupTime();
    const noCore = createModel({ core: false });
    new BlinkController(noCore.model);
    expect(() => noCore.trigger()).not.toThrow();
  });
});
