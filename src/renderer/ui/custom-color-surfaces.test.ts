import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { uiColorContrast, uiColorTokens } from "../../shared/ui-colors";

const files = ["ChatMessageList", "ConversationSidebar", "RightInspector", "RunExperience", "ReviewPanel", "ChatComposer", "FileTreePanel"] as const;
const styles = Object.fromEntries(files.map(name => [name, readFileSync(new URL(`../react/features/chat/components/${name}.css`, import.meta.url), "utf8") ]));
styles.BrowserWorkspacePanel = readFileSync(new URL("../react/features/chat/workspace/BrowserWorkspacePanel.css", import.meta.url), "utf8");
styles.root = readFileSync(new URL("../react/styles/react-root.css", import.meta.url), "utf8");

function declaration(file: string, selector: string, property: string): string {
  const dom = new JSDOM(`<style>${styles[file]}</style>`);
  const rules = Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[];
  const matches = rules.filter(rule => rule.selectorText?.split(",").map(value => value.trim()).includes(selector));
  const value = matches.map(rule => rule.style.getPropertyValue(property)).filter(Boolean).at(-1) ?? "";
  dom.window.close();
  return value;
}

const surfaces: [string, string, string][] = [
  ["BrowserWorkspacePanel", ".ff-browser-workspace__address input", "--ff-bg-workspace"],
  ["BrowserWorkspacePanel", ".ff-browser-workspace__toolbar button:hover:enabled", "--ff-bg-hover"],
  ["FileTreePanel", ".ff-file-preview__header", "--ff-bg-page"],
  ["ChatMessageList", '.ff-message-markdown [data-streamdown="table-wrapper"]', "--ff-bg-workspace"],
  ["ChatMessageList", '.ff-message-markdown [data-streamdown="table"] th', "--ff-bg-page"],
  ["ChatMessageList", ".ff-mermaid--fallback .ff-mermaid__source", "--ff-bg-page"],
  ["ChatMessageList", ".ff-svg-card--fallback .ff-svg-card__source", "--ff-bg-page"],
  ["ChatMessageList", ".ff-message-markdown-fallback", "--ff-bg-page"],
  ["ChatMessageList", ".ff-tool-executions__result", "--ff-bg-page"],
  ["ChatMessageList", ".ff-ask-user-qa__row", "--ff-bg-page"],
  ["ConversationSidebar", ".ff-conversation-list .ant-conversations-item-active", "--ff-bg-workspace"],
  ["ConversationSidebar", ".ff-session-rename-input", "--ff-bg-workspace"],
  ["ConversationSidebar", ".ff-session-rename-input input", "--ff-bg-workspace"],
  ["ConversationSidebar", ".ff-session-popover .ant-popover-inner", "--ff-bg-workspace"],
  ["ConversationSidebar", ".ff-session-context-menu", "--ff-bg-workspace"],
  ["ConversationSidebar", ".ff-session-context-menu .ant-menu", "--ff-bg-workspace"],
  ["RightInspector", ".ff-right-inspector", "--ff-bg-page"],
  ["RightInspector", ".ff-inspector-pane", "--ff-bg-workspace"],
  ["RunExperience", ".ff-task-plan-card", "--ff-bg-workspace"],
  ["RunExperience", ".ff-run-outcome", "--ff-bg-workspace"],
  ["RunExperience", ".ff-interaction-panel", "--ff-bg-page"],
  ["RunExperience", ".ff-interaction-panel__custom-answer input", "--ff-bg-workspace"],
  ["RunExperience", ".ff-interaction-panel__actions button", "--ff-bg-workspace"],
  ["RunExperience", ".ff-quiz-short-answer", "--ff-bg-workspace"],
  ["RunExperience", ".ff-quiz-graded__explanation", "--ff-bg-page"],
  ["ReviewPanel", ".ff-review-panel__restore-btn", "--ff-bg-workspace"],
  ["root", ".ff-compressing-context", "--ff-bg-workspace"],
  ["root", ".ff-workspace-empty button", "--ff-bg-workspace"],
  // The rounded card is the surface the typed text sits on; the inner sender is transparent.
  ["ChatComposer", ".ff-composer-shell", "--ff-surface"],
  ["ChatComposer", ".ff-queue-dock__editor", "--ff-surface"],
  ["ChatComposer", ".ff-composer__attachment", "--ff-bg-page"],
  ["ChatComposer", ".ff-composer .ant-sender-actions-btn:disabled", "--ff-bg-hover"],
];

