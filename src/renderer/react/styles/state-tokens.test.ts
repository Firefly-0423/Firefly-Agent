import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guards the interaction-state tokens in react-root.css by computing real contrast ratios from the declared colours.
const css = fs.readFileSync(path.join(__dirname, "react-root.css"), "utf8");
const buttonCss = fs.readFileSync(path.join(__dirname, "../components/ui/Button.css"), "utf8");

const section = (start: string) => {
  const from = css.indexOf(start);
  return css.slice(from, css.indexOf("\n}", from));
};
const declared = (block: string) => Object.fromEntries([...block.matchAll(/--ff-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(match => [match[1], match[2]]));
const light = declared(section(":root {"));
const dark = { ...light, ...declared(section(':root[data-ui-theme="firefly-dark"] {')) };

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
// color-mix(in srgb, base N%, black)
const towardBlack = (color: Rgb, keepPercent: number): Rgb => color.map(c => Math.round(c * keepPercent / 100)) as Rgb;

const themes = { light, dark } as const;
const surfaces = ["bg-page", "bg-workspace", "surface", "popover"] as const;

describe.each(Object.entries(themes))("%s theme state tokens", (_name, theme) => {
  it.each(surfaces)("the keyboard focus ring has at least 3:1 contrast against %s", surface => {
    // --ff-focus-ring-color is var(--ff-accent), so the ring is the solid accent colour.
    expect(contrast(rgb(theme["accent"]), rgb(theme[surface]))).toBeGreaterThanOrEqual(3);
  });

  it.each(["bg-page", "bg-workspace"] as const)("the panel docking guide has at least 3:1 contrast against %s", surface => {
    expect(theme["drop-guide"]).toBeDefined();
    expect(contrast(rgb(theme["drop-guide"]!), rgb(theme[surface]))).toBeGreaterThanOrEqual(3);
  });

  it("primary button text keeps 4.5:1 contrast in the resting, hover and pressed states", () => {
    const base = rgb(theme["primary-bg"] ?? theme["accent-solid"]);
    const text = rgb(theme["on-accent"]);
    expect(contrast(text, base)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, towardBlack(base, 88))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, towardBlack(base, 78))).toBeGreaterThanOrEqual(4.5);
  });

  it("the primary button edge is distinguishable from the surface it sits on (3:1)", () => {
    const base = rgb(theme["primary-bg"] ?? theme["accent-solid"]);
    expect(contrast(base, rgb(theme["surface"]))).toBeGreaterThanOrEqual(3);
  });
});

describe("state token wiring", () => {
  it("the dark theme declares its own primary background", () => {
    expect(section(':root[data-ui-theme="firefly-dark"] {')).toContain("--ff-primary-bg:");
  });

  it("no focus-visible rule uses a translucent accent ring any more", () => {
    const translucent = css.split("\n").filter(line => line.includes(":focus-visible") && /outline:[^;]*rgba\(var\(--ff-accent-rgb\)/.test(line));
    expect(translucent).toEqual([]);
  });

  it("a zero-specificity baseline ring covers interactive elements that define none", () => {
    expect(css).toMatch(/:where\(button, a\[href\][^\n]*\):focus-visible\s*\{\s*outline: var\(--ff-focus-ring\);/);
  });
});

describe("focus ring placement", () => {
  const composerCss = fs.readFileSync(path.join(__dirname, "../features/chat/components/ChatComposer.css"), "utf8");
  const windowControlsCss = fs.readFileSync(path.join(__dirname, "../components/ui/WindowControls.css"), "utf8");

  it("the model-connection button draws its ring on the status dot, not on its mostly empty 24px hit area", () => {
    expect(css).toMatch(/\.ff-page-role \.ff-model-connection:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
    expect(css).toMatch(/\.ff-page-role \.ff-model-connection:focus-visible \.ff-model-connection__dot\s*\{[^}]*outline:\s*var\(--ff-focus-ring\)/);
  });

  it("window controls keep the ring inside the button because the three buttons touch", () => {
    expect(windowControlsCss).toMatch(/\.ff-page \.ff-winbtn:focus-visible\s*\{\s*outline-offset:\s*-\d+px;/);
  });

  it("the composer width does not animate, so it does not glide while a panel or the window edge is dragged", () => {
    const rule = composerCss.match(/\.ff-composer-stack\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("transition: transform");
    expect(rule).not.toMatch(/transition:[^;]*width/);
  });
});

describe("Button.css", () => {
  it.each([
    [":hover", /\.ff-btn:hover:not\(:disabled\)/],
    ["pressed (:active)", /\.ff-btn:active:not\(:disabled\)/],
    ["keyboard focus", /\.ff-btn:focus-visible\s*\{\s*outline: var\(--ff-focus-ring\)/],
    ["disabled", /\.ff-btn:disabled\s*\{[^}]*opacity: var\(--ff-disabled-opacity\)/],
    ["loading", /\.ff-btn\[aria-disabled="true"\]/],
    ["reduced motion", /@media \(prefers-reduced-motion: reduce\)/],
  ])("defines the %s state", (_label, pattern) => {
    expect(buttonCss).toMatch(pattern);
  });

  it("styles pointer states only for buttons that are neither disabled nor loading", () => {
    expect(buttonCss).not.toMatch(/\.ff-btn:hover\s*\{/);
    expect(buttonCss).not.toMatch(/\.ff-btn:active\s*\{/);
  });
});
