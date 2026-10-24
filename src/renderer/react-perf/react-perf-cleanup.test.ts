import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("performance runs use the shipping renderer and its supported Markdown packages", () => {
  const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  const dependencies = JSON.parse(readFileSync(fromHere("../../../package.json"), "utf8")).dependencies;
  for (const packageName of ["katex", "streamdown", "@streamdown/math"]) {
    expect(dependencies[packageName]).toBeDefined();
  }
  expect(dependencies["@ant-design/x-markdown"]).toBeUndefined();
  const harness = readFileSync(fromHere("../../../scripts/perf/chat-renderer-baseline.mjs"), "utf8");
  expect(harness).not.toContain("paired-control");
  for (const suffix of ["css", "test.ts", "tsx", "state.test.ts"]) {
    const name = suffix === "state.test.ts" ? "streamdown-spike-state.test.ts" : "streamdown-spike." + suffix;
    expect(existsSync(fromHere("./" + name))).toBe(false);
  }
});
