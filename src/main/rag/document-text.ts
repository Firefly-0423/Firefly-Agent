import { createHash } from "crypto";
import * as path from "path";

/** Office and PDF formats whose text Firefly extracts before a model reads it. */
export const EXTRACTED_DOCUMENT_EXTS: ReadonlySet<string> = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);
const LEGACY_FORMATS = new Map([[".doc", ".docx"], [".xls", ".xlsx"], [".ppt", ".pptx"]]);

/** Cap on the extracted text, so a small archive cannot expand into an unbounded string. */
export const DOCUMENT_TEXT_MAX_CHARS = 8_000_000;
/** Cap on the bytes an Office archive may inflate to while its parts are read. */
const ARCHIVE_MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const PDF_MAX_PAGES = 2000;

export const isExtractedDocumentExt = (ext: string): boolean => EXTRACTED_DOCUMENT_EXTS.has(ext.toLowerCase());

/** The message for a legacy binary Office file, or null when the extension is not one. */
export function legacyDocumentReason(ext: string): string | null {
  const modern = LEGACY_FORMATS.get(ext.toLowerCase());
  return modern ? `旧版 ${ext.toLowerCase()} 格式暂不支持，请在 Office 或 WPS 中另存为 ${modern} 后再上传` : null;
}

export class DocumentTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentTextError";
  }
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function bounded(text: string): string {
  if (text.length > DOCUMENT_TEXT_MAX_CHARS) {
    throw new DocumentTextError(`文档文字超过 ${DOCUMENT_TEXT_MAX_CHARS.toLocaleString("en-US")} 个字符，无法读取；请拆分后再上传`);
  }
  return text;
}

async function openArchive(bytes: Buffer, label: string) {
  const JSZip = require("jszip");
  let zip: any;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocumentTextError(`无法打开这个 ${label} 文件，它可能已损坏或不是真正的 ${label}`);
  }
  let inflated = 0;
  zip.forEach((_name: string, entry: any) => { inflated += Number(entry?._data?.uncompressedSize) || 0; });
  if (inflated > ARCHIVE_MAX_INFLATED_BYTES) throw new DocumentTextError(`这个 ${label} 解压后过大，无法读取`);
  return zip;
}

async function part(zip: any, name: string): Promise<string | null> {
  const entry = zip.file(name);
  return entry ? entry.async("string") : null;
}

/** Word body text: one line per paragraph, table cells separated by tabs, rows by line breaks. */
export function wordXmlText(xml: string): string {
  // Fragments, not one growing string: a cell or row end only swaps the last separator, never recopies the text.
  const parts: string[] = [];
  let length = 0;
  const push = (text: string) => { parts.push(text); length += text.length; };
  const swapTrailing = (from: string, to: string) => {
    if (parts.length && parts[parts.length - 1] === from) { parts[parts.length - 1] = to; return; }
    push(to);
  };
  const pattern = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<\/w:(p|tc|tr)>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    if (match[1] !== undefined) { if (match[1]) push(decodeXml(match[1])); }
    else if (match[2] === "tab") push("\t");
    else if (match[2] || match[3] === "p") push("\n");
    else if (match[3] === "tc") swapTrailing("\n", "\t");
    else swapTrailing("\t", "\n");
    if (length > DOCUMENT_TEXT_MAX_CHARS) break;
  }
  return parts.join("");
}

/** DrawingML text (slides, notes): one line per paragraph. */
function drawingXmlText(xml: string): string {
  let out = "";
  const pattern = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    out += match[1] !== undefined ? decodeXml(match[1]) : "\n";
    if (out.length > DOCUMENT_TEXT_MAX_CHARS) break;
  }
  return out;
}

async function docxText(bytes: Buffer): Promise<string> {
  const zip = await openArchive(bytes, ".docx");
  const body = await part(zip, "word/document.xml");
  if (body === null) throw new DocumentTextError("这个 .docx 里没有正文（缺少 word/document.xml）");
  const sections = [wordXmlText(body)];
  const notes = [await part(zip, "word/footnotes.xml"), await part(zip, "word/endnotes.xml")].filter((xml): xml is string => xml !== null);
  const noteText = notes.map(wordXmlText).join("\n").trim();
  if (noteText) sections.push("## 脚注\n" + noteText);
  return sections.join("\n\n");
}

