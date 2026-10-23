> Historical snapshot: this file records its original phase1 baseline and acceptance time. For the user-selected mini target and final post-review source, see [fresh mini validation](../reports/2026-10-17-memory-token-mini-validation.md). Do not substitute its earlier counts or limits for current mini evidence.

# Natural memory phase 1 — isolated Electron/UI acceptance

The actual compiled candidate application completed natural-language proposal, explicit confirmation, clean shutdown, reopening, new-session request selection, correction and forgetting. The product implementation was not changed during this follow-up. All conversation data and application storage were synthetic, and model responses were supplied in process without a provider request.

This supplements [the phase-1 implementation report](2026-10-17-natural-memory-phase1-validation.md). Its statement that Electron/UI acceptance had not yet run describes that earlier checkpoint; the present report supplies that missing evidence. Real-provider acceptance remains unperformed.

## Exact candidate and scope

- Repository/worktree: `E:/Codex/2026-10-17/task/firefly-memory-phase1`.
- Branch: `codex/natural-memory-phase1-20261017`.
- Product implementation tested: `7d454a795c52e1aef11b328c28c17bbaa6bba4d8`.
- Original feature base: `0539f72a5888d1453227d3f3eabef410e23fbc58`.
- Runtime: the candidate's existing Electron `43.7.0`, Playwright `1.63.0`, and existing compiled Main/preload/renderer. No dependency installation, packaging or application installation occurred in this follow-up.
- New tracked deliverables: the reusable verification script, this report and a compact JSON evidence artifact. No `src/` file, product renderer, CSS, package manifest or lockfile changed.
- The separate masked-Token task's `source-secret-screen`, terminal mapper and error UI were not changed. Its fix is neither assumed integrated nor covered by this acceptance.

The execution agent's requested configuration was not changed. The application's `openai/gpt-6-luna` string is an existing test-fixture model identifier directed exclusively to `https://memory-qa.invalid/v1`; it does not identify a real provider call or an execution-agent model downgrade. The current tool surface does not independently expose the primary turn's sampled reasoning-effort metadata.

## Isolation and offline boundaries

`scripts/verify/natural-memory-electron-ui.cjs` launches its own application through Electron's documented Playwright testing interface. It checks actual `appPath`, `userData`, `sessionData`, logs, home and appData against a fresh task-owned root before submitting conversation data. The three launches deliberately reuse that one synthetic profile to verify persistence.

The child receives a small environment whitelist plus synthetic USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP. The bootstrap explicitly sets Electron home/appData before the product's identity preflight. It then loads the actual product entry. SQLite, encrypted memory storage, the source ledger, runtime authority, recall selection, IPC, confirmation/correction/forgetting transactions and both rendered windows remain real.

The bootstrap replaces only external boundaries: model `fetch` gets deterministic JSON/SSE responses, other fetches fail closed, Node HTTP(S) and Electron net HTTP calls are blocked, and every created Chromium session blocks HTTP(S). MCP, channel/scheduler startup, screenshot prewarming, embedding/reranker startup, proactive triggers and update checks are suppressed through the existing background dependency boundary. Normal readiness and controlled shutdown still run. No real external service is started. No real API settings or real memory database are opened for this test.

This is application-profile isolation under the current OS account, not an OS sandbox. The OS account, hostname and optional desktop/documents/downloads metadata have not been proved synthetic. The test makes no assertion that every system metadata field was replaced. Only Google Fonts requests were observed at a blocked browser boundary; no provider/network request was allowed by the harness. No microphone, screenshot, tool call, GitHub-auth operation or masked-token transcript was exercised.

The user paused engineering while another agent finished its work, then explicitly resumed it at `2026-10-17 10:44 UTC`. No engineering execution occurred during that pause. After resumption, realpath checks again confirmed this worktree, `dist`, `node_modules` and QA output are independent task-owned directories; recursive checks found zero reparse points in `dist`, `node_modules` or the retained QA output. The earlier isolation check also found link count `1` on the candidate Electron executable, TypeScript library and compiled Main entry. The preview and daily-development checkouts share a dependency junction to `Firefly_Agent-skills-layout`; this candidate does not use that junction. Git object storage is shared normally between registered worktrees, while this branch and its checkout are separate.

All six launcher/Main PIDs recorded by the successful run had exited when checked after testing. This harness starts no fixed-port HTTP mock or application backend service: the fake transport is in-process, and Playwright's temporary debugging connections close with its own instance. The exact debugging port of each past launch was not recorded. Other agents' private conversations were not read, and no non-owned process was stopped or restarted. Resumption did not repeat an Electron run because both the reviewed script hash and the tested product tree remained unchanged.

## Closure evidence

