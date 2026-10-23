import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readState } from "../state/state";
import {
  ABOUT_LINES,
  BANNER_LINES,
  cmdAbout,
  cmdDefault,
  cmdHello,
  cmdHelp,
  cmdPlaceholder,
  cmdUnknown,
  cmdVersion,
  renderAbout,
  renderBanner,
} from "./handlers";

let root: string;
let stdout: string;
let stderr: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-cli-handlers-"));
  process.env.FIREFLY_HOME = root;
  stdout = "";
  stderr = "";
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.FIREFLY_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = { version: "9.8.7-test" };

describe("simple commands", () => {
  it("cmdHello prints the banner and exits 0", () => {
    expect(cmdHello()).toBe(0);
    expect(stdout).toBe(`${renderBanner()}\n`);
  });

  it("cmdAbout prints the about screen and exits 0", () => {
    expect(cmdAbout()).toBe(0);
    expect(stdout).toBe(`${renderAbout()}\n`);
  });

  it("cmdVersion prints exactly the injected version and exits 0", () => {
    expect(cmdVersion(ctx)).toBe(0);
    expect(stdout).toBe(`${ctx.version}\n`);
  });

  it("cmdHelp prints usage, every command and every flag", () => {
    expect(cmdHelp()).toBe(0);
    for (const text of [
      "Usage: firefly [command] [options]",
      "hello     Print the welcome banner",
      "about     Print banner plus project metadata",
      "version   Print version only",
      "run       Launch the Electron desktop app [dev only]",
      "doctor    Diagnose the local environment (planned)",
      "init      Initialize a workspace (planned)",
      "update    Self-update (planned)",
      "help      Show this help",
      "-v, --version   Print version and exit",
      "-h, --help      Show this help",
      "Run `firefly` with no arguments for the first-time greeting.",
    ]) {
      expect(stdout).toContain(text);
    }
  });

  it.each(["doctor", "init", "update"] as const)("cmdPlaceholder(%s) prints the planned line", (name) => {
    expect(cmdPlaceholder(name)).toBe(0);
    expect(stdout).toBe(
      `firefly ${name}: planned for a future release. See https://github.com/Firefly-0423/Firefly-Agent\n`,
    );
    expect(stderr).toBe("");
  });

  it("cmdUnknown writes an actionable error to stderr and exits 2", () => {
    expect(cmdUnknown("bogus")).toBe(2);
    expect(stderr).toBe("firefly: unknown command 'bogus'. Try 'firefly --help'.\n");
    expect(stdout).toBe("");
  });
});

describe("cmdDefault", () => {
  it("prints the banner, a blank line and the greeting on a first meeting", () => {
    expect(cmdDefault(ctx)).toBe(0);
    expect(stdout).toBe(`${renderBanner()}\n\nLet's start from here.\n`);
    expect(stderr).toBe("");
  });

  it("records the first-seen time and version in the CLI state", () => {
    const before = Date.now();
    cmdDefault(ctx);
    const state = readState();
    expect(state.kind).toBe("present");
    if (state.kind !== "present") throw new Error("unreachable");
    expect(state.record.version).toBe(ctx.version);
    const seen = Date.parse(state.record.firstSeenAt);
    expect(Number.isFinite(seen)).toBe(true);
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
  });

  it("greets a returning user with the version and Ready", () => {
    cmdDefault(ctx);
    stdout = "";
    stderr = "";
    expect(cmdDefault(ctx)).toBe(0);
    expect(stdout).toBe(`Firefly_Agent v${ctx.version}\nReady.\n`);
    expect(stderr).toBe("");
  });

  it("treats corrupt state as a first meeting and replaces it", () => {
    const file = path.join(root, ".firefly", "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    expect(cmdDefault(ctx)).toBe(0);
    expect(stderr).toContain("firefly: CLI state was unreadable; treating as first meeting.");
    expect(stdout).toContain(renderBanner());
    expect(stdout).toContain("Let's start from here.");
    expect(readState().kind).toBe("present");
  });

  it("never fails when the state file cannot be written", () => {
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "file");
    process.env.FIREFLY_HOME = blocked;
    expect(cmdDefault(ctx)).toBe(0);
    expect(stderr).toBe(
      "firefly: could not write ~/.firefly/state.json; you may see this banner again next time.\n",
    );
    expect(stdout).toContain("Let's start from here.");
  });
});

describe("re-exports", () => {
  it("exposes the banner data and renderers used by other CLI modules", () => {
    expect(BANNER_LINES.length).toBeGreaterThan(0);
    expect(ABOUT_LINES.length).toBeGreaterThan(0);
    expect(renderBanner()).toContain(BANNER_LINES[2]);
    expect(renderAbout()).toContain(ABOUT_LINES[0]);
  });
});
