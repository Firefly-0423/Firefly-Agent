# Proactive follow-up and Obsidian section fixes

> **Scope of this PR:** only the Obsidian section fix (section 2) is included here. The proactive penalty change described in section 1 (`-18` to `-15`) is NOT part of this PR: it is a tuning decision held in draft PR #181 until the product owner decides. The `audit/` evidence files mentioned below were temporary and are not committed.

Date: 2026-10-20 (Asia/Singapore)

Historical repair record: the proactive rules and verification below describe the earlier penalty-only fix. The owner subsequently selected [Plan B](2026-10-20-proactive-followup-plan-b.md): a 12-hour interval, a 75-point gate, and only a new return-from-away event, including after a previous return scene. References below to six hours, 85 points and different scenes are retained as historical evidence, not current policy. The Obsidian section is unaffected.

## Scope and baseline

- Branch: `codex/fix-proactive-obsidian`; starting HEAD: `d9a6da57` (replacement of the last inherited tests). The initial working tree was clean.
- Production changes are limited to `src/main/proactive/proactive-trigger.ts` and `src/main/knowledge/obsidian/obsidian-markdown.ts`. The latter implements the section operations called by `obsidian-workspace-service.ts`; the service itself needs no change.
- Tests changed only in our own `proactive-trigger.test.ts` and `obsidian-workspace-service.test.ts`.
- No commit, push, checkout, dependency installation, dependency edit, pinned-file edit, CI change, new check, or full-suite run was performed. Existing test concurrency and timeouts were retained.
- Applied the available Superpowers startup, systematic-debugging, test-driven-development and verification-before-completion workflows, plus context-engineering, constraint-driven-development, security-and-hardening and code-review-and-quality. The user's focused-only verification restriction overrides the TDD skill's full-suite instruction.

## 1. Proactive follow-ups were unreachable

### Reproduction before the fix

The test calls the real trigger twice, first with a long idle interval, then with active input. With one unanswered message and a day-long absence, the emitted `back_from_away` candidate scored **82**. Changing the old assertion to require eligibility failed with:

```text
AssertionError: expected 82 to be greater than or equal to 85
```

A second reproduction uses an eight-hour absence, a previous proactive message 24 hours earlier, and a different previous scene. It passes the generated candidate to the real `canStartProactiveGeneration`. The expected allowed decision failed with the actual decision:

```json
{"allowed":false,"reason":"followup_score_too_low"}
```

These are assertion failures against unchanged production code, after resolving the runner-only environment failures described below.

### Intent and root cause

Inspected `proactive-policy.ts`, `proactive-trigger.ts`, `proactive-service.ts`, `proactive-prompt.ts`, their tests, and the trigger wiring in `proactive-lifecycle.ts`. Searches of `docs/`, its plan directories, repository READMEs and Markdown filenames found no dedicated proactive README or proactive design/implementation plan in this checkout. The documentation hits concern unrelated validation/background suppression; they do not specify a different scoring contract.

The implementation provides affirmative evidence that a follow-up is intended:

- `FOLLOWUP_MIN_SCORE` is 85, with a six-hour interval and a different-scene requirement.
- Policy blocks two unanswered messages, while explicitly permitting a qualifying second message.
- The follow-up prompt says this is the last proactive opportunity when the user has not replied.
- The service tests exercise a qualifying second delivery and reject a third; these tests previously supplied scores directly rather than obtaining them from the trigger.

The trigger's documented additive scoring disagreed with that path. Maximum scores, including the maximum 12-point silence reward and the currently zero freshness reward, are:

| Scene | Maximum before unanswered penalty | Old score with one unanswered message | Fixed score |
| --- | ---: | ---: | ---: |
| `morning_greeting` | 52 + 15 + 12 = 79 | 61 | 64 |
| `evening_checkin` | 44 + 15 + 12 = 71 | 53 | 56 |
| `back_from_away` | 68 + 20 + 12 = 100 | 82 | 85 |
| `work_break` | 56 + 20 + 12 = 88 | 70 | 73 |

