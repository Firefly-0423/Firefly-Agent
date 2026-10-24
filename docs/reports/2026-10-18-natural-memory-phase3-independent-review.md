# Phase 3 independent review

Reviewed frozen range `d7ef9822974287af4089a9f6d208ec9d3e8913b2..d925dcc59` on `codex/memory-phase3-temporal-20261018`. Product checkout was read-only; private probes and this report are under `.verification/phase3-review/`. No product edits, Git mutations, live databases, network, models, SDK checks, services, installation, or packaging were used.

**Assessment: not ready to accept at this head.** Three Important findings below are reproducible. No Critical finding established. This report predates the author's fixes and does not certify later commits.

## Strengths

- Slot overlap checks execute inside the existing `BEGIN IMMEDIATE` writer transaction for both activation and correction. Adjacent half-open intervals and rollback on correction conflict are covered.
- Original `occurredAt` and validated host timezone survive source recapture and journal replay. Relative parsing does not use recovery wall time; legacy absent-zone temporal inputs fail closed.
- M historical recall uses current projections, source-bound question metadata, and repeated snapshot/permit/claim checks. Correction, forget, and original-source-change tests exercise the final dispatch seam.
- Schema 11 index replacement is transactional; old version checks reject newer schemas. Management lists past/future facts separately from current eligibility. No new dependency was introduced.

## Important findings

### R1 — Corrected assertions can return through raw H and reach the wire

Locations: `src/main/memory-history/history-repository.ts:113`, `:128`; `src/main/memory-core/fact-repository.ts:146`; integration at `src/main/memory-context/main-context.ts:334`. Acceptance assertion gap: `scripts/verify/natural-memory-phase3-electron.cjs:151` checks the generated assertion label, not the original English source text.

Reproduction in private `review.test.ts`, test `corrected temporal assertion cannot return via H and reach wire`:

1. Confirm `2026-01-01, I prefer English` as a historical fact.
2. Capture its original text as H, first using `captureSource`, then independently using `captureTranscript` with a native-shaped `raw-history` document, native provenance, and `sourceDeps: []`.
3. Correct the selected fact to Chinese.
4. Query H, assemble a current authenticated historical question with the H evidence, obtain a permit, and dispatch through the real context guard into a fake callback.
5. The callback receives `2026-01-01, I prefer English` in quoted historical evidence. The negative assertion fails after dispatch, rather than in fixture setup.

Cause: H only derives recall dependencies from currently effective projections and document source roots. Expired temporal facts do not participate, and source-free native documents have no roots at all. Correction replaces M's projection but leaves the original source/history text valid and does not advance a history exclusion barrier. Current M revision checks therefore do not protect the independent H data path.

This H behavior predates this diff (blame: `ba1bc47e6` for lines 128–129), but it is an unclosed integration requirement of this stage's explicitly confirmed correction/privacy semantics, not a claim that H was newly introduced here.

Fix: enforce correction exclusions at H query and every subsequent validation, using actor-scoped retired assertion/source provenance. Treat old revisions only as exclusion evidence, never recall evidence. Include old-revision support sources as well as the original assertion source; reject full documents before excerpting when provenance matches. Native documents with untraceable derived echoes need an explicit conservative policy. Add full-wire assertions for both original source text and generated labels, including a correction between permit and send.

### R2 — New temporal lookup rejects ordinary messages over 4000 characters

Locations: `src/main/memory-policy/fact-query.ts:28`; callers `src/main/memory-context/main-context.ts:298`, `:331`; `src/main/memory-recall/main-fact-selector.ts:69`.

`FactQuery.resolve` applies the 4000-character limit before detecting temporal intent. Both Main callers supply the full current question for every ordinary request. A source containing `'a'.repeat(4001)`, no facts and no temporal marker, now fails `context.assemble` with `MEMORY_FACT_QUERY_DENIED`. This is a general conversation regression, not merely a refusal to parse an unusually long temporal query.

Fix: preserve the normal message/context size contract. Bound temporal interpretation without aborting an otherwise valid ordinary request; for unsupported long temporal input, fail closed on historical fact selection while permitting the ordinary message. Keep full-source fingerprint verification and avoid granting authority from a truncated fragment. Test both selector and assemble, ordinary and temporal messages.

