# Natural memory phase 2 validation — 2026-10-18

Status: implementation, actual Electron closure and final full suite pass. SDK build/package verification remains blocked by automatic approval review; no all-checks-green claim is made.

## Scope and baseline

The task-owned worktree is `E:/Codex/2026-10-17/task/firefly-memory-phase2`, branch `codex/memory-phase2-post-ui-20261018`. The merged mini baseline is `9f94f79b8ad12777d23bf432fe0f8f33bc99c4fc` (PR112), verified on resume. Nine task commits were replayed with an equal range-diff; the original branch `codex/memory-phase2-mini-20261017` remains at `8c7c0891`. Earlier dirty drafts and hashes remain in `.verification/resume-20261018-ab7bd9d3`.

The frozen product, tests and Electron acceptance script are commit `cafd21197838f843fe9f783ab4e2e5ba33e2c8c8`. Any later validation-only commit is identified separately; it must not change product/test code. The user switched the continuation to `gpt-6-astra / medium`; the narrow final reviewer was explicitly dispatched with that configuration. Earlier full reviews used the previously requested `gpt-6.1-sol / max`.

Phase 2 adds bounded recoverable extraction and default-off, separately consented automatic ADD/support for durable positive language (zh/en) and response style (concise/detailed) statements. The host and program whitelist authorize these operations; model confidence does not. Other low-sensitivity classes and conflicting, negative or ineligible statements remain candidates requiring confirmation. There is no automatic correction/deletion, historical shadow backfill, vector database, graph, Learn/Code experience library or complex temporal query expansion.

Existing SQLite, encrypted source ledger, immutable facts, command receipts, single writer and suppression are reused. New journal/profile/consent records are versioned in existing tables, with no DDL migration. Unknown sends are never resent; saved results apply locally without a model call. Current source, generation, scope, consent and profile are rechecked at coordinated dispatch/application. Estimated resource budgets are conservative bounds, not provider billing measurements.

## Actual Electron closure

Command: `node .verification/run-isolated.cjs final-electron-closure scripts/verify/natural-memory-phase2-electron.cjs`.

Frozen evidence: `.verification/electron-phase2-1792288807005-a31c25b9/result.json`; request bodies, process log and three settings screenshots are in the same directory. Outer run: `.verification/runs/final-electron-closure-1792288806676-e1ff2f49`.

Exit 0; 28 checkpoint assertions, three actual Electron 43.7.0 process launches and three graceful exits with code 0. This used the real built app, React chat, settings UI, preload, IPC, Main owner, Worker and SQLite with a synthetic profile and intercepted fake provider. External fetch/HTTP/Electron/Chromium network paths were blocked. No user's instance, profile, credentials or database was used.

The observed sequence was:

1. Natural form-of-address statement creates a default-off candidate; UI confirmation activates it.
2. UI opt-in for language creates an automatic `natural-add-v1` zh fact from natural text; response-style remains disabled.
3. Close the owned process/Worker, cold reopen the same private SQLite, submit a new session through the UI, and inspect the actual outgoing chat request: confirmed address and language are selected as user-role sourced data, not system instructions.
4. A different user message supports the same fact without a fact revision; a conflicting English statement remains pending.
5. Disable language; a style statement remains pending. A real temporary chat now completes and the immediate automation-state and extraction-request counts are unchanged.
6. UI correction synchronously changes zh to en at revision 2; a new-session request selects en and omits the old typed zh assertion.
7. UI forget removes both active facts. Close/reopen again; a new-session request contains neither typed assertion, the raw old name, nor its original source phrases.

The temporary Electron count check is an immediate post-turn observation, not an exhaustive delayed-write proof. Complementary owner tests traverse attachment admission and assert zero memory/history commands, no disk transcript, in-memory multi-turn continuity and no cross-session recall. Journal/runner tests cover stale/late result, deletion, consent/profile changes and recovery boundaries independently; the Electron script does not pretend to exercise every fault injection.