The single-unanswered penalty was explicitly documented as 18, so the contradiction is between two explicit pieces of code, not a missing feature inferred from a test alone. The never-allow-a-second-message outcome contradicts policy, prompt and service behavior. Treating the 85-point hard gate as authoritative, **15 is the largest penalty compatible with the current maximum score**. This is a conservative consistency repair inferred from those constraints; no document was found prescribing 15 independently.

### Minimal fix and tests

Changed only the one-unanswered penalty from `-18` to `-15` and updated its explanatory comment. Base scores, urgency, silence, ranking, weather placeholders, the evaluation floor and all policy gates are unchanged. A high-urgency return can now reach exactly 85; lower-urgency returns and greetings are still insufficient. Two unanswered messages still receive a 100-point penalty and remain hard-blocked by policy.

Changes to our tests:

1. Replaced the assertion named `cannot make the final followup eligible even after a day away`. Its `< 85` expectation pinned this bug; it now requires the generated score to reach the unchanged follow-up threshold. This was observed red before editing production code.
2. Added real trigger-to-policy cases: a four-hour absence scores 81 and remains denied; an eight-hour absence scores 85 and is allowed after the other gates have elapsed. Both assert the exact generated candidate and policy decision.
3. Renamed the sampled-scenes test to identify its **low-urgency** inputs. Its existing score and denial assertions are unchanged: those sampled opportunities should still be rejected. It never represented the strongest possible return.

Existing policy tests still require the six-hour boundary, different scene, exact 85-point threshold, runtime gates and rejection after two unanswered messages. Existing service tests still require rejection of a third unanswered delivery. No assertion pinning correct behavior was weakened.

### Decisions left to the product owner

No decision blocks this repair. Broader scoring calibration remains a product choice: whether weaker returns, work breaks or greetings should ever qualify for follow-up, and whether future weather signals should contribute freshness. This patch deliberately retains their existing formulas and all hard gates. It does not guarantee delivery: the model may choose silence, and runtime/delivery gates still apply.

## 2. Obsidian sections used heading objects from different extractions

### Reproduction before the fix

New tests use the real workspace service and temporary Markdown files, without mocking the parser or filesystem. The fixture contains a preamble, a parent heading, the selected `Schedule` section, its `Equipment` child, and a `Results` sibling.

- Reading without children returned an empty string and the hash of the empty string.
- Reading with children threw `TypeError: Cannot read properties of undefined (reading 'level')` in `sectionEnd`.
- Replacing without children duplicated earlier document content instead of removing the selected section.
- Replacing with children, appending to a section, and reading the last section also threw at `anchor.level`.

All six cases failed against unchanged production code. Missing-heading and duplicate-heading tests already passed and were retained as guards.

### Intent and root cause

The public service and `obsidian-tools.ts` expose section reading, replacement and append, with explicit child-section semantics. `sectionEnd` documents stopping at the next heading when excluding children, or the next heading of equal or shallower depth when including them. Its old comment identified the extraction problem as a known issue awaiting a separate fix; it did not establish empty reads or exceptions as intended product behavior.

Each Markdown operation extracted `headings`, then called `locateHeadingPath(content, ...)`, which extracted new objects. The located heading was therefore absent by identity from the first array. `headings.indexOf(first)` returned `-1`. Without children, the end position became the first heading's offset; with children, `headings[-1]` became the undefined anchor.

### Minimal fix and tests

`locateHeadingPath` now accepts the already extracted heading array. Reading, replacing and appending each pass their own array, so the matched heading and boundary calculation share one extraction. Removed the obsolete known-bug comment and documented that invariant. No public signature or workspace-service behavior outside section boundary calculation changed.

Added eight service-level cases covering:

- Reading with and without descendants, exact section text, depth and section-content hash, with the original file unchanged.
- Replacement with and without descendants, exact whole-file bytes, preservation of prefix/sibling content, resulting file hash and byte count.
- Append after descendants and before the next sibling, with exact resulting bytes and metadata.
- The final section extending to EOF without a terminal newline.
- Missing and ambiguous paths across read, replace and append, retaining the structured errors and original bytes.

There were no existing Obsidian tests asserting empty successful reads or cross-extraction exceptions to update. Existing optimistic-concurrency, required-hash and private-directory tests remain unchanged and pass. The fix removes one redundant extraction per section operation and adds no new I/O or permission bypass.

