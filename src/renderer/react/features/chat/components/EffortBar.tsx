// 推理档位条：一根发光的流体条，从左填到当前档，里面有一串向右流动的光点，档位越高越密越快；
// 珍珠白的圆把手完整落在条内，每档一个小点，条下是各档的名字。
// 点击或拖动都会吸附到最近的一档，松手才提交；换档时把手处荡开一圈光，光点也会短暂加速。
// 键盘：← → / ↑ ↓ 逐档移动，Home / End 到两端，直接提交。
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { motionReduced } from "../../../../ui/appearance-prefs";
import { stepSparks, type Spark } from "./effort-sparks";
import "./EffortBar.css";

/** Knob diameter and the padding that keeps it inside the bar. */
export const KNOB = 26;
const PAD = 1;
/** How long the sparks rush after a level change, and how much faster. */
const BURST_MS = 650;
const BURST = 2.6;

/** Centre of stop `index` as a fraction of the usable width (the bar minus one knob). */
export function stopFraction(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1);
}

/** Nearest allowed stop to a pointer x inside a bar of `width`; disabled stops are skipped. */
export function nearestStop(x: number, width: number, count: number, disabled: readonly boolean[] = []): number {
  const usable = Math.max(1, width - KNOB - PAD * 2);
  const fraction = Math.min(1, Math.max(0, (x - PAD - KNOB / 2) / usable));
  const exact = fraction * (count - 1);
  let best = -1;
  for (let index = 0; index < count; index += 1) {
    if (disabled[index]) continue;
    if (best < 0 || Math.abs(index - exact) < Math.abs(best - exact)) best = index;
  }
  return Math.max(0, best);
}

const stopLeft = (index: number, count: number) => `calc(${PAD}px + ${KNOB / 2}px + (100% - ${KNOB + PAD * 2}px) * ${stopFraction(index, count)})`;

/** Draws the sparks on a canvas the size of the bar, clipped to the lit part, so they only show where the bar is filled. */
function useSparks(canvas: RefObject<HTMLCanvasElement | null>, level: number, burstAt: number) {
  const state = useRef({ level, burstAt });
  state.current = { level, burstAt };
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext?.("2d");
    if (!element || !context) return;
    let sparks: Spark[] = [], frame = 0, last = performance.now(), width = 0, height = 0;
    const resize = () => {
      const box = element.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      width = box.width; height = box.height;
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const color = () => getComputedStyle(element).getPropertyValue("--ff-effort-spark").trim() || "255, 255, 255";
    const draw = () => {
      context.clearRect(0, 0, width, height);
      const rgb = color();
      for (const spark of sparks) {
        const tail = context.createLinearGradient(spark.x - spark.length, spark.y, spark.x, spark.y);
        tail.addColorStop(0, `rgba(${rgb}, 0)`);
        tail.addColorStop(1, `rgba(${rgb}, ${spark.alpha})`);
        context.strokeStyle = tail;
        context.lineWidth = spark.size;
        context.lineCap = "round";
        context.beginPath(); context.moveTo(spark.x - spark.length, spark.y); context.lineTo(spark.x, spark.y); context.stroke();
        context.fillStyle = `rgba(${rgb}, ${Math.min(1, spark.alpha + 0.25)})`;
        context.beginPath(); context.arc(spark.x, spark.y, spark.size * 0.9, 0, Math.PI * 2); context.fill();
      }
    };
    resize();
    sparks = stepSparks([], 0, width, height, state.current.level).map((spark) => ({ ...spark, x: Math.random() * width }));
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
    observer?.observe(element);
    const tick = (now: number) => {
      const seconds = Math.min(0.05, (now - last) / 1000); last = now;
      const boost = now - state.current.burstAt < BURST_MS ? BURST : 1;
      if (!document.hidden) { sparks = stepSparks(sparks, seconds, width, height, state.current.level, boost); draw(); }
      frame = requestAnimationFrame(tick);
    };
    // Reduced motion (the user's appearance choice or the system's) shows one still frame; the loop follows the
    // preference when it changes while the bar is open.
    const follow = () => {
      cancelAnimationFrame(frame); frame = 0;
      if (motionReduced()) { draw(); return; }
      last = performance.now(); frame = requestAnimationFrame(tick);
    };
    const preference = typeof MutationObserver === "function" ? new MutationObserver(follow) : undefined;
    preference?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    const system = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    system?.addEventListener?.("change", follow);
    follow();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); preference?.disconnect(); system?.removeEventListener?.("change", follow); };
  }, [canvas]);
}

