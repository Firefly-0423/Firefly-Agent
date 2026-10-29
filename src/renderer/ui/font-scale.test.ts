import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { typeScale } from "../../test-utils/type-scale";

const ROOT = path.resolve("src/renderer");
// Artwork rather than text: the weather card's big temperature numbers.
const ALLOWED = new Set(["react/features/chat/components/weather/weather-card.css 60px", "react/features/chat/components/weather/weather-card.css 50px"]);

function stylesheets(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

it("defines the seven-step type scale", () => {
  expect([...typeScale().values()]).toEqual(["12px", "13px", "14px", "16px", "18px", "22px", "26px"]);
});

it("sizes UI text only from the type scale", () => {
  const stray: string[] = [];
  for (const file of stylesheets(ROOT)) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // A pixel font size, either on its own or as the size in a font shorthand. A var() fallback such as
    // var(--ff-chat-font-size, 14px) is the default of a user setting and does not match.
    for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?px)|font:\s*(?:(?:italic|normal|bold|[1-9][05]0)\s+)*(\d+(?:\.\d+)?px)/g)) {
      const size = match[1] ?? match[2]!;
      if (!ALLOWED.has(`${relative} ${size}`)) stray.push(`${relative}: ${match[0]}`);
    }
  }
  expect(stray).toEqual([]);
});
