# Phase 3 temporal memory validation

Status: completed and retained locally. Frozen-head full regression, offline Electron acceptance and independent review are complete. No integration or deployment was performed.

## Baseline and scope

- Worktree: `E:/Codex/2026-10-17/task/firefly-memory-phase2`.
- Branch: `codex/memory-phase3-temporal-20261018`.
- Phase 3 base: `d7ef9822974287af4089a9f6d208ec9d3e8913b2`.
- Frozen product source: `8693974b8179c446b4fa6bc48a8f9703a5cb98f6`.
- Implementation commits: `f4800e48`, `b24cea04`, `d925dcc5`, `7132b7ba`, `8693974`; design commit `b5059670`.
- Uses the approved phase 2 baseline and mini total-usage statistics. No functional usage attribution integration, vector retrieval expansion, Work/Code experience store or external service was added.
- Other worktrees continued changing independently; no merge/rebase/copy from them was performed. The older c77e094/36ade022 references are not this stage's baseline.

## Behavior delivered

Source timestamps and IANA zones are host-owned, retained across restart, optional on legacy data. Only bounded explicit calendar periods are accepted: ISO day/range, today/yesterday, last week/month. Ambiguous/unbounded statements fail closed. The date clause is removed only for factual validation; original evidence span and quote limits remain enforced.

Schema 11 removes the one-current-row-per-slot unique index while preserving the keyed identity index. A writer-transaction interval check rejects overlap and allows adjacent/disjoint half-open periods. Candidate revision/hash binds its period. Typed correction updates the selected current projection, preserving its period; old immutable assertion revisions are audit/exclusion metadata, never historical truth. Whole-slot forget synchronously suppresses every owned disjoint period and support in one transaction.

Historical selection derives a range only from the authenticated current question's immutable source text, timestamp and zone. The source-bound query is rechecked at assembly, snapshot/permit and final dispatch. Unresolved explicit historical intent selects no historical fact. Ordinary long messages retain normal conversation behavior. Recalled memory remains user-role sourced data and receives no tool/system authority.

Management exposes all eligible current projections, including past/future periods, and displays bounded candidate/fact time. IPC explicitly whitelists candidate time. No new UI redesign was undertaken.

H is also checked: old assertion/support origins and native provenance cannot resurrect corrected content. Untraceable H or assistant/tool echoes are conservatively excluded after an actor-owned correction or original-source invalidation. Native capture reports `disabled-by-retraction` coverage before source reads; actual stale evidence still fails dispatch.

## Independent review and repairs

The independent astra/medium review found three Important issues: old H text returning after correction; ordinary messages over 4000 characters rejected; single-quoted questions gaining temporal authority. It also proved original quote length was bypassed. Repairs were verified with initially RED private probes, retained as tracked regression tests. Extended review found parenthesized quotes and cross-session assistant echoes, then the fresh-native-capture policy failure; each was repaired. Closing review reports no remaining Critical/Important in the reviewed changes, with 7 privacy probes PASS and 2 independently selected closure regressions PASS.

Electron found candidate time removed by IPC and multi-period forget residue; both received RED regression tests and fixes. A subsequent harness run encountered unfinished prior asynchronous jobs during its temporary-chat assertion. The harness must wait for prior persistent jobs to drain; this is a verification synchronization change, not relaxed temporary persistence assertions. One private draft used the wrong `queue` field and failed before the temporary check; corrected to the actual `counts` contract. All failed evidence is retained.

## Verified commands so far

Commands use `E:/Node.js/node.exe .verification/run-isolated.cjs <label> <script> ...`, which supplies private temporary/profile/cache directories, synthetic Git identity, no inherited credential configuration and offline npm settings.

| Check | Result | Evidence under `.verification/runs/` |
|---|---|---|
| Full ordinary `npm run build` | PASS, including storage boundary/Main/preload/CLI/renderer; existing Vite large-chunk warning | `phase3-build-1792292396276-7bacc5fd` |
| Renderer TypeScript | PASS | `phase3-renderer-types-1792292430118-5f62eb21` |
| Final repaired Main TypeScript compilation | PASS | `phase3-final-main-types-1792294147709-35e22a98` |
| Review fixes and ordinary/natural protocol | 123 PASS | `phase3-review-fixes-1792292736240-cdff1eb3` |
| H query/permit correction races | 49 PASS | `phase3-history-races-1792292791198-392d8358` |
| Temporal/H/native closure | 90 PASS | `phase3-closure-directed-1792292969304-c5fd7aac` |
| Native retraction coverage | 29 PASS | `phase3-capture-coverage-1792292992395-b35f0927` |
| Plugin manifest schema consistency only | PASS | `phase3-schema-1792292845228-9b40f8c8` |
| Existing native release helper verification | PASS | `phase3-native-helpers-1792292844359-7aa975b8` |
| Native history zero-write acceptance | 12 PASS | `native-zero-write-1792293020044-968a4cef` |
| Eval contracts (`npm run test:eval`) | 23 PASS | `phase3-eval-1792292843068-6d87c2a2` |
| Frozen full suite | 882 files PASS, 1 skipped; 10836 cases PASS, 11 inherited skips, 0 FAIL; exit 0 | `mini-full-1792294203691-acbb8e0d` |

