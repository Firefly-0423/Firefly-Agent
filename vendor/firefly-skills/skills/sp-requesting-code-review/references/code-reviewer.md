# Firefly review brief
Firefly-maintained adaptation based on Superpowers; see the Skill's NOTICE and LICENSE.

Parent supplies: requirement, authorized scope, repository path, BASE_SHA, HEAD_SHA, changed paths, verification records and known limitations.
The child uses the existing task general execution context, not a separate agent runtime.

1. Confirm the actual range and read the relevant definitions, callers and tests.
2. Check both fulfillment and overreach: requirements, API contracts, permissions, cancellation, resource cleanup, data compatibility and security.
3. Separate earlier defects from this diff. Never label a missing runtime check as a proven defect without code evidence.
4. Report each finding with severity, path and line, reasoning, impact and proposed minimal handling.
5. State checks performed, test coverage and unverified behavior. Do not turn a passing focused test into a full-suite claim.
6. Review read-only. Do not commit, push, merge, install packages, change settings or invoke external services unless separately authorized. If blocked, return the exact missing context to the parent.

Return: findings ordered by severity; requirements fulfilled/missing; checks and limitations; readiness assessment. Absence of findings is not proof of universal safety.
