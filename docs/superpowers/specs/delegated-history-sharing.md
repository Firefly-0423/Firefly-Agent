# Delegated history sharing

Status: approved by the owner 2026-10-26 (snapshot at delegation time). Baseline: branch docs/readme-showcase. Decision B from the 2026-10-26 review: children use the history the parent already acquired instead of acquiring it again.

## Problem

A delegated child is prepared with `readParentGrant` (`src/main/orchestrator/child-session-runtime.ts:123`). Its read set is the parent actor plus the parent's read actors (`src/main/memory-context/main-default-memory.ts:697`). On each turn the child's history step calls `historical.native.capture(signal)` on the native provider that belongs to each of those sessions (`main-default-memory.ts:358-361`).

The native provider is single-consumer by design:

- `capture()` refuses while another capture is publishing (`src/main/memory-sources/native-history-provider.ts:139`), and `query()` refuses while one is publishing (`:169`).
- `capture()` starts with `revoke()` (`:140`). It moves the epoch, so every earlier evidence handle of that provider fails `evidenceGate` with `MEMORY_HISTORY_STALE`.
- Test `simultaneous captures cannot share an epoch or publication eligibility` pins this (`native-history-provider.test.ts:117`).

So two children of one parent conflict in two ways:

1. They capture at the same time. The second capture fails with `MEMORY_HISTORY_STALE`, and the child run fails with `E_CONTEXT_FAILURE`.
2. They capture one after the other. The later capture revokes the evidence the earlier child selected. That child then fails when its context is materialized or its witness is published.

Both rules are intended. Children must read the parent's history (`default-entry-adapters.test.ts:57`), and a provider serves one consumer per epoch. Neither rule is the bug: the bug is that every child turn acquires again.

## Decision

The parent's family acquires each read actor once and the children share that acquisition. The provider stays single-consumer, because only one caller ever calls `capture()`.

### Delegation history lease

Add a `DelegationHistoryLease`, owned by the main memory runtime and keyed by the parent run grant.

- `capture(actorToken, signal)`: single-flight per actor.
  - If a capture for that actor is in flight, return the same promise.
  - If the last outcome is still current, return it. "Current" means the provider epoch has not moved since that capture.
  - Otherwise start one new capture.
  - The caller's signal only detaches that caller. The shared capture is aborted only when every attached caller has aborted or the lease is closed.
- `query` is unchanged. Each child still runs `history.query` with its own prompt over the covered partition. Queries do not publish, so they can run at the same time against one committed cursor.
- Lifetime: the lease is created on the first child prepared with a given `readParentGrant`. It closes when the parent grant is revoked, through the existing `liveRunAuthority` path. Closing aborts any in-flight capture.

In `main-default-memory.ts`, the child branch of `capture: token => ...` goes through the lease when the run has a parent grant. Runs without a parent (the normal chat, scheduler and proactive paths) keep calling `native.capture` directly, so their behaviour does not change.

### Invalidation

Children see the parent's history as of delegation time (open question 1, decided). When the parent transcript changes later, `beforeMutation` → `invalidate` still moves the provider epoch for everyone else, but the family's pinned outcome and each child's already materialized history are not re-read. A delete/repair/rewind of the parent transcript (`retireOrigins`) is the exception: it revokes the lease, and children fall back to no parent history with a coverage notice, so retracted content never survives in a child.

### What does not change

- The provider still refuses two direct concurrent captures. The pinned test keeps passing.
- Children still read the parent's history. The test at `default-entry-adapters.test.ts:57` keeps passing.
- Read authority is unchanged. The lease only shares captures among runs whose `readActorTokens` came from the same parent grant, and it never widens the read set.
- Unrelated families reading the same session are not coalesced. They keep today's behaviour; see open question 2.

## Tests to add

1. Two children prepared from one parent grant run their history step at the same time. Both succeed, and the provider sees exactly one `capture()`.
2. Child A selects evidence, then child B runs its history step. A's evidence is still valid, because no second capture happens.
3. A parent append after delegation does not re-capture and does not fail the child; a parent delete/rewind revokes the lease and the child continues with a coverage notice.
4. Aborting one child's signal does not abort the shared capture of a sibling. Aborting all of them, or revoking the parent grant, does.
5. A run without a parent grant still calls `native.capture` directly. A regression guard asserts that the lease is not used.
6. A lease never serves a token that is not in the caller's own `readActorTokens`. The result is `MEMORY_ACTOR_DENIED`.

## Open questions for the owner

1. Decided 2026-10-26: a child reads the parent's history as it was at delegation time, not live. This matches OpenAI Agents SDK handoffs (the new agent receives the history at handoff) and fork-style subagents (Claude Code, OpenClaw, Letta), and keeps a background partner's behaviour reproducible while the user keeps chatting. Mechanism: the lease captures once when the first child of a delegation is prepared and pins that outcome for the lease lifetime; a later parent mutation does not trigger a re-capture for that family. The child materializes the selected history into its own context once, so a later epoch move of the parent's provider cannot invalidate it. If the user wants a running partner to see something new, that is an explicit message to the partner (future work), never an implicit re-read.
2. A normal chat run in another session can also read the parent session and collide with a family capture. That is rare and stays out of scope. If it shows up in practice, a per-provider capture queue would fix it.
3. Rollback: a single flag in the child branch restores the direct `native.capture` call.

## As built (2026-10-31)

The real run on 2026-10-30 showed one more victim than the problem statement lists: the parent itself. The parent's history step had already captured the sessions it reads. Its children read the same sessions, and their captures revoked the parent's evidence. The parent's next tool_result append then failed validation (`MEMORY_HISTORY_STALE` → `E_TOOL_EXECUTION_FAILED`).

What was built differs from the lease above in two ways. Both keep the provider's rules unchanged.

1. **The sharing lives on the provider: `captureShared()` in `native-history-provider.ts`.**
   - It reuses the last committed capture while the provider epoch has not moved, or joins the shared capture in flight. Only when neither exists does it capture.
   - A direct `capture()` in progress is still refused, so the pinned single-consumer test is unchanged.
   - `main-default-memory.ts` routes only delegated children (a background entry with a parent grant) to it. Every other run keeps calling `capture()`.
   - Because the epoch is the provider's own, nothing is pinned per family and no separate lifetime is needed. Any revoke (forget, history removal, delete, repair, rewind, grant change, teardown) ends the reuse at once.
   - The caller's signal only detaches that caller. The shared capture keeps the provider's own deadline.
2. **Delegation-time snapshot: the scheduler, not the provider.**
   - Partners are synchronous: the parent waits for `delegate_agent`.
   - The only parent append while a partner runs is a sibling's result committed early. `tool-call-scheduler.ts` now holds every commit, and every new launch, while a partner in the group is still running.
   - The parent transcript therefore does not change under a running partner. A halting commit still stops everything after it.
   - A user deleting or rewinding the parent transcript mid-run still revokes, as before. That is the retraction case the design wants to fail closed.

Tests:
- `native-history-provider.test.ts`:
  - concurrent shared callers join one acquisition;
  - a current capture is reused and the parent's evidence stays valid;
  - a moved epoch captures again;
  - a detaching caller does not cancel its siblings;
  - a direct capture is still refused meanwhile.
- `main-default-memory.test.ts`: two children of one parent run their history step together and both read the parent context. Without the routing this fails with `MEMORY_HISTORY_STALE`.
- `tool-call-scheduler.test.ts`: commits wait for the running partners, and a halt still stops later launches.

Not covered, unchanged from open question 2: a normal run in another session that captures a session a family is reading.
