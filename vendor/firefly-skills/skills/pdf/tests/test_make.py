import json
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
MAKE = SCRIPTS / "make.py"
PDF_SKILL = Path(__file__).resolve().parents[1]


class MakeCliTests(unittest.TestCase):
    def run_make(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(MAKE), *args],
            cwd=SCRIPTS,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_check_requires_only_python_packages(self):
        result = self.run_make("check")

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "ok")
        self.assertNotIn("playwright", result.stdout.lower())
        self.assertNotIn("node", result.stdout.lower())

    def test_run_creates_a_multi_page_pdf_with_chinese_title(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "windows-native.pdf"
            result = self.run_make(
                "run",
                "--title", "中文季度报告",
                "--type", "report",
                "--author", "Firefly 团队",
                "--out", str(output),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "ok")
            self.assertTrue(output.exists())
            self.assertGreaterEqual(len(PdfReader(output).pages), 2)

    def test_reformat_uses_the_source_content(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.md"
            output = Path(directory) / "reformatted.pdf"
            source.write_text("# Windows 内容\n\n这是被重排的正文。", encoding="utf-8")
            result = self.run_make(
                "reformat",
                "--input", str(source),
                "--title", "重排报告",
                "--out", str(output),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists())
            self.assertGreaterEqual(len(PdfReader(output).pages), 2)

    def test_public_pdf_workflow_has_no_browser_renderer(self):
        public_files = [PDF_SKILL / "SKILL.md", PDF_SKILL / "README.md"]
        public_text = "\n".join(path.read_text(encoding="utf-8").lower() for path in public_files)

        self.assertIn("python (join-path $scriptroot 'make.py')", public_text)
        self.assertNotIn("playwright", public_text)
        self.assertNotIn("render_cover.js", public_text)
        self.assertNotIn("bash scripts/make.sh", public_text)

    def test_powershell_resolves_resources_from_foreign_directory(self):
        with tempfile.TemporaryDirectory(prefix="office space-") as directory:
            root = Path(directory)
            script = root / "invoke.ps1"
            script.write_text("""param($SkillDir, $PythonExe)
$scriptRoot = Join-Path $SkillDir 'scripts'
& $PythonExe (Join-Path $scriptRoot 'make.py') check
exit $LASTEXITCODE
""", encoding="utf-8")
            result = subprocess.run([shutil.which("pwsh") or "powershell", "-NoProfile", "-File", str(script),
                                     "-SkillDir", str(PDF_SKILL), "-PythonExe", sys.executable],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], "ok")

    def test_reformat_preserves_input_and_extractable_cjk_and_english(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.md"
            source.write_text("# 中文验收报告\n\n来源内容保留。 Evidence retained 2026.", encoding="utf-8")
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            output = root / "report.pdf"
            result = self.run_make("reformat", "--input", str(source), "--title", "中文验收报告", "--out", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            text = "\n".join(page.extract_text() for page in PdfReader(output).pages)
            self.assertIn("中文验收报告", text)
            self.assertIn("来源内容保留", text)
            self.assertIn("Evidence retained 2026", text)

    def test_failed_build_retains_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "existing.pdf"
            output.write_bytes(b"existing-user-output")
            content = root / "invalid.json"
            content.write_text('{"not": "blocks"}', encoding="utf-8")
            result = self.run_make("run", "--title", "Invalid", "--content", str(content), "--out", str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stderr)["status"], "error")
            self.assertEqual(output.read_bytes(), b"existing-user-output")


if __name__ == "__main__":
    unittest.main()
