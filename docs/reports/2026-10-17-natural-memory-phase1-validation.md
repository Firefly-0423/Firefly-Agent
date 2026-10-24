> Historical snapshot: this file records its original phase1 baseline and acceptance time. For the user-selected mini target and final post-review source, see [fresh mini validation](../reports/2026-10-17-memory-token-mini-validation.md). Do not substitute its earlier counts or limits for current mini evidence.

# Phase 1 natural user memory — validation and delivery

**Result:** implementation and locked-environment acceptance passed. The final complete suite finished at 08:31:50 UTC: **10,392 passed, 11 existing platform skips, zero failed/unhandled errors**, exit 0. The real closure checks actual outgoing canonical/provider requests after confirmation and reopening; this is not a database-write-only acceptance. No real provider or Electron/UI run is claimed.

## Provenance and scope

- Repository: `https://github.com/Serendipity-wu02/Firefly_Agent.git`.
- Worktree: `E:\Codex\2026-10-17\task\firefly-memory-phase1`.
- Branch: `codex/natural-memory-phase1-20261017`.
- Implementation baseline: **0539f72a5888d1453227d3f3eabef410e23fbc58**, verified against the remote `codex/inspector-cards` branch at task discovery. Both 36ade022 and research c77e094 are ancestors; implementation did not mix their files.
- The user's `Firefly_Agent-chat-ux` checkout and ongoing renderer changes were not edited, switched or reset. At 08:23 UTC its owner had advanced HEAD to `3a8bda592cc9b1f4d36493a1b63a79282c03ced6`, with three modified renderer files and one new renderer test still present. This implementation remains pinned to its verified 0539 baseline and does not mix in that later UI work. No renderer files, Android files, dependency manifests/lockfiles, CI files or real user databases are changed by this branch.
- Model cache advertises `gpt-6.1-sol` with `max`; the independent review explicitly requested and accepted that model/effort. The durable host does not expose this implementation turn's effective sampling metadata. The global `xhigh` default was identified as insufficient evidence of the effective turn configuration; no substitute model or effort was requested. This remains a verification limit.
- No push, PR, merge, Firefly app package/installation, real Electron launch, credential read, paid model call or real external service was performed. Tests use synthetic keys, isolated databases and fake transports. Development dependencies were eventually rebuilt in this isolated worktree with `npm ci --offline --ignore-scripts`; the shared original installation was preserved.

## Implemented behavior

Only user forms of address, language, response style, tools and general low-sensitivity preferences enter the new model path. Existing deterministic remember/change/forget paths remain. Successful persistent desktop Chat turns can request a new bounded extraction using the run's admitted model profile, independently of the old shadow toggle. Results always become review candidates. Old shadow rows are not consumed.

The host assigns scope, actor, source, role, trust, time and generation. Both Main and the SQLite writer validate the source; the writer checks exact source content fingerprints, bounded schema, literal unique evidence span, self-subject, sensitivity, negation and conservative non-fact/context guards. Quoted text, wishes/questions, hypotheses, temporary statements, unsupported contextual claims, assistant/tool sources and model-supplied authority fields are rejected. Project-bound natural proposals are conservatively refused rather than flattened into global facts. No persistent extraction queue is added.

Unknown policy candidates keep an empty body and have no core candidate/evidence. Resolution creates a fresh candidate and evidence in one transaction, links it to the old row and invalidates the old row. Existing same-attribute deterministic revision remains. Confirmations bind ID, revision, content hash, actor and scope, recheck current source/conflict/suppression in the writer transaction, and retain hash/scope in encrypted support audit metadata.

Typed facts distinguish `entityKey`, `slotKey` and `assertionKey`. Existing `subjectKey` remains the legacy-compatible slot alias. Known shell slots preserve old tombstones byte-for-byte; new many-valued identities use a separate NFKC/case/whitespace-normalized `canonicalValue` while retaining display spelling. Opposite polarities cannot add duplicate support to each other. Explicit later deterministic changes produce a new immutable revision and update typed state consistently.

