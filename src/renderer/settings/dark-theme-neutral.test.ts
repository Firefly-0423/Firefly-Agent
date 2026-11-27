import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The default dark theme ("深色 · 流萤") is neutral grey-black layers; emerald is kept for primary actions only.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const themeCss = read("../ui/theme.css");
const rootCss = read("../react/styles/react-root.css");
const systemCss = read("./settings-system.css");

const block = (css: string, selector: string) => {
  const from = css.indexOf(`${selector} {`);
  expect(from, `${selector} block`).toBeGreaterThanOrEqual(0);
  return css.slice(from, css.indexOf("\n}", from));
};
const token = (body: string, name: string) => body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? "";
const isNeutralHex = (value: string) => /^#([0-9a-f]{2})\1\1$/i.test(value);

const darkRb = block(themeCss, '[data-ui-theme="firefly-dark"]');
const darkRoot = block(rootCss, ':root[data-ui-theme="firefly-dark"]');

describe("default dark theme palette", () => {
  it.each(["--rb-bg-0", "--rb-bg-1", "--rb-bg-2", "--rb-bg-3", "--rb-bg-elevated", "--rb-card-bg", "--rb-input-bg", "--rb-text-strong", "--rb-text-default", "--rb-text-muted", "--rb-text-faint"])(
    "%s is a pure grey with no green cast", name => {
      expect(isNeutralHex(token(darkRb, name)), `${name}: ${token(darkRb, name)}`).toBe(true);
    });

  it.each(["--ff-bg-page", "--ff-bg-workspace", "--ff-bg-subtle", "--ff-rail", "--ff-surface", "--ff-popover", "--ff-text", "--ff-text-secondary", "--ff-text-muted"])(
    "%s is a pure grey with no green cast", name => {
      expect(isNeutralHex(token(darkRoot, name)), `${name}: ${token(darkRoot, name)}`).toBe(true);
    });

  it("layers the frame darkest, the conversation panel one step up and cards one more", () => {
    const grey = (value: string) => parseInt(value.slice(1, 3), 16);
    expect(grey(token(darkRoot, "--ff-rail"))).toBe(grey(token(darkRoot, "--ff-bg-page")));
    expect(grey(token(darkRoot, "--ff-bg-workspace"))).toBeGreaterThan(grey(token(darkRoot, "--ff-bg-page")));
    expect(grey(token(darkRoot, "--ff-surface"))).toBeGreaterThan(grey(token(darkRoot, "--ff-bg-workspace")));
  });

  it("hover, selection and borders are white veils, not accent tints", () => {
    for (const name of ["--ff-bg-hover", "--ff-bg-active", "--ff-border"]) expect(token(darkRoot, name), name).toMatch(/^rgba\(255, 255, 255, /);
    for (const name of ["--rb-active-light", "--rb-hover-light", "--rb-border-soft", "--rb-pink-50", "--rb-pink-100"]) expect(token(darkRb, name), name).toMatch(/^rgba\(255, 255, 255, /);
  });

  it("keeps a near-black label on the emerald primary buttons", () => {
    expect(token(darkRb, "--rb-text-on-pink")).toBe("#0a0a0a");
    expect(token(darkRoot, "--ff-on-accent")).toBe("#0a0a0a");
    expect(token(darkRoot, "--ff-primary-bg")).toBe("#10b981");
  });

  it("turns the accent-derived tints white only while custom colours are off", () => {
    expect(rootCss).toContain(':root[data-ui-theme="firefly-dark"]:not([data-ui-colors]) {\n  --ff-accent-rgb: 255, 255, 255;');
    expect(themeCss).toContain('html[data-ui-theme="firefly-dark"]:not([data-ui-colors]) {\n  --rb-accent-rgb: 255, 255, 255;');
  });

  it("no longer paints selected rows in the settings window, the activity bar or the session list with emerald", () => {
    expect(themeCss).not.toMatch(/\.settings-shell \{[^}]*(16, 185, 129|#6ee7b7)/);
    expect(themeCss).not.toMatch(/ff-activity-rail__item\[aria-current="page"\] \{[^}]*(16, 185, 129|#6ee7b7)/);
    expect(themeCss).not.toMatch(/ant-conversations-item-active \{[^}]*16, 185, 129/);
  });
});

describe("dark settings window background", () => {
  it("has no hard-coded green gradient", () => {
    expect(systemCss).not.toMatch(/27,\s*58,\s*45/);
    expect(systemCss).not.toMatch(/13,\s*22,\s*18/);
    const glassDark = systemCss.split("\n").filter(line => /data-glass="true"\]\[data-ui-theme="firefly-dark"\]/.test(line) || /--st-win-bg/.test(line));
    expect(glassDark.join("\n")).not.toMatch(/--st-win-bg:\s*linear-gradient/);
  });

  it("is a flat surface made from the neutral frame token, with no accent radial in the default dark theme", () => {
    expect(systemCss).toMatch(/--st-win-bg: color-mix\(in srgb, var\(--rb-bg-1\) var\(--st-win-alpha\), transparent\);/);
    const defaultGlassMain = block(systemCss, ':root[data-glass="true"][data-ui-theme="firefly-dark"]:not([data-ui-colors]) .settings-shell .settings-main');
    expect(defaultGlassMain).not.toContain("radial-gradient");
    expect(defaultGlassMain).not.toContain("--rb-pink-400");
  });

  it("tints the selected nav item with a white veil and normal text", () => {
    const neutral = block(systemCss, ':root[data-ui-theme="firefly-dark"]:not([data-ui-colors]) .settings-shell,\n:root[data-ui-theme="firefly-dark"]:not([data-ui-colors]) .ff-modal-overlay');
    expect(token(neutral, "--st-selected-fill")).toBe("rgba(255, 255, 255, 0.09)");
    expect(token(neutral, "--st-selected-text")).toBe("var(--rb-text-strong)");
    expect(token(neutral, "--st-nav-hover")).toBe("rgba(255, 255, 255, 0.06)");
  });

  it("keeps the accent-mixed selection for custom colours", () => {
    const custom = block(systemCss, ':root[data-ui-theme="firefly-dark"][data-ui-colors] .settings-shell,\n:root[data-ui-theme="firefly-dark"][data-ui-colors] .ff-modal-overlay');
    expect(token(custom, "--st-selected-fill")).toContain("var(--rb-pink-400)");
  });
});
