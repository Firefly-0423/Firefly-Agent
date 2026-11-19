# Proactive follow-up: Plan B

Date: 2026-10-20 (Asia/Singapore)

## Decision and scope

Implemented the owner's selection of Plan B from the fully read research report at `E:\Codex\Firefly_Agent-skills-layout\output\rewrite-tools\research-proactive.out`. After one delivered proactive message without a user message, allow at most one final message, only on a new return from away, after a longer wait and with a reachable score gate.

Starting branch: `codex/proactive-followup-b`; HEAD: `2d2183e5`. The worktree was clean. The existing replacement tests and `penaltyFor(1) = -15` were retained. All changes remain uncommitted; no state-changing Git command, dependency installation, pinned-file edit or CI change was performed.

## Parameters and implementation

| Rule | Previous branch behavior | Plan B |
| --- | --- | --- |
| `FOLLOWUP_INTERVAL_MS` | 6 hours (21,600,000 ms) | 12 hours (43,200,000 ms) |
| `FOLLOWUP_MIN_SCORE` | 85 | 75 |
| Follow-up scene | Must differ from `lastProactiveScene` | Must be `back_from_away`; previous scene may also be `back_from_away` |
| Scene rejection reason | `followup_same_scene` | `followup_requires_return` |
| One-unanswered penalty | -15 | -15, unchanged |
| Unanswered hard stop | 2 | 2, unchanged |
| Normal-chat quiet period | 30 minutes | Unchanged |
| Global proactive cooldown | 2 hours | Unchanged |
| Return scene cooldown | 4 hours | Unchanged |
| Trigger evaluation floor / retry gap | 60 points / 30 minutes | Unchanged |

`proactive-policy.ts` changes only the two follow-up constants and the scene condition inside `startGuards`. The guard sequence is retained: switches, screen lock, busy states, inactive night, unanswered limit, normal-chat quiet period, global cooldown, scene cooldown, then follow-up interval, scene and score checks. Commit admission still reuses those guards after the epoch check.

`proactive-types.ts` replaces the rejection reason. Service telemetry already forwards policy decisions to `candidate_blocked` and `commit_blocked`; no separate mapping or legacy string remained to change. Service tests assert the new `candidate_blocked` string and verify that blocked non-return scenes never build a prompt, run a model or commit a message.

`proactive-prompt.ts` now explains that the user has returned again after being away. The statement that this is the last opportunity, the prohibition on blame/nagging/guilt-tripping, and the instruction to choose `silent` without sufficient reason remain verbatim. The trigger penalty comment is updated; its executable scoring code is unchanged. The earlier repair report has a supersession notice so its historical 6-hour/85/different-scene evidence is not mistaken for current policy.

The existing trigger owns event detection: the previous observed idle time must be at least 30 minutes and the current idle time less than 60 seconds. Policy permits the resulting return candidate even when the last proactive scene was another return. No new event queue, event identifier, persistence field or time-based reset was added. Continuous online activity does not create another return edge.

Base scores, window fit, urgency, freshness, silence bonus, ranking, all scene cooldowns, evaluation timing/floor and state-store implementation remain unchanged. The user-listed permission, marketplace and browser pinned paths have an empty working diff; node_modules was not edited.

## Worked examples

All times below are user-local. Eligibility permits generation; the model may still choose silence, and delivery is rechecked.

1. **Ignored at 14:00; depart at 17:00; return at 08:00 next morning.** The interval is 18 hours and the absence 15 hours. Return score is `68 + 20 urgency + 12 silence - 15 = 85`, above 75. Both a previous `work_break` and a previous `back_from_away` allow this final opportunity. A successful delivery raises the unanswered count from 1 to 2; further opportunities stop until a user message.
2. **Ignored at 14:00; continuously online through 20:00.** Six hours is below the new 12-hour wait, and no return edge exists. There is no follow-up. The regression also observes continuous activity next morning at 08:00: even after 18 hours, a `work_break` is refused with `followup_requires_return`.
3. **A new return after a 90-minute absence, with the 12-hour wait already satisfied.** Urgency is `round(4 + 4*log2(3)) = 10`; `68 + 10 + 12 - 15 = 75`, so it qualifies. A 60-minute absence gives urgency 8 and score 73, which is refused. The four-hour and eight-hour examples still score 81 and 85 respectively; both now qualify after other guards pass.
4. **Exact boundaries.** With one unanswered message and no other blockers, 12 hours minus 1 ms is refused, exactly 12 hours passes; a return score of 74 fails, 75 passes. At two unanswered messages even an injected score of 100 is refused with `unanswered_limit`. Crossing midnight or restarting does not reset that count.

## Tests and replaced assertions

Changes are confined to our own tests under `src/main/proactive`:

