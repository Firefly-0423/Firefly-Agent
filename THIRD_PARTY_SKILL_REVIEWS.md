# External Skill static reviews

These are engineering license-scope and complete-text compatibility reviews, not legal advice, runtime verification, installation, or activation. The Main-only static table is `src/main/skills/external-reviews.ts`. User confirmation cannot create or bypass a review. Synthetic test entries never appear in this table.

## Review boundary

Review binds the fixed source, full 40-hex commit, canonical repository-relative Skill directory, SHA-256 of sorted `[path, sha256, decodedBytes]` tuples encoded as compact UTF-8 JSON, and the explicit `policyVersion`. The initial named policy is `firefly-instruction-only-v1`; an approval under another or missing policy cannot approve an import. Every actual byte is checked against the file's SHA-256, Git blob SHA-1 and decoded size. The exact declared inventory must equal the complete prepared payload. T4 must derive that inventory from the verified complete tree, not a user-selected subset.

The marketplace separates latest discovery, the unique newest application-reviewed fixed snapshot under the current policy, and verified installed bytes. Renderer supplies only `latest`/`reviewed` plus an expected commit; Main selects the corresponding snapshot. A reviewed entry remains discoverable after HEAD removes its path, including a valid empty latest catalog. Selecting it fetches its pinned catalog/tree and revalidates the complete payload. A changed HEAD never inherits its approval. Discovery/network failures remain visible failures rather than silently claiming a current catalog. Imports do not replace an existing installation; the existing TARGET_EXISTS and rollback rules remain.

The existing frontend-design record below is assigned this initial policy for its original exact bytes and original scope; this does not approve a newer commit or add a new reviewed Skill. New installation records retain the policy version. Earlier installed records without it remain distinguishable as legacy provenance; listing one does not create a current-policy review or grant a new import. Installed identity is shown only after committed state, ownership marker and the complete installed content pass the existing verification. Activation still requires the separate installed-Skills confirmation.

All imported files must be inside the selected Skill directory. This MVP has no agreed mapping for importing a required ancestor LICENSE/NOTICE; such a candidate stays blocked pending adaptation. Ancestor text may be evidence of absent conflicts, but applicable required notices cannot be silently omitted. Supported payloads contain SKILL.md, applicable LICENSE/LICENCE/COPYING and NOTICE/COPYRIGHT text, and `.md`/`.txt` files immediately under `references/`. Unsupported files, nested references, binary/non-UTF-8 text, host-only frontmatter, required scripts, host APIs/tools/other Skills, or required remote retrieval block the entire item. No text is stripped, rewritten or executed. Named aesthetic references and explicitly optional capabilities are not required runtime dependencies.

Allowed license IDs are exactly MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC. Every file needs exact reviewed coverage and an included, byte-verified applicable license with substantive terms. License labels, adjacent boilerplate, package declarations and renderer flags alone are insufficient. The static reviewer must resolve actual scope and all applicable copyright and NOTICE obligations. Content heuristics are additional fail-closed checks, not a substitute for that review.

## Firefly's own source and the Firefly-native policy

