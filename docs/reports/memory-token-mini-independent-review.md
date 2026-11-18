# Independent mini whole-branch security and quality review

Reviewed baseline: `7cecb37528a336f6d1df574e4d6fc5e64ebf8ed0` (`firefly-mini-v1.1.x`). Reviewed head: `fdce10837af7ccc09b706717d9ae62888d9bf3b0`. Date: 2026-10-17. Scope: `E:/Codex/2026-10-17/task/firefly-memory-mini-pr` only.

**Verdict: requires fixes. Critical: 0. Important: 3. Minor: 0.** The pending/confirmation separation, canonical-store recall, and deletion barriers are substantial strengths. Three independently reproduced input-validation gaps still violate the approved pre-confirmation low-sensitive, user-only fact contract. They do not bypass explicit activation confirmation or grant tool/system authority.

## Strengths

- The selective range changes 54 files (1,900 insertions, 107 deletions). Production changes are confined to memory, safe run failures, and the associated contracts/labels. The diff does not change package/lock/native sources, settings layout, window behavior, token-usage-store, or CI. The approved retention of mini aggregate usage is visible at `src/main/memory-context/main-default-memory.ts:989` and `:990`; per-feature usage is an approved separate integration, not missing phase1 work.
- Natural extraction checks a Main-owned actor, full direct-user source, temporary status, source fingerprint, current model profile, and suppression generation. The worker independently validates the raw response (`src/main/memory-policy/main-policy.ts:54`, `src/main/memory-policy/policy-repository.ts:127`). A model result creates evidence plus a pending candidate; it cannot activate itself.
- Confirmation binds candidate identity/revision/hash/scope and rechecks source, time, conflict, and suppression in the writer transaction (`src/main/memory-policy/policy-repository.ts:318`, `src/main/memory-core/fact-repository.ts:106`). Revision/resolution invalidates old confirmations and the old candidate. The typed tool/shell Main and worker edit paths agree on category binding.
- Selection nominates IDs/revisions, then canonical context rechecks current eligibility and support. Stored values are framed as user-role data behind a fixed guard, rather than interpolated into system authority (`src/main/memory-recall/main-fact-selector.ts:79`, `src/main/memory-context/context-repository.ts:98`, `src/main/memory-context/fact-context-messages.ts:5`).
- Correction/forget remain synchronous; the immutable revision ledger, suppression generation, original sources/subjects, and late-result checks prevent stale nominations from resurrecting a forgotten fact (`src/main/memory-policy/policy-repository.ts:351`, `src/main/memory-core/suppression.ts:55`). Core lifecycle timestamps now share the transaction clock.
- The masked-token change recursively inspects serialized JSON and rejects duplicate keys before JSON parsing can hide an earlier secret. Real and partial credential values remain rejected by the reviewed tests. Safe failure codes replace raw exception/provider text in the changed harness, AGUI, renderer, and child paths. The scheduler regression retains cancellation/quiescence/cleanup assertions.

## Important findings

### R1. Normalize semantic evidence before negation, quote, and hypothetical checks

**Location:** `src/main/memory-policy/natural-protocol.ts:42`, `:44`, `:47`. The same ordering problem occurs in manual edits at `:79` before normalization at `:81`.

**Trigger:** A valid-schema untrusted response proposes positive tool `Vim`, quoting the complete direct-user source `I do ｎｏｔ use Vim`. `validateNaturalResponse` returns a positive proposal and `typedUserFact` produces `用户使用工具：Vim`. The identical ASCII `not` source is correctly rejected for positive polarity. The correct negative proposal for the fullwidth source is incorrectly discarded. Complete sources `＂I use Vim＂` and `I ｗｉｓｈ I used Vim` also produce positive proposals, although their normalized forms are quoted/hypothetical.

**Cause and consequence:** `NON_FACT`, `QUALIFIED`, `INSTRUCTION`, and `NEGATIVE` run on raw sentence/clause/quote text, while value containment and other shared validators use NFKC. Equivalent text therefore crosses different semantic gates. The worker persists these returned proposals as pending personal facts; after a normal explicit confirmation, an opposite-polarity or non-fact assertion can enter canonical recall. This is a deterministic validation bypass, not a claim about how frequently a real provider emits the wrong label.

