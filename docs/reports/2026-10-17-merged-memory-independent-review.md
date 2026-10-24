# Firefly PR109 follow-up review

## Executive summary

No actionable Critical, Important or Minor findings in the exact committed range `444d50eede292115b13fbcf41e62303b3525c913..f38895d12e5b29e6c9716639abad4ddfd2b6302a`.

| Severity | Findings |
| --- | ---: |
| Critical | 0 |
| Important | 0 |
| Minor | 0 |

Assessment: ready to continue the authorized local Phase2 work from this head. This is a review of the two follow-up fixes only, not an assessment that the rest of Phase2 is implemented, released or ready to deploy. PR109's previously completed merge is not being requested or repeated.

## What changed

Two commits, four files, 130 insertions and six deletions:

| File | Added | Removed | Review focus |
| --- | ---: | ---: | --- |
| src/main/memory-policy/natural-protocol.ts | 8 | 4 | Selected category label, negative marker and retained validation |
| src/main/memory-context/main-default-memory.test.ts | 57 | 0 | Real textarea -> settings IPC -> SQLite correction |
| src/main/orchestrator/firefly-agent.ts | 12 | 2 | Safe public metadata on errors and owned close failure |
| src/main/agui-chat-failure.integration.test.ts | 53 | 0 | Real no-tool ChatLoop -> FireflyAgent -> bridge chain |

`fac50b997579c5ec1f228650674a4abda4197b9b` fixes prefills. `f38895d12e5b29e6c9716639abad4ddfd2b6302a` fixes failure metadata.

## Findings and strengths

No actionable findings.

P1: `natural-protocol.ts:129` recognizes the five generated labels after the existing NFKC normalization; `:130` rejects a recognized label belonging to another category. `:131` preserves the explicit negative marker, and `:139` extracts the value rather than storing the assertion label as part of that value. Existing quote, hypothetical, instruction, sensitivity, size and secret validation remains in the path. Main derives the selected category from the target record and commits an authorized settings user event; `main-policy.ts:71`, `:114` and `policy-repository.ts:351` retain target/revision checks. Repository correction still independently reparses the stored source and checks current source role/trust (`policy-repository.ts:369`). Background extraction does not gain authority from this label parser.

The added UI test cases (`main-default-memory.test.ts:905`) cover all five categories and a negative tool prefill, assert actual submitted action text, pure value/canonicalValue, subject/slot/entity/assertion identity, stale revision refusal, forgetting and post-forget refusal. The rejection cases begin at `:948`. Existing complete-statement and shell compatibility tests remain intact.

P2: `firefly-agent.ts:31` unwraps only the known AgentExecutionError wrapper and constructs a fresh Error with the existing safe user message plus `publicRunFailure`'s two finite fields. Provider message/body, arbitrary source and cause are not copied. Both the normal catch (`:599`) and owned close catch (`:610`) use it. The bridge maps the result again at `agui-bridge.ts:884` before sending only safe code/message/source. The original cancellation branch, close-before-terminal ordering and bridge settlement gate remain unchanged. The added integration test at `agui-chat-failure.integration.test.ts:31` fakes only the external transport and exercises the actual chain, including close failure and unrecognized metadata fallback.

## Test coverage and verification evidence

Reviewed existing author-generated logs and run manifests; these were not rerun by this read-only reviewer:

- `.verification/runs/review-prefilled-red-behavior-1792245936881-6950469c`: seven behavioral failures and two passing rejection cases. Failures include stored value/assertion mismatches and a foreign-category label.
- `review-prefilled-green-1792246008176-de44a819`: nine selected tests passed.
- `review-memory-regression-1792246048109-c5d03002`: 234 tests passed in four files.
- `review-chat-failure-red-behavior-1792246035582-cbefa24c`: three actual-chain metadata assertion failures and one passing fallback case.
- `review-chat-close-red-1792246092480-b26934a7`: owned-close metadata assertion failed.
- `review-chat-failure-green-1792246137208-f648fdd3`: 144 tests passed in five files.
- `review-main-typecheck-1792246162289-de8ca492`: Main TypeScript noEmit command exited zero.

The behavioral RED logs contain actual assertion mismatches, not setup/import errors. The green run manifests identify their precommit HEADs; these are recorded implementation-time checks, not fresh executions at the final commit. The isolation launcher uses an allowlisted environment and synthetic profile/cache/temp roots, without inherited API keys.

Fresh reviewer checks: `git diff --check <base> <head>` exited zero; `git diff --exit-code <head> -- <four reviewed files>` exited zero; HEAD remained exactly `f38895d12e5b29e6c9716639abad4ddfd2b6302a`. Only the two plan files were modified concurrently by the parent for bookkeeping. No source, test, index, HEAD or branch was mutated by this reviewer.

## Blast radius

`parseNaturalEdit` has four direct production calls, split between Main validation/event creation and repository revalidation. `naturalAssertion` has two direct production calls. The new `safeTerminalError` has two calls inside FireflyAgent. `runWithEvents` has four production calls including the internal standard-agent wrapper; its bridge, channel and scheduler error consumers still receive an Error and retain existing handling. The scope uses surgical review within the larger repository (1,860 tracked TypeScript/TSX files).

## Historical context

Blame was checked for replaced parser and terminal-error lines. The existing normalized semantic checks from `3ab888fdf` remain. Existing safe-message classification and owned close/terminal sequencing from `38d60b578` remain; the fix adds finite metadata alongside them. No security validation was removed or weakened in the reviewed range.

## Recommendations

No blocking remediation for these two fixes. Continue with the authorized local Phase2 plan and its own RED/GREEN work; retain the existing tests and error/source allowlist.

## Method and limitations

All four changed files and surrounding production paths were reviewed for correctness, security, readability, architecture and performance. Trust boundaries checked: untrusted textarea/model text -> host-authorized source-backed correction; private provider exceptions -> finite renderer error metadata. No new dependency or unbounded operation was introduced.

Declined to judge: incomplete Phase2 job/consent/recovery functionality, Android, real UI acceptance, real providers, real profiles/databases/keys and release/deployment readiness, because those are outside this authorized review. No package installs, network/provider calls, full-suite reruns, UI/process changes, remote writes or subagents were used. No suspected actionable finding required a synthetic reproduction.

Preserved limitations: the inherited source-button i18next object-key warning and inherited runStore lazy cleanup are not newly adjudicated or expanded here. The recorded memory regression also contains a MaxListenersExceededWarning. These are not presented as regressions caused by this range.

The requesting-code-review skill loaded; its code-reviewer.md reference could not be fetched. The requested Critical/Important/Minor and readiness structure is used here. Confidence is high for the exact reviewed diff and caller analysis; no independent dynamic test execution is claimed.

## References

Base: `444d50eede292115b13fbcf41e62303b3525c913`.
Head: `f38895d12e5b29e6c9716639abad4ddfd2b6302a`.
Previously merged PR109: `d2a58dbae9f6392bdf0df109c23633f84e39c191` (parent-provided history; no remote query).