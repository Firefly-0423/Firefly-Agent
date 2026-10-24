# Phase 2 independent re-review — 2026-10-18

**Reviewer:** the original requested `gpt-6.1-sol` / `max` reviewer, resumed for the user's expressly requested re-review. No additional reviewer or implementation agent was dispatched.

**Frozen implementation:** `e74f62b9af75c1f75b11ed91a6a2c5f2927d7868`, branch `codex/memory-phase2-post-ui-20261018`.

**New merged mini baseline:** `9f94f79b8ad12777d23bf432fe0f8f33bc99c4fc` (PR112). The old task branch remains preserved at `8c7c0891`.

## Verdict

**Original I1 and I2 are addressed at the frozen implementation.** No further actionable Critical, Important or Minor finding was confirmed in the Phase 2 implementation/fix diff during this focused re-review. This approves the two race repairs and their integration with the new baseline; it does not certify Task 6 or a final full-project result.

There is a separately reproduced inherited same-document-navigation observation below, outside the Phase 2 diff. It has not been shown to cause the current actual Electron acceptance failure. The initially inspected acceptance script also made two incorrect UI timing assumptions; the implementation owner is correcting that synthetic harness without manually granting a target or altering the production React UI.

## I1 — addressed: live scope checked at coordinated dispatch

In `src/main/memory-policy/main-policy.ts:54`, the new `current` closure repeats `naturalActor(token)` and then invokes the host-provided authority assertion. It is passed to the final `command` at line 66. `command` invokes that assertion from its `execute` closure at line 41, and schedules that closure through `actorAuthority.coordinate` at line 42. The assertion therefore executes after queued work, immediately before sending the final policy command, rather than only before the awaited source/job preflight.

`naturalSource` also rechecks the live actor after its evidence read; `naturalJobs` checks it again before returning the list. Strict DTO validation and the existing settings-frame assertion are preserved. There is no renderer-supplied actor/scope authorization field.

The new four-case regression covers enqueue, dispatch, save and apply. It changes the live project after the awaited evidence/job read and requires refusal, unchanged budget/phase, no new job for enqueue and no fact.

The original independent scope probe was rerun unchanged through the isolated launcher against `e74`. **Observed:** both dispatch and apply return `MEMORY_POLICY_NATURAL_SCOPE_DENIED`, and `facts: []`.

Evidence: `.verification/runs/phase2-re-review-scope-probe-1792288039527-37b36341/`. Complete inline source and the recorded full HEAD are in `run.json`; observations are in `output.log`. Exit 0.

## I2 — addressed: live model/lifetime guard carried through every application path

`src/main/memory-policy/natural-extraction-runner.ts:36` defines a guard that calls `model.assertCurrent()` and checks the combined lifetime signal. Enqueue, dispatch, save and all three apply paths pass that guard to `naturalCommand`. The latter composes it with the live actor assertion inside the coordinated execution closure described above.

All apply paths use `return await`, so an asynchronous guard failure reaches the surrounding catch and becomes finite `blocked/profile-changed` when a job exists. The current-source value is named `latestSource` at line 65; it does not shadow the guard closure. The earlier TDZ/ReferenceError draft is not present in this frozen commit.

The new three-case model regression invalidates the model across the awaited journal read during dispatch, save and saved-result application. It checks the terminal reason, budget, send/prepare counts and absence of a fact. Saved application retains zero prepare/send; an invalidated pre-dispatch job makes no reservation; a request already sent keeps its reservation.

The original independent saved-result profile probe was rerun unchanged. **Observed:** `profileInvalidated: true`, `phase: "blocked"`, `reason: "profile-changed"`, `factCount: 0`. The probe's `prepare` throws if called, preserving independent evidence that saved recovery did not prepare a model call.

Evidence: `.verification/runs/phase2-re-review-profile-probe-1792288039509-b8f2e5ab/`, exit 0, with full source/HEAD in `run.json` and observations in `output.log`.

## New-baseline compatibility

Read-only `git range-diff` of the old nine task commits against the replayed nine commits reports **all nine `=`**. `git diff <new-base>...e74 --check` passes. There is no task diff under `src/renderer/react`; no conflict resolution or task edit replaced Claude's React UI.

The upstream `runWithUsageAttribution` wrapper remains around the asynchronous FireflyAgent run. Phase 2 only adds the previously reviewed finite error metadata at the two terminal error replacements; it does not remove the wrapper or add a new attribution layer. The real no-tool Chat/agent/bridge failure-chain regression passes on this combined baseline. Memory's existing aggregate request/usage callbacks remain; the user's earlier deferral is not treated as permission to remove upstream usage functionality.

The two new memory-automation IPC channel names do not replace the upstream usage/skill channel additions. Preload retains those APIs and adds the separate `window.memoryAutomation` bridge. The settings HTML retains the upstream usage section while adding the dedicated memory controls. Both locale files retain upstream keys and the automation strings; relevant settings IPC, panel and i18n tests pass. The writer/journal/gate semantics otherwise remain the previously reviewed ones, unchanged by the replay.