describe("custom-color foreground and surface pairs", () => {
  it.each(surfaces)("keeps %s %s paired with its custom foreground", (file, selector, token) => {
    expect(declaration(file, `:root[data-ui-colors] ${selector}`, "background")).toBe(`var(${token})`);
    const colors = uiColorTokens({ enabled: true, accent: "#eeeeee", background: "#121212", foreground: "#ffffff" });
    expect(colors[token]).toBeDefined();
    expect(colors[token]).not.toBe("#ffffff");
  });

  it.each([
    ["ChatMessageList", ".ff-message--user .ant-bubble-content"],
    ["ChatMessageList", ".ff-message--user .ff-message-markdown a"],
    ["RunExperience", ".ff-interaction-panel__actions button.is-primary"],
    ["ChatComposer", ".ff-composer .ant-sender-actions-btn"],
  ])("uses contrast-aware text on %s %s", (file, selector) => {
    expect(declaration(file, `:root[data-ui-colors] ${selector}`, "color")).toBe("var(--rb-text-on-pink)");
    expect(uiColorTokens({ enabled: true, accent: "#ffffff" })["--rb-text-on-pink"]).toBe("#000000");
    expect(uiColorTokens({ enabled: true, accent: "#000000" })["--rb-text-on-pink"]).toBe("#ffffff");
  });

  it("keeps the existing light defaults when custom colors are disabled", () => {
    expect(declaration("ChatMessageList", ".ff-message--user .ant-bubble-content", "color")).toBe("var(--ff-text)");
    expect(declaration("ConversationSidebar", ".ff-session-rename-input", "background")).toBe("var(--ff-surface)");
    expect(declaration("RunExperience", ".ff-interaction-panel", "background")).toBe("var(--ff-popover)");
    const dom = new JSDOM('<div class="ff-session-rename-input"></div>');
    const input = dom.window.document.querySelector("div")!;
    expect(input.matches(":root[data-ui-colors] .ff-session-rename-input")).toBe(false);
    dom.window.document.documentElement.dataset.uiColors = "#ffffff:#121212:#ffffff";
    expect(input.matches(":root[data-ui-colors] .ff-session-rename-input")).toBe(true);
    dom.window.close();
  });

  it("pairs composer text and disabled actions with their surfaces", () => {
    expect(declaration("ChatComposer", ".ff-composer .ant-sender-input", "color")).toBe("var(--ff-text)");
    expect(declaration("ChatComposer", ":root[data-ui-colors] .ff-queue-dock__editor", "color")).toBe("var(--ff-text)");
    expect(declaration("ChatComposer", ":root[data-ui-colors] .ff-composer .ant-sender-actions-btn:disabled", "color")).toBe("var(--ff-text-muted)");
  });

  it.each([
    { enabled: true, accent: "#0285ff", background: "#121212", foreground: "#ffffff" },
    { enabled: true, accent: "#0285ff", background: "#ffffff", foreground: "#0d0d0d" },
  ])("keeps browser and file headers readable with custom colors %j", input => {
    const tokens = uiColorTokens(input);
    for (const [file, selector, token] of surfaces.slice(0, 3)) {
      expect(declaration(file, `:root[data-ui-colors] ${selector}`, "background")).toBe(`var(${token})`);
      expect(uiColorContrast({ background: tokens[token], foreground: tokens["--ff-text"] })).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("boots shared live theme updates in the reminder window without dropping audio", () => {
    const toast = readFileSync(new URL("../toast/toast.ts", import.meta.url), "utf8");
    expect(toast).toMatch(/import\s+["']\.\.\/ui\/theme["']/);
    expect(toast).toContain('import actionSoundUrl from "./assets/toast-action.wav"');
    expect(toast).toContain('import notifySoundUrl from "./assets/toast-notify.wav"');
  });
});
