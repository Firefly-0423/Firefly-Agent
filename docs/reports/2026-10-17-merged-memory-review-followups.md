# Merged PR109 review follow-ups

PR109 was independently read as merged at `2026-10-17T13:51:26Z`, merge `d2a58dbae9f6392bdf0df109c23633f84e39c191`, parents mini931997e1 and published28eb55d9. The user's subsequent instruction superseded an earlier push-to109 direction before any such action executed. No additional push, comment, resolve, PR, deployment or user-worktree/process action occurred.

Only the task-owned Phase2 commit was replayed onto this exact merge, from7e2569a to444d50ee. The original remains in `codex/memory-phase2-before-merged-mini-20261017`; its117-case final verification passed before replay. Package-lock SHA256 remains `813132dfcc24b49df17ae4dee77638226f52f5b0fd13515c979d8962afb85d4e`. The old54ee branch and private dependencies remain preserved.

## P1: prefilled settings correction

[Original review](https://github.com/Serendipity-wu02/Firefly-Agent/pull/109#discussion_r4302790572). Local fix `fac50b997579c5ec1f228650674a4abda4197b9b`.

The real settings component opens its textarea from `item.assertion`. The regression mounts that component in JSDOM and forwards its actual revisioned action through the real settings IPC handler, Main default-memory owner, source registry, policy writer and SQLite. Only the external model response is fake. Editing exactly `用户使用工具：Vim` to `用户使用工具：Emacs` previously stored typed value `用户使用工具:Emacs` and canonical value `用户使用工具:emacs`; it now stores `Emacs` and `emacs` with the appropriate new slot/assertion identity and the same entity. No guessed malformed output was substituted for this observation.

Generated labels now share the assertion formatter's fixed vocabulary. The parser recognizes the selected category's label and optional negative marker before extracting the value. A foreign generated category is rejected. Existing schema, source, sensitivity, quote/hypothesis, revision, synchronous correction and suppression checks remain in place. No UI layout or locale change was needed.

Behavioral RED:7 failures/2 passes across five categories and a negative tool fact, plus unsafe edits. GREEN:9 passes. Relevant complete owner/natural-memory/settings-IPC/panel regression files:234 passes,0 failures. Success cases also reject stale revision1 after correction and prove forget plus late correction cannot restore the fact. Existing legacy paths remain covered by those files.

## P2: safe failure metadata

[Original review](https://github.com/Serendipity-wu02/Firefly-Agent/pull/109#discussion_r4302790575). Local fix `f38895d12e5b29e6c9716639abad4ddfd2b6302a`.

The new integration test runs the real no-tool ChatLoop, FireflyAgent and AG-UI bridge. Only the external model stream and Electron event surface are synthetic. Context, model and known execution-wrapper errors previously reached the renderer as `E_HARNESS_FAILURE/runtime`; the owned memory-close branch did the same. The generic error replacement discarded their metadata.

Both replacements now attach only the finite `publicRunFailure` result, unwrapping known execution wrappers. The replacement message remains the existing fixed safe user message. Raw provider body, cause and diagnostic objects are not attached or sent. Arbitrary source/code fields remain subject to the existing allowlist and cannot choose a public classification.

Behavioral RED:3 failures/1 pass plus1 separate owned-close failure. GREEN:144 passes across the new actual-chain test and existing agent, public-failure and bridge files. Assertions cover exactly one terminal error, skipped success effects, synthetic secret exclusion and zero real network requests. Main TypeScript `tsc -p tsconfig.main.json --noEmit`:PASS.

## Evidence and review status

Local isolated runs are under `.verification/runs/`:

- `review-prefilled-red-behavior-1792245936881-6950469c`
- `review-prefilled-green-1792246008176-de44a819`
- `review-memory-regression-1792246048109-c5d03002`
- `review-chat-failure-red-behavior-1792246035582-cbefa24c`
- `review-chat-close-red-1792246092480-b26934a7`
- `review-chat-failure-green-1792246137208-f648fdd3`
- `review-main-typecheck-1792246162289-de8ca492`

Initial Vite realpath/profile-fixture failures were setup errors, corrected before counting behavioral RED. Existing source-button locale warnings and owner-fixture lazy-index cleanup warnings did not fail the regression runs; no unrelated UI repair was added.

One fresh independent `gpt-6.1-sol/max` review targets only committed `444d50ee..f38895d`. The independent review found no actionable Critical, Important or Minor issues and approved continuing local Phase2 work. Its unchanged raw report is archived in [independent review](2026-10-17-merged-memory-independent-review.md). Declined areas (incomplete Phase2, Android, real UI/provider/profile execution and deployment) remain outside the authorized fake-only follow-up acceptance; no claim for those areas is made. No new full-project suite or real Electron run is claimed for these follow-ups; frozen whole-branch checks and fake-only Electron acceptance belong to the continuing isolated Phase2 plan. Real provider, credentials, billing and user databases were not exercised. The prior PR109 CI succeeded and has not been rerun.

Rollback is by leaving this local branch unused or reverting the two independent fix commits on a task-owned branch. The published merge, original protected Task1 commit and user worktrees are untouched.