## Acceptance-script diagnostics and inherited observation

### Harness timing assumptions — confirmed by source inspection

The initially inspected untracked `scripts/verify/natural-memory-phase2-electron.cjs` clicked “新对话” and waited for a new Main target before submitting a message. That ordering contradicts `ChatPage.tsx:1081`: new-task navigation clears state and enters a draft welcome page; it does not create a session. `ensureSession` creates/selects the session at first submission (`ChatPage.tsx:997`–1036). A pre-submit target wait can time out with a healthy UI. Do not bypass this by manually calling `setActiveSession`; submit through the real UI and then inspect the authoritative target/session.

The initially inspected script used Playwright `checkbox.check()`/`uncheck()` for consent. `automation-panel.ts:48` immediately renders the old authoritative checked value while the CAS request is pending; line 51 updates it only after the response. Thus Playwright's immediate checked postcondition can fail even when the requested consent mutation succeeds. A real click followed by the existing authoritative revision/flag wait exercises the intended asynchronous behavior. This is a harness contract mismatch, not evidence that consent CAS failed.

The owner subsequently reported an actual task-owned fake-provider Electron run completing the first UI submission, default-off candidate and UI confirmation, with a correct Main target, then stopping at the checkbox postcondition. That is author-run progress, not reviewer-run Electron evidence. I did not launch an application or independently claim final acceptance. The untracked harness is mutable and is not included in the frozen implementation verdict; its final version/run still needs the owner's Task 6 verification.

### Inherited observation H1 — same-document event clears a registered target

`src/main/plugin-host/active-chat-target.ts:110`–122 ignores `_isInPlace` and clears the registered target for every main-frame navigation event. A pure EventEmitter probe registers `synthetic-chat`, then emits a main-frame same-document navigation with both the installed Electron details shape and legacy positional arguments. **Observed:** `active: null` and a `navigation` invalidation. An assertion requiring the mounted target to remain fails.

The code's intended contract describes invalidation for reload/navigation replacing the renderer. The neighboring `create-aux-windows.ts:68`–72 explicitly preserves readiness for same-document navigation. `ChatPage.tsx:712` reports active selection and `ChatPage.tsx:743` synchronizes the URL with `history.replaceState`, so event ordering is worth tracing if a real existing-session switch loses the target.

Evidence: `.verification/runs/phase2-re-review-same-document-probe-1792288046403-b7781b32/`, full probe in `run.json`, exit 1 is the deliberately failing invariant assertion. This handler is inherited from the merged baseline, not introduced by Phase 2 or `e74`. I did not reproduce that event ordering in an actual Electron session, and the owner's later first-submit target was healthy. **Do not label H1 as the sole or demonstrated cause of the current Task 6 failure.** It is retained as an inherited boundary observation outside the Phase 2 finding counts, without expanding this task into a production UI repair. A future runtime diagnosis should record registry invalidation reason and navigation details rather than masking authority with manual registration.

## Fresh independent verification

```text
E:/Node.js/node.exe .verification/run-isolated.cjs phase2-re-review-focused scripts/testing/run-tests.mjs src/main/memory-policy/natural-extraction-runner.test.ts src/main/memory-policy/main-policy.test.ts src/main/memory-policy/natural-automation-integration.test.ts src/main/agui-chat-failure.integration.test.ts src/main/memory-policy/memory-automation-settings-ipc.test.ts src/renderer/settings/memory/automation-panel.test.ts src/renderer/settings/settings-i18n-regression.test.ts --reporter=dot
```

**Observed: 7 files, 156 tests passed, exit 0.** Manifest records full HEAD `e74f62b9af75c1f75b11ed91a6a2c5f2927d7868`. Archive: `.verification/runs/phase2-re-review-focused-1792288021501-9435d276/`. Includes the new four scope and three profile cases. This used execution access because the previous review had already established sandbox Vite `realpath EPERM`; no test/source change or dependency reinstall was used to bypass that environment failure.

All probes and tests used the existing isolated launcher, synthetic sources/models, private environment roots and in-memory or test-owned SQLite. No full suite, real provider/counting call, actual key/settings/user database, app/service/owner process, Git mutation, push/PR/merge/deployment, dependency install/rebuild or second reviewer was used by this reviewer. Only this report and isolated evidence artifacts were written. No denied or pending approval action remains.

## Remaining limits and readiness

The original review report remains unchanged at `.verification/phase2-independent-review.md`; its findings describe the older frozen target. This re-review closes I1/I2 for `e74`, backed by fresh tests and the exact original adversarial probes.

The final full suite, complete build/type/storage/schema/offline/native checks and completed actual Electron/preload/Worker/SQLite cold-restart acceptance remain the main agent's responsibility. Their current progress is not silently counted as independent execution here. No guarantee is made about provider billing, live credentials, real user stores, unrelated upstream UI behavior, or later changes to the untracked acceptance script.

**Readiness:** the two race repairs are accepted; final Phase 2 closure remains conditional on the owner's frozen Task 6 checks. No repeated independent review is requested.
