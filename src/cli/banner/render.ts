import { displayWidth } from "../util/width.js";
import { FIREFLY_LOGO_TEXT, FIREFLY_LOGO } from "./ascii.js";
import { MIN_BANNER_WIDTH, DEFAULT_BANNER_WIDTH, BANNER_LINES, ABOUT_LINES, type RenderOptions } from "./text.js";
import process from "node:process";

export { FIREFLY_LOGO };

export function resolveWidth(opts?: RenderOptions): number {
  if (opts?.width !== undefined) return Math.max(MIN_BANNER_WIDTH, opts.width);
  const terminalWidth = typeof process.stdout.columns === "number" ? process.stdout.columns : 0;
  return terminalWidth >= MIN_BANNER_WIDTH ? terminalWidth : DEFAULT_BANNER_WIDTH;
}

function textField(value: string, boxWidth: number): string {
  const capacity = boxWidth - 4;
  if (displayWidth(value) > capacity) {
    return [...value].slice(0, capacity - 1).join("").concat("…");
  }
  const remaining = capacity - displayWidth(value);
  const before = Math.floor(remaining / 2);
  return [" ".repeat(before), value, " ".repeat(remaining - before)].join("");
}

function drawFrame(content: readonly string[], columns: number): string {
  const horizontal = "─".repeat(columns - 2);
  const output = [`╭${horizontal}╮`];
  for (const value of content) output.push(`│ ${textField(value, columns)} │`);
  output.push(`╰${horizontal}╯`);
  return output.join("\n");
}

export function renderBanner(opts?: RenderOptions): string {
  const columns = resolveWidth(opts);
  return [FIREFLY_LOGO_TEXT, drawFrame(BANNER_LINES, columns)].join("\n\n");
}

export function renderAbout(opts?: RenderOptions): string {
  const columns = resolveWidth(opts);
  const greeting = renderBanner(opts);
  return [greeting, drawFrame(ABOUT_LINES, columns)].join("\n\n");
}
