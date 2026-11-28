import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserToolSettingsStore } from "./browser-tools-settings";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-browser-settings-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const settingsFile = (): string => path.join(root, "browser-tools-settings.json");
const readStored = (): unknown => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));

describe("createBrowserToolSettingsStore", () => {
  it("returns the frozen defaults when the file is missing", () => {
    const store = createBrowserToolSettingsStore(settingsFile());
    expect(store.get()).toEqual({ askWhereToSave: false, folder: null });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it("loads a valid stored file and still returns detached copies", () => {
    const folder = path.join(root, "downloads");
    fs.mkdirSync(folder);
    fs.writeFileSync(settingsFile(), JSON.stringify({ askWhereToSave: true, folder }));
    const store = createBrowserToolSettingsStore(settingsFile());

    const first = store.get();
    expect(first).toEqual({ askWhereToSave: true, folder });
    first.askWhereToSave = false;
    first.folder = null;
    expect(store.get()).toEqual({ askWhereToSave: true, folder });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "folder"],
    ["a missing boolean", { folder: null }],
    ["a non-boolean flag", { askWhereToSave: 1, folder: null }],
    ["an empty folder", { askWhereToSave: false, folder: "" }],
    ["a relative folder", { askWhereToSave: false, folder: "downloads" }],
    ["an overlong folder", { askWhereToSave: false, folder: path.win32.join("C:\\tmp", "x".repeat(1025)) }],
    ["an unknown key", { askWhereToSave: false, folder: null, extra: true }],
    ["invalid JSON", "{not json"],
  ])("falls back to the defaults for %s", (_label, contents) => {
    fs.writeFileSync(
      settingsFile(),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
    const store = createBrowserToolSettingsStore(settingsFile());
    expect(store.get()).toEqual({ askWhereToSave: false, folder: null });
  });

  it("persists a valid update and returns the new value", () => {
    const folder = path.join(root, "downloads");
    fs.mkdirSync(folder);
    const store = createBrowserToolSettingsStore(settingsFile());

    expect(store.update({ askWhereToSave: true })).toEqual({ askWhereToSave: true, folder: null });
    expect(readStored()).toEqual({ askWhereToSave: true, folder: null });
    expect(store.update({ folder })).toEqual({ askWhereToSave: true, folder });
    expect(readStored()).toEqual({ askWhereToSave: true, folder });

    expect(createBrowserToolSettingsStore(settingsFile()).get()).toEqual({
      askWhereToSave: true,
      folder,
    });
  });

  it("merges partial updates with the current value", () => {
    const store = createBrowserToolSettingsStore(settingsFile());
    store.update({ askWhereToSave: true });
    const folder = path.join(root, "chosen");
    fs.mkdirSync(folder);
    expect(store.update({ folder })).toEqual({ askWhereToSave: true, folder });
  });

  it.each([
    ["a relative folder", { folder: "relative" }],
    ["an empty folder", { folder: "" }],
    ["a non-boolean flag", { askWhereToSave: "yes" }],
    ["an unknown key", { extra: true }],
  ])("rejects %s without changing the current value or the file", (_label, patch) => {
    const store = createBrowserToolSettingsStore(settingsFile());
    store.update({ askWhereToSave: true });
    const before = fs.readFileSync(settingsFile(), "utf8");

    const result = store.update(patch as never);
    expect(result).toEqual({ askWhereToSave: true, folder: null });
    expect(store.get()).toEqual({ askWhereToSave: true, folder: null });
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe(before);
  });

  it("keeps a new value for this run but never overwrites an unreadable file", () => {
    fs.writeFileSync(settingsFile(), "{broken");
    const store = createBrowserToolSettingsStore(settingsFile());
    expect(store.get()).toEqual({ askWhereToSave: false, folder: null });

    expect(store.update({ askWhereToSave: true })).toEqual({ askWhereToSave: true, folder: null });
    expect(store.get()).toEqual({ askWhereToSave: true, folder: null });
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe("{broken");
  });

  it("keeps a new value for this run when the parent path cannot be written", () => {
    const parent = path.join(root, "not-a-directory");
    fs.writeFileSync(parent, "file");
    const store = createBrowserToolSettingsStore(path.join(parent, "settings.json"));

    expect(store.get()).toEqual({ askWhereToSave: false, folder: null });
    expect(store.update({ askWhereToSave: true })).toEqual({ askWhereToSave: true, folder: null });
    expect(store.get()).toEqual({ askWhereToSave: true, folder: null });
  });
});
