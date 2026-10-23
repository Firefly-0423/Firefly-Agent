---
name: sp-subagent-driven-development
description: Use when executing implementation plans with independent tasks in the current session
modes: [code]
hiddenFromUi: false
---
# Plan execution with Firefly task agents

Firefly-maintained adaptation of Superpowers. [NOTICE](NOTICE.md) distinguishes source material and new implementations; [LICENSE](LICENSE) preserves upstream permission.

Use the approved plan; do not restart design, create another Agent Loop or treat this Skill as authorization. Read the plan's exact requirements, dependencies, quality gates and user restrictions. Work one task at a time unless actual independence and permission are established.

Retrieve briefs through the existing `read_skill_reference` tool, skill_id `sp-subagent-driven-development`:
- ref `implementer-prompt.md`: [implementation brief](references/implementer-prompt.md).
- ref `task-reviewer-prompt.md`: [specification and quality review](references/task-reviewer-prompt.md).
- ref `re-review-prompt.md`: [focused re-review](references/re-review-prompt.md).

Only Firefly Main orchestrates with `delegate_agent({agent_id, prompt})`: use `implementation` for implementation, `review` for review, `security-governance` for security and `coordination-debug` for complex debugging. Supply full requirements/context in `prompt`; runtime owns persistent reuse by conversation/workspace/agent. No model, session or authority override is accepted. Specialists cannot delegate or question the user directly; return missing context and coordination suggestions to Main. Permissions, approval and cancellation remain owned by Firefly's existing execution chain. Reused sessions are not fresh independent reviewers; report that boundary honestly.

For each task: extract a precise brief; implement within scope with a failing regression first for changed behavior; run affected checks; review against requirements and quality; fix proven findings and re-review. Stop after five unsuccessful fix/review rounds and report the blocker to the parent/user; never relax tests. Do not silently proceed past blocking findings. Fresh reviews must receive the actual current diff and prior findings, not only the implementer's assurances.

Optional local helpers retain their names but are new Node implementations maintained by Firefly. In PowerShell set `$skillDir` to the exact local directory returned by `invoke_skill` before running any helper; relative Markdown links below are for reading only:
- `node (Join-Path $skillDir 'scripts/sdd-workspace') PLAN_FILE`: [workspace helper](scripts/sdd-workspace).
- `node (Join-Path $skillDir 'scripts/task-brief') PLAN_FILE TASK_NUMBER`: [brief extraction](scripts/task-brief).
- `node (Join-Path $skillDir 'scripts/review-package') PLAN_FILE BASE_SHA HEAD_SHA`: [read-only Git review package](scripts/review-package).

Paths above are relative to this installed Skill directory. The helpers need a project Git directory and Node on PATH; use only public/authorized plan files. They create ignored local review files, never commit or publish. Their scripts do not install dependencies. If the runtime cannot execute Node or Git, carry out brief extraction/review via existing authorized file/tools and explicitly report that helpers were not run.

Keep existing user changes and configured enabled/mode states. Commits, branches, worktrees, package installs, service calls and pushes require separate authorization. Parent settles final task results from actual receipts and tests, not solely child text. Record unresolved checks rather than declaring completion.
