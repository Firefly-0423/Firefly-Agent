"""Synthetic PDF/XLSX acceptance. Requires the existing PDF Skill dependencies.

Run with an isolated interpreter and TEMP/TMP/TMPDIR set to an authorized workspace.
The output directory must not exist. No user documents or native Office app are opened.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ROOT / "vendor/firefly-skills/skills"
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def workbook(path: Path) -> None:
    rows = []
    for row in range(1, 11):
        label = "Office Rent 办公费用" if row == 4 else f"Item {row}"
        rows.append(f'<row r="{row}"><c r="A{row}" t="inlineStr"><is><t>{label}</t></is></c>'
                    f'<c r="F{row}"><v>{100 if row == 10 else 10}</v></c></row>')
    parts = {
        "[Content_Types].xml": '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>''',
        "_rels/.rels": '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>''',
        "xl/workbook.xml": f'''<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget FY2026" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>''',
        "xl/_rels/workbook.xml.rels": '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>''',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{NS}"><dimension ref="A1:F10"/><sheetData>{"".join(rows)}</sheetData></worksheet>',
        "xl/sharedStrings.xml": f'<sst xmlns="{NS}" count="0" uniqueCount="0"/>',
        "xl/styles.xml": f'''<styleSheet xmlns="{NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>''',
        "customXml/item1.xml": '<payload xml:space="preserve">  Keep exact\n spacing  </payload>',
        "xl/media/sentinel.bin": b"\x00\xffunrelated-part-preserved",
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)


def accept(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    commands = []

    def run(skill: str, script: str, *args: str | Path) -> str:
        command = [sys.executable, str(SKILLS / skill / "scripts" / script), *map(str, args)]
        result = subprocess.run(command, cwd=output, capture_output=True, text=True, encoding="utf-8")
        commands.append({"command": command, "cwd": str(output), "exit": result.returncode,
                         "stdout": result.stdout, "stderr": result.stderr})
        (output / "commands.json").write_text(json.dumps(commands, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if result.returncode:
            raise RuntimeError(f"{script}: {result.stderr}")
        return result.stdout

    from pypdf import PdfReader
    sys.path.insert(0, str(SKILLS / "pdf/scripts"))
    from pdf_cover import resolve_font_paths

    content = output / "content.json"
    content.write_text(json.dumps([
        {"type": "h1", "text": "中文与英文验收报告"},
        {"type": "body", "text": "来源内容保留。 Evidence retained 2026. 合成文件，不包含用户数据。"},
        {"type": "table", "headers": ["项目 Item", "状态 Status"], "rows": [["记忆底座", "已隔离验证"], ["Office XML", "内容保留"]]},
        {"type": "pagebreak"},
        {"type": "h1", "text": "下一页 Next page"},
        {"type": "body", "text": "分页、中文字体和边界检查。 No clipping or missing glyphs should appear."},
    ], ensure_ascii=False, indent=2), encoding="utf-8")
    source_hash = digest(content)
    pdf = output / "acceptance.pdf"
    run("pdf", "make.py", "run", "--title", "中文办公验收", "--author", "Firefly 验证",
        "--date", "2026-10-01", "--content", content, "--out", pdf)
    assert digest(content) == source_hash
    reader = PdfReader(pdf)
    text = "\n".join(page.extract_text() for page in reader.pages)
    for expected in ("中文办公验收", "来源内容保留", "Evidence retained 2026", "下一页 Next page"):
        assert expected in text, expected
    assert len(reader.pages) == 3, len(reader.pages)
    (output / "pdf-text.txt").write_text(text, encoding="utf-8")
    previews = json.loads(run("pdf", "make.py", "preview", "--input", pdf, "--out-dir", output / "preview", "--dpi", "96"))
    assert len(previews["pages"]) == 3

    source = output / "source.xlsx"
    workbook(source)
    original_hash = digest(source)
    workspace = Path(json.loads(run("xlsx", "xlsx_workspace.py", "create", "--base-dir", output))["workspace"])
    second = Path(json.loads(run("xlsx", "xlsx_workspace.py", "create", "--base-dir", output))["workspace"])
    assert workspace != second and workspace.parent == output and second.parent == output
    matches = json.loads(run("xlsx", "xlsx_workspace.py", "find-label", "--input", source, "--label", "office rent"))["matches"]
    assert matches[0]["sheet"] == "Budget FY2026" and matches[0]["cell"] == "A4"
    unpacked = workspace / "unpacked"
    run("xlsx", "xlsx_unpack.py", source, unpacked)
    run("xlsx", "xlsx_add_column.py", unpacked, "--sheet", "Budget FY2026", "--col", "G", "--header", "% of Total",
        "--formula", "=F{row}/$F$10", "--formula-rows", "2:9", "--total-row", "10", "--total-formula", "=SUM(G2:G9)", "--numfmt", "0.0%")
    edited = output / "edited.xlsx"
    run("xlsx", "xlsx_pack.py", unpacked, edited)
    static = json.loads(run("xlsx", "formula_check.py", edited, "--json"))
    assert static["formula_count"] == 9 and static["error_count"] == 0, static
    assert digest(source) == original_hash
    changed = {"xl/worksheets/sheet1.xml", "xl/sharedStrings.xml", "xl/styles.xml"}
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(edited) as current:
        assert set(original.namelist()) == set(current.namelist())
        for name in set(original.namelist()) - changed:
            assert original.read(name) == current.read(name), name
        sheet = ET.fromstring(current.read("xl/worksheets/sheet1.xml"))
        cells = {cell.get("r"): cell for cell in sheet.findall(f".//{{{NS}}}c")}
        assert cells["G2"].findtext(f"{{{NS}}}f") == "F2/$F$10"
        assert cells["G10"].findtext(f"{{{NS}}}f") == "SUM(G2:G9)"
        assert cells["A4"].findtext(f"{{{NS}}}is/{{{NS}}}t") == "Office Rent 办公费用"
    return {"status": "ok", "python": sys.version, "interpreter": sys.executable,
            "packages": {name: importlib.metadata.version(name) for name in ("reportlab", "pypdf", "pypdfium2", "matplotlib")},
            "pdf": {"pages": 3, "fonts": {name: str(path) for name, path in resolve_font_paths().items()}, "previewPages": previews["pages"], "visualReview": "pending"},
            "xlsx": {"formulas": 9, "staticErrors": 0, "preservedUneditedParts": True, "inputHash": original_hash,
                     "nativeRendering": "not exercised", "dynamicRecalculation": "not exercised",
                     "nativeCommandsOnPath": {name: shutil.which(name) for name in ("soffice", "excel")}},
            "artifacts": {p.relative_to(output).as_posix(): digest(p) for p in output.rglob("*") if p.is_file()}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = accept(args.output.resolve())
    receipt = args.output / "result.json"
    receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "receipt": str(receipt)}, ensure_ascii=False))
