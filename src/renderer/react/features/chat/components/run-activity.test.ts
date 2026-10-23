import { expect, test } from "vitest";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";

test("adds live reasoning to accumulated time, then freezes at completion", () => {
  const running = { startedAt: 400, reasoningMs: 2400, activeReasoningStartedAt: 6400 };
  expect(resolveRunActivitySnapshot(running, 8400))
    .toStrictEqual({ processing: true, reasoningMs: 4400, processingMs: 8000 });
  expect(resolveRunActivitySnapshot({ startedAt: 400, reasoningMs: 4400, completedAt: 12400 }, 90000))
    .toStrictEqual({ processing: false, reasoningMs: 4400, processingMs: 12000 });
});

test("completed panels fold except for abnormal runs or explicit user choices", () => {
  const live = { startedAt: 900, reasoningMs: 0 };
  const done = { ...live, completedAt: 1900 };
  expect(resolveRunActivityExpanded({}, "job", live)).toBe(true);
  expect(resolveRunActivityExpanded({}, "job", done)).toBe(false);
  expect(resolveRunActivityExpanded({ job: false }, "job", live)).toBe(false);
  expect(resolveRunActivityExpanded({}, "job", { ...done, keepExpanded: true })).toBe(true);
  expect(resolveRunActivityExpanded({ job: true }, "job", done)).toBe(true);
  expect(shouldAutoCollapseRunActivity(true, false)).toBe(true);
});

test.each([
  [true, false, false, true], [true, false, true, false],
  [false, false, false, false], [true, true, false, false], [false, true, false, false],
])("collapse transition %s -> %s with keepExpanded=%s", (before, after, keep, expected) => {
  expect(shouldAutoCollapseRunActivity(before, after, keep)).toBe(expected);
});

test.each([[62300, "1分2秒"], [700, "0秒"], [999, "0秒"], [1000, "1秒"],
  [59999, "59秒"], [60000, "1分0秒"], [-20, "0秒"]])("formats %s milliseconds", (time, expected) => {
  expect(formatElapsed(time as number)).toBe(expected);
});
