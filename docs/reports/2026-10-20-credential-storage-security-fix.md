# Credential storage and settings IPC remediation

Review baseline: `codex/sec-c5` at `7f9ebdfb4491fd90d444bbe7ea8669326a66e9f9`, compared with the uncommitted working tree. The initial working tree was clean. The user-named comparison worktree was `E:\Codex\Firefly_Agent-names`, branch `codex/own-names`, HEAD `114cbe883af293ddd702c10fdfd67edf6ee9ffdc` (a different revision, not assumed identical). No commits or pushes were made.

## Outcome and scope

Finding 5 (P2) is addressed for model settings, general settings, and WeChat iLink credentials when Electron safeStorage is available. The explicitly requested plaintext fallback remains supported and emits `CREDENTIAL_STORAGE_PLAINTEXT` at warning level. The additional settings IPC concern is addressed by checking owned windows, main frames, and shipped document URLs, and masking credentials for the chat/pet callers that do not edit them.

This is a surgical review of the changed storage/IPC paths, their callers, and regression tests. All 11 changed or new TypeScript files were reviewed for correctness, security, behavior compatibility, and error handling. The changes introduce no dependencies, quality threshold changes, test skips, or changes to the approval/permission model. All 55 excluded files matched their pre-edit SHA-256 hashes. No files under node_modules were edited.

## Per-finding remediation

| Finding / store | Root cause | Fix and files | Regression coverage |
| --- | --- | --- | --- |
| 5: model API keys | `saveModelSettings` serialized the complete runtime object, including the top-level key, provider cache, and every saved profile. | `src/main/settings/model-settings.ts` decodes before normalization, migrates legacy JSON on ordinary disk load, and encrypts every `apiKey` copy on atomic saves through `src/main/settings/credential-storage.ts`. Explicit read-only diagnostic preparation still never migrates or writes. | `settings-credentials.test.ts`: migration, all key copies, restart, plaintext fallback, unavailable/corrupt encryption, warm-cache downgrade refusal, failed-save cache preservation, diagnostic read-only behavior. `credential-storage.test.ts`: nested round trips, encryption/write/rename failures and cleanup. |
| 5: SMTP/ASR and other general settings credentials | `saveGeneralSettings` and the installer-choice persistence path serialized reusable secrets directly. | `src/main/settings/settings-facade.ts` uses the shared codec for read, migration, ordinary save, and installer-choice save. Protected fields include SMTP username/password, ASR credentials (including the legacy shared Mossland key), map and search API keys. | `settings-credentials.test.ts`: every protected field, unknown legacy metadata preservation during migration, installer-choice persistence, restart, fallback, decryption failure, encryption failure, and warm-cache downgrade refusal. |
| 5: WeChat iLink token | QR login wrote `botToken` to `weixin/credentials.json` as plain JSON. | `src/main/channels/adapters/wechat/ilink-bot-adapter.ts` migrates existing tokens on read and encrypts tokens on QR login. Unreadable encrypted data is retained and cannot be overwritten by a replacement login. The direct WeChat ASR settings reader also decodes the encrypted general settings before testing configuration presence. | `ilink-credentials.test.ts`: legacy token migration, QR-login encryption, token reload, fallback warning, corrupt/unavailable encryption, migration failure, and encrypted ASR configuration recognition. |
| Additional settings IPC concern | Full configuration/catalog/save responses returned secrets; several model settings handlers did not verify the caller. Existing general-settings checks already verified the source but still returned all secrets to chat/pet. | `src/main/settings/settings-ipc.ts` uses the existing `isFromHostDocument` boundary. Full config reads/saves and profile saves require the live settings window's main frame and exact settings document. Chat retains profile listing, default selection and deletion, with masked keys. Chat/pet general reads and chat general-save responses are masked. | `settings-credentials-ipc.test.ts`: development/production documents, settings editor values, masked chat/pet responses, permitted catalog operations, foreign windows, subframes, missing events, navigation, query mismatch, destroyed windows/WebContents, and rejection before writes. Existing read-error and input-modality tests now supply a legitimate sender without weakening their original assertions. |

