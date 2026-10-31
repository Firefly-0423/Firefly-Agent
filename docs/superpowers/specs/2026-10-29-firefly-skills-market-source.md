# Firefly's own Skill repository as a market source

Status: approved (user, 2026-10-29). Decisions:
- Our Skills are reviewed one by one, like Anthropic's.
- They get a Firefly-native review policy rather than the instruction-only one.
- A market Skill that is already built in is shown as built in, not offered for install.

## Today

| | Plugin market | Skills market ("外部市场") |
| --- | --- | --- |
| Source | `Firefly-0423/firefly-plugins`: `registry.json` on `main`, packages from its Releases | `openai/plugins` and `anthropics/skills` only (`EXTERNAL_SOURCES` in `src/main/skills/external-policy.ts`) |
| Trust | The remote registry pins each package SHA-256; Main refuses a mismatch; a bundled catalog is the offline fallback | Listing is open, but installing needs an in-app static review: `EXTERNAL_SKILL_REVIEWS` pins source, commit, path, content SHA-256 and every license file |
| Our repo | Connected | `Firefly-0423/firefly-skills` is not a source |
| Reviews today | n/a | One entry (Anthropic `frontend-design`) |

Bundled Skills are a third thing: `vendor/firefly-skills/skills` holds 50 upstream Skills copied into the installer. It is not related to the `firefly-skills` GitHub repository and is out of scope here.

`Firefly-0423/firefly-skills` today:
- four Skills: `diagram`, `document-reader-validation`, `knowledge-workspace` and `plugin-development`;
- each with `SKILL.md`, `LICENSE` (MIT) and `NOTICE.md`;
- a Claude-format catalog at `.claude-plugin/marketplace.json` (one bundle listing the four Skill roots, `strict: false`).

## Findings that shaped the design
- All four Skills in `firefly-skills` are byte-identical (same Git blobs) to the built-in `skills/` directory of this repository. The repository is the public release of the built-in Skills. Offering them in the market would install a second copy under an `external-firefly-…` id, which the specialist bindings (keyed by Skill name) would not recognise.
- They carry Firefly frontmatter: `modes` (all four), `effectKind: mutation` (three) and `tools` (`knowledge-workspace`, the four Obsidian tools). The instruction-only policy accepts only `name`, `description`, `license`, `version` and `metadata`, and blocks body lines that require a tool, so all four would be blocked.
- These fields are metadata, not grants:
  - `modes` limits visibility;
  - `tools` labels the catalog entry ("sharing grants no tool permission");
  - `effectKind` classifies an invocation for permission prompts.

  The host still enforces every tool permission.
- Installed external Skills take their metadata from the host's install record, never from the untrusted files (`external-scan.ts`: `tools: []`, no `modes` or `effectKind`).

## Change

1. **Source.** Add `firefly` to `EXTERNAL_SOURCES`: repository `Firefly-0423/firefly-skills` and catalog `.claude-plugin/marketplace.json`.
   - Give each source a `catalogFormat`. Anthropic and Firefly both use `"claude-catalog"`.
   - The Anthropic-only branch in `external-manifests.ts` and `external-sources.ts` becomes a check on that format, so Firefly gets the same catalog parsing and the same `declaration: "verified"` handling.
2. **One list of sources.** `ExternalSkillSourceId` gains `"firefly"`. These validators read `EXTERNAL_SOURCES` instead of repeating `"openai" | "anthropic"`:
   - `external-ipc.ts`;
   - `external-review.ts` (`isExternalSkillReview`);
   - the Renderer's source tabs.
3. **Firefly-native policy.** The `firefly` source reviews under `firefly-native-v1`; third-party sources keep `firefly-instruction-only-v1`.
   - Allowed: the extra frontmatter keys `modes` (known modes), `effectKind` (known effects) and `tools` (tool ids).
   - Not applied: the "requires a tool" body heuristic.
   - Still applied: the remote-resource check, the file-shape rules and all license rules.
   - The review entry pins these values in a `native` field. The install record stores them, and `external-scan.ts` uses them; they must equal the parsed frontmatter, or the item is blocked.
4. **Built in.** A market Skill whose name is a Skill Firefly ships (the built-in directory or the installer's managed Skills) is listed as built in and cannot be prepared or installed, so there is never a second copy. Today all four are built in, so no review entries are added now.
5. **Reviews (later Skills).** Add one static review per Skill at the current `firefly-skills` commit. Each entry pins:
   - `policyVersion: firefly-native-v1`, `compatibility: instruction-only`, and the `native` metadata;
   - the path and the content SHA-256;
   - the license: the Skill's own `LICENSE`, SPDX `MIT`, covering `SKILL.md`, `NOTICE.md` and the `LICENSE`.

   The rationale goes in `THIRD_PARTY_SKILL_REVIEWS.md`, like the Anthropic one. A Skill whose files change at a later commit is shown as needing review and cannot be installed until a new entry ships.
6. **Review helper.** A small script prints a draft entry for a given commit and Skill path, using the same hashing as Main. The reviewer still reads the files and decides. Its output is a proposal, never an approval.
7. **UI.** A third tab, "Firefly-0423/firefly-skills", placed first and selected by default. Built-in items show a 已内置 label instead of an install action. The open-source tabs stay as they are.
8. **Boundary test.** `skills/external-boundary.test.ts` pins the reviewed hashes of the boundary files. Update it together with the source list, as its comment requires.

## Not changing
- The plugin market and its trust model.
- `vendor/firefly-skills` (bundled upstream Skills).
- Any runtime, script or hook support: Skills stay text only. The Firefly-native fields are reviewed metadata, never grants.

## Tests
- A source and catalog test: the Firefly catalog lists its four Skills; an unknown source id is refused at IPC and in reviews.
- A review match test:
  - a Skill at the reviewed commit with matching hashes is installable;
  - one changed byte, or a new commit with changed files, is shown as needing review;
  - a missing `LICENSE` is blocked.
- Updated `external-boundary.test.ts` hashes.
- A real check in the demo profile: open the market, see the Firefly tab, install `diagram`, and use it in a session.

## Release flow afterwards
Change a Skill in `firefly-skills` → run the helper at the new commit → review the files → add or replace the entry → ship the app.