**Fix:** Retain the original source and exact span offsets, but apply every semantic guard to consistently NFKC-normalized sentence, clause, quote, value, and manual-edit text. Do not calculate original evidence offsets against normalized strings, whose lengths can differ. Add worker-boundary tests for the fullwidth negation with both polarities, fullwidth quotation marks and wish/hypothesis forms, plus the selected correction/revision path. Preserve the existing evidence-local negation cases and valid five-category fixtures.

### R2. Common medical data can be stored under an allowed model category

**Location:** `src/main/memory-policy/natural-protocol.ts:40` and `:49`. The reused sensitive gate is `src/main/memory-shadow/shadow-validate.ts:8`; that file is unchanged, but its result now authorizes durable phase1 candidate persistence. Manual edits reuse it at `src/main/memory-policy/natural-protocol.ts:94`.

**Trigger:** Each complete source and schema-valid untrusted proposal below returns one accepted natural proposal, which also passes `assertTypedUserFact`:

| Direct-user source / quote | Claimed attribute | Value | Produced assertion |
| --- | --- | --- | --- |
| `I use insulin` | `tool` | `insulin` | `用户使用工具：insulin` |
| `I have diabetes` | `preference` | `diabetes` | `用户喜好：diabetes` |
| `I am HIV positive` | `preference` | `HIV` | `用户喜好：HIV` |

`I have an allergy` was a rejecting control. `parseNaturalEdit("I use insulin", "tool")` also succeeds.

**Cause and consequence:** The independent sensitivity check is a limited vocabulary/shape blacklist; these unambiguous health terms are absent. The remaining check only requires the proposed value to occur in the quote. An untrusted model's choice of `tool` or `preference` can therefore relabel health data into a permitted category. `insertNatural` immediately writes the sensitive quote to evidence and the value to policy/core candidate payloads before confirmation. Explicit confirmation protects active recall, but does not prevent this out-of-scope sensitive persistence. Encryption does not satisfy the approved data-minimization/category restriction.

**Fix:** Add a category-independent, normalized sensitivity gate for the complete relevant evidence and proposed/edit value, including common conditions, medications/treatments, and the examples above; reject ambiguous/non-low-sensitive values rather than accepting a model-selected safe category as proof. Couple that with positive category/evidence relationship checks, since free substring presence is not a low-sensitive fact test. Apply the gate to worker proposals and typed edits. Add integration regressions asserting no new evidence or typed candidate for these sources, and that a typed correction cannot introduce them. Keep legacy deterministic behavior intact and do not replace a code boundary with another model permission decision.

### R3. A first-person marker does not prove the proposed predicate belongs to the user

**Location:** `src/main/memory-policy/natural-protocol.ts:44` and `:49`.

**Trigger:** Complete direct-user source `I taught Alice to use Vim`, with an untrusted response claiming `{subject:"user", attribute:"tool", value:"Vim", polarity:"positive", status:"asserted", quote:"I taught Alice to use Vim", ...}`, yields a positive tool proposal and `用户使用工具：Vim`.

**Cause and consequence:** The check proves only that `I` and `Vim` occur somewhere in the quote. Here `I` is the subject of *taught*; Alice is the subject of *use*. The existing other-person blacklist does not recognize named people. The host thus accepts the model's user-subject label without independent evidence of the user's tool use. This is an unsupported personal fact/inference in a pipeline whose accepted scope is user-only direct facts. It becomes a durable pending candidate and can subsequently be confirmed and recalled; it does not autoactivate.

**Fix:** Require category-bound first-person predicate/value evidence, including the approved direct address/language forms, and reject ambiguous reporting/teaching/attributed clauses. Bind the proposed value to that predicate inside the verified evidence span. A larger list of names/reporting verbs is insufficient. Add no-evidence/no-typed-candidate worker regressions for named third-party attribution and mixed first-/third-person clauses, alongside positive coverage for all five supported categories.

## Reproduction and reachable worker path

The reviewer ran two short pure Node probes using the already installed TypeScript compiler and an in-memory CommonJS module loader. They read the current source under the verified frozen head, transpiled only in memory, and used the real implementations of `natural-protocol`, `shadow-validate`, `source-secret-screen`, `context-contracts`, `extractor`, `fact-identity`, `repository-types`, and `shadow-contracts`. No validation function was stubbed; no emitted file, test file, database, credentials, network call, build, or dependency change occurred. Both processes exited 0.

