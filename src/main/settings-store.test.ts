import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => state.directory },
}));

import {
  DEFAULT_USER_PROFILE,
  getAvatarPath,
  getGeneralSettingsPath,
  getRagStorePath,
  getSettingsPath,
  getStickerSettingsPath,
  getUserProfilePath,
  loadUserProfile,
  saveUserProfile,
} from "./settings-store";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-settings-store-"));
  state.directory = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const profileFile = (): string => path.join(root, "user-profile.json");

describe("settings paths", () => {
  it("places every settings file under the current user data directory", () => {
    expect(getSettingsPath()).toBe(path.join(root, "model-settings.json"));
    expect(getGeneralSettingsPath()).toBe(path.join(root, "app-settings.json"));
    expect(getUserProfilePath()).toBe(path.join(root, "user-profile.json"));
    expect(getAvatarPath()).toBe(path.join(root, "avatar.png"));
    expect(getRagStorePath()).toBe(path.join(root, "rag-data", "memory-store.json"));
    expect(getStickerSettingsPath()).toBe(path.join(root, "sticker-settings.json"));
  });
});

describe("loadUserProfile", () => {
  it("returns the default profile when no file exists", () => {
    expect(loadUserProfile()).toEqual(DEFAULT_USER_PROFILE);
  });

  it("merges a stored partial profile over the defaults", () => {
    fs.writeFileSync(
      profileFile(),
      JSON.stringify({ nickname: "Firefly", birthday: "2000-01-02", gender: "female" }),
    );
    expect(loadUserProfile()).toEqual({
      ...DEFAULT_USER_PROFILE,
      nickname: "Firefly",
      birthday: "2000-01-02",
      gender: "female",
    });
  });

  it("keeps unknown stored fields", () => {
    fs.writeFileSync(profileFile(), JSON.stringify({ nickname: "N", futureField: true }));
    expect(loadUserProfile()).toMatchObject({ nickname: "N", futureField: true });
  });

  it.each([
    ["invalid JSON", "{broken"],
    ["a JSON null", "null"],
    ["an array", "[]"],
  ])("returns the defaults for %s", (_label, contents) => {
    fs.writeFileSync(profileFile(), contents);
    expect(loadUserProfile()).toEqual(DEFAULT_USER_PROFILE);
  });

  it("returns the defaults when the path cannot be read", () => {
    fs.mkdirSync(profileFile());
    expect(loadUserProfile()).toEqual(DEFAULT_USER_PROFILE);
  });
});

describe("saveUserProfile", () => {
  it("merges a partial update with the existing profile and returns it", () => {
    fs.writeFileSync(profileFile(), JSON.stringify({ nickname: "Old", timezone: "UTC" }));
    const saved = saveUserProfile({ nickname: "New", defaultCity: "Shanghai" });
    expect(saved).toEqual({
      ...DEFAULT_USER_PROFILE,
      nickname: "New",
      timezone: "UTC",
      defaultCity: "Shanghai",
    });
    expect(JSON.parse(fs.readFileSync(profileFile(), "utf8"))).toEqual(saved);
  });

  it("creates the user data directory before writing", () => {
    const nested = path.join(root, "nested", "profile");
    state.directory = nested;
    expect(() => saveUserProfile({ nickname: "N" })).not.toThrow();
    expect(fs.existsSync(path.join(nested, "user-profile.json"))).toBe(true);
  });

  it("does not let a later read lose fields from earlier saves", () => {
    saveUserProfile({ nickname: "N", gender: "male" });
    saveUserProfile({ defaultCity: "Beijing" });
    expect(loadUserProfile()).toMatchObject({
      nickname: "N",
      gender: "male",
      defaultCity: "Beijing",
      timezone: DEFAULT_USER_PROFILE.timezone,
    });
  });
});
