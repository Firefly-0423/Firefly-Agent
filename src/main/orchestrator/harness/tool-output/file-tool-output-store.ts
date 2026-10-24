import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fireflyDataDirectory } from "../../../firefly-data-paths";
import { ephemeralConversations } from "../../../ephemeral-conversations";
import type { ToolOutputStore, ToolOutputRef, ReadToolOutputResult, ReadToolOutputInput, PutToolOutputInput,
  FindToolOutputResult, FindToolOutputMatch, FindToolOutputInput } from "./types";

export const MAX_READ_CODE_POINTS = 8_192;
const referencePrefix = "tool-result://v1/";
type RecordMeta = Omit<ToolOutputRef, "resultRef"> & {
  sha256: string; outcome: PutToolOutputInput["outcome"]; ownerSessionId?: string; conversationId: string; schemaVersion: 1;
};
export class ToolOutputInvalidInputError extends Error { readonly code = "E_TOOL_OUTPUT_INVALID_INPUT"; }
export class ToolOutputCorruptError extends Error { readonly code = "E_TOOL_OUTPUT_CORRUPT"; }
export class ToolOutputPersistenceError extends Error {
  readonly code = "E_TOOL_OUTPUT_PERSISTENCE";
  constructor(message: string, readonly cause?: unknown) { super(message); }
}
function sha256(text: string): string {
  const hash = createHash("sha256");
  hash.update(text, "utf8");
  return hash.digest("hex");
}
export function toolOutputRecordId(conversationId: string, runId: string, toolCallId: string): string {
  return sha256(conversationId + "\0" + runId + "\0" + toolCallId);
}
export function toolOutputResultRef(recordId: string): string { return referencePrefix + recordId; }
function countCodePoints(text: string): number {
  let cursor = 0, total = 0;
  while (cursor < text.length) {
    cursor += text.codePointAt(cursor)! > 0xffff ? 2 : 1;
    total++;
  }
  return total;
}
function sliceCodePoints(text: string, offset: number, length: number): string {
  let from = 0, skipped = 0;
  while (skipped < offset && from < text.length) { from += text.codePointAt(from)! > 0xffff ? 2 : 1; skipped++; }
  let until = from, taken = 0;
  while (taken < length && until < text.length) { until += text.codePointAt(until)! > 0xffff ? 2 : 1; taken++; }
  return text.slice(from, until);
}
function parseResultRef(reference: string): string {
  const id = reference.startsWith(referencePrefix) ? reference.slice(referencePrefix.length) : "";
  if (/^[a-f0-9]{64}$/.test(id)) return id;
  throw new ToolOutputInvalidInputError("工具结果引用无效");
}
function validateRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ToolOutputInvalidInputError("offset 必须是非负整数");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_READ_CODE_POINTS) throw new ToolOutputInvalidInputError(`length 必须是 1-${MAX_READ_CODE_POINTS} 的整数`);
}
function validateOwnerSessionId(ownerSessionId: string | undefined): void {
  if (ownerSessionId !== undefined && (typeof ownerSessionId !== "string" || !ownerSessionId.trim())) throw new ToolOutputInvalidInputError("工具结果所有者标识无效");
}
function isNodeNotFound(cause: unknown): boolean {
  return !!cause && typeof cause === "object" && (cause as { code?: unknown }).code === "ENOENT";
}
function isRecordMeta(value: unknown): value is RecordMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.schemaVersion === 1 && typeof entry.recordId === "string" && /^[a-f0-9]{64}$/.test(entry.recordId)
    && typeof entry.conversationId === "string"
    && (entry.ownerSessionId === undefined || (typeof entry.ownerSessionId === "string" && entry.ownerSessionId.trim().length > 0))
    && typeof entry.runId === "string" && typeof entry.toolCallId === "string" && typeof entry.toolName === "string"
    && (entry.outcome === "success" || entry.outcome === "failure" || entry.outcome === "unknown")
    && typeof entry.createdAt === "number" && typeof entry.bytes === "number" && typeof entry.codePoints === "number"
    && typeof entry.truncatedForModel === "boolean" && typeof entry.sha256 === "string";
}
function toRef(record: RecordMeta): ToolOutputRef {
  return { recordId: record.recordId, resultRef: toolOutputResultRef(record.recordId), runId: record.runId,
    toolCallId: record.toolCallId, toolName: record.toolName, bytes: record.bytes, codePoints: record.codePoints,
    truncatedForModel: record.truncatedForModel, createdAt: record.createdAt };
}
type Stored = { meta: RecordMeta; output: string };
const memoryResults = new Map<string, Map<string, Stored>>();
export type FileToolOutputStoreOptions = { now?: () => number };
export class FileToolOutputStore implements ToolOutputStore {
  private readonly directory: string;
  private readonly clock: () => number;
  constructor(root: string, options: FileToolOutputStoreOptions = {}) {
    this.directory = path.resolve(fireflyDataDirectory(root, "runs"), "tool-results");
    this.clock = options.now ?? Date.now;
  }
  private metadata(input: PutToolOutputInput, id: string): RecordMeta {
    return { schemaVersion: 1, recordId: id, conversationId: input.conversationId,
      ...(input.ownerSessionId !== undefined ? { ownerSessionId: input.ownerSessionId } : {}),
      runId: input.runId, toolCallId: input.toolCallId, toolName: input.toolName, outcome: input.outcome, createdAt: this.clock(),
      bytes: Buffer.byteLength(input.output, "utf8"), codePoints: countCodePoints(input.output),
      truncatedForModel: input.truncatedForModel, sha256: sha256(input.output) };
  }
  private sameInvocation(meta: RecordMeta, input: PutToolOutputInput): void {
    if (meta.runId !== input.runId || meta.toolCallId !== input.toolCallId || meta.ownerSessionId !== input.ownerSessionId) throw new ToolOutputCorruptError("工具结果记录身份不匹配");
  }
  async put(input: PutToolOutputInput): Promise<ToolOutputRef> {
    this.validatePutInput(input);
    const id = toolOutputRecordId(input.conversationId, input.runId, input.toolCallId);
    if (ephemeralConversations.has(input.conversationId)) {
      const records = memoryResults.get(input.conversationId) ?? new Map<string, Stored>();
      memoryResults.set(input.conversationId, records);
      const previous = records.get(id);
      if (previous) { this.sameInvocation(previous.meta, input); return toRef(previous.meta); }
      const meta = this.metadata(input, id);
      records.set(id, { meta, output: input.output });
      return toRef(meta);
    }
    const location = this.recordDir(input.conversationId, id);
    try {
      const previous = await this.readMetaIfPresent(location);
      if (previous) {
        await this.readAndValidate(location, input.conversationId, id);
        this.sameInvocation(previous, input);
        return toRef(previous);
      }
      await mkdir(location, { recursive: true });
      const outputFile = path.join(location, "output.txt");
      const outputStaging = `${outputFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(outputStaging, input.output, "utf8");
      await rename(outputStaging, outputFile);
      const meta = this.metadata(input, id);
      const metaFile = path.join(location, "meta.json");
      const metaStaging = `${metaFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(metaStaging, JSON.stringify(meta), "utf8");
      await rename(metaStaging, metaFile);
      return toRef(meta);
    } catch (cause) {
      if (cause instanceof ToolOutputCorruptError) throw cause;
      throw new ToolOutputPersistenceError("工具结果保存失败", cause);
    }
  }
  async read(input: ReadToolOutputInput): Promise<ReadToolOutputResult | null> {
    validateOwnerSessionId(input.ownerSessionId);
    validateRange(input.offset, input.length);
    const id = parseResultRef(input.resultRef);
    const stored = await this.readAndValidate(this.recordDir(input.conversationId, id), input.conversationId, id, input.ownerSessionId);
    if (!stored) return null;
    return { content: sliceCodePoints(stored.output, input.offset, input.length), offset: input.offset,
      totalCodePoints: stored.meta.codePoints, resultRef: input.resultRef };
  }
  async find(input: FindToolOutputInput): Promise<FindToolOutputResult | null> {
    validateOwnerSessionId(input.ownerSessionId);
    if (!input.query || Array.from(input.query).length > MAX_READ_CODE_POINTS) throw new ToolOutputInvalidInputError("query 必须是 1-8192 个 Unicode 码点");
    const id = parseResultRef(input.resultRef);
    const stored = await this.readAndValidate(this.recordDir(input.conversationId, id), input.conversationId, id, input.ownerSessionId);
    if (!stored) return null;
    const content = Array.from(stored.output);
    const needle = Array.from(input.query);
    const matches: FindToolOutputMatch[] = [];
    for (let cursor = 0; cursor <= content.length - needle.length && matches.length < 8; cursor++) {
      if (!needle.every((character, position) => content[cursor + position] === character)) continue;
      const from = Math.max(0, cursor - 160);
      const until = Math.min(content.length, cursor + needle.length + 160);
      matches.push({ offset: cursor, preview: content.slice(from, until).join("") });
    }
    return { resultRef: input.resultRef, totalCodePoints: content.length, matches };
  }
  async deleteConversation(conversationId: string): Promise<void> {
    if (!conversationId) throw new ToolOutputInvalidInputError("conversationId 不能为空");
    memoryResults.delete(conversationId);
    const location = this.conversationDir(conversationId);
    this.assertWithinRoot(location);
    await rm(location, { recursive: true, force: true });
  }
  private validatePutInput(input: PutToolOutputInput): void {
    validateOwnerSessionId(input.ownerSessionId);
    if (!input.conversationId || !input.runId || !input.toolCallId || !input.toolName) throw new ToolOutputInvalidInputError("工具结果缺少会话、运行、调用或工具标识");
    if (typeof input.output !== "string") throw new ToolOutputInvalidInputError("工具结果必须是字符串");
  }
  private conversationDir(conversationId: string): string { return path.join(this.directory, sha256(conversationId)); }
  private recordDir(conversationId: string, recordId: string): string {
    const location = path.join(this.conversationDir(conversationId), "records", recordId);
    this.assertWithinRoot(location);
    return location;
  }
  private assertWithinRoot(target: string): void {
    const suffix = path.relative(this.directory, target);
    if (suffix === "" || suffix.startsWith("..") || path.isAbsolute(suffix)) throw new ToolOutputInvalidInputError("工具结果存储路径无效");
  }
  private async readMetaIfPresent(directory: string): Promise<RecordMeta | null> {
    try {
      const content = await readFile(path.join(directory, "meta.json"), "utf8");
      const decoded = JSON.parse(content) as unknown;
      if (!isRecordMeta(decoded)) throw new ToolOutputCorruptError("工具结果元数据损坏");
      return decoded;
    } catch (cause) { if (isNodeNotFound(cause)) return null; throw cause; }
  }
  private async readAndValidate(directory: string, conversationId: string, recordId: string, ownerSessionId?: string): Promise<Stored | null> {
    if (ephemeralConversations.has(conversationId)) {
      const stored = memoryResults.get(conversationId)?.get(recordId);
      if (!stored || stored.meta.recordId !== recordId || stored.meta.conversationId !== conversationId) return null;
      if (ownerSessionId !== undefined && stored.meta.ownerSessionId !== ownerSessionId) return null;
      return stored;
    }
    const meta = await this.readMetaIfPresent(directory);
    if (!meta || meta.recordId !== recordId || meta.conversationId !== conversationId) return null;
    if (ownerSessionId !== undefined && meta.ownerSessionId !== ownerSessionId) return null;
    let content: string;
    try { content = await readFile(path.join(directory, "output.txt"), "utf8"); }
    catch (cause) { if (isNodeNotFound(cause)) throw new ToolOutputCorruptError("工具结果内容缺失"); throw cause; }
    if (sha256(content) !== meta.sha256 || Buffer.byteLength(content, "utf8") !== meta.bytes || countCodePoints(content) !== meta.codePoints) throw new ToolOutputCorruptError("工具结果内容校验失败");
    return { meta, output: content };
  }
}
