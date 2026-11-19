# Sandbox cwd, filesystem containment, and patch Move to fixes

Date: 2026-10-20. Worktree: `E:\Codex\Firefly_Agent-secb`, branch `codex/sec-fix-b`, baseline `7f9ebdfb4491fd90d444bbe7ea8669326a66e9f9` (HEAD versus uncommitted changes; no target branch or merge operation).

The scoped fixes for findings 2, 3, and the patch-move portion of 7 are implemented. Existing partial production changes were reviewed and retained, with regression coverage completed in this restarted run. Type checking passes. Eight focused test files have **164 passing tests and 14 skips**, using the runner adaptation described below. Actual junction creation and real SRT enforcement remain unverified in this restricted host.

## Finding 2 — Model cwd selected the sandbox authorization root (P1)

**Root cause.** `run_shell` forwarded model-controlled cwd without binding it to the session workspace. Sandbox initialization then derived scoped write access from cwd, or searched cwd's ancestors for a project root in project-read-only mode. A successful initialization could therefore authorize a different directory, including a Startup directory, rather than the Main-owned workspace.

**Fix.** [run-shell-tool.ts](../../src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts) now resolves cwd against `context.resolvedWorkspaceRoot`, rejects lexical and canonical escapes before interpreter resolution/wrapping/spawn, and uses the canonical contained directory for process construction. Omitted cwd uses the bound workspace; relative subdirectories resolve within it. Legacy calls without a bound workspace use Main's `process.cwd()` as the root, never model cwd. Checks run again after awaited preparation and before foreground/background execution. The internal execution-plan function requires a workspace-root argument.

[sandbox-exec.ts](../../src/main/orchestrator/sandbox/sandbox-exec.ts) accepts the trusted canonical workspace root separately from execution cwd and uses it for configuration and the sandbox session key. Project detection cannot enlarge an explicitly supplied root. The optional argument preserves legacy sandbox API callers; the sole production wrapping caller is `run_shell`, which always supplies the checked root. Approval decisions, permission levels, and existing fail-closed behavior are unchanged.

**Regression tests.** Additions to [run-shell-plan-boundary.test.ts](../../src/main/orchestrator/tools/builtin-tools/run-shell-plan-boundary.test.ts) check outside cwd for scoped/project-read-only modes (full and allow_all have no sandbox and keep an explicit cwd unchanged), foreground and background rejection before execution, controlled junction-target escapes, cwd changes during interpreter resolution and wrapping, workspace-default and relative cwd, and internal canonical cwd. Legal cases inspect the trusted root passed to wrapping and actual process/background specifications; foreground cases write and read temporary marker files. Real junction cases are also present but skipped by this host. [sandbox-exec.test.ts](../../src/main/orchestrator/sandbox/sandbox-exec.test.ts) checks scoped and project-read-only grants against the bound root even when an ancestor has a project marker. SRT initialization is mocked, not a live sandbox installation test.

## Finding 3 — Lexical containment allowed junction/symlink escapes (P1)

**Root cause.** Prefix/relative-path checks did not inspect filesystem targets. Existing linked ancestors could redirect an otherwise valid workspace path outside it, including paths whose final file did not exist yet.

**Fix.** The new [path-containment.ts](../../src/main/orchestrator/tools/path-containment.ts) requires lexical containment, resolves the trusted root, and checks every existing target-path component with `lstatSync` and `realpathSync`. Every resolved component must remain beneath the real root. Missing suffixes are appended only after a contained existing ancestor is established. Dangling links, loops, inspection failures, and other resolution errors fail closed. Internal links and a trusted workspace root that is itself a link remain supported.

[apply-patch-tools.ts](../../src/main/orchestrator/tools/apply-patch-tools.ts) uses this helper for add/update/delete sources and Move to destinations during whole-patch prevalidation, and checks again before executing each hunk. It retains lexical operation paths so deleting a permitted internal symlink keeps existing unlink semantics and write-evidence paths. [document-tools.ts](../../src/main/orchestrator/tools/document-tools.ts) returns the helper's canonical output path for Excel, Word, and PDF, under the workspace or the existing desktop fallback. Shell uses the same helper as described above.

