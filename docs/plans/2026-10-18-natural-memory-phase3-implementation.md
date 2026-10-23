# Natural memory phase 3 implementation plan

> **For agentic workers:** use superpowers:executing-plans inline, with test-driven development and one independent final review.

**Goal:** Confirm and recall explicitly timed low-sensitivity facts without treating old or corrected information as a current preference.

**Architecture:** Extend authenticated source metadata, typed candidate time, existing encrypted fact projections and guarded context reads. Keep current queries unchanged by default; historical selection carries a host-derived temporal intent through every Worker validation boundary.

**Tech stack:** existing TypeScript, Electron, SQLite single writer, Vitest and private fake transport; no new dependencies.

**Spec:** `docs/plans/2026-10-18-natural-memory-phase3-design.md`.

## Global constraints

- Base `d7ef982`; isolated branch `codex/memory-phase3-temporal-20261018`. No assumption that phase 2 was published.
- Preserve default-off ADD-only automation, source/tombstone identities and confirmation revision/hash binding.
- No real data/provider, SDK/EXE packaging/install, remote writes or unrelated UI/marketplace changes.
- Use `.verification/run-isolated.cjs` with unique labels; physical private dependencies already exist. No reinstall. Preserve source manifests and evidence.

## Review focus

1. A timezone change after enqueue/restart must not reinterpret a relative statement (task 1/2 tests).
2. Historical selection must not bypass a correction/forget between count and send (task 3 snapshot/permit tests).
3. Two concurrent confirmations/corrections must not create overlapping slot intervals (task 2 transaction tests).
4. Unknown dates and legacy timezone-free sources must not become definite historical evidence (tasks 1/3 tests).
5. A quoted/temporary time expression must not become a fact or query capability (tasks 1/4 tests).

## Task 1: Source-bound temporal parsing

**Files:** new `src/main/memory-policy/fact-temporal.ts` and tests; source contracts/ledger/provider capture; natural protocol and tests.
**Interfaces:** pure parser consumes source text, source `occurredAt` and host `timeZone`; returns no temporal marker, unresolved marker, or a bounded validated effective interval plus the factual clause span. Query parser returns an explicit range only from the current authenticated question.

- [ ] Write RED for exact boundaries, ISO invalid dates, yesterday/last month, DST, missing clock/zone, source/quote and one-off distinctions.
- [ ] Persist validated host timezone at source capture, preserving legacy compatibility and unchanged-source recapture; verify with restart fixtures.
- [ ] Implement pure temporal parsing and natural candidate validation without accepting model timestamps or relaxing shadow checks globally.
- [ ] Run targeted tests and Main types, then commit.

## Task 2: Confirmed non-overlapping intervals

**Files:** core schema/fact repository/tests, policy repository/natural journal tests, candidate/settings contracts where needed.
**Interfaces:** activation/correction enforce effective interval overlap in the writer transaction; time-bearing candidate DTO/hash binds source/time revision. Current-record management can enumerate historical records without granting model recall authority.

- [ ] RED: two disjoint confirmed facts coexist; overlapping confirm/correct fails atomically; historical source cannot auto-ADD even when enabled; saved recovery preserves the original interval.
- [ ] Implement transactional index migration and interval checks without changing canonical subject/tombstone identity. Keep corrections as replacement, not historical truth.
- [ ] Verify fault-injected migration/activation rollback, stale confirmation, malformed records, legacy facts and suppression; run core/policy regressions and commit.

## Task 3: Historical facts through final-send authority

**Files:** policy/main-policy, main-fact-selector, recall/context contracts and repositories, main-context, default-memory owner and fact-context framing/tests.
**Interfaces:** optional host-derived range is bound to the current source and propagated through baseline/inspect/snapshot/claim; current default uses transactionNow. Historical eligibility still uses current revision/source/actor/suppression checks and excludes corrected revisions.

- [ ] RED: ordinary question omits expired facts; explicit past question selects the correct interval after reopen; unknown-time evidence is excluded; same source reference anchors relative query.
- [ ] Implement bounded historical eligibility and source-bound query validation at selection and all final-send rechecks, preserving recall visibility and metadata.
- [ ] Race tests: correct/forget/source deletion/project switch after selection invalidate stale context; old index results never restore data. Run context/recall/owner regressions and commit.

## Task 4: User-visible interval management and full closure

**Files:** minimal settings memory panel/contracts/i18n/tests; phase-3 offline Electron acceptance script; validation report.

- [ ] RED UI tests show candidate/active effective periods and keep historical records correctable/forgettable without redesign.
- [ ] Implement minimal display and management wiring; verify real UI/IPC/Worker/SQLite cold closure with fake transport.
- [ ] Independent astra/medium security/quality review; fix required findings with RED/GREEN and reverify.
- [ ] Freeze source; run relevant tests, one full suite, build/types/schema/native/eval contracts. Do not run prohibited SDK/EXE workflows; report these limits.
- [ ] Compare protected trees, retain phase-2 evidence, commit local report and record tested/final SHA, migration/rollback limits and remaining risks.