### R3 — Single-quoted text grants historical query authority

Locations: `src/main/memory-policy/fact-temporal.ts:6`, `:69–72`; `src/main/memory-policy/fact-query.ts:31–32`.

`parseFactTimeQuery("'What language did I prefer yesterday?'", {occurredAt:1773057600000,timeZone:'UTC'})` returns a definite interval `[1772928000000,1773014400000)`. The query UNSAFE filter omits straight and curly single quotation boundaries, although the natural fact validator explicitly handles them. As a result quoted content is interpreted as the current user's request to retrieve past facts, contrary to review focus 5.

Fix: reuse a shared quotation/hypothesis boundary validator for factual and query authority, preserving in-word apostrophes. Cover straight/curly quotes and embedded quoted time questions at parser and selector level.

## Additional verified constraint gap (not elevated to a merge-blocking severity by itself)

`src/main/memory-policy/natural-protocol.ts:95–103` shortens the model's quote before shadow validation, then restores the unvalidated original quote. `Yesterday,` + 190 spaces + `I prefer English` (216 characters) is accepted despite `SHADOW_LIMITS.maxQuoteChars === 200`. The probe is RED. The demonstrated excess is padding, and the outer response bound remains, so this report does not overstate it as a standalone security exposure. Validate the original envelope/quote bounds before clause adaptation; keep shadow sensitivity checks on the factual clause so ISO dates are not mistaken for sensitive number strings.

## Verification evidence

- Four existing directed files independently rerun: `temporal-memory.test.ts`, `fact-temporal.test.ts`, `fact-repository.test.ts`, `natural-temporal.test.ts`: **46 passed, 4 files passed**, exit 0. Run: `.verification/runs/phase3-review-directed-1792292655301-db65fc34/`.
- Private four-probe run with source-bound H: **4 failed as expected**, including full dispatch reproduction. Run: `.verification/runs/phase3-review-probes-elevated-1792292583933-4f7edf3a/`.
- Same probes with native-shaped source-free H: **4 failed as expected**. Run: `.verification/runs/phase3-review-native-probes-1792292631452-b0f9693a/`. Current probe file corresponds to this run.
- Initial sandbox run could not collect tests due to Vitest `realpath` EPERM; zero tests executed. Narrow elevated runs were then authorized and completed. No automatic approval denial remains pending.
- Reproduction command: `E:/Node.js/node.exe .verification/run-isolated.cjs phase3-review-native-probes scripts/testing/run-tests.mjs --config .verification/phase3-review/vitest.config.ts .verification/phase3-review/review.test.ts --reporter=dot`.
- `git status --short` was empty after review probes (private verification paths are ignored). Product source was not mutated for testing. Author-provided earlier mutation evidence was not represented as independently rerun.

## Coverage and declined-to-judge

Reviewed changed source seams, design/implementation plan, progress ledger, source metadata, parser/wrapper, confirmation/correction transactions, query/snapshot/claim/send flow, settings projection, schema migration, and offline acceptance assertions. Examined H and production runtime one-hop callers and relevant Git blame. High-risk fan-out: historical eligibility feeds policy recall/manage, recall rank/visibility, context checkedFacts, and H checkedDocument; both new query entry paths were inspected. This is targeted risk review, not an exhaustive audit of all pre-existing memory code.

- Unbounded/vague period support and transaction-as-of retrieval: intentionally outside the approved bounded-valid-time scope; not reported as defects.
- Historical access not refreshing expired current-preference strength: explicit accepted limitation; not reported as a defect.
- Full regression, full build/typecheck, real Electron/UI acceptance, native helper checks, real data migration, installation/packaging, and SDK verification: not run by this reviewer. Parent owns allowed wider verification; SDK remains prohibited.
- Concurrent correction overlap: transaction implementation and direct correction-conflict rollback test inspected/passed; no separate multi-process writer race was added.
- Cross-actor/project regressions and all timezone database transitions: inspected at the relevant boundaries, not exhaustively enumerated by new runtime probes.
- No network dependency audit was performed; dependency files are unchanged and network was prohibited.

