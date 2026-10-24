import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const relationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

async function runFindLabel(target, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "firefly-xlsx-test-"));
  try {
    const script = path.join(directory, "xlsx_workspace.py");
    await fs.copyFile(path.join(root, "vendor/firefly-skills/skills/xlsx/scripts/xlsx_workspace.py"), script);
    const workbook = new JSZip();
    const sheetName = options.sheetName ?? "Public Sheet";
    workbook.file("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    workbook.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationshipType}" Target="${target}"${options.external ? ' TargetMode="External"' : ""}/></Relationships>`);
    workbook.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Public label</t></is></c><c r="C2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`);
    const xlsx = path.join(directory, "public.xlsx");
    const bytes = await workbook.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(xlsx, bytes);
    const before = createHash("sha256").update(bytes).digest("hex");
    const result = spawnSync("python", [script, "find-label", "--input", xlsx, "--label", "Public label"], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(createHash("sha256").update(await fs.readFile(xlsx)).digest("hex"), before);
    return { status: result.status, output: JSON.parse(result.stdout) };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("find-label resolves root and part-relative worksheet relationships without changing the source", async () => {
  for (const [target, sheetName] of [["/xl/worksheets/sheet1.xml", "Public Sheet"], ["worksheets/sheet1.xml", "Second Public"], ["../xl/worksheets/sheet1.xml", "Nested Public"]]) {
    const result = await runFindLabel(target, { sheetName });
    assert.equal(result.status, 0, target);
    assert.deepEqual(result.output.matches, [{ sheet: sheetName, cell: "B2", row: 2, text: "Public label" }]);
  }
});

test("find-label rejects escaping and external worksheet relationships", async () => {
  for (const [target, options] of [["../../outside.xml", {}], ["https://example.invalid/sheet.xml", {}], ["worksheets/sheet1.xml", { external: true }]]) {
    const result = await runFindLabel(target, options);
    assert.equal(result.status, 1, target);
    assert.equal(result.output.status, "error");
  }
});