The exact response template for the first probe was:

```js
JSON.stringify({facts:[{
  subject:"user", attribute, value, polarity, status:"asserted",
  quote:text, reason:"synthetic untrusted model output"
}]})
// validateNaturalResponse(raw, text, "synthetic-message")
// Every returned proposal was also checked with:
// assertTypedUserFact("synthetic-actor", typedUserFact("synthetic-actor", proposal))
```

| Source | Attribute/value/polarity | Actual proposal count |
| --- | --- | ---: |
| `I use Vim` | tool / Vim / positive | 1 (control) |
| `I do not use Vim` | tool / Vim / positive | 0 (control) |
| `I do not use Vim` | tool / Vim / negative | 1 (control) |
| `I do ｎｏｔ use Vim` | tool / Vim / positive | 1 |
| `I do ｎｏｔ use Vim` | tool / Vim / negative | 0 |
| `＂I use Vim＂` | tool / Vim / positive | 1 |
| `I ｗｉｓｈ I used Vim` | tool / Vim / positive | 1 |
| `I use insulin` | tool / insulin / positive | 1 |
| `I have diabetes` | preference / diabetes / positive | 1 |
| `I am HIV positive` | preference / HIV / positive | 1 |
| `I have an allergy` | preference / allergy / positive | 0 (control) |
| `I taught Alice to use Vim` | tool / Vim / positive | 1 |

The second probe called `parseNaturalEdit(text,"tool")` directly. It accepted `I use insulin` as positive `insulin`, `＂I use Vim＂` as positive `"I use Vim"`, and `I do ｎｏｔ use Vim` as positive value `I do not use Vim`.

Real reachable path: successful persistent desktop Chat -> `main-default-memory.ts:996` -> `main-policy.ts:54` -> writer command -> `policy-repository.ts:136` -> returned proposals inserted at `:140`. `insertNatural` at `:107` rechecks suppression and constructs evidence/core/policy records, but has no later independent subject/sensitivity/normalized-semantic gate. The core candidate parser checks structural fact fields, not these semantics. With a fresh valid direct-user source, allowed scope, current generation, and no tombstone, no later check rejects the demonstrated proposals. No database reproduction was performed under the review's read-only/no-DB constraint; the persistence conclusion is source tracing, not a claim of an executed DB exploit.

## Review and test evidence

- Read `AGENTS.md`, the mini publication plan, and the phase1 contract; applied code-review-and-quality, security-and-hardening, differential-review, context-engineering, and verification-before-completion. Retained the existing quality floor; no new policy, suppressions, skipped/deleted tests, threshold or CI changes were introduced by the reviewed diff. The RED run's test-name-filter exclusions are not new source skips.
- Inspected all changed production hunks (29 TS/JSON files), all 17 changed test/fixture diffs, the synthetic Electron launcher, and relevant one-hop writer/source/suppression/support/selector/canonical-context/terminal callers. Historical reports/artifacts are provenance, not current mini acceptance. Used local baseline blame on the event and core lifecycle changes; the legacy activation, conflict, and suppression checks were retained. The Date.now changes replace the clock source rather than remove a validation check.
- Direct production blast radius: `validateNaturalResponse` has one worker call site; `parseNaturalEdit` has four Main/worker call sites; `assertContextSecretFree` has ten production call sites; `publicRunFailure` has seven production call sites. The latter two therefore received review across transcript/context, harness/AGUI, and renderer callers, rather than only their unit tests.
- Reviewer-owned fresh checks: `git diff --check BASE HEAD` emitted no issues; the pure probes above independently reproduced the three findings. Initial and final pre-report reads of HEAD were `fdce1083`, and tracked status was clean. Only this ignored report is written by the reviewer.
- Handoff check: HEAD remained `fdce1083`; the parent had begun its authorized RED regressions in `src/main/memory-policy/natural-memory.test.ts`. Those uncommitted remediation tests are outside this frozen-commit review and were not edited by the reviewer. The report path is confirmed ignored.
- Inspected the mini typed-tool RED archive: two expected failing forward adaptations and two passing reverse cases. Inspected the related GREEN output: 16 files / 537 cases. Its manifest, and the build/types/schema manifests, record pre-commit HEAD `512bb38c`; they are supporting port evidence, not independently certified exact-HEAD acceptance. Build/types/schema archives report exit 0. Existing locked dependency/native/package sources are unchanged by the range.
- Inspected `.verification/electron-memory-ui-1792239870042/result.json`: it identifies exact head `fdce1083`, three isolated Electron launches, pending-only natural extraction, UI confirmation, new-session actual request recall after restart, synchronous correction/forget, absence after a further restart, masked history in the actual next turn, no renderer errors/failures, and graceful shutdowns. The launcher uses mock transport and synthetic storage, blocks outgoing fetch/native HTTP/Electron/Chromium paths, and asserts storage paths under the task root. Its process is still the same OS user; this is not an OS security sandbox claim.
- Offline-eval output inspected: 23 cases, zero failures. Native zero-write output inspected: 12 cases, zero failures. These are inspected executor evidence, not tests rerun by this reviewer. The separately running frozen full suite was designated superseded diagnostics by its owner after these findings; no full-suite pass for the release is claimed here. The historical 10,392/10,485 results are not mini acceptance.

