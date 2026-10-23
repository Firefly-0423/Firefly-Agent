import { beginWriteBatch } from "./registry/file-write-evidence";
import * as fs from "fs";
import * as path from "path";
import { resolveContainedPath } from "./path-containment";
import { app } from "electron";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { findSkillPath } from "../../external-content-paths";
import { reviewTrackerFor } from "../review/review-tracker-access";
import { randomUUID } from "node:crypto";
import { finished, pipeline } from "node:stream/promises";

type Arguments = Record<string, unknown>;
type Theme = { name: string; headerFill: string; headerFont: string; headerBorder: string; zebraFill: string; borderColor: string };
type ThemeColors = { headerFill?: string; headerFont?: string; headerBorder?: string; zebraFill?: string; borderColor?: string };
type SheetInput = { name: string; headers: string[]; rows: unknown[][] };
interface StyleCacheEntry { [styleId: string]: Record<string, unknown> }
const loadedStyles = new Set<string>();
const styleCatalogs = new Map<string, StyleCacheEntry>();
const docLog = "[DocTools]";

function validateFilename(filename: string, ext: string | string[]): string | null {
  if (!filename || typeof filename !== "string") return null;
  const suffixes = Array.isArray(ext) ? ext : [ext];
  const allowed = suffixes.some(suffix => filename.toLowerCase().endsWith(suffix));
  if (!allowed) return null;
  return /[<>:"|?*]/.test(filename) ? null : filename;
}
function filenameError(ext: string, args: Arguments): string {
  const received = args.filename;
  const parameters = Object.keys(args).join(", ") || "（空）";
  if (received === undefined || received === null || String(received).trim() === "") {
    return `[错误] 未提供 filename 参数（要求 ${ext} 结尾）。本次收到的参数键：${parameters}。请补上 filename 后重试。`;
  }
  const label = String(received);
  if (/[<>:"|?*]/.test(label)) return `[错误] filename 含非法字符（<>:"|?*）：${label}`;
  return `[错误] filename 必须是 ${ext} 结尾，实际收到：${label}。`;
}
function captureBaseline(context: ToolContext | undefined, outputPath: string): void {
  if (context?.runId) {
    const review = reviewTrackerFor();
    review.captureBefore(context.runId, outputPath, undefined, undefined, context);
  }
}
function resolveOutputPath(filename: string, workspaceRoot?: string): string | null {
  const cleaned = path.normalize(filename).replace(/\\/g, "/");
  if (cleaned.includes("..") || path.isAbsolute(cleaned)) return null;
  const root = path.resolve(workspaceRoot || app.getPath("desktop"));
  const destination = path.resolve(root, cleaned);
  const remainder = path.relative(root, destination);
  if (remainder === ".." || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) return null;
  return resolveContainedPath(root, destination);
}
function loadStylesDir(skillId: string): StyleCacheEntry {
  if (loadedStyles.has(skillId)) return styleCatalogs.get(skillId) ?? {};
  loadedStyles.add(skillId);
  const collected: StyleCacheEntry = {};
  try {
    const directory = findSkillPath(skillId, "styles");
    if (!directory) return {};
    for (const filename of fs.readdirSync(directory)) {
      if (!filename.endsWith(".json")) continue;
      const identifier = filename.replace(/\.json$/, "");
      try { collected[identifier] = JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8")); }
      catch { /* 单个样式失败不影响其他文件。 */ }
    }
    console.log(docLog, `已加载 ${skillId} 样式:`, Object.keys(collected).join(", ") || "(无)");
  } catch { /* 目录读取失败时保留已收集的样式。 */ }
  styleCatalogs.set(skillId, collected);
  return collected;
}
function toHexColor(color: string): string {
  const digits = color.replace("#", "").toUpperCase();
  switch (digits.length) { case 8: return digits.slice(2); case 6: return digits; default: return "1F4E79"; }
}
function toArgb(color: string): string {
  const digits = color.replace("#", "").toUpperCase();
  switch (digits.length) { case 8: return digits; case 6: return "FF" + digits; default: return "FF1F4E79"; }
}
function mergeTheme(base: Theme, colors?: ThemeColors): Theme {
  if (!colors) return base;
  return { name: base.name + "(自定义)",
    headerFill: colors.headerFill ? toArgb(colors.headerFill) : base.headerFill,
    headerFont: colors.headerFont ? toArgb(colors.headerFont) : base.headerFont,
    headerBorder: colors.headerBorder ? toArgb(colors.headerBorder) : base.headerBorder,
    zebraFill: colors.zebraFill ? toArgb(colors.zebraFill) : base.zebraFill,
    borderColor: colors.borderColor ? toArgb(colors.borderColor) : base.borderColor };
}
function themeReader(): (style?: string) => Theme {
  const catalog = new Map<string, Theme>();
  let initialized = false;
  const fallback: Theme = { name: "默认深蓝", headerFill: "FF1F4E79", headerFont: "FFFFFFFF", headerBorder: "FF1F4E79", zebraFill: "FFF2F2F2", borderColor: "FFBFBFBF" };
  function loadThemes(): void {
    if (initialized) return;
    initialized = true;
    try {
      const directory = findSkillPath("xlsx", "styles");
      if (!directory) return;
      for (const filename of fs.readdirSync(directory)) {
        if (!filename.endsWith(".json")) continue;
        const identifier = filename.replace(/\.json$/, "");
        try {
          const source = JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
          catalog.set(identifier, { name: String(source.name || identifier), headerFill: String(source.headerFill || fallback.headerFill),
            headerFont: String(source.headerFont || fallback.headerFont), headerBorder: String(source.headerBorder || fallback.headerBorder),
            zebraFill: String(source.zebraFill || fallback.zebraFill), borderColor: String(source.borderColor || fallback.borderColor) });
        } catch { /* 读取下一份样式。 */ }
      }
      console.log(docLog, "已加载样式:", Array.from(catalog.keys()).join(", ") || "(无)");
    } catch { /* 使用默认主题。 */ }
  }
  return function getTheme(style?: string): Theme {
    loadThemes();
    if (!style) return catalog.get("default") ?? fallback;
    return catalog.get(style) ?? catalog.get("default") ?? fallback;
  };
}
function numberFormat(header: string, value: number): string {
  if (/年|year/.test(header)) return "0";
  if (/%|率|比|ratio|rate|涨|跌|幅/.test(header)) return "0.0%";
  if (/\$|元|价|额|金|amount|price|cost|revenue/.test(header)) return "#,##0.00";
  if (Number.isInteger(value) && Math.abs(value) >= 1000) return "#,##0";
  return "#,##0.00";
}
function displayWidth(value: unknown): number {
  return Array.from(String(value)).reduce((width, character) => width + (character.charCodeAt(0) > 127 ? 2 : 1), 0);
}
function fillWorkbook(book: import("exceljs").Workbook, sheets: SheetInput[], theme: Theme): void {
  const headerFill: import("exceljs").Fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerFill } };
  const zebraFill: import("exceljs").Fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.zebraFill } };
  const border: Partial<import("exceljs").Borders> = {
    top: { style: "thin", color: { argb: theme.borderColor } }, left: { style: "thin", color: { argb: theme.borderColor } },
    bottom: { style: "thin", color: { argb: theme.borderColor } }, right: { style: "thin", color: { argb: theme.borderColor } },
  };
  const headingBorder: Partial<import("exceljs").Borders> = { ...border, bottom: { style: "medium", color: { argb: theme.headerBorder } } };
  for (const input of sheets) {
    const sheet = book.addWorksheet(input.name || "Sheet1");
    if (Array.isArray(input.headers)) sheet.addRow(input.headers);
    for (const values of (input.rows || [])) sheet.addRow(values);
    const labels = input.headers || [];
    const count = input.rows?.length || 0;
    const endRow = count + 1;
    const heading = sheet.getRow(1);
    heading.height = 24;
    heading.eachCell({ includeEmpty: false }, cell => {
      cell.font = { bold: true, color: { argb: theme.headerFont }, size: 11, name: "Calibri" };
      cell.fill = headerFill;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = headingBorder;
    });
    for (let index = 2; index <= endRow; index++) {
      const row = sheet.getRow(index);
      const striped = (index - 1) % 2 === 0;
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        cell.border = border;
        if (striped) cell.fill = zebraFill;
        if (typeof cell.value === "number") {
          cell.alignment = { horizontal: "right", vertical: "middle" };
          const label = labels[column - 1] ? String(labels[column - 1]).toLowerCase() : "";
          cell.numFmt = numberFormat(label, cell.value);
        } else if (cell.value instanceof Date) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.numFmt = "yyyy-mm-dd";
        } else { cell.alignment = { horizontal: "left", vertical: "middle" }; }
      });
    }
    sheet.columns.forEach((column, index) => {
      let width = labels[index] ? displayWidth(labels[index]) + 4 : 8;
      for (const values of (input.rows || [])) {
        const value = values[index];
        if (value !== undefined && value !== null) {
          const measured = displayWidth(value);
          if (measured + 2 > width) width = measured + 2;
        }
      }
      column.width = Math.min(Math.max(width, 10), 45);
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    if (labels.length > 0 && count > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: endRow, column: labels.length } };
  }
}
async function writeWorkbook(book: import("exceljs").Workbook, destination: string, context?: ToolContext): Promise<void> {
  const writes = beginWriteBatch(context, [destination]);
  await writes.run([destination], async () => {
    const parent = path.dirname(destination);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    captureBaseline(context, destination);
    const output = fs.createWriteStream(destination);
    const close = new Promise<void>(resolve => output.once("close", resolve));
    const finish = finished(output, { cleanup: true });
    void finish.catch(() => {});
    try {
      await book.xlsx.write(output);
      output.end();
      await finish;
      await close;
    } catch (failure) {
      output.destroy();
      await close;
      throw failure;
    }
  });
}
async function wordDocument(args: Arguments, context?: ToolContext): Promise<string> {
  const name = validateFilename(String(args.filename || ""), ".docx");
  if (!name) return filenameError(".docx", args);
  const destination = resolveOutputPath(name, context?.resolvedWorkspaceRoot);
  if (!destination) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + name;
  const catalog = loadStylesDir("docx");
  const identifier = args.style ? String(args.style) : "default";
  const selected = (catalog[identifier] ?? catalog["default"]) as {
    name?: string; titleColor?: string; titleSize?: number; titleFont?: string; bodyFont?: string;
    bodySize?: number; bodyColor?: string; lineSpacing?: number; headingColor?: string;
  } | undefined;
  const titleInk = toHexColor(selected?.titleColor ?? "FF1F4E79");
  const titlePoints = selected?.titleSize ?? 28;
  const titleTypeface = selected?.titleFont ?? "微软雅黑";
  const bodyTypeface = selected?.bodyFont ?? "微软雅黑";
  const bodyPoints = selected?.bodySize ?? 24;
  const bodyInk = toHexColor(selected?.bodyColor ?? "FF333333");
  const leading = selected?.lineSpacing ?? 360;
  const headingInk = toHexColor(selected?.headingColor ?? "FF1F4E79");
  console.log(docLog, "Word 主题:", selected?.name ?? "默认商务", "style=" + identifier);
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const document = new Document({ styles: { default: { document: { run: { font: bodyTypeface, size: bodyPoints, color: bodyInk }, paragraph: { spacing: { line: leading } } } } },
    sections: [{ children: [new Paragraph({ text: String(args.title || ""), heading: HeadingLevel.HEADING_1,
      run: { font: titleTypeface, size: titlePoints, bold: true, color: titleInk }, spacing: { after: 200, line: leading } }),
      ...((args.paragraphs as string[]) || []).map(text => new Paragraph({ children: [new TextRun({ text, font: bodyTypeface, size: bodyPoints, color: bodyInk })], spacing: { line: leading, after: 120 } }))] }] });
  const bytes = await Packer.toBuffer(document);
  const writes = beginWriteBatch(context, [destination]);
  await writes.run([destination], () => {
    const parent = path.dirname(destination);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    captureBaseline(context, destination);
    fs.writeFileSync(destination, bytes);
  });
  console.log(docLog, "Word 已生成:", destination);
  return `[write_word] 已生成：${destination}`;
}
async function pdfDocument(args: Arguments, context?: ToolContext): Promise<string> {
  const name = validateFilename(String(args.filename || ""), ".pdf");
  if (!name) return filenameError(".pdf", args);
  const destination = resolveOutputPath(name, context?.resolvedWorkspaceRoot);
  if (!destination) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + name;
  const PDFKit = await import("pdfkit");
  const parent = path.dirname(destination);
  captureBaseline(context, destination);
  const document = new PDFKit.default();
  let output: fs.WriteStream | undefined;
  let finish: Promise<void> | undefined;
  let scratch: string | undefined;
  let created = false;
  try {
    const candidates = [{ file: "C:\\Windows\\Fonts\\msyh.ttc", family: "MicrosoftYaHei" },
      { file: "C:\\Windows\\Fonts\\simsun.ttc", family: "SimSun" }, { file: "C:\\Windows\\Fonts\\simhei.ttf", family: undefined }];
    let fontFailure: unknown;
    let selected = false;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.file)) continue;
      try {
        if (candidate.family) document.font(candidate.file, candidate.family);
        else document.font(candidate.file);
        selected = true;
        break;
      } catch (failure) { fontFailure = failure; }
    }
    if (!selected && fontFailure) throw new Error("FIREFLY_PDF_FONT_UNAVAILABLE", { cause: fontFailure });
    scratch = path.join(parent, `.firefly-pdf-${randomUUID()}.tmp`);
    const writes = beginWriteBatch(context, [scratch, destination]);
    await writes.run([scratch], async () => {
      try {
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        output = fs.createWriteStream(scratch!, { flags: "wx", mode: 0o600 });
        output.once("open", () => { created = true; });
        finish = pipeline(document, output);
        void finish.catch(() => {});
        document.fontSize(22).text(String(args.title || ""), { align: "center" });
        document.moveDown();
        document.fontSize(12);
        for (const text of (args.paragraphs as string[]) || []) {
          document.text(text, { align: "left" });
          document.moveDown(0.5);
        }
        document.end();
        await finish;
        writes.runSync([scratch!, destination], () => fs.renameSync(scratch!, destination));
      } catch (failure) {
        document.destroy();
        output?.destroy();
        if (finish) await finish.catch(() => {});
        throw failure;
      } finally { if (scratch && created) fs.rmSync(scratch, { force: true }); }
    });
  } catch (failure) {
    document.destroy();
    throw failure;
  }
  console.log(docLog, "PDF 已生成:", destination);
  return `[write_pdf] 已生成：${destination}`;
}
export function registerDocumentTools(): void {
  const getTheme = themeReader();
  const HANDLER_write_excel = async (args: Arguments, context?: ToolContext): Promise<string> => {
    const name = validateFilename(String(args.filename || ""), ".xlsx");
    if (!name) return filenameError(".xlsx", args);
    const destination = resolveOutputPath(name, context?.resolvedWorkspaceRoot);
    if (!destination) return "[错误] 路径不合法（禁止目录穿越或绝对路径）: " + name;
    const sheets = args.sheets as SheetInput[];
    if (!Array.isArray(sheets) || sheets.length === 0) return "[错误] sheets 不能为空。本次收到的参数键：" + (Object.keys(args).join(", ") || "（空）");
    const ExcelJS = await import("exceljs");
    const book = new ExcelJS.Workbook();
    const preset = getTheme(args.style ? String(args.style) : undefined);
    const overrides = args.colors as ThemeColors | undefined;
    const appearance = mergeTheme(preset, overrides);
    console.log(docLog, "Excel 主题:", appearance.name, "style=" + (args.style || "default"), overrides ? "+自定义颜色" : "");
    fillWorkbook(book, sheets, appearance);
    await writeWorkbook(book, destination, context);
    console.log(docLog, "Excel 已生成（默认美观样式）:", destination);
    return `[write_excel] 已生成：${destination}`;
  };
  const HANDLER_write_word = wordDocument;
  const HANDLER_write_pdf = pdfDocument;
  toolRegistry.register({
  "id": "write_excel",
  "name": "写 Excel",
  "description": "生成一个美观的 Excel 文件（.xlsx）。支持多种预设风格 + 自定义颜色。已内置：表头加粗+背景、全表细边框、隔行斑马纹、列宽自适应、数字右对齐+千位分隔、冻结首行、自动筛选。\n【优先使用】简单表格生成、数据整理、换算结果导出等场景应直接用此工具，不要走 invoke_skill(xlsx)。\n\n何时用：\n- 用户要把数据整理成表格\n- 用户要「做一张表」「导出 Excel」「整理成 Excel」\n- 用户明确选择了风格 → 用对应 style 参数直接生成；尚未明确时先向用户确认\n- 用户给了自定义颜色要求 → 用 colors 参数传 ARGB hex 值\n\n不要用于：\n- 需要 Excel 公式、编辑已有 xlsx → 才考虑 invoke_skill(xlsx)\n\nstyle：预设风格名（见 skills/xlsx/styles/catalog.md）。可选值含 default / dark / colorful / simple-business / financial。\ncolors（可选）：自定义颜色覆盖，每个是 ARGB hex 如 'FFF8BBD0'（粉色）。\n参数：filename（.xlsx 结尾，可含子目录），sheets（工作表数组），style（可选），colors（可选）。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "work"
  ],
  "needsContext": true,
  "effectKind": "mutation",
  "verificationPolicy": "artifact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filename": {
        "type": "string",
        "description": "文件名，可含子目录如 'test/report.xlsx'（相对桌面，.xlsx 结尾）"
      },
      "sheets": {
        "type": "array",
        "description": "工作表数组",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "description": "工作表名"
            },
            "headers": {
              "type": "array",
              "description": "表头字符串数组",
              "items": {
                "type": "string"
              }
            },
            "rows": {
              "type": "array",
              "description": "数据行，每行是一个数组",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      "style": {
        "type": "string",
        "description": "预设主题：default(深蓝,默认) / simple-business(简洁商务) / dark(深色护眼) / colorful(彩色清晰) / financial(财务报表)"
      },
      "colors": {
        "type": "object",
        "description": "自定义颜色覆盖（ARGB hex，如 'FFF8BBD0' 粉色 / 'FF2D2D2D' 深灰）。你负责把用户的颜色描述翻译成 hex。",
        "properties": {
          "headerFill": {
            "type": "string",
            "description": "表头背景色 ARGB hex，如 'FFF8BBD0'(粉)"
          },
          "headerFont": {
            "type": "string",
            "description": "表头文字色 ARGB hex，如 'FF333333'(深灰)"
          },
          "headerBorder": {
            "type": "string",
            "description": "表头底线色 ARGB hex"
          },
          "zebraFill": {
            "type": "string",
            "description": "斑马纹背景色 ARGB hex"
          },
          "borderColor": {
            "type": "string",
            "description": "边框颜色 ARGB hex"
          }
        }
      }
    },
    "required": [
      "filename",
      "sheets"
    ]
  }
, execute: HANDLER_write_excel });
  toolRegistry.register({
  "id": "write_word",
  "name": "写 Word",
  "description": "生成一个美观的 Word 文档（.docx）。支持多种预设风格主题。\n已内置：标题样式（颜色/字号/字体）、正文行距/字体/颜色、段落间距。\n\n何时用：\n- 用户要写报告/总结/方案/请假条\n- 需要「导出成 Word」「做成 docx」\n- 用户明确选择了风格 → 用对应 style 参数直接生成；尚未明确时先向用户确认\n\n不要用于：\n- 表格数据（用 write_excel）\n- 轻量笔记（用 write_file）\n- 需要复杂排版（页眉页脚/目录/图片/表格）→ 才考虑 invoke_skill(docx)\n\nstyle 可选值（见 skills/docx/styles/catalog.md）：default(商务) / academic(学术) / clean(极简) / elegant(优雅) / formal(公文)。\n参数：filename（只传文件名，如 AI新闻汇总.docx，不要传绝对路径；输出目录由系统固定为桌面），title（标题），paragraphs（段落数组），style（可选预设风格）。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "work"
  ],
  "needsContext": true,
  "effectKind": "mutation",
  "verificationPolicy": "artifact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filename": {
        "type": "string",
        "description": "文件名，必须以 .docx 结尾，例如 'AI新闻汇总.docx'。只传文件名，不要传绝对路径或目录。文件默认写入系统指定的桌面目录。"
      },
      "title": {
        "type": "string",
        "description": "文档标题"
      },
      "paragraphs": {
        "type": "array",
        "description": "段落字符串数组",
        "items": {
          "type": "string"
        }
      },
      "style": {
        "type": "string",
        "description": "预设风格：default(商务) / academic(学术) / clean(极简) / elegant(优雅) / formal(公文)"
      }
    },
    "required": [
      "filename",
      "title",
      "paragraphs"
    ]
  }
, execute: HANDLER_write_word });
  toolRegistry.register({
  "id": "write_pdf",
  "name": "写 PDF",
  "description": "生成一个 PDF 文件保存到桌面。\n\n何时用：\n- 用户要写正式文档（合同/简历/申请书）\n- 需要「导出成 PDF」\n\n不要用于：\n- 可编辑文档（用 write_word）\n- 表格数据（用 write_excel）\n\n参数：filename（.pdf 结尾），title（标题），paragraphs（段落数组）。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "work"
  ],
  "needsContext": true,
  "effectKind": "mutation",
  "verificationPolicy": "artifact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filename": {
        "type": "string",
        "description": "文件名（.pdf 结尾）"
      },
      "title": {
        "type": "string",
        "description": "标题"
      },
      "paragraphs": {
        "type": "array",
        "description": "段落字符串数组",
        "items": {
          "type": "string"
        }
      }
    },
    "required": [
      "filename",
      "title",
      "paragraphs"
    ]
  }
, execute: HANDLER_write_pdf });
}