Typed recall no longer depends on re-parsing the old extraction grammar. Selection nominates only fact IDs/revisions; canonical context rechecks current eligibility, revision, source, scope, validity and deletion. Stored memory text is serialized as user-role data behind a fixed system guard, including the controlled runtime port. It grants no tools or instruction authority and cannot override the current request.

Correction and forgetting complete synchronously in SQLite transactions. Core mutation timestamps now use the caller's unified transaction clock. SQLite schema stays at version 10: there is no new DDL, automatic migration, rewriting of old records, vector store or graph. Existing base temporal validation remains; complex temporal queries are excluded.

## Closure evidence

`src/main/memory-policy/natural-memory.test.ts` exercises the real SQLite writer, source registry, policy, selector and canonical context with a fake extraction transport:

1. A natural form-of-address statement initially produces an unknown empty-body record.
2. A new model result resolves it into a different pending candidate with evidence and an explicit replacement link; the old confirmation cannot activate it.
3. Independent confirmation produces an active fact and bound audit proof.
4. The fixture closes the repository and reopens it using the same synthetic database/key.
5. A different session selects the typed fact and its canonical outgoing request includes the expected assertion.
6. Synchronous correction increments the immutable revision and makes the old nominated context invalid.
7. Synchronous forget removes it from subsequent selection and rejects stale nominations and late results. Equivalent Vim/vim/fullwidth identities remain suppressed.

`src/main/memory-context/main-default-memory.test.ts` additionally drives the ordinary desktop Chat owner with the shadow toggle off: natural tool statement → settings confirmation → a different session's actual fake-provider HTTP request contains the fact as user-role data → settings correction → settings forget. The assertion is absent from system messages. Separate runtime and controlled-port tests inspect their actual outgoing requests for the same trust boundary.

Further tests cover all five categories, source mutation during a fake call, stale hash/scope and revision, current-slot conflict, confirmation source validity, confirm/revise and correct/forget ordering, temporary zero-write behavior, malformed/schema/authority input, negative and quoted evidence, deletion suppression, fault injection after record/before receipt, legacy fact readability and unchanged schema 10. Existing core migration rollback tests are retained.

## Changed files

| Area | Files and purpose |
| --- | --- |
| Protocol/identity | `src/main/memory-policy/natural-protocol.ts`, `fact-identity.ts`: schema/evidence checks, typed normalization, legacy-compatible identity and explicit edits. |
| Policy writer/Main | `src/main/memory-policy/policy-repository.ts`, `main-policy.ts`, `fact-supports.ts`, `policy-contracts.ts`, `extractor.ts`: transactional proposals/resolution, bound confirmation, correction/suppression and legacy polarity compatibility. |
| Settings/shared API | `src/main/memory-policy/memory-settings-ipc.ts`, `src/shared/memory-contracts.ts`, `src/shared/memory-panel-contracts.ts`: typed worker data, optional candidate hash DTO and stale-hash rejection. |
| Core/recall | `src/main/memory-core/fact-repository.ts`, `src/main/memory-recall/main-fact-selector.ts`: transaction clock and canonical typed selection. |
| Desktop/context | `src/main/memory-context/main-default-memory.ts`, `main-memory-runtime.ts`, `main-s-runtime-port.ts`, `fact-context-messages.ts`: new Chat extraction lifecycle and untrusted memory data in actual requests. |
| Regression fixtures/tests | `src/main/memory-policy/natural-memory.test.ts`, `memory-settings-ipc.test.ts`; `src/main/memory-context/main-default-memory.test.ts`, `main-memory-runtime.test.ts`, `main-s-current-turn.test.ts`, `smh-integration.test.ts`, `smh-fixture.test-support.ts`. |
| Design/evidence | `docs/plans/2026-10-17-natural-memory-phase1.md`, this report, preserved independent review and `docs/reports/artifacts/2026-10-17-memory-mutation-check.cjs`. |

## Independent review and fixes

The original read-only report is preserved in [2026-10-17-natural-memory-independent-review.md](2026-10-17-natural-memory-independent-review.md). It found **0 Critical, 4 Important** on the pre-fix snapshot. It is not represented as approval of the later code.

