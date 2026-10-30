import fs from "node:fs";
import path from "node:path";

/** The type scale from tokens.css, as token name → size (e.g. "--ff-fs-ui" → "13px"). */
export function typeScale(): ReadonlyMap<string, string> {
  const tokens = fs.readFileSync(path.resolve("src/renderer/ui/tokens.css"), "utf8");
  return new Map([...tokens.matchAll(/(--ff-fs-[a-z]+):\s*(\d+px);/g)].map((match) => [match[1]!, match[2]!]));
}

/** jsdom does not resolve var(): put each type-scale size in place of its token, for tests that read computed sizes. */
export function withTypeScale(css: string): string {
  const scale = typeScale();
  return css.replace(/var\((--ff-fs-[a-z]+)\)/g, (token, name: string) => scale.get(name) ?? token);
}
