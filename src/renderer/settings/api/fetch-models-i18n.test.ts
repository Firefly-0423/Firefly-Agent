import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(__dirname, "..");
const zh = JSON.parse(readFileSync(resolve(dir, "i18n/zh-CN.json"), "utf8")) as Record<string, unknown>;
const source = readFileSync(resolve(dir, "settings.ts"), "utf8");
const html = readFileSync(resolve(dir, "index.html"), "utf8");

const lookup = (path: string): unknown => path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), zh);

describe("settings page strings for the model-list fetch and reasoning levels", () => {
  it("every t() key the fetch handler uses resolves to a string", () => {
    const keys = [...source.matchAll(/t\("(settings\.panel\.api\.field\.model\.fetch\.[A-Za-z]+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const key of keys) expect(typeof lookup(key), key).toBe("string");
  });

  it("every data-i18n key on the new form resolves under the settings namespace", () => {
    const keys = [...html.matchAll(/data-i18n(?:-title|-aria-label)?="(panel\.api\.field\.model\.(?:fetch|reasoningLevels)\.[A-Za-z]+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) expect(typeof lookup(`settings.${key}`), key).toBe("string");
  });
});
