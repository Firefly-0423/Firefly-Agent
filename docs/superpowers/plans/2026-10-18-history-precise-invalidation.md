# H Precise Invalidation Implementation Plan

> Execute inline using executing-plans and TDD; independent gpt-6-astra/medium review after implementation. User has already authorized the repair and this execution method.

**Goal:** Restore provably independent H after corrections/forget without resurrecting revoked origins.

**Architecture:** Authenticated event receipts link native history to trusted user sources or the actual claimed context dependency closure. Revalidate these durable origins transactionally and preserve coverage gaps for unknown legacy data.

**Tech Stack:** TypeScript, encrypted SQLite Worker repositories, native read-only acquisition, Vitest, isolated Electron.

**Spec:** ../specs/2026-10-18-history-precise-invalidation.md

## Global constraints

- Baseline a38c34829b5d6265b6f6f03b2d642f584ec05340; only this isolated worktree changes.
- No real keys/data/services, paid calls, SDK installation, packaging, push, PR, merge or deploy.
- No parser/model-declared authority; unknown legacy history stays fail closed.
- Use source/event versions and actual selected dependencies, never wall-clock inference.

## Review focus

- Partial provenance, same IDs with changed bytes and snapshot reconstruction cannot mint freshness.
- Cross-session derived echoes inherit all actual M/H/S/current dependencies.
- Ordinary appends do not revoke independent past history; corrections and deletion do.
- Cached evidence racing revocation fails at final materialization.
- v11 migration interruption preserves old records; rollback requires backup or verified down migration.

## Task 1: Durable origin repository

Files: `memory-core/schema.ts`, `memory-history/history-origins.ts` and `.test.ts`. Worker contracts: `historyUserOrigin`, `historyResponseOrigin`, `originStatus`, `retireOrigins`, `projectNative`. Critical tests cover two pre-correction independent sessions, deleted/rewound assistant descendants, v11 interrupted migration, unknown native cache with generation zero, and large partial projections.

- [x] Add failing tests for v12 migration and independent/invalid origin behavior.
- [x] Run targeted tests and retain RED evidence.
- [x] Add metadata-only origin ledger, bounded identity validation, dependency validation and schema migration.
- [x] Run targeted tests to GREEN.

## Task 2: Trusted producers and native recovery

Files: `default-run-capture.ts`, `main-s-runtime-port.ts`, `main-context.ts`, `context-repository.ts`, `conversation-transcript-adapter.ts`, `transcript-ledger.ts`, `main-history.ts`, `history-repository.ts`, `native-history-provider.ts`, `scoped-history-query.ts`. Main reads trusted user evidence before the canonical lease; inside it registration performs only Worker I/O. Response closure selects only transmitted summary/H segments and freezes claimed snapshot dependencies. Native projection returns `{documents,partial}`; partial coverage remains visible during context assembly.

Review additions: output closure stores H document owner/incarnation dependencies; native H deletion revokes exact events. Graph validation has memoization and a total budget. S registers its assistant only after successful settlement. No automatic legacy rebuild is implemented.

Electron discovery and authorized minimal addition: `orchestrator/firefly-agent.ts` awaits the existing writer's checkpoint after ordinary Chat success and durable output/settlement, before success terminal acknowledgement. Failure surfaces without rewriting JSONL. Work/Code and H read-only paths remain unchanged. RED: `checkpoint-red`; GREEN: `checkpoint-green` (79 tests). Final Electron must have no harness checkpoint.

- [x] Add failing live-user/guarded-response and native recovery tests, including restart and partial coverage.
- [x] Record user origins from verified canonical sources and output origins from claimed snapshots after successful append.
- [x] Filter native history into safe atomic groups; propagate incomplete coverage without blocking safe groups.
- [x] Validate full receipts in H query and final context materialization; retain legacy barriers otherwise.
- [x] Run targeted suite to GREEN, including two unrelated pre-correction sessions.

## Task 3: Review and verification

- [x] Run type checks, targeted and full suite with isolated environment.
- [x] Run real isolated Electron acceptance with fake model transport and synthetic data.
- [x] Independent review; reproduce and fix material findings with RED/GREEN evidence.
- [x] Commit implementation and reports; report exact HEAD, evidence, remaining limits and database rollback boundary.
