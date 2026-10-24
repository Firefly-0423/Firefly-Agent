# Finding 8: direct Windows shell descendant lifetime

Review base: `7f9ebdfb4491fd90d444bbe7ea8669326a66e9f9`, branch `codex/sec-c8`.
Scope: uncommitted changes to `shell-job-manager.ts`, the adjacent Windows process supervisor, and adjacent tests. No commit or push.

## Root cause and fix

**P2, finding 8.** The original manager considered immediate-process `close` to mean completion, cleared the deadline, and stopped cleaning up terminal jobs. Windows `taskkill /T` addressed the original PID; once an intermediate process exited, that PID tree could not reliably identify surviving detached descendants. Holding the execution permit until that same `close` did not fix the missing ownership.

- `src/main/orchestrator/tools/builtin-tools/windows-shell-job.ts`: introduce a supervisor for direct Windows background jobs. It creates a non-inheritable Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, without breakaway permission. `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns the target at process creation, before its first instruction; this also avoids the create-suspended/assign crash gap. Only stdin/stdout/stderr handles are inherited.
- The supervisor waits for the root process to exit, terminates remaining job members, and polls job accounting until no processes remain before exiting with the root exit code. This works even when descendants disconnect stdio, inherit stdio, detach, or survive an intermediate parent's exit.
- Main retains the supervisor's input pipe. Stop, deadline, output limit, cancellation and shutdown close that pipe; EOF causes job termination. Main losing the pipe also requests cleanup; forced supervisor death closes the sole job handle. The command itself still receives EOF stdin through NUL.
- `src/main/orchestrator/tools/builtin-tools/shell-job-manager.ts`: use the supervisor only for direct Windows jobs. Existing immutable terminal states and log-flush completion remain intact. `completion`/`processSettled` now follow supervisor close, after descendant cleanup. Late stop on an exited job needs no PID kill because its job is already empty. Other `killTree` callers retain their existing implementation.
- Preserve argument quoting, cmd verbatim arguments, the exact absolute executable, cwd, the supplied environment, raw output bytes, nonzero exit codes and `spawn_error` classification. Command data travels as base64 JSON on a private pipe, never as interpolated PowerShell/C# source. Reject NUL before native command-line truncation can occur.

The snapshot PID for these jobs identifies the supervisor. The supervisor uses Windows PowerShell/.NET `Add-Type`; this adds approximately one second of startup in these tests. Systems that prohibit this facility fail startup rather than fall back to an uncontained process. No dependency or packaging configuration was changed.

Windows references: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [atomic job assignment rationale](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/).

## Regression tests and fresh verification

- Preserved the pre-existing untracked `shell-job-descendants.test.ts`: six real Windows tests cover natural completion with inherited/disconnected output, an exited intermediate parent, deadline, stop, owned cancellation and shutdown.
- Added `windows-shell-job.test.ts`: ten real Windows cases cover argv/cwd/environment/stdin/raw output/nonzero exit, cmd syntax, an executable path containing spaces with a competing prefix executable, spawn failures, two NUL rejection cases, root exit, supervisor death, control EOF, and output-limit cleanup.
- Existing `shell-job.test.ts`: all sixteen cases pass. **All 32 related tests pass in the required full run.**
- Regression sensitivity: temporarily restored the original manager from `git show HEAD:<path>` without changing the index; both natural-completion descendant cases failed their liveness checks. Restored the fixed source in `finally`. The RED run additionally encountered sandbox cleanup permission/time-limit errors; the fixed implementation passes the same real-process cases. New NUL cases were also observed failing before input validation was added.
- `npx tsc -p tsconfig.main.json --noEmit`: exit 0, including a final run after the final source changes.
- `npx vitest run src/main/orchestrator src/main/skills`: exit 1; **203 files passed, 15 failed; 2936 cases passed, 240 failed, 2 skipped; zero unhandled errors**.
- Same command on `E:\Codex\Firefly_Agent-names`: **193 files passed, 23 failed; 2874 cases passed, 286 failed, 2 skipped; zero unhandled errors**. Every current failing case also failed on the base worktree, matched by relative file and full test name. **Zero new failing cases.** These runs are not represented as a green full suite.

Both runs used the existing `.verification/realpath-fallback.cjs` as an absolute `NODE_OPTIONS` preload and workspace-local TEMP/TMP/report directories. Relative preload paths break child-process startup when fixtures change cwd. These are test-process settings, not product or dependency changes.

Evidence: `.verification/c8-tsc.log`, `.verification/c8-vitest.log`, `.verification/c8-base-vitest.log`, `.verification/c8-red.log`, and `.verification/c8-test-comparison.json`. The comparison JSON lists every shared failing test by name and all related test outcomes. Full-run archives:

- Current: `.verification/reports/2026-10-20T13-01-03-237Z-1a894dde-aa6f-4c39-985d-d390b64f82ac/report.json`.
- Base: `.verification/base-reports/2026-10-20T12-54-28-486Z-ba6a5783-6c85-4e37-b1cd-b9c979102eee/report.json`.

Remaining failing files, all reproduced on the base:

| File under `src/main/` | Failed cases |
| --- | ---: |
| orchestrator/parallel-roles-integration.test.ts | 7 |
| orchestrator/specialist-twelve-delegation.test.ts | 1 |
| orchestrator/harness/execution-coordinator.test.ts | 2 |
| orchestrator/harness/write-ownership.test.ts | 3 |
| orchestrator/tools/built-in-tools-shell.test.ts | 2 |
| skills/directory-install.test.ts | 2 |
| skills/external-enable.test.ts | 11 |
| skills/external-install.test.ts | 20 |
| skills/external-integration.test.ts | 5 |
| skills/external-revisions.test.ts | 2 |
| skills/external-scan.test.ts | 16 |
| skills/external-service.test.ts | 21 |
| skills/external-state.test.ts | 51 |
| skills/self-improvement-source.test.ts | 1 |

## Focused security and quality review

Reviewed both production files and both regression files against HEAD, including untracked files. No new high/critical security defect was found in the reviewed paths. Trust boundaries checked: model command to native argv, environment transport, control pipe ownership, inheritable handles, job creation/closure, PID reuse, and completion before execution-permit release. Existing approval and ownership checks are unchanged.

History: the original spawn/close logic traces to `f1f657954`; retained-completion and scoped cancellation trace to `38d60b578`. Those completion and cancellation contracts were retained. Production blast radius: one caller of `startShellJob` (the background branch of `run-shell-tool.ts`); `killTree` has four internal lifecycle call sites and one foreground caller, whose unmanaged fallback is unchanged. `disposeAllShellJobs` remains connected to the existing app lifecycle hook.

`git diff --check` passes. SHA-256 checks cover all 55 specified permission/marketplace/browser files: zero changes. No writes to `node_modules`, permission-model changes, CI changes, or changes to `run-shell-tool.ts`/fetch/download tools were made.

## Boundaries and unfinished validation

- The foreground implementation in the explicitly excluded `run-shell-tool.ts` and the SRT path remain unchanged. This patch establishes containment for direct Windows jobs created by `startShellJob`; it does not claim new foreground or SRT containment.
- Real Windows processes were tested. A packaged Electron application quit/crash, SRT descendant containment, and non-Windows runtime behavior were not exercised. Unix behavior was left unchanged.
- Baseline failures above were left outside this focused fix. The full suite remains red for those cases.
- The test rewrote `src/main/orchestrator/tools/__snapshots__/built-in-tools.snapshot.test.ts.snap`. The requested `git checkout -- <file>` was attempted but denied because `.git/worktrees/.../index.lock` is not writable. Restored the original bytes using read-only `git show HEAD:<file>` instead. Its blob hash matches HEAD (`baddd08aa3d3f0eb566bfacc2d04c1a68308e552`) and `git diff --exit-code HEAD -- <file>` passes. `git status` still reports its cached modified entry in this read-only-index environment; no snapshot content change remains.

Review recommendation: the scoped finding is fixed with verified Windows regressions; accept with the explicit full-suite baseline failures and runtime-validation boundaries above.
