import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEmbeddingProviderIdentity, type EmbeddingProvider } from "../rag/embedding";
import { buildStickerEmbeddingIndex, type StickerEmbeddingEntry } from "./sticker-embedder";

type StickerDescriptionInput = Record<string, { phrases: string[] }>;
type DiskIndex = { createdAt: string; entries: StickerEmbeddingEntry[]; key: string; schemaVersion: 1 };
function userCacheRoot(): string {
  const electron = require("electron") as typeof import("electron");
  return electron.app.getPath("userData");
}
function descriptionRows(scope: "built-in" | "user", input: StickerDescriptionInput) {
  return Object.entries(input).map(([key, description]) => ({ scope, id: key,
    phrases: Array.isArray(description.phrases) ? description.phrases.map((part) => String(part)) : [],
  })).sort((left, right) => left.id.localeCompare(right.id));
}
async function identityKey(stock: StickerDescriptionInput, custom: StickerDescriptionInput): Promise<string> {
  const identity = await getEmbeddingProviderIdentity();
  const serialized = JSON.stringify({ schemaVersion: 1, provider: identity,
    stickers: [...descriptionRows("built-in", stock), ...descriptionRows("user", custom)] });
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}
function cachedEntries(file: string, key: string): StickerEmbeddingEntry[] | null {
  try {
    if (!fs.existsSync(file)) return null;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object") return null;
    const stored = value as DiskIndex;
    if (stored.schemaVersion !== 1 || stored.key !== key || typeof stored.createdAt !== "string") return null;
    if (!Array.isArray(stored.entries)) return null;
    const valid = stored.entries.every((row) => row && typeof row.id === "string"
      && Array.isArray(row.embedding) && row.embedding.every((component) => typeof component === "number" && Number.isFinite(component)));
    return valid ? stored.entries : null;
  } catch { return null; }
}
export async function buildCachedStickerEmbeddingIndex(
  provider: EmbeddingProvider, builtIn: StickerDescriptionInput,
  userStickers: StickerDescriptionInput, cacheDir = userCacheRoot(),
): Promise<StickerEmbeddingEntry[]> {
  const destination = path.join(cacheDir, "sticker-embedding-cache.json");
  const fingerprint = await identityKey(builtIn, userStickers);
  const hit = cachedEntries(destination, fingerprint);
  if (hit) return hit;
  const computed = await buildStickerEmbeddingIndex(provider, builtIn, userStickers);
  try {
    const payload: DiskIndex = { schemaVersion: 1, key: fingerprint, entries: computed, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = `${destination}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(staging, destination);
  } catch (failure) { console.warn("[StickerEmbedding] cache write failed:", failure); }
  return computed;
}
