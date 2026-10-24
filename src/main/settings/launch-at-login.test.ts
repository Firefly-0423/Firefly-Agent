import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStorageContext } from "../storage/storage-context";
import {
  consumeInstallerLaunchAtLoginSelection as consumeChoice,
  applyInstallerLaunchAtLoginSelection as mergeChoice,
  syncLaunchAtLogin as synchronize,
} from "./launch-at-login";

vi.mock("../storage/storage-context", () => ({ getStorageContext: vi.fn() }));

beforeEach(() => {
  vi.mocked(getStorageContext).mockReset();
  vi.mocked(getStorageContext).mockReturnValue({ profile: { kind: "production" } } as never);
});

describe("Installer handoff", () => {
  it.each([false, true])("consumes a boolean choice (%s) after reading UTF-8", (choice) => {
    const operations: string[] = [];
    const file = "setup-preferences.json";
    const disk = {
      readFileSync: vi.fn(() => {
        operations.push("read");
        return JSON.stringify({ launchAtLogin: choice });
      }),
      unlinkSync: vi.fn(() => { operations.push("remove"); }),
    };
    expect(consumeChoice(file, disk)).toBe(choice);
    expect(disk.readFileSync.mock.calls).toEqual([[file, "utf8"]]);
    expect(disk.unlinkSync.mock.calls).toEqual([[file]]);
    expect(operations).toEqual(["read", "remove"]);
  });

  it("leaves unreadable JSON in place", () => {
    const disk = { readFileSync: vi.fn(() => "{unfinished"), unlinkSync: vi.fn() };
    expect(consumeChoice("broken-handoff.json", disk)).toBeNull();
    expect(disk.unlinkSync).not.toHaveBeenCalled();
  });

  it.each(['{}', '{"launchAtLogin":"true"}', '{"launchAtLogin":1}', 'null'])(
    "discards a parsed payload without a boolean: %s", (payload) => {
      const disk = { readFileSync: vi.fn(() => payload), unlinkSync: vi.fn() };
      expect(consumeChoice("invalid-choice.json", disk)).toBeNull();
      expect(disk.unlinkSync).toHaveBeenCalledExactlyOnceWith("invalid-choice.json");
    },
  );

  it.each(["read", "remove"])("returns no choice when the %s operation fails", (stage) => {
    const disk = {
      readFileSync: vi.fn(() => {
        if (stage === "read") throw new Error("cannot open handoff");
        return '{"launchAtLogin":false}';
      }),
      unlinkSync: vi.fn(() => { throw new Error("cannot remove handoff"); }),
    };
    expect(consumeChoice("locked-choice.json", disk)).toBeNull();
    expect(disk.unlinkSync).toHaveBeenCalledTimes(stage === "read" ? 0 : 1);
  });

  it("merges the chosen flag while preserving other preferences and the original object", () => {
    const original = { launchAtLogin: false, language: "en-US", theme: "dusk" };
    expect(mergeChoice(original, true)).toEqual({ launchAtLogin: true, language: "en-US", theme: "dusk" });
    expect(original.launchAtLogin).toBe(false);
    expect(mergeChoice({ ...original, launchAtLogin: true }, false)).toEqual(original);
    expect(mergeChoice(original, null)).toBe(original);
  });
});

describe("Operating system login preference", () => {
  it.each([false, true])("writes the production preference exactly once: %s", (flag) => {
    const system = { setLoginItemSettings: vi.fn() };
    synchronize(flag, system);
    expect(system.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: flag }]]);
  });

  for (const profile of ["smoke", "test", "development"] as const) {
    it.each([false, true])(`isolates ${profile} from login changes (%s)`, (flag) => {
      vi.mocked(getStorageContext).mockReturnValue({ profile: { kind: profile } } as never);
      const system = { setLoginItemSettings: vi.fn() };
      synchronize(flag, system);
      expect(system.setLoginItemSettings.mock.calls).toEqual([]);
    });
  }

  it("propagates an unavailable storage context before touching the OS", () => {
    vi.mocked(getStorageContext).mockImplementation(() => { throw Error("FIREFLY_STORAGE_NOT_INITIALIZED"); });
    const system = { setLoginItemSettings: vi.fn() };
    expect(() => synchronize(true, system)).toThrow(/^FIREFLY_STORAGE_NOT_INITIALIZED$/);
    expect(system.setLoginItemSettings.mock.calls).toEqual([]);
  });
});