Remaining blocker is implementation correction of R1–R3 and re-verification at a new frozen head. There is no unresolved permission blocker.

## Follow-up review — uncommitted fixes after d925dcc5

Original four private probes now **4 PASS**: `.verification/runs/phase3-review-fixes-1792292781237-e3dadf28/`. Ordinary long input, simple single-quoted query, original quote length, and directly linked native old assertion are repaired. Reviewed the candidate-time IPC whitelist fix and old-revision support-origin lookup as well.

**Still not ready to accept:** expanded private probes report **4 PASS / 3 FAIL**, `.verification/runs/phase3-review-residual-1792292825083-ad8724e8/`:

1. **R3 incomplete:** `Analyze ('What language did I prefer yesterday?').` still grants the definite yesterday range. `fact-temporal.ts:6` only treats apostrophes adjacent to whitespace/start/end as delimiters, missing punctuation boundaries. Use token-aware quotation boundaries that allow contractions but recognize brackets/punctuation (and curly opening quotation marks), then test the current-question selector.
2. **R1 incomplete — unlinked assistant echo:** create a native-shaped raw-history turn in session B whose user asks `What language did I prefer?` and assistant says `You preferred English on 2026-01-01.`; its provenance has distinct IDs from the fact source in session A. After correcting the confirmed English fact to Chinese, this H still reaches the fake final dispatch. `hasSupersededOrigin` matches original/support IDs but has no dependency for the assistant echo.
3. **Same privacy gap after original-source loss:** the same echo reaches final dispatch after session A's original source is edited and the new revision is recaptured, making the old assertion source stale. The new H guard additionally only examines `current.revision > 1`, so it cannot address source invalidation of an unrevised fact.

The echo fixture models a normal prior answer in another conversation, with a leading user turn and valid native-shaped provenance, not a standalone unclassified assistant document. The parser groups native messages by user turn, so the original assertion need not occur in the echo's document. The probe verifies full `assemble -> permit -> dispatch`, not merely H query output.

**Required policy consequence:** to guarantee the approved no-revival rule without trustworthy assistant-to-fact dependencies, an actor-scoped conservative exclusion barrier for untraceable historical material after correction/source loss is necessary. Exact original-message matching alone cannot establish safety. Track genuine dependency lineage if selective retention is required; do not use lexical matching as an authorization boundary. The barrier must also invalidate already selected evidence at final validation and remain effective across recapture/restart.

Direct physical native source deletion has independent protections: `main-default-memory.ts` invokes native invalidation before canonical mutation; native capture re-reads the transcript under its barrier and filters inactive provenance. Those protect the mutated session/document. They do not prove safety of another session's unchanged echo. This follow-up dynamically tested source revision loss, not a real filesystem deletion or real native helper execution; no claim is made that the direct native deletion gate itself is broken.

Current private probe file contains all seven cases. Product source remains untouched by the reviewer; fixes are the parent's uncommitted work and were reviewed as such. No permission blocker remains.

## Second follow-up — seven privacy probes pass; capture integration still needs closure

After Unicode quotation-boundary matching and actor-scoped untraceable-H exclusion were applied, the original plus residual probes are **7 PASS**, exit 0: `.verification/runs/phase3-review-final-seven-1792292892796-e86ac79d/`.

The new guard is evaluated inside `checkedDocument`, which is reused at query and dependency validation. It rejects source-free native material and non-user messages lacking declared derived dependencies when an owned current fact has been corrected or its original source is invalid. Exact original and obsolete-support exclusions remain. This closes the demonstrated cross-session echo paths; current typed M historical recall is not disabled by this H guard.

**Important integration issue found by call-chain inspection:** the same guard runs while `captureTranscript` calls H `put`. After a correction, a newly captured unbound native document raises `MEMORY_HISTORY_STALE`; `native-history-provider.ts` only converts `MEMORY_HISTORY_COVERAGE_INSUFFICIENT` to partial coverage, and `scoped-history-query.ts` only accepts that code or `MEMORY_HISTORY_NATIVE_UNAVAILABLE`. `main-history.ts` preflight `assertUnboundCaptureAllowed` still only tests the forget generation. Consequently a fresh native history capture can abort the whole model turn instead of merely making H unavailable. The seven probes query already captured history, so their PASS does not establish this fresh-capture behavior works.

