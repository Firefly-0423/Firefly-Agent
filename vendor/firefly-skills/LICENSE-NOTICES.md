# Inherited Skills: verified license scope

## vNext current distribution

The current distribution contains 50 third-party and adapted Skills, pinned by `skills-manifest.json`. Firefly maintains host-specific instructions for the existing tool and specialist-session contracts. Source records and complete third-party licenses remain in this directory. Packaging copies these canonical directories directly; runtime uses the existing managed-directory synchronization.

The four project Skills in the repository-root `skills/` directory and the prompt support in `prompts/` are maintained by Firefly-0423 under the repository MIT license. They are loaded through the existing Skill and prompt composition paths; mode metadata does not grant tool authority.

## Historical pinned body upgrades

The API/interface-design and context-engineering Skills now use reviewed bodies from addyosmani/agent-skills commit `2686b620fc1fed2e8f60c704839c766b8594c6b6`, with Firefly frontmatter and explicit host/authorization adaptations. The discovery workflow is a Firefly-maintained adaptation of that source, using actual registered IDs and existing tool contracts rather than unavailable mandatory Skills. These three Skills retain complete MIT licenses and per-Skill NOTICE files inside their distributed directories. `license-provenance.json` records these current bodies under `currentBodyUpgrades`; earlier per-file matching records describe the prior bodies, not byte identity of the new adaptations.

These notices accompany the directly packaged `skills/` directory. The complete licenses in `licenses/` remain alongside the directory. They do not grant rights to unrelated Skills.

The distributed `xlsx/scripts/xlsx_workspace.py` now includes a Firefly-maintained worksheet-relationship path fix. Its source-layer replacement is `scripts/packaging/skill-adaptations/xlsx/scripts/xlsx_workspace.py`; the prior archive member had SHA-256 `676a2521264b2c87425233df12591f9fe5e0b207289806bad9d8ea828e680545`, and the adapted member has SHA-256 `7743ec3e6cb37a0d632b3133ca068b4ddff70288a5f493fbd8d35867dc413320`. The earlier provenance record identifies the inherited source; it does not claim the adapted file is byte-identical to that source. This change does not replace the remaining XLSX files or their source notices.

The 14 as- Skills derive from Addy Osmani / agent-skills; the eight ecc- Skills derive from Affaan Mustafa / ECC. The body comparison removes only frontmatter and outer whitespace. Original frontmatter differs from product metadata. Several upstream revisions have the same body; no unique original checkout is claimed. Per-file hashes, all matching revisions, and the exact license revisions are recorded in license-provenance.json. No script or resource exists inside these 22 distributed directories.

These files are inherited/adapted works, not wholly original Firefly work. Existing Superpowers notices inside the distributed directories remain applicable only to those nine Skills. The two licenses above do not cover other directories; their separate scopes and unresolved evidence are documented below.

## Other verified source scopes

- `docx`, `pdf`, `xlsx`, `pptx-generator`: MiniMax Skills, MIT; preserve both MiniMax and the bundled MiniMaxAI copyright. Raw/LF matches, translated references, Windows/Office-theme additions and Firefly edits are separately recorded. These directories include Firefly adaptations; no claim that the whole directory matches one MiniMax release. MiniMax MIT does not license external executables or libraries installed separately by the user.
- `skill-creator`: Anthropic skills and claude-plugins-official, Apache-2.0. All three inherited complete license texts remain in the distributed directories, including their original appendix placeholders; these were not filled with invented copyright. Root README/gitignore correspond to the official plugins repository, whose root Apache license was also checked. The SKILL body has product metadata, installation-directory and platform guidance adaptations. The supporting files are matched individually; this is not an official pristine single-version plugin.
- `self-improving-agent`: the current directory distribution uses a Firefly-maintained adaptation of Peter Skøtt Pedersen's `plugin/skills/self-improvement` at `8a71d7098d7c39494dcaa46254885225ddb5d259`. The same commit's complete `plugin/LICENSE` is included inside the Skill. Templates, entry examples and the manual extraction helper retain upstream content; the body uses Firefly's existing tools and authorization. External host hooks, install commands and the unavailable self-healing dependency are not delivered. The previous OpenClaw remake's ten unresolved files have been removed from the current directory distribution, not retroactively licensed. Existing user installations and backups are preserved; their historical content remains separate from the new distribution.

These are provenance and distribution notices, not endorsements. Keep all original author and license notices. The new self-improvement source and Firefly adaptation are explicitly distinguished from the old remake; a product rename is not a license grant. Those historical adaptations kept Skill IDs, modes and authorization unchanged; the vNext mode-only changes are declared above. Managed updates recognize the original body hash and preserve user modifications. Distribute the canonical directories together with the licenses and notices. The earlier ZIP changes remain historical provenance; current distribution uses the pinned directory manifest.

## Approved additions, 2026-10-05

- `tob-property-based-testing`: Trail of Bits property-based-testing at `82fe8226252622fa807643bdca1710901198553a`, CC BY-SA 4.0. The complete LICENSE and attributed change notice are inside its Skill directory. The adapted body and five references retain CC BY-SA 4.0; this does not relicense unrelated Firefly code. References match their pinned source bytes. No upstream agents/assets/evals or PBT dependency is installed.
- `ecc-production-audit`: Affaan Mustafa / ECC production-audit at `ef648e01899ba3e8dc6371642deaaf64b4477775`, MIT. Same-commit LICENSE and adaptation notice are retained inside its Skill directory. This is local-evidence guidance, with no installed scanner or deployment authority.
- Project `document-reader-validation` is independently authored Firefly guidance under MIT. It includes no Anthropic doc-coauthoring text.

## Approved additions, 2026-10-13

Eleven instruction-only Skills were added at the commits below. Each directory keeps the complete upstream LICENSE and a NOTICE.md naming the pinned source. Firefly changes only the SKILL.md frontmatter (directory ID, `effectKind: read`, `modes`, `hiddenFromUi`); every body and reference file is byte-identical to the pinned commit, and `license-provenance.json.currentDistribution.addedSkills` records both hashes. None grants tool, file, network or credential authority. All were read in full before inclusion.

- `frontend-design`: anthropics/skills `683bc88e56f3e09ba94f7055977f3d3aa499f202`, Apache-2.0 (LICENSE.txt, unchanged from the static review).
- `ac-prd`, `ac-documentation-writer`: github/awesome-copilot `156736fb63e965b2f547a1460f3b5972c46e6b24`, MIT, Copyright GitHub, Inc.
- `ws-architecture-decision-records`, `ws-error-handling-patterns`, `ws-stride-analysis-patterns`, `ws-accessibility-compliance`, `ws-data-storytelling`: wshobson/agents `46891e7e60da0e52baf1050b7b6391b64e84c6d9`, MIT, Copyright (c) 2024 Seth Hobson.
- `as-deprecation-and-migration`: addyosmani/agent-skills `1be8e34187e34647bb83adc3a1323b26ae6f6abe`, MIT, Copyright (c) 2025 Addy Osmani.
- `sp-receiving-code-review`: obra/superpowers `bb92a77741419a4ab5f06e711a283343f1ada0c3`, MIT, Copyright (c) 2025 Jesse Vincent.
- `ecc-agent-security-hardening`: affaan-m/ECC `b92f181b3b748d1abbc2afd94af6aa7d8c8fca29`, MIT, Copyright (c) 2026 Affaan Mustafa.

Current distribution is 50 vendor Skills plus four project Skills, 54 total.