const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await openArchive(bytes, ".pptx");
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slides.length === 0) throw new DocumentTextError("这个 .pptx 里没有幻灯片");
  const sections: string[] = [];
  for (const name of slides) {
    const number = slideNumber(name);
    let section = `## 幻灯片 ${number}\n` + drawingXmlText((await part(zip, name)) ?? "").trim();
    const notes = await part(zip, `ppt/notesSlides/notesSlide${number}.xml`);
    const noteText = notes ? drawingXmlText(notes).trim() : "";
    if (noteText) section += "\n备注：" + noteText;
    sections.push(section);
    if (sections.reduce((sum, text) => sum + text.length, 0) > DOCUMENT_TEXT_MAX_CHARS) break;
  }
  return sections.join("\n\n");
}

function cellText(cell: any): string {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (value && typeof value === "object" && "result" in value && !("richText" in value)) {
    const result = (value as { result?: unknown }).result;
    return result === undefined || result === null ? "" : result instanceof Date ? result.toISOString() : String(result);
  }
  try {
    return String(cell.text ?? "");
  } catch {
    return String(value);
  }
}

async function xlsxText(bytes: Buffer): Promise<string> {
  await openArchive(bytes, ".xlsx");
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes);
  } catch {
    throw new DocumentTextError("无法打开这个 .xlsx 文件，它可能已损坏或不是真正的 .xlsx");
  }
  const sections: string[] = [];
  let length = 0;
  workbook.eachSheet((sheet: any) => {
    const rows: string[] = [`## 工作表 ${sheet.name}`];
    sheet.eachRow({ includeEmpty: false }, (row: any) => {
      if (length > DOCUMENT_TEXT_MAX_CHARS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any, column: number) => { cells[column - 1] = cellText(cell).replace(/[\t\r\n]+/g, " "); });
      const line = Array.from(cells, cell => cell ?? "").join("\t").replace(/\t+$/, "");
      length += line.length + 1;
      rows.push(line);
    });
    sections.push(rows.join("\n"));
  });
  return sections.join("\n\n");
}

function pdfjsRoot(): string {
  return path.dirname(require.resolve("pdfjs-dist/package.json"));
}

async function pdfText(bytes: Buffer): Promise<string> {
  const root = pdfjsRoot();
  // Node 22.12+ (Electron 43) loads an ES module through require when it has no top-level await, as pdf.mjs does.
  const pdfjs = require(path.join(root, "legacy", "build", "pdf.mjs"));
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: path.join(root, "cmaps").split(path.sep).join("/") + "/",
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    let document: any;
    try {
      document = await task.promise;
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "PasswordException") throw new DocumentTextError("这个 PDF 设有密码，无法读取；请先移除密码再上传");
      throw new DocumentTextError("无法打开这个 PDF，它可能已损坏");
    }
    if (document.numPages > PDF_MAX_PAGES) throw new DocumentTextError(`这个 PDF 超过 ${PDF_MAX_PAGES} 页，无法读取；请拆分后再上传`);
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      page.cleanup();
      length += text.length;
      pages.push(`## 第 ${number} 页\n` + text.trim());
      if (length > DOCUMENT_TEXT_MAX_CHARS) break;
    }
    if (length === 0 || !pages.some(page => page.replace(/^## 第 \d+ 页\n?/, "").trim())) {
      throw new DocumentTextError("这个 PDF 里没有可读取的文字（可能是扫描件或图片），请先做文字识别再上传");
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

const cache = new Map<string, string>();
const CACHE_ENTRIES = 8;

/**
 * Plain text of a .docx, .xlsx, .pptx or .pdf file. Results are cached by content hash, so paging through one
 * document with read_file extracts it once. Throws DocumentTextError with a user-facing Chinese message.
 */
export async function extractDocumentText(bytes: Buffer, ext: string): Promise<string> {
  const lower = ext.toLowerCase();
  const legacy = legacyDocumentReason(lower);
  if (legacy) throw new DocumentTextError(legacy);
  if (!isExtractedDocumentExt(lower)) throw new DocumentTextError(`暂不支持的文件格式 ${lower}`);
  const key = lower + ":" + createHash("sha256").update(bytes).digest("hex");
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const raw = lower === ".docx" ? await docxText(bytes) : lower === ".pptx" ? await pptxText(bytes) : lower === ".xlsx" ? await xlsxText(bytes) : await pdfText(bytes);
  const text = bounded(tidy(raw));
  if (!text) throw new DocumentTextError("文档里没有可读取的文字");
  cache.set(key, text);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return text;
}
