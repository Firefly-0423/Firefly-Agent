import importlib.util
import json
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from xlsx_workspace import find_label
from xlsx_add_column import find_ws_path
from formula_check import check


class WindowsWorkflowTests(unittest.TestCase):
    def create_workbook(self, path: Path) -> None:
        files = {
            "xl/workbook.xml": """<?xml version='1.0'?><workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets><sheet name='Budget' sheetId='1' r:id='rId1'/></sheets></workbook>""",
            "xl/_rels/workbook.xml.rels": """<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/></Relationships>""",
            "xl/sharedStrings.xml": """<?xml version='1.0'?><sst xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><si><t>Office Rent</t></si></sst>""",
            "xl/worksheets/sheet1.xml": """<?xml version='1.0'?><worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData><row r='4'><c r='A4' t='s'><v>0</v></c></row></sheetData></worksheet>""",
        }
        with zipfile.ZipFile(path, "w") as archive:
            for name, text in files.items():
                archive.writestr(name, text)

    def test_find_label_returns_the_real_sheet_and_row(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "budget.xlsx"
            self.create_workbook(workbook)

            matches = find_label(workbook, "office rent")

            self.assertEqual(matches, [{"sheet": "Budget", "cell": "A4", "row": 4, "text": "Office Rent"}])

    def test_workflow_documentation_is_windows_first(self):
        text = (SCRIPTS.parent / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("python (Join-Path $scriptRoot 'xlsx_workspace.py')", text)
        self.assertIn("$env:TEMP", text)
        self.assertNotIn("/tmp/", text)
        self.assertNotIn("grep -n", text)

    def test_powershell_resolves_resources_from_foreign_directory(self):
        with tempfile.TemporaryDirectory(prefix="office space-") as directory:
            root = Path(directory)
            workbook = root / "budget.xlsx"
            self.create_workbook(workbook)
            script = root / "invoke.ps1"
            script.write_text("""param($SkillDir, $PythonExe, $InputFile)
$scriptRoot = Join-Path $SkillDir 'scripts'
& $PythonExe (Join-Path $scriptRoot 'xlsx_workspace.py') find-label --input $InputFile --label 'office rent'
exit $LASTEXITCODE
""", encoding="utf-8")
            result = subprocess.run([shutil.which("pwsh") or "powershell", "-NoProfile", "-File", str(script),
                                     "-SkillDir", str(SCRIPTS.parent), "-PythonExe", sys.executable,
                                     "-InputFile", str(workbook)], cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["matches"][0]["cell"], "A4")

    def test_editor_resolves_internal_absolute_and_relative_relationships(self):
        for target in ("/xl/worksheets/sheet1.xml", "worksheets/sheet1.xml", "../xl/worksheets/sheet1.xml"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                workbook = root / "budget.xlsx"
                self.create_workbook(workbook)
                with zipfile.ZipFile(workbook) as archive:
                    archive.extractall(root / "unpacked")
                rels = root / "unpacked/xl/_rels/workbook.xml.rels"
                rels.write_text(rels.read_text().replace("worksheets/sheet1.xml", target))
                self.assertEqual(Path(find_ws_path(str(root / "unpacked"), "Budget")),
                                 root / "unpacked/xl/worksheets/sheet1.xml")

    def test_editor_rejects_external_and_traversal_relationships(self):
        for target, attribute in (("../../outside.xml", ""), ("https://example.invalid/sheet.xml", ""),
                                  ("worksheets/sheet1.xml", " TargetMode='External'"),
                                  ("%2e%2e/%2e%2e/outside.xml", "")):
            with self.subTest(target=target, attribute=attribute), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                workbook = root / "budget.xlsx"
                self.create_workbook(workbook)
                with zipfile.ZipFile(workbook) as archive:
                    archive.extractall(root / "unpacked")
                rels = root / "unpacked/xl/_rels/workbook.xml.rels"
                rels.write_text(rels.read_text().replace("Target='worksheets/sheet1.xml'",
                                                       f"Target='{target}'{attribute}"))
                with self.assertRaises(ValueError):
                    find_ws_path(str(root / "unpacked"), "Budget")

    def test_unpack_pack_preserves_unedited_parts_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "budget.xlsx"
            self.create_workbook(workbook)
            with zipfile.ZipFile(workbook, "a") as archive:
                archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
                archive.writestr("customXml/item1.xml", '<data xml:space="preserve">  exact\n spacing  </data>')
                archive.writestr("xl/media/keep.bin", b"\x00\xffpreserve")
            before = hashlib.sha256(workbook.read_bytes()).hexdigest()
            for script, args in (("xlsx_unpack.py", [workbook, root / "unpacked"]),
                                 ("xlsx_pack.py", [root / "unpacked", root / "output.xlsx"])):
                result = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)],
                                        cwd=root, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(hashlib.sha256(workbook.read_bytes()).hexdigest(), before)
            with zipfile.ZipFile(workbook) as source, zipfile.ZipFile(root / "output.xlsx") as output:
                self.assertEqual(sorted(source.namelist()), sorted(output.namelist()))
                for name in source.namelist():
                    self.assertEqual(output.read(name), source.read(name), name)

    def test_unpack_rejects_occupied_workspace_without_removing_user_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "budget.xlsx"
            self.create_workbook(workbook)
            work = root / "unpacked"
            work.mkdir()
            marker = work / "user-work.txt"
            marker.write_text("keep")
            result = subprocess.run([sys.executable, str(SCRIPTS / "xlsx_unpack.py"), str(workbook), str(work)],
                                    cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), "keep")

    def test_unpack_rejects_zip_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "malicious.xlsx"
            with zipfile.ZipFile(workbook, "w") as archive:
                archive.writestr("../escaped.txt", "do not extract")
            result = subprocess.run([sys.executable, str(SCRIPTS / "xlsx_unpack.py"), str(workbook), str(root / "unpacked")],
                                    cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "escaped.txt").exists())

    def test_formula_check_reads_root_and_relative_relationships(self):
        for target in ("/xl/worksheets/sheet1.xml", "worksheets/sheet1.xml", "../xl/worksheets/sheet1.xml"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                workbook = Path(directory) / "budget.xlsx"
                self.create_workbook(workbook)
                with zipfile.ZipFile(workbook) as archive:
                    files = {name: archive.read(name) for name in archive.namelist()}
                files["xl/_rels/workbook.xml.rels"] = files["xl/_rels/workbook.xml.rels"].replace(b"worksheets/sheet1.xml", target.encode())
                files["xl/worksheets/sheet1.xml"] = files["xl/worksheets/sheet1.xml"].replace(b"<v>0</v>", b"<f>SUM(B2:B3)</f><v>0</v>")
                with zipfile.ZipFile(workbook, "w") as archive:
                    for name, content in files.items():
                        archive.writestr(name, content)
                report = check(str(workbook))
                self.assertEqual(report["error_count"], 0, report)
                self.assertEqual(report["formula_count"], 1, report)

    def test_formula_check_rejects_wrong_type_missing_or_external_sheet_relationship(self):
        for replacement in ("styles", "missing", "external"):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as directory:
                workbook = Path(directory) / "budget.xlsx"
                self.create_workbook(workbook)
                with zipfile.ZipFile(workbook) as archive:
                    files = {name: archive.read(name) for name in archive.namelist()}
                rels = files["xl/_rels/workbook.xml.rels"]
                if replacement == "styles":
                    rels = rels.replace(b"relationships/worksheet", b"relationships/styles")
                elif replacement == "missing":
                    rels = rels.replace(b"Id='rId1'", b"Id='unused'")
                else:
                    rels = rels.replace(b"Target='", b"TargetMode='External' Target='")
                files["xl/_rels/workbook.xml.rels"] = rels
                with zipfile.ZipFile(workbook, "w") as archive:
                    for name, content in files.items():
                        archive.writestr(name, content)
                self.assertGreater(check(str(workbook))["error_count"], 0)


if __name__ == "__main__":
    unittest.main()
