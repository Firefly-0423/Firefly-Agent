---
name: xlsx
description: Create, read, edit, recalculate, and verify Excel workbooks on Windows while preserving formulas and existing workbook structure.
license: MIT
metadata:
  version: "2.0"
  category: productivity
modes:
  - work
  - code
---

# Windows-native XLSX workflow

PowerShell resource resolution: set `$skillDir` to the exact directory returned by `invoke_skill`, then `$scriptRoot = Join-Path $skillDir 'scripts'`. The command examples below use the same shell session; reinitialize both variables in a new shell. Keep inputs and outputs in the authorized workspace, not the installed Skill directory.

Firefly host: `write_excel` is registered for simple new tables in Work mode only. For formula-preserving edits, resolve `scripts/`, `references/` and `templates/` beneath the actual Skill local directory returned by `invoke_skill`; run Python/LibreOffice only if the current mode and approval allow. The unpack helper deletes its target directory before extracting, so pass only a new dedicated workspace subdirectory and never the source workbook or a shared directory.

Use existing XML helpers for formula work or edits of existing `.xlsx` files. Do not make a new workbook when the task is to edit an existing one: unpack, make the smallest XML change, pack, then validate.

For a simple data-only table, use the platform's normal workbook writer instead. This skill is for formulas, formatting-sensitive edits, macros, pivot preservation, and formula validation.

## Workspace and discovery

Create an isolated workspace under the Windows temporary directory, not beside the source file.

```powershell
python (Join-Path $scriptRoot 'xlsx_workspace.py') create --base-dir $env:TEMP
python (Join-Path $scriptRoot 'xlsx_reader.py') .\input.xlsx
python (Join-Path $scriptRoot 'xlsx_workspace.py') find-label --input .\input.xlsx --label "Office Rent"
```

`find-label` returns the actual worksheet, cell, and row. Use it before inserting a row from an instruction such as “insert after Office Rent”; do not trust a prompt-provided row number.

## Edit existing workbooks

```powershell
$workspaceInfo = python (Join-Path $scriptRoot 'xlsx_workspace.py') create --base-dir $env:TEMP | ConvertFrom-Json
if ($workspaceInfo.status -ne 'ok') { throw $workspaceInfo.error }
$work = Join-Path $workspaceInfo.workspace 'unpacked'
python (Join-Path $scriptRoot 'xlsx_unpack.py') .\input.xlsx $work
python (Join-Path $scriptRoot 'xlsx_add_column.py') $work --sheet "Budget FY2026" --col G --header "% of Total" --formula '=F{row}/$F$10' --formula-rows 2:9 --total-row 10 --total-formula '=SUM(G2:G9)' --numfmt '0.0%'
python (Join-Path $scriptRoot 'xlsx_pack.py') $work .\output.xlsx
python (Join-Path $scriptRoot 'formula_check.py') .\output.xlsx --report
```

Use a unique directory returned by `xlsx_workspace.py create` for concurrent tasks. Keep it until validation has passed, then remove only that known workspace.

## Create formula workbooks

Read `references/create.md` and `references/format.md`, copy `templates/minimal_xlsx/` to the temporary workspace, edit the XML, then pack it. Every calculated value must be an Excel formula, never a precomputed hard-coded number.

## Visual system

Read `styles/catalog.md` and the selected local style before choosing colors. Use clear header, input, formula and semantic-state colors consistently. Retain the workbook’s existing styling for edits unless the user asked for a visual redesign.

Financial convention: hard-coded inputs are blue (`0000FF`), formulas black (`000000`), and cross-sheet formulas green (`00B050`).

## Validate and recalculate

```powershell
python (Join-Path $scriptRoot 'formula_check.py') .\output.xlsx --json
python (Join-Path $scriptRoot 'libreoffice_recalc.py') .\output.xlsx .\output-recalculated.xlsx --timeout 90
python (Join-Path $scriptRoot 'formula_check.py') .\output-recalculated.xlsx --report
```

`formula_check.py` is required before delivery. LibreOffice is optional for dynamic recalculation; when it is installed, the helper locates standard Windows installation paths automatically.

## Rules

1. Preserve all original worksheets, names, values, macros, and unrelated XML parts during edits.
2. Use XML unpack/edit/pack for existing workbooks; do not round-trip them through `openpyxl`.
3. Confirm the expected sheet names and a source data sample after repacking.
4. Use `find-label` to locate labeled rows rather than a text-search command tied to a particular shell.
5. Never overwrite the input file; write and validate an explicit output file.