## Discovered defect and repair

The previous real Electron failure was `MEMORY_ATTACHMENT_DENIED` before a model request, surfaced by the renderer as `E_HARNESS_FAILURE`. AG-UI asks for an attachment grant on every canonical user turn. The owner rejected all temporary sessions before checking whether the message had any attachment.

The minimal repair moves temporary attachment refusal after the authenticated text-only return. Sender/session binding, live admission equality, exact user turn, role/content and modelContext validation remain before that return. A nonempty temporary attachment list still fails before storage access or capability issuance. No error is swallowed and no target is manually registered.

The actual bridge ordering was added to the temporary-turn test helper. RED evidence `.verification/runs/temporary-admission-red-1792288669292-812b8f15` fails with the expected `MEMORY_ATTACHMENT_DENIED`. GREEN `.verification/runs/temporary-admission-green-1792288697337-80c05fca` passes 204 tests across the real owner and AG-UI suites. A forged temporary attachment still fails, with zero storage commands. Main compilation passes in `temporary-main-build-1792288708732-336e8767`.

## Independent reviews

The initial whole-change review found two Important races: live scope after awaited reads, and live profile before saved-result apply. They were repaired with four scope and three profile RED/GREEN cases. Re-review at `e74f62b9` ran 156 tests and the original adversarial probes: scope denied, or blocked/profile-changed, with no fact. No new actionable finding was confirmed. See the retained phase-2 re-review report.

The final narrow astra/medium review approved the temporary admission repair with no required findings. Its own test rerun failed during collection with sandbox `realpath EPERM`; it inspected the successful author-run RED/GREEN/build/Electron evidence and does not claim an independent execution. This is an environment error, not an automatic approval denial. See the retained temporary-admission review.

Inherited observation H1 remains outside this change: same-document navigation can invalidate the existing active-target registry in a synthetic event probe. It was not shown to cause the actual Electron failure, and the complete actual closure has valid targets. No unrelated React UI/authority repair or manual target bypass was introduced.

## Final results

`node .verification/run-isolated.cjs mini-full scripts/testing/run-tests.mjs --reporter=dot` completed once on frozen `cafd211`: **877 files passed, 1 file skipped; 10,781 tests passed, 11 skipped, 0 failed; exit 0; 878.19 seconds**. Evidence: `.verification/runs/mini-full-1792288802057-7bb7cee8`, including the full machine-readable case report. Its 2,888 tracked source files have identical before/after manifest SHA256 `d0033608cb1958df3324445734432669969baa640b3e6655bc615cecfa785e4f`; `sourceUnchanged: true`.

The 11 inherited skips are five non-Windows-only memory cases and six Windows symlink cases. Four symlink cases explicitly report unavailable privilege; the other two and the five platform cases have no explicit skip reason in the runner report, so they are not relabeled as passing. No test skip/assertion/timeout was weakened by this task. Exact names remain in the archived `report.json`.

All evidence paths and command arguments are retained in each run's `run.json`.

Already completed on the new baseline/frozen repair:

- 273 related tests on e74; 204 owner/AG-UI tests after the temporary fix.
- Full `npm run build` on e74, plus Main recompilation after the only later product edit; renderer typecheck passed. No preload/renderer product changes followed that build. Existing Vite large-chunk warning remains.
- Frozen schema contract check, native helper PE verification, 12 actual native read-only/zero-write cases and 23 evaluation-contract tests pass.
- `git diff --check` passes. No standalone lint script is defined by this repository.

Reproduction commands for final ancillary checks (all invoked with `node .verification/run-isolated.cjs <label> ...`):