The four new test files add 37 regression cases. Existing settings/provider/ASR contracts remain intact for their real consumers; no renderer source changes were necessary. Settings editors still receive the credentials they already use to edit/reveal values and test connections. Other windows receive `"********"` for configured credentials, preserving existing string types and presence checks.

## Persistence and migration guarantees

- The JSON container and non-secret settings stay readable. A non-empty credential is stored as `{ "$safeStorage": 1, "ciphertext": "<base64>" }`; only Main decodes it back to the original string.
- Legacy plaintext is read before migration. Migration encrypts the original parsed document, preserving unknown/retired fields rather than rewriting normalized defaults.
- Migration finishes encryption before creating a staging file. Writes use a unique, exclusively created staging file in the same directory, followed by rename. Encryption, staging-write, or rename failures leave the original file untouched; staging files are cleaned up. No plaintext backup copy is created.
- WeChat's asynchronous reader compares the original bytes again before migration, so a stale read cannot migrate over a newer login in the Main event loop.
- A migration failure logs a generic warning and continues serving the successfully read legacy credentials. Migration can retry on the next disk load/restart.
- If safeStorage is unavailable, existing plaintext remains usable and new plaintext saves remain possible, with an explicit warning. Existing encrypted data is never downgraded. A locked or corrupt encrypted settings file follows the existing read-failure/write-blocking behavior; WeChat returns no usable login and logs a warning while preserving the file. Restore safeStorage and restart to reload blocked settings.
- Encrypt/decrypt failures do not log credentials or raw crypto errors. Cache updates and notifications occur only after successful persistence.
- On Linux, the documented `basic_text` backend is treated as unavailable rather than presented as secure encryption.

The implementation follows the existing plugin secret store's synchronous Electron safeStorage pattern while retaining these settings' explicitly requested fallback behavior. The detected Electron version is `43.7.0`. Electron documents Windows protection through DPAPI and does not claim isolation from other applications running as the same user. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Differential security review

The original plaintext writers and unguarded model handlers trace to `f1f657954`; catalog views were expanded in `2bca649d0`, and general-settings sender checks were added in `5ad8e2e71`. The patch preserves those existing general-settings checks and extends the same document guard to the secret-returning model paths. No security checks were removed.

Production Main source contains these textual call/declaration expressions: `loadModelSettings` 39 across 19 files, `saveModelSettings` 11 across 4 files, `loadGeneralSettings` 43 across 11 files, `saveGeneralSettings` 11 across 5 files, and WeChat `loadCredentials` 2 in its adapter. These are search counts including dependency-interface calls, not a computed runtime call graph. Main return types remain plaintext for these consumers. The only separate direct JSON settings reader found was the WeChat ASR presence check, updated here. Renderer call-site inspection confirmed chat lists/selects/deletes profiles, while the settings page edits keys and fetches/tests models.

Adversarial checks covered a copied plaintext credential file, a copied encrypted file without usable safeStorage, corrupted ciphertext, an interrupted/failed save, a stale migration snapshot, and foreign/subframe/navigated IPC callers. No new security regression was found in the scoped diff. This does not establish or claim an untrusted-renderer exploit chain.

## Verification

Logs, temporary test configuration, and archive reports are under `output/security-c5/` (ignored build output).

| Check | Observed result |
| --- | --- |
| `npx tsc -p tsconfig.main.json --noEmit` | PASS, exit 0, including the final implementation. |
| Required `npx vitest run src/main/orchestrator src/main/skills` with the existing config | Both worktrees: 216 suites fail to load with native `realpath EPERM`; no test cases execute. This is not reported as a passing run. |
| Settings + WeChat tests with the temporary module-loader workaround | 28 files, 264 tests PASS. This includes all 37 new regression cases and existing relevant tests. |
| Orchestrator + skills plus four renderer regression files with the workaround | 181 files pass, 39 fail; 2,743 tests pass, 480 fail, 2 existing skips, 1 unhandled error. All 71 renderer cases pass. |
| Base orchestrator + skills with the same workaround | 176 files pass, 40 fail; 2,653 tests pass, 499 fail, the same 2 existing skips, 1 unhandled error. |
| Case-name comparison | 479 of the current run's 480 failed cases also fail on the base. The unhandled rejection on both runs is the native `realpath EPERM` in `harness-adapter-owner-lifetime.test.ts`. |
| Remaining unmatched failure | `prepared-model-call.test.ts`, `preserves runtime timeout errors (stream=true)`, timed out in the broad run and passed on base. A focused rerun on this worktree passed all 56 tests in that file; no code/assertion/timeout changes were made for it. |
| Diff and exclusions | `git diff --check` PASS; no remaining `.snap` diff; 55 excluded-file SHA-256 hashes unchanged. |