**Regression tests.** New [path-containment.test.ts](../../src/main/orchestrator/tools/path-containment.test.ts) covers traversal/prefix collisions, outside ancestors, an outside ancestor followed by a return inside, final-file links, missing suffixes, internal links, linked roots, dangling links, loops, and denied inspection/resolution. Additions to [apply-patch-tools.test.ts](../../src/main/orchestrator/tools/apply-patch-tools.test.ts) cover each operation through an outside ancestor and verify that whole-patch prevalidation leaves earlier safe hunks and source contents unchanged. Document tests exercise all three writers with workspace and desktop roots and nested missing suffixes, plus successful canonical Word output. Controlled filesystem resolution tests execute here; separate actual junction tests remain available for an unrestricted Windows runner.

## Finding 7 — Patch Move to silently replaced a destination (P2; scoped portion)

**Root cause.** Destination containment was checked, but destination existence was not. Writing the edited source followed by `renameSync` could replace an existing unmatched destination.

**Fix.** `apply-patch-tools.ts` rejects existing destinations during prevalidation and immediately before the hunk. For a new destination it uses `copyFileSync(..., COPYFILE_EXCL)`, writes the matched post-image there, then unlinks the source only after the destination write succeeds. A destination appearing at exclusive creation causes failure without changing the source or replacing that destination. The source is no longer edited before a failed move.

**Regression tests.** Patch tests cover an existing destination (including no earlier safe-hunk mutation), a destination created by an earlier hunk, a collision injected precisely at exclusive creation, and a successful move with edited contents, a newly created parent directory, and preserved CRLF. Existing patch matching, evidence, and partial-write tests also pass.

## Verification and runner limitations

Project declarations: Node `>=24 <25`, Electron `43.7.0`, TypeScript `^5.6.0`, Vitest `^4.1.9`. Observed runner: Node `24.19.0`, Vitest `4.1.11`. No dependency or configuration changes were made.

- `npx tsc -p tsconfig.main.json --noEmit`: exit 0, including a final run after production edits and diagnostic restoration.
- `git diff --check`: exit 0.
- Focused Vitest batches (all exit 0 with the adaptation below):

| Files passed to `npx vitest run` (paths under `src/main/orchestrator/`) | Passed | Skipped |
| --- | ---: | ---: |
| `tools/path-containment.test.ts`, `tools/apply-patch-tools.test.ts` | 42 | 6 |
| `tools/document-tools.test.ts`, `tools/builtin-tools/run-shell-plan-boundary.test.ts` | 47 | 8 |
| `sandbox/sandbox-exec.test.ts`, `tools/builtin-tools/run-shell-fail-closed.test.ts` | 42 | 0 |
| `tools/builtin-tools/run-shell-outcomes.test.ts`, `tools/builtin-tools/run-shell-edges.test.ts` | 33 | 0 |
| **Total** | **164** | **14** |

Thirteen skips are new actual-junction cases: creation returns EPERM. One is the pre-existing non-Windows symlink-unlink evidence case. These skips do not establish real junction behavior. Non-skipping controlled realpath tests cover the security checks and positive internal-link resolution at helper and tool boundaries. Existing cancellation, approval/plan guards, shell outcomes, failure-closed handling, and legitimate document writes also passed.

The initial normal invocation stopped in the archive reporter while renaming its report in the system temporary directory. With TEMP/TMP and `FIREFLY_TEST_REPORT_ROOT` directed into the ignored worktree-local `.tmp-security-review`, the runner then failed before test collection because Vite's native realpath returned EPERM on source files. The same pre-collection realpath failure was reproduced in the base worktree `E:\Codex\Firefly_Agent-names` using its existing `apply-patch-tools.test.ts`; it is not attributed to this change.

A temporary, ignored test-process preload at `.tmp-security-review/realpath-fallback.cjs` retries only native-realpath EPERM using Node's ordinary `fs.realpathSync`, which a direct probe confirmed works here. It performs actual filesystem resolution; it does not replace the product helper or modify dependencies. Successful batches used:

