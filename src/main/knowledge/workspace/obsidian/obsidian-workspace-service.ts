import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { extractHeadings, readSection, replaceSection, appendToSection, contentHash, type MarkdownHeading } from "./obsidian-markdown";

export interface LearnObsidianSettings { enabled: boolean; vaultPath: string }
export interface ObsidianFileInfo { path: string; name: string; size: number; modifiedAt: string }
export interface ObsidianReadResult { path: string; content: string; contentHash: string; headings: MarkdownHeading[] }
export interface ObsidianSectionResult {
  path: string; headingPath: string[]; headingDepth: number; content: string; contentHash: string;
}
export interface ObsidianSearchResult {
  path: string; name: string; matchType: "filename" | "heading" | "body"; matchText?: string; headingPath?: string[];
}
export interface ObsidianWriteResult { path: string; operation: string; newContentHash: string; bytesWritten: number }
export type ObsidianEditRequest =
  | { operation: "create"; path: string; content: string }
  | { operation: "replace_file"; path: string; content: string; expectedContentHash: string }
  | { operation: "append"; path: string; content: string; expectedContentHash: string }
  | { operation: "replace_section"; path: string; headingPath: string[]; content: string; includeChildren?: boolean; expectedContentHash: string }
  | { operation: "append_to_section"; path: string; headingPath: string[]; content: string; expectedContentHash: string };
export type ObsidianErrorCode =
  | "VAULT_NOT_CONFIGURED" | "VAULT_NOT_FOUND" | "PATH_OUTSIDE_VAULT" | "PATH_NOT_FOUND" | "PATH_ALREADY_EXISTS"
  | "FILE_TYPE_NOT_SUPPORTED" | "READ_FAILED" | "WRITE_FAILED" | "CONTENT_CONFLICT" | "CONTENT_HASH_REQUIRED"
  | "HEADING_NOT_FOUND" | "AMBIGUOUS_HEADING" | "MARKDOWN_PARSE_FAILED";
export class ObsidianError extends Error {
  constructor(public code: ObsidianErrorCode, message: string, public details?: unknown) {
    super(`[${code}] ${message}`); this.name = "ObsidianError";
  }
}

const noteExtensions = new Set([".md", ".markdown", ".mdown", ".mdx"]);
const isNote = (location: string): boolean => noteExtensions.has(path.extname(location).toLowerCase());
function headingFailure(file: string, headings: string[], ambiguous: boolean, details?: unknown): ObsidianError {
  return ambiguous
    ? new ObsidianError("AMBIGUOUS_HEADING", `标题路径不唯一: ${headings.join(" > ")}，文件: ${file}`, details)
    : new ObsidianError("HEADING_NOT_FOUND", `标题路径未找到: ${headings.join(" > ")}，文件: ${file}`);
}
function writtenResult(file: string, operation: string, contents: string): ObsidianWriteResult {
  return { path: file, operation, newContentHash: contentHash(contents), bytesWritten: Buffer.byteLength(contents, "utf8") };
}

// Windows 的文件名不区分大小写，.OBSIDIAN / .Firefly 同样属于应用内部目录。
function isInternalFolder(name: string): boolean {
  const comparable = process.platform === "win32" ? name.toLowerCase() : name;
  return comparable === ".obsidian" || comparable === ".firefly";
}

