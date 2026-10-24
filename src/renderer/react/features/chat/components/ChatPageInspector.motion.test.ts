import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./ChatPageInspector.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./ChatPageInspector.tsx", import.meta.url), "utf8");

describe("docked pane motion", () => {
  it("animates the group's panel widths only while the pane is opening or closing", () => {
    expect(css).toMatch(/\.ff-page-dock:has\(\.ff-chat-inspector\[data-dock-motion\]\) > \[data-panel\] \{\s*transition: flex-grow 220ms cubic-bezier\(0\.22, 1, 0\.36, 1\);\s*\}/);
    // Drag, keyboard and window resizing are not inside that gate, so they stay immediate.
    expect(css).not.toMatch(/\.ff-page-dock > \[data-panel\] \{[^}]*transition:\s*flex-grow/);
  });
  it("keeps the component's motion timing in step with the CSS width transition", () => {
    expect(source).toContain("const MOTION_MS = 220;");
    expect(css).toContain("220ms");
  });
  it("keeps a closing pane painted until its width has moved, then hides it at once in the DOM", () => {
    // The hidden attribute is immediate (RightInspector); a discrete display transition keeps it rendered for the motion.
    expect(css).toMatch(/\.ff-chat-inspector > \.ff-right-inspector \{[^}]*transition: display 220ms allow-discrete;/);
    expect(source).toContain("visible={visible}");
  });
  it("fades a closed pane out with the motion and gives it no transition when it is reopened", () => {
    expect(css).toMatch(/\.ff-chat-inspector\.is-closed \{\s*opacity: 0;\s*transition: opacity 160ms ease-out;\s*\}/);
    expect(source).toContain('visible ? "" : " is-closed"');
  });
  it("starts a freshly mounted pane from zero width so its entrance animates too", () => {
    expect(css).toMatch(/@starting-style\s*\{\s*\.ff-page-dock > \[data-panel\]:has\(\.ff-chat-inspector\) \{\s*flex-grow: 0 !important;/);
  });
  it("switches the width motion, the wrapper fade and the pane's display transition off for reduced-motion users", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.ff-page-dock > \[data-panel\],[\s\S]*\.ff-chat-inspector > \.ff-right-inspector \{\s*transition: none !important;/);
    expect(source).toContain("moving: !prefersReducedMotion()");
  });
  it("moves the pane by its width, never by transform, so native bounds are not chased mid-animation", () => {
    expect(css).not.toMatch(/translate|transform/);
  });
  it("drops the panel header and frame only when the browser is the single panel", () => {
    expect(css).toMatch(/\.ff-chat-inspector\.is-browser-only \.ff-inspector-pane__head \{ display: none; \}/);
    expect(css).toMatch(/\.ff-chat-inspector\.is-browser-only \.ff-inspector-pane \{ border: 0; border-radius: 0; \}/);
    expect(source).toContain("const browserOnly = tabs.length === 1 && tabs[0].id === \"browser\";");
  });
});
