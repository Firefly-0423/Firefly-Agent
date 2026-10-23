# Independent review: external skills batch 1

Date: 2026-10-18. Reviewer: the single independent review agent, using the requested Critical / Important / Minor code-reviewer template.

**Reviewed range:** `88443aa28a184ea3f7cec17b698fce1a2ca8b547..b131aaa9ef87bea9866cc8f94dd3431a10cd18af`, branch `codex/external-skills-batch1-20261018`, worktree `E:/Codex/2026-10-18/task-2/firefly-external-batch1`.

**Recommendation: With fixes; do not merge this head yet.** Found **0 Critical, 3 Important, 2 Minor** issues. The important issues are in format adaptation, not a demonstrated bypass of fixed-commit approval or a demonstrated code-execution path. Each was checked with concrete synthetic input rather than inferred from test names.

## Strengths

- Main retains source, path, commit, payload and approval authority. IPC and the service validate the selector; the supplied commit is checked against Main's chosen latest or reviewed snapshot. No renderer-supplied review, path or policy becomes authority.
- Current-policy exact-content matching, ambiguity rejection, independent installed-file verification, DTO stripping and disabled installation are explicit. Reviewed discovery uses its own fixed commit rather than asking HEAD to authorize the older bytes.
- Failed-review detail refresh uses the original operation generation and clears the actionable preview first. The new identity checks include repository, path and commit. The existing cancellation barrier and commit ownership flow remain present.
- The manifest adapter is a small separate passive module. No dependency or lockfile changes, source-allowlist expansion, derived package stripping, candidate lifecycle invocation or installer privilege expansion appears in the diff. The baseline chat/sidebar implementation is outside the changed files.

## Issues

### Critical (Must Fix)

None found in the reviewed range.

### Important (Should Fix)

#### I1. Portable fallback overlays do not receive the nested-extension checks applied to legacy Codex

**Location:** `src/main/skills/external-manifests.ts:80`, `:82`; contrast `:86–92`. Introduced in `b131aaa`.

**Trigger:** A portable root manifest has no inline OpenAI overlay and uses a compatibility manifest containing `extensions.com.openai`. For example:

```json
// plugins/bundle/plugin.json
{"name":"bundle","license":"MIT"}
// plugins/bundle/.codex-plugin/plugin.json
{"name":"bundle","skills":"./skills","extensions":{"com.openai":{"onboardingSkill":"./skills/setup/SKILL.md"}}}
```

