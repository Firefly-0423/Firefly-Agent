# External skills bounded follow-up

Authorization: parent delegation after first-batch delivery, 2026-10-18. Fix the two reported minors, integrate the latest development target in isolation while preserving original commits and Claude changes, then plan and continue only the approved device simulation. No push, PR, target merge, real GUI/install, candidate execution/download, SDK/application packaging, accounts/devices or real credentials.

## Preserved baseline and environment

- Original branch `codex/external-skills-batch1-20261018` stays at `ad392a5420966a1dd4233f4f51a6233162513fbd`; tested code `6f237ec` and all first-batch evidence remain unchanged.
- Tail work starts from that exact head on `codex/external-skills-tail-20261018` in the existing task-only worktree. Reuse its node_modules, isolated npm/Cargo data, synthetic user, native test helper and empty Electron override. New logs/archive go to `audit/followup/`; install/download scripts remain prohibited.
- Integration creates a separate branch from the freshly resolved `firefly-mini-v1.1.x`, then replays the original and tail commits in order. Original branch references and commit objects remain intact; no local target merge or remote mutation. Verify the replay and the complete file delta; retain all unrelated latest/Claude content.

## Task A: two regression-driven fixes

- [x] Add real adapter tests for manifest-over-entry Claude version precedence, fallback and malformed canonical version; service commit records the canonical bundle version while remaining disabled.
- [x] Observe the wrong-precedence assertion fail, then use manifest version first, followed by entry and existing catalog fallback.
- [x] Add metadata-mode tests for portable, Codex, Claude and MCP files: return a blocked candidate with validated repository-relative `file-mode` evidence, do not read the unsupported blob, expose no local private paths. Keep ignored legacy overlay behavior and all other error checks.
- [x] Observe mode tests fail before changing code. Convert only the internal unsupported-metadata-mode case to a bounded blocked DTO; keep declaration blocked, full import ineligible and zero stage/state. Preserve known earlier issues.
- [x] Run affected and external/React regression tests; Main/preload/renderer type checks. Update compatibility documentation to resolve the two minors; preserve the historical first-batch report. Commit locally.

## Task B: integration and combination validation

- [x] Read-only fetch the actual latest target; inspect its AGENTS/delta and preserve original refs. Start isolated integration branch from that commit and replay the bounded commits without merging into any target.
- [x] Verify original/replayed commit mapping and unrelated Claude/vendor files. Do not modify/recreate PR115 or duplicate its repair.
- [x] Run external/React plus changed plugin marketplace/runtime/manager/version-store regressions, required compile/storage checks and one complete project suite on the integrated tree. First preflight the previously missing tracked README target and Electron override. Record all failures/skips, without weakening tests or thresholds.
- [x] Save separate follow-up QA, current progress and local handoff; report the actual completed batch before device implementation.

## Task C: device simulation handoff

After A/B, inspect existing MCP tools, permissions, ownership and persistence seams. Write the device simulation spec and concrete implementation plan covering light/AC/curtain fixtures, read-only state, action preview, least authorization, durable pending commands and receipt validation. The already granted simulation authorization permits continuing after the plan is concrete; keep real accounts/devices/credentials and executable external candidates out of scope. Do not rebuild MCP or silently register live endpoints.