| Check | Script/arguments after label | Result / evidence run |
| --- | --- | --- |
| Schema | `scripts/plugin-sdk/generate-schema.mjs --check` | PASS; `final-schema-1792288819795-4e2c2c3c` |
| Native PE | `scripts/verify/history-helpers.mjs` | PASS; `final-native-pe-1792288820817-9d76760b` |
| Native zero-write | `node_modules/vitest/vitest.mjs run --config scripts/testing/vitest.memory-history-zero-write.config.ts` (label `native-zero-write`) | 12 PASS; `native-zero-write-1792288833574-4eff0c9a` |
| Eval contracts | `E:/Node.js/node_modules/npm/bin/npm-cli.js run test:eval` | 23 PASS; `final-eval-contracts-1792288821173-475095c0` |
| Main compilation | `node_modules/typescript/bin/tsc -p tsconfig.main.json` | PASS; `temporary-main-build-1792288708732-336e8767` |

## Changed files

- Journal and policy: `natural-job-repository.ts`, `natural-automation.ts`, `natural-extraction-runner.ts`, `natural-protocol.ts`, `policy-repository.ts`, `main-policy.ts`, with behavioral tests.
- Transport and ownership: `shadow-model-call.ts`, transport limits tests, `main-default-memory.ts` and owner tests, composition wiring. The final temporary fix only changes the ordering of the no-attachment return and temporary attachment denial.
- Explicit consent UI: separate automation settings IPC/contracts/preload, two small settings controls and zh/en text, with IPC/panel tests.
- Previously authorized follow-ups: typed edit parsing in the existing memory panel and finite no-tool error metadata in FireflyAgent, with integration coverage.
- Acceptance, plans and these validation/review reports. The exact list is `git diff --name-only 9f94f79b HEAD`; no dependency/lockfile/native helper/React chat files were changed.

The first direct SDK verifier attempt failed because `packages/plugin-sdk/dist` had not been built. It is not counted as a product regression or passing SDK check. The subsequent `npm run check:plugin-sdk` request was rejected by automatic approval review before process creation: the reviewer considered its build/package verification artifacts incompatible with the explicit no packaging/install boundary, including the claimed dry-run. No retry or alternate entry point was used. A separate authorization question is pending; without it this check remains blocked, not passed. The earlier direct verifier's dry-run emitted a package manifest but created no tarball or installation.

## Boundaries and remaining limitations

No push, PR creation/comment/merge, deployment, app packaging/install, real provider/counting call, dependency reinstall or user database migration occurred. Offline numerical vector evaluation remains unavailable because local `models/Xenova/bge-m3` is absent; no model download was performed. Evaluation contracts passing is not a numerical retrieval benchmark.

The SDK example workflow runs `npm pack` and installs its tarball into a temporary project; it is not executed under the explicit no packaging/install boundary. Live provider transport, billing and credentials have not been accepted. Future provider acceptance requires separate authorization.

The user deferred per-feature memory attribution. Existing aggregate usage callbacks and the new upstream usage wrapper are preserved; this task adds no independent attribution feature. Only the two necessary memory controls were added to settings. There is no task diff under `src/renderer/react`.

Read-only protected-tree comparison found the user's chat-ux tree had independently advanced from e6657aae to 9f94f79b with five modified React workspace/chat files; those files were not touched by this task. Preview remains clean at 9f94f79b, and the earlier memory PR tree remains clean at 28eb55d9. Both snapshots are retained, so concurrent human changes are not mislabeled as unchanged.

## Rollback and follow-up

For an eventual deployed build, first turn both automation controls off and close the owning process so its work drains. Preserve the database and matching encryption material before changing versions. Code can then be returned to the previously deployed mini build; no schema downgrade is required. Do not delete receipts, suppression tombstones or unknown-send records to force retries. Code rollback does not erase already accepted facts: use the normal synchronous forget action if that is desired. No real-user rollback or database modification was executed or claimed here.

The task's old branch, original snapshots and local commits remain recoverable. Discarding this isolated checkout is unnecessary; nothing was published. Complex temporal reasoning, hybrid/vector retrieval, Work/Code experience and per-feature attribution remain separate follow-up work.
