// Code appearance: the syntax colours used for code blocks, one choice for the light theme and one for the dark.
// Each theme is a small palette; the chat turns it into Prism token styles and the settings page paints its preview
// from the same colours. "firefly" is the look Firefly had before the choice existed.

export const LIGHT_CODE_THEMES = ["firefly", "github", "solarized", "vs"] as const;
export const DARK_CODE_THEMES = ["firefly", "one-dark", "github-dark", "dracula", "nord"] as const;
export type LightCodeTheme = (typeof LIGHT_CODE_THEMES)[number];
export type DarkCodeTheme = (typeof DARK_CODE_THEMES)[number];

export interface CodePalette {
  /** Block background; undefined keeps the window's own code surface. */
  background?: string;
  text: string;
  comment: string;
  keyword: string;
  function: string;
  string: string;
  number: string;
  type: string;
  tag: string;
  property: string;
  punctuation: string;
}

export const CODE_THEME_NAMES: Record<LightCodeTheme | DarkCodeTheme, string> = {
  firefly: "Firefly",
  github: "GitHub Light",
  solarized: "Solarized Light",
  vs: "Visual Studio",
  "one-dark": "One Dark",
  "github-dark": "GitHub Dark",
  dracula: "Dracula",
  nord: "Nord",
};

export const LIGHT_CODE_PALETTES: Record<LightCodeTheme, CodePalette> = {
  // Prism's One Light, which the code highlighter used by default.
  firefly: { text: "#383a42", comment: "#a0a1a7", keyword: "#a626a4", function: "#4078f2", string: "#50a14f", number: "#986801", type: "#c18401", tag: "#e45649", property: "#e45649", punctuation: "#383a42" },
  github: { background: "#ffffff", text: "#24292f", comment: "#6e7781", keyword: "#cf222e", function: "#8250df", string: "#0a3069", number: "#0550ae", type: "#953800", tag: "#116329", property: "#0550ae", punctuation: "#24292f" },
  solarized: { background: "#fdf6e3", text: "#657b83", comment: "#93a1a1", keyword: "#859900", function: "#268bd2", string: "#2aa198", number: "#d33682", type: "#b58900", tag: "#268bd2", property: "#cb4b16", punctuation: "#586e75" },
  vs: { background: "#ffffff", text: "#000000", comment: "#008000", keyword: "#0000ff", function: "#795e26", string: "#a31515", number: "#098658", type: "#267f99", tag: "#800000", property: "#001080", punctuation: "#000000" },
};

export const DARK_CODE_PALETTES: Record<DarkCodeTheme, CodePalette> = {
  // The mint-on-ink colours of Firefly's dark theme.
  firefly: { text: "var(--ff-text, #dce8e2)", comment: "#7f948a", keyword: "#c3a6f0", function: "#8ec7f0", string: "#7bd8ae", number: "#e8c36a", type: "#e8c36a", tag: "#f2a07b", property: "#8ec7f0", punctuation: "#a9bdb3" },
  "one-dark": { background: "#282c34", text: "#abb2bf", comment: "#5c6370", keyword: "#c678dd", function: "#61afef", string: "#98c379", number: "#d19a66", type: "#e5c07b", tag: "#e06c75", property: "#e06c75", punctuation: "#abb2bf" },
  "github-dark": { background: "#0d1117", text: "#c9d1d9", comment: "#8b949e", keyword: "#ff7b72", function: "#d2a8ff", string: "#a5d6ff", number: "#79c0ff", type: "#ffa657", tag: "#7ee787", property: "#79c0ff", punctuation: "#c9d1d9" },
  dracula: { background: "#282a36", text: "#f8f8f2", comment: "#6272a4", keyword: "#ff79c6", function: "#50fa7b", string: "#f1fa8c", number: "#bd93f9", type: "#8be9fd", tag: "#ff79c6", property: "#66d9ef", punctuation: "#f8f8f2" },
  nord: { background: "#2e3440", text: "#d8dee9", comment: "#616e88", keyword: "#81a1c1", function: "#88c0d0", string: "#a3be8c", number: "#b48ead", type: "#8fbcbb", tag: "#81a1c1", property: "#81a1c1", punctuation: "#eceff4" },
};

export function codePalette(scheme: "light" | "dark", theme: string): CodePalette {
  return scheme === "dark"
    ? DARK_CODE_PALETTES[theme as DarkCodeTheme] ?? DARK_CODE_PALETTES.firefly
    : LIGHT_CODE_PALETTES[theme as LightCodeTheme] ?? LIGHT_CODE_PALETTES.firefly;
}
