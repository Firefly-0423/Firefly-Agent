import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProactiveState } from "./proactive-types";

const state = vi.hoisted(() => ({ directory: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => state.directory },
}));

import { defaultProactiveState, loadProactiveState, saveProactiveState } from "./proactive-state-store";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-proactive-state-"));
  state.directory = root;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (): string => path.join(root, "proactive-state.json");
const write = (value: unknown): void => fs.writeFileSync(file(), JSON.stringify(value));

describe("defaultProactiveState", () => {
  it("returns the documented initial values", () => {
    expect(defaultProactiveState()).toEqual({
      proactiveEpoch: 0,
      unansweredCount: 0,
      lastProactiveAt: null,
      lastProactiveScene: null,
      lastNormalConversationEndedAt: null,
      globalDesire: 0,
      affinity: {},
      lastFiredAt: {},
    });
  });

  it("returns independent nested objects on every call", () => {
    const first = defaultProactiveState();
    const second = defaultProactiveState();
    expect(first).not.toBe(second);
    expect(first.affinity).not.toBe(second.affinity);
    expect(first.lastFiredAt).not.toBe(second.lastFiredAt);
    first.affinity.alice = 3;
    expect(second.affinity).toEqual({});
  });
});

describe("loadProactiveState", () => {
  it("returns the defaults when the file is missing", () => {
    expect(loadProactiveState()).toEqual(defaultProactiveState());
    expect(fs.existsSync(file())).toBe(false);
  });

  it("merges stored fields over the defaults and keeps unknown fields", () => {
    write({
      proactiveEpoch: 4,
      unansweredCount: 2,
      lastProactiveAt: 111,
      lastProactiveScene: "tea",
      globalDesire: 0.6,
      affinity: { alice: 5 },
      lastFiredAt: { tea: 99 },
      futureField: "kept",
    });
    expect(loadProactiveState()).toEqual({
      proactiveEpoch: 4,
      unansweredCount: 2,
      lastProactiveAt: 111,
      lastProactiveScene: "tea",
      lastNormalConversationEndedAt: null,
      globalDesire: 0.6,
      affinity: { alice: 5 },
      lastFiredAt: { tea: 99 },
      futureField: "kept",
    });
  });

  it("tolerates missing nested maps and invalid affinity maps", () => {
    write({ proactiveEpoch: 8, lastFiredAt: null, affinity: null });
    expect(loadProactiveState()).toEqual({
      ...defaultProactiveState(),
      proactiveEpoch: 8,
    });
  });

  it.each([
    ["invalid JSON", "{broken"],
    ["a JSON null", "null"],
    ["an array", "[]"],
  ])("returns the defaults for %s", (_label, contents) => {
    fs.writeFileSync(file(), contents);
    expect(loadProactiveState()).toEqual(defaultProactiveState());
  });

  it("returns the defaults when the path cannot be read", () => {
    fs.mkdirSync(file());
    expect(loadProactiveState()).toEqual(defaultProactiveState());
  });
});

describe("saveProactiveState", () => {
  it("writes pretty JSON that loads back unchanged", () => {
    const value: ProactiveState = {
      ...defaultProactiveState(),
      proactiveEpoch: 3,
      unansweredCount: 1,
      affinity: { bob: 2 },
      lastFiredAt: { walk: 120 },
    };
    saveProactiveState(value);
    expect(fs.readFileSync(file(), "utf8")).toContain('\n  "proactiveEpoch": 3');
    expect(loadProactiveState()).toEqual(value);
  });

  it("overwrites the previous state", () => {
    saveProactiveState({ ...defaultProactiveState(), proactiveEpoch: 1 });
    saveProactiveState({ ...defaultProactiveState(), proactiveEpoch: 2 });
    expect(loadProactiveState().proactiveEpoch).toBe(2);
  });

  it("warns instead of throwing when the state cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(file());
    expect(() => saveProactiveState(defaultProactiveState())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
