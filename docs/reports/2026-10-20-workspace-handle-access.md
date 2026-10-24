# Workspace handle access — 2026-10-20

Implemented in the uncommitted worktree on `codex/sec-handle`, based on `a33977df34c1c1f69aeb62e23e1f1093ff139dda` (the supplied PR #168 baseline). **Security acceptance is incomplete:** the sandbox denies the link fixtures and native canonicalization needed by several acceptance tests. This report does not classify those tests as passing.

No commit, push, checkout, stash, reset, dependency installation, permission change, or CI-policy change was performed. `node_modules` was not edited. All seven pinned files retain both their approved canonical-LF SHA-256 and their original raw-byte SHA-256.

## Design and scope

The Windows handle guarantee applies only to the five migrated operations listed below. It does not cover every tool using a restricted permission level.

The research report at `E:/Codex/Firefly_Agent-skills-layout/output/rewrite-tools/research-toctou.out` was read completely as UTF-8 before implementation. Its double-swap counterexample is addressed by binding traversal and data I/O to handles, rather than comparing an opened file against a subsequently resolved path.

| Effective permission condition | Access mechanism |
| --- | --- |
| Read with a `project-read-only` snapshot or intersecting live level | Windows native handles |
| Write with a `scoped` snapshot or intersecting live level | Windows native handles |
| Write intersecting `read-only` or `project-read-only` | Denied |
| Other authorized levels, including full/per-action | Direct filesystem operations |
| Non-Windows | Existing path guard and direct filesystem fallback; residual TOCTOU race remains |

The existing snapshot/live intersection is preserved. An `allow_all` run continues to use its snapshot without intersecting the live global level. Legacy calls without a permission snapshot retain their existing scope.
Write denial takes precedence over restricted-backend selection.

`workspaceRestriction` shares the original permission decision between the path guard and bridge. Direct-path branches recheck after async handoffs, before review capture and post-write metadata, and after evidence subscriber callbacks. A downgrade cannot leave a Windows restricted operation on an already selected path branch. Errors after a completed mutation retain an unknown effect where appropriate; already observed applied evidence is preserved.

## Native implementation

`native/src/handle_fs.rs` contains the NT open, metadata, component-validation, plain-type and local-NTFS primitives extracted from `history_read.rs`. History's public error/identity contract, read-only access, sharing, budgets and test modules are preserved. The history test and observer module bodies were compared with `git show HEAD:native/src/history_read.rs` and are unchanged.

The new `firefly-workspace` binary is built with `workspace-handle`, which enables the existing WDK bindings through `history-read`.

- Each helper transaction acquires its authorized root once with `OBJ_DONT_REPARSE`, validates a plain directory on local NTFS, and retains it. Every workspace descendant is opened one component at a time with `RootDirectory`; traversed directory handles stay alive until the operation ends.
- Files and directories are checked through their opened handles. Unexpected attributes/types and reparse points are refused. Regular files must have exactly one observed link. Remote filesystems and non-NTFS filesystems are refused.
- Existing write targets use `FILE_OPEN`, with no overwrite/supersede disposition. Their preimages are read through the validated handle. TS performs overwrite-drop checks or string-replacement matching on those bytes. Replace commit rechecks the handle, seeks to zero, writes the new bytes, truncates to the new length only after a successful write, then calls `sync_all`. The same handle retains identity, ACLs and pinning. Writes are **not atomic**: interruption can leave a new prefix mixed with the old, unwritten tail; flushing does not turn this into an atomic replace.
- Missing descendants are not created during preparation. Commit creates directories and the leaf with exclusive `FILE_CREATE` relative to retained parents. A competing entry causes rejection; there is no cleanup by an original pathname.
- Listing uses `NtQueryDirectoryFile(FileNamesInformation)` on the retained directory. Child metadata is opened relative to that directory. One unusual/blocked child (including a reparse or multi-link child) aborts `list_dir` as a whole. Follow-up: return blocked entries with a reason, without ever following them.
- Read/image bytes, stat metadata, preimages and after-images come from handles. Canonical names are queried from the handle using normalized `VOLUME_NAME_NONE`; they are not a second path-based containment proof.

The root open checks the entire absolute root for reparses. It does not retain directory handles above the authorized root. Root lifetime is one helper transaction, not the lifetime of a conversation binding.

Names reject separators, traversal components, ADS colons, reserved DOS names, control characters and trailing dots/spaces. Standard `\\?\` local drive prefixes and long paths are supported. SUBST/short-root aliases are rejected when their normalized root name differs; target casing/aliases use handle-derived names and identities.

These choices follow Microsoft's [RootDirectory and create-disposition semantics](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile), [OBJ_DONT_REPARSE contract](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes), [directory-query API](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntquerydirectoryfile), and [handle-name API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew).

## Bridge, callers and evidence

The bridge uses private JSON-lines pipes, strict response shapes, bounded hexadecimal byte payloads, a 30-second deadline, a parent-process watchdog, release acknowledgement and process closure. It uses no shell or PATH search. Packaged resolution is `resources/bin/firefly-workspace.exe`; development resolution is `native/target/release/firefly-workspace.exe`, matching the existing history-helper layout.

On restricted Windows access, errors never select a path fallback. Strict error frames contain exactly `type`, `version`, `code` and typed `reason`; native reparse-point/hard-link/outside-root reasons reach the thrown TS `WorkspaceError` with public code `E_WORKSPACE_BOUNDARY`. Sharing violations return `E_WORKSPACE_BUSY`, independently of boundary rejection. Native I/O, missing and budget failures have separate TS codes. Missing executables still fail closed with reason `missing`; malformed frames have reason `protocol`. `workspaceHandleSupport` explicitly reports `workspace-unsupported-platform` elsewhere. The TS public functions return the documented fallback sentinel for unsupported/unrestricted calls.

Only read requests (including image/preimage reads) and directory listing retry sharing violations: at most five attempts, 40 ms between attempts (at most 160 ms backoff), with a 250 ms retry-start budget. Each attempt closes its helper before starting another. Helper startup/I/O/exit scheduling is not a hard real-time guarantee. Write lease preparation and commits never retry; sharing stays `FILE_SHARE_READ` everywhere. Once a commit request is sent, helper termination by abort/deadline, transport loss or an invalid after-image throws `E_WORKSPACE_UNKNOWN_EFFECTS`, with `effectState: unknown` and the cause in `reason`. An expired lease that never sends a commit remains `not_applied`.

Operational limits are 32 MiB per native file snapshot/write, 100,000 directory entries, 512 relative components, 255 UTF-16 units per component, 16,000 UTF-16 units for bridge/root path strings, and a JSON frame budget of twice the byte limit plus 128 KiB. Existing `read_file` and image budgets remain 10/5 MiB. Large frames are assembled once from fragments rather than repeatedly copied.

Exactly these five operations go through the helper on Windows:

| Operation | Helper scope |
| --- | --- |
| fs-tools `read_file` | `project-read-only`: file bytes/metadata |
| fs-tools `list_dir` | `project-read-only`: enumeration and child metadata |
| fs-tools `read_image` | `project-read-only`: image bytes/metadata |
| fs-tools `write_file` | `scoped`: replace/append, preimage and commit |
| life-tools `str_replace` | `scoped`: preimage and commit |

These conditions also apply when the effective level is restricted by the live-level intersection. Native observations supply overwrite checks, diffs, byte hashes, child sizes, post-write size and canonical write ownership for these operations.

`apply-patch`, `ast-grep` and `document-tools` only pass `ctx` to `captureBefore`; their actual reads/writes remain pathname-based under `scoped` / `project-read-only`. They have **not** been migrated to handle-bound operations. Follow-up migration estimates (rough engineering effort, not completed work): apply-patch **3–5 days**, ast-grep **1–2 days**, document-tools **2–3 days**. Review preimage capture does not make their mutations handle-safe.

Review observations persist in the existing private review store. Once a run uses handle access, finalization consumes stored authorized observations for its captures. Captured identities and alias mappings correlate casing and controlled short-name aliases; finalization does not resolve an old spelling again. Shared async/synchronous write batches refresh observations for later authorized patch, AST and document mutations, including deletion and rename. Failed/unknown observations remain unknown rather than causing a path retry or a fabricated deletion. A later permission downgrade can omit an unavailable version while retaining known applied facts.

Unrestricted review acquisition uses one ordinary Node fd for bytes and fstat identity. This is allowed unrestricted/fallback I/O, **not** the rejected open-first containment design. Native containment relies on the root/ancestor chain. ADS/remote unrestricted observations are kept separate from local default-stream alias identities.

Protected review represents the last authorized observed version. It does not perform a fresh workspace scan at finalization and does not promise to include external edits made after that observation. Manual restore operations retain their existing authorization and implementation.

## Cross-platform contract and Unix plan

The Rust `WorkspaceBackend` and `WorkspaceFile` traits define root acquisition, read/stat/list, prepared writes and commit. `Snapshot` and the private wire protocol are backend independent. Workspace identities contain fixed 32-hex-digit `deviceId` and `fileId` strings, preserving up to 128 bits each; future Unix dev/ino values require no TS contract change. The history identity contract remains unchanged.

No Unix filesystem backend is shipped. The unsupported Rust implementation returns an explicit error, and TS keeps the existing path-level behavior. The existing native crate also contains Windows screenshot modules; a Unix helper build has not been established.

Future implementation work:

1. Make the helper's build surface portable or isolate it from Windows screenshot modules; implement Unix parent/deadline supervision.
2. Open and retain root/ancestor fds, use `openat` with `O_NOFOLLOW`, `O_DIRECTORY` and `O_CLOEXEC`, and validate type, device and link count through fstat.
3. Use `mkdirat` and exclusive relative creation under retained parents. Open existing files without `O_TRUNC`; truncate only after validation. Use `unlinkat` only for explicitly authorized handle-relative cleanup.
4. Enumerate a retained directory descriptor, for example with `fdopendir` on a duplicate; never reopen a directory pathname.
5. Add Unix filesystem policy, symlink/mount/hard-link races and device acceptance tests, then enable that platform in the internal selector. Keep the existing TS method and wire shapes.

## Tests and independent review

New Rust tests cover normal read/replace/append/stat/list, preparation without truncation or parent creation, pinned-parent creation, long/prefixed paths, casing, names/ADS, root/mid/leaf reparses and hard links. `cfg(test)` barriers cover root/ancestor acquisition, parent-create and leaf-I/O boundaries. Independent OS threads perform the attacks. Test-only native junction/hard-link fixtures avoid relying solely on shell behavior. The APIs used are documented by Microsoft for [reparse buffers](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer), [setting reparses](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_reparse_point) and [hard-link information](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_link_information).

Race assertions check external sentinel bytes, directory entries and file/directory IDs, plus actual content/list I/O identities. Where the OS refuses replacement of an already pinned object, the operation may safely finish on that original object. The positive reparse-injection and double-swap tests require successful fixture construction and remain failures when that construction is denied. No production environment variable or feature enables the workspace test barriers.

An independent read-only reviewer found no Critical issue and four Important issues. All four were addressed in one fix pass:

| Finding | Regression coverage |
| --- | --- |
| Alternate spellings could escape review protection | Mixed unrestricted/native casing and controlled short-name alias captures; no target path I/O at finalization |
| Subscriber downgrades could permit capture/stat by path | Before-capture and applied-evidence subscriber cases; actual applied bytes/facts retained |
| Native preimages above 5 MiB could disappear from review | Changed and unchanged 6 MiB snapshots with exact before/after hashes |
| Later writers could leave protected review unknown | Shared async/sync mutation plumbing with patch-like write, delete and rename |

The review's identity-width readiness concern was also addressed with workspace-only opaque IDs. The final fix pass was verified by the author; there was no second independent review. A platform-condition mutation caused **27/34 bridge tests to fail**; restoration returned **34/34 passing** with the original file hash restored.

The differential review used the supplied base and current uncommitted files. Baseline history was inspected with read-only log/blame: `b78c36c9` introduced the tool boundary, `f3c486d5` added live intersection/hard-link checks, `e49436f0` retained `allow_all`, and `3d2ce62c` added the native history binder. No permission check was removed without replacement. An AST scan of 653 production Main TS files found 8 `beginWriteBatch`, 7 `captureBefore`, 2 `finalizeReview`, 2 `canonicalWriteIdentity`, 2 write-ownership claim and 2 `withWorkspaceWrite` call sites. This is a surgical review of the changed security paths and direct consumers, not an audit of the entire application. Line coverage was not measured.

Existing tests were changed only in two files:

- `workspace-boundary.test.ts`: Windows internal/root junction acceptance now asserts rejection, as explicitly required; the non-Windows expectations remain. Its Electron mock resolves the real release helper. Existing sentinel/no-side-effect assertions remain.
- `electron-builder-config.test.mjs`: the exact package pipeline now includes the workspace helper build/verification and its outside-ASAR resource. Existing history requirements remain, with additional workspace assertions.

New Windows routing/integration tests are platform scoped; they all ran on this Windows host. Portable bridge tests explicitly exercise Linux/macOS fallback and unrestricted passthrough. No new test was skipped to obtain a passing result.

## 2026-10-21 review fixes and fresh verification

The follow-up preserves the pre-existing uncommitted work on `codex/sec-handle` / `a33977df34c1c1f69aeb62e23e1f1093ff139dda`. No commit, push or git-history change was made. This section supersedes the historical verification totals below; neither run establishes full security acceptance.

Changes: typed native error causes and strict error frames; positive helper controls before every junction/hard-link rejection case; bounded read-only busy retries; write-before-truncate replacement; typed unknown commit effects; factual coverage/limitations above; workspace-specific verifier messages. History's adapter translates the new shared reparse/sharing variants back to its original `OpenFailed(NTSTATUS)` contract; its existing tests were retained. `FILE_SHARE_READ` is unchanged; no delete sharing or broader sharing was added.

Observed tests-first evidence:

- Bridge reason, malformed-reason, contention and commit timeout/abort tests failed against the original bridge, then passed. `reader_writer_contention_is_not_boundary` covers file/image/preimage reads, listing, retry exhaustion and no write-lease retry.
- Native `reader_writer_contention_is_not_boundary` failed with `workspace-boundary`, then passed with `workspace-busy` / `sharing-violation`, and reads succeed after the writer closes.
- Native `replace_failure_preserves_unwritten_tail` injected failure after three bytes: original implementation returned only `rep`; corrected implementation retained `repginal tail` with the original identity. The injection exists only under `cfg(test)`.
- `timeout_after_commit_reports_unknown_effects` passed for timeout and abort; invalid after-images also remain unknown. An expired lease that sends no commit remains not applied.
- Independent review found two P2 issues: late backoff wake could start a helper beyond the retry budget, and shared error variants changed history's Rust error contract. Both received failing regressions and fixes: the delayed-wake test first observed two starts instead of one; `history_reader_retains_native_open_error_contract` first observed `SharingViolation` instead of `OpenFailed`. Both now pass. No second review or full application security audit is claimed.
- `junction_rejection_requires_working_helper` and the other alias cases now perform ordinary reads/writes with the same root/context before rejection and require `reparse-point` / `hard-link`. Their actual alias assertions remain **unverified here** because the sandbox denies link creation. For the root-alias case, the same root spelling/context first succeeds as a plain directory before it is replaced with a junction.
- A real missing-release-executable probe confirmed required mode (`FIREFLY_REQUIRE_WORKSPACE_HELPER=1`) fails the named rejection test (exit 1); optional mode skips it (exit 0) and prints the build instruction. The generated release executable was restored afterward. Other tests excluded by that name filter were also skipped; those are not acceptance passes.

Fresh logs, exit records, pre-edit copies and JSON results: `output/workspace-handle-fixes/` (ignored local artifacts). All Vitest invocations set `FIREFLY_TEST_BASH=E:\Git\bin\bash.exe`; real-helper checks set `FIREFLY_REQUIRE_WORKSPACE_HELPER=1` except the explicit optional-missing probe. `TEMP` / `TMP` point to `E:\Codex\Firefly_Agent-hdl\output\workspace-handle-fixes\tmp`.

| Check actually run | Fresh result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.main.json` | **PASS**, final exit 0 |
| Requested `npx vitest run src/main/orchestrator/tools src/main/orchestrator/review scripts` | **BLOCKED/FAIL**, exit 1: all 53 files fail loading at sandbox `realpath EPERM`; no test bodies ran |
| Same scope with existing `output/workspace-handle-tests/vitest.config.mjs`, `--configLoader native` / `preserveSymlinks` | **521 passed, 38 failed, 2 existing skips**, exit 1 across 53 files (41 passed / 12 failed). This broad run preceded the final review fixes; see failure accounting below |
| Final bridge/callers/downgrade/integration/workspace-review/run-review-tracker subset using that temporary config | **116 passed**, 6 files, exit 0: bridge 52, callers 20, downgrade 3, real-helper integration 4, workspace-review 2, tracker 35 |
| `cargo test --features history-read,workspace-handle` from `native` | **41 passed, 9 failed**, exit 101 in library phase; later targets were not reached |
| Explicit `cargo test --features history-read,workspace-handle --bin firefly-workspace --test workspace_handle_contract` | Protocol **2 passed**; workspace contracts **4 passed, 2 failed**, exit 101 at denied junction/hard-link fixtures |
| `cargo clippy --features history-read,workspace-handle -- -D warnings` | **BLOCKED**, exit 101: installed Clippy `0.1.98` cannot discover its configuration (`os error 5`); no lint-clean verdict |
| Node helper/build/verification/packaging tests, four files | **48 passed, 1 failed, 1 existing skip**, exit 1; failure is `pinned retrieval models and provenance ship externally without unrelated models`, at sandbox `mkdir EPERM` |
| Final helper-only Node tests, three files | **32 passed, 1 existing skip**, exit 0; includes all four workspace build/verifier tests |
| Final `npm run build:workspace-helper` | **PASS**, exit 0; newly rebuilt and PE-verified release executable, **418,816 bytes** |
| Final `npm run verify:workspace-helper` (script exists) | **PASS**, exit 0 |
| Seven pinned files / three workflow files | **PASS**, all 10 raw SHA-256 values unchanged from this turn's pre-edit snapshot; all seven approved canonical-LF hashes also match |
| `git diff --check` | **PASS** |

The final full Cargo run used a freshly created local E-drive directory, with **both** `FF_WORKSPACE_TEST_ROOT` and `FF_HISTORY_TEST_ROOT` set to `E:\Codex\Firefly_Agent-hdl\output\workspace-handle-fixes\native-review-final-20261021`. Six history tests fail canonicalizing their fixtures (`access denied`); three workspace race tests fail creating junctions. The full-run failure names are:

- `history_read::observed_contract_tests::{captured_bytes_remain_immutable_with_a_preexisting_writable_mapping, deterministic_held_root_ancestor_leaf_races_read_only_authorized_handle, existing_aliases_and_invalid_budget_never_enter_content_read, maximum_bound_and_oversize_are_checked_before_data_read, new_hardlink_observed_at_leaf_barrier_is_rejected_before_content_read, presence_requests_attributes_only_without_content_reads_or_write_rights}`.
- `workspace_access::windows_backend::tests::{parent_open_create_race_cannot_create_in_external_directory, research_double_swap_is_rejected_before_external_open_then_second_swap_is_denied, swapped_unopened_component_fails_read_stat_list_image_and_write_prepare}`.

The two explicit workspace contract failures are `existing_hardlinks_fail_read_stat_list_and_write_without_truncation` (fixture NTSTATUS `0xc0000022`) and `root_mid_leaf_reparse_fail_before_io_or_truncate` (junction access denied).

Broad supplemental TS failure accounting: **24** pathname/link fixture `EPERM` failures outside the shell-job suite; **2** Bash shell-selection assertions; **11** shell-job lifecycle/process-death/timeout/fixture failures; **1** stale caller assertion expecting the old unknown-effect error code. That last assertion was updated to `E_WORKSPACE_UNKNOWN_EFFECTS` and passes in the final 116-test subset. The other **37 failures remain unresolved**; they were not turned into skips or counted as passes. Exact names and first errors are in [verification-failures.md](../../output/workspace-handle-fixes/verification-failures.md), with full errors in `vitest-supplemental.json`. Shell-job tests reported processes still alive; subsequent CIM process inspection was denied, so termination could not be independently confirmed. No unrelated process was killed.

The requested Vitest command's `scripts` argument does not include Node `.mjs` tests under the repository's Vitest include rules; those were run separately as recorded above. The temporary supplemental config only bypasses loader canonicalization; application path guards and fixture failures remain visible. The broad run rewrote one unrelated snapshot with identical content but LF line endings; its repository CRLF form was restored and it has no final diff. No repository test configuration, CI policy, dependency, or threshold was changed.

Not run/established in this follow-up: full repository Vitest outside the requested scope, remaining native integration targets after the failing library phase (apart from the explicit workspace targets above), successful junction/hard-link adversarial acceptance, Electron/device/installer acceptance, Unix builds, fresh history release builds, or a successful Clippy/rustfmt verdict. Replacement order/flush semantics were checked against the official [Rust File documentation](https://doc.rust-lang.org/std/fs/struct.File.html#method.set_len); this does not establish crash atomicity.

## Verification results (2026-10-20 historical run)

Host: Windows, Node `24.19.0`, installed Vitest `4.1.11`, Rust `1.98.1` / MSVC toolchain. Electron `43.7.0` is declared by the project; an Electron application run was not performed.

Logs and machine-readable results are under `output/workspace-handle-tests/` (ignored local artifacts).

| Check | Result |
| --- | --- |
| Main TypeScript no-emit check | **PASS**, exit 0 |
| Focused Vitest, 17 files | **220 passed, 30 failed, 2 existing platform skips**, exit 1 |
| Final bridge/caller/downgrade/integration/review subset, 6 files | **98 passed**, exit 0 |
| New bridge/caller/downgrade/integration/review tests within that run | **63 passed**, including 4 real-helper tests and packaged-location execution |
| Existing review tracker suite | **35 passed** |
| Node build/PE/packaging tests | **49 passed, 0 failed, 1 existing non-Windows CLI skip**, exit 0 |
| Workspace release build and PE verification | **PASS**, executable 414,208 bytes |
| Both history release builds and PE verification | **PASS**, 384,512 / 367,104 bytes |
| Full `cargo test` invocation | **39 passed, 9 failed** in the library phase, exit 101 |
| Native workspace unit subset | **4 passed, 3 failed** at denied junction setup |
| Binary protocol unit tests | **6 passed**: history presence 2, history read 3, workspace 1 |
| Workspace integration contracts | **3 passed, 2 failed** at denied junction/hard-link setup |
| Clippy | **BLOCKED** before a lint verdict: configuration discovery/canonicalization returns access denied |
| Rustfmt | **BLOCKED** by the same configuration/path access issue; no formatting success claimed |
| Seven pinned preimages | **PASS**, canonical-LF and raw-byte hashes unchanged |
| History test module body comparison | **PASS**, unchanged |
| `git diff --check` and changed-file trailing-whitespace scan | **PASS** |

All 30 focused TS failures report `EPERM` in native realpath or link fixtures. The file totals are:

| Focused file | Pass / fail / skip |
| --- | --- |
| `write-ownership.test.ts` | 0 / 9 / 0 |
| `run-review-tracker.test.ts` | 35 / 0 / 0 |
| `workspace-review.test.ts` | 2 / 0 / 0 |
| `apply-patch-tools.test.ts` | 19 / 3 / 1 |
| `ast-grep-tools.test.ts` | 20 / 2 / 0 |
| `document-tools.test.ts` | 6 / 3 / 0 |
| `fs-tools-eof.test.ts` | 2 / 0 / 0 |
| `fs-tools.test.ts` | 26 / 2 / 0 |
| `life-tools.test.ts` | 13 / 1 / 0 |
| `workspace-boundary.test.ts` | 19 / 4 / 0 |
| `workspace-boundary.unit.test.ts` | 5 / 0 / 0 |
| `workspace-handle-callers.test.ts` | 20 / 0 / 0 |
| `workspace-handle-downgrade.test.ts` | 3 / 0 / 0 |
| `workspace-handle.integration.test.ts` | 4 / 0 / 0 |
| `workspace-handle.test.ts` | 34 / 0 / 0 |
| `file-write-evidence.test.ts` | 0 / 6 / 1 |
| `tool-evidence.test.ts` | 12 / 0 / 0 |

Exact failing names/messages are in `failures-final.json`; the full result is `focused-final.json`. Six unchanged history tests fail at their existing fixture canonicalization. Three workspace race cases fail at junction fixture creation (`ERROR_ACCESS_DENIED`); the hard-link integration fixture receives `NTSTATUS 0xc0000022`. Native tests retain owned fixtures when they cannot safely verify cleanup targets. No ACL or sandbox changes were made to hide these failures.

### Commands

Run from the worktree root unless specified:

```powershell
$env:TEMP = (Resolve-Path 'output/workspace-handle-tests').Path
$env:TMP = $env:TEMP
$env:FF_HISTORY_TEST_ROOT = $env:TEMP
$env:FF_WORKSPACE_TEST_ROOT = $env:TEMP
$env:CARGO_INCREMENTAL = '0'

npx --no-install tsc --noEmit -p tsconfig.main.json
node scripts/build/workspace-helper.mjs
node scripts/build/history-helpers.mjs
node --test --test-concurrency=1 scripts/build/workspace-helper.test.mjs scripts/build/history-helpers.test.mjs scripts/verify/history-helpers.test.mjs scripts/packaging/electron-builder-config.test.mjs
```

From `native/`:

```powershell
cargo test --offline --locked --features history-read,workspace-handle -- --test-threads=1
cargo test --offline --locked --features history-read,workspace-handle --lib workspace_access -- --test-threads=1
cargo test --offline --locked --features history-read,workspace-handle --bins --test workspace_handle_contract -- --test-threads=1
```

Clippy was attempted with:

```powershell
cargo clippy --offline --locked --features history-read,workspace-handle --all-targets --manifest-path native/Cargo.toml
```

Explicit default-only configuration directories were also tried; configuration discovery still returned access denied. No lints were suppressed or thresholds lowered.

The stock Vitest invocation was first blocked by native `realpath` and the archive reporter's temp rename. The final invocation uses a local, untracked native-loader config, following Vite's documented [native configuration loader](https://vite.dev/config/#config-loading), with the existing Node environment, single-worker/file-serial settings and no test cache. Only module path resolution and reporting differ. The `.mjs` configuration avoids temporary bundling under `node_modules`.

```javascript
export default {
  resolve: { preserveSymlinks: true },
  test: {
    environment: 'node', reporters: ['default'],
    include: ['src/main/**/*.test.ts'], pool: 'forks', singleFork: true,
    maxWorkers: 1, minWorkers: 1, watch: false, cache: false, fileParallelism: false
  }
};
```

```powershell
npx --no-install vitest run --configLoader native --config output/workspace-handle-tests/vitest.config.mjs --reporter=default --reporter=json --outputFile=output/workspace-handle-tests/focused-final.json src/main/orchestrator/tools/workspace-handle.test.ts src/main/orchestrator/tools/workspace-handle-callers.test.ts src/main/orchestrator/tools/workspace-handle-downgrade.test.ts src/main/orchestrator/tools/workspace-handle.integration.test.ts src/main/orchestrator/tools/workspace-boundary.test.ts src/main/orchestrator/tools/workspace-boundary.unit.test.ts src/main/orchestrator/tools/fs-tools.test.ts src/main/orchestrator/tools/fs-tools-eof.test.ts src/main/orchestrator/tools/life-tools.test.ts src/main/orchestrator/tools/registry/file-write-evidence.test.ts src/main/orchestrator/tools/registry/tool-evidence.test.ts src/main/orchestrator/review/run-review-tracker.test.ts src/main/orchestrator/review/workspace-review.test.ts src/main/orchestrator/harness/write-ownership.test.ts src/main/orchestrator/tools/apply-patch-tools.test.ts src/main/orchestrator/tools/ast-grep-tools.test.ts src/main/orchestrator/tools/document-tools.test.ts
```

The full Vitest suite was not run. Full Electron application/device acceptance, complete installer/NSIS execution, remaining Rust integration targets after the library failure, Unix builds, and successful reparse/hard-link race injection remain unverified.

## Residual risks and compatibility limits

- Link count is an observation, not an atomic hard-link-table lease. A new outside alias created after the final check remains a documented residual risk.
- Existing writable mappings can change data without an ordinary competing writer handle. Returned bytes are copied observations, not an atomic filesystem transaction or a promise that the file remains unchanged afterward.
- Creation/write errors or cancellation can leave created parents/files or partially written data **inside the pinned workspace**. Effects after commit starts remain uncertain when the helper cannot report an after-image. There is no pathname rollback.
- Root/target reparses, unsupported attributes/filesystems, noncanonical root aliases, over-budget files/listings and helper unavailability fail closed. A restricted listing containing a reparse/multi-link child is rejected.
- Main, the helper executable and private review storage are trusted. Replacing application code/binaries, process injection, administrator/kernel/driver intervention and compromise of private application storage are outside this workspace-writer boundary.
- Native process/hex encoding and persisted observations add bounded overhead. Large-run alias lookup was not performance benchmarked.
- Non-Windows retains the explicitly documented path-level race. No Unix safety claim is made.

Before claiming security acceptance, rerun the recorded checks on a Windows local-NTFS environment that permits fixture canonicalization and creation of junctions/hard links, obtain the Clippy verdict, and complete the blocked adversarial cases. The implementation is available for review in the unchanged branch with all edits uncommitted.

## Changed files

The complete 36-file inventory follows. Generated binaries, logs and fixtures stay in ignored build/output directories.

- [docs/reports/2026-10-20-workspace-handle-access.md](E:/Codex/Firefly_Agent-hdl/docs/reports/2026-10-20-workspace-handle-access.md)
- [docs/superpowers/plans/2026-10-20-workspace-handle-access.md](E:/Codex/Firefly_Agent-hdl/docs/superpowers/plans/2026-10-20-workspace-handle-access.md)
- [electron-builder.yml](E:/Codex/Firefly_Agent-hdl/electron-builder.yml)
- [native/Cargo.toml](E:/Codex/Firefly_Agent-hdl/native/Cargo.toml)
- [native/src/bin/firefly-workspace.rs](E:/Codex/Firefly_Agent-hdl/native/src/bin/firefly-workspace.rs)
- [native/src/handle_fs.rs](E:/Codex/Firefly_Agent-hdl/native/src/handle_fs.rs)
- [native/src/history_read.rs](E:/Codex/Firefly_Agent-hdl/native/src/history_read.rs)
- [native/src/lib.rs](E:/Codex/Firefly_Agent-hdl/native/src/lib.rs)
- [native/src/workspace_access.rs](E:/Codex/Firefly_Agent-hdl/native/src/workspace_access.rs)
- [native/src/workspace_access/windows_backend.rs](E:/Codex/Firefly_Agent-hdl/native/src/workspace_access/windows_backend.rs)
- [native/src/workspace_access/windows_tests.rs](E:/Codex/Firefly_Agent-hdl/native/src/workspace_access/windows_tests.rs)
- [native/tests/support/workspace_links.rs](E:/Codex/Firefly_Agent-hdl/native/tests/support/workspace_links.rs)
- [native/tests/workspace_handle_contract.rs](E:/Codex/Firefly_Agent-hdl/native/tests/workspace_handle_contract.rs)
- [package.json](E:/Codex/Firefly_Agent-hdl/package.json)
- [scripts/build/workspace-helper.mjs](E:/Codex/Firefly_Agent-hdl/scripts/build/workspace-helper.mjs)
- [scripts/build/workspace-helper.test.mjs](E:/Codex/Firefly_Agent-hdl/scripts/build/workspace-helper.test.mjs)
- [scripts/packaging/electron-builder-config.test.mjs](E:/Codex/Firefly_Agent-hdl/scripts/packaging/electron-builder-config.test.mjs)
- [scripts/verify/history-helpers.mjs](E:/Codex/Firefly_Agent-hdl/scripts/verify/history-helpers.mjs)
- [scripts/verify/workspace-helper.mjs](E:/Codex/Firefly_Agent-hdl/scripts/verify/workspace-helper.mjs)
- [src/main/orchestrator/harness/write-ownership.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/harness/write-ownership.ts)
- [src/main/orchestrator/review/run-review-tracker.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/review/run-review-tracker.ts)
- [src/main/orchestrator/review/workspace-review-source.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/review/workspace-review-source.ts)
- [src/main/orchestrator/review/workspace-review.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/review/workspace-review.test.ts)
- [src/main/orchestrator/tools/apply-patch-tools.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/apply-patch-tools.ts)
- [src/main/orchestrator/tools/ast-grep-tools.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/ast-grep-tools.ts)
- [src/main/orchestrator/tools/document-tools.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/document-tools.ts)
- [src/main/orchestrator/tools/fs-tools.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/fs-tools.ts)
- [src/main/orchestrator/tools/life-tools.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/life-tools.ts)
- [src/main/orchestrator/tools/registry/file-write-evidence.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/registry/file-write-evidence.ts)
- [src/main/orchestrator/tools/workspace-boundary.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-boundary.test.ts)
- [src/main/orchestrator/tools/workspace-boundary.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-boundary.ts)
- [src/main/orchestrator/tools/workspace-handle-callers.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-handle-callers.test.ts)
- [src/main/orchestrator/tools/workspace-handle-downgrade.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-handle-downgrade.test.ts)
- [src/main/orchestrator/tools/workspace-handle.integration.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-handle.integration.test.ts)
- [src/main/orchestrator/tools/workspace-handle.test.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-handle.test.ts)
- [src/main/orchestrator/tools/workspace-handle.ts](E:/Codex/Firefly_Agent-hdl/src/main/orchestrator/tools/workspace-handle.ts)

## Pinned-file confirmation

- `src/main/plugin-marketplace.ts`: approved LF hash `ad0fe3f01d656157650efdc0413398759563bd8b548fc9edde2bbba0c6b5b88b`; raw bytes unchanged.
- `src/main/browser/browser-request-policy.ts`: approved LF hash `9ce32fdba4722e49b7c96d27ad7a2058fae3d62a4186d44aac98e49d7e62bdf1`; raw bytes unchanged.
- `src/main/browser/browser-startup-config.ts`: approved LF hash `08b61ff4e0f654f1bb236bcf19d6f09d3ddcc8d9b2c21d6052fdb55e800f2701`; raw bytes unchanged.
- `src/main/browser/electron-browser-guest.ts`: approved LF hash `a71fade70a93bb0c1ab40e7cbee856c2b423e87092bbaf4f3174a3d896de8d21`; raw bytes unchanged.
- `src/main/permission-policy.ts`: approved LF hash `b83f34a3ab293c4ea87ddf6f2bb13cd8cf4e6fc31ff266be06f7f5b5f89b1903`; raw bytes unchanged.
- `src/main/permission.ts`: approved LF hash `654fa51defb14ea31406a6a1e5a6ad9c6a4213f7d65b8434bc0d30f672613577`; raw bytes unchanged.
- `src/main/permission/bootstrap.ts`: approved LF hash `4419a194aa95f813f9f6aa90d250c1b71036ef49b508b6c0c716a0dc8ffc70a0`; raw bytes unchanged.