The final run returned exit code `0`. It has four distinct Main-owned Chat session IDs, four corresponding persisted user/assistant pairs, successful terminal run snapshots, and the exact synthetic assistant reply rendered in each session. The optional `sSettlement` field was not exposed by these ordinary Chat DTOs; where present the script requires success, and it always requires `runSnapshot.status=terminal`, `terminalStatus=success`, correct `answersUserMessageId`, persisted reply text and rendered text.

| Step | Actual operation and checked result |
| --- | --- |
| Natural expression | The real composer submitted `小雀是我习惯用的称呼，以后这样叫我`. The initial model request had no pre-existing memory section. |
| Pending proposal | Settings IPC returned zero active facts and one typed `address` candidate, `用户称呼：小雀`, with source revision, content hash and global scope. The rendered card required confirmation. |
| Confirmation | Clicking the actual card's confirm button produced fact `8be7554c-c871-439d-bf5c-70d396605391`, revision `1`, `explicitUserConfirmed`, with candidate/evidence provenance. |
| Close and reopen | The first own Electron instance closed gracefully. A new instance reopened the same synthetic profile; storage was not seeded or edited between launches. |
| New-session recall | Session `9e09a99c-956e-44e6-b675-12afae186c4b` submitted a different ordinary request. The captured actual model body contained the same fact ID, revision `1`, source references and timestamps in a **user-role data message**. Neither system nor developer data carried the synthetic name. |
| Correction | The actual settings editor changed the value to `小禾`. The same fact ID advanced to revision `2` synchronously. Session `6cac75f3-036d-4c3e-b6b9-1188e4dac980` selected revision `2`; the entire request body had no `小雀`. |
| Forgetting | Clicking the actual forget button returned zero active facts. Session `c5bf3585-8651-4fa9-beba-14288d170bcd` had no memory section, and no role anywhere in its request body contained either synthetic name. |
| Persistence after forgetting | The second instance closed gracefully. A third instance reopened the same profile and still returned zero active facts. |

All three launches collected their own blocked-request, dialog and suppressed-background records before shutdown. All three closed normally, without forced termination. No error dialog or renderer page error was recorded. A forced-shutdown timeout fails this verification instead of being counted as a pass.

The successful run is retained locally at `.verification/electron-memory-ui-1792230308149/`:

- `result.json`: full per-step states, four session/turn/run identities and three launch boundaries. SHA-256 `fda28456d11b76bd411465c8b33cfcb48295737766b8a07ccd846a6afb774585`.
- `model-requests.ndjson`: four main requests and four separate natural-extraction requests, containing only the controlled conversations and this candidate's normal prompt/environment metadata. No request headers are recorded.
- `01-pending-candidate.png`, `02-confirmed.png`, `03-new-session-recall.png`, `04-corrected.png`, `05-forgotten.png`: actual rendered windows. These were visually inspected; the local diagnostic folder is intentionally not committed.
- [Compact portable evidence](artifacts/2026-10-17-natural-memory-electron-ui-evidence.json): exact session/run identities, same-fact revisions, actual memory messages, all-role absence checks and per-launch boundary records without absolute machine paths.

## Independent review and diagnostic iterations

An independent reviewer inspected the harness without editing or launching it. The following verification defects were corrected before the final successful run:

1. Per-launch boundary evidence was previously replaced on reopening; it is now retained and checked for every launch.
2. Forgetting previously inspected only a fixed memory-message prefix; it now checks the entire request body across every role for both values.
3. Confirmation/correction now verify the same fact ID and revisions `1` then `2`; each new session is checked through the actual Main registry and persisted corresponding user message.
4. Forced termination previously could be reported as success; it now fails acceptance.
5. Capturing a request alone previously could hide a failed answer; every round now waits for the corresponding persisted successful terminal answer and rendered response.

Earlier harness attempts are retained as failures, not folded into this success: Windows Electron home initially escaped the synthetic root; a pre-ready `openInReactChatWindow` probe left a pending message with `MEMORY_DESKTOP_SESSION_DENIED`; URL-based session identification was not a contract of the new-chat UI; `require` is not available inside Playwright's serialized main-evaluate function; and the Chat DTO does not promise `sSettlement`. The final harness explicitly sets home/appData, waits for real readiness, clicks the normal new-chat button, reads a bootstrap closure for Main's real active target, and asserts the actual exposed successful-run contract. No production authorization check was bypassed or relaxed.

Final independent review passed with no remaining Critical or Important findings. Reviewer `/root/memory_phase1_review` independently re-read script SHA-256 `9c341ad87b1f35a2e29cb423cccd6069d2f406d1c4db0585b13a1cb587ed1f20`, recomputed the original result/request hashes, compared every compact evidence section with the original run, and confirmed the synthetic SQLite file header. The reviewer confirmed four unique successful sessions, three graceful launches, same-fact revision `1 → 2`, all-role forgetting and zero failures/renderer errors. The successful run has exactly five screenshots. The reviewer did not edit files or launch an application.

