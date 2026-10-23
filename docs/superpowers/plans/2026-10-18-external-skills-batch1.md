# External Skills Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make external skill review state accurate, preserve reachable approved revisions, and parse supported upstream text formats without granting execution capabilities.

**Architecture:** Keep authority in Main. Extend the existing five-method bridge with an optional validated revision selector; attach read-only version and diagnostic DTOs while preserving strict installed manifests. Resolve approved revisions from the application review table and recheck all pinned bytes under a named policy.

**Tech Stack:** Node 24, TypeScript, React 19, Vitest 4, existing safe YAML/frontmatter parser and GitHub fixed-commit fetcher; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-18-external-skills-batch1.md`

## Global Constraints

- Only `openai/plugins` and `anthropics/skills`; no candidate execution, lifecycle scripts, credentials, real user state or devices.
- Independent worktree, npm cache/config and dependencies; `npm ci --ignore-scripts` only.
- Preserve whole skill payload, exact source/commit/path/digest/policy approval, licenses, byte/path bounds, token ownership, rollback and default disabled import.
- Preserve baseline chat/sidebar changes; do not integrate unavailable `2d53b41`, edit other tasks, run `check:plugin-sdk`, package SDK/EXE, merge or deploy.
- No new tests skips, assertion removal, safety suppression or threshold lowering. Use real parser and production modules with synthetic local fixtures.

## Review Focus

- A failed review followed by a slow detail response must not overwrite a newly selected source or version (Task 1).
- Upstream removes a skill or changes bytes at HEAD: the reviewed fixed revision remains reachable, without approving HEAD (Task 2).
- A malicious Renderer requests arbitrary commit, path, policy or review data: selector is an assertion, never new authority (Task 2).
- A portable manifest has both an inline overlay and a compatibility file: use documented precedence, no unsafe component merging (Task 3).
- Mixed packages, empty MCP configs and unsupported file modes: show exact limitations without silently stripping or executing anything (Task 3).

---

### Task 1: Accurate review failure state and mode copy

**Files:** Modify `src/renderer/react/features/chat/components/ExternalSkillsPanel.tsx`, `SkillModePanel.tsx`, `ExternalSkillsPanel.copy.ts`, `src/renderer/react/i18n/en.json`, `zh-CN.json`; test existing `ExternalSkillsPanel.test.ts`, `SkillModePanel.test.ts`.

**Interfaces:** Consumes existing `ExternalSkillsApi.detail/prepare`; produces refreshed, generation-checked detail after prepare failure, identity checks including commit/path, and a dedicated external-market subtitle.

- [x] Write React regressions: dependency rejection refreshes detail and disables retry; detail refresh failure removes stale actionable state; late failure-detail cannot replace another source; mismatched prepared commit rejected; subtitle covers Work/Code and preview displays known dependency blocker.
- [x] Run `npm test -- ExternalSkillsPanel.test.ts SkillModePanel.test.ts`; observe expected assertions fail for stale state/copy.
- [x] Implement refresh-after-failure with the same operation ticket; keep admission until refresh completes, and validate full identity. Prefer known dependency blockers over generic incomplete-preview copy.
- [x] Run the same tests; expect PASS including existing cancellation, focus and commit lock cases.
- [x] Commit only task files and plan/spec.

### Task 2: Version identities and policy-bound fixed snapshots

**Files:** Modify `src/shared/external-skills.ts`, `src/main/skills/external-types.ts`, `external-policy.ts`, `external-reviews.ts`, `external-review.ts`, `external-service.ts`, `external-sources.ts`, `external-ipc.ts`, `src/preload/index.ts`, external-market renderer; extend related contract/bridge/IPC/service/review fixtures/tests. Create focused `src/main/skills/external-revisions.ts` and its tests if selection logic needs a separate unit.

**Interfaces:** `ExternalSkillSelection { kind: "latest" | "reviewed"; commit: string }` optional third argument of bridge detail/prepare (fourth in service after owner); read-only `ExternalSkill.revisions` describes latest, reviewed digest/policy and installed digest/enabled. `ExternalSkillReview.policyVersion: string` is required for matching; `EXTERNAL_REVIEW_POLICY_VERSION` is the single current value. Discovery accepts an optional Main-chosen pinned commit.

- [x] Write service/IPC/bridge/review tests for advancing HEAD, removed latest candidate, explicit old revision, wrong expected commit, malformed/extra selector fields, source/path/digest/policy mismatch, duplicate reviews and installed identity. Add renderer version choice and mismatch/stale response tests.
- [x] Run focused external tests and observe feature assertions fail.
- [x] Implement trusted review selection, bounded latest/reviewed snapshot caches, fixed-commit discovery, DTO decoration, strict selector validation and current-policy matching. Keep new display fields out of persisted skill data; installed identity must be verified committed proof, never a listing hint.
- [x] Add UI version controls and separate status rows. New latest bytes remain unreviewed; old static review is labeled and fully revalidated on prepare. Preserve unavailable-HEAD access to reviewed entry where feasible without hiding discovery errors.
- [x] Run all external tests plus renderer tests/typechecks; expect PASS, no changed installation authority.
- [x] Commit this task.

### Task 3: Upstream format adapters and actionable compatibility evidence

**Files:** Modify `external-sources.ts`, `external-review.ts`, `external-service.ts`, shared external DTO and renderer translations; create a focused manifest compatibility parser if needed; extend source/review/service/integration tests.

**Interfaces:** Source declaration verification returns original skill identity plus verified bundle metadata and bounded coded component/path issues. Full review adds bounded file/frontmatter/instruction issues. Original candidate blockers remain authoritative; no derived payload is produced.

- [x] Write source fixtures for root portable `plugin.json`/`skills/`, inline OpenAI overlay precedence, legacy Codex, Claude manifest/default/custom directories and current Anthropic catalog. Write rejects for nonempty MCP/hooks/commands/dependencies, traversal, non-text files and executable modes; empty MCP object must never execute.
- [x] Run focused tests and observe unsupported-layout and missing-diagnostic assertions fail.
- [x] Implement only documented local formats and passive bounded JSON reads. Classify unsupported component paths/keys; preserve canonical path/byte/hash checks and original whole skill directory. Never load entrypoints or expand auth/env templates.
- [x] Run real parser and all external/renderer regressions; expect pure-text fixtures eligible only with exact static approval and mixed/Remotion-shape fixtures still blocked with no stage.
- [x] Commit this task and update source/compatibility documentation.

### Task 4: Full verification, independent review and delivery

**Files:** Add a concise validation report under `docs/qa/`; implementation fixes only for verified important findings.

**Interfaces:** Consumes entire branch diff against `88443aa`; produces local commits, reproducible command results, remaining limitations and PR status.

- [x] Run `npm test`, relevant Node script tests, `tsc -p tsconfig.main.json`, `npm run build:preload`, `npm run check:renderer`, `npm run build:renderer`, storage boundary check; inspect failures against the clean baseline using the same isolated dependencies if necessary, without modifying unrelated failures.
- [x] Dispatch one fresh independent reviewer for the complete diff, spec, plan, ledger and test evidence. Cover all Review Focus lines, approval/cache/race boundaries and upstream semantics.
- [x] Grade findings; reproduce important findings with failing tests, fix once and run affected and complete suites. Record deferred minor issues and explicit decisions.
- [x] Write evidence with exact counts, environment limitations and skipped/not-run items. Make final local commit; inspect `git diff --check`, status, log and modified files.
- [x] Hand the verified local branch and review evidence to the parent for coordinated PR delivery; do not publish the unfinished first batch or merge/deploy. The parent coordinates the already completed separate plugin-market repair PR.