| File | Coverage and changes to old expectations |
| --- | --- |
| `proactive-policy.test.ts` | Updated the cooldown constant assertion from 21,600,000 to 43,200,000 ms. Replaced the combined six-hour/different-scene/84–85 test with exact 12h-minus-1ms/12h and 74/75 boundaries, same-scene return acceptance, and third-message rejection. Non-return follow-ups (`work_break`, `morning_greeting`, `evening_checkin`, plus a weather placeholder) are refused at score 100. Added the 4h-minus-1ms/4h scene-cooldown boundary after a later silence stamp. Expanded user reset to counts 1 and 2. Existing runtime/quiet/global/epoch checks remain. |
| `proactive-trigger.test.ts` | The old four-hour-away score-81 denial is now allowed because the gate is 75; the eight-hour score-85 allowance is retained. Added real 60-minute/73 denial and 90-minute/75 allowance. The sampled low-urgency test retains its below-threshold and refusal assertions, but non-return candidates now report the scene restriction before the score restriction. Added real trigger → policy → state-transition timelines for both prior scenes, overnight return, no third candidate, and continuous online activity. The day-long-return eligibility assertion remains. |
| `proactive-service.test.ts` | Replaced the old synthetic arbitrary second-scene allowance (`rain_at_window`) with a real return scene at score 75. Time advances by the follow-up interval rather than rewriting delivery metadata. Retained rejection of a third delivery, added its telemetry assertion, and verified user-message reset resumes eligibility. Added high-score non-return rejection and exact telemetry tests. |
| `proactive-prompt.test.ts` | Updated the exact follow-up block from “different scene” to “new return after being away,” using `back_from_away` as the fixture scene. All other prompt text is still asserted exactly, including last opportunity and anti-nagging rules. |
| `proactive-state-store.test.ts` (new) | Writes the real JSON store in a temporary fake Electron userData directory, reloads a fresh module and verifies exact state equality for counts 1 and 2. Seven days later the count is retained: 1 may qualify, 2 stays stopped. User reset persists as 0 with cooldowns intact. No production state-store change or real userData access. |

The timeline tests exercise the real trigger, policy, timezone conversion and committed-state transition. Model and physical channel delivery are outside those tests. Restart coverage is a fresh module reading a real temporary file, not an Electron process restart.

## Verification

| Check | Fresh result |
| --- | --- |
| Red: five changed/new test files against unchanged production policy/prompt | 19 failed, 93 passed; failures demonstrated old interval, threshold, scene/prompt/telemetry behavior |
| `npx tsc -p tsconfig.main.json --noEmit` | Passed, exit 0 |
| Focused Vitest filter `src/main/proactive`, with temporary environment workaround below | 144 passed, 11 files, exit 0; no skips or unhandled errors; 2.49 seconds |
| `git diff --check` | Passed |
| User-listed pinned paths | Empty working diff |
| Cleanup | All 535 generated runtime files and their directory removed; checked external config paths are absent; no `audit/` or temporary files left in the repo |

The successful Vitest run began at 22:58:40 local time. The requested prefix filter also selects the existing adjacent `src/main/proactive-delivery-shared.test.ts` (2 cases); the proactive directory itself accounts for 142 cases in 10 files. No full suite ran.

The repository-config attempt used `--configLoader native` to avoid config-bundling temporary writes under the node_modules junction. It failed before running tests with sandbox `EPERM` in the archive reporter's temporary-file rename. An external-config attempt then hit the same restriction in Vitest's transform-file rename. These are runner failures, not product test failures. Reusing an external config across tool invocations also failed because the per-invocation sandbox temp file was already gone; the successful run recreated it in the same invocation.

The successful equivalent command was:

```powershell
$env:TEMP = 'E:\Codex\Firefly_Agent-bgc\.proactive-plan-b-runtime'
$env:TMP = $env:TEMP
$env:FIREFLY_TEST_REPORT_ROOT = Join-Path $env:TEMP 'reports'
npx vitest run src/main/proactive --config $planBExternal --configLoader native
```

`$planBExternal` was a temporary `.mjs` file outside the repo, importing the actual `vitest.config.ts`, preserving its settings/reporters, and overriding only root, `resolve.preserveSymlinks: true`, and `cacheDir` into the disposable runtime directory. The initial red run used the default reporter alone to isolate the sandbox reporter error; the final green run retained the repository archive reporter. Single-worker/file-serial execution, timeouts, includes, disabled watch/cache and all assertions were retained. No tracked test configuration or package metadata was changed. The runtime cache/report files are disposable verification artifacts, not deliverables.

The external configs disappeared with their per-invocation sandbox temporary directories; the previously emitted paths were checked absent. Repository artifacts were inventoried, checked for reparse points and containment, then deleted as individual files and empty directories. Final untracked files are only this report and the new state-store test.

The final review used `code-review-and-quality` inline to check the small production diff, boundary cases, unchanged guard order, reason consumers, test isolation and scope. No blocking finding remained. This is not an independent security audit. The main TypeScript config excludes test files; Vitest executed them. Full build, packaging, Electron UI, real LLM and real channel delivery were not run under the focused resource restriction.

## Residual risks and open uncertainty

- Returning to the computer does not prove willingness to chat. The 12-hour/75-point values are the owner's product hypothesis, not research-derived optimums.
- “Unanswered” counts successful proactive commits, not confirmed reads. Two unanswered messages stay stopped indefinitely, including across days/restart, until a user message. This is intentionally unchanged.
- The trigger samples idle transitions in memory. A missed observation, restart, fast runtime blocker, or 30-minute evaluation backoff can consume or miss a return opportunity; a refused return is not queued to fire automatically when the interval subsequently reaches 12 hours. Existing quiet-hours and delivery restrictions still apply.
- Policy trusts the trigger's `back_from_away` candidate; it does not independently prove an idle transition. This change preserves that existing module boundary and does not add event tokens or alter scoring.
- The model may choose silence; technical failure may use the existing fallback. Automated tests verify eligibility and mocked service delivery, not the naturalness of real messages.

**Open uncertainty:** does a user's non-response mean “do not interrupt me,” or do they value the pet's ambient companionship without feeling a need to answer? The owner chose the latter as the working product assumption while retaining a strict final opportunity. Real usage is still needed to validate that assumption.
