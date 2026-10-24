// The small diff under each code theme picker: a fixed four-line TypeScript snippet painted with that theme's colours,
// so a choice can be judged before any code shows up in a conversation.
import { codePalette, type CodePalette } from "../../../shared/code-themes";

type Token = [keyof CodePalette, string];
type Line = { no: number; sign: " " | "-" | "+"; tokens: Token[] };

const LINES: Line[] = [
  { no: 1, sign: " ", tokens: [["keyword", "function"], ["text", " "], ["function", "greet"], ["punctuation", "("], ["text", "name"], ["punctuation", ": "], ["type", "string"], ["punctuation", ") {"]] },
  { no: 2, sign: "-", tokens: [["text", "  "], ["keyword", "return"], ["text", " "], ["string", "\"Hello, \""], ["text", " "], ["punctuation", "+"], ["text", " name"], ["punctuation", ";"]] },
  { no: 2, sign: "+", tokens: [["text", "  "], ["keyword", "return"], ["text", " "], ["string", "`Hello, "], ["punctuation", "${"], ["text", "name"], ["punctuation", "}"], ["string", "!`"], ["punctuation", ";"]] },
  { no: 3, sign: " ", tokens: [["punctuation", "}"]] },
];

/** The preview's ground when a theme keeps the window's own code surface. */
const SURFACE = { light: "#ffffff", dark: "#1d302a" } as const;

/** A colour written as a CSS variable resolves against this window, not the chat's theme: use its fallback. */
const plain = (color: string) => /^var\([^,]+,\s*(.+)\)$/.exec(color)?.[1] ?? color;

export function renderCodeThemePreview(host: HTMLElement, scheme: "light" | "dark", theme: string): void {
  const palette = codePalette(scheme, theme);
  host.dataset.theme = theme;
  host.style.background = palette.background ?? SURFACE[scheme];
  host.style.color = plain(palette.text);
  host.replaceChildren(...LINES.map(line => {
    const row = document.createElement("div");
    row.className = `code-theme-preview__line${line.sign === "-" ? " is-remove" : line.sign === "+" ? " is-add" : ""}`;
    const no = document.createElement("span");
    no.className = "code-theme-preview__no";
    no.textContent = String(line.no);
    const sign = document.createElement("span");
    sign.className = "code-theme-preview__sign";
    sign.textContent = line.sign;
    const code = document.createElement("span");
    code.className = "code-theme-preview__code";
    for (const [kind, text] of line.tokens) {
      const token = document.createElement("span");
      token.textContent = text;
      if (kind !== "text") token.style.color = plain(palette[kind] ?? "");
      code.append(token);
    }
    row.append(no, sign, code);
    return row;
  }));
}
