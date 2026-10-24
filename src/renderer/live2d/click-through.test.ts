// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClickThroughController } from "./click-through";
let canvas: HTMLCanvasElement, frame: FrameRequestCallback | undefined, alpha: number;
const controllers: ClickThroughController[] = [];
beforeEach(() => { canvas = document.createElement("canvas"); alpha = 10; frame = undefined; vi.stubGlobal("requestAnimationFrame", vi.fn((fn: FrameRequestCallback) => { frame = fn; return 1; })); vi.stubGlobal("cancelAnimationFrame", vi.fn()); vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20 } as DOMRect); vi.stubGlobal("devicePixelRatio", 2); });
afterEach(() => { controllers.forEach(c => c.dispose()); controllers.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(options = {}) {
  const readPixels = vi.fn((_x, _y, _w, _h, _rgba, _byte, buffer: Uint8Array) => { buffer[3] = alpha; });
  const gl = { drawingBufferWidth: 100, drawingBufferHeight: 80, RGBA: 6408, UNSIGNED_BYTE: 5121, readPixels }, getGL = vi.fn(() => gl), interactive = vi.fn(); const controller = new ClickThroughController(canvas, { getGL } as never, { onInteractive: interactive, ...options }); controllers.push(controller); return { controller, interactive, getGL, readPixels };
}
function move(x = 11, y = 21) { canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y })); }
function flush() { const fn = frame; frame = undefined; fn?.(0); }
it("coalesces moves, maps CSS pixels with DPR and flips WebGL Y", () => { const f = fixture(); move(10, 20); move(12, 23); expect(requestAnimationFrame).toHaveBeenCalledOnce(); expect(f.interactive).not.toHaveBeenCalled(); flush(); expect(f.readPixels).toHaveBeenCalledWith(4, 73, 1, 1, 6408, 5121, expect.any(Uint8Array)); expect(f.interactive).toHaveBeenCalledWith(true); });
it("uses an inclusive default threshold and suppresses repeated state callbacks", () => { const f = fixture(); move(); flush(); move(); flush(); expect(f.interactive).toHaveBeenCalledOnce(); alpha = 9; move(); flush(); expect(f.interactive.mock.calls).toEqual([[true], [false]]); });
it("allows a custom alpha threshold including zero", () => { const f = fixture({ alphaThreshold: 0 }); alpha = 0; move(); flush(); expect(f.interactive).toHaveBeenCalledWith(true); });
it.each([[9, 20], [10, 19], [60, 20], [10, 60]])("passes through out-of-bounds point %j,%j without reading pixels", (x, y) => { const f = fixture(); move(x, y); flush(); expect(f.interactive).toHaveBeenCalledWith(false); expect(f.readPixels).not.toHaveBeenCalled(); });
it("captures before GL initializes", () => { const f = fixture(); f.getGL.mockReturnValue(null as never); move(); flush(); expect(f.interactive).toHaveBeenCalledWith(true); });
it("falls back to DPR 1", () => { vi.stubGlobal("devicePixelRatio", 0); const f = fixture(); move(11, 21); flush(); expect(f.readPixels.mock.calls[0].slice(0, 2)).toEqual([1, 78]); });
it("pauses and cancels pending work, then re-evaluates the same state on resume", () => { const f = fixture(); move(); flush(); move(); f.controller.pause(); expect(cancelAnimationFrame).toHaveBeenCalledWith(1); flush(); move(); expect(f.interactive).toHaveBeenCalledOnce(); f.controller.resume(); move(); flush(); expect(f.interactive.mock.calls).toEqual([[true], [true]]); });
it("disposes idempotently and cannot be resumed", () => { const f = fixture(); move(); f.controller.dispose(); f.controller.dispose(); f.controller.resume(); flush(); move(); expect(f.interactive).not.toHaveBeenCalled(); expect(cancelAnimationFrame).toHaveBeenCalledOnce(); });
