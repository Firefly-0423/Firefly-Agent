import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));

import {
  addUserSticker,
  deleteUserSticker,
  getAllStickerConfig,
  getLocalStickerUrl,
  getStickersDir,
  getUserStickerFilePath,
  isStickerIdTaken,
  loadUserStickerManifest,
} from "./sticker-storage";

let root = "";
const manifestPath = () => path.join(root, "sticker-manifest.json");
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as {
  schemaVersion: number;
  stickers: Record<string, { file: string; description: string; phrases: string[]; createdAt: number }>;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-stickers-"));
  mocks.userData = root;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function sourceFile(name = "source.png"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

describe("paths and manifest loading", () => {
  it("resolves sticker paths under userData", () => {
    expect(getStickersDir()).toBe(path.join(root, "stickers"));
    expect(getUserStickerFilePath("a.png")).toBe(path.join(root, "stickers", "a.png"));
    expect(getLocalStickerUrl("a b.png")).toBe("local-sticker:///a%20b.png");
  });

  it("returns an empty manifest when the file does not exist", () => {
    expect(loadUserStickerManifest()).toEqual({});
  });

  it("returns an empty manifest for corrupt JSON and logs", () => {
    fs.writeFileSync(manifestPath(), "{broken", "utf8");
    expect(loadUserStickerManifest()).toEqual({});
    expect(console.error).toHaveBeenCalledWith("[stickers] load manifest failed:", expect.any(Error));
  });

  it("reads saved stickers and tolerates a missing stickers field", () => {
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 1, stickers: { a: { id: "a" } } }), "utf8");
    expect(loadUserStickerManifest()).toEqual({ a: { id: "a" } });
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(loadUserStickerManifest()).toEqual({});
  });
});

describe("isStickerIdTaken", () => {
  it("reserves built-in, retired and manifest ids", async () => {
    expect(isStickerIdTaken("firefly-hug")).toBe(true);
    expect(isStickerIdTaken("playful")).toBe(true);
    expect(isStickerIdTaken("custom")).toBe(false);
    await addUserSticker(sourceFile(), "custom", "a custom sticker", ["hi"]);
    expect(isStickerIdTaken("custom")).toBe(true);
  });
});

describe("addUserSticker", () => {
  it("copies the image and writes a manifest entry", async () => {
    const source = sourceFile("dance.PNG");
    const before = Date.now();
    await addUserSticker(source, "dance", "dancing", ["dance", "party"]);
    const destination = path.join(root, "stickers", "dance.png");
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(source));
    const manifest = readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.stickers.dance).toMatchObject({
      id: "dance",
      file: "dance.png",
      description: "dancing",
      phrases: ["dance", "party"],
    });
    expect(manifest.stickers.dance!.createdAt).toBeGreaterThanOrEqual(before);
    expect(manifest.stickers.dance!.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a duplicate id with the exact message", async () => {
    await addUserSticker(sourceFile(), "dance", "dancing", []);
    await expect(addUserSticker(sourceFile(), "dance", "again", [])).rejects.toThrow(
      '表情包 ID "dance" 已存在',
    );
  });

  it("rejects unsupported extensions before copying", async () => {
    const source = sourceFile("anim.svg");
    await expect(addUserSticker(source, "anim", "vector", [])).rejects.toThrow("不支持的图片格式: .svg");
    expect(fs.existsSync(path.join(root, "stickers"))).toBe(false);
  });

  it("preserves previously saved stickers", async () => {
    await addUserSticker(sourceFile("one.png"), "one", "first", []);
    await addUserSticker(sourceFile("two.jpg"), "two", "second", []);
    expect(Object.keys(readManifest().stickers)).toEqual(["one", "two"]);
  });
});

describe("deleteUserSticker", () => {
  it("removes the file and the manifest entry", async () => {
    await addUserSticker(sourceFile(), "dance", "dancing", []);
    await deleteUserSticker("dance");
    expect(fs.existsSync(path.join(root, "stickers", "dance.png"))).toBe(false);
    expect(readManifest().stickers).toEqual({});
  });

  it("still removes the entry when the image was already deleted by hand", async () => {
    await addUserSticker(sourceFile(), "dance", "dancing", []);
    fs.unlinkSync(path.join(root, "stickers", "dance.png"));
    await expect(deleteUserSticker("dance")).resolves.toBeUndefined();
    expect(readManifest().stickers).toEqual({});
  });

  it("refuses to delete a built-in sticker with the exact message", async () => {
    await expect(deleteUserSticker("firefly-hug")).rejects.toThrow('内置表情包 "firefly-hug" 不能删除，只能禁用');
  });

  it("reports an unknown sticker with the exact message", async () => {
    await expect(deleteUserSticker("missing")).rejects.toThrow('表情包 "missing" 不存在');
  });
});

describe("getAllStickerConfig", () => {
  it("lists every built-in enabled by default", () => {
    const items = getAllStickerConfig({});
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({
      id: "firefly-hug",
      src: "/stickers/hug.png",
      enabled: true,
      builtIn: true,
    });
    expect(items[0]?.description).toContain("，");
  });

  it("applies saved enable switches to built-ins", () => {
    const items = getAllStickerConfig({ "firefly-hug": false });
    expect(items.find((item) => item.id === "firefly-hug")?.enabled).toBe(false);
    expect(items.find((item) => item.id === "firefly-meal")?.enabled).toBe(true);
  });

  it("appends user stickers with local protocol URLs and phrases", async () => {
    await addUserSticker(sourceFile(), "dance", "dancing", ["dance", "party"]);
    const item = getAllStickerConfig({})?.find((entry) => entry.id === "dance");
    expect(item).toMatchObject({
      id: "dance",
      src: "local-sticker:///dance.png",
      enabled: true,
      builtIn: false,
      description: "dance，party",
    });
  });

  it("falls back to the description when a user sticker has no phrases", async () => {
    await addUserSticker(sourceFile(), "quiet", "silent sticker", []);
    expect(getAllStickerConfig({}).find((entry) => entry.id === "quiet")?.description).toBe("silent sticker");
  });

  it("lets a manifest entry replace a built-in id", () => {
    fs.writeFileSync(
      manifestPath(),
      JSON.stringify({
        schemaVersion: 1,
        stickers: {
          "firefly-hug": { id: "firefly-hug", file: "hug.png", description: "user hug", phrases: ["mine"], createdAt: 1 },
        },
      }),
      "utf8",
    );
    const items = getAllStickerConfig({});
    expect(items.filter((item) => item.id === "firefly-hug")).toHaveLength(1);
    expect(items.find((item) => item.id === "firefly-hug")).toMatchObject({
      builtIn: false,
      description: "mine",
    });
  });

  it("refuses to add a user sticker that reuses a built-in id", async () => {
    await expect(addUserSticker(sourceFile(), "firefly-hug", "user hug", ["mine"])).rejects.toThrow(
      '表情包 ID "firefly-hug" 已存在',
    );
    expect(fs.existsSync(manifestPath())).toBe(false);
  });
});
