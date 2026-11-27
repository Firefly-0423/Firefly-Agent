import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The default dark theme ("深色 · 流萤") is neutral grey-black layers; emerald is kept for primary actions only.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const themeCss = read("../ui/theme.css");
const rootCss = read("../react/styles/react-root.css");
const systemCss = read("./settings-system.css");
const glowCss = read("../ui/glow.css");
const tokensCss = read("../ui/tokens.css");
const controlsCss = read("./settings-controls.css");
const settingsHtml = read("./index.html");
const messagesCss = read("../react/features/chat/components/ChatMessageList.css");

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

describe("default dark chat content", () => {
  const scope = ':root[data-ui-theme="firefly-dark"]:not([data-ui-colors])';
  const from = glowCss.indexOf("/* ===== Default dark: emerald is for primary buttons");
  const split = glowCss.indexOf("/* ===== Default dark: the two deliberate emerald spots");
  const neutralSection = glowCss.slice(from, split);
  const emeraldSection = glowCss.slice(split);
  const parse = (css: string) => [...css.matchAll(/^(:root[^{}]*)\{([^}]*)\}/gm)].map(match => ({ selector: match[1].trim(), body: match[2] }));
  const rules = parse(neutralSection);
  const emeraldRules = parse(emeraldSection);

  it("has both sections to inspect, and every rule in them is scoped to the default dark theme", () => {
    expect(rules.length).toBeGreaterThan(10);
    expect(emeraldRules.length).toBeGreaterThan(5);
    for (const { selector } of [...rules, ...emeraldRules]) {
      for (const part of selector.split(/,\s*(?=:root)/)) expect(part.trim().startsWith(scope), part).toBe(true);
    }
  });

  it("paints the user's own bubble and the inserted-while-running bubble as a solid emerald pill with near-black text", () => {
    const found = emeraldRules.find(item => item.selector.includes(".ff-message--user .ant-bubble-content") && item.selector.includes(".ff-run-activity__insertion"));
    expect(found).toBeDefined();
    expect(found!.body).toContain("background: var(--ff-accent)");
    expect(found!.body).toContain("color: var(--ff-on-accent)");
    expect(token(darkRoot, "--ff-accent")).toBe("#10b981");
    expect(token(darkRoot, "--ff-on-accent")).toBe("#0a0a0a");
  });

  it("keeps links, inline code and file chips readable inside the emerald bubble", () => {
    expect(emeraldSection).toMatch(/\.ff-message--user :is\(\.ff-message-markdown[^{]*\{ color: inherit; \}/);
    expect(emeraldSection).toMatch(/\.ff-message--user \.ff-message-markdown :not\(pre\) > code \{ color: inherit; background: rgba\(0, 0, 0, 0\.14\); \}/);
    expect(emeraldSection).toMatch(/\.ff-message--user \.ff-file-link,[^{]*\{ color: inherit; \}/);
    expect(emeraldSection).toMatch(/\.ff-message--user:has\(\.ff-message__sticker:only-child\) \.ant-bubble-content \{ background: transparent; \}/);
  });

  it("shows file names and file links in emerald with an underline on hover", () => {
    const names = emeraldRules.find(item => item.selector.includes(".ff-file-link") && item.body.includes("color: var(--ff-accent)") && !item.selector.includes(":hover"));
    expect(names?.selector).toContain(".ff-file-change-card__base");
    expect(names?.selector).toContain(".ff-run-row--file .ff-run-row__head > strong");
    const hover = emeraldRules.find(item => item.selector.includes(".ff-file-link:hover"));
    expect(hover?.body).toContain("color: var(--ff-accent)");
    expect(hover?.body).toContain("text-decoration: underline");
  });

  it("keeps markdown links, file-type icons and highlight text neutral", () => {
    expect(neutralSection).toMatch(/\.ff-message-markdown a \{ color: var\(--ff-text\);/);
    expect(neutralSection).toMatch(/data-file-type="text"\]\) \.ff-run-file__icon \{ color: var\(--ff-text-muted\); \}/);
    expect(neutralSection).toMatch(/\.ff-file-preview__md-btn\.is-active \{ color: var\(--ff-text\);/);
  });

  it("uses no emerald literal or accent variable as a value in the neutral section", () => {
    const declarations = rules.map(item => item.body).join("\n");
    expect(declarations).not.toMatch(/16, 185, 129|#10b981|#6ee7b7|#34d399|#059669|--ff-accent\b|--ff-glow/);
  });

  it("leaves the custom-colour bubble on the user's accent with the computed on-accent text", () => {
    expect(messagesCss).toMatch(/:root\[data-ui-colors\] \.ff-message--user \.ant-bubble-content \{\s*background: var\(--ff-accent\);/);
    expect(messagesCss).toMatch(/:root\[data-ui-colors\] \.ff-message--user \.ant-bubble-content,[^{]*\{\s*color: var\(--rb-text-on-pink\);/);
  });

  it("keeps the success colour for completed status", () => {
    expect(neutralSection).toContain(".ff-task-delegation.is-completed .ff-task-delegation__marker { color: var(--ff-success); }");
  });
});
