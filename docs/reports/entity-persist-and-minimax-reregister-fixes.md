# Entity mention persistence and MiniMax MCP re-registration fixes

Date: 2026-10-20. Status: both bugs reproduced before their respective production fixes; focused regression tests and Main type check pass. Changes remain uncommitted.

## Baseline and scope

- Worktree: `E:/Codex/Firefly_Agent-bgb`.
- Branch: `codex/fix-minimax-entity-persist`.
- Starting HEAD: `b8ebb2edbe09099ba3c37ad46bebd2d54d33c4e1`; starting worktree was clean.
- Existing stacked case-insensitive EntityGraph and Obsidian exporter changes are retained.
- Product changes are limited to `src/main/memory/entity-graph.ts` and `src/main/settings/general-settings-lifecycle.ts`, with their existing test files updated.
- No state-changing Git commands, dependency installation, dependency edits, pinned-file edits, CI changes or full-suite runs were performed.

## Bug 1: repeat entity mentions were not persisted

### Reproduction

Before changing production code, strengthened the existing repeat-mention tests to read `entity-graph.json` directly instead of `entityGraph.load()`, which returns the same cached object. The test creates Alice at time 1000, repeats the mention at 2000, and expects count 2 and last-mention time 2000 on disk without a manual save or unrelated ingestion.

The parameterized test covers an exact name (`Alice`) and a differently-cased alias (`AL`) with only already-known aliases supplied. The existing differently-cased name test also checks the file, covering a repeat with no aliases supplied.

Observed RED: **3 failed, 23 passed**. All three failures read count **1** and last-mention time **1000** from disk instead of **2** and **2000**. These were assertion failures in executed tests, separate from the runner startup errors described below.

### Root cause and bug decision

`ingestEntities` increments `mentionCount` and updates `lastMentionedAt` for every existing match, but previously set `changed` only when adding an alias or entity. A repeat-only batch therefore skipped the final `save()`.

This is a bug: `MemoryScheduler.runQueuedMemoryWrite` calls ingestion after the memory judge and performs no later graph save. Repository caller searches found no production call to `entityGraph.save()`. Search and the Obsidian exporter consume the graph; they do not flush it. There is no caller-level persistence contract that makes this intentional deferred storage.

### Fix and tests

Moved the existing `changed = true` assignment to immediately follow the mention metadata updates. Ingestion still saves once per changed batch; empty and invalid-only batches retain their existing behavior. Matching, original spelling, aliases, IDs and relations are unchanged.

Observed GREEN: **26/26** entity graph tests. Existing coverage includes alias merging, case-insensitive matching/search, relation attachment, invalid input, reset and Jieba registration. The strengthened tests verify actual file contents rather than an in-memory workaround.

### Open decisions

None required for this fix. Atomic file replacement, crash durability during an interrupted write, IO-failure rollback, and broader alias normalization are outside this change. This proves completed ingestion writes the updated JSON, not power-loss safety.

## Bug 2: MiniMax reported successful re-registration after a returned failure

### Reproduction

The implementation is in `src/main/settings/general-settings-lifecycle.ts`, in the historically named `syncVolcanoSearchMcp` function. It is not currently under skills or the MCP manager.

Before changing this implementation, added focused tests using the real sync function and API-key validation with mocked MCP manager operations. The mocks avoid launching `uvx`, contacting MiniMax, using real credentials or changing actual MCP configuration. The existing-server fixture follows the manager's public server-list shape.

With removal succeeding and replacement addition returning `{ ok: false, error: "synthetic connection failure", reason: "unreachable" }`, observed RED: **1 failed, 23 passed**. The returned result was `reregistered`; the expected failure result was `reregister_failed: synthetic connection failure`. Success and rejected-promise cases already passed.

### Root cause and bug decision

The re-registration branch awaited `addMcpServer` but ignored its result. Its catch handles rejected promises only. `mcp-manager.ts` intentionally converts connection and persistence failures into `{ ok: false, error, reason }`; awaiting those fulfilled promises cannot detect failure.

This is a bug: the adjacent initial-registration path explicitly branches on `result.ok` and returns `register_failed: ...` for a returned failure. Successful re-registration must use the same interpretation of `ok`.