[Firefly-0423/firefly-skills](https://github.com/Firefly-0423/firefly-skills) is a third source. It is read as a Claude marketplace catalog, like `anthropics/skills`, and reviewed under `firefly-native-v1`; the two third-party sources stay on `firefly-instruction-only-v1`.

The Firefly-native policy is the instruction-only policy with two differences:
- It accepts Firefly's own frontmatter fields: `modes` (known modes), `effectKind` (known effects) and `tools` (tool ids). Each is strictly validated, and a malformed value blocks the Skill rather than being dropped.
- It does not apply the "requires a tool" body heuristic, because these Skills are written for Firefly's tools.

Everything else applies unchanged: the exact-commit and content-digest binding, the supported file shapes, the remote-resource, script, library and cross-Skill checks, and every license rule. A review entry under this policy also pins those fields in `native`. They must equal what the Skill declares, and the install record keeps them. Registration takes them from that record, never from the installed files. They only limit visibility and label the Skill; the host still decides every tool permission.

A market Skill whose name is a Skill that ships with Firefly is listed as built in and is never prepared or installed, so no second copy exists. At commit `81e0bb6658705fdce08896186626243ba978367a` all four Skills in the repository (`diagram`, `document-reader-validation`, `knowledge-workspace`, `plugin-development`) are byte-identical to the built-in ones, so no review entry is recorded for them.

To draft an entry for a future Skill, run `node scripts/security/external-skill-review-draft.mjs <local clone> <commit> <skill path> firefly`. It prints the hashes, license evidence and Firefly metadata Main will check. It leaves `reviewer` empty, so an unedited draft approves nothing: read every file, fill in the reviewer, and record the rationale here.

## Reviewed: ai-cs-research and general-learning (Firefly-native)

- Repository: [Firefly-0423/firefly-skills](https://github.com/Firefly-0423/firefly-skills)
- Commit: `709cd2a076a50093bc909ff7e61985c8d9db8b09`
- Directories:
  - [skills/ai-cs-research](https://github.com/Firefly-0423/firefly-skills/tree/709cd2a076a50093bc909ff7e61985c8d9db8b09/skills/ai-cs-research)
  - [skills/general-learning](https://github.com/Firefly-0423/firefly-skills/tree/709cd2a076a50093bc909ff7e61985c8d9db8b09/skills/general-learning)
- Policy: `firefly-native-v1`
- Static conclusion: PASS for each complete six-file instruction-only payload
- Reviewer: Claude Code static review for Firefly-0423, 2026-10-30. The draft is from `scripts/security/external-skill-review-draft.mjs`, and every file was read in full.

Canonical content digests:
- `ai-cs-research`: `0bca14ab9301530d7496922d29f7fd7c8f2916c8c164292c17c636b1ef0856ea`
- `general-learning`: `25c681d07383edbae8561bd0e88b40191d6b4b464c1eb1cf48040a212fbc20e0`

Payload: each Skill is `SKILL.md`, `LICENSE`, `NOTICE.md` and three Markdown files directly under `references/`. There are no scripts, assets, links or nested paths.

License: each `LICENSE` is the repository's MIT text (Copyright (c) 2026 Firefly-0423), SHA-256 `19f8615650a1f98f1866e019542334808ae19731fa264f9e174de5e0cde7bb03`, and covers all six files. Each `NOTICE.md` names the projects consulted for method (OpenAI notebook guidance, Claude Scholar, ARIS, scholar-tools, Orchestra AI Research Skills, Hugging Face Skills for research; similar learning references) and states that no upstream code, templates or Skill bodies are redistributed. Nothing in the text reproduces those projects.

Firefly metadata:
- `ai-cs-research` declares `modes: [work, code]`; `general-learning` declares `modes: [work]`.
- Both declare `effectKind: mutation`, because they may save notes or results through the host's file and knowledge tools.
- Neither declares `tools`.

Body review:
- Both are method guidance. They require no script, dependency, download, remote resource, connector or other Skill. Each states that loading it grants no command execution, installation, upload, cost or new permission, and that the host's refusals are not to be bypassed.
- The host tools they name exist and are described accurately:
  - `read_skill_reference` (the Skill tools);
  - `pop_quiz` (1–3 questions per call; types choice, multi, true_false and short_answer; `learningObjective` required; optional `sourceRef`; no native fill-in-the-blank, as `general-learning` says).
- `knowledge-workspace` conventions are used only when a valid Vault exists, and neither Skill requires it.

Package root: the catalog declares the repository root (`./`) as the plugin package, so the root is checked for plugin components too. At this commit the repository tooling lives in `tools/`, and the root has no `scripts/`, `hooks/`, `bin/`, MCP or settings files.

Not tested: model adherence, real-model runs and learner outcomes. A new commit, any changed file or a new capability needs a fresh review.

## Reviewed: frontend-design

- Repository: [anthropics/skills](https://github.com/anthropics/skills)
- Commit: `683bc88e56f3e09ba94f7055977f3d3aa499f202`
- Directory: [skills/frontend-design](https://github.com/anthropics/skills/tree/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design)
- Static conclusion: PASS for the complete two-file instruction-only payload
- Reviewer: Firefly T3 implementation static review, 2026-10-08T04:42:50.000Z
- Canonical content digest: `444b2331df1f7dc747db4f4ec6cd3d8a84a41c00855041336d424aeb8ca65589`

Exact complete payload:

| Repository path | Bytes | SHA-256 | Git blob SHA-1 |
| --- | ---: | --- | --- |
| skills/frontend-design/LICENSE.txt | 10174 | 0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594 | f433b1a53f5b830a205fd2df78e2b34974656c7b |
| skills/frontend-design/SKILL.md | 9390 | d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3 | a5333457c414d20d625f307df945842c0952ecc3 |

The [Skill frontmatter](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/SKILL.md) explicitly directs to the adjacent [LICENSE.txt](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/LICENSE.txt), containing Apache License 2.0 sections 1–9. Scope is these two files only, not the entire repository/plugin. Both original files must be preserved byte-for-byte. There is no explicit copyright statement in this payload; none is invented from another Skill.

The pinned complete recursive tree and fresh pinned directory evidence show exactly these two ordinary files, no scripts, assets, links, nested paths, references or local NOTICE. Fresh root and `skills/` listings contain no ancestor LICENSE. The [README](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/README.md) describes open-source Apache examples separately from the source-available document Skills; it is context, not the sole license proof. The [root THIRD_PARTY_NOTICES.md](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/THIRD_PARTY_NOTICES.md) lists imageio, imageio-ffmpeg, FFmpeg, Pillow and fonts. None of those components is included or required by the two-file design guidance; no applicable component NOTICE was identified. The complete root notice remains part of the external review evidence.

The body is textual design guidance. It does not require retrieving the named book The Elements of Typographic Style. Memory, screenshots and note space are conditional capabilities. Writing frontend code is the downstream user task, not an import-time bundled dependency. Model adherence, actual host runtime, frontend tooling and output quality were not tested. Host safety and instruction precedence still apply.

This review rechecked preserved connected-GitHub evidence, exact decoded bytes, SHA-256, Git blob hashes, complete pinned directory/tree, and ancestor licensing context. It made no new network request and ran no upstream content. Expanded payload, newly applicable NOTICE, changed content, changed commit or a new required capability needs a fresh review.

## Blocked: brand-guidelines

[skills/brand-guidelines](https://github.com/anthropics/skills/tree/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/brand-guidelines) at the same pinned commit is a complete two-file payload (`SKILL.md`, `LICENSE.txt`). Its frontmatter points to the adjacent Apache-2.0 terms; the scope is this directory, not all Anthropic Skills. This is not added to the static table: the body says color application is via `python-pptx`'s RGBColor class, an unsupported required library/tool capability. Its Poppins/Lora typography is explicitly conditional with Arial/Georgia fallback, so font names alone are not classified as a mandatory download. Any potentially applicable font notice and runtime adaptation must be resolved before approval; no dependency is installed and no text is silently removed. Static conclusion: BLOCKED / DEPENDENCY_BLOCKED, with runtime compatibility and notice scope unresolved.

The pinned complete tree and preserved bytes were checked for both files: `skills/brand-guidelines/SKILL.md` is 2235 bytes, SHA-256 `1120b3769e2985cefb3d25be981b1f914abeba57ae079b83c20c666c164fa9fe`, Git blob `47c72c607bdb5dd81bdea5de2b5e4f3992a5fd59`; `skills/brand-guidelines/LICENSE.txt` is 11345 bytes, SHA-256 `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362`, Git blob `4f881c52d1f72f4cfb720e339e2d35c3058d01a9`. These hashes are review evidence, not an approved allowlist entry.

## Blocked: OpenAI candidates

No OpenAI Skill is currently approved. A source may have zero importable entries while remaining browsable.

[chatgpt-app-submission](https://github.com/openai/plugins/tree/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/openai-developers/skills/chatgpt-app-submission) has a complete two-file text payload at commit `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f`, but the adjacent Apache terms do not resolve the parent [plugin manifest's Proprietary declaration](https://github.com/openai/plugins/blob/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/openai-developers/.codex-plugin/plugin.json). No explicit skill licensing declaration or repository-root license clarifies that scope. Static conclusion: BLOCKED / LICENSE_BLOCKED. The submission-inspection instructions do not themselves require the surrounding connector; no fictitious connector blocker is substituted for the actual license ambiguity.

`build-chatgpt-app` remains unreviewed/blocked: no exact complete-payload, affirmative license-scope and supported-host review is recorded. Surrounding package licensing or connector access is not inferred to grant approval. No installable OpenAI example is forced.
