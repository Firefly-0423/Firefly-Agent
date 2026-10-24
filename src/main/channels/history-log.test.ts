import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const location = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => location.directory } }));
import { appendHistory, loadRecentHistory, migrateHistory } from "./history-log";

beforeEach(() => { location.directory = fs.mkdtempSync(join(tmpdir(), "history-window-contract-")); });
afterEach(() => { fs.rmSync(location.directory, { recursive: true, force: true }); });

it("returns no context for unknown sessions or empty records", () => {
  expect(loadRecentHistory("unseen-room", 16)).toStrictEqual([]);
  appendHistory("", "user", "Do not persist");
  appendHistory("empty-room", "user", "");
  expect(loadRecentHistory("empty-room", 16)).toStrictEqual([]);
});

it("round-trips ordered roles and contents while keeping conversations isolated", () => {
  appendHistory("river-room", "user", "Where is the bridge?");
  appendHistory("river-room", "assistant", "Across the square.");
  appendHistory("hill-room", "user", "Check the summit");
  expect(loadRecentHistory("river-room", 16).map(({ role, content }) => ({ role, content }))).toStrictEqual([
    { content: "Where is the bridge?", role: "user" }, { content: "Across the square.", role: "assistant" },
  ]);
  expect(loadRecentHistory("hill-room", 16).map(item => item.content)).toStrictEqual(["Check the summit"]);
});

it("takes the last requested turns without reversing their chronology", () => {
  for (let turn = 0; turn < 12; turn++) {
    appendHistory("window-room", "user", `Request ${turn}`);
    appendHistory("window-room", "assistant", `Response ${turn}`);
  }
  expect(loadRecentHistory("window-room", 4).map(item => item.content)).toStrictEqual([
    "Request 10", "Response 10", "Request 11", "Response 11",
  ]);
});

it("bounds the history file while preserving both ends of the latest 200 records", () => {
  for (let sequence = 0; sequence < 260; sequence++) appendHistory("busy-room", "user", `Entry ${sequence}`);
  const history = loadRecentHistory("busy-room", 260);
  expect(history.length).toBeLessThanOrEqual(200);
  expect(history[0].content).toEqual("Entry 60");
  expect(history.at(-1)?.content).toEqual("Entry 259");
});

it("copies legacy context once, preserves its source and never replaces a destination", () => {
  appendHistory("old-room", "user", "Earlier discussion");
  migrateHistory("old-room", "current-room");
  expect(loadRecentHistory("current-room", 16).map(item => item.content)).toStrictEqual(["Earlier discussion"]);
  expect(loadRecentHistory("old-room", 16)).toHaveLength(1);
  appendHistory("occupied-room", "user", "Current discussion");
  migrateHistory("old-room", "occupied-room");
  expect(loadRecentHistory("occupied-room", 16).map(item => item.content)).toStrictEqual(["Current discussion"]);
});

it("treats absent, empty and identical migration keys as harmless", () => {
  migrateHistory("no-source", "no-destination");
  expect(loadRecentHistory("no-destination", 16)).toStrictEqual([]);
  expect(() => migrateHistory("same-room", "same-room")).not.toThrow();
  expect(() => migrateHistory("", "unused-room")).not.toThrow();
});
