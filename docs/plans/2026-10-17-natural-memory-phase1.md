> Historical snapshot: this file records its original phase1 baseline and acceptance time. For the user-selected mini target and final post-review source, see [fresh mini validation](../reports/2026-10-17-memory-token-mini-validation.md). Do not substitute its earlier counts or limits for current mini evidence.

# Natural low-sensitivity memory: phase 1

## Scope and verified baseline

Implement the approved user-only loop: natural statement → validated pending candidate → explicit confirmation → reopen → select into a new session's canonical context → synchronous correction → synchronous forget. Only forms of address, language, response style, tools and general preferences. No auto-ADD, shadow backfill, vectors, graph, Learn/calls, Work/Code learning, external services or real credentials.

Product repository: `https://github.com/Serendipity-wu02/Firefly_Agent.git`. Feature worktree: `E:\Codex\2026-10-17\task\firefly-memory-phase1`, branch `codex/natural-memory-phase1-20261017`. Implementation baseline is **0539f72a5888d1453227d3f3eabef410e23fbc58**, verified against remote `codex/inspector-cards`; both 36ade022 and research c77e094 are ancestors. Registered skills-layout checkout is older (36ade022); main points to a separate older history. The user's chat-ux checkout has three modified renderer files and is never edited here. Android is excluded.

Host model metadata lists `gpt-6.1-sol` and supports `max`; local global default `xhigh` is not evidence of this delegated task's sampling setting. The durable host does not expose this task's effective sampling configuration through read_thread. No model setting will be silently substituted; report this verification limit.

## Design

- Keep the single SQLite writer, encrypted policy records, immutable core revisions, source ledger, command receipts, supports, suppression, and legacy deterministic paths.
- Add a versioned typed fact protocol with distinct entity, slot and assertion identities. `subjectKey` remains a compatibility alias for the legacy slot hash; known shell and preference categories honor existing tombstones. Typed fields are emitted only after worker-side validation, never trusted from renderer/model authority claims.
- Preserve display spelling separately from `canonicalValue`; new many-valued identities use NFKC/case/whitespace normalization. Every legacy single-valued key remains byte-compatible. Confirm audit support retains the bound content hash and scope as well as revision.
- Reuse the bounded shadow model transport and response schema validation for new calls only. Add strict source-span, quotation, hypothesis, one-shot command, polarity, secret and user-subject checks. The host supplies actor, scope, source, role, time and suppression generation. Model results always create pending candidates.
- Resolve/reclassify creates evidence plus a new core/policy candidate atomically, links and invalidates the previous candidate, and never repurposes an unknown row. Confirm binds candidate ID, revision, content hash, actor and scope; recheck source versions, current conflict and suppression inside the writer transaction. Old events cannot confirm replacement content.
- Typed state is additive encrypted payload metadata: no new SQLite DDL or user-data rewrite. Existing schema-10 databases and untyped records remain readable; rollback consists of reverting feature code before activation, or restoring a pre-feature isolated backup if reverting an already-used deployment. This task opens only synthetic databases.
- The selector uses trusted typed facts and nominates IDs/revisions; canonical context rechecks ownership, revision, validity, source and deletion before use. Memory text remains untrusted data, never system/tool authority.
- Capture new desktop Chat sources only after successful turns. Temporary sessions exit before calls or persistent candidates. No persistent/resumable extraction queue in phase 1. Correction and forget run synchronously, never via model/background jobs.

## Implementation plan (test first)

1. Establish isolated baseline with existing memory-policy/core/recall/context tests. Reuse an exact-lockfile dependency installation without changing its files or scripts.
2. Add protocol/identity tests: five categories, negation, bad schema, quoted/hypothetical/one-shot/third-party/assistant/tool/secret inputs; legacy slot/tombstone compatibility.
3. Implement transactional natural proposals and explicit resolution/reclassification. Test rollback faults, stale generation/source/revision/hash/scope, source edits/deletes, conflicts and confirm/revise ordering.
4. Add Main extraction/confirmation/correction plumbing and typed selection. Prove natural → confirm → close/reopen → a different session's actual canonical context → correction → forget; old nominations and late results must fail after deletion.
5. Integrate the desktop host using fake transport tests, preserving renderer files and legacy paths. Run related tests, full project tests, storage boundary, main/preload/renderer type/build checks and existing lint where available. No real Electron/provider acceptance claimed.
6. Request independent code/security review, fix findings with regression tests, rerun affected checks. Record exact commands, outcomes, baseline/HEAD, changes, remaining risks and rollback.

## Quality and trust contract

Follow existing AGENTS.md and CI; no new dependencies, skip directives, ignored type errors, weakened assertions/thresholds or CI changes. No CONSTRAINTS.md exists: apply the constraint skill's floor and existing project checks; no new CI policy. Model/renderer data, retrieved memories and source text cross explicit trust boundaries; confirmations grant storage only. All tests use synthetic scoped data and temporary roots. Preserve source validity and the transaction clock. Native managed worktree creation was unavailable on the durable host, so authorized git-worktree fallback was used.

## Later phases (excluded)

2. Resumable extraction tasks and separately authorized automatic ADD.
3. Complex temporal reasoning.
4. Hybrid retrieval and Work/Code memory.

## Execution record

- Baseline memory-policy/core/recall checks passed: 568 passed, five pre-existing platform skips. The first new closure suite failed on 13 missing natural-extraction/resolution behaviors before implementation.
- Added real SQLite/source-ledger tests and fake transport integration through actual canonical context and provider-request assembly. The fresh runtime/controlled-port/desktop-owner authority suite passed 179 tests after moving stored values from system messages into user-role data behind a fixed system guard.
- The first broad related run overlapped that authority edit and had one stale implementation failure (1710 passed, five skips); a fresh run of all three affected suites passed. Final acceptance uses a frozen-source full-suite run, recorded in the delivery report.
- One independent review by the requested gpt-6.1-sol/max configuration found four Important issues, no Critical issues. Its original report is preserved in `../reports/2026-10-17-natural-memory-independent-review.md`. A unified fix pass added failing reproductions for normalization/suppression, opposite polarity on legacy paths, evidence-local negation and quoted/wish/question inputs before fixing them. Additional repeated-denial coverage exposed and fixed an adjacent legacy-support error.
- Two in-memory mutation experiments removed the polarity guard and canonical identity normalization independently; the corresponding assertions rejected both mutants. No production files were modified by these experiments.
- No real provider, Electron application, user database, credential, UI checkout, Android repository, dependency lockfile, CI policy or test suppression has been changed.
- The first full run exposed three branch display/role assertions and six dependency-environment failures. The branch issues were fixed and passed 191 focused tests; all six environment failures reproduced on an unmodified 0539 source export. Matching lockfile hashes had missed a stale installed SDK (1.29.0 versus locked 1.31.0) and the reused CLI realpath layout.
- Rebuilt only this worktree's dependencies offline with scripts disabled after anonymously caching the exact missing public SDK tarball; preserved the original shared installation. The two existing first-party security patch scripts were run manually before the later instruction forbidding installation scripts; no third-party installation hooks or Electron installer ran, and no further installation scripts run.
- Final locked-dependency build, renderer types and schema checks passed; the former environment-failure files passed 11/11. Final full project acceptance passed **10,392 tests**, with eleven inherited platform skips and no failures/unhandled errors. Source hashes stayed unchanged during the complete run. Native zero-write/cancellation acceptance passed 12 tests. See the validation report for archives, commands, rollback and limits.
