import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import type { ChannelAttachment } from "../../types";
import { OneBotActionClient, OneBotActionError } from "./onebot-action-client";
import type { OneBotSegment, OneBotStreamPacket } from "./onebot-types";

export const ONEBOT_STREAM_MIN_VERSION = "4.8.115";
export const ONEBOT_STREAM_CHUNK_BYTES = 64 * 1024;
export const ONEBOT_BASE64_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const ONEBOT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const ONEBOT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const ONEBOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
type MediaKind = "image" | "audio" | "file" | "video";
function sanitizeFilename(candidate: string, fallback: string): string {
  const cleaned = path.basename(candidate || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (cleaned || fallback).slice(0, 120);
}
function extensionFor(category: MediaKind, filename?: string): string {
  const suffix = filename ? path.extname(filename).slice(0, 12) : "";
  if (suffix) return suffix;
  return category === "image" ? ".png" : category === "audio" ? ".mp3" : category === "video" ? ".mp4" : ".bin";
}
function mimeFor(category: MediaKind, filename: string): string {
  const suffix = path.extname(filename).toLowerCase();
  if (category === "image") {
    if (suffix === ".jpg" || suffix === ".jpeg") return "image/jpeg";
    if (suffix === ".gif") return "image/gif";
    if (suffix === ".webp") return "image/webp";
    return "image/png";
  }
  return category === "audio" ? suffix === ".wav" ? "audio/wav" : "audio/mpeg" : category === "video" ? "video/mp4" : "application/octet-stream";
}
export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const numbers = (label: string) => label.match(/\d+(?:\.\d+){1,3}/)?.[0].split(".").map((component) => Number(component)) ?? [];
  const actual = numbers(version), required = numbers(minimum);
  for (let position = 0; position < Math.max(actual.length, required.length); position++) {
    const observed = actual[position] ?? 0, wanted = required[position] ?? 0;
    if (observed !== wanted) return observed > wanted;
  }
  return true;
}
export class OneBotMediaManager {
  private sweep: NodeJS.Timeout | null = null;
  constructor(private readonly getClient: () => OneBotActionClient | null,
    private readonly cacheDir = path.join(app.getPath("userData"), "channels", "cache", "qq"),
    private readonly onStreamUnavailable?: (error: Error) => void) {}
  async start(): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await this.cleanupCache();
    this.sweep = setInterval(() => void this.cleanupCache(), 60 * 60 * 1000);
    this.sweep.unref?.();
  }
  stop(): void { if (this.sweep) clearInterval(this.sweep); this.sweep = null; }
  async downloadSegment(segment: OneBotSegment, supportsStream: boolean): Promise<ChannelAttachment> {
    const category = this.segmentKind(segment.type);
    const descriptor = segment.data;
    const identifier = String(descriptor.file_id ?? descriptor.file ?? descriptor.url ?? "");
    if (!identifier) throw new Error(`${segment.type} 消息缺少 file/file_id`);
    let filename: string;
    if (supportsStream) {
      const action = category === "image" ? "download_file_image_stream" : category === "audio" ? "download_file_record_stream" : "download_file_stream";
      try { filename = await this.downloadStream(action, identifier, category); }
      catch (failure) { this.reportStreamUnavailable(failure); throw failure; }
    } else {
      const address = typeof descriptor.url === "string" ? descriptor.url : "";
      if (!/^https?:\/\//i.test(address)) throw new Error("当前 NapCat 不支持 Stream API，且消息没有可下载 URL");
      filename = await this.downloadUrl(address, category);
    }
    await this.cleanupCache(new Set([filename]));
    return { kind: category, filePath: filename, mime: mimeFor(category, filename),
      caption: typeof descriptor.file_name === "string" ? descriptor.file_name : typeof descriptor.file === "string" ? path.basename(descriptor.file) : undefined };
  }
  async encodeOutbound(filePath: string, kind: MediaKind, supportsStream: boolean): Promise<string> {
    const canonical = await fs.promises.realpath(filePath);
    const metadata = await fs.promises.stat(canonical);
    if (!metadata.isFile()) throw new Error(`QQ 媒体路径不是文件: ${filePath}`);
    if (metadata.size > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 单文件不能超过 100 MiB");
    if ((kind === "image" || kind === "audio") && metadata.size <= ONEBOT_BASE64_THRESHOLD_BYTES) return `base64://${(await fs.promises.readFile(canonical)).toString("base64")}`;
    if (!supportsStream) throw new Error("NapCat Stream API 不可用，无法跨 WSL 发送此媒体");
    try { return await this.uploadStream(canonical, metadata.size); }
    catch (failure) { this.reportStreamUnavailable(failure); throw failure; }
  }
  async cleanupCache(protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const instant = Date.now();
    const retained: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const child of await fs.promises.readdir(this.cacheDir, { withFileTypes: true })) {
      if (!child.isFile()) continue;
      const filename = path.join(this.cacheDir, child.name);
      try {
        const metadata = await fs.promises.stat(filename);
        if (instant - metadata.mtimeMs > ONEBOT_CACHE_TTL_MS) { await fs.promises.unlink(filename); continue; }
        retained.push({ path: filename, size: metadata.size, mtimeMs: metadata.mtimeMs });
      } catch { /* 其他清理任务可能先移除了文件。 */ }
    }
    let occupied = retained.reduce((bytes, record) => bytes + record.size, 0);
    for (const record of retained.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (occupied <= ONEBOT_CACHE_MAX_BYTES) break;
      if (protectedPaths.has(record.path)) continue;
      try { await fs.promises.unlink(record.path); occupied -= record.size; }
      catch { /* 下次清理时再尝试。 */ }
    }
  }
  private segmentKind(category: string): MediaKind {
    switch (category) {
      case "image": case "mface": return "image";
      case "record": return "audio";
      case "video": return "video";
      case "file": return "file";
      default: throw new Error(`不支持的 QQ 媒体类型: ${category}`);
    }
  }
  private async downloadStream(action: string, file: string, kind: MediaKind): Promise<string> {
    const connection = this.getClient();
    if (!connection) throw new Error("NapCat 未连接");
    let destination = "";
    const opened: { handle?: fs.promises.FileHandle } = {};
    let declaredBytes = 0, blockSize = ONEBOT_STREAM_CHUNK_BYTES, receivedBytes = 0;
    const positions = new Set<number>();
    try {
      const parameters: Record<string, unknown> = { file, chunk_size: ONEBOT_STREAM_CHUNK_BYTES };
      if (kind === "audio") parameters.out_format = "mp3";
      const receipt = await connection.callStream<OneBotStreamPacket>(action, parameters, async (frame) => {
        if (frame.data_type === "file_info") {
          if (opened.handle || destination) throw new Error("Duplicate stream file_info packet");
          declaredBytes = Number(frame.file_size ?? 0);
          if (!Number.isFinite(declaredBytes) || declaredBytes < 0) throw new Error("Invalid stream file_size");
          if (declaredBytes > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站文件超过 100 MiB");
          blockSize = Number(frame.chunk_size ?? ONEBOT_STREAM_CHUNK_BYTES);
          if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 1024 * 1024) throw new Error("Invalid stream chunk_size");
          const label = sanitizeFilename(frame.file_name ?? "", `media${extensionFor(kind)}`);
          const suffix = extensionFor(kind, label);
          destination = path.join(this.cacheDir, `qq-${Date.now()}-${randomUUID()}${suffix}`);
          opened.handle = await fs.promises.open(destination, "w");
          return;
        }
        if (frame.data_type !== "file_chunk") return;
        if (!opened.handle || !destination) throw new Error("Stream chunk arrived before file_info");
        const position = Number(frame.index);
        if (!Number.isInteger(position) || position < 0 || positions.has(position)) throw new Error(`Invalid or duplicate stream chunk index: ${frame.index}`);
        const bytes = Buffer.from(frame.data ?? "", "base64");
        if (bytes.length !== Number(frame.size ?? bytes.length)) throw new Error("Stream chunk size mismatch");
        if (receivedBytes + bytes.length > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站文件超过 100 MiB");
        const offset = position * blockSize;
        if (offset + bytes.length > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站 chunk 偏移越界");
        if (declaredBytes > 0 && offset + bytes.length > declaredBytes) throw new Error("Stream chunk offset exceeds file size");
        await opened.handle.write(bytes, 0, bytes.length, offset);
        positions.add(position);
        receivedBytes += bytes.length;
      });
      await opened.handle?.close();
      opened.handle = undefined;
      if (!destination) throw new Error("Stream did not provide file_info");
      if (declaredBytes > 0 && receivedBytes !== declaredBytes) throw new Error(`Stream byte count mismatch: ${receivedBytes}/${declaredBytes}`);
      if (receipt.total_chunks !== undefined && positions.size !== receipt.total_chunks) throw new Error(`Stream chunk count mismatch: ${positions.size}/${receipt.total_chunks}`);
      if (receipt.total_bytes !== undefined && receivedBytes !== receipt.total_bytes) throw new Error(`Stream completed byte mismatch: ${receivedBytes}/${receipt.total_bytes}`);
      if (positions.size > 0) {
        let largest = -1;
        for (const position of positions) if (position > largest) largest = position;
        if (largest !== positions.size - 1) throw new Error(`Stream chunk indexes not contiguous: ${positions.size} chunks, max index ${largest}`);
      }
      return destination;
    } catch (failure) {
      await opened.handle?.close().catch(() => undefined);
      if (destination) await fs.promises.unlink(destination).catch(() => undefined);
      throw failure;
    }
  }
  private async downloadUrl(address: string, category: MediaKind): Promise<string> {
    const received = await fetch(address, { signal: AbortSignal.timeout(30_000) });
    if (!received.ok) throw new Error(`QQ 媒体下载失败: HTTP ${received.status}`);
    const declared = Number(received.headers.get("content-length") ?? 0);
    if (declared > ONEBOT_BASE64_THRESHOLD_BYTES) throw new Error("旧版 NapCat URL 媒体超过 8 MiB");
    let bytes: Buffer;
    if (received.body) {
      const blocks: Buffer[] = [];
      let count = 0;
      const reader = received.body.getReader();
      let oversized = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          count += value.byteLength;
          if (count > ONEBOT_BASE64_THRESHOLD_BYTES) { oversized = true; throw new Error("旧版 NapCat URL 媒体超过 8 MiB"); }
          blocks.push(Buffer.from(value));
        }
      } finally { if (oversized) void reader.cancel().catch(() => undefined); }
      bytes = Buffer.concat(blocks);
    } else {
      bytes = Buffer.from(await received.arrayBuffer());
      if (bytes.length > ONEBOT_BASE64_THRESHOLD_BYTES) throw new Error("旧版 NapCat URL 媒体超过 8 MiB");
    }
    const suffix = extensionFor(category, new URL(address).pathname);
    const destination = path.join(this.cacheDir, `qq-${Date.now()}-${randomUUID()}${suffix}`);
    await fs.promises.writeFile(destination, bytes);
    return destination;
  }
  private async uploadStream(filename: string, size: number): Promise<string> {
    const connection = this.getClient();
    if (!connection) throw new Error("NapCat 未连接");
    if (size === 0) throw new Error("QQ 不支持发送空文件");
    const identifier = randomUUID();
    const blocks = Math.max(1, Math.ceil(size / ONEBOT_STREAM_CHUNK_BYTES));
    const digest = createHash("sha256");
    for await (const bytes of fs.createReadStream(filename)) digest.update(bytes as Buffer);
    const checksum = digest.digest("hex");
    let position = 0;
    for await (const raw of fs.createReadStream(filename, { highWaterMark: ONEBOT_STREAM_CHUNK_BYTES })) {
      const bytes = raw as Buffer;
      const receipt = await connection.call<OneBotStreamPacket>("upload_file_stream", {
        stream_id: identifier, chunk_data: bytes.toString("base64"), chunk_index: position, total_chunks: blocks,
        file_size: size, expected_sha256: checksum, filename: path.basename(filename), file_retention: 10 * 60 * 1000,
      }, 10 * 60_000);
      if (receipt.status && receipt.status !== "chunk_received" && receipt.status !== "file_created") throw new Error(`NapCat upload rejected chunk ${position}: ${receipt.status}`);
      position++;
    }
    const receipt = await connection.call<OneBotStreamPacket>("upload_file_stream", { stream_id: identifier, is_complete: true, file_retention: 10 * 60 * 1000 }, 10 * 60_000);
    if (receipt.status !== "file_complete" || !receipt.file_path) throw new Error("NapCat upload did not return file_path");
    if (receipt.sha256 && receipt.sha256 !== checksum) throw new Error("NapCat upload SHA-256 mismatch");
    return receipt.file_path;
  }
  private reportStreamUnavailable(failure: unknown): void {
    const diagnostic = failure instanceof Error ? failure.message : String(failure);
    if (!(failure instanceof OneBotActionError) || (failure.retcode !== 1404 && !/(?:not found|unsupported|not support|未找到|不支持)/iu.test(diagnostic))) return;
    this.onStreamUnavailable?.(failure);
  }
}
