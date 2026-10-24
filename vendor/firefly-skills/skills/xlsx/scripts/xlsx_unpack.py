#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
xlsx_unpack.py — Unpack an xlsx file into a working directory for XML editing.

Usage:
    python3 xlsx_unpack.py <input.xlsx> <output_dir>

What it does:
1. Unzips the xlsx (which is a ZIP archive)
2. Preserves original part bytes; edit only the intended XML files
3. Prints a summary of key files to edit
"""

import sys
import zipfile
import os


def unpack(xlsx_path: str, output_dir: str) -> None:
    if not os.path.isfile(xlsx_path):
        print(f"ERROR: File not found: {xlsx_path}", file=sys.stderr)
        sys.exit(1)

    if not xlsx_path.lower().endswith((".xlsx", ".xlsm")):
        print(f"WARNING: '{xlsx_path}' does not have an .xlsx/.xlsm extension", file=sys.stderr)

    if os.path.lexists(output_dir) and (
        os.path.islink(output_dir) or getattr(os.path, "isjunction", lambda path: False)(output_dir)
        or not os.path.isdir(output_dir) or os.listdir(output_dir)
    ):
        print("ERROR: Output must be a new or empty dedicated workspace; existing files are preserved", file=sys.stderr)
        sys.exit(1)

    try:
        with zipfile.ZipFile(xlsx_path, "r") as z:
            # Validate member paths to prevent zip-slip (path traversal) attacks
            for member in z.namelist():
                member_path = os.path.realpath(os.path.join(output_dir, member))
                if not member_path.startswith(os.path.realpath(output_dir) + os.sep) and member_path != os.path.realpath(output_dir):
                    print(f"ERROR: Zip entry '{member}' would escape target directory (path traversal blocked)", file=sys.stderr)
                    sys.exit(1)
            os.makedirs(output_dir, exist_ok=True)
            z.extractall(output_dir)
    except zipfile.BadZipFile:
        print(f"ERROR: '{xlsx_path}' is not a valid ZIP/xlsx file", file=sys.stderr)
        sys.exit(1)

    # Preserve original bytes, including whitespace-sensitive or extension XML.
    # Readability must not silently rewrite unrelated package parts.
    xml_count = 0
    for dirpath, _, filenames in os.walk(output_dir):
        for fname in filenames:
            if fname.endswith(".xml") or fname.endswith(".rels"):
                fpath = os.path.join(dirpath, fname)
                xml_count += 1

    print(f"Unpacked '{xlsx_path}' → '{output_dir}'")
    print(f"Preserved {xml_count} XML/rels files without rewriting\n")

    # Print key files grouped by category
    categories = {
        "Package root": ["[Content_Types].xml", "_rels/.rels"],
        "Workbook": ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"],
        "Styles & Strings": ["xl/styles.xml", "xl/sharedStrings.xml"],
        "Worksheets": [],
    }

    all_files = []
    for dirpath, _, filenames in os.walk(output_dir):
        for fname in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fname), output_dir)
            all_files.append(rel)

    # Collect worksheets
    for rel in sorted(all_files):
        if rel.startswith("xl/worksheets/") and rel.endswith(".xml"):
            categories["Worksheets"].append(rel)

    print("Key files to inspect/edit:")
    for category, files in categories.items():
        if not files:
            continue
        print(f"\n  [{category}]")
        for f in files:
            full = os.path.join(output_dir, f)
            if os.path.isfile(full):
                size = os.path.getsize(full)
                print(f"    {f}  ({size:,} bytes)")
            else:
                print(f"    {f}  (not found)")

    # Warn about high-risk files present
    risky = {
        "xl/vbaProject.bin": "VBA macros — DO NOT modify",
        "xl/pivotTables": "Pivot tables — update source ranges carefully if shifting rows",
        "xl/charts": "Charts — update data ranges if shifting rows",
    }
    print("\n  [High-risk content detected:]")
    found_any = False
    for path, warning in risky.items():
        full = os.path.join(output_dir, path)
        if os.path.exists(full):
            print(f"    ⚠️  {path} — {warning}")
            found_any = True
    if not found_any:
        print("    ✓ None (safe to edit)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: xlsx_unpack.py <input.xlsx> <output_dir>")
        sys.exit(1)
    unpack(sys.argv[1], sys.argv[2])
