# Workspace handle access implementation plan

**Goal:** Bind restricted Windows workspace traversal and I/O to native handles.
**Spec:** The user's 2026-10-20 request and the fully read `research-toctou.out`.
**Baseline:** `codex/sec-handle`, `a33977df34c1c1f69aeb62e23e1f1093ff139dda`, initially clean.
**Architecture:** Extract the existing history reader's NT open, inspection, name validation, and local NTFS primitives. A private helper pins the authorized root/ancestors and leaf throughout a transaction. TS receives immutable bytes for guards and evidence, commits through the same handle, and consumes the resulting bytes. Directory enumeration uses NtQueryDirectoryFile.

## Constraints

- No state-changing git commands, commits, node_modules changes, pinned-file edits, new dependencies, CI policy changes, or full Vitest run.
- Preserve history behavior/tests and unrestricted tool behavior; retain live-level intersection and allow_all.
- Windows helper failures fail closed; non-Windows explicitly uses the old path guard with its known race.
- Test barriers exist only under cfg(test); there is no production environment switch.
- Follow the authorized implementation inline. The user's execution request supersedes skill handoff/commit steps.

## Tasks

- [ ] Native backend: test rejection and successful operations first; extract shared primitives; implement WorkspaceBackend/WorkspaceFile traits and Windows backend; unsupported backend returns an explicit error.
  - Interfaces: open root once; read/stat/list/prepare_write; file snapshot and commit(mode, bytes) retain ancestors and target handle.
  - Verify: `cargo test --features history-read,workspace-handle`, then Clippy.
- [ ] Bridge: mock-process tests for protocol, lifecycle, timeout, platform and permission behavior; implement bounded JSON lines and private packaged/development resolution.
  - Interfaces: readWorkspaceFile, listWorkspaceDirectory, statWorkspaceEntry, withWorkspaceWrite; immutable snapshots and a leased write callback.
  - Verify: focused workspace-handle Vitest and main typecheck.
- [ ] Callers and evidence: route restricted reads/listing/image/write/replacement through the bridge; supply native before/after snapshots to write evidence and review. Persist restricted review observations so finalization never reopens the workspace path.
  - Verify: caller routing, existing fs/life/boundary/evidence/review tests. Explain mechanism-specific test updates in the report.
- [ ] Packaging: add the helper resource and mirrored build/PE-verification scripts; retain existing history build contracts.
  - Verify: Node script tests, release helper build/PE verification, real helper protocol smoke.
- [ ] Race/security review: independent-thread attacks at root/ancestor/parent-create/leaf-I/O barriers, double swap, sentinel bytes/names/IDs and actual I/O identity assertions; final focused regression/typecheck/hashes and report.

## Review focus

- Opening an existing write target must not truncate before inspection and TS overwrite checks.
- Missing descendants must be created only under retained parent handles, without an absolute reopen.
- Enumeration and child metadata must never resolve a workspace path again.
- Permission downgrades before commit must stop the write; unavailable helpers cannot trigger a Windows fallback.
- Evidence/review must consume the same native observations, including after a helper failure or tracker restart.

## Progress

- Research report read fully as UTF-8; original Node check/use and all named call sites inspected.
- Superpowers bundle found in the local plugin cache; planning, execution, TDD and debugging instructions read. Existing user constraints define the quality bar; no new tools or thresholds are installed.

- Implementation and packaging are complete and uncommitted. Independent review found four Important issues; the single fix pass added alias, downgrade, large-file and shared-writer regressions and platform-neutral IDs.
- Main typecheck passes; focused TS: 220 passed, 30 EPERM failures, 2 existing skips; new tests: 63 passed. Packaging: 49 passed, 1 existing skip. Workspace/history release builds and PE verification pass.
- Native library: 39 passed, 9 fixture-access failures; bin protocols: 6 passed; workspace contracts: 3 passed, 2 denied link fixtures. Clippy/rustfmt are blocked during configuration/path discovery. Native adversarial acceptance remains pending, not complete.
- All 7 canonical and raw pinned hashes match. See docs/reports/2026-10-20-workspace-handle-access.md for commands, limitations and the 36-file inventory.
