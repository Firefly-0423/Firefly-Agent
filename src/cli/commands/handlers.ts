import { errLine, outLine } from "../util/log.js";
import { writeState, readState, type FirstLaunchRecord } from "../state/state.js";
import { BANNER_LINES, ABOUT_LINES } from "../banner/text.js";
import { renderBanner, renderAbout } from "../banner/render.js";

export type HandlerCtx = { version: string };
export { ABOUT_LINES, BANNER_LINES, renderAbout, renderBanner };

function printSuccess(text: string): number {
  outLine(text);
  return 0;
}

export function cmdHello(): number {
  return printSuccess(renderBanner());
}

export function cmdAbout(): number {
  return printSuccess(renderAbout());
}

export function cmdVersion(ctx: HandlerCtx): number {
  return printSuccess(ctx.version);
}

export function cmdHelp(): number {
  return printSuccess([
    "Usage: firefly [command] [options]", "",
    "Commands:",
    "  hello     Print the welcome banner",
    "  about     Print banner plus project metadata",
    "  version   Print version only",
    "  run       Launch the Electron desktop app [dev only]",
    "  doctor    Diagnose the local environment (planned)",
    "  init      Initialize a workspace (planned)",
    "  update    Self-update (planned)",
    "  help      Show this help", "",
    "Flags:",
    "  -v, --version   Print version and exit",
    "  -h, --help      Show this help", "",
    "Run `firefly` with no arguments for the first-time greeting.",
  ].join("\n"));
}

export function cmdPlaceholder(name: "doctor" | "init" | "update"): number {
  return printSuccess(`firefly ${name}: planned for a future release. See https://github.com/Firefly-0423/Firefly-Agent`);
}

export function cmdUnknown(name: string): number {
  const diagnostic = `firefly: unknown command '${name}'. Try 'firefly --help'.`;
  errLine(diagnostic);
  return 2;
}

export function cmdDefault(ctx: HandlerCtx): number {
  const previous = readState();
  switch (previous.kind) {
    case "present":
      outLine(`Firefly_Agent v${ctx.version}`);
      return printSuccess("Ready.");
    case "corrupt":
      errLine("firefly: CLI state was unreadable; treating as first meeting.");
  }
  outLine(renderBanner());
  outLine();
  outLine("Let's start from here.");
  const meeting: FirstLaunchRecord = {
    firstSeenAt: new Date().toISOString(), version: ctx.version,
  };
  try {
    writeState({ firstLaunch: meeting });
  } catch {
    errLine("firefly: could not write ~/.firefly/state.json; you may see this banner again next time.");
  }
  return 0;
}
