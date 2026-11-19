# Natural-memory phase 2 design

## Resume baseline — 2026-10-18

The human resumed after Claude merged PR112. The exact remote mini base is now `9f94f79b8ad12777d23bf432fe0f8f33bc99c4fc`, with original `d2a58dba` as its first parent. Work remains in the same isolated `firefly-memory-phase2` directory on `codex/memory-phase2-post-ui-20261018`. The old feature branch at `8c7c0891` and all paused dirty files are preserved; all nine task commits replayed with an equal range-diff. No shared branch or owner checkout was merged/reset/changed. The original baseline paragraphs below are historical. The latest resume explicitly asks for an independent re-review after the two verified authority repairs; this supersedes the earlier one-review workflow restriction. Per-feature usage implementation remains out of scope; the newly merged upstream usage layer is retained.

## Goal and fixed baseline

Continue from the verified mini phase1 merge `d2a58dbae9f6392bdf0df109c23633f84e39c191` in local branch `codex/memory-phase2-mini-20261017`, at `E:/Codex/2026-10-17/task/firefly-memory-phase2`. The user merged PR109 at 13:51:26 UTC and then authorized continued isolated phase2 work and two review follow-ups. Its parents are mini931997e1 and the published phase1 head28eb55d9; both published CI runs succeeded. Only the task-owned phase2 commit was replayed onto that exact merge, from7e2569a to444d50ee, with the original preserved in `codex/memory-phase2-before-merged-mini-20261017`. The old54ee phase2 branch, two pre-mini draft copies and private dependencies also remain preserved. The two verified settings-edit and failure-metadata repairs are separate local commits; no additional push, comment or resolve is made to the merged PR109. No owner's UI checkout, Claude process, unrelated inspector history, deployment or publication is involved.

The user wants optional, program-authorized low-risk ADD-only memory and restart-safe extraction. Success is an opt-in fact added and recalled without a confirmation click, independent duplicate evidence without replacement, conflict held pending, disabling consent fencing an in-flight result, and no resurrection after correction/deletion or recovery. Model confidence never grants authority.

## Options and selected architecture

1. **Selected: extend the existing SQLite writer with a separately versioned natural-job protocol and conservative program gate.** Reuse sources, jobs, encrypted payloads, immutable facts, command receipts, suppression and actor coordination. Keep network I/O outside write/host-setting queues. This is the smallest boundary compatible with synchronous correction/forgetting.
2. Reuse the generic core job lease/reclaim behavior unchanged. Rejected: an expired lease could resend a request whose result is unknown and charge twice.
3. Add another queue service or memory framework. Rejected: more ownership/recovery boundaries without solving provider-side exactly-once execution.

No framework/dependency/CI changes, vector/graph work, Android, Work/Code learning, complex temporal queries or UI redesign. Necessary opt-in controls only are added to the existing settings surface.

## Automatic policy

- `language` and `response-style` are independently **false** by default. The first whitelist is `zh`/`en` and `concise`/`detailed`, positive polarity only. Address, tools and general preferences stay pending even if a model is confident.
- The program must recognize the entire short source as one explicit, first-person, durable self-statement. Initial grammar supports tightly anchored Chinese and English forms such as `我一直用中文交流`, `我长期偏好用英语交流`, `I always prefer English for our chats.`, `我一直偏好简洁的回复`, `I always prefer concise replies.` and detailed equivalents. It is deliberately incomplete.
- Reuse all phase-1 schema, unique evidence-span, self-subject, sensitivity, quote, hypothetical, temporal/context and instruction filters. Program-derived category/value must equal the validated model proposal. Quoted/hypothetical/negative/assistant-suggested/one-off, multi-fact or unsupported expressions remain pending or are rejected by existing validation.
- Only host-owned persistent direct-user sources with clear global scope qualify. Project-bound/ambiguous scope is refused before durable enqueue and before application; no global fallback. Temporary/chat-assistant/tool paths create no job/control/result row or model request.
- Consent is changed only through the authorized settings frame and a source-backed user operation, with compare-and-swap revision. A job captures that revision. Application rechecks current flags **and exact revision**; an off/on cycle cannot authorize old work. Default-off jobs are never backfilled automatically after enabling.
- At application, the writer rechecks source fingerprint/revision/trust, scope, suppression generation, subject suppression, time and current facts. A clean empty slot may ADD. An eligible same canonical fact may receive an independent user-message support, without a fact revision/value replacement. Same-source replay adds no evidence. Any different/negative/denied/ineligible existing fact holds the proposal pending. Existing explicit deterministic paths remain intact.
- Correct/forget remain synchronous, outside network queues. Old generations, stale nominations and saved/late model results cannot override them. Memory remains sourced untrusted user data, with no system/tool authority.

## Durable jobs, idempotency and recovery

Use namespace/version-tagged encrypted records in the existing `jobs` table; no DDL/schema version change. Existing generic job APIs remain unchanged and fail closed if given a new protocol record. Source IDs, scope and actor are host-derived. A deterministic job identity binds source revision, actor/scope and protocol; one source cannot start another extraction on replay.

