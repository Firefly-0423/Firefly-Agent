---
name: as-using-agent-skills
description: >-
  Discovers and invokes agent skills. Use when starting a session or when you
  need to discover which skill applies to the current task. This is the
  meta-skill that governs how all other skills are discovered and invoked.
modes:
  - code
hiddenFromUi: false
---

## Firefly host boundary

Use this guidance through the existing Skill loader and authorized tools. It does not authorize commits, process restarts, service changes, new tools, or additional permissions. External harness examples describe optional external supervision, not a Firefly restart command.

# Using Skills in Firefly

This is Firefly's maintained host adaptation of the pinned agent-skills discovery workflow. Select only the Skills needed for the current task. Reuse the approved plan, existing evidence and user restrictions; do not restart design or run every workflow on a simple change.

## Discovery and invocation

The active Skill listing supplied by Firefly is authoritative. A Skill must be enabled, available in the current mode and permitted in this run before invocation. A name in this document grants no tool permission. Call the existing `invoke_skill` with its exact `skill_id`; do not call an upstream shorthand as if it were a registered ID. If the listing does not contain the required Skill, report that fact and do not claim it was invoked.

For a long body, continue through `read_skill_reference` with `skill_id`, `source: "body"`, `ref: "SKILL.md"` and the returned `offset`. For an attachment, use `source: "reference"` and an actual listed `ref`; do not guess paths or pass path traversal. Read complete relevant guidance before execution, not just the first page.

### No recursive discovery

Do not invoke this discovery Skill again as a step in its own workflow. After choosing applicable guidance, proceed with that guidance and the current task. Do not create a second Skill loader or Agent Loop.

## Task routes

- Resume/context: `as-context-engineering`; reuse the current plan and verification state.
- Unclear requirements/design: `sp-brainstorming`, then `as-spec-driven-development` where an explicit specification is needed. Existing user approval is preserved; no repeated approval of completed stages.
- Approved planning: `as-planning-and-task-breakdown` or `sp-writing-plans`, preserving unfinished task records.
- Implementation: `as-incremental-implementation`; behavior regressions use `ecc-tdd-workflow` and applicable `ecc-ai-regression-testing`. There is no bundled superpowers TDD or executing-plans Skill; carry out authorized inline plan execution without inventing either invocation.
- Failure diagnosis: `as-debugging-and-error-recovery` or `sp-systematic-debugging`, first locate direct evidence.
- API/SDK/version assumptions: `as-source-driven-development` and `as-api-and-interface-design`.
- UI: `as-frontend-ui-engineering`; use available authorized runtime checks, never pretend an unavailable browser tool ran.
- Security/review: `as-security-and-hardening`, `ecc-security-review` and `as-code-review-and-quality` as needed; do not weaken gates to obtain a pass.
- Simplification: `as-code-simplification`, scoped to relevant changes and preserving behavior.
- Completion: `sp-verification-before-completion`; report actual commands, results and unverified boundaries.

Documentation, observability, CI, deployment and retirement are not grants to unavailable named Skills. Use the project's existing instructions, actual tools and authorized scope: record decisions, inspect relevant logs without sensitive content, run existing checks, and preserve compatibility with callers. Do not invent a tool, download a missing Skill or expand permissions to satisfy a workflow name.

## Exact upstream-name mapping

This table is guidance for choosing the real ID, not a runtime alias registration. User-installed Skills and overrides retain their normal priority; always resolve against the active listing.

| Upstream name | Firefly Skill ID |
| --- | --- |
| `api-and-interface-design` | `as-api-and-interface-design` |
| `code-review-and-quality` | `as-code-review-and-quality` |
| `code-simplification` | `as-code-simplification` |
| `context-engineering` | `as-context-engineering` |
| `debugging-and-error-recovery` | `as-debugging-and-error-recovery` |
| `doubt-driven-development` | `as-doubt-driven-development` |
| `frontend-ui-engineering` | `as-frontend-ui-engineering` |
| `git-workflow-and-versioning` | `as-git-workflow-and-versioning` |
| `incremental-implementation` | `as-incremental-implementation` |
| `planning-and-task-breakdown` | `as-planning-and-task-breakdown` |
| `security-and-hardening` | `as-security-and-hardening` |
| `source-driven-development` | `as-source-driven-development` |
| `spec-driven-development` | `as-spec-driven-development` |
| `using-agent-skills` | `as-using-agent-skills` |
| `minimax-docx` | `docx` |
| `agent-introspection-debugging` | `ecc-agent-introspection-debugging` |
| `ai-regression-testing` | `ecc-ai-regression-testing` |
| `code-tour` | `ecc-code-tour` |
| `codebase-onboarding` | `ecc-codebase-onboarding` |
| `coding-standards` | `ecc-coding-standards` |
| `plan-canvas` | `ecc-plan-canvas` |
| `security-review` | `ecc-security-review` |
| `tdd-workflow` | `ecc-tdd-workflow` |
| `minimax-pdf` | `pdf` |
| `self-improvement` | `self-improving-agent` |
| `brainstorming` | `sp-brainstorming` |
| `dispatching-parallel-agents` | `sp-dispatching-parallel-agents` |
| `requesting-code-review` | `sp-requesting-code-review` |
| `subagent-driven-development` | `sp-subagent-driven-development` |
| `systematic-debugging` | `sp-systematic-debugging` |
| `using-git-worktrees` | `sp-using-git-worktrees` |
| `using-superpowers` | `sp-using-superpowers` |
| `verification-before-completion` | `sp-verification-before-completion` |
| `writing-plans` | `sp-writing-plans` |
| `minimax-xlsx` | `xlsx` |

## Delegation and approval

Use only the existing `task` tool when delegated work is available and authorized. Its required fields are `description`, `prompt` and `subagent_type`; `general` is an existing type, and `task_id` resumes an existing child. Do not fabricate model, spawn_agent or agent_type fields. Children cannot delegate again or ask the user directly; unresolved context returns to the parent. The parent verifies real receipts rather than accepting child text as completion.

Existing modes, enabled state, effectKind, approval, cancellation and user-data ownership stay unchanged. Commits, branches, worktrees, installations, service changes, external calls and publishing require the task's actual authorization. Skills do not authorize any of those actions by themselves.