## Recommendations

1. Treat R1-R3 as required fixes to the approved phase1 trust contract. Add failing worker integration regressions first, preserve positive five-category/raw-offset/legacy/masked-history coverage, and repair the shared semantic boundary rather than add exceptions downstream.
2. After repairs, run fresh related tests, build/types/schema, native/offline checks, actual mock-only Electron closure, and one whole feasible suite on a new frozen mini head with source-integrity evidence. Keep the existing tests/checks and explicit usage deferral intact. The present review remains the one independent review of `fdce1083`; do not relabel it as an approval of later unreviewed changes.
3. Keep the formal PR focused on the selected mini target, with the final source/evidence head and these resolved findings recorded. No merge, force push, branch deletion, deployment, or existing-instance restart was performed or reviewed as authorized execution by this reviewer.

## Declined-to-judge behaviors and reasons

1. **Real-provider extraction accuracy, network behavior, billed totals, or model obedience:** all reviewed runtime evidence uses fake transport; real calls/keys/network access were prohibited. The deterministic host failures above do not depend on provider frequency, and no provider safety guarantee is inferred.
2. **Live user DB/profile upgrade, restore, physical erasure/backups, and real-user migration behavior:** no real DB/profile was opened. The additive metadata and existing synthetic interruption/deletion tests were inspected; they are not a live-data migration or backup certification. Logical suppression/recall was reviewed, not physical removal of immutable history.
3. **Current third-party vulnerability/advisory and installation-script safety:** no network, audit/install, or dependency execution was allowed; manifest/lock/native sources have no range diff. This review does not certify the unchanged dependency supply chain against current advisories.
4. **Final full-suite/build acceptance after remediation:** not available at this reviewed head; earlier manifests have the provenance limits above, and the frozen full run became superseded diagnostics. This is a remaining release verification obligation, not a pass.
5. **Real OS sandbox isolation, arbitrary hostile local-process containment, or off-Windows desktop UI/native behavior:** the actual QA is a synthetic Windows same-user process with guarded transports and profile paths. No OS-security or other-platform acceptance is claimed.
6. **Per-feature usage history/attribution and phase2 background/automatic learning:** explicitly outside this PR by the user's decisions. No missing-functionality finding is raised. Existing aggregate request/usage callbacks were source-inspected; no absent history API was assumed.
7. **Fresh suite-level mutation score, load/performance benchmarks, and exhaustive natural-language/DLP coverage:** source mutation/full-suite execution/benchmarks were outside this read-only review; only the coordinated pure probes were run. Existing historical mutation evidence was not counted as new proof. No general claim that keyword screening comprehensively recognizes sensitive or attributed language is made.

## Assessment

**Ready with fixes and fresh acceptance; current `fdce1083` is not ready to represent completed phase1 acceptance.** Confidence is high in the three demonstrated validation gaps and their reachable worker persistence path; confidence is bounded by the declined behaviors above. No Critical issue, confirmation bypass, memory-as-system-authority path, stale-index resurrection, or cancellation/cleanup regression was found in the reviewed changed code. The remaining blockers are R1-R3 and post-fix mini verification. No action was denied by approval review, and no operation has an uncertain outcome.


