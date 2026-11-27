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

describe("default dark chat content is neutral", () => {
  const scope = ':root[data-ui-theme="firefly-dark"]:not([data-ui-colors])';
  const neutralSection = glowCss.slice(glowCss.indexOf("/* ===== Default dark: emerald is for primary buttons"));
  const rules = [...neutralSection.matchAll(/^(:root[^{}]*)\{([^}]*)\}/gm)].map(match => ({ selector: match[1].trim(), body: match[2] }));

  it("has a neutral section to inspect, and every rule in it is scoped to the default dark theme", () => {
    expect(rules.length).toBeGreaterThan(10);
    for (const { selector } of rules) {
      for (const part of selector.split(/,\s*(?=:root)/)) expect(part.trim().startsWith(scope), part).toBe(true);
    }
  });

  it("paints the user's own bubble and the inserted-while-running bubble in a lifted neutral grey with normal text", () => {
    expect(token(tokensCss, "--ff-dark-main-user-bubble")).toBe("#303030");
    for (const needle of [".ff-message--user .ant-bubble-content", ".ff-run-activity__insertion"]) {
      const found = rules.find(item => item.selector.endsWith(needle));
      expect(found, needle).toBeDefined();
      expect(found!.body, needle).toContain("background: var(--ff-dark-main-user-bubble)");
      expect(found!.body, needle).toContain("color: var(--ff-text)");
    }
  });

  it("shows file references, links and file-type icons as normal or muted text, not emerald", () => {
    expect(neutralSection).toMatch(/\.ff-file-link,\s*:root[^{]*\.ff-file-link:hover \{ color: var\(--ff-text\); \}/);
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

describe("settings window uses only tokens its own stylesheets define", () => {
  const sheets = [...settingsHtml.matchAll(/href="(\.{1,2}\/[^"]+\.css)"/g)].map(match => match[1]);
  const loaded = sheets.map(href => read(href)).join("\n");
  const settingsMainRules = systemCss.split("\n").filter(line => /\.settings-main\b/.test(line) && /background/.test(line) && /:not\(\[data-ui-colors\]\)/.test(line));

  it("loads the shared theme sheet and the settings sheets, but not the React root sheet", () => {
    expect(sheets).toEqual(expect.arrayContaining(["../ui/theme.css", "./settings-system.css", "./settings-controls.css"]));
    expect(sheets.some(href => href.includes("react-root"))).toBe(false);
  });

  it("resolves the default dark settings-main background to #1f1f1f from the loaded sheets, in normal mode", () => {
    expect(settingsMainRules.length).toBeGreaterThanOrEqual(1);
    const normal = settingsMainRules.find(rule => !rule.includes("data-glass"));
    expect(normal, "normal-mode rule").toBeDefined();
    expect(normal).not.toContain("--ff-bg-workspace");
    expect(normal!.match(/var\((--[a-z0-9-]+)\)/)![1]).toBe("--rb-bg-2");
    // The token must be declared by a loaded sheet, on a selector that matches the document root in the settings window.
    const declared = [...loaded.matchAll(/^((?:html)?\[data-ui-theme="firefly-dark"\]) \{([^}]*)\}/gm)].map(match => token(match[2], "--rb-bg-2")).filter(Boolean);
    expect(declared).toEqual(["#1f1f1f"]);
  });

  it("uses the same loaded token for the glass-mode content area", () => {
    const glass = block(systemCss, ':root[data-glass="true"][data-ui-theme="firefly-dark"]:not([data-ui-colors]) .settings-shell .settings-main');
    expect(glass).toContain("var(--rb-bg-2) var(--st-main-alpha)");
    expect(glass).not.toContain("--ff-bg-workspace");
  });

  it("no longer references --ff-bg-workspace anywhere in the settings stylesheets", () => {
    expect(systemCss).not.toContain("--ff-bg-workspace");
    expect(controlsCss).not.toContain("--ff-bg-workspace");
  });
});

describe("custom colours keep the previous glass behaviour", () => {
  it("applies the 92/92/90 glass alphas to default dark only", () => {
    const def = block(systemCss, ':root[data-glass="true"][data-ui-theme="firefly-dark"]:not([data-ui-colors]) .settings-shell,\n:root[data-glass="true"][data-ui-theme="firefly-dark"]:not([data-ui-colors]) .ff-modal-overlay');
    expect([token(def, "--st-win-alpha"), token(def, "--st-main-alpha"), token(def, "--st-card-alpha")]).toEqual(["92%", "92%", "90%"]);
    expect(systemCss).not.toContain(':root[data-glass="true"][data-ui-theme="firefly-dark"] .settings-shell,\n:root[data-glass="true"][data-ui-theme="firefly-dark"] .ff-modal-overlay {\n  --st-win-alpha');
  });

  it("restores 90% content and 78% card opacity with the accent card fill and accent radial for custom colours", () => {
    const custom = block(systemCss, ':root[data-glass="true"][data-ui-theme="firefly-dark"][data-ui-colors] .settings-shell,\n:root[data-glass="true"][data-ui-theme="firefly-dark"][data-ui-colors] .ff-modal-overlay');
    expect(token(custom, "--st-main-alpha")).toBe("90%");
    expect(token(custom, "--st-card-alpha")).toBe("78%");
    expect(custom).not.toContain("--st-win-alpha");
    expect(custom).toContain("var(--rb-pink-400) 8%");
    const main = block(systemCss, ':root[data-glass="true"][data-ui-theme="firefly-dark"][data-ui-colors] .settings-shell .settings-main');
    expect(main).toContain("radial-gradient(900px 420px at 100% 0%");
    expect(main).toContain("var(--rb-bg-1) var(--st-main-alpha)");
  });
});

describe("default dark settings surfaces have no emerald background", () => {
  it("paints the selected retrieval model card with a white veil, scoped to default dark", () => {
    const rule = block(controlsCss, ':root[data-ui-theme="firefly-dark"]:not([data-ui-colors]) .settings-shell .rag-model-card.is-active');
    expect(rule).toContain("background: var(--rb-active-light)");
    expect(rule).not.toMatch(/--ff-glow|--ff-accent|16, 185, 129/);
    expect(token(darkRb, "--rb-active-light")).toMatch(/^rgba\(255, 255, 255, /);
    expect(block(controlsCss, ":root .settings-shell .rag-model-card.is-active")).toContain("--ff-glow");
  });

  it("paints the memory graph canvas with the plain card colour, scoped to default dark", () => {
    const rule = block(systemCss, ':root[data-ui-theme="firefly-dark"]:not([data-ui-colors]) #memory-panel .memory-graph-wrap');
    expect(rule).toContain("background: var(--rb-card-bg)");
    expect(rule).not.toMatch(/radial-gradient|--ff-glow/);
    expect(token(darkRb, "--rb-card-bg")).toBe("#2a2a2a");
    expect(block(systemCss, "#memory-panel .memory-graph-wrap")).toContain("--ff-glow-rgb");
  });
});