The workaround is isolated to `output/security-c5/vitest.config.mjs`: it imports the original config and changes only Vite's module-resolution option `resolve.preserveSymlinks` to `true`. Runs use `--config output/security-c5/vitest.config.mjs --configLoader native`. The native config loader avoids Vite's temporary config output under the dependency junction. Application filesystem checks and test assertions are not patched; consequently native realpath failures in actual runtime paths still surface. The base uses the equivalent `base-vitest.config.mjs`, importing its own config. `TEMP`, `TMP`, and `FIREFLY_TEST_REPORT_ROOT` point inside `output/security-c5/`, avoiding the sandbox temp directory's separate archive-rename error. Project config, dependency files, CI, and thresholds are unchanged.

The focused test command was:

```powershell
npx vitest run src/main/settings src/main/channels/adapters/wechat --config output/security-c5/vitest.config.mjs --configLoader native
```

The renderer files added to the broad workaround run were `provider-settings.integration.test.ts`, `desktop-asr-settings.test.ts`, `api/provider-ui.test.ts`, and chat's `model-catalog-load-state.test.ts`. No new tests were skipped. The two existing skips are symlink tests in `apply-patch-tools.test.ts` and `file-write-evidence.test.ts` and were already skipped in the base run.

Evidence:

- `output/security-c5/focused-tests.log` and `test-reports/2026-10-20T12-34-32-720Z-4494eca4-477f-483a-a7e2-6cb4865b761e/report.json`
- `output/security-c5/required-vitest.log` and `base-required-vitest.log`
- `output/security-c5/expanded-tests.log` and `base-expanded-tests.log`
- `output/security-c5/baseline-comparison.json` (case-by-case comparison)
- `output/security-c5/timeout-recheck.log` and `typecheck.log`

The broad tests updated `src/main/orchestrator/tools/__snapshots__/built-in-tools.snapshot.test.ts.snap`. The requested normal `git checkout -- <file>` was first attempted and failed because the managed sandbox cannot create the shared repository's `index.lock` outside this worktree. The file was then successfully restored using the same `git checkout -- <file>` with `GIT_INDEX_FILE` pointing to a copied index inside `output/security-c5/`. The real index was not changed. The comparison worktree's snapshot also matches its own HEAD.

Review recommendation: the scoped fix and regression tests are ready for review. Broad-suite acceptance remains limited by the demonstrated base/environment failures and the isolated broad-run timeout; this report does not claim an all-green suite or live Electron acceptance.

## Remaining limits and deliberate omissions

- The plaintext fallback remains an exposure whenever OS encryption is unavailable, as explicitly requested. It is surfaced through warning logs, not a new settings UI/status protocol.
- Older builds can parse the JSON/non-secret fields but cannot consume encrypted credential objects. Retaining a usable plaintext duplicate would defeat this fix; no downgrade conversion was added.
- Actual Windows DPAPI/account recovery, packaged Electron windows, live provider/SMTP/ASR services, and a real WeChat QR session were not exercised. safeStorage and network login responses are mocked in regression tests.
- This patch does not retroactively encrypt external backups, diagnostic copies, MCP server environment files, or other credential stores outside the specified scope.
- Renderer sandboxing, filesystem authorization, Shell sandbox grants, SSRF controls, and the approval/permission model are outside this task and unchanged.
- A full application build/installer was not run; the requested Main TypeScript no-emit verification avoids regenerating excluded product artifacts.
