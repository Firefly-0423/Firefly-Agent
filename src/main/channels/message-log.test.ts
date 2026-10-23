import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));

import { appendLog, clearLog, getRecentLog, reloadLogFromDisk } from "./message-log";

let root = "";
const logPath = () => path.join(root, "channels", "log.jsonl");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-channel-log-"));
  mocks.userData = root;
  clearLog();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const entry = (text: string) => ({
  dir: "incoming" as const,
  channel: "telegram",
  senderId: "sender-1",
  chatId: "chat-1",
  text,
});

describe("appendLog", () => {
  it("stamps an ISO time and writes one JSON line to disk", () => {
    appendLog({ ...entry("hello"), senderName: "Ada", hasAttachments: true });
    const lines = fs.readFileSync(logPath(), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const saved = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(saved).toMatchObject({
      dir: "incoming",
      channel: "telegram",
      senderId: "sender-1",
      chatId: "chat-1",
      text: "hello",
      senderName: "Ada",
      hasAttachments: true,
    });
    expect(saved.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps entries newest-first in memory", () => {
    appendLog(entry("one"));
    appendLog(entry("two"));
    appendLog(entry("three"));
    expect(getRecentLog().map((item) => item.text)).toEqual(["three", "two", "one"]);
  });

  it("caps the in-memory window at 200 entries", () => {
    for (let index = 0; index < 205; index++) appendLog(entry(`e${index}`));
    const recent = getRecentLog(1000);
    expect(recent).toHaveLength(200);
    expect(recent[0]?.text).toBe("e204");
    expect(recent.at(-1)?.text).toBe("e5");
  });

  it("truncates an oversized log file while keeping the newest lines", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    const old = Array.from({ length: 1005 }, (_, index) =>
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", ...entry(`old${index}`) }),
    );
    fs.writeFileSync(logPath(), old.join("\n") + "\n", "utf8");
    appendLog(entry("newest"));
    const lines = fs.readFileSync(logPath(), "utf8").split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(1000);
    expect(lines.at(-1)).toContain("newest");
    expect(fs.readFileSync(logPath(), "utf8")).not.toContain("old0\"");
  });

  it("still records in memory when the disk write fails", () => {
    mocks.userData = path.join(root, "blocked");
    fs.writeFileSync(mocks.userData, "not a directory", "utf8");
    expect(() => appendLog(entry("memory-only"))).not.toThrow();
    expect(getRecentLog().map((item) => item.text)).toEqual(["memory-only"]);
  });
});

describe("getRecentLog", () => {
  it("clamps the limit to the 1..200 range", () => {
    appendLog(entry("one"));
    appendLog(entry("two"));
    expect(getRecentLog(0)).toHaveLength(1);
    expect(getRecentLog(0)[0]?.text).toBe("two");
    expect(getRecentLog(10_000)).toHaveLength(2);
  });

  it("reads from disk when memory is empty, newest first, skipping corrupt lines", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    const rows = ["one", "two", "three"].map((text) =>
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", ...entry(text) }),
    );
    fs.writeFileSync(logPath(), [...rows.slice(0, 2), "{broken", rows[2]!].join("\n") + "\n", "utf8");
    expect(getRecentLog().map((item) => item.text)).toEqual(["three", "two", "one"]);
  });

  it("returns an empty list when the disk log is missing", () => {
    expect(getRecentLog()).toEqual([]);
  });
});

describe("clearLog and reloadLogFromDisk", () => {
  it("clears both memory and the on-disk file", () => {
    appendLog(entry("one"));
    expect(fs.existsSync(logPath())).toBe(true);
    clearLog();
    expect(fs.existsSync(logPath())).toBe(false);
    expect(getRecentLog()).toEqual([]);
  });

  it("tolerates clearing an already-missing log", () => {
    expect(() => clearLog()).not.toThrow();
    expect(() => clearLog()).not.toThrow();
  });

  it("reloads at most the newest 200 entries from disk", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    const rows = Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", ...entry(`r${index}`) }),
    );
    fs.writeFileSync(logPath(), rows.join("\n") + "\n", "utf8");
    reloadLogFromDisk();
    const recent = getRecentLog(1000);
    expect(recent).toHaveLength(200);
    expect(recent[0]?.text).toBe("r204");
    expect(recent.at(-1)?.text).toBe("r5");
  });

  it("ignores a missing file and corrupt lines", () => {
    expect(() => reloadLogFromDisk()).not.toThrow();
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), "{broken\n" + JSON.stringify({ at: "x", ...entry("ok") }) + "\n", "utf8");
    reloadLogFromDisk();
    expect(getRecentLog().map((item) => item.text)).toEqual(["ok"]);
  });
});
