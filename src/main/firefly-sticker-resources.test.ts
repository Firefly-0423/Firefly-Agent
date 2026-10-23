import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AUTO_SEND_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_DESCRIPTIONS, BUILT_IN_STICKER_FILES } from "./stickers/sticker-descriptions";
import { BUILT_IN_STICKER_IDS } from "../shared/sticker-types";

const { dataDir } = vi.hoisted(() => ({ dataDir: { value: "" } }));
vi.mock("electron", () => ({ app: { getPath: () => dataDir.value, getAppPath: () => process.cwd() } }));
import { deleteUserSticker, getAllStickerConfig, isStickerIdTaken } from "./stickers/sticker-storage";
import { buildStickerEmbeddingIndex } from "./stickers/sticker-embedder";
import { resolveStickerImagePath } from "./channels/outgoing-composer";

afterEach(() => { if (dataDir.value) fs.rmSync(dataDir.value, { recursive: true, force: true }); });

it("preserves an existing custom ID even when a new built-in uses the same name", async () => {
  dataDir.value = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-sticker-conflict-"));
  const stickers = { "firefly-hug": { id: "firefly-hug", file: "custom.gif", description: "公开自定义", phrases: ["自定义含义"], createdAt: 1 } };
  fs.writeFileSync(path.join(dataDir.value, "sticker-manifest.json"), JSON.stringify({ schemaVersion: 1, stickers }));
  expect(getAllStickerConfig({}).filter(item => item.id === "firefly-hug")).toMatchObject([{ builtIn: false }]);
  expect(resolveStickerImagePath("firefly-hug")).toBe(path.join(dataDir.value, "stickers", "custom.gif"));
  const provider = { name: "public-test", dims: 1, embed: async () => [1], embedBatch: async (texts: string[]) => texts.map(text => [text === "自定义含义" ? 2 : 1]) };
  const index = await buildStickerEmbeddingIndex(provider, BUILT_IN_STICKER_DESCRIPTIONS, stickers);
  expect(index.filter(entry => entry.id === "firefly-hug")).toEqual([{ id: "firefly-hug", embedding: [2] }]);
  await expect(deleteUserSticker("firefly-hug")).resolves.toBeUndefined();
});

it("loads 29 Firefly IDs with matching PNG resources and descriptions", () => {
  expect(BUILT_IN_STICKER_IDS).toHaveLength(29);
  expect(Object.keys(BUILT_IN_STICKER_FILES)).toEqual([...BUILT_IN_STICKER_IDS]);
  expect(Object.keys(BUILT_IN_STICKER_DESCRIPTIONS)).toEqual([...BUILT_IN_STICKER_IDS]);
  for (const id of BUILT_IN_STICKER_IDS) {
    expect(id).toMatch(/^firefly-/);
    expect(BUILT_IN_STICKER_DESCRIPTIONS[id].phrases.length).toBeGreaterThan(0);
    const bytes = fs.readFileSync(path.resolve(__dirname, "../renderer/public/stickers", BUILT_IN_STICKER_FILES[id]));
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
  expect(fs.readdirSync(path.resolve(__dirname, "../renderer/public/stickers"))).toHaveLength(29);
});

it("lists built-ins with saved toggles and preserves user GIF metadata without writes", () => {
  dataDir.value = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-stickers-"));
  const file = path.join(dataDir.value, "sticker-manifest.json");
  const original = JSON.stringify({ schemaVersion: 1, stickers: { personal: { id: "personal", file: "personal.gif", description: "公开测试", phrases: [], createdAt: 1 } } });
  fs.writeFileSync(file, original);
  const items = getAllStickerConfig({ "firefly-hug": false });
  expect(items).toHaveLength(30);
  expect(items.find(item => item.id === "firefly-hug")).toMatchObject({ enabled: false, builtIn: true, src: "/stickers/hug.png" });
  expect(items.find(item => item.id === "personal")).toMatchObject({ builtIn: false, enabled: true });
  expect(items.find(item => item.id === "personal")?.src).toContain("personal.gif");
  expect(isStickerIdTaken("hugtight")).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(resolveStickerImagePath("firefly-hug")).toMatch(/hug\.png$/);
  expect(resolveStickerImagePath("hugtight")).toBeNull();
});

it("auto-sends only the 8 dedicated stickers, never the manual built-ins", () => {
  expect(Object.keys(AUTO_SEND_STICKER_DESCRIPTIONS)).toEqual([
    "firefly-pout", "firefly-wink", "firefly-amazed", "firefly-smile-ok",
    "firefly-flustered", "firefly-bubble-tea", "firefly-wink-tongue", "firefly-cake",
  ]);
  expect(AUTO_SEND_STICKER_DESCRIPTIONS["firefly-hug"]).toBeUndefined();
  for (const id of Object.keys(AUTO_SEND_STICKER_DESCRIPTIONS)) expect(BUILT_IN_STICKER_FILES[id]).toBeTruthy();
});
