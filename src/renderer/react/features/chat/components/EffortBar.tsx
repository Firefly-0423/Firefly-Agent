// 推理档位条（仿 Codex）：一根粗圆角条，从左填色到当前档；白色圆把手在填色末端、完整落在条内；每档一个小点。
// 点击或拖动都会吸附到最近的一档，松手才提交；平时切换有平滑过渡，拖动时把手跟手不带延迟。
// 键盘：← → / ↑ ↓ 逐档移动，Home / End 到两端，直接提交。
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import "./EffortBar.css";

/** Knob diameter and the padding that keeps it inside the bar. */
export const KNOB = 26;
const PAD = 1;

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

export function EffortBar({ count, value, disabled = [], label, onPreview, onCommit }: {
  count: number;
  value: number;
  disabled?: readonly boolean[];
  label: string;
  /** While dragging: the stop under the pointer, so the title can follow. */
  onPreview?(index: number | null): void;
  onCommit(index: number): void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const offset = `calc(${PAD}px + (100% - ${KNOB + PAD * 2}px) * ${stopFraction(shown, count)})`;

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
    <div ref={barRef} className={`ff-effort-bar${dragging !== null ? " is-dragging" : ""}`}
      role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={shown}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onKeyDown={onKeyDown}>
      <span className="ff-effort-bar__fill" style={{ width: `calc(${offset} + ${KNOB}px + ${PAD}px)` }} />
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={`ff-effort-bar__dot${index <= shown ? " is-filled" : ""}${disabled[index] ? " is-disabled" : ""}`}
          style={{ left: `calc(${PAD}px + ${KNOB / 2}px + (100% - ${KNOB + PAD * 2}px) * ${stopFraction(index, count)})` }} />
      ))}
      <span className="ff-effort-bar__knob" style={{ left: offset }} />
    </div>
  );
}
