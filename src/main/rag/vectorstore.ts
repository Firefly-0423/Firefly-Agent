import * as path from "path";
import * as fs from "fs";
import { type EmbeddingIndexMetadata, type EmbeddingProvider, getEmbeddingProvider } from "./embedding";

export type { EmbeddingIndexMetadata };

export type MemoryEntry = {
  metadata?: Record<string, unknown>;
  lastRecalledAt: number;
  createdAt: number;
  weight: number;
  source: string;
  embedding: number[];
  text: string;
  id: string;
};
export type SearchResult = { score: number; entry: MemoryEntry };
export type VectorSearchOptions = { allowedEntryIds?: string[]; importIds?: string[] };

export function cosineSimilarity(a: number[], b: number[]): number {
  let product = 0;
  for (let position = 0; position < a.length; position += 1) {
    product += a[position] * b[position];
  }
  return product;
}

type PreparedMemory = { text: string; source: string; embedding: number[]; metadata?: Record<string, unknown> };

export class JsonVectorStore {
  // retriever 也通过此字段读取条目。
  private entries: MemoryEntry[] = [];
  private metadata: EmbeddingIndexMetadata | null = null;
  private dataFilename: string;
  private metadataFilename: string;
  private needsWrite = false;
  private pendingWrite: Promise<void> | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private epoch = 0;

  constructor(dbPath: string) {
    this.dataFilename = path.join(dbPath, "memory-store.json");
    this.metadataFilename = path.join(dbPath, "memory-store-meta.json");
    try {
      if (fs.existsSync(this.dataFilename)) {
        this.entries = JSON.parse(fs.readFileSync(this.dataFilename, "utf8")) as MemoryEntry[];
      }
    } catch (failure) {
      console.warn("[RAG] failed to load vector store:", failure);
      this.entries = [];
    }
    try {
      if (fs.existsSync(this.metadataFilename)) {
        this.metadata = JSON.parse(fs.readFileSync(this.metadataFilename, "utf8")) as EmbeddingIndexMetadata;
      }
    } catch {
      this.metadata = null;
    }
  }

  private prepareDirectory(filename: string): void {
    const parent = path.dirname(filename);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  }

  private writeJsonSync(filename: string, value: unknown): void {
    this.prepareDirectory(filename);
    const temporaryFilename = `${filename}.tmp`;
    fs.writeFileSync(temporaryFilename, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporaryFilename, filename);
  }

  private persistMetadata(): void {
    try {
      this.writeJsonSync(this.metadataFilename, this.metadata);
    } catch (failure) {
      console.warn("[RAG] failed to save index metadata:", failure);
    }
  }

