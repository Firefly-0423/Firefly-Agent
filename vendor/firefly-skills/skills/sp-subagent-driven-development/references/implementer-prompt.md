# Firefly implementation brief
Firefly-maintained adaptation; upstream attribution is in NOTICE and LICENSE.

Parent supplies: task requirements, allowed files, repository path, current progress, constraints, dependencies and exact verification commands.
Use the existing task general context with inherited permissions. No nested delegation; no direct user question. If required information is absent, return BLOCKED with the missing information.

Implement only the approved task. Preserve prior changes. For changed behavior, add and run a test exposing the issue before the implementation, then run affected regressions. Do not discard existing code to simulate test-first practice. No automatic commits, worktrees, package installs, pushes, resets or changes to permissions.

Self-review requirements, errors, cancellation, data handling and cleanup. Report DONE, DONE_WITH_CONCERNS or BLOCKED, changed paths/reasons, real commands/exit results, evidence and limitations. DONE_WITH_CONCERNS does not authorize the parent to ignore blockers.