| Logical phase | Existing row state | Recovery behavior |
| --- | --- | --- |
| `unsent` | `pending` | Prepare/validate locally, then reserve once and dispatch if current/budgeted |
| `result-unknown` | `running` | May have crossed the provider boundary; never auto-resend |
| `result-saved` | `recorded` | Re-read source and apply only local validation/storage; never prepare/send a model call |
| `applied` | `complete` | Return durable result; no second application |
| `blocked` | `invalidated` | Terminal finite reason, no automatic retry |

`result-unknown` is durably committed before calling transport. A crash in the remaining send boundary may conservatively quarantine a request that never reached the provider. This is preferable to a duplicate charge. Timeout/network/cancellation after this boundary stays unknown; a known provider refusal becomes blocked. There is no exactly-once provider/billing claim and no automatic network retry (`maxRetries=0`).

Before storing a successful result, the writer independently validates and normalizes it against the current source. Store only admitted bounded proposals in canonical form, source/profile/protocol/hash bindings and finite metadata, never arbitrary rejected model bodies or another copy of source text. Result application and durable `applied` transition share one transaction/receipt. A crash after result save can recover locally; a crash after receipt replays the same outcome.

Recovery enumerates only this protocol's existing jobs, never old shadow records or historical chats without jobs. The Main owner re-establishes source/actor/session ownership from current host data; deleted, temporary, changed-project or unavailable sessions fail closed. Startup/explicit recovery pumps only unsent/saved jobs, one at a time; settings mutations do not wait behind network I/O. Owner shutdown aborts and drains owned tasks before closing the writer.

## Resource and retention boundaries

- At most 20 dispatch reservations per actor/UTC day; at most 100,000 conservatively reserved token-budget units/day. Reserve before dispatch and never refund an unknown/failed request. Clock rollback cannot reset a budget.
- At most 800 requested output tokens, 16,384 UTF-8 request bytes, 32,768 result bytes and the existing 4,000 user characters / five proposals. A prepared request without verified limits fails closed.
- The conservative input reservation uses the existing bounded-byte convention (`wire bytes + 1024`) plus output reserve, and is explicitly labeled an estimate. It is not an exact tokenizer or provider invoice ceiling. Actual usage is validated; malformed/over-reserve usage closes further dispatch for the day. Known quota/rate-limit refusal also closes the day. Hard local request/input/output limits remain independent of usage reporting.
- No real counting API, credential inspection or paid provider call during development/acceptance. Use fake transports and synthetic usage; a future provider's honoring/token accounting cannot be certified here.
- Maximum 100 nonterminal jobs/actor and 1,000 protocol job rows/actor, with seven-day retention. Lazy transactional expiry removes expired job/result copies; durable command receipts remain to prevent historical input from starting another call. Applied results are reduced to outcome metadata; rejected raw bodies are never retained. Budget/control records are one current record each per actor.
- No raw exception/provider body in logs/renderer. Settings expose switches/revisions, finite stop reasons and aggregate counts only, never source contents, keys or paths.

## Trust boundaries and abuse cases

The untrusted boundaries are model JSON, renderer settings input, old/corrupt encrypted records and source changes while a request is outside the writer. Host capabilities bind authority; SQL is parameterized and records versioned. Tests first attempt forged flags/confidence/scope, stale consent revisions, mismatched source/profile, duplicate save/apply commands, crash boundaries, expired/legacy jobs, budget overflow/rollback and deletion after dispatch/save. All must fail closed without a second network call or unwanted fact.

## Safety acceptance

1. Default-off durable natural statement -> pending only; explicit per-class opt-in -> only exact first-person durable whitelist facts ADD; another class remains pending.
2. Same fact/new independent message -> one fact/revision, extra support; replay/source revision reuse adds no support. Conflict/negative/denied facts never overwrite.
3. Off while a fake request is blocked -> result cannot auto-promote; off/on does not revive its prior consent epoch.
4. Crash before send, after unknown, after saved result, during local application and after receipt; reopen SQLite. Only unsent dispatches once; saved applies without model preparation; unknown never resends; applied replays once.
5. Correct/forget before a late result or saved-result recovery; old candidates/index nominations/generations never revive values. Include source deletion/edit and corrupt records.
6. Actor/scope/project/session isolation and temporary zero persistence; arbitrary model authorization fields, quote/hypothesis/negation/assistant suggestion never promote.
7. All caps, unknown-charge reservation, provider/usage failure closure, retention and malformed metadata tested with synthetic clocks/storage/transport.
8. Relevant existing tests, full project suite, Main/preload/renderer builds/types/storage/schema checks, and an isolated actual settings/runtime mock-provider smoke. Independent whole-branch security review; material findings require RED/GREEN repair and full verification. No real DB/profile/provider or preview instance.

## Review and rollback

Execute inline with TDD and one fresh final security/quality review on the requested `gpt-6.1-sol`/`max`; keep a durable task ledger. The user's instruction to design/plan and then continue overrides generic repeated approval handoffs; a material new product decision still pauses its dependent portion. No new numeric CI/coverage bar is invented; keep existing assertions/checks and the constraint floor.

All changes remain reversible on the phase2 branch. Default-off settings do not silently become opt-in; stale/missing/corrupt controls deny automatic promotion. Stop using this branch to discard it. A future used database must be closed/backed up with its key set before rollout; do not manually rewrite encrypted records or reset any user worktree.
