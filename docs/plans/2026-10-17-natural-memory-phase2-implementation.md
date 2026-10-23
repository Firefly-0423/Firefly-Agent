# Natural-memory phase 2 implementation plan

## Resume baseline — 2026-10-18

The human resumed after Claude merged PR112. The exact remote mini base is now `9f94f79b8ad12777d23bf432fe0f8f33bc99c4fc`, with original `d2a58dba` as its first parent. Work remains in the same isolated `firefly-memory-phase2` directory on `codex/memory-phase2-post-ui-20261018`. The old feature branch at `8c7c0891` and all paused dirty files are preserved; all nine task commits replayed with an equal range-diff. No shared branch or owner checkout was merged/reset/changed. The original baseline paragraphs below are historical. The latest resume explicitly asks for an independent re-review after the two verified authority repairs; this supersedes the earlier one-review workflow restriction. Per-feature usage implementation remains out of scope; the newly merged upstream usage layer is retained.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline in this task. Steps use checkbox syntax; one independent whole-branch security/quality review follows implementation.

**Goal:** Add explicit default-off conservative ADD-only memory with durable bounded extraction/recovery.

**Architecture:** Keep network work outside SQLite/host mutation queues. A versioned journal in existing jobs binds source/actor/generation/profile/consent; a program whitelist and current-store checks authorize only new low-risk slots or independent duplicate supports.

**Tech Stack:** Existing TypeScript, Node24 SQLite, Electron, Vitest/Playwright; no dependency or CI change.

**Spec:** [Phase2 design](2026-10-17-natural-memory-phase2-design.md).

## Global constraints

- Base `d2a58dbae9f6392bdf0df109c23633f84e39c191` (user-merged PR109); only `E:/Codex/2026-10-17/task/firefly-memory-phase2`, local branch `codex/memory-phase2-mini-20261017`, is editable for phase2. The original task1 commit7e2569a, old54ee branch and two pre-mini draft copies remain preserved. Task1 is now444d50ee; the authorized review repairs are separate local commits before task2. PR109 CI succeeded and its publication is complete; no further push/comment/resolve to that merged PR or owner's UI/process change is allowed.
- Publication/Claude/preview/old feature trees and all remote refs are untouched. No phase2 content in the phase1 PR.
- Private physical dependencies and per-process TEMP/TMP/profile/database/cache; fake model and usage only, no real credentials/API or user DB.
- Default-off per-class consent; first whitelist language zh/en and style concise/detailed, positive exact durable self-statements only. Scope ambiguity refuses global writes.
- ADD/support only; no automatic correction/deletion or old shadow/chat backfill. Synchronous correct/forget and all suppression checks stay authoritative.
- Daily20 dispatch reservations /100,000 estimated token-budget units; output800, request16,384 bytes, result32,768 bytes; retry0. Seven-day retention, nonterminal100/rows1000. Never present estimated units as exact billing.
- No added skip/only/type/lint suppression, weakened assertions/thresholds, new checker/dependency or unrelated refactor.

## Review focus

1. A crafted ordinary user/model/renderer payload cannot enable a category, invent scope or bypass program/source checks.
2. A settings off/on cycle fences a result from the old consent epoch, including locally saved recovery.
3. A process crash at every side of the dispatch/save/apply boundary never causes a blind paid retry or duplicate support/fact.
4. A synchronous correction/deletion or changed source/project wins over every late/saved result and old nomination.
5. Missing/corrupt usage, controls or journal metadata closes dispatch/promotion without leaking content or resetting reservations.

## Task 1: Program eligibility and bounded contracts

**Files:** Create `src/main/memory-policy/natural-automation.ts` and `.test.ts`; shared automation DTOs in `src/shared/memory-automation-contracts.ts`.

**Interfaces:** `automaticNaturalProposal(text:string, proposals:readonly NaturalProposal[]):NaturalProposal|null`; `NaturalAutomationConfig` has revision/language/responseStyle; fixed `NATURAL_JOB_LIMITS` and finite phase/reason types.

- [x] Write table tests: exact Chinese/English durable zh/en/concise/detailed are admitted; bare requests, one-off, quote, hypothesis, negative, confidence/scope additions, multiple clauses/facts and non-whitelisted categories are not.
- [x] Run `scripts/testing/run-tests.mjs src/main/memory-policy/natural-automation.test.ts --reporter=dot`; observe missing behavior RED.
- [x] Implement the pure gate using existing validation and canonical typed values; no model-reported confidence.
- [x] Run the whole new file plus existing natural-memory tests; commit the focused gate/contracts.

## Task 2: Versioned journal, consent and budgets

**Files:** Create `src/main/memory-policy/natural-job-repository.ts` and `.test.ts`; small early dispatch in `policy-repository.ts`.

**Interfaces:** Policy transport kind `naturalJob` with a parsed `operation`; operations `state/configure/enqueue/dispatch/save/block/get/list/apply`. Every mutation has a durable commandId. Repository consumes source/actor/scope plus an application callback; returns bounded metadata/results. Existing jobs row state maps exactly to the design's finer payload phases.

- [x] Write real temporary/in-memory SQLite tests for default controls, CAS consent/user-source authority, deterministic enqueue, unknown reservation, saved canonical result, local apply receipt, corrupt/legacy namespace denial and each resource cap.
- [x] Run the new repository file RED; inspect actual missing operation/phase failure, not an import/setup mistake.
- [x] Implement strict encrypted payload/version validation, transaction-clock reads, parameterized SQL and receipt/phase checks. Save normalized admitted proposals, never raw rejected bodies/source copies. Reserve once, no refund/retry; lazy expiry cannot reauthorize old input.
- [x] Test reopen at unsent/unknown/saved/applied, save/apply fault rollback, clock rollback/overflow/malformed usage and quota closure; generic core job tests still pass. Commit.

