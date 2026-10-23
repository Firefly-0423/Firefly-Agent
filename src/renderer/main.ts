import { Live2DManager } from "./live2d/manager";
import "./ui/theme";
import { InteractionController } from "./live2d/interaction";
import { MouseFocusController } from "./live2d/focus";
import { FireflyExpressionState } from "./live2d/expression-state";
import { FireflyActionController } from "./live2d/action-controller";
import { BlinkController } from "./live2d/blink";
import { ClickThroughController } from "./live2d/click-through";
import { Live2DRendererLifecycleTracker } from "./live2d/lifecycle-diagnostics";
import { resolveAsset } from "../shared/renderer-base";
import { LIVE2D_DEFAULT_EXPRESSION, LIVE2D_WORKING_EXPRESSION } from "../shared/live2d-actions";

const surface = document.getElementById("live2d-canvas") as HTMLCanvasElement;
if (!surface) throw new Error("Canvas #live2d-canvas not found");
if (!window.firefly) {
  (window as unknown as { firefly: unknown }).firefly = {
    minimize: () => {},
    setInteractive: (_: boolean) => Promise.resolve(),
    moveTo: (_x: number, _y: number) => {},
    setDragging: (_isDragging: boolean) => {},
    getCursorPosition: () => Promise.resolve(null),
    onPetZoom: (_cb: (zoom: number) => void) => () => {},
    onPetVisibilityChanged: (_cb: (visible: boolean) => void) => () => {},
  };
}
declare global {
  interface Window {
    live2dWork?: {
      getWorking?: () => Promise<boolean>;
      onChanged: (callback: (working: boolean) => void) => () => void;
    };
  }
}
let gestures: InteractionController | null = null;
let gaze: MouseFocusController | null = null;
let expressions: FireflyExpressionState | null = null;
let actionPlayer: FireflyActionController | null = null;
let eyes: BlinkController | null = null;
let transparency: ClickThroughController | null = null;
let releaseZoom: (() => void) | null = null;
let releaseVisibility: (() => void) | null = null;
let visible = true;
let releaseWork: (() => void) | null = null;
let working = false;
const lifetime = new Live2DRendererLifecycleTracker();
function trackSubscription(label: string, off: () => void): () => void {
  return lifetime.track("subscription", label, off);
}
function addTrackedEventListener(target: EventTarget, label: string, type: string, listener: EventListenerOrEventListenerObject): void {
  target.addEventListener(type, listener);
  lifetime.track("listener", label, () => target.removeEventListener(type, listener));
}
const renderer = new Live2DManager({
  canvas: surface,
  width: window.innerWidth,
  height: window.innerHeight,
  modelPath: resolveAsset("models/firefly/Firefly.model3.json"),
  onLoad: installControllers,
  onError: (failure) => { console.error("[Firefly] Failed to load model:", failure); },
});
function currentBaseExpression(): string {
  return working ? LIVE2D_WORKING_EXPRESSION : LIVE2D_DEFAULT_EXPRESSION;
}
function installControllers(): void {
  console.log("[Firefly] Model loaded");
  const avatar = renderer.getModel();
  if (!avatar) return;
  expressions = new FireflyExpressionState(avatar);
  void expressions.setBase(currentBaseExpression());
  actionPlayer = new FireflyActionController(renderer, expressions);
  eyes = new BlinkController(avatar);
  gestures = new InteractionController(surface, avatar, renderer.getHitAreaDefs(), {
    resolveRegions: (x, y) => renderer.hitTestRegions(x, y),
    playAction: (target) => actionPlayer?.play(target, 5000) ?? Promise.resolve(false),
    onTrigger: (area, target) => { console.info("[Firefly] double-click", area.name, "started", target); },
    onMiss: (area, target) => console.info("[Firefly] double-click", area.name, "not started", target),
  });
  gaze = new MouseFocusController(surface, avatar);
  gaze.focusCenter(true);
  transparency = new ClickThroughController(surface, renderer, {
    onInteractive: (interactive) => void window.firefly.setInteractive(interactive),
  });
  releaseZoom = trackSubscription("firefly:onPetZoom", window.firefly.onPetZoom((zoom) => renderer.applyZoom(zoom)));
  releaseVisibility = trackSubscription("firefly:onPetVisibilityChanged", window.firefly.onPetVisibilityChanged((shown) => {
    visible = shown;
    if (!shown) {
      transparency?.pause();
      gaze?.pause();
      renderer.pause();
      return;
    }
    if (!dragging) {
      renderer.resume();
      gaze?.resume();
      transparency?.resume();
    }
  }));
  window.settings?.getGeneral().then((configuration) => {
    if (configuration?.petZoom && configuration.petZoom !== 1) renderer.applyZoom(configuration.petZoom);
  }).catch(() => { /* 失败时维持现有流程。 */ });
  (window as unknown as { __firefly: unknown }).__firefly = {
    manager: renderer,
    interaction: gestures,
    focus: gaze,
    expressionReset: expressions,
    resetExpression: () => expressions?.resetNow(),
    getLive2DDiagnostics: () => ({
      resources: renderer.getResourceMetrics(),
      lifecycle: lifetime.getDiagnostics(),
      controllers: {
        interaction: gestures !== null,
        focus: gaze !== null,
        expressionReset: expressions !== null,
        blink: eyes !== null,
        clickThrough: transparency !== null,
      },
      petVisible: visible,
      isDragging: dragging,
    }),
  };
}
releaseWork = trackSubscription("live2dWork:onChanged", window.live2dWork?.onChanged((value) => {
  working = value === true;
  void expressions?.setBase(currentBaseExpression());
}) ?? (() => {}));
void window.live2dWork?.getWorking?.().then((value) => {
  working = value === true;
  void expressions?.setBase(currentBaseExpression());
}).catch(() => { /* 失败时维持现有流程。 */ });
renderer.init();
addTrackedEventListener(window, "window:resize", "resize", () => {
  renderer.resize(window.innerWidth, window.innerHeight);
  gaze?.focusCenter(true);
});
window.addEventListener("beforeunload", () => {
  expressions?.dispose(); expressions = null;
  actionPlayer?.dispose(); actionPlayer = null;
  releaseWork?.(); releaseWork = null;
  eyes?.dispose(); eyes = null;
  gaze?.dispose(); gaze = null;
  transparency?.dispose(); transparency = null;
  releaseZoom?.(); releaseZoom = null;
  releaseVisibility?.(); releaseVisibility = null;
  gestures?.dispose(); gestures = null;
  renderer.dispose();
  lifetime.disposeAll();
});