No standalone lint script is defined; `git diff --check` passed. Build ran at d925dcc5; only Main/test changes followed, and final Main compilation passed at the 8693974 product tree. No renderer changes followed its passing build/typecheck.

## Limits and rollback

- Correction without a new explicit period preserves the selected period; creating a different period requires a new dated assertion.
- Only bounded calendar semantics are supported; no transaction-as-of query or general temporal language reasoning.
- Historical reads do not refresh expired current-preference strength.
- Untraceable H may remain unavailable indefinitely for an actor after correction or persistent source invalidation, including unrelated new raw documents. Typed M historical recall remains available. This conservative loss of recall prevents stale derived echoes from becoming truth.
- Forget is whole canonical slot, not selective one-interval deletion, preserving existing tombstone semantics.
- A complete stage does not imply real-provider quality validation: no real keys/settings were read and no paid or external model calls made. Electron transport is synthetic.
- SDK check remains deliberately NOT RUN following the user's decision to preserve the no-package restriction after automatic approval review rejected it. No SDK/EXE package/install, push, PR, merge, deployment or user DB migration occurred. Numerical vector evaluation was not run without a local model; no download was attempted.
- Restore the retained phase 2 branch/base to roll back code in a separate checkout. Before any future real schema 11 upgrade, back up the database together with its matching key while the application is closed. Schema 10 code must not open a schema 11 database; restore the paired pre-upgrade backup rather than manually downgrading indexes. All migration exercises here used temporary SQLite; the injected migration-interruption test proves transaction rollback restores version/index and encrypted data, and old facts remain readable after upgrade.
- Workspace, failed/passing logs, screenshots and private test profiles are retained for review, rather than automatically deleted.

## Visual inspection

The actual settings screenshot shows both corrected disjoint periods and their effective endpoints. It also exposes a pre-existing source-button localization collision: `settings.panel.memory.entries.source` is used as a label while the locale entry is an object, so i18next displays an object-return diagnostic. `git show d7ef9822:src/renderer/settings/memory/entries-panel.ts` confirms the label call predates phase 3. This minor presentation defect is recorded rather than extending this memory change into the user's active UI redesign. Candidate/confirm/correct/forget controls and period labels work in the Electron acceptance.


## Full-suite follow-up

The first frozen full run at 7132b7ba completed with 10834 PASS, 2 FAIL, 11 inherited skips; its 2901-file manifest remained exactly unchanged (5283db534bedfc86f215f457090a230a6a9b4fc2f1d9576ad8f7d51ad48a91e9). One old test required raw H after correction, inconsistent with the approved retraction boundary; it now requires corrected M, explicit retraction coverage, and absence of old assertion/quoted H. The other exposed ordinary FactQuery validation changing the established source-denial path. Ordinary messages now bypass temporal interpretation and retain existing context source guards; historical intent still verifies the full source and fingerprint. Independent incremental review found no new Important issue (3 targeted cases PASS). Four affected files passed all 156 cases in phase3-full-followup-1792294119332-367daef6; Main compilation passed in phase3-final-main-types-1792294147709-35e22a98. The final full run is a fresh freeze, not a reinterpretation of the first failed run.

The committed Electron harness includes the previously validated queue-drain synchronization. A new run of that exact committed file is recorded separately from the private development copy.


## Frozen-head Electron evidence

At 8693974b8179c446b4fa6bc48a8f9703a5cb98f6 the committed script completed successfully (26 assertions, 3 real Electron launches, exit 0). Evidence: .verification/electron-phase3-1792294203084-8a95deb6/result.json, model-requests.ndjson, process.log, and three PNG screenshots. Command/run metadata: .verification/runs/phase3-electron-frozen-1792294202747-8ea55ed1.

