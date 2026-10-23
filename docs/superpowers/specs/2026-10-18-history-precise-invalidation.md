# H precise invalidation

Baseline: a38c34829b5d6265b6f6f03b2d642f584ec05340. Authorized repair of the H safety barrier; no retrieval tuning or M/S behavior expansion.

## Root cause and decision

HistoryRepository.hasSupersededOrigin treats any owned corrected fact as invalidating every untraceable document. MainHistory and NativeHistoryProvider reject all unbound acquisition after any forget. Native documents always have empty sourceDeps, so these gates permanently exclude unrelated and future history.

Removing these checks would resurrect raw copies. Matching text or trusting parser-supplied dependencies would have the same defect. Instead persist authenticated, exact event origins, then recover only atomic groups whose origins are complete and still valid. Old unproved history remains quarantined with an explicit coverage gap.

## Trust and persistence

Add schema v12 history_origins: HMAC identity indexes and encrypted metadata, no plaintext messages. Identity includes actor, provider, session and canonical event identity. Receipts bind exact canonical entry digest, sequence, role, turn/revision and source versions. Native file acquisition remains mandatory and proves the current active projection. Native/parser DTOs never mint credentials.

User origins are registered from the verified current direct-user source and canonical entry. This repair implements no automatic legacy rebuilding. An old source ledger lacking exact canonical identity cannot mint a receipt. Independent source/transcript clocks need not equal; original event time is retained. Unknown old users remain isolated.

Assistant/tool origins are recorded only after successful guarded canonical append. Worker freezes the actual claimed snapshot's selected source, fact, history, summary and transcript dependencies at event granularity. No dependency claims come from model output. Missing closure is permanently marked incomplete. Mutable transcript heads are acquisition fences, not long-term dependencies. Failed/uncertain append or absent receipt cannot grant historical access.

## Revocation and recovery

Every query and final context materialization validates receipt identity, source versions, deleted/suppressed sources, corrected assertions and recursive event dependencies in the Worker transaction. Normal temporal facts with independent validity intervals remain distinct from correction of an erroneous assertion. An unrelated actor/session/project never supplies ownership for another partition.

Native acquisition always requires exact receipts, including before any M correction or forget, and may return safe user events and complete derived atomic groups while excluding unproved/invalid groups. Tool pairing remains atomic. Partial coverage always propagates to the context notice; no empty result implies absence of history. Reacquisition after restart proves the current files and uses durable receipts. Cached evidence and old indexes cannot bypass revalidation.

Production acceptance found ordinary Chat success did not create a canonical snapshot, preventing new small conversations from becoming readable H after restart. The authorized minimal writer fix awaits the existing session-bound checkpoint after successful output/settlement and before RUN_FINISHED. Checkpoint failure propagates without discarding the transcript. H remains read-only; Work/Code and generic checkpoint policy remain unchanged. Final Electron acceptance uses ordinary UI completion, with no harness checkpoint.

## Constraints and rollback

Only synthetic databases, fake transports and isolated Electron profiles. No real keys, real databases, external services, paid calls, SDK/package installation, packaging, push, PR, merge or deployment. Baseline worktrees and reports remain untouched.

Schema migration is transactional and preserves all existing encrypted records. Old binaries reject v12: source-code rollback alone is not database rollback. Restore a pre-upgrade database backup or implement and verify a separate down migration before downgrading; do not discard origin safety records in place.

H deletion freezes a document identity/owner/incarnation dependency for output receipts and precisely revokes native document event identities, so derived echoes and alternate projections stay blocked. Canonical delete/repair/rewind observers revoke affected receipts before mutation. Ordinary append preserves earlier valid events. Graph validation uses memoization, depth 64 and a 1000-node/source/document budget; exceeding it fails closed.