```powershell
$env:TEMP = Join-Path (Get-Location) '.tmp-security-review'
$env:TMP = $env:TEMP
$env:FIREFLY_TEST_REPORT_ROOT = Join-Path $env:TEMP 'reports'
$env:NODE_OPTIONS = '--require=E:\Codex\Firefly_Agent-secb\.tmp-security-review\realpath-fallback.cjs'
# Run each pair of test files from the table separately with npx vitest run.
```

The unadapted Vitest command is therefore not reported as passing. No whole-orchestrator, whole-skills, coverage, packaging, or Electron UI run was attempted, following the restarted request's focused-test/resource limit. Reports and diagnostic logs are retained under the ignored `.tmp-security-review` directory.

Diagnostic RED evidence is in `.tmp-security-review/red-probes.log`: temporarily weakening containment to lexical checks fails seven patch/document assertions and two shell assertions; removing exclusive creation fails the collision test; restoring cwd-derived sandbox roots fails both root-grant tests. These are deliberate weakened variants, not executions of the exact baseline revision. Each probe restored production sources in `finally`; subsequent full focused batches passed. The exact baseline defects were additionally traced through read-only HEAD diff/blame, without changing git state.

## Scope, review, and remaining work

- Reviewed the five production files, their five changed/new test files, immediate sandbox/execution/write-evidence callers, and HEAD history. The security boundary is model arguments crossing into Main-owned path authority. The original patch lexical guard and sandbox cwd derivation trace to `f1f657954`; no approval checks were removed. Direct production blast radius: three modules import the new helper; document output resolution serves three writer entry points; patch containment serves source/destination validation and execution; sandbox wrapping has one production caller. This was a focused high-risk diff review, not a repository-wide audit. No additional blocking issue was found in the requested scope.
- All 55 tracked pinned files (`permission.ts`, `permission-policy.ts`, `permission/bootstrap.ts`, `plugin-marketplace.ts`, and `browser/*`) have no HEAD diff; a current SHA-256 inventory is retained at `.tmp-security-review/pinned-files-sha256.json`. The supplied pin values were not provided, so this is not a comparison against an external pin manifest. No pinned file, approval/permission model, dependency, lockfile, CI policy, or check threshold was edited.
- `fetch-url-tool.ts` and `download-file-tool.ts` were not edited and have no HEAD diff. Download containment and download overwrite behavior belong to the other agent and remain outside this report's completion claim.
- The stray `root.txt` was deleted. No `*.snap` changed, so the requested snapshot-only checkout exception was unnecessary. No state-changing git command, commit, push, or new worktree was used. The existing `node_modules` junction was not modified.
- Remaining acceptance: run the actual-junction cases and real SRT enforcement on a Windows host that permits them. The current test evidence verifies application argument/configuration boundaries with mocks, not kernel sandbox enforcement.
- Realpath checking does not lock ancestors against an external process swapping them between validation and I/O. This fix closes the reported pre-existing-link attack; descriptor-relative/no-follow filesystem enforcement against active races would require a broader platform implementation. No permission-model change was needed or made.
- Exclusive copy/write/unlink is not an atomic rename: if a later write or unlink fails, it can leave a new partial/complete destination while retaining the original source. Existing write-evidence/error handling records partial effects; pre-existing destination contents are protected. Atomic multi-file rollback and preservation of rename inode/link identity are not claimed.
- The installed skill catalog did not expose the requested Superpowers names. Repository adaptations for using-superpowers, systematic-debugging, and verification-before-completion were located and read; the repository's ECC TDD workflow supplied the available RED/GREEN guidance. No claim is made that the unavailable exact `superpowers:test-driven-development` skill was invoked. Existing task scope and checks took precedence over generic skill suggestions for commits or expanded testing.

Implementation references: Node 24 documents canonical resolution in [realpathSync](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsrealpathsyncpath-options), destination exclusion in [copyFileSync](https://nodejs.org/docs/latest-v24.x/api/fs.html#fscopyfilesyncsrc-dest-mode), and replacement behavior in [rename](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsrenameoldpath-newpath-callback).
