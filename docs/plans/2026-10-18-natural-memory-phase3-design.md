# Phase 3: explicit valid-time memory

## Authorized goal and baseline

Continue the user's third stage (time semantics and historical memory) from local, unpublished phase-2 `d7ef9822974287af4089a9f6d208ec9d3e8913b2`. Work uses the already isolated tree on `codex/memory-phase3-temporal-20261018`; phase-2 branch and evidence remain intact. Current Claude local head `7975f155` adds settings/model-routing changes beyond mini `9f94f79b`; these are not silently merged into the memory base. Other worktrees, dependencies, profiles, processes and databases are not edited.

The earlier plans only name “complex time” as a later stage, not a detailed implementation. On 2026-10-18 the user explicitly confirmed this product boundary: past facts that actually held may be recalled; content corrected as erroneous, forgotten, or losing its source must not return through historical queries. This specification makes the implementation choices explicit rather than claiming they existed in the earlier plan.

## Chosen approach and alternatives

Extend the existing typed fact/source/policy/context pipeline. Keep system recording/acceptance clocks independent of the user's asserted effective interval. Support explicit, conservatively parsed calendar periods and relative periods anchored to the original authenticated message time and host-recorded timezone. Temporal facts always require confirmation in this stage; the phase-2 default-off ADD/support whitelist stays unchanged.

Rejected: exposing every immutable revision as history, because a correction can mean the old assertion was false. Also rejected: a parallel timeline database or model-generated timestamp authority. Both increase privacy/reconciliation risk and bypass the existing final-send checks.

## Product semantics

- `validFrom` inclusive and `validTo` exclusive describe when a fact holds. `referenceTime` is the authenticated source's original event time; recorded/accepted/superseded times remain writer transaction times. Unknown stays unknown, not a fabricated current timestamp.
- Explicit calendar ranges and named calendar periods are supported, initially Chinese/English ISO dates plus today/yesterday/last week/last month. Relative expression resolution uses the message's persisted host timezone, never extraction/recovery wall time. Invalid date, missing anchor/timezone, contradictory or vague time is unresolved, never silently current.
- One-off instructions remain ineligible. Only an anchored time clause attached to an otherwise validated first-person low-sensitivity factual assertion can become a temporal candidate. Existing schema, source span, subject, sensitivity, negation, quotation/hypothesis and instruction checks remain mandatory. The model cannot supply clock, scope or permission.
- A confirmed past period is historical and does not influence an ordinary current question. An explicit time question can select facts overlapping its window, with effective-time and system-time metadata visible to the model. Partial overlap is labeled; unknown effective intervals are not proof of a historical period. No attempt is made to answer “what the system knew as of an old transaction time”; immutable audit records remain internal.
- Disjoint intervals may coexist in the same canonical slot. Overlapping conflicting intervals cannot be confirmed. An undated fact is conservatively open-ended for conflict checks. A new statement never silently closes or replaces an existing interval; users use explicit correction to resolve it.
- Correction replaces the selected fact immediately and retires its erroneous revision from all current/historical recall. A new true historical interval is a separately confirmed assertion, not an old corrected revision. Forget remains synchronous and blocks the whole canonical subject/source history under existing suppression rules; it cannot be bypassed by choosing another time.
- Settings must expose historical/future active records with their effective period so they can be corrected or forgotten. Only minimal metadata/text changes, no React UI redesign. Candidate confirmation hashes bind all time metadata.
- Historical reads remain subject to current actor/project/source/revision/suppression permissions at selection, snapshot and final wire send. No new renderer query authority. Temporary sessions still exit before persistence/extraction.

## Persistence and compatibility

Reuse the encrypted ledger and current-fact projections. Replace the unique active-slot index only if required for non-overlapping intervals; keep the same keyed canonical subject index and every old tombstone. Enforce interval conflict checks inside the single writer transaction on activation and correction. Schema upgrade must be transactional; malformed/future schemas fail closed. No real user database is upgraded here. Older code must refuse a newer schema rather than misread multiple intervals. Rollback requires a matched pre-upgrade private backup/key set; never rewrite encrypted user rows by hand.

Source timezone is host metadata, validated and stored with the source observation, preserved across recapture/recovery. Legacy sources lacking it remain readable; relative temporal extraction from them fails closed. Explicit absolute dates also require a declared host calendar zone rather than guessing UTC.

## Acceptance and constraints

Use synthetic fixed clocks/timezones, temporary SQLite and fake model transport. Acceptance: natural historical statement -> pending with visible dates -> confirmation -> close/reopen -> explicit historical question actually selects it, ordinary current question does not -> current non-overlapping assertion -> correction removes erroneous old content from both modes -> forget -> reopen/late result/stale snapshot cannot revive it. Cover DST/month boundaries, missing/invalid dates, source edits/deletion, scope isolation, overlapping confirmation races, correction/forget races, interrupted migration and legacy facts.

No graph/vector/hybrid retrieval, automatic persona rewriting, Learn/Work/Code experience workflow, new dependency, real provider/credentials/data, SDK check/pack/install, EXE packaging, deployment, push or PR. Existing per-feature attribution deferral remains. The user's instruction to record a plan then implement, plus confirmed historical privacy boundary, authorizes execution without repeated generic skill approval handoffs. Material new product ambiguities still pause only dependent work.
