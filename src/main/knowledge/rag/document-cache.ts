import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { DOCUMENT_CHUNK_OVERLAP, DOCUMENT_CHUNK_SIZE } from "./chunk";
import { getEmbeddingProviderIdentity } from "./embedding";

export type DocumentCacheIdentity = {
  textSha256: string; embeddingProvider: string; embeddingModel: string;
  embeddingEndpoint?: string; dimensions: number; chunkStrategyVersion: string;
  chunkSize: number; chunkOverlap: number;
};
export type DocumentCacheRecord = {
  key: string; importId: string; chunkCount: number;
  fileName: string; createdAt: string;
};
type CacheEnvelope = { records: Record<string, unknown> };

export function normalizeDocumentTextForCache(text: string): string {
  const unixLines = text.replace(/\r\n/g, "\n");
  return unixLines.replace(/\r/g, "\n");
}
export function sha256(input: string): string {
  const digest = crypto.createHash("sha256");
  digest.update(input, "utf8");
  return digest.digest("hex");
}
export function createDocumentCacheKey(identity: DocumentCacheIdentity): string {
  const serialized = JSON.stringify(identity);
  return sha256(serialized);
}
export async function buildDocumentCacheIdentity(text: string): Promise<DocumentCacheIdentity> {
  const canonical = normalizeDocumentTextForCache(text);
  return buildDocumentCacheIdentityFromTextSha(sha256(canonical));
}
export async function buildDocumentCacheIdentityFromTextSha(textSha256: string): Promise<DocumentCacheIdentity> {
  const embedding = await getEmbeddingProviderIdentity();
  // Property insertion order is part of the on-disk cache identity.
  return {
    textSha256, embeddingProvider: embedding.provider,
    embeddingModel: embedding.model, embeddingEndpoint: embedding.endpoint,
    dimensions: embedding.dimensions, chunkStrategyVersion: "document-chunks-v1",
    chunkSize: DOCUMENT_CHUNK_SIZE, chunkOverlap: DOCUMENT_CHUNK_OVERLAP,
  };
}

function location(): string {
  return path.join(app.getPath("userData"), "rag-data", "document-cache.json");
}
async function readEnvelope(): Promise<CacheEnvelope> {
  try {
    const contents = await fs.readFile(location(), "utf8");
    const data = JSON.parse(contents) as Partial<CacheEnvelope>;
    const entries = data.records;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) return { records: entries };
  } catch { /* A cache failure is a miss. */ }
  return { records: {} };
}
async function replaceEnvelope(envelope: CacheEnvelope): Promise<void> {
  const destination = location();
  const scratch = `${destination}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(scratch, JSON.stringify(envelope, null, 2), "utf8");
  await fs.rename(scratch, destination);
}
function acceptsRecord(candidate: unknown): candidate is DocumentCacheRecord {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const fields = candidate as Record<string, unknown>;
  return typeof fields.key === "string" && typeof fields.importId === "string"
    && typeof fields.fileName === "string" && typeof fields.createdAt === "string"
    && typeof fields.chunkCount === "number" && Number.isFinite(fields.chunkCount) && fields.chunkCount >= 0;
}
export async function getDocumentCacheRecord(identity: DocumentCacheIdentity): Promise<DocumentCacheRecord | null> {
  const key = createDocumentCacheKey(identity);
  return getDocumentCacheRecordByKey(key);
}
export async function getDocumentCacheRecordByKey(key: string): Promise<DocumentCacheRecord | null> {
  const envelope = await readEnvelope();
  const candidate = envelope.records[key];
  if (!acceptsRecord(candidate)) return null;
  return candidate.key === key ? candidate : null;
}
export async function putDocumentCacheRecord(record: DocumentCacheRecord): Promise<void> {
  const envelope = await readEnvelope();
  envelope.records[record.key] = record;
  await replaceEnvelope(envelope);
}
export async function getValidDocumentCacheRecord(key: string, hasImportId: (importId: string) => boolean): Promise<DocumentCacheRecord | null> {
  const cached = await getDocumentCacheRecordByKey(key);
  if (cached === null) return null;
  return hasImportId(cached.importId) ? cached : null;
}
