// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE2D_DEFAULT_EXPRESSION, LIVE2D_WORKING_EXPRESSION } from "../shared/live2d-actions";

const fixture = vi.hoisted(() => {
  const controller = () => ({ pause: vi.fn(), resume: vi.fn(), dispose: vi.fn(), focusCenter: vi.fn() });
  return {
    options: undefined as undefined | { onLoad: () => void; onError: (e: Error) => void },
    manager: { init: vi.fn(), getModel: vi.fn(), getHitAreaDefs: vi.fn(() => []), hitTestRegions: vi.fn(), applyZoom: vi.fn(), pause: vi.fn(), resume: vi.fn(), resize: vi.fn(), dispose: vi.fn(), getResourceMetrics: vi.fn(() => ({ textures: 1 })) },
    interaction: controller(), focus: controller(), blink: controller(), click: controller(),
    expression: { setBase: vi.fn(), resetNow: vi.fn(), dispose: vi.fn() },
    actions: { play: vi.fn(async () => true), dispose: vi.fn() },
    interactionOptions: undefined as undefined | { resolveRegions: (x: number, y: number) => unknown; playAction: (target: unknown) => Promise<boolean>; onTrigger: (...args: unknown[]) => void; onMiss: (...args: unknown[]) => void },
    clickOptions: undefined as undefined | { onInteractive: (value: boolean) => void },
  };
});
vi.mock("./live2d/manager", () => ({ Live2DManager: vi.fn(function (options) { fixture.options = options; return fixture.manager; }) }));
vi.mock("./ui/theme", () => ({}));
vi.mock("../shared/renderer-base", () => ({ resolveAsset: (asset: string) => `/${asset}` }));
vi.mock("./live2d/interaction", () => ({ InteractionController: vi.fn(function (_canvas, _model, _defs, options) { fixture.interactionOptions = options; return fixture.interaction; }) }));
vi.mock("./live2d/focus", () => ({ MouseFocusController: vi.fn(function () { return fixture.focus; }) }));
vi.mock("./live2d/expression-state", () => ({ FireflyExpressionState: vi.fn(function () { return fixture.expression; }) }));
vi.mock("./live2d/action-controller", () => ({ FireflyActionController: vi.fn(function () { return fixture.actions; }) }));
vi.mock("./live2d/blink", () => ({ BlinkController: vi.fn(function () { return fixture.blink; }) }));
vi.mock("./live2d/click-through", () => ({ ClickThroughController: vi.fn(function (_canvas, _manager, options) { fixture.clickOptions = options; return fixture.click; }) }));