let dragging = false;
let crossedThreshold = false;
let capturedPointer: number | null = null;
let initialScreenX = 0;
let initialScreenY = 0;
let grabX = 0;
let grabY = 0;
let queuedMove: { x: number; y: number } | null = null;
let moveFrame: number | null = null;
let frozenImage: HTMLImageElement | null = null;
let captureGeneration = 0;
let frozenUrl: string | null = null;
function clearDragOverlay(): void {
  if (frozenImage) { frozenImage.remove(); frozenImage = null; }
  if (frozenUrl) { URL.revokeObjectURL(frozenUrl); frozenUrl = null; }
  surface.style.visibility = "";
}
function captureCanvasBlob(): Promise<Blob | null> {
  return new Promise((complete) => {
    try { surface.toBlob((image) => complete(image), "image/png"); }
    catch (failure) {
      console.warn("[Firefly] canvas.toBlob failed", failure);
      complete(null);
    }
  });
}
async function showDragOverlay(token: number): Promise<void> {
  const snapshot = await captureCanvasBlob();
  if (!snapshot || token !== captureGeneration || !dragging) return;
  const objectUrl = URL.createObjectURL(snapshot);
  const overlay = document.createElement("img");
  overlay.src = objectUrl;
  overlay.alt = "";
  overlay.draggable = false;
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh", objectFit: "contain",
    pointerEvents: "none", userSelect: "none", zIndex: "10",
  });
  overlay.onload = () => {
    if (token !== captureGeneration || !dragging) { URL.revokeObjectURL(objectUrl); return; }
    frozenImage?.remove();
    frozenImage = overlay;
    frozenUrl = objectUrl;
    document.body.appendChild(overlay);
    surface.style.visibility = "hidden";
  };
  overlay.onerror = () => URL.revokeObjectURL(objectUrl);
}
function scheduleMoveTo(screenX: number, screenY: number): void {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (!Number.isFinite(grabX) || !Number.isFinite(grabY)) return;
  queuedMove = { x: screenX - grabX, y: screenY - grabY };
  if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove);
}
function flushMove(): void {
  moveFrame = null;
  if (!queuedMove) return;
  window.firefly.moveTo(queuedMove.x, queuedMove.y);
  queuedMove = null;
}
function cancelPendingMove(): void {
  if (moveFrame !== null) { cancelAnimationFrame(moveFrame); moveFrame = null; }
  queuedMove = null;
}
function finishDrag(): void {
  dragging = false;
  crossedThreshold = false;
  capturedPointer = null;
  captureGeneration += 1;
  cancelPendingMove();
  clearDragOverlay();
  if (visible) { renderer.resume(); gaze?.resume(); }
  window.firefly.setDragging(false);
  if (visible) transparency?.resume();
}
addTrackedEventListener(surface, "canvas:pointerenter", "pointerenter", () => { transparency?.resume(); });
addTrackedEventListener(surface, "canvas:pointercancel", "pointercancel", (event) => {
  if (dragging && (event as PointerEvent).pointerId === capturedPointer) finishDrag();
});
addTrackedEventListener(surface, "canvas:pointerleave", "pointerleave", () => {
  if (dragging) return;
  void window.firefly.setInteractive(false);
});
addTrackedEventListener(surface, "canvas:pointerdown", "pointerdown", (raw) => {
  const pointer = raw as PointerEvent;
  if (dragging || pointer.button !== 0) return;
  if (!Number.isFinite(pointer.screenX) || !Number.isFinite(pointer.screenY)) return;
  if (!Number.isFinite(window.screenX) || !Number.isFinite(window.screenY)) return;
  dragging = true;
  crossedThreshold = false;
  capturedPointer = pointer.pointerId;
  initialScreenX = pointer.screenX;
  initialScreenY = pointer.screenY;
  captureGeneration += 1;
  grabX = pointer.screenX - window.screenX;
  grabY = pointer.screenY - window.screenY;
  cancelPendingMove();
  transparency?.pause();
  gaze?.pause(true);
  renderer.pause();
  void window.firefly.setInteractive(true);
  try { (pointer.target as Element).setPointerCapture(pointer.pointerId); }
  catch { /* 失败时维持现有流程。 */ }
});
addTrackedEventListener(surface, "canvas:pointermove", "pointermove", (raw) => {
  const pointer = raw as PointerEvent;
  if (!dragging || pointer.pointerId !== capturedPointer) return;
  if (!crossedThreshold && Math.hypot(pointer.screenX - initialScreenX, pointer.screenY - initialScreenY) > 5) {
    crossedThreshold = true;
    window.firefly.setDragging(true);
    void showDragOverlay(captureGeneration);
  }
  if (crossedThreshold) scheduleMoveTo(pointer.screenX, pointer.screenY);
});
addTrackedEventListener(surface, "canvas:pointerup", "pointerup", (raw) => {
  const pointer = raw as PointerEvent;
  if (!dragging || pointer.pointerId !== capturedPointer) return;
  const wasMoved = crossedThreshold;
  if (wasMoved) scheduleMoveTo(pointer.screenX, pointer.screenY);
  if (moveFrame !== null) { cancelAnimationFrame(moveFrame); moveFrame = null; }
  flushMove();
  finishDrag();
  try { (pointer.target as Element).releasePointerCapture(pointer.pointerId); }
  catch { /* 失败时维持现有流程。 */ }
  const bounds = surface.getBoundingClientRect();
  const outside = pointer.clientX < bounds.left || pointer.clientX > bounds.right || pointer.clientY < bounds.top || pointer.clientY > bounds.bottom;
  if (outside) void window.firefly.setInteractive(false);
});