The actual UI accepted a dated English preference as a pending candidate, showed its bounded period, confirmed it, closed the process and Worker, then reopened into a new chat. A current question omitted the expired preference; the authenticated historical question selected it into the actual outbound user-role memory context. A second Chinese preference in a non-overlapping period coexisted and selected only for its matching question. Temporary dated input caused neither extraction nor journal/budget changes after earlier durable jobs drained. Correcting the first period preserved its endpoints and the next request used the corrected fact without the old English assertion. Forget removed both periods synchronously; a third process launch and new historical question contained neither remembered labels nor original statements. Every owned process exited with code 0. No real provider or credential was involved.


## Final freeze and completion

Final full run finished at 2026-10-18T03:45:35.120Z on 8693974b8179c446b4fa6bc48a8f9703a5cb98f6. The 2901 tracked-file manifest was identical before and after: 23ce32abf592b4c8988baa058316c61d6b9da96fc21d7473231271b34f885fd9; sourceUnchanged=true. The archive reports 882 passed files and 1 inherited skipped file, 10836 passed tests and 11 inherited skips, no failures. Skip details are retained in the report.json/output log: platform/native gates and unavailable Windows symlink privileges remain explicit, not converted into passes. This change added no skip or disabled assertion to obtain green.

Exact final commands:

- Full: node .verification/run-isolated.cjs mini-full scripts/testing/run-tests.mjs --reporter=dot
- Main: node .verification/run-isolated.cjs phase3-final-main-types node_modules/typescript/bin/tsc -p tsconfig.main.json
- Electron: node .verification/run-isolated.cjs phase3-electron-frozen scripts/verify/natural-memory-phase3-electron.cjs
- Renderer: node .verification/run-isolated.cjs phase3-renderer-types node_modules/typescript/bin/tsc -p tsconfig.renderer.json
- Build: node .verification/run-isolated.cjs phase3-build E:/Node.js/node_modules/npm/bin/npm-cli.js run build
- Schema only: node .verification/run-isolated.cjs phase3-schema scripts/plugin-sdk/generate-schema.mjs --check
- Helpers: node .verification/run-isolated.cjs phase3-native-helpers scripts/verify/history-helpers.mjs
- Zero write: node .verification/run-isolated.cjs native-zero-write node_modules/vitest/vitest.mjs run --config scripts/testing/vitest.memory-history-zero-write.config.ts
- Eval contracts: node .verification/run-isolated.cjs phase3-eval E:/Node.js/node_modules/npm/bin/npm-cli.js run test:eval

The final documentation commit adds this report and the preserved independent review only. Product source and the tested acceptance script remain exactly at 8693974. Task 1 source/parser, Task 2 transactional periods, Task 3 historical send authority, and Task 4 management/native/Electron closure are complete. Phase 4 hybrid retrieval and Work/Code remain deferred.

Dependency lockfile is unchanged: SHA256 813132dfcc24b49df17ae4dee77638226f52f5b0fd13515c979d8962afb85d4e. No unresolved permission blocker remains. The deliberate SDK exclusion above is retained under the user's restriction, not represented as a passing verification.

## Main changed-file map

- `src/main/memory-policy/fact-temporal.ts`, `fact-query.ts`: bounded source-calendar parsing and authenticated query binding.
- `src/main/memory-core/source-contracts.ts`, `source-ledger.ts`, `src/main/memory-sources/desktop-user-source-provider.ts`: host timezone provenance and restart behavior.
- `src/main/memory-core/schema.ts`, `fact-repository.ts`: schema 11 transactional migration and non-overlapping current projections.
- `src/main/memory-policy/natural-protocol.ts`, `natural-job-repository.ts`, `policy-repository.ts`, `fact-supports.ts`: candidate/journal periods, correction, whole-slot forgetting and obsolete support exclusions.
- `src/main/memory-recall/main-fact-selector.ts`, `main-recall.ts`, `recall-repository.ts`; `src/main/memory-context/main-context.ts`, `context-repository.ts`, `fact-context-messages.ts`: typed historical selection, snapshot/permit/send rechecks and user-role period metadata.
- `src/main/memory-history/history-repository.ts`, `main-history.ts`, `src/main/memory-sources/native-history-provider.ts`, `src/main/memory-context/main-desktop-memory.ts`: H exclusion and explicit retraction coverage.
- `src/main/memory-policy/memory-settings-ipc.ts`, `src/renderer/settings/memory/entries-panel.ts`, related contracts: management time DTO and existing-card period labels.
- Focused source/temporal/migration/IPC/native/context tests plus `scripts/verify/natural-memory-phase3-electron.cjs`: persisted regression and actual application closure evidence.