Visual QA also found an existing source-button translation problem: `t("settings.panel.memory.entries.source")` resolves to an object and renders an i18n diagnostic instead of a short label. `git show 0539f72a:...` confirms the same call/object already exist at the feature base. It does not block confirmation, correction, forgetting or request recall. It was not changed because this follow-up preserves the user's UI work; source-button polish remains a separate UI-owner task.

## Read-only integration compatibility

Compatibility checks use the feature patch `0539f72a..7d454a7`. Historical committed snapshots were checked with a task-local `GIT_INDEX_FILE`: `git read-tree <target>` followed by `git apply --cached --check`. The latest clean targets were rechecked after resumption with `git --no-optional-locks -C <target> apply --check --whitespace=nowarn <patch>`, without applying the patch or writing a temporary index. No target checkout/index/branch was changed. No merge, cherry-pick, push or pull request was performed.

| Local candidate snapshot | Status and check |
| --- | --- |
| Historical daily snapshots `4b07528`, `7c454ed`, and historical preview snapshots `defce257`, `f152a89` | Their earlier patch checks passed. They are retained as historical evidence; they are no longer the recommended current target. Earlier uncommitted UI/settings changes were never edited or overwritten here. |
| Current daily development `E:/Codex/Firefly_Agent-chat-ux`, `codex/usage-history`, `507c532961488ffdd54bb8ad9d6d9068e06f9558` | Clean at the `10:44 UTC` resumption check. Latest read-only feature-patch check passed. Memory-core/context/policy/recall contracts and model-settings are unchanged relative to the feature base. The newer usage-attribution fixes are on this development line. |
| Current preview `E:/Codex/Firefly_Agent-preview`, detached `8ff702f503a7bdd6afa149813c3e79a549b0e079` | Clean at the resumption check. Latest read-only feature-patch check passed. It contains the page/rail UI plus merged usage-page work; memory-core/context/policy/recall contracts and model-settings are unchanged relative to the feature base. It was never launched, stopped or restarted by this task. |

The recommendation is a **new isolated integration worktree based on preview commit `8ff702f`**, preserving its current page/rail design and merged usage page. The phase-1 patch has no textual conflict with that exact target or with daily-development commit `507c532`. This recommendation supersedes the pre-pause `defce257` recommendation. Integration itself remains a separate authorized action; this task did not create that integration checkout or change either target.

Preview `8ff702f` does not contain daily-development follow-up `507c532`, which assigns post-turn memory work to the memory usage feature and fixes usage accounting. It also does not contain the parallel masked-Token commit `b5204efd1045fe56a5923cfb17d89a01c58bd672`, as checked by ancestry. Those independent commits must not be assumed integrated or validated by this QA. Their combination is outside this report's patch-conflict claim; both include adjacent application/runtime work that needs its own integration review.

A clean patch check is source-level evidence, not a runtime test of either other repository or a combined Token/usage/memory product. The local cached `origin/main` reference was `1a76fb0672646d44ac0a653d64ea6a8436cfa213`; no fetch or inference about another agent's PR number was needed for this bounded local compatibility check. If a target advances again, repeat the check against its exact successor before integration.

## Commands and limits

```powershell
node --check scripts/verify/natural-memory-electron-ui.cjs
node scripts/verify/natural-memory-electron-ui.cjs
node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.preload.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
git diff --check
```

The final UI command and syntax check passed. Main/preload/renderer no-emit checks and whitespace checks passed. No lint script is defined by this project. The earlier implementation's full regression result remains 10,392 passed, 11 inherited platform skips and zero failures/unhandled errors; it was not rerun for this verification-only follow-up. The actual product source tree is still the tested `7d454a7` tree.

The testing approach follows [Electron's automated-testing documentation](https://www.electronjs.org/docs/latest/tutorial/automated-testing), [Playwright's Electron API](https://playwright.dev/docs/api/class-electron) and [Electron app path APIs](https://www.electronjs.org/docs/latest/api/app). No installed/packaged production Electron run or real-provider behavior was tested. Fake output validates software boundaries and actual request selection; it does not establish natural-language extraction quality, provider latency, real-model instruction adherence or billing behavior.

To repeat, build this exact candidate using the project's existing workflow if its compiled outputs are absent, then run the standalone verification command. Each invocation creates a fresh diagnostic root; it never points at a real profile. Stop only the instance owned by that run. To discard this follow-up, revert its verification/report commit or stop using this worktree; there is no product data migration to undo. For rollback of an already-used future feature profile, follow the complete closed database/key backup procedure in the implementation report rather than deleting encrypted rows or resetting a user's checkout.

Phase 2 resumable extraction and automatic ADD, phase 3 complex time, and phase 4 hybrid retrieval/Work/Code learning remain excluded.
