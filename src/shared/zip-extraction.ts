import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fromRandomAccessReaderPromise, RandomAccessReader, type Entry, type ZipFile } from "yauzl";

export const ZIP_EXTRACTION_LIMITS = {
  archiveBytes: 512 * 1024 * 1024,
  entries: 20_000,
  entryBytes: 256 * 1024 * 1024,
  expandedBytes: 1024 * 1024 * 1024,
  compressionRatio: 200,
  pathBytes: 1024,
  pathDepth: 64,
  metadataBytes: 8 * 1024 * 1024,
} as const;

export interface ZipExtractionOptions {
  dir: string;
  onEntry?: (entry: Entry) => void;
  limits?: Partial<{ [Key in keyof typeof ZIP_EXTRACTION_LIMITS]: number }>;
}

class ArchiveReader extends RandomAccessReader {
  private readonly file: FileHandle;
  private closing: Promise<void> | undefined;

  constructor(file: FileHandle) {
    super();
    this.file = file;
  }

  _readStreamForRange(start: number, end: number) {
    const file = this.file;
    return Readable.from((async function* () {
      let position = start;
      while (position < end) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) throw new Error("ZIP_UNEXPECTED_EOF");
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })());
  }

  closeFile(): Promise<void> {
    this.closing ??= this.file.close();
    return this.closing;
  }

  close(callback: (error: Error | null) => void): void {
    void this.closeFile().then(() => callback(null), callback);
  }
}

async function destinationState(directory: string) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length !== 0) {
      throw new Error("ZIP_DESTINATION_NOT_EMPTY_OR_UNSAFE");
    }
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function entryPath(entry: Entry, limits: { pathBytes: number; pathDepth: number }): { relative: string; directory: boolean; mode: number } {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0xf000;
  if (type === 0xa000) throw new Error("ZIP_SYMLINK_FORBIDDEN");
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) throw new Error("ZIP_SPECIAL_FILE_FORBIDDEN");
  if (entry.isEncrypted()) throw new Error("ZIP_ENCRYPTED_FORBIDDEN");
  const directory = entry.fileName.endsWith("/") || type === 0x4000
    || ((entry.versionMadeBy >>> 8) === 0 && entry.externalFileAttributes === 16);
  const relative = entry.fileName.replace(/\/$/, "");
  if (Buffer.byteLength(relative) > limits.pathBytes) throw new Error("ZIP_PATH_LIMIT");
  if (!relative || relative.includes("\0") || relative.includes("\\")) throw new Error("ZIP_UNSAFE_PATH");
  const segments = relative.split("/");
  if (segments.length > limits.pathDepth) throw new Error("ZIP_PATH_LIMIT");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error("ZIP_UNSAFE_PATH");
  return { relative, directory, mode: (mode & 0o777) || (directory ? 0o755 : 0o644) };
}

export async function extractZip(archive: string, options: ZipExtractionOptions): Promise<void> {
  if (!path.isAbsolute(options.dir)) throw new Error("ZIP_DESTINATION_MUST_BE_ABSOLUTE");
  const limits = { ...ZIP_EXTRACTION_LIMITS, ...options.limits };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("ZIP_INVALID_LIMIT");
  const original = await destinationState(options.dir);
  await mkdir(path.dirname(options.dir), { recursive: true });
  const parent = await realpath(path.dirname(options.dir));
  const destination = path.join(parent, path.basename(options.dir));
  const file = await open(archive, "r");
  const reader = new ArchiveReader(file);
  const abort = new AbortController();
  reader.on("error", (error: Error) => abort.abort(error));
  let zipfile: ZipFile | undefined;
  let staging: string | undefined;
  let extractionError: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limits.archiveBytes) throw new Error("ZIP_ARCHIVE_LIMIT");
    zipfile = await fromRandomAccessReaderPromise(reader, info.size, { autoClose: false, validateEntrySizes: true });
    zipfile.on("error", (error: Error) => abort.abort(error));
    if (zipfile.fileSize > limits.archiveBytes || zipfile.entryCount > limits.entries) throw new Error("ZIP_ARCHIVE_LIMIT");
    const members: Array<{ entry: Entry; relative: string; directory: boolean; mode: number }> = [];
    const names = new Set<string>();
    const kinds = new Map<string, boolean>();
    let expandedBytes = 0;
    let metadataBytes = 0;
    for await (const entry of zipfile.eachEntry()) {
      metadataBytes += entry.fileNameRaw.length + entry.extraFieldLength + entry.fileCommentRaw.length
        + Buffer.byteLength(entry.fileName) + Buffer.byteLength(entry.fileComment);
      if (metadataBytes > limits.metadataBytes) throw new Error("ZIP_METADATA_LIMIT");
      options.onEntry?.(entry);
      const member = entryPath(entry, limits);
      const key = member.relative.toLowerCase();
      if (names.has(key)) throw new Error("ZIP_DUPLICATE_PATH");
      names.add(key);
      if (kinds.has(key) && (!kinds.get(key) || !member.directory)) throw new Error("ZIP_PATH_TYPE_CONFLICT");
      kinds.set(key, member.directory);
      const segments = key.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index).join("/");
        if (kinds.get(prefix) === false) throw new Error("ZIP_PATH_TYPE_CONFLICT");
        if (!kinds.has(prefix)) metadataBytes += Buffer.byteLength(prefix);
        if (metadataBytes > limits.metadataBytes) throw new Error("ZIP_METADATA_LIMIT");
        kinds.set(prefix, true);
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
        || entry.uncompressedSize > limits.entryBytes) throw new Error("ZIP_ENTRY_LIMIT");
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > limits.expandedBytes) throw new Error("ZIP_EXPANDED_LIMIT");
      if (entry.uncompressedSize > 1024 * 1024
        && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.compressionRatio)) {
        throw new Error("ZIP_COMPRESSION_RATIO_LIMIT");
      }
      if (!member.relative.startsWith("__MACOSX/")) members.push({ entry, ...member });
    }
    staging = await mkdtemp(path.join(parent, ".firefly-unzip-"));
    for (const member of members) {
      const target = path.join(staging, member.relative);
      await mkdir(member.directory ? target : path.dirname(target), { recursive: true });
      if (member.directory) continue;
      const input = await zipfile.openReadStreamPromise(member.entry);
      await pipeline(input, createWriteStream(target, { flags: "wx", mode: member.mode }), { signal: abort.signal });
    }
    abort.signal.throwIfAborted();
    zipfile.close();
    await reader.closeFile();
    const current = await destinationState(destination);
    if ((original === null) !== (current === null)
      || (original && current && (original.dev !== current.dev || original.ino !== current.ino))) {
      throw new Error("ZIP_DESTINATION_CHANGED");
    }
    if (current) await rmdir(destination);
    try {
      await rename(staging, destination);
      staging = undefined;
    } catch (error) {
      if (current) await mkdir(destination).catch((restoreError: NodeJS.ErrnoException) => {
        if (restoreError.code !== "EEXIST") throw restoreError;
      });
      throw error;
    }
  } catch (error) {
    extractionError = error;
    throw error;
  } finally {
    try {
      zipfile?.close();
      await reader.closeFile();
    } catch (closeError) {
      if (extractionError !== undefined && extractionError !== closeError) {
        throw new AggregateError([extractionError, closeError], "ZIP_EXTRACTION_AND_CLOSE_FAILED");
      }
      throw closeError;
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