type Bridge = {
  firefly?: { setInteractive: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn>; setDragging: ReturnType<typeof vi.fn>; onPetZoom: ReturnType<typeof vi.fn>; onPetVisibilityChanged: ReturnType<typeof vi.fn>; getCursorPosition?: () => Promise<null> };
  settings?: { getGeneral: ReturnType<typeof vi.fn> };
  live2dWork?: { onChanged: (callback: (working: boolean) => void) => () => void; getWorking?: () => Promise<boolean> };
  __firefly?: { getLive2DDiagnostics: () => { isDragging: boolean; petVisible: boolean; lifecycle: { activeDisposers: number } }; resetExpression: () => unknown };
};
const win = window as unknown as Bridge;
let canvas: HTMLCanvasElement;
let zoom: (value: number) => void, visible: (value: boolean) => void, working: (value: boolean) => void;
let offs: Array<ReturnType<typeof vi.fn>>;
let unloadListeners: EventListener[];
let frames: Map<number, FrameRequestCallback>;
function pointer(type: string, input: Record<string, unknown> = {}) {
  const event = new Event(type);
  Object.assign(event, { button: 0, pointerId: 1, screenX: 40, screenY: 50, clientX: 20, clientY: 20, ...input });
  canvas.dispatchEvent(event);
}
async function boot(load = true) { await import("./main"); if (load) fixture.options!.onLoad(); await Promise.resolve(); }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.options = undefined; fixture.manager.getModel.mockReturnValue({});
  fixture.expression.setBase.mockResolvedValue(true);
  document.body.innerHTML = '<canvas id="live2d-canvas"></canvas>';
  canvas = document.querySelector("canvas")!;
  vi.spyOn(canvas, "toBlob").mockImplementation(callback => callback(null));
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100, top: 0, bottom: 100 } as DOMRect);
  Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  Object.defineProperty(window, "screenX", { configurable: true, writable: true, value: 20 });
  Object.defineProperty(window, "screenY", { configurable: true, writable: true, value: 30 });
  offs = [vi.fn(), vi.fn(), vi.fn()];
  win.firefly = { setInteractive: vi.fn(async () => {}), moveTo: vi.fn(), setDragging: vi.fn(), onPetZoom: vi.fn(callback => { zoom = callback; return offs[0]; }), onPetVisibilityChanged: vi.fn(callback => { visible = callback; return offs[1]; }) };
  win.live2dWork = { onChanged: callback => { working = callback; return offs[2]; } };
  win.settings = { getGeneral: vi.fn(async () => ({ petZoom: 1 })) }; delete win.__firefly;
  frames = new Map(); let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { frames.set(++nextFrame, callback); return nextFrame; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(id => { frames.delete(id); }));
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:unit"), revokeObjectURL: vi.fn() }));
  unloadListeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => { if (type === "beforeunload") unloadListeners.push(listener as EventListener); add(type, listener, options); });
});
afterEach(() => {
  window.dispatchEvent(new Event("beforeunload"));
  for (const listener of unloadListeners) window.removeEventListener("beforeunload", listener);
  delete win.firefly; delete win.settings; delete win.live2dWork; delete win.__firefly;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("pet renderer entry", () => {
  it("rejects a missing canvas with the exact startup error", async () => {
    canvas.remove(); await expect(import("./main")).rejects.toThrow(new Error("Canvas #live2d-canvas not found"));
    expect(fixture.manager.init).not.toHaveBeenCalled();
  });

  it("provides the browser fallback bridge and tolerates missing optional bridges", async () => {
    delete win.firefly; delete win.settings; delete win.live2dWork;
    await boot();
    expect(await win.firefly!.getCursorPosition!()).toBeNull();
    expect(await win.firefly!.setInteractive(true)).toBeUndefined();
    pointer("pointerdown"); pointer("pointerup");
    expect(fixture.manager.init).toHaveBeenCalledOnce();
  });

  it("initializes the loaded model, current expression, zoom and diagnostics", async () => {
    win.settings!.getGeneral.mockResolvedValue({ petZoom: 1.5 });
    await boot();
    expect(fixture.expression.setBase).toHaveBeenCalledWith(LIVE2D_DEFAULT_EXPRESSION);
    expect(fixture.focus.focusCenter).toHaveBeenCalledWith(true);
    expect(fixture.manager.applyZoom).toHaveBeenCalledWith(1.5);
    zoom(2); expect(fixture.manager.applyZoom).toHaveBeenLastCalledWith(2);
    expect(win.__firefly!.getLive2DDiagnostics()).toMatchObject({ resources: { textures: 1 }, controllers: { interaction: true, focus: true, expressionReset: true, blink: true, clickThrough: true }, isDragging: false, petVisible: true });
    win.__firefly!.resetExpression(); expect(fixture.expression.resetNow).toHaveBeenCalledOnce();
  });

  it("handles missing models and reports model-load errors", async () => {
    fixture.manager.getModel.mockReturnValue(null); await boot();
    expect(win.__firefly).toBeUndefined();
    expect(win.firefly!.onPetZoom).not.toHaveBeenCalled();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("model failed"); fixture.options!.onError(failure);
    expect(error).toHaveBeenCalledWith("[Firefly] Failed to load model:", failure);
  });

  it("ignores rejected settings and default zoom snapshots", async () => {
    win.settings!.getGeneral.mockRejectedValue(new Error("unavailable"));
    await boot(); await Promise.resolve(); expect(fixture.manager.applyZoom).not.toHaveBeenCalled();
  });

  it("retains working events received before model load and applies later transitions", async () => {
    await boot(false); working(true); fixture.options!.onLoad();
    expect(fixture.expression.setBase).toHaveBeenLastCalledWith(LIVE2D_WORKING_EXPRESSION);
    working(false); expect(fixture.expression.setBase).toHaveBeenLastCalledWith(LIVE2D_DEFAULT_EXPRESSION);
  });

  it("reads the initial working snapshot", async () => {
    win.live2dWork!.getWorking = async () => true; await boot();
    expect(fixture.expression.setBase).toHaveBeenLastCalledWith(LIVE2D_WORKING_EXPRESSION);
  });

  it("keeps the idle expression when the initial working snapshot fails", async () => {
    win.live2dWork!.getWorking = async () => { throw new Error("unavailable"); };
    await boot(); await Promise.resolve();
    expect(fixture.expression.setBase).toHaveBeenLastCalledWith(LIVE2D_DEFAULT_EXPRESSION);
  });

  it("does not reapply the default persisted zoom", async () => {
    await boot(); expect(fixture.manager.applyZoom).not.toHaveBeenCalled();
  });

  it("wires double-click actions, hit testing and interactive changes", async () => {
    await boot();
    const target = { kind: "expression", name: "expression1" };
    expect(await fixture.interactionOptions!.playAction(target)).toBe(true);
    expect(fixture.actions.play).toHaveBeenCalledWith(target, 5000);
    fixture.interactionOptions!.resolveRegions(1, 2); expect(fixture.manager.hitTestRegions).toHaveBeenCalledWith(1, 2);
    fixture.clickOptions!.onInteractive(false); expect(win.firefly!.setInteractive).toHaveBeenCalledWith(false);
  });

  it("pauses hidden pets and resumes visible pets unless dragging", async () => {
    await boot(); visible(false);
    expect(fixture.click.pause).toHaveBeenCalledOnce(); expect(fixture.focus.pause).toHaveBeenCalledOnce(); expect(fixture.manager.pause).toHaveBeenCalledOnce();
    visible(true); expect(fixture.manager.resume).toHaveBeenCalledOnce();
    pointer("pointerdown"); visible(false); visible(true);
    expect(fixture.manager.resume).toHaveBeenCalledOnce();
    expect(win.__firefly!.getLive2DDiagnostics()).toMatchObject({ isDragging: true, petVisible: true });
  });

  it("resizes the renderer and recenters focus", async () => {
    await boot(); window.dispatchEvent(new Event("resize"));
    expect(fixture.manager.resize).toHaveBeenCalledWith(window.innerWidth, window.innerHeight);
    expect(fixture.focus.focusCenter).toHaveBeenCalledTimes(2);
  });

  it("ignores non-primary, invalid and mismatched pointer inputs", async () => {
    await boot(); pointer("pointerdown", { button: 1 }); pointer("pointerdown", { screenX: NaN });
    expect(fixture.manager.pause).not.toHaveBeenCalled();
    pointer("pointermove"); pointer("pointerup");
    expect(win.firefly!.moveTo).not.toHaveBeenCalled();
    pointer("pointerdown"); pointer("pointermove", { pointerId: 2, screenX: 90 }); pointer("pointerup", { pointerId: 2 });
    expect(win.__firefly!.getLive2DDiagnostics().isDragging).toBe(true);
    pointer("pointercancel", { pointerId: 2 }); expect(win.__firefly!.getLive2DDiagnostics().isDragging).toBe(true);
    pointer("pointercancel"); expect(win.__firefly!.getLive2DDiagnostics().isDragging).toBe(false);
  });

  it("starts a drag only beyond five pixels and coalesces moves until final pointerup", async () => {
    await boot(); pointer("pointerdown");
    pointer("pointermove", { screenX: 43, screenY: 54 });
    expect(win.firefly!.setDragging).not.toHaveBeenCalled();
    pointer("pointermove", { screenX: 46, screenY: 50 });
    pointer("pointermove", { screenX: 50, screenY: 60 });
    expect(win.firefly!.setDragging).toHaveBeenCalledWith(true); expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(win.firefly!.moveTo).not.toHaveBeenCalled();
    pointer("pointerup", { screenX: 60, screenY: 70 });
    expect(win.firefly!.moveTo).toHaveBeenCalledExactlyOnceWith(40, 50);
    expect(win.firefly!.setDragging).toHaveBeenLastCalledWith(false); expect(frames.size).toBe(0);
    expect(win.__firefly!.getLive2DDiagnostics().isDragging).toBe(false);
  });

  it("flushes animation-frame moves and drops pending moves on cancellation", async () => {
    await boot(); pointer("pointerdown"); pointer("pointermove", { screenX: 50 });
    const [id, callback] = [...frames][0]; frames.delete(id); callback(0);
    expect(win.firefly!.moveTo).toHaveBeenCalledWith(30, 30);
    pointer("pointermove", { screenX: 60 }); pointer("pointercancel");
    expect(frames.size).toBe(0); expect(win.firefly!.moveTo).toHaveBeenCalledOnce();
  });

  it("passes through outside releases and leaves, while retaining capture during dragging", async () => {
    await boot(); pointer("pointerenter"); expect(fixture.click.resume).toHaveBeenCalledOnce();
    pointer("pointerleave"); expect(win.firefly!.setInteractive).toHaveBeenLastCalledWith(false);
    pointer("pointerdown"); pointer("pointerleave"); expect(win.firefly!.setInteractive).toHaveBeenLastCalledWith(true);
    pointer("pointerup", { clientX: 101 }); expect(win.firefly!.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("does not resume rendering when a hidden pet finishes dragging", async () => {
    await boot(); pointer("pointerdown"); visible(false); pointer("pointerup");
    expect(fixture.manager.resume).not.toHaveBeenCalled(); expect(fixture.focus.resume).not.toHaveBeenCalled();
  });

  it("ignores invalid window coordinates and tolerates pointer-capture failures", async () => {
    await boot(); window.screenX = NaN; pointer("pointerdown");
    expect(fixture.manager.pause).not.toHaveBeenCalled();
    window.screenX = 20;
    vi.mocked(canvas.setPointerCapture).mockImplementation(() => { throw new Error("unsupported"); });
    vi.mocked(canvas.releasePointerCapture).mockImplementation(() => { throw new Error("unsupported"); });
    pointer("pointerdown"); pointer("pointerup");
    expect(win.__firefly!.getLive2DDiagnostics().isDragging).toBe(false);
  });

  it("displays and releases a captured drag overlay", async () => {
    await boot(); vi.mocked(canvas.toBlob).mockImplementation(callback => callback(new Blob(["frame"])));
    const create = vi.spyOn(document, "createElement");
    pointer("pointerdown"); pointer("pointermove", { screenX: 50 }); await Promise.resolve();
    const img = create.mock.results.find(result => result.value instanceof HTMLImageElement)!.value as HTMLImageElement;
    img.dispatchEvent(new Event("load"));
    expect(document.body.contains(img)).toBe(true); expect(canvas.style.visibility).toBe("hidden");
    pointer("pointerup"); expect(document.body.contains(img)).toBe(false); expect(canvas.style.visibility).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:unit");
  });

  it("ignores captures that finish after dragging has ended", async () => {
    await boot(); let capture!: BlobCallback;
    vi.mocked(canvas.toBlob).mockImplementation(callback => { capture = callback; });
    pointer("pointerdown"); pointer("pointermove", { screenX: 50 }); pointer("pointerup");
    capture(new Blob(["late"])); await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(document.querySelector("img")).toBeNull();
  });

  it("tolerates canvas capture errors and invalid movement coordinates", async () => {
    await boot(); vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(canvas.toBlob).mockImplementation(() => { throw new Error("capture denied"); });
    pointer("pointerdown"); pointer("pointermove", { screenX: 50 }); await Promise.resolve();
    pointer("pointermove", { screenX: NaN }); pointer("pointerup", { screenX: Infinity });
    expect(win.firefly!.moveTo).toHaveBeenCalledExactlyOnceWith(30, 30);
    expect(document.querySelector("img")).toBeNull();
  });

  it("releases an overlay URL if the image fails to load or loads after cancellation", async () => {
    await boot(); vi.mocked(canvas.toBlob).mockImplementation(callback => callback(new Blob(["frame"])));
    const create = vi.spyOn(document, "createElement");
    pointer("pointerdown"); pointer("pointermove", { screenX: 50 }); await Promise.resolve();
    const img = create.mock.results.find(result => result.value instanceof HTMLImageElement)!.value as HTMLImageElement;
    img.dispatchEvent(new Event("error")); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:unit");
    pointer("pointercancel"); img.dispatchEvent(new Event("load"));
    expect(document.body.contains(img)).toBe(false); expect(canvas.style.visibility).toBe("");
  });

  it("disposes controllers, subscriptions and tracked listeners on unload", async () => {
    await boot(); window.dispatchEvent(new Event("beforeunload"));
    for (const controller of [fixture.manager, fixture.interaction, fixture.focus, fixture.blink, fixture.click, fixture.expression, fixture.actions]) expect(controller.dispose).toHaveBeenCalledOnce();
    for (const off of offs) expect(off).toHaveBeenCalledOnce();
    expect(win.__firefly!.getLive2DDiagnostics().lifecycle.activeDisposers).toBe(0);
    const count = fixture.manager.resize.mock.calls.length; window.dispatchEvent(new Event("resize"));
    expect(fixture.manager.resize).toHaveBeenCalledTimes(count);
  });
});