  private stopTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private changed(): void {
    this.needsWrite = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      void this.writeOnce().catch(() => {});
    }, 5000);
    this.timeout.unref();
  }

  private writeOnce(): Promise<void> {
    if (this.pendingWrite) return this.pendingWrite;
    const operation = this.writeSnapshot(this.epoch);
    this.pendingWrite = operation;
    const finish = () => { this.pendingWrite = null; };
    operation.then(finish, finish);
    return operation;
  }

  private async writeSnapshot(startEpoch: number): Promise<void> {
    this.needsWrite = false;
    try {
      const serialized = JSON.stringify(this.entries, null, 2);
      await fs.promises.mkdir(path.dirname(this.dataFilename), { recursive: true });
      const temporaryFilename = `${this.dataFilename}.tmp`;
      await fs.promises.writeFile(temporaryFilename, serialized, "utf8");
      if (startEpoch !== this.epoch) return;
      await fs.promises.rename(temporaryFilename, this.dataFilename);
    } catch (failure) {
      this.needsWrite = true;
      console.warn("[RAG] failed to save vector store:", failure);
      throw failure;
    }
  }

  async flush(): Promise<void> {
    this.stopTimeout();
    while (this.needsWrite || this.pendingWrite !== null) {
      try {
        await this.writeOnce();
      } catch {
        return;
      }
    }
  }

  flushSync(): void {
    this.stopTimeout();
    if (this.needsWrite) {
      try {
        this.writeJsonSync(this.dataFilename, this.entries);
        this.needsWrite = false;
      } catch (failure) {
        console.warn("[RAG] failed to flush vector store:", failure);
      }
    }
  }

  clearForRebuild(): void {
    this.epoch++;
    this.stopTimeout();
    this.entries = [];
    this.needsWrite = false;
    this.metadata = null;
    try {
      this.prepareDirectory(this.dataFilename);
      fs.writeFileSync(this.dataFilename, "[]", "utf8");
    } catch (failure) {
      console.warn("[RAG] failed to clear vector store file:", failure);
    }
  }

  private describeIndex(engine: EmbeddingProvider, width: number): EmbeddingIndexMetadata {
    const fingerprint = engine.cacheIdentity;
    return {
      provider: fingerprint?.provider ?? engine.name,
      model: fingerprint?.model ?? engine.name,
      dimensions: width,
      cacheIdentity: fingerprint ? JSON.stringify(fingerprint) : engine.name,
    };
  }

  private checkDimensions(engine: EmbeddingProvider): void {
    const width = engine.resolvedDimensions ?? engine.declaredDimensions;
    if (width === undefined) return;
    if (this.metadata) {
      if (this.metadata.dimensions !== width) {
        throw new Error([
          `[RAG] Index dimension mismatch: index was built with ${this.metadata.dimensions}-dim `,
          `(model: ${this.metadata.model}), but current provider declares ${width}-dim. `,
          "Rebuild the index or switch back to the original model.",
        ].join(""));
      }
      return;
    }
    if (this.entries.length > 0) {
      const previousWidth = this.entries[0].embedding.length;
      if (previousWidth !== width) {
        throw new Error([
          `[RAG] Index dimension mismatch: existing index has ${previousWidth}-dim vectors, `,
          `but provider declares ${width}-dim. Rebuild the index first.`,
        ].join(""));
      }
      this.metadata = this.describeIndex(engine, width);
      this.persistMetadata();
      console.log("[RAG] migrated index metadata (inferred from existing vectors):", this.metadata);
    }
  }

  private recordDimensions(engine: EmbeddingProvider, width: number): void {
    if (!this.metadata) {
      this.metadata = this.describeIndex(engine, width);
      this.persistMetadata();
      console.log("[RAG] created index metadata:", this.metadata);
    }
  }

  getIndexMeta(): Readonly<EmbeddingIndexMetadata> | null { return this.metadata; }

  async add(
    text: string, source: string, provider: EmbeddingProvider, metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    this.checkDimensions(provider);
    const matches = await this.search(text, source, provider, 1, 0.95);
    if (matches.length > 0) {
      const recalled = matches[0].entry;
      recalled.weight = Math.min(recalled.weight + 0.1, 5.0);
      recalled.lastRecalledAt = Date.now();
      this.changed();
      return recalled;
    }
    const vector = await provider.embed(text);
    this.recordDimensions(provider, vector.length);
    const added: MemoryEntry = {
      id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: text,
      embedding: vector,
      source: source,
      weight: 1.0,
      createdAt: Date.now(),
      lastRecalledAt: Date.now(),
      metadata: metadata,
    };
    this.entries.push(added);
    this.changed();
    return added;
  }

  async addUnique(
    text: string, source: string, provider: EmbeddingProvider, metadata?: Record<string, unknown>,
  ): Promise<MemoryEntry> {
    this.checkDimensions(provider);
    const vector = await provider.embed(text);
    this.recordDimensions(provider, vector.length);
    const prepared = { text, source, embedding: vector, metadata };
    return this.addPreparedBatch([prepared])[0];
  }

  async addBatch(
    items: Array<{ text: string; source: string; metadata?: Record<string, unknown> }>,
    provider: EmbeddingProvider, options?: { isCancelled?: () => boolean },
  ): Promise<MemoryEntry[]> {
    this.checkDimensions(provider);
    const collected: MemoryEntry[] = [];
    for (let cursor = 0; cursor < items.length; cursor += 16) {
      if (options?.isCancelled?.()) throw new Error("cancelled");
      const group = items.slice(cursor, cursor + 16);
      const encoded = await provider.embedBatch(group.map(({ text }) => text));
      if (options?.isCancelled?.()) throw new Error("cancelled");
      if (encoded.length > 0) this.recordDimensions(provider, encoded[0].length);
      const prepared = group.map((row, position) => ({ ...row, embedding: encoded[position] }));
      collected.push(...this.addPreparedBatch(prepared));
    }
    return collected;
  }

  addPreparedBatch(items: Array<PreparedMemory>): MemoryEntry[] {
    const inserted: MemoryEntry[] = [];
    for (let position = 0; position < items.length; position += 1) {
      const row = items[position];
      const added: MemoryEntry = {
        id: `${row.source}_${Date.now()}_${position}_${Math.random().toString(36).slice(2, 6)}`,
        text: row.text,
        embedding: row.embedding,
        source: row.source,
        weight: 1.0,
        createdAt: Date.now(),
        lastRecalledAt: Date.now(),
        metadata: row.metadata,
      };
      this.entries.push(added);
      inserted.push(added);
    }
    this.changed();
    return inserted;
  }

  async search(
    query: string, source?: string, provider?: EmbeddingProvider,
    topK = 5, minScore = 0.3, options: VectorSearchOptions = {},
  ): Promise<SearchResult[]> {
    if (this.entries.length === 0) return [];
    const engine = provider ?? getEmbeddingProvider();
    if (!engine) return [];
    this.checkDimensions(engine);
    const encodedQuery = await engine.embed(query);
    const timestamp = Date.now();
    const ranked: SearchResult[] = [];
    const imports = new Set(options.importIds ?? []);
    const allowed = options.allowedEntryIds ? new Set(options.allowedEntryIds) : null;
    for (const memory of this.entries) {
      if (source && memory.source !== source) continue;
      if (imports.size && !imports.has(String(memory.metadata?.importId ?? ""))) continue;
      if (allowed && !allowed.has(memory.id)) continue;
      const product = cosineSimilarity(encodedQuery, memory.embedding);
      const idleHours = (timestamp - memory.lastRecalledAt) / (1000 * 60 * 60);
      const weighted = product * memory.weight * Math.pow(0.95, idleHours / 24);
      if (weighted >= minScore) ranked.push({ entry: memory, score: weighted });
    }
    ranked.sort((left, right) => right.score - left.score);
    const selected = ranked.slice(0, topK);
    for (const { entry: memory } of selected) {
      memory.lastRecalledAt = timestamp;
      memory.weight = Math.min(memory.weight + 0.05, 5.0);
    }
    if (selected.length > 0) this.changed();
    return selected;
  }

  prune(minWeight = 0.1): number {
    const previousCount = this.entries.length;
    this.entries = this.entries.filter(({ weight }) => weight >= minWeight);
    this.changed();
    return previousCount - this.entries.length;
  }

  deleteEntriesByIds(ids: string[], source?: string): number {
    const targets = new Set(ids);
    if (targets.size === 0) return 0;
    const previousCount = this.entries.length;
    this.entries = this.entries.filter((memory) =>
      !targets.has(memory.id) || (source !== undefined && memory.source !== source));
    const removedCount = previousCount - this.entries.length;
    if (removedCount > 0) this.changed();
    return removedCount;
  }

  deleteImportedDoc(importId: string, fileName?: string): number {
    const previousCount = this.entries.length;
    this.entries = this.entries.filter((memory) => {
      if (memory.source !== "imported_doc") return true;
      if (memory.metadata?.importId) return memory.metadata.importId !== importId;
      if (fileName && memory.metadata?.fileName === fileName) return false;
      return true;
    });
    const removedCount = previousCount - this.entries.length;
    if (removedCount > 0) this.changed();
    return removedCount;
  }

  hasImportedDocumentChunks(importId: string): boolean {
    return this.entries.some((memory) =>
      memory.source === "imported_doc" && String(memory.metadata?.importId ?? "") === importId);
  }

  get stats() {
    const tally: Record<string, number> = {};
    for (const memory of this.entries) tally[memory.source] = (tally[memory.source] || 0) + 1;
    return { total: this.entries.length, sources: tally };
  }
}
