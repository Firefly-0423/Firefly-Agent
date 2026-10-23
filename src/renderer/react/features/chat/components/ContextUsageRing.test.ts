// @vitest-environment jsdom
import * as React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";

vi.mock("antd", () => ({
  Popover: ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) =>
    React.createElement("section", null, children, content),
}));
import { ContextUsageRing, RING_CIRCUMFERENCE, clampVisualRatio, computeUsageRatio,
  contextUsageCategoryMeta, contextUsageMoodMeta, formatTokenCount, resolveRingTone } from "./ContextUsageRing";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); document.head.replaceChildren(); });
const usage = (counts: Partial<Record<ContextUsageCategoryKey, number>>, capacity = 256000): ContextUsageSnapshot => ({
  phase: "terminal", contextWindowTokens: capacity, totalTokens: Object.values(counts).reduce((a, b) => a + b, 0),
  messageCount: 7, updatedAt: 54321,
  categories: (["conversation", "systemPrompt", "skills", "tools", "other", "runtimeAndToolLogs"] as ContextUsageCategoryKey[])
    .map(key => ({ key, tokens: counts[key] ?? 0 })),
});
const show = (snapshot?: ContextUsageSnapshot, extra: { sessionId?: string; busy?: boolean } = {}) => {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(ContextUsageRing, { usage: snapshot, ...extra }));
};
const arc = (html: string) => {
  const match = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(html);
  expect(match).not.toBeNull();
  return match!.slice(1).map(Number);
};

test.each([[0, "0"], [999, "999"], [1234, "1.2k"], [12345, "12.3k"], [123456, "123k"],
  [1000000, "1M"], [1500000, "1.5M"], [999700, "1M"], [2000000, "2M"], [NaN, "0"]])(
  "formats the public token counter at %s", (value, expected) => expect(formatTokenCount(value as number)).toBe(expected));

test("calculates occupancy separately from the bounded visual fraction", () => {
  expect(computeUsageRatio(12800, 256000)).toBeCloseTo(0.05);
  expect(computeUsageRatio(0, 100)).toBe(0);
  for (const [total, window] of [[100, 0], [100, -5], [NaN, 100], [100, NaN]]) {
    expect(Number.isNaN(computeUsageRatio(total, window))).toBe(true);
  }
  expect(clampVisualRatio(0.42)).toBeCloseTo(0.42);
  for (const [input, output] of [[1.18, 1], [-0.2, 0], [NaN, 0], [Infinity, 0]]) {
    expect(clampVisualRatio(input)).toBe(output);
  }
});

test.each([[0.05, "normal"], [0.69, "normal"], [0.7, "warm"], [0.89, "warm"],
  [0.9, "alert"], [1.4, "alert"], [NaN, "normal"]])("selects tone for occupancy %s", (ratio, expected) => {
  expect(resolveRingTone(ratio as number)).toBe(expected);
});

test("renders no placeholder without usage and a proportional arc for normal usage", () => {
  expect(show()).toBe("");
  const html = show(usage({ systemPrompt: 12800 }));
  expect(html).toContain("ff-context-usage-ring is-normal");
  expect(html).toContain("上下文 12.8k / 256k (5%)");
  const [length, circumference] = arc(html);
  expect(circumference).toBeCloseTo(RING_CIRCUMFERENCE);
  expect(length / circumference).toBeCloseTo(0.05, 2);
});

test.each([
  { tokens: 12800, tone: "normal", percent: 5 },
  { tokens: 184320, tone: "warm", percent: 72 },
  { tokens: 300000, tone: "alert", percent: 117 },
] as const)("shows honest percentages and the $tone text caption", ({ tokens, tone, percent }) => {
  const html = show(usage({ conversation: tokens }));
  expect(html).toContain("(" + percent + "%)");
  expect(html).toContain("ff-context-usage-ring is-" + tone);
  expect(html).toContain("ff-context-usage-menu__mood is-" + tone);
  expect(html).toContain(contextUsageMoodMeta()[tone].text);
  expect(html).not.toContain("context-usage/" + tone + ".png");
  if (tone === "alert") {
    const [length, circumference] = arc(html);
    expect(length).toBeCloseTo(RING_CIRCUMFERENCE);
    expect(length / circumference).toBeCloseTo(1);
  }
});

test.each([0, -1, NaN])("keeps absolute totals and shares when capacity is %s", (capacity) => {
  const html = show(usage({ systemPrompt: 1500 }, capacity));
  expect(html).toContain("ff-context-usage-ring__track");
  expect(html).not.toContain("ff-context-usage-ring__progress");
  expect(html).not.toContain("tokens (");
  expect(html).toContain("ff-context-usage-menu__share");
  expect(html).toContain(">100%</span>");
  expect(html).toContain("1.5k tokens");
});

test.each([
  { sessionId: undefined, busy: false, enabled: false },
  { sessionId: "usage-session", busy: false, enabled: true },
  { sessionId: "usage-session", busy: true, enabled: false },
])("enables compression only with an idle session: %j", ({ sessionId, busy, enabled }) => {
  const html = show(usage({ conversation: 12800 }), { sessionId, busy });
  document.body.innerHTML = html;
  expect(html).not.toContain("context-usage/compact.png");
  const button = document.querySelector<HTMLButtonElement>(".ff-context-usage-menu__mood-figure")!;
  expect(button.disabled).toBe(!enabled);
  expect(button.parentElement!.classList.contains("can-compact")).toBe(enabled);
  if (enabled) expect(html).toContain("ff-context-usage-menu__mood is-normal can-compact");
});

test("sorts nonzero categories and renders one overall bar plus descending-opacity shares", () => {
  const html = show(usage({ systemPrompt: 12800, tools: 51200, conversation: 12800 }));
  document.body.innerHTML = html;
  expect(html).toContain("上下文容量");
  expect(html).toContain("估算值（按字符折算），对话后自动刷新");
  expect(document.querySelectorAll(".ff-context-usage-menu__progress.is-normal")).toHaveLength(1);
  const meta = contextUsageCategoryMeta();
  const names = Array.from(document.querySelectorAll(".ff-context-usage-menu__name"), node => node.textContent);
  expect(names).toStrictEqual([meta.tools.label, meta.conversation.label, meta.systemPrompt.label]);
  for (const category of ["skills", "runtimeAndToolLogs", "other"] as const) expect(html).not.toContain(meta[category].label);
  expect(html).toContain("51.2k");
  expect(Array.from(document.querySelectorAll(".ff-context-usage-menu__share"), node => node.textContent))
    .toStrictEqual(["67%", "17%", "17%"]);
  expect(Array.from(document.querySelectorAll<HTMLElement>(".ff-context-usage-menu__dot"), node => node.style.opacity))
    .toStrictEqual(["1", "0.85", "0.7"]);
});

test("keeps the compression label horizontal with its hint on the next grid row", () => {
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync("src/renderer/react/features/chat/components/ContextUsageRing.css", "utf8");
  document.head.append(stylesheet);
  document.body.innerHTML = show(usage({ conversation: 400 }));
  const button = document.querySelector(".ff-context-usage-menu__mood-figure")!;
  const style = getComputedStyle(button);
  expect(style.whiteSpace).toBe("nowrap");
  expect(style.width).not.toMatch(/^\d+px$/);
  expect(style.fontSize).not.toBe("0px");
  expect(getComputedStyle(button.parentElement!).display).toBe("grid");
  expect(getComputedStyle(button.parentElement!).display).not.toBe("flex");
});
