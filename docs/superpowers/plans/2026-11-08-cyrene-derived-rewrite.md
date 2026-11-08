# Rewrite of code derived from Cyrene-Agent

Date: 2026-11-08. Branch: `dev/cyrene-rewrite` (from `hotfix/1.1.4` at 46423d7).

## Why

Issue #46: Cyrene-Agent (MIT, `Copyright (c) 2026 Playa`) asked us to confirm code reuse. A comparison against
Cyrene `04a648a` (2026-11-06) found code that Cyrene committed in July–August and Firefly added on 2026-10-24
(17b76f1, "Firefly 1.1.0"), unchanged except for brand names. The owner chose to rewrite it.

The released versions 1.1.0–1.1.4 already contain that code, so the MIT notice for those releases is the owner's
separate decision; this plan only removes the derived code from the source going forward.

## How each item is done

- Rewrite from Firefly's own requirements and the existing behavior (tests, protocol, callers), not by editing
  Cyrene's text line by line. Names, structure and decomposition change; the public protocol with Main stays, since
  Main is Firefly code.
- Keep behavior: the existing tests (or their rewritten replacements) must pass before and after.
- Proof per item: `scratchpad/cyrene/runs.cjs` reports no run of 8 or more identical meaningful lines against Cyrene
  for the rewritten files, and the whole-file hash check reports no identical file.

## Inventory (lines in identical runs / meaningful lines)

| # | Area | Files | Shared |
|---|---|---|---|
| 1 | Screenshot helper tests | `native/tests/*.rs` (6) | 1647 / 1647 |
| 2 | Screenshot helper source | `native/src/win/{renderer,window,capture,capture_dxgi}.rs`, `native/src/{request,protocol,geometry,app,error}.rs` | ~350 / ~4000 |
| 3 | Chat page | `ChatPage.tsx`, `ConversationSidebar.tsx`, `CodeGitPanel.tsx` | 531 |
| 4 | Main services | `social-context/*`, `lsp/*`, `plugin-host/{scheduler-service,active-chat-target,secrets-service}.ts`, `sim/*` | ~300 |
| 5 | Tests in Main | `transcript-sink.test.ts`, `perf-trace.test.ts`, `tool-runtime.test.ts`, `lsp/types.test.ts` | ~120 |
| 6 | Scattered fragments | ~20 files with a single 8–16 line run | ~200 |
| 7 | Whole small files | plugin `examples/*` manifests and `ui.html`, `tsconfig*.json`, `reset.css`, `toast.css`, `mpv-binary.ts`, `.github` templates, `tool-output-store.ts`, `env.ts`, `prompts/work_remark.md` | — |

Not in scope: the Live2D model files (credited to their creator in `THIRD_PARTY_NOTICES.md`; structural JSON
similarity comes from the Cubism format) and vendored third-party files (Anthropic skills, licenses).

## Order

1 → 2 → 3 → 4 → 5 → 6 → 7, one commit per item, each with the comparison output in the commit message.
Then the pending 1.1.4 work resumes in order: push the review fixes, PowerPoint/Excel threads, full suite,
packaging, installer check, release notes SHA.