| Finding | Regression and resolution |
| --- | --- |
| Vim/vim/fullwidth bypassed suppression | Failing forget-variant tests; canonical identity shared by writes, conflicts, correction and suppression, with separate display spelling. |
| Legacy duplicate support ignored typed polarity | Failing negative-shell → explicit same-value change; fixed both integrate and ingest branches. Added language/style change, opposite-support and repeated-denial cases. |
| Negation omitted no longer/没有 and leaked across clauses | Failing common-negation and mixed-clause tests; expanded independent guard and checked the exact evidence clause. Positive and negative apostrophe cases remain accepted. |
| Single quotes, wishes and questions became facts | Failing ASCII/Unicode quote, wish and question-without-punctuation cases; conservative non-fact guard rejects them. |

The unified fix pass also made confirmation hash/scope durable in support proofs; its new audit assertion failed before that fix. An adjacent repeated-denial case failed before fixing support of an already negative assertion. No test was deleted, skipped or weakened to pass. Two isolated in-memory mutants (remove polarity validation; remove canonical identity normalization) were both rejected by their assertions; production files were not modified by the mutation experiment.

## Verification results

All commands run from the feature worktree. `TEMP`/`TMP` point to `.verification/tmp`. Test commands use the supported archive reporter entry; the full suite uses the repository CI timeout settings, Node 24, a 4 GiB heap and `E:\Git\bin\bash.exe` as Bash fixture. Existing optional/platform skips remain explicit.

| Command | Result |
| --- | --- |
| Baseline: `node scripts/testing/run-tests.mjs src/main/memory-policy src/main/memory-core src/main/memory-recall --reporter=dot` | 568 passed, 5 pre-existing platform skips. |
| Fresh actual-request authority regression: `node scripts/testing/run-tests.mjs src/main/memory-context/main-memory-runtime.test.ts src/main/memory-context/main-s-current-turn.test.ts src/main/memory-context/main-default-memory.test.ts --reporter=dot` | 179 passed. |
| Independent-review/IPC regression: `node scripts/testing/run-tests.mjs src/main/memory-policy/natural-memory.test.ts src/main/memory-policy/memory-settings-ipc.test.ts --reporter=dot` | Initial 13 failures before the unified fix; **63 passed** on final frozen source, including additional legacy-polarity/repeated-denial coverage. Archive: `2026-10-17T07-53-09-028Z-42c4865d-44dc-42a1-8e88-27e32c9d42d5`. |
| `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit` | Passed after typed protocol and review fixes. |
| `npm.cmd run check:renderer` | Passed, including the final locked-dependency check (`natural-locked-renderer.log`). |
| `npm.cmd run check:plugin-schema` | Passed, including the final locked-dependency check (`natural-locked-schema.log`). |
| `npm.cmd run test:eval` | 23 passed. |
| `npm.cmd run test:plugin-marketplace` | 66 passed. |
| `npm.cmd run build` | Frozen-source full build passed after review/full-suite fixes; final locked-dependency build also passed (`natural-locked-build.log`). |
| `CARGO_NET_OFFLINE=true npm.cmd run build:history-helpers` | Both release helpers compiled and verified offline. |
| `npm.cmd run test:memory-history-zero-write` (explicit synthetic root and debug/release helpers) | 12 passed, including actual native partial-read/precommit cancellation and source zero-write barriers. |
| `node docs/reports/artifacts/2026-10-17-memory-mutation-check.cjs` | Unmodified assertions passed; 2/2 in-memory mutants killed. |
| First `npm.cmd test -- --reporter=dot` | Exit 1: 10,383 passed / 9 failed / 11 existing skips, 817.75 s. Three branch failures fixed, then 191 tests passed; six remaining failures reproduced on baseline with the same stale dependency environment. |
| Final related suite: `node scripts/testing/run-tests.mjs src/main/memory-policy src/main/memory-core src/main/memory-recall src/main/memory-context src/main/memory-shadow --reporter=dot` | **1,730 passed, five existing platform skips, zero failures**, exit 0. Archive: `2026-10-17T08-01-02-767Z-d56723fc-3801-47b1-a3af-292c153c9778`. |
| Final locked-environment `npm.cmd test -- --reporter=dot` | **10,392 passed / 11 existing skips / zero failures**, 847 files passed, one platform file skipped, exit 0. 08:17:26–08:31:50 UTC; 863.67 s. Log: `natural-locked-full-test.log`. Archive: `2026-10-17T08-17-26-105Z-9b821145-c2c6-4bf4-8c83-303df51dbd84/report.json`. |
| `git diff --check` | Passed before final acceptance; repeated at delivery. |