## Executor dispositions after the independent review

The report above remains the reviewer's original assessment of `7cecb375..fdce1083`. It is not relabeled as an independent approval of subsequent commits. The executor reproduced and repaired all three Important findings in `3ab888fdfcd37775d5c17defe7490185f39b3856`; no Critical or Minor finding was silently dropped.

| Finding | Repair | Evidence |
| --- | --- | --- |
| R1 semantic Unicode / typed edits | Normalize semantic copies in `natural-protocol.ts:85` and`:124`; preserve original source offset/quote. Selected negative edits retain the literal category object, and ambiguous double negatives fail closed. | Valid initial RED19fail/58pass, Unicode12GREEN; supplemental literal-object/double-negative RED5, full natural/IPC103GREEN. Raw compatibility-ligature offset assertion retained. |
| R2 low-sensitivity persistence | Extend existing category-independent normalized original-sentence/value/quote/reason screening in `memory-shadow/shadow-validate.ts:14`; the same filter also gates selected typed edits. |7medical/selected-edit RED->7GREEN. Actual worker assertions require zero candidate/evidence for insulin/diabetes/HIV and sensitive reason; not only a Main mock. |
| R3 personal ownership | `natural-protocol.ts:27`,`:56`,`:94` require a direct category-bound self predicate and a literal object/alias with a word boundary, checked against the enclosing clause. Only a leading contrast connective is stripped. |10reported/named/mixed-subject/truncated-object RED. Original valid contrast-clause case initially failed and was retained/fixed. Complete related1819passed/5existing platform skips; final natural/IPC103passed. |

The full affected natural/IPC GREEN ran before committing exactly that source as3ab; no production changes followed. Final build/renderer types/schema, eval23, native12 and actual compiled Electron closure all pass on clean3ab. Final full-suite/source-integrity acceptance: **10512 passed / 11 inherited skips / zero failed or unhandled errors**, exit0. Frozen3ab888fd, 2026-10-17T12:52:56.117Z–2026-10-17T13:06:44.648Z; `mini-full-1792241576113-12af9bac`. All2827 tracked file hashes unchanged (d962ae4a3fd76ce29c5633ec5eda1eb819f90c1b287b126c5289c9ff6964143a).. The final mini validation/evidence report records exact commands, run IDs, hashes and diagnostic history. The stoppedfdce full attempt is not a release pass.

Explicit rulings on all declined-to-judge items:

1. Real-provider accuracy/billing/network: accepted boundary; user prohibited keys/paid validation, so fake transport only and no provider guarantee.
2. Live database/backup/physical erasure: accepted boundary; no real profile opened or migrated, existing schema10 retained. Logical suppression/context forget is tested; immutable source/history/backup erasure is not asserted.
3. Current dependency advisories/install safety: accepted unchanged-supply-chain boundary; lock/native sources unchanged, physical private copy only, no mini install/lifecycle/rebuild command. No advisory certification is claimed.
4. Post-fix acceptance: not waived; final checks are run against3ab and the full result/source manifest must pass before publication.
5. OS containment/other platforms: accepted limit; same-user synthetic Windows process roots with guarded transports, not an OS sandbox or non-Windows UI claim.
6. Per-feature Usage/phase2: explicitly deferred by the user; mini aggregate callbacks retained. No phase2 code, autoADD or durable task changes in this PR.
7. Fresh benchmarks/mutation score/exhaustive language or DLP: accepted limit; no such certification claimed. Conservative supported self-predicate parsing and keyword screening remain bounded.

Separate inherited visual observation: source-button i18next object-key warning in the mini settings panel. Exact base/current component and settings-locale blobs match; the selected user's UI is preserved. This does not invalidate the observed confirmation/edit/forget/new-session request closure and is documented as an existing UI limit.

No rejected approval action or uncertain publication outcome exists at this checkpoint. Only the task-owned stopped diagnostic test process tree was terminated; final Electron launches all exited normally. No user instance, real database, credential or external provider was used.