Remedy: expose a narrowly typed untraceable-history-disabled decision at capture preflight and return an explicit insufficient-coverage result for that policy decision. Preserve hard failure for real `STALE` races and already selected evidence. Verify a new ordinary/historical turn after correction through native capture or the real offline Electron path. The inspection result was sent to the parent before completion.

Product limitation to retain: because legacy raw/native H lacks trustworthy fact-dependency lineage, any actor-owned corrected fact (or persistently invalid original source) can make that actor's untraceable H unavailable indefinitely, including newly captured unrelated documents. Typed M historical recall remains available subject to normal source/revision guards. This is a conservative privacy tradeoff, not selective historical retention.

## Closing review — retraction preflight and whole-slot forget

**Latest scoped assessment: no remaining Critical/Important finding in the reviewed fixes.** This supersedes the earlier blocking verdicts for the uncommitted tree inspected in this closing pass; it is not a full-suite or final-commit certification.

- H baseline now reports `unboundDisabled`; Main preflight converts it to the explicit `MEMORY_HISTORY_DISABLED_BY_RETRACTION` policy decision. Native capture returns `coverage-insufficient` / `disabled-by-retraction` before reading source files. Default scoped history already accepts coverage-insufficient results; desktop scoped history now omits retraction-disabled sessions alongside forgotten sessions. Genuine `MEMORY_HISTORY_STALE` remains a hard error. The previously identified fresh-capture failure is closed at the intended narrow boundary.
- Forget validates the selected fact's actor/revision before entering the existing operation branch, identifies actor-owned current facts in the same canonical slot, and forgets each sibling and all its support origins within the existing single writer transaction. Candidate invalidation and the command receipt remain in that transaction. No partial successful return occurs midway; errors roll back the whole mutation. Reused subject suppression semantics make subsequent confirmation/recall remain blocked.
- Independently executed only the two new relevant regression cases: `reports retraction coverage before reading native history after correcting a fact` and `forgets every disjoint interval in the selected canonical slot atomically`: **2 PASS, 37 intentionally filtered skips**, exit 0, `.verification/runs/phase3-review-closing-1792293033339-292bb7f8/`.
- Previous independent privacy-probe evidence remains **7 PASS**. No new full regression, build, or Electron run was performed by this reviewer. Parent is responsible for the final frozen-head build and offline Electron closure.
- The long-term loss of untraceable H after correction/source invalidation remains an explicit product limitation. Typed M historical recall stays available. There is no outstanding permission blocker, and the reviewer made no product-source changes.

## Small follow-up after full-suite feedback (HEAD 7132b7ba plus working changes)

Reviewed ordinary-query early return, the revised correction/H expectation, and the acceptance harness drain wait. **No new Important permission regression found.**

`FactQuery.resolve` returning undefined for non-temporal text grants no historical capability and uses the pre-existing current-fact eligibility path. Main selector still obtains committed source authority and reads the actual source; Main assemble still checks/reads the current source and places it among required sources. Context baseline/inspect/snapshot/final validation retain their source and suppression checks. Explicit historical input still requires same-session trusted source provenance and a full-text fingerprint match before acquiring a time binding. Direct trusted Main rank with no temporal binding already supported ordinary current ranking; the early return does not expand it.

The default-memory test change follows the approved conservative barrier: corrected M must remain present, raw quoted H and the retired assertion must be absent, and the retraction diagnostic must be present. It replaces a contradicted old expectation with stronger relevant assertions. The Electron harness now waits for prior `unsent`, `result-unknown`, and `result-saved` jobs to drain before sampling temporary-session state; both original state equality and natural-request count assertions remain unchanged.

Independent focused authority/lifecycle verification: **3 PASS / 7 deliberately filtered skips**, exit 0, `.verification/runs/phase3-review-query-boundary-1792294156792-95e5c4d2/` (forged query/source authority; reopen/correct/forget historical dispatch; unknown dates/missing timezone). Full-suite and Electron outcomes are parent-owned evidence and were not independently rerun in this small review.
