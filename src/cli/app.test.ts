import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "./app";
import { readState } from "./state/state";

const release = "2.7.1-contract";
let isolatedHome: string;
let output: { stdout: string; stderr: string };
beforeEach(() => {
  isolatedHome = fs.mkdtempSync(path.join(tmpdir(), "cli-dispatch-contract-"));
  vi.stubEnv("FIREFLY_HOME", isolatedHome);
  output = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { output.stderr += String(chunk); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(isolatedHome, { force: true, recursive: true });
});

it("persists the first meeting and shows a compact status on later launches", async () => {
  expect(await main([], release)).toEqual(0);
  expect(output.stdout).toContain("Chat · Work · Code");
  expect(output.stdout).toContain("Let's start from here.");
  const saved = readState();
  expect(saved.kind).toEqual("present");
  expect(saved).toMatchObject({ record: { version: release } });
  output.stdout = "";
  expect(await main([], release)).toEqual(0);
  expect(output.stdout).toContain(`Firefly_Agent v${release}`);
  expect(output.stdout).toContain("Ready.");
  expect(output.stdout).not.toContain("Chat · Work · Code");
});

it.each(["version", "-v", "--version"])("prints only the release for %s", async command => {
  expect(await main([command], release)).toEqual(0);
  expect(output.stdout.trim()).toEqual(release);
});

it("renders the welcome command without the first-meeting greeting", async () => {
  expect(await main(["hello"], release)).toEqual(0);
  expect(output.stdout).toContain("Chat · Work · Code");
  expect(output.stdout).not.toContain("Let's start from here.");
});

it("displays project metadata for the about command", async () => {
  expect(await main(["about"], release)).toEqual(0);
  expect(output.stdout).toContain("https://github.com/Firefly-0423/Firefly-Agent");
});

it("provides usage through the help flag", async () => {
  expect(await main(["--help"], release)).toEqual(0);
  expect(output.stdout).toContain("Usage: firefly");
});

it("acknowledges the reserved diagnostics command", async () => {
  expect(await main(["doctor"], release)).toEqual(0);
  expect(output.stdout).toContain("planned for a future release");
});

it("reports an unknown command only on the error stream with status two", async () => {
  expect(await main(["inspect-universe"], release)).toEqual(2);
  expect(output.stderr).toContain("unknown command 'inspect-universe'");
  expect(output.stdout).toEqual("");
});
