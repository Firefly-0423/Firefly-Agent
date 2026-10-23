// 新会话页背后的字符波纹：铺满一层很淡的等宽字母数字，鼠标移过时从指针处荡开一圈圈波纹，
// 波峰经过的字符变亮并换字，然后慢慢平息；鼠标不动时只剩底层几不可见的微光。
// - 颜色取主题的次要文字色，透明度很低，不抢内容；只在新会话页挂载，开始对话后就是默认背景；
// - 约 30 帧每秒，没有波纹时停止重绘，窗口不可见时暂停；系统"减少动态效果"时只画静止的底层；
// - 纯装饰：aria-hidden、不接收指针（指针位置从 window 上读）。
import { useEffect, useRef } from "react";
import "./CodeRain.css";

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CELL = 14;
const FRAME_MS = 33;
/** Ripple speed (px per ms), lifetime, ring thickness, and how often moving the pointer starts a new one. */
const RIPPLE_SPEED = 0.32;
const RIPPLE_LIFE_MS = 1700;
const RING_WIDTH = 26;
const SPAWN_EVERY_MS = 90;
const MAX_RIPPLES = 12;
/** Opacity of the resting glyphs and of a glyph on a ripple's crest. */
const REST_ALPHA = 0.05;
const CREST_ALPHA = 0.9;

export interface Ripple { x: number; y: number; born: number }

export function randomGlyph(random: () => number = Math.random): string {
  return GLYPHS[Math.floor(random() * GLYPHS.length)] ?? "a";
}

/** How strongly the ripples light a cell at (x, y) at time now: 0 at rest, up to 1 on a fresh crest. */
export function rippleIntensity(x: number, y: number, ripples: readonly Ripple[], now: number): number {
  let intensity = 0;
  for (const ripple of ripples) {
    const age = now - ripple.born;
    if (age < 0 || age > RIPPLE_LIFE_MS) continue;
    const radius = age * RIPPLE_SPEED;
    const offset = Math.hypot(x - ripple.x, y - ripple.y) - radius;
    const ring = Math.exp(-(offset * offset) / (2 * RING_WIDTH * RING_WIDTH));
    intensity = Math.max(intensity, ring * (1 - age / RIPPLE_LIFE_MS));
  }
  return intensity;
}

export function CodeRain({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let glyphs: string[] = [];
    let columns = 0;
    let rows = 0;
    let width = 0;
    let height = 0;
    let color = "rgb(128,128,140)";
    let glow = color;
    const ripples: Ripple[] = [];
    let lastSpawn = 0;
    let dirty = true;

    const readColor = () => {
      const style = getComputedStyle(canvas);
      color = style.color || color;
      // Glyphs on a ripple's crest take the theme's glow (teal); without one they only brighten.
      glow = style.getPropertyValue("--ff-code-rain-glow").trim() || color;
      dirty = true;
    };
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = `12px ui-monospace, "Cascadia Mono", Consolas, monospace`;
      context.textBaseline = "top";
      columns = Math.ceil(width / CELL);
      rows = Math.ceil(height / CELL);
      glyphs = Array.from({ length: columns * rows }, () => randomGlyph());
      readColor();
    };
    const draw = (now: number) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      ripples.splice(0, ripples.length, ...ripples.filter(ripple => now - ripple.born <= RIPPLE_LIFE_MS));
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = column * CELL;
          const y = row * CELL;
          const lit = ripples.length ? rippleIntensity(x + CELL / 2, y + CELL / 2, ripples, now) : 0;
          const index = row * columns + column;
          // A crest passing over a glyph flips it, which is what makes the ring read as moving text.
          if (lit > 0.55 && Math.random() < 0.25) glyphs[index] = randomGlyph();
          context.fillStyle = lit > 0.2 ? glow : color;
          context.globalAlpha = REST_ALPHA + (CREST_ALPHA - REST_ALPHA) * lit;
          context.fillText(glyphs[index]!, x, y);
        }
      }
      context.globalAlpha = 1;
      dirty = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reduced) return;
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      if (x < 0 || y < 0 || x > box.width || y > box.height) return;
      const now = performance.now();
      if (now - lastSpawn < SPAWN_EVERY_MS) return;
      lastSpawn = now;
      ripples.push({ x, y, born: now });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      dirty = true;
    };

    resize();
    draw(performance.now());
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { resize(); draw(performance.now()); });
    observer?.observe(canvas);
    const themeObserver = new MutationObserver(() => { readColor(); draw(performance.now()); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-theme", "data-theme", "class"] });
    if (reduced) return () => { observer?.disconnect(); themeObserver.disconnect(); };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    let frame = 0;
    let last = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      // Nothing moving: leave the resting layer as it is instead of redrawing it every frame.
      if (document.hidden || now - last < FRAME_MS || (!dirty && ripples.length === 0)) return;
      last = now;
      draw(now);
      if (ripples.length) dirty = true;
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      observer?.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={`ff-code-rain ${className ?? ""}`} aria-hidden="true" />;
}