export function EffortBar({ count, value, disabled = [], labels, label, onPreview, onCommit }: {
  count: number;
  value: number;
  disabled?: readonly boolean[];
  /** Short name under each stop; clicking one chooses it. */
  labels?: readonly string[];
  label: string;
  /** While dragging: the stop under the pointer, so the title can follow. */
  onPreview?(index: number | null): void;
  onCommit(index: number): void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [burst, setBurst] = useState({ at: -Infinity, key: 0 });
  const shown = dragging ?? value;
  const offset = `calc(${PAD}px + (100% - ${KNOB + PAD * 2}px) * ${stopFraction(shown, count)})`;
  const lit = `calc(${offset} + ${KNOB}px + ${PAD}px)`;
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value) setBurst((last) => ({ at: performance.now(), key: last.key + 1 }));
    previous.current = value;
  }, [value]);
  useSparks(canvasRef, stopFraction(shown, count), burst.at);

  const stopAt = (clientX: number) => {
    const box = barRef.current!.getBoundingClientRect();
    return nearestStop(clientX - box.left, box.width, count, disabled);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const index = stopAt(event.clientX);
    setDragging(index);
    onPreview?.(index);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    const index = stopAt(event.clientX);
    if (index !== dragging) { setDragging(index); onPreview?.(index); }
  };
  /** Release commits the stop under the pointer; a cancelled drag (the system took the pointer) puts everything back. */
  const finish = (commit: boolean) => {
    if (dragging === null) return;
    const index = dragging;
    setDragging(null);
    onPreview?.(null);
    if (commit && index !== value) onCommit(index);
  };
  const step = (from: number, direction: 1 | -1) => {
    for (let index = from + direction; index >= 0 && index < count; index += direction) if (!disabled[index]) return index;
    return from;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? step(value, 1)
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? step(value, -1)
        : event.key === "Home" ? step(-1, 1) : event.key === "End" ? step(count, -1) : null;
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onCommit(next);
  };

  return (
    <div className="ff-effort-scale">
      <div ref={barRef} className={`ff-effort-bar${dragging !== null ? " is-dragging" : ""}`}
        style={{ "--ff-effort-level": stopFraction(shown, count) } as CSSProperties}
        role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={shown}
        aria-valuetext={labels?.[shown]}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onKeyDown={onKeyDown}>
        <span className="ff-effort-bar__fill" style={{ width: lit }} />
        <canvas ref={canvasRef} className="ff-effort-bar__sparks" aria-hidden="true" style={{ clipPath: `inset(0 calc(100% - ${lit}) 0 0 round 999px)` }} />
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={`ff-effort-bar__dot${index <= shown ? " is-filled" : ""}${disabled[index] ? " is-disabled" : ""}`}
            style={{ left: stopLeft(index, count) }} />
        ))}
        <span className="ff-effort-bar__knob" style={{ left: offset }}>
          {burst.key > 0 && <span key={burst.key} className="ff-effort-bar__ripple" aria-hidden="true" />}
        </span>
      </div>
      {labels && (
        <div className="ff-effort-scale__ticks" aria-hidden="true">
          {labels.map((name, index) => (
            <button type="button" tabIndex={-1} key={index} disabled={disabled[index]}
              className={`ff-effort-scale__tick${index === shown ? " is-active" : ""}`} style={{ left: stopLeft(index, count) }}
              onClick={() => { if (index !== value) onCommit(index); }}>{name}</button>
          ))}
        </div>
      )}
    </div>
  );
}
