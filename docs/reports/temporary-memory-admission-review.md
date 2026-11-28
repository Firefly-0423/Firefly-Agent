# Temporary text-only admission review

Date: 2026-10-18. Scope: the uncommitted minimal change in src/main/memory-context/main-default-memory.ts and its tests, plus temporary-chat acceptance in scripts/verify/natural-memory-phase2-electron.cjs. Base HEAD: e74f62b9af75c1f75b11ed91a6a2c5f2927d7868. No product files edited.

## Verdict

Approve the minimal product fix. No required correctness, security, persistence, architecture, or performance findings in this change. This is a narrow review, not a repeat of the completed whole-change reviews.

- main-default-memory.ts:890-897 still binds the current sender/session, requires a live admission, checks grant equality, parses the turn ID, and requires exactly one user message with string content and no modelContext before returning undefined for an attachment-free turn. Returning undefined does not issue an attachment capability.
- A nonempty attachment list in a temporary session still fails before copying attachments, accessing the source registry, validating file selection, or issuing a grant. The new injected-file regression tests this second barrier in addition to appendUser's existing refusal.
- AG-UI calls prepareAttachmentGrant whenever userTurnId exists (agui-bridge.ts:577-578), including text-only turns. The moved condition therefore fixes the observed rejection at the correct boundary.
- Temporary run selection, immutable session-mode binding, in-memory capture, empty cross-session read tokens, and onTurnSucceeded's temporary-session exclusion remain unchanged. The temporaryTurn helper now traverses attachment admission before openRun; its existing assertions cover two-turn context, no memory/history commands, no transcript directory, and no cross-session recall.

## Verification inspected

- RED: .verification/runs/temporary-admission-red-1792288669292-812b8f15/output.log records the newly exercised temporaryTurn failing at line 1061 with MEMORY_ATTACHMENT_DENIED (1 failed, 125 skipped). This directly exercises the former condition; no mutation of product files was performed during this read-only review.
- GREEN: .verification/runs/temporary-admission-green-1792288697337-80c05fca/run.json and output.log record main-default-memory.test.ts plus agui-bridge.test.ts, exit 0, 204 tests passed.
- Build: .verification/runs/temporary-main-build-1792288708732-336e8767/run.json records tsc -p tsconfig.main.json, exit 0.
- Electron: .verification/electron-phase2-1792288736139-f758e450/result.json records 28 checks, failures=[], three owned-process exits with code 0, a temporary real-ui-turn-finished, and temporary-chat-no-extraction-or-journal. The script requires RUN_FINISHED and an actual intercepted chat model request; it does not count RUN_ERROR as success. It launches a private synthetic profile and uses the real UI/preload/IPC paths; the transport is deliberately synthetic.
- Independently ran git diff --check successfully.

## Optional acceptance improvement

The temporary assertion at natural-memory-phase2-electron.cjs:155-157 samples automation state and natural-request count immediately after RUN_FINISHED. AG-UI dispatches onTurnSucceeded asynchronously (agui-bridge.ts:973); these samples alone are not a general proof that a delayed extraction could never occur. The script also labels temporary=true from its requested UI action rather than independently asserting the resulting session flag. For stronger future acceptance, verify the resulting temporary flag and recheck the temporary source/session after a deterministic background-work barrier or shutdown/reopen, including absence of its transcript/journal records. This does not block this minimal fix: the unchanged production temporary branch exits before asynchronous extraction, the unit tests exercise the relevant guards, and the current Electron run proves the formerly rejected text-only turn now completes. Do not describe this one immediate sample as exhaustive zero-persistence proof.

## Independent-run limitation

Attempted: node .verification/run-isolated.cjs temporary-admission-review node_modules/vitest/vitest.mjs run src/main/memory-context/main-default-memory.test.ts -t temporary.
Target: this tree's main-default-memory.test.ts only, using synthetic environment directories.
Result: test collection failed with EPERM at realpath of that test file; no tests executed. Evidence: .verification/runs/temporary-admission-review-1792288808363-cefcfb45/. This was an execution-environment error, not an auto-review denial, pending operation, or uncertain execution outcome. Existing RED/GREEN/build/Electron artifacts were read and inspected; their runs were not independently reproduced here. No user instance, credentials, network, other tree, PR, or push was touched.
