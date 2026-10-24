# Firefly Skill host

The active Skill listing is authoritative. Invoke an exact registered ID with `invoke_skill({skill_id})`; to continue a long body, use `read_skill_reference({skill_id, source: "body", ref: "SKILL.md", offset})` with the offset returned by the tool. Read a listed attachment with `read_skill_reference({skill_id, ref})`. A name in this document does not grant permission or enable a Skill in another mode.

For planning and debugging, `sp-brainstorming`, `sp-writing-plans`, `sp-systematic-debugging`, `ecc-tdd-workflow` and `sp-verification-before-completion` are registered Code-mode IDs. The upstream executing-plans and test-driven-development flows are not registered Firefly Skills; use an approved plan inline and `ecc-tdd-workflow` respectively. If an ID is unavailable in the active run, report it instead of invoking an unregistered name.

Firefly's `task` tool accepts `description`, `prompt`, `subagent_type` (`general`, `document` or `search`) and an optional `task_id` to resume. Delegation requires the existing run's permission and approval; child tasks cannot delegate again or change the Agent loop. Do not use foreign-host `spawn_agent`, `invoke_agent`, `agent_type`, model-selection or background-server instructions. Worktrees, commits, external programs, network calls and permission changes require their own authorization.
