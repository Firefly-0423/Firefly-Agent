import { it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { readState, writeState, statePath } from "./state";

let directory: string;
const firstMeeting = { version: "2.4.6", firstSeenAt: "2025-03-12T05:06:07.000Z" };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-state-contract-"));
  vi.stubEnv("FIREFLY_HOME", directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { force: true, recursive: true });
});

function putState(text: string) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), text, "utf8");
}

it("uses the application directory below the selected home", () => {
  expect(statePath()).toEqual(path.join(directory, ".firefly", "state.json"));
});

it("creates state on first write and reads the same launch record", () => {
  expect(readState()).toStrictEqual({ kind: "missing" });
  expect(() => writeState({ firstLaunch: firstMeeting })).not.toThrow();
  expect(readState()).toStrictEqual({ kind: "present", record: firstMeeting });
  expect(statePath()).toEqual(path.join(directory, ".firefly", "state.json"));
});

it.each([
  "[broken", JSON.stringify("scalar"), JSON.stringify({ lastSeenAt: "yesterday" }),
  JSON.stringify({ firstLaunch: { firstSeenAt: "yesterday" } }),
  JSON.stringify({ firstLaunch: { firstSeenAt: 17, version: 42 } }),
])("returns the original unreadable document for %s", raw => {
  putState(raw);
  expect(readState()).toStrictEqual({ raw, kind: "corrupt" });
});

it("reads a launch record while ignoring unrelated top-level metadata", () => {
  putState(JSON.stringify({ preferences: { compact: true }, firstLaunch: firstMeeting }));
  expect(readState()).toStrictEqual({ record: firstMeeting, kind: "present" });
});