export class ObsidianWorkspaceService {
  private configuration: LearnObsidianSettings | null = null;
  configure(settings: LearnObsidianSettings): void { this.configuration = settings; }
  isReady(): boolean {
    if (!this.configuration?.enabled || !this.configuration?.vaultPath) return false;
    try { return fsSync.existsSync(this.configuration.vaultPath); } catch { return false; }
  }
  private root(): string {
    const configured = this.configuration;
    if (!configured?.enabled || !configured?.vaultPath) throw new ObsidianError("VAULT_NOT_CONFIGURED", "Obsidian Vault 未配置");
    if (!fsSync.existsSync(configured.vaultPath)) throw new ObsidianError("VAULT_NOT_FOUND", `Vault 路径不存在: ${configured.vaultPath}`);
    return path.resolve(configured.vaultPath);
  }
  private resolvePath(relative: string): string {
    const root = this.root();
    if (path.isAbsolute(relative)) throw new ObsidianError("PATH_OUTSIDE_VAULT", `不接受绝对路径: ${relative}。请使用 Vault 内的相对路径。`);
    const normalized = path.normalize(relative);
    if (normalized.startsWith("..") || normalized.includes(".." + path.sep)) {
      throw new ObsidianError("PATH_OUTSIDE_VAULT", `路径试图跳出 Vault: ${relative}`);
    }
    const absolute = path.resolve(root, normalized);
    if (!absolute.startsWith(root + path.sep) && absolute !== root) {
      throw new ObsidianError("PATH_OUTSIDE_VAULT", `解析后路径不在 Vault 内: ${absolute}`);
    }
    // Keep realpath probes in the same short-circuit order as ordinary file access.
    try {
      const physical = fsSync.realpathSync(absolute);
      if (!physical.startsWith(fsSync.realpathSync(root) + path.sep) && physical !== fsSync.realpathSync(root)) {
        throw new ObsidianError("PATH_OUTSIDE_VAULT", `路径通过符号链接跳出 Vault: ${absolute}`);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    for (const segment of normalized.split(path.sep)) {
      if (isInternalFolder(segment)) throw new ObsidianError("PATH_OUTSIDE_VAULT", `禁止操作 ${segment}/ 目录: ${relative}`);
    }
    return absolute;
  }
  private notePath(relative: string): string {
    const absolute = this.resolvePath(relative);
    if (!isNote(absolute)) {
      throw new ObsidianError("FILE_TYPE_NOT_SUPPORTED", `不支持的文件类型: ${path.extname(absolute)}。仅支持 .md / .markdown / .mdx。`);
    }
    return absolute;
  }
  async listFiles(input?: { relativeDir?: string; recursive?: boolean }): Promise<ObsidianFileInfo[]> {
    const root = this.root();
    const relative = input?.relativeDir ?? "";
    const recursive = input?.recursive ?? true;
    const start = relative ? this.resolvePath(relative) : root;
    const notes: ObsidianFileInfo[] = [];
    const visit = async (directory: string): Promise<void> => {
      const children = await fs.readdir(directory, { withFileTypes: true });
      for (const child of children) {
        if (child.isDirectory() && isInternalFolder(child.name)) continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) { if (recursive) await visit(absolute); }
        else if (child.isFile() && isNote(child.name)) {
          const attributes = await fs.stat(absolute);
          notes.push({ path: path.relative(root, absolute).replace(/\\/g, "/"), name: child.name,
            size: attributes.size, modifiedAt: attributes.mtime.toISOString() });
        }
      }
    };
    await visit(start);
    return notes.sort((left, right) => left.path.localeCompare(right.path));
  }
  async search(input: { query: string; relativeDir?: string; limit?: number }): Promise<ObsidianSearchResult[]> {
    const candidates = await this.listFiles({ relativeDir: input.relativeDir, recursive: true });
    const needle = input.query.toLowerCase();
    const maximum = input.limit ?? 20;
    const matches: ObsidianSearchResult[] = [];
    for (const candidate of candidates) {
      if (matches.length >= maximum) break;
      if (candidate.name.toLowerCase().includes(needle)) {
        matches.push({ path: candidate.path, name: candidate.name, matchType: "filename" });
        continue;
      }
      try {
        const note = await this.readFile({ path: candidate.path });
        const contents = note.content;
        for (const heading of note.headings) {
          if (matches.length >= maximum) break;
          if (heading.text.toLowerCase().includes(needle)) {
            matches.push({ path: candidate.path, name: candidate.name, matchType: "heading",
              matchText: heading.text, headingPath: heading.path });
          }
        }
        if (matches.length < maximum && contents.toLowerCase().includes(needle)) {
          const listed = matches.some((match) => match.path === candidate.path);
          if (!listed) matches.push({ path: candidate.path, name: candidate.name, matchType: "body" });
        }
      } catch { continue; }
    }
    return matches.slice(0, maximum);
  }
  async readFile(input: { path: string }): Promise<ObsidianReadResult> {
    const absolute = this.notePath(input.path);
    let contents: string;
    try { contents = await fs.readFile(absolute, "utf8"); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new ObsidianError("PATH_NOT_FOUND", `文件不存在: ${input.path}`);
      throw new ObsidianError("READ_FAILED", `读取文件失败: ${input.path}`, cause);
    }
    const hash = contentHash(contents);
    const outline = extractHeadings(contents);
    return { path: input.path, content: contents, contentHash: hash, headings: outline };
  }
  async readSection(input: { path: string; headingPath: string[]; includeChildren?: boolean }): Promise<ObsidianSectionResult> {
    const note = await this.readFile({ path: input.path });
    const section = readSection(note.content, input.headingPath, input.includeChildren ?? false);
    if (typeof section === "object" && "kind" in section) {
      if (section.kind === "NOT_FOUND") throw headingFailure(input.path, input.headingPath, false);
      if (section.kind === "AMBIGUOUS") {
        throw headingFailure(input.path, input.headingPath, true, section.matches?.map((match) => match.path.join(" > ")));
      }
    }
    const target = note.headings.find((heading) => heading.path.length === input.headingPath.length
      && input.headingPath.every((component, offset) => heading.path[offset] === component));
    return { path: input.path, headingPath: input.headingPath, headingDepth: target?.depth ?? input.headingPath.length,
      content: section as string, contentHash: contentHash(section as string) };
  }
  async edit(input: ObsidianEditRequest): Promise<ObsidianWriteResult> {
    if (input.operation !== "create" && !input.expectedContentHash) {
      throw new ObsidianError("CONTENT_HASH_REQUIRED", `修改已有文件必须携带 expectedContentHash（先 read_file 获取），操作: ${input.operation}，文件: ${input.path}`);
    }
    // Unknown operations historically return undefined without touching the filesystem.
    switch (input.operation) {
      case "create": {
        const absolute = this.notePath(input.path);
        if (fsSync.existsSync(absolute)) {
          throw new ObsidianError("PATH_ALREADY_EXISTS", `文件已存在，create 不覆盖: ${input.path}。如需修改请先 read_file 再用对应编辑操作。`);
        }
        await this.replaceContents(absolute, input.content);
        return writtenResult(input.path, "create", input.content);
      }
      case "replace_file": case "append": case "replace_section": case "append_to_section": {
        const absolute = this.notePath(input.path);
        await this.requireHash(absolute, input.expectedContentHash, input.path);
        const next = await this.editedContents(absolute, input);
        await this.replaceContents(absolute, next);
        return writtenResult(input.path, input.operation, next);
      }
    }
  }
  private async editedContents(absolute: string, input: Exclude<ObsidianEditRequest, { operation: "create" }>): Promise<string> {
    if (input.operation === "replace_file") return input.content;
    const current = await fs.readFile(absolute, "utf8");
    if (input.operation === "append") return current + (current.endsWith("\n") ? "" : "\n") + input.content.trimEnd() + "\n";
    const section = input.operation === "replace_section"
      ? replaceSection(current, input.headingPath, input.content, input.includeChildren ?? false)
      : appendToSection(current, input.headingPath, input.content);
    if (typeof section === "object" && "kind" in section) {
      throw headingFailure(input.path, input.headingPath, section.kind !== "NOT_FOUND");
    }
    return section as string;
  }
  private async replaceContents(destination: string, contents: string): Promise<void> {
    const scratch = destination + ".firefly-tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(scratch, contents, "utf8");
      await fs.rename(scratch, destination);
    } catch (cause) {
      try { await fs.unlink(scratch); } catch { /* Best effort cleanup. */ }
      throw new ObsidianError("WRITE_FAILED", `写入文件失败: ${destination}`, cause);
    }
  }
  private async requireHash(absolute: string, expected: string, display: string): Promise<void> {
    let current: string;
    try { current = await fs.readFile(absolute, "utf8"); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new ObsidianError("PATH_NOT_FOUND", `文件不存在: ${display}`);
      throw cause;
    }
    const actual = contentHash(current);
    if (actual !== expected) {
      throw new ObsidianError("CONTENT_CONFLICT", `文件 ${display} 已被外部修改，请重新读取后再编辑。`, { expected, current: actual });
    }
  }
}
export const obsidianWorkspace = new ObsidianWorkspaceService();
