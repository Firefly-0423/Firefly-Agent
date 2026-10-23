# Backend reliability implementation plan

> Execute with `superpowers:executing-plans` and TDD. The initial phase authorized local fixes and tests only. After local verification, the user authorized a precise commit, branch push and draft PR targeting `firefly-mini-v1.1.x`. Merge, auto-merge, deployment, installer/EXE packaging, branch deletion, dependency installation/upgrades, real devices and production task data remain outside scope.

**Base:** `474055fd054f28ec264e82a62448b785ec38a297` (`firefly-mini-v1.1.x`, live remote verified before execution).
**Goal:** Preserve committed scheduler state on IO failures, contain asynchronous errors, report truthful terminal results, and discover complete bounded MCP catalogs without weakening validation.
**Spec:** The four verified findings, three review corrections, interfaces and constraints summarized below are the implementation contract. Detailed local evidence is retained in the ignored per-plan workspace; the PR records the portable results and verification limits without publishing raw logs or temporary artifacts.
**Architecture:** Retain SchedulerStore → Engine → Runner and the existing MCP adapter. Reuse AtomicJsonStore without changing it; keep task JSON/history JSONL and public IPC shapes.

## Constraints and reviewed decisions

- Preserve all other worktrees and their modifications, including ConversationSidebar.tsx. Work only on the isolated backend branch.
- JSON config read/advance failures pause automatic scheduling; history failures fail that run without automatic replay. Do not infer IO origin by parsing arbitrary error strings.
- Persist the scheduled slot's next state before dispatch; failed persistence never dispatches. No zero-delay retry storm, no timer resurrection after stop. Retain the existing no-backfill policy, not an exactly-once claim.
- Execute and close resources before a single terminal convergence. Cleanup failure is runtime_error/failed with explicit notice that execution may already have taken effect; never automatically repeat effects.
- Preserve `terminal?.status ?? 'success'` legacy fallback, history status enums, old normalization including Learn→Work, plugin permission fingerprints and task/history retention limits.
- Reuse public `@modelcontextprotocol/sdk/validation/ajv`: inspect `getValidator(schema)(value).valid`. Validate structuredContent whenever supplied; isError only excuses missing structuredContent. Reject conflicting schema $id instead of reusing a different schema.
- Complete MCP discovery before registration; preserve owner cleanup, cancellation, conservative effect risks and required-task rejection. Proposed generous bounds: 100 pages, 10,000 tools, 60 seconds for complete discovery.
- No dependency or SDK upgrade. Reuse existing dependencies without installation; prevent Electron's auto-download using explicit test-process override/mock. No full dependency copy.

## Review focus

MCP source references: [pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination) and [tool metadata/results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), checked against the installed SDK 1.31.0 `Client.listTools`, `Client.callTool` and public `AjvJsonSchemaValidator` implementations. The SDK clears its metadata cache on each page; the adapter therefore owns complete-catalog validation through public APIs.

- Partial writes, flush/rename failures, or corrupt files must preserve the last committed data, memory, authorization and notification state.
- Corrupt scheduler storage must surface an IPC error and disable scheduling without aborting core initialization.
- Advancement failures and stop/start races must not execute a slot twice or resurrect timers.
- History and cleanup failures must produce one truthful failed outcome; no success toast or automatic retry of possibly applied work.
- Every catalog page must retain output/task validation; cursor cycles, conflicting schemas, failed pages and stale owners must not publish a partial or wrongly owned catalog.

### Task 1: Scheduler persistence

**Files:** scheduler/scheduler-store.ts, scheduler/scheduler-ipc.ts and focused tests. Reuse main/atomic-json-store.ts unchanged.
**Interface:** keep createSchedulerStore public methods. Internal commitTasks(next) persists `{tasks:next}` before assigning/notification. Corrupt load records a private error; task reads/mutations reject until successful load, while initialize itself remains nonfatal.

- [x] Add RED tests for partial writes and rename failures on add/update/delete/toggle/deleteTasksByOwner; unchanged memory/file/no notification; corrupted config and history, recovery load, old normalization and clone isolation.
- [x] Reuse AtomicJsonStore with envelope validation compatible with existing normalized old records. Clone schedules and arrays across the public boundary. Add local atomic JSONL replace with owned-temp cleanup; only ENOENT is an empty file.
- [x] Catch list IPC errors consistently with existing mutation handlers. No automatic backup restoration.
- [x] Verify scheduler store/IPC/bootstrap/execution-spec, AtomicJsonStore and plugin scheduler integration.

### Task 2: Scheduler error ownership

**Files:** scheduler/scheduler-engine.ts and tests; runner boundary work is completed with Task 3 so terminal reporting stays unified.
**Interface:** retain engine API and runningTaskIds lifetime. Internal running/paused state gates all scheduling and refresh paths.

- [x] Add RED tests for rejected run, config read/advance failure, other due tasks continuing, no zero-delay loops, stop/refresh/late-settlement behavior and a default-Node rejection subprocess.
- [x] Persist nextFireAt/once-disable before dispatch. Catch config failures at that boundary and pause; catch background run rejections separately without reusing a broken history writer.
- [x] Re-arm only while active and healthy. refreshPluginTasks must not bypass pause/stop. Explicit start retries recovery; no automatic replay.
- [x] Verify engine and bootstrap suites, then combined scheduler regression.