## Task 3: Atomic ADD/support application

**Files:** Modify `policy-repository.ts`, `fact-repository.ts` only if a distinct automatic policy version is needed; create `src/main/memory-policy/natural-automation-integration.test.ts`.

**Interfaces:** Saved-result application callback invokes validated natural insertion with job consent binding. Program authorizes inside the same transaction as job completion; no public Main/model `auto=true` field. Outcome retains existing `IntegrationResult`/`PolicyOutcome` shape.

- [x] Write API-level RED tests: default pending, selective opt-in ADD, independent canonical duplicate support without revision, same-source replay, conflict/denial/negative -> pending; flags/revision/source/generation cannot be forged.
- [x] Implement internal optional authorization context from the journal only; recheck control revision/current store, program gate, source/time/suppression and independent supports. Preserve deterministic/manual paths.
- [x] Test off/on while saved, correct/forget and source mutation before apply, stale candidates/nominations and fault rollback. Run policy/core regressions and commit.

## Task 4: Main transport, runner and recovery ownership

**Files:** Create `src/main/memory-policy/natural-extraction-runner.ts` and `.test.ts`; extend `main-policy.ts`, `shadow-model-call.ts` and `main-default-memory.ts` minimally.

**Interfaces:** Runner `run(actor,sourceRef,model,signal)` and `recover(actor,modelFactory,signal)` use only journal methods and host-bound profiles. Prepared transport exposes verified request-byte/output-limit metadata; optional for old direct phase1 callers, mandatory for the phase2 runner. Host startup rebinds only owned persistent session sources.

- [x] RED tests count actual fake transport sends across restart boundaries: unknown zero resend; saved zero prepare/send; unsent once; applied idempotent. Invalid limits/profile/scope or temporary actor sends nothing and writes no journal.
- [x] Implement enqueue/preflight -> durable dispatch reservation -> send -> validated save -> local apply. No network wait holds actor/settings SQL coordination. Track/abort/drain owned tasks on shutdown and retain mini aggregate request/usage callbacks; per-feature attribution remains explicitly deferred.
- [x] Test deletion/consent/profile/source changes while fake send is blocked, result cap/malformed provider metadata, late result and concurrent duplicate runners; run Main/transport/usage regressions, commit.

## Task 5: Explicit settings-only opt-in

**Files:** New `src/main/memory-policy/memory-automation-settings-ipc.ts` / tests, shared contracts, small `main-default-memory.ts`/composition/preload/IPC changes; minimal `src/renderer/settings/memory/automation-panel.ts` / tests and existing settings DOM/i18n wiring.

**Interfaces:** Separate `MemoryAutomationPanelApi` exposes `state()` and `configure({expectedRevision,language,responseStyle})`; separate window bridge avoids weakening existing panel contracts. Host creates an independent settings user source and only authorized mainFrame changes flags; state contains switches/counts/finite reasons only.

- [x] RED tests unauthorized/stale/revoked-frame and malformed/confidence/scope payloads cannot mutate; unavailable/default-off display, per-class toggle and stale-revision refresh work.
- [x] Implement two necessary controls using existing settings styles/text encoding, no panel redesign or source-button polish. Recheck frame authority after awaits and preserve opt-in persistence.
- [x] Run IPC/preload/settings/host regressions and types; commit.

## Task 6: Safety closure and final review

**Files:** New focused phase2 acceptance/verification script and `docs/reports/2026-10-17-natural-memory-phase2-validation.md`; evidence remains synthetic/task-owned.

**Interfaces:** Exercise actual owner/settings/SQLite/reopen/request selection with fake provider, plus all recovery/crash/consent/deletion cases. Source manifests bind final checks to one frozen commit.

- [x] Run default-off -> explicit class opt-in -> automatic ADD -> reopen/new-session selection -> duplicate support -> conflict pending -> disable -> correct/forget -> restart/late-result denial; independently test crash saved/unknown recovery.
- [ ] Run related tests, project full suite once after implementation, normal build/Main/preload/renderer types, storage/schema and required offline/native checks. Record existing skips/warnings and any named failure; no real API/DB/app preview.
- [x] Dispatch one fresh whole-branch `gpt-6.1-sol`/`max` security/quality reviewer with the spec, plan, ledger and five focus points. Material findings get actual RED/GREEN repairs and the required suite re-run; retain declined-to-judge limits.
- [x] Commit only local phase2 work; compare protected tree identities/states, report tested/final SHA, commands, limits and rollback. Keep completed phase1 publication/CI and Claude's target UI untouched.

Final verification 2026-10-18: frozen cafd211 completed actual Electron closure (28 checks, three launches/closes) and full suite (10,781 passed, 11 inherited skips; identical source manifests), plus schema/native/eval contracts and types/build. SDK check remains uncompleted: direct verifier lacked dist, then compilation/verification request was rejected before execution by automatic approval under the no-package/install boundary. No retry/bypass; separate authorization remains pending. The verification checkbox stays open for that explicit limitation. See docs/reports/2026-10-18-natural-memory-phase2-validation.md. Final repair reviewer used the user's superseding gpt-6-astra/medium request; original whole review and race re-review used 6.1-sol/max.
