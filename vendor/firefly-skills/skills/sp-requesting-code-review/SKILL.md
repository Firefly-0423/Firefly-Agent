---
name: sp-requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
modes: [code]
hiddenFromUi: false
---
# Requesting code review in Firefly

Firefly-maintained adaptation of Superpowers, not an unmodified upstream package. Source and license: [NOTICE](NOTICE.md), [LICENSE](LICENSE).

Use the existing `read_skill_reference` tool with skill_id `sp-requesting-code-review` and ref `code-reviewer.md` to read [the review brief](references/code-reviewer.md).
Establish the user-authorized scope, actual base and head commits, changed paths, requirements and existing verification before review. If the base is unknown, ask the parent/user instead of inventing a branch.

Firefly Main delegates only when available and permitted: `delegate_agent({agent_id: "review", prompt: "complete review brief"})`. Put actual paths and verified commit range into `prompt`; no model, session or authority parameter exists. Runtime owns persistent reuse. Specialists inherit normal approval/cancellation boundaries and cannot ask the user or delegate again; return missing context to Main. Without delegation, perform the same scoped review in the current run and say so.

Review correctness, security boundaries, data preservation and test coverage; findings need path, line, impact and evidence. Fix confirmed serious issues and re-review the changed scope. Keep uncertain or untested behavior explicit. Do not auto-commit, create worktrees, push, merge or run additional checks contrary to the user's instructions. Skills are guidance, not grants of tool permission.