Diagnostic history is retained: one related-suite run overlapped the context-role edit and failed that newly added controlled-port assertion while 1710 tests passed and five skipped; the fresh 179-test authority run passed afterward. A later negative-repeat RED run had one failure with 47 passing before its fix. These expected/diagnostic failures are not counted as acceptance passes. Logs and machine-readable archives remain under the isolated worktree, not in user data.

The first full run also caught a candidate-display regression (canonical lowercase identity exposed as display value) and two SMH assertions that still expected values inside system instructions. The DTO now preserves spelling; the SMH assertions inspect user-role data/provenance and explicitly forbid the value inside system instructions while retaining exact count/send checks. The 191-test and 1,730-test runs include these fixes.

Matching lockfile hashes did not prove the reused installation was current: its MCP SDK was 1.29.0 versus locked 1.31.0. Four Work verification failures were caused by the trust guard rejecting CLI realpaths outside the local dependency root (per-package junction reuse); two OAuth issuer failures used the stale SDK. All six reproduced in an unmodified Git-archive export of baseline 0539, with the same environment (5 passed / 6 failed). No Work/OAuth source or test was changed.

One offline lockfile rebuild failed with `ENOTCACHED` for the locked public `sdk-1.31.0.tgz`; the previous local reuse directory was restored. One anonymous fetch of that exact public tarball succeeded, without credentials/source upload. The subsequent offline, script-disabled rebuild succeeded: 1,076 packages / 24 seconds. SDK 1.31.0, TypeScript 5.9.3, Vitest 4.1.11 and Electron package 43.7.0 match the lockfile; compiler/test CLIs now resolve within the worktree. The old shared installation was never modified.

Before the latest instruction forbidding install scripts arrived, the two existing, reviewed, hash-guarded first-party security patch scripts in `postinstall` were manually executed against the isolated dependency copies (node-forge and Git argv parser). No third-party install hooks or Electron installer were executed; npm installation itself kept `--ignore-scripts`. No further installation scripts run. The previously failing two files then passed **11/11**, archive `2026-10-17T08-13-30-653Z-0aaec655-e65c-4005-bf3e-77b5f1eb38c4`.

The final complete run used the locked local dependencies and verified release presence helper, with the original CI single-worker/timeouts intact. Its archive reports **zero unhandled errors**, identical tracked source diff hashes at start/end, and unchanged hashes for every new source file. No product code changed during that run. All eleven skips are inherited Windows/non-Windows or unavailable Windows file-symlink privilege gates; none was added. The earlier failures remain visible as diagnosis history and are superseded by this final successful run.

No lint script or ESLint/Biome/Prettier configuration exists in this baseline, so no lint command is invented and no new checking policy/dependency is introduced.

## Limits, rollback and later phases

This validates software behavior with fake model output, not real-provider extraction quality, latency or billing. No actual Electron/UI acceptance was run. Sensitivity/language guards deliberately reject ambiguous cases and are not a general DLP or natural-language understanding guarantee. New extraction tasks are in-memory only and may be lost on exit; resumable work is a separate phase.

No database migration runs in this task. To discard this unintegrated implementation, retain the user's checkout and simply stop using the feature branch/worktree. For a future deployment, back up the complete database/key set while closed before first use. Revert feature code before activation, or restore the closed pre-feature backup if rolling back an already-used profile; do not attempt to delete/rewrite encrypted policy rows manually or reset the user's working tree. Legacy slot hashes and deletion markers were deliberately preserved. Synthetic fault-injection tests prove failed resolution leaves previous records and legacy recall intact.

Excluded follow-up: phase 2 resumable extraction and separately authorized automatic ADD; phase 3 complex time; phase 4 hybrid retrieval and Work/Code learning. None is enabled by this branch.