Add ordinary synthetic text at `skills/text/SKILL.md`, its scoped MIT LICENSE and `skills/setup/SKILL.md`. Supply an exact current-policy synthetic review for the complete `skills/text` payload. The documented compatibility form supports the nested onboarding declaration; it must be treated as a host component by this passive importer. [OpenAI package reference](https://developers.openai.com/plugins/build/plugins#add-an-onboarding-skill).

**Observed:** `verifyExternalSkillDeclaration` returns verified with no dependency issues. `evaluateExternalSkill` returns `review: "approved", blockers: [], dependencyIssues: []`. A second fixture using nested `hooks: "./lifecycle.json"`, with the hook configuration outside the default `hooks/` directory, produces the same result. No setup skill or hook command was executed during these checks.

**Cause and impact:** `inspectFields` allows the `extensions` key as metadata, but the portable fallback branch never inspects its contents. The legacy-only branch does. The original mixed package can therefore lose a required host component without a dependency blocker, contradicting the batch's whole-candidate policy. An exact static review remains necessary; changing an upstream commit alone does not inherit approval. This is a compatibility-policy bypass, not evidence that hooks execute in Firefly.

**Fix:** Reuse one conservative compatibility-overlay inspector for both standalone Codex and portable fallback manifests. Inspect supported nested OpenAI fields and block other active nested extensions. Reject active extra nesting in inline overlays. Preserve the documented whole-overlay replacement rule; do not merge the ignored legacy overlay into an inline one.

**Coverage / blast radius:** One production adapter caller (`external-sources.ts:150`), one service declaration call (`external-service.ts:296`), reached by both detail and prepare for latest and reviewed selections. `external-manifests.test.ts:49` covers top-level fallback hooks and `:72` covers nested standalone Codex settings, but their combination is absent. Add fallback nested onboarding/hooks/MCP and unexpected nested-extension fixtures, plus a service assertion that preparation creates no stage.

#### I2. Claude manifest presence expands root catalog selections, and strict conflicts are accepted

**Location:** `src/main/skills/external-sources.ts:92–95`; `src/main/skills/external-manifests.ts:67–68`, `:95–96`. Introduced in `b131aaa`.

**Trigger A:** A root-source marketplace entry explicitly selects one skill, and an optional plugin manifest exists:

```json
// .claude-plugin/marketplace.json
{"plugins":[{"name":"bundle","source":"./","skills":["./skills/selected"]}]}
// .claude-plugin/plugin.json
{"name":"bundle"}
```

The tree also contains `skills/selected/SKILL.md` and `skills/unlisted/SKILL.md`.

**Observed:** Both paths are discovered and both receive `declaration: "verified"`, no dependency issues, and only `REVIEW_REQUIRED`. With two root-source entries selecting disjoint skill paths, the same manifest causes broad enumeration for each entry; duplicate IDs then reject the entire catalog with `CATALOG_INVALID`.

**Trigger B:** A local Claude package has its own manifest while the entry sets `strict: false` and an entry `skills` component. The adapter still returns verified with no dependency issue.

**Expected and impact:** Root-source explicit selections suppress the default skill scan; strict-false entries with manifest plus entry components are conflicts. These are source-selection rules, not optional runtime features. The current adapter advertises unselected or conflicting content as declared, and valid disjoint catalog groups can stop loading. Exact Firefly review still prevents an arbitrary unreviewed import. [Claude manifest reference, marketplace combination rules](https://code.claude.com/docs/en/plugins-reference#marketplace-entries-and-the-manifest).

**Fix:** Model effective Claude roots and strict/conflict state once, then use those rules consistently in discovery and declaration verification. Keep root-source explicit selection restrictive when a manifest exists. Retain default-plus-extra behavior for ordinary local plugin packages where it applies. Reject or explicitly block strict conflicts with their catalog/manifest path.

**Coverage / blast radius:** One production discovery call (`external-service.ts:240`); both latest and pinned reviewed discovery use it. Both service detail and prepare consume declaration verification. `external-manifests.test.ts:87` checks root explicit selection only without a manifest; `:92` checks catalog additions only for a subdirectory package. Missing combinations are root plus manifest, disjoint root entries plus manifest, and strict false plus entry components. The baseline at `88443aa` enumerated only the root entry's supplied paths (`external-sources.ts` old line 76); the broadened scan is new.

#### I3. Catalog display-license precedence hides a restrictive package declaration from the existing license guard

**Location:** `src/main/skills/external-manifests.ts:117`; consumer `src/main/skills/external-review.ts:146–147`. Introduced in `b131aaa`.

**Trigger:** A Claude catalog entry says `license: "MIT"`, its `.claude-plugin/plugin.json` says `license: "Proprietary"`, and the selected skill has the ordinary synthetic reviewed MIT text payload. For example:

```json
{"plugins":[{"name":"bundle","source":"./plugins/claude","license":"MIT"}]}
// plugins/claude/.claude-plugin/plugin.json
{"name":"bundle","license":"Proprietary"}
```

**Observed:** The adapter returns `bundle.license: "MIT"` and no licensing blocker. The real evaluator, given exact current-policy synthetic review evidence, returns `review: "approved", blockers: []`.

**Cause and impact:** The catalog's display value short-circuits the manifest value. Consequently the evaluator never sees the restrictive declaration and its existing fail-closed package-license check cannot run on it. Claude's catalog precedence is explicitly a display-field rule; it should not erase licensing evidence for Firefly's import decision. [Claude marketplace display-field reference](https://code.claude.com/docs/en/plugins/marketplace-reference#display-fields). This finding concerns the software's conservative policy, not a legal determination about which license actually applies. The exact static approval gate remains intact.

**Fix:** Keep display precedence separate from admission evidence. Check all applicable package declarations for unknown/restrictive or unresolved conflicting scope and retain `LICENSE_BLOCKED` as required by the existing importer policy. A permissive display label must not clear it. Validate the manifest value even when a catalog value is present.

**Coverage / blast radius:** The same single adapter-to-service declaration path feeds the full evaluator and stage admission. `external-review.test.ts:244` already checks that `bundle.license: "Proprietary"` stays blocked; that test bypasses the new adapter and cannot catch information lost upstream. Add adapter-to-evaluator regressions for both override directions and malformed shadowed declarations, with a no-stage service case.

### Minor (Nice to Have)

#### M1. Claude bundle version precedence is reversed

**Location:** `src/main/skills/external-manifests.ts:116`, introduced in `b131aaa`.

With catalog `version: "entry-9"` and manifest `version: "manifest-3"`, the verified result says `entry-9`. Claude gives the manifest's version priority. [Claude metadata precedence](https://code.claude.com/docs/en/plugins-reference#metadata-precedence). The displayed and persisted bundle version is therefore inaccurate, although commit/digest identity and authorization are unaffected. Prefer the manifest version, then the entry and existing fallback; test a conflicting pair. This uses the same synthetic fixture as I2, so no separate broad test run is needed.

#### M2. Unsupported metadata-file modes lose the actionable file evidence

**Location:** `src/main/skills/external-manifests.ts:39`, introduced in `b131aaa`.

A `100755` root manifest causes `DEPENDENCY_BLOCKED` with the generic message `External operation failed.` before the adapter returns a dependency issue. The failed-review follow-up detail also fails on the same file, leaving no selected detail that can show the path or mode reason. Refusal is safe, but the new actionable-diagnostics behavior does not cover metadata files. Preserve a blocked candidate with a `file-mode` issue naming the manifest/config path without parsing or executing it. `external-service.test.ts:83` covers this for a payload SKILL file only; add a metadata-file case. The synthetic check confirmed the generic error and absent returned issue.

## Coverage, history and blast radius

All **31 changed files / +1034 -110 lines** were reviewed. There are **16 production/DTO/translation files**, **10 test files**, **1 fixture helper**, and **4 documentation files**. This was a complete diff review with deeper analysis of trust boundaries, rather than a full fresh audit of every unchanged module in the repository.

| Changed group | Files reviewed | Focus |
| --- | --- | --- |
| Main authority and formats (9) | `external-ipc.ts`, `external-manifests.ts`, `external-policy.ts`, `external-review.ts`, `external-reviews.ts`, `external-revisions.ts`, `external-service.ts`, `external-sources.ts`, `external-state.ts` | Selector authority, exact approval, policy, full payload, catalog semantics, snapshot invalidation, installed proofs |
| Shared / bridge / UI (7) | `external-types.ts`, `src/shared/external-skills.ts`, `src/preload/index.ts`, `ExternalSkillsPanel.tsx`, `SkillModePanel.tsx`, `en.json`, `zh-CN.json` | DTO persistence boundary, cancellation/races, confirmation, copy and escaped diagnostics |
| Tests and helper (11) | `external-{bridge,contract,ipc,manifests,review,revisions-selection,revisions,service,sources}.test.ts`, `ExternalSkillsPanel.test.ts`, `testing/external-fixtures.ts` | Behavior assertions and untested input combinations; no new test skips or suppression additions found |
| Documentation (4) | `THIRD_PARTY_SKILL_REVIEWS.md`, `docs/external-skills-compatibility.md`, batch spec and plan | Original-byte approval scope, stated limitations, official source semantics |

Read the progress ledger and generated review diff/task brief material as context. Compared the exact commits directly. Read unchanged one-hop fetch, frontmatter, installation/rollback, scan, external access-gate and path-proof code. Existing staging still verifies every retained payload file and commits disabled, and an existing target still fails. Git history attributes the removed explicit Anthropic enumeration and replaced declaration verifier to baseline import/merge `963fd46`; the new format implementation is `b131aaa`. The range has three commits: `7f77b87` (failure state), `734643b` (revisions/policy), `b131aaa` (formats).

Production call-site counts from `git grep`, excluding tests and definitions: manifest inspector **1**, declaration verifier **1**, discovery **1**, evaluator **1**, reviewed-selector helper **3**, selector validator **2**, installation verifier **9** (the new service presentation call plus existing install/state/scan/access consumers). The findings' internal call counts are small, but the shared admission path serves both UI operations and both revision choices.

### Requested review focus

| Focus | Review result |
| --- | --- |
| Failed review followed by slow detail; source/version changes | Generation checks occur after both awaits; stale follow-up cannot publish into the current selection. Existing source-race and version-preparation tests were inspected. No defect found in this path. |
| HEAD changes bytes/removes the entry | Reviewed choice resolves a Main-selected fixed commit, reads that commit's catalog/tree, and rechecks bytes. The removed/empty-catalog tests verify separation from latest approval. Discovery failures remain explicit errors. |
| Malicious renderer commit/path/policy/review input | IPC rejects extra selector fields and Main revalidates shape and expected commit. Current-policy exact static approval remains required. No new renderer authority found. |
| Portable overlay precedence | Whole inline-overlay replacement is correct for the tested top-level case. Fallback nested-extension handling is incomplete: I1. |
| Mixed packages, empty MCP, unsupported modes | Empty MCP maps are read as inert JSON. Whole payload files remain retained and mixed Remotion stays blocked in supplied evidence. I1 and M2 identify gaps at metadata boundaries; I3 identifies lost licensing evidence. |

## Testing actually performed and verification evidence

- Ran **two read-only Node stdin synthetic-check invocations**, each exit **0**, against this worktree's existing compiled production `external-sources`, `external-manifests`, `external-review` and policy modules with its own dependencies. Inputs and fake fetch responses were memory-only; Node ran as CommonJS. No fixture was written to disk, no candidate module/command was imported or executed, and no network or real user configuration was used. Windows process/realpath access required environment escalation, which was granted for these checks.
- Invocation 1 observed: nested fallback hooks `approved / []`; selected and unlisted Claude root skills both `verified`; bundle version `entry-9` for a manifest version `manifest-3`.
- Invocation 2 observed: documented fallback onboarding `approved / []`; strict-false conflict `verified / [REVIEW_REQUIRED]`; shadowed Proprietary license `MIT / approved / []`; disjoint root catalog `CATALOG_INVALID`; executable manifest `DEPENDENCY_BLOCKED` with only the generic error.
- Independently ran `git diff --check BASE HEAD`: exit **0**. Verified HEAD is the requested `b131aaa`, branch name is as above, and tracked/untracked Git status was clean before writing this report outside the checkout. A final readback still showed HEAD `b131aaa` and a concurrent author modification to `external-manifests.test.ts`; that uncommitted repair work is excluded from this fixed-commit review.
- Inspected author-produced `E:/Codex/2026-10-18/task-2/audit/batch1/task3-regression.log`: **736 passed, 1 skipped, 19 test files passed**. The recorded skip is the existing Windows symlink privilege case (`ERROR_PRIVILEGE_NOT_HELD (1314)`), not a newly introduced skip. These are the author's results, not a fresh reviewer suite run.
- Inspected `audit/batch1/real-remotion-result.json`: the compiled-review check records **58 original files / 561339 bytes**, digest `be1b704d0941cf8537a91753714e54705a74e6b88245d3c314b21aeb474e614d`, and `DEPENDENCY_BLOCKED + REVIEW_REQUIRED`. I did not execute or import Remotion.
- Did not rerun the full project suite or build, mutate code for mutation testing, install dependencies, or run packaging/SDK checks. The parent is responsible for the ongoing full verification; no full-suite success is claimed here. The one-condition mutation experiment in the general quality skill was superseded by the task's explicit read-only restriction.

## Recommendations

Address I1–I3 in one test-first correction pass, using the concrete combinations above. Keep the exact-approval, whole-payload, current-policy and disabled-import gates. The Claude model should distinguish discovery selection, source conflicts, display metadata and admission evidence; a shared small helper is preferable to more format-specific exceptions. Fix M1 alongside those semantics; retain M2 as an explicit minor decision if deferred.

## Declined to judge

- Actual MCP connection/execution, device connectors and an executable skill host: explicitly deferred to later batches; reviewed only passive detection and absence of new execution paths.
- Automatic replacement, upgrade or rollback to an already installed target: this batch intentionally retains `TARGET_EXISTS`; assessed preservation, not a new upgrade feature.
- Offline catalogs and persistent download caches after network/catalog errors: explicitly excluded; assessed that errors remain errors and did not require an offline fallback.
- Separate plugin-market patch `2d53b41` / PR 115: explicitly excluded, not integrated, and not part of the actual changed files.
- Fresh exhaustive audit of unchanged dependencies, installer/EXE packaging, deployment and same-OS-user kernel isolation: outside this diff review; no dependency changes or new isolation claims were made.
- Pixel-level Electron UI and live upstream/account/device interoperability: prohibited or outside the allowed synthetic review; code and supplied tests were reviewed, but no live acceptance result is asserted.

No other behavior considered during this review was silently set aside as outside the spec. In particular, root catalog selection, strict conflicts and conflicting license evidence were assessed as real user expectations rather than dismissed because the plan did not enumerate each fixture.

## Assessment

**Ready to merge? With fixes.** The revision/IPC/race design preserves its intended authority boundaries, but the reproduced format-policy gaps prevent approval of head `b131aaa`. Fix the important findings and complete the parent's full verification before integration.

**Confidence:** High for the concrete adapter/evaluator findings and their source locations; medium-high for the reviewed state/cache/IPC reasoning. Independent execution covered synthetic production adapters/evaluator only, not a fresh end-to-end Electron import, activation or full-suite run. No review action was denied or left with an uncertain outcome. The report is the only file written by this reviewer.
