import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import chinese from "./zh-CN.json";
import english from "./en.json";

// Every key the settings window passes to t() as a literal must name a string in both dictionaries.
// A key that names a group of keys renders "key '…' returned an object instead of string." in the panel.

const settingsRoot = join(__dirname, "..");
const LITERAL_KEY = /\bt\(\s*["'`](settings\.[A-Za-z0-9_.-]+)["'`]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function lookup(dictionary: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), dictionary);
}

const usages = sourceFiles(settingsRoot).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(LITERAL_KEY)].map((match) => ({ file: relative(settingsRoot, file), key: match[1] })));

describe("settings translation keys", () => {
  it("finds the literal keys it checks", () => {
    expect(usages.length).toBeGreaterThan(100);
  });

  const broken = (dictionary: unknown, accepts: (value: unknown) => boolean) => [...new Set(usages
    .filter(({ key }) => !accepts(lookup(dictionary, key)))
    .map(({ file, key }) => `${file}: ${key} → ${typeof lookup(dictionary, key)}`))];

  it("resolve to strings in zh-CN, the fallback language", () => {
    expect(broken(chinese, (value) => typeof value === "string")).toEqual([]);
  });

  // English still lacks some keys; i18next falls back to zh-CN for those. A key naming an object is broken in either language.
  it("never resolve to a group of keys in en", () => {
    expect(broken(english, (value) => value === undefined || typeof value === "string")).toEqual([]);
  });
});
