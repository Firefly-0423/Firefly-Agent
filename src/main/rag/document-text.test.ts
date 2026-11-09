import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractDocumentText, legacyDocumentReason, wordXmlText } from "./document-text";

const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

async function zip(parts: Record<string, string>): Promise<Buffer> {
  const archive = new JSZip();
  for (const [name, text] of Object.entries(parts)) archive.file(name, text);
  return archive.generateAsync({ type: "nodebuffer" });
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

function pdf(draw: (doc: any) => void): Promise<Buffer> {
  return new Promise(resolve => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    draw(doc);
    doc.end();
  });
}

describe("extractDocumentText", () => {
  it("reads Word paragraphs, tables, escaped characters and footnotes", async () => {
    const body = paragraph("流萤测试文档") + paragraph("A &amp; B &lt;ok&gt;")
      + `<w:tbl><w:tr><w:tc>${paragraph("名称")}</w:tc><w:tc>${paragraph("数量")}</w:tc></w:tr><w:tr><w:tc>${paragraph("流萤")}</w:tc><w:tc>${paragraph("3")}</w:tc></w:tr></w:tbl>`
      + `<w:p><w:r><w:t>前</w:t><w:tab/><w:t>后</w:t><w:br/><w:t>下一行</w:t></w:r></w:p>`;
    const bytes = await zip({
      "word/document.xml": `<w:document ${W}><w:body>${body}</w:body></w:document>`,
      "word/footnotes.xml": `<w:footnotes ${W}><w:footnote>${paragraph("脚注内容")}</w:footnote></w:footnotes>`,
    });
    const text = await extractDocumentText(bytes, ".DOCX");
    expect(text).toBe("流萤测试文档\nA & B <ok>\n名称\t数量\n流萤\t3\n前\t后\n下一行\n\n## 脚注\n脚注内容");
  });

  it("falls back to numeric file order without a slide list, and never guesses notes by number", async () => {
    const slide = (text: string) => `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p></p:sld>`;
    const bytes = await zip({
      "ppt/slides/slide10.xml": slide("第十页"),
      "ppt/slides/slide2.xml": slide("第二页"),
      "ppt/notesSlides/notesSlide2.xml": `<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>讲稿</a:t></a:r></a:p></p:notes>`,
    });
    expect(await extractDocumentText(bytes, ".pptx")).toBe("## 幻灯片 2\n第二页\n第二段\n\n## 幻灯片 10\n第十页\n第二段");
  });

  it("follows the presentation's slide list and each slide's notes relationship", async () => {
    // Codex review on #47: rearranged decks came out in file-name order, and notes were matched by number.
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const rels = (entries: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
    const slide = (text: string) => `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const bytes = await zip({
      "ppt/presentation.xml": `<p:presentation xmlns:p="p" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels(`<Relationship Id="rId2" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Type="${R}/slide" Target="/ppt/slides/slide2.xml" Id="rId3"/>`),
      "ppt/slides/slide1.xml": slide("原第一页"),
      "ppt/slides/slide2.xml": slide("挪到最前"),
      "ppt/slides/_rels/slide2.xml.rels": rels(`<Relationship Id="rId1" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>属于挪到最前的讲稿</a:t></a:r></a:p></p:notes>`,
    });
    expect(await extractDocumentText(bytes, ".pptx")).toBe("## 幻灯片 1\n挪到最前\n备注：属于挪到最前的讲稿\n\n## 幻灯片 2\n原第一页");
  });

  it("keeps Excel error values instead of printing [object Object]", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("错误");
    sheet.getCell("A1").value = { formula: "1/0", result: { error: "#DIV/0!" } };
    sheet.getCell("B1").value = { error: "#N/A" };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await extractDocumentText(bytes, ".xlsx")).toBe("## 工作表 错误\n#DIV/0!\t#N/A");
  });

  it("reads every Excel sheet as tab-separated rows, using formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet("库存");
    first.addRow(["名称", "数量"]);
    first.addRow(["流萤", 3]);
    first.getCell("C2").value = { formula: "B2*2", result: 6 };
    workbook.addWorksheet("备注").addRow(["多行\n文字", null, "末列"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await extractDocumentText(bytes, ".xlsx")).toBe("## 工作表 库存\n名称\t数量\n流萤\t3\t6\n\n## 工作表 备注\n多行 文字\t\t末列");
  });

  it("reads PDF text page by page", async () => {
    const bytes = await pdf(doc => { doc.text("Hello Firefly PDF line one"); doc.text("Second line 12345"); doc.addPage(); doc.text("Page two text"); });
    expect(await extractDocumentText(bytes, ".pdf")).toBe("## 第 1 页\nHello Firefly PDF line one\nSecond line 12345\n\n## 第 2 页\nPage two text");
  });

  const cjkFont = "C:/Windows/Fonts/simhei.ttf";
  it.skipIf(!fs.existsSync(cjkFont))("reads Chinese PDF text written with an embedded CJK font", async () => {
    const bytes = await pdf(doc => { doc.font(cjkFont).text("流萤测试文档"); doc.text("第二行：数字 12345"); });
    expect(await extractDocumentText(bytes, ".pdf")).toBe("## 第 1 页\n流萤测试文档\n第二行：数字 12345");
  });

  it("explains PDFs without a text layer, damaged files and legacy formats", async () => {
    const scanned = await pdf(doc => { doc.rect(10, 10, 100, 100).fill("#000"); });
    await expect(extractDocumentText(scanned, ".pdf")).rejects.toThrow("扫描件");
    await expect(extractDocumentText(Buffer.from("not a pdf"), ".pdf")).rejects.toThrow("可能已损坏");
    await expect(extractDocumentText(Buffer.from("not a zip"), ".docx")).rejects.toThrow("可能已损坏");
    await expect(extractDocumentText(await zip({ "other.xml": "<x/>" }), ".docx")).rejects.toThrow("word/document.xml");
    await expect(extractDocumentText(Buffer.from("x"), ".doc")).rejects.toThrow("另存为 .docx");
    expect(legacyDocumentReason(".XLS")).toContain(".xlsx");
    expect(legacyDocumentReason(".txt")).toBeNull();
  });

  it("returns the same text when the same bytes are read again", async () => {
    const bytes = await zip({ "word/document.xml": `<w:document ${W}><w:body>${paragraph("缓存")}</w:body></w:document>` });
    expect(await extractDocumentText(bytes, ".docx")).toBe("缓存");
    expect(await extractDocumentText(Buffer.from(bytes), ".docx")).toBe("缓存");
  });

  it("extracts a large Word table in linear time", () => {
    // Codex review on #47: each cell end recopied the whole output, so 5,000 rows took about 8 s.
    const row = `<w:tr><w:tc>${paragraph("名称名称名称")}</w:tc><w:tc>${paragraph("12345")}</w:tc></w:tr>`;
    const began = performance.now();
    const text = wordXmlText(`<w:tbl>${row.repeat(20000)}</w:tbl>`);
    expect(performance.now() - began).toBeLessThan(1500);
    expect(text.split("\n")).toHaveLength(20001);
    expect(text.startsWith("名称名称名称\t12345\n")).toBe(true);
  });

  it("refuses a document over the character cap instead of returning part of it", async () => {
    // Codex review on #47: trailing spaces counted toward the cap but were trimmed afterwards, so a cut-off prefix
    // fell back under the limit and passed for the whole document.
    expect(() => wordXmlText(paragraph("x".repeat(1000)).repeat(9000))).toThrow("无法读取");
    const padded = paragraph("y".repeat(100) + " ".repeat(900)).repeat(9000) + paragraph("最后一节");
    const bytes = await zip({ "word/document.xml": `<w:document ${W}><w:body>${padded}</w:body></w:document>` });
    await expect(extractDocumentText(bytes, ".docx")).rejects.toThrow("请拆分后再上传");
  });
});