### Task 3: Scheduler terminal convergence

**Files:** scheduler/scheduler-runner.ts, scheduler-engine.ts and tests; retain types and IPC result shapes.
**Interface:** runOne returns ScheduledRunResult or undefined for a skipped run; fireNow maps actual failure to existing reason shape.

- [x] Add RED tests for success/timeout/cancelled/runtime_error/no-terminal, delayed or rejected close, initial/final history failure, single lifecycle publication, no false toast and fireNow/IPC failure propagation.
- [x] Bring initial history/started actions under the execution error boundary. Capture execution and cleanup outcomes, then once-only finalization. Non-success is history failed/result false; close failures warn about possibly applied work. Persistence failure prevents a success result; no recursive failed-write attempts.
- [x] Preserve partial reply and existing failure fields. Do not migrate old history or extend enums.
- [x] Verify runner, engine, IPC, background lifetime and plugin lifecycle consumers.

### Task 4: MCP paginated discovery

**Files:** orchestrator/mcp-adapter.ts, at most one small MCP metadata helper if needed, lifecycle/pagination tests.
**Interface:** preserve connectMcpServer(config, owner?) and tool IDs. Derive catalog tool types from SDK, retain full metadata.

- [x] Add RED tests for multiple/empty pages, cursor cycle, duplicate name, bounded totals/deadline, second-page failure/close, no partial registry, every page's output schema and required-task validation.
- [x] Read cursors sequentially, enforce complete-catalog bounds and existing ownership cleanup. Never invoke private SDK cache APIs.
- [x] Keep per-connection complete metadata and public schema validators, including conflicting $id checks and SDK-compatible isError behavior. Preserve SDK callTool transport and request signals.
- [x] Run pagination, existing MCP lifecycle/effect/SSE and Main typecheck.

## Completion

- Each task must have observed RED→GREEN evidence and recorded commands/results in the per-plan ledger.
- Run combined regressions, storage-boundary check, Main typecheck and appropriate broader tests. The project full test command will be attempted only with the same offline/profile isolation; report any environmental failures explicitly instead of installing or changing assertions.
- One fresh independent final review is required by executing-plans. Fix important findings with RED→GREEN and repeat affected/combined verification.
- Preserve local uncommitted work and evidence; do not delete the plan workspace because there are no authorized commits to preserve it in Git history.

## Local implementation outcome

All four tasks and the one independent final review fix pass are complete. Review found 0 Critical, 3 Important and 0 Minor; all Important findings have observed failing regressions and passing coverage. Final fixes also preserve valid cross-tool schema references and anonymous document-local anchors while rejecting conflicting resolved resource IDs.

- Full suite: **11,189 passed, 0 failed, 11 skipped** across 900 files (899 passed, 1 skipped); exit 0, 0 unhandled errors. Existing platform/symlink privilege gates account for skips; no new skipped tests were added.
- Directed scheduler/MCP/native-fixture regression: **289/289 passed** in 24 files.
- Main TypeScript no-emit check and storage boundary check pass (88 allowlisted accesses in 46 files).
- The first complete run exposed only a missing native test helper. Its existing Rust source was built with the installed toolchain using `--offline --locked`, and the final full run explicitly selected that helper; no download, dependency upgrade or lockfile change occurred.
- Final source fingerprints match all 13 changed/new source files; the full-run archive recorded identical starting/ending diff hashes.
- Local branch `codex/backend-reliability-20261018` remains based on `474055fd054f28ec264e82a62448b785ec38a297`, which still matches the target remote and contains #117, #118 and #119.

Evidence remains in `.superpowers/sdd/2026-10-18-backend-reliability/`: `handoff.json`, `progress.md`, `final-directed.log`, `final-verified-full-regression.log`, and `reports/2026-10-18T12-50-02-967Z-a0bb917b-e187-4782-b361-8c83221a2e31/report.json`. The native helper is in `native-target/debug/` there. Test cache/reports/build artifacts are isolated; shared installed node_modules were reused without installation or modification.

The local-verification phase preserved this linked worktree and its uncommitted helper/tests/plan. That phase performed no commit, push, PR, merge, branch deletion, external plugin, real-device operation or production user data access. Existing preview UI work was not modified. No remaining blocker was known within the four-task scope.

## Draft PR handoff

After accepting the local result, the user authorized committing these four fixes and their tests/plan, pushing the isolated branch and creating a draft PR. The target remains `firefly-mini-v1.1.x`; this does not authorize merging, auto-merge, deployment, installer/EXE packaging or deleting any branch.

Publication preflight reconfirmed all 13 source fingerprints against the completed full run, an empty renderer diff and no untracked renderer files. The shared dependency lock record and relevant installed versions predate the test run and remain unchanged. Only the 14 explicit backend source/test/plan paths are included; generated helpers, test caches, reports, logs and temporary directories remain excluded.

The target remote still points to the original base, so no rebase or combination repair is needed. Existing UI PRs use separate branches. This PR preserves the local verification evidence above, discloses the one independent review and its three corrected Important findings without claiming a second review, and leaves real Electron GUI acceptance unverified. CI for the published commit is tracked separately from the local results.
