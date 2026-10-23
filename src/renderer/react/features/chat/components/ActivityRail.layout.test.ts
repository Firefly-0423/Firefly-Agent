import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../../styles/react-root.css"), "utf8");

it("never lays the sidebar overlay or its hover strip over the activity rail", () => {
  const rail = "left: calc(var(--ff-workspace-gutter) + 48px)";
  // The folded sidebar, the hover strip that unfolds it, and the narrow-window overlay all start right of the rail.
  expect(css.match(/\.ff-page-sidebar\.is-floating \{[^}]*\}/)?.[0]).toContain(rail);
  expect(css.match(/\.ff-page-edge \{[^}]*\}/)?.[0]).toContain(rail);
  const narrow = css.slice(css.indexOf("@media (max-width: 900px) {"));
  expect(narrow.match(/\.ff-page-sidebar \{[^}]*\}/)?.[0]).toContain(rail);
});
