// @vitest-environment jsdom
import { expect, it } from "vitest";
import { applyUiColors, connectUiColors } from "./colors";
it("applies custom colors and removes overrides on reset", () => {
  applyUiColors({ enabled: true, accent: "#123456", background: "#ffffff", foreground: "#222222" });
  expect(document.documentElement.style.getPropertyValue("--ff-accent")).toBe("#123456");
  applyUiColors({ enabled: false });
  expect(document.documentElement.style.getPropertyValue("--ff-accent")).toBe("");
  expect(document.documentElement.dataset.uiColors).toBeUndefined();
});
it("does not let an initial stale read overwrite a live color change", async () => {
  let resolve!: (value: unknown) => void; let listener!: (value: unknown) => void;
  const dispose = connectUiColors({ getColors: () => new Promise(done => { resolve = done; }), onColorsChanged: fn => { listener = fn; return () => {}; } });
  listener({ enabled: true, accent: "#654321" });
  resolve({ enabled: true, accent: "#123456" }); await Promise.resolve();
  expect(document.documentElement.style.getPropertyValue("--ff-accent")).toBe("#654321");
  dispose();
});
