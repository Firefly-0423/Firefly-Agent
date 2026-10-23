/**
 * ANSI Shadow rendering of "FIREFLY". Six lines, monospace-only.
 * Committed verbatim so the banner is byte-for-byte deterministic across releases.
 */
export const FIREFLY_LOGO = [
  "███████╗ ██╗ ██████╗  ███████╗ ███████╗ ██╗      ██╗   ██╗",
  "██╔════╝ ██║ ██╔══██╗ ██╔════╝ ██╔════╝ ██║      ╚██╗ ██╔╝",
  "█████╗   ██║ ██████╔╝ █████╗   █████╗   ██║       ╚████╔╝ ",
  "██╔══╝   ██║ ██╔══██╗ ██╔══╝   ██╔══╝   ██║        ╚██╔╝  ",
  "██║      ██║ ██║  ██║ ███████╗ ██║      ███████╗   ██║   ",
  "╚═╝      ╚═╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝      ╚══════╝   ╚═╝   ",
] as const;

export const FIREFLY_LOGO_TEXT = FIREFLY_LOGO.join("\n");