### Decisions left to the product owner

No decision blocks this identity fix. Existing ATX-heading parsing, inclusion of the selected heading line, replacement-content/newline conventions and default exclusion of child sections are preserved. Supporting other Markdown heading syntaxes or changing these semantics would be separate work. `readSection` continues to return a hash of the selected section; writes continue to require the whole-file digest obtained through `readFile`, as the edit tool instructs. This patch does not redesign that API contract.

## Verification and environment limits

| Check | Result |
| --- | --- |
| Red: two changed test files, before either production fix | **8 failed, 50 passed**: 2 proactive failures and 6 Obsidian failures for the reported causes |
| Green: same two files | **58 passed**, 2 files, exit 0 |
| `npx tsc -p tsconfig.main.json --noEmit` | **Passed**, exit 0 |
| Exact `npx vitest run src/main/proactive src/main/knowledge` with repository config | **Blocked by sandbox**: 14 failed suites during import, no executed test cases, native `realpath` EPERM |
| Same focused filters with isolated sandbox workaround | **164 passed**, 14 files, exit 0; no skipped cases or unhandled errors |
| `git diff --check` | **Passed** |
| Diff of the user-listed pinned paths | **Empty** |

The default runner first failed in the archive reporter while renaming a file under the sandbox-provided Windows temporary directory. Redirecting report output into the workspace exposed a second restriction: `fs.realpathSync.native` returns EPERM for source paths, while regular `fs.realpathSync` succeeds. With that bypassed, Vitest's temporary transform-file renames also needed a workspace-local TEMP/TMP directory. These startup/import failures are not the bug reproductions and are not counted as passing tests.

Verification used a temporary, untracked configuration under `audit/` that merged the existing repository config, changing only resolution and cache location:

```js
import { mergeConfig } from "vitest/config";
import original from "../vitest.config.ts";
export default mergeConfig(original, {
  resolve: { preserveSymlinks: true },
  cacheDir: "audit/proactive-obsidian-vite-cache",
});
```

The successful focused command was:

```powershell
$env:FIREFLY_TEST_REPORT_ROOT = Join-Path (Get-Location).Path 'audit/proactive-obsidian-tests'
$env:TEMP = Join-Path (Get-Location).Path 'audit/proactive-obsidian-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
npx vitest run src/main/proactive src/main/knowledge --config audit/proactive-obsidian-vitest.config.mjs --configLoader native
```

For the red and initial green runs, substitute the two explicit changed test-file paths for the directory filters. The override retained the repository's reporter, includes, single-worker settings, timeouts, disabled cache/watch and serial file execution. The native config loader emitted a `MODULE_TYPELESS_PACKAGE_JSON` warning; package metadata was not changed to silence it. No workaround was added to tracked project configuration. Temporary verification files remain untracked under `audit/`: automatic approval review rejected the scoped cleanup command as "blocked by policy" without providing a more specific reason. The rejection occurred before the command executed.

Recorded evidence under `audit/proactive-obsidian-tests/`:

- Red: `2026-10-20T14-20-27-541Z-a4abfc81-4425-4a0c-8336-2d7ac75c9e7d/report.json`.
- Initial green: `2026-10-20T14-21-07-583Z-a8b73d5f-55ef-46ee-9800-f69390af7039/report.json`.
- Focused green: `2026-10-20T14-21-49-883Z-ef9b98cc-b82d-4cd4-b1af-b148f5b41706/report.json`.
- Default-command environment failure: `2026-10-20T14-22-20-500Z-95e0d551-02f6-498e-b9ee-76579e8498b4/report.json`; console output is in `audit/proactive-obsidian-default-vitest.log`.

The final scoped review checked the production diff and test assertions for correctness, boundary handling, retained concurrency/path protections, readability and duplicate work. No remaining blocking finding was identified. This is an inline review, not an independent review or a general security audit. The main type-check configuration excludes test files; Vitest executed the tests. Full-suite, Electron/UI, real model/channel delivery, build and packaging verification were not run under the user's resource restriction. Changes remain uncommitted.