Caller review: `handleGeneralSettingsChanged` starts synchronization without consuming its result. `settings-ipc.ts` awaits synchronization when search settings change but returns saved settings, discarding the sync result. Application dependency wiring supplies this same function. Changing settings-save success or adding UI notifications would be a separate product decision.

### Fix and tests

Capture the addition result. For `!result.ok`, log the failure and return `reregister_failed: ${result.error}`. Preserve `reregistered` for success and `reregister_exception: ...` for rejected removal/addition promises. This follows the surrounding string-result convention without changing IPC shapes or the manager's reason taxonomy.

Four new test cases cover successful replacement and its submitted config (including trimmed synthetic key), returned addition failure, rejected removal, and rejected addition. A removal rejection must prevent addition.

Observed GREEN: **24/24** settings lifecycle tests, including the existing window and non-production login-isolation tests.

Review mutation check: temporarily inverted the new `!result.ok` guard. Both success/failure outcome tests failed as expected; both exception tests passed. The other 20 tests were excluded by the test-name filter, not disabled in source. Restored the correct guard and reran both complete focused files: **50/50 passed, zero skipped**.

### Open decisions

None required for truthful sync results. Whether settings-save callers should expose sync failures in the UI, avoid unconditional re-registration on unrelated setting changes, or restore the previous server after a failed replacement remains outside scope. Existing remove-then-add behavior is retained; a failed replacement can leave no registered MiniMax server. No real MiniMax/MCP integration acceptance was performed.

## Verification and environment limitations

Runtime: Node `v24.19.0`; lockfile versions TypeScript `5.9.3`, Vite `7.3.6`, Vitest `4.1.11`. The runner also reported Vitest `4.1.11`.

The default focused invocation initially failed before tests ran:

1. The archive reporter received `EPERM` renaming its report in sandbox TEMP.
2. Redirecting only report output exposed Vite's native source-file `realpath` failure; changing worker pool to threads did not resolve it.
3. A direct Node probe confirmed regular `fs.realpathSync` succeeded while `fs.realpathSync.native` failed with `EPERM` on the same test file.
4. A temporary config using `resolve.preserveSymlinks: true` passed source resolution, then exposed another sandbox TEMP rename failure in the runner cache.

Successful RED/GREEN runs used an ignored local config, inherited all existing test settings, and redirected process-local TEMP/report output into this worktree. The workaround changes file identity resolution only, following [Vite 7's documented `resolve.preserveSymlinks` option](https://v7.vite.dev/config/shared-options#resolve-preservesymlinks). The checked-in test configuration and quality thresholds were not changed. Default-runner execution in this sandbox remains unverified.

Retained local config at `.build-temp/entity-minimax.vitest.config.ts`:

```ts
import base from "../vitest.config";

export default {
  ...base,
  resolve: { preserveSymlinks: true },
};
```

Successful final focused invocation (PowerShell):

```powershell
$env:FIREFLY_TEST_REPORT_ROOT = Join-Path $PWD 'output/entity-minimax-test-reports'
$env:TEMP = Join-Path $PWD '.build-temp/entity-minimax-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
npx vitest run --config .build-temp/entity-minimax.vitest.config.ts src/main/memory/entity-graph.test.ts src/main/settings/general-settings-lifecycle.test.ts
```

Result: exit **0**, **2 files passed, 50 tests passed, zero skipped**. Final archive: `output/entity-minimax-test-reports/2026-10-20T14-22-04-861Z-1063980f-07af-46a3-a2ee-12be5a7b7a5f/report.json`. Earlier RED and environment-failure archives are retained alongside it. These are ignored local artifacts.

- `npx tsc -p tsconfig.main.json --noEmit`: exit **0**, no TypeScript diagnostics.
- `git diff --check`: passed.
- Focused test scope includes the sole `entity-graph*.test.ts` file and the settings lifecycle file that owns the MiniMax branch; no skills or orchestrator implementation was changed.
- No full suite, Electron runtime acceptance, emitted build, packaging or live service verification was run. Verification is bounded to the requested Main type check and focused tests.

> Update: the entity-mention persistence fix (bug 1) was reviewed and merged into the stacked case-insensitive dedup PR (#175), so this PR now carries only the MiniMax re-registration fix (bug 2) and its tests.
