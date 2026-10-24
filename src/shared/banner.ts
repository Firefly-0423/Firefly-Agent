/** 流萤启动横幅：CLI 与 Electron 主进程共用，纯文本不带颜色。 */
export const FIREFLY_LOGO = [
  "███████╗ ██╗ ██████╗  ███████╗ ███████╗ ██╗      ██╗   ██╗", "██╔════╝ ██║ ██╔══██╗ ██╔════╝ ██╔════╝ ██║      ╚██╗ ██╔╝",
  "█████╗   ██║ ██████╔╝ █████╗   █████╗   ██║       ╚████╔╝ ", "██╔══╝   ██║ ██╔══██╗ ██╔══╝   ██╔══╝   ██║        ╚██╔╝  ",
  "██║      ██║ ██║  ██║ ███████╗ ██║      ███████╗   ██║   ", "╚═╝      ╚═╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝      ╚══════╝   ╚═╝   ",
] as const;

export const BANNER_LINES = ["♡ Firefly_Agent ♡", "Your Desktop AI Companion", "Chat · Work · Code"] as const;

/** 未知终端宽度时使用的边框宽度 */
export const DEFAULT_BANNER_WIDTH = 64;
export const MIN_BANNER_WIDTH = 60;

const glyphs = (s: string): string[] => Array.from(s);

/** 在 width-4 的内宽里居中；过长则截断并补省略号 */
function centerInBox(text: string, width: number): string {
  const room = width - 4;
  const chars = glyphs(text);
  if (chars.length > room) return chars.slice(0, room - 1).join("") + "…";
  const spare = room - chars.length;
  const before = Math.floor(spare / 2);
  return " ".repeat(before) + text + " ".repeat(spare - before);
}

function frameBox(lines: readonly string[], width: number): string {
  const edge = "─".repeat(width - 2);
  return [
    `╭${edge}╮`,
    ...lines.map((line) => `│ ${centerInBox(line, width)} │`),
    `╰${edge}╯`,
  ].join("\n");
}

/** 完整横幅：标志、空行、边框盒子。 */
export function renderBanner(): string {
  return [FIREFLY_LOGO.join("\n"), frameBox(BANNER_LINES, DEFAULT_BANNER_WIDTH)].join("\n\n");
}
