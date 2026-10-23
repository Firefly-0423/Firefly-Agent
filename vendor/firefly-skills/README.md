# Firefly vendor Skills

`skills/` in this directory is the canonical source of the 50 currently distributed vendor Skills. The repository-root `skills/` contains exactly four Firefly-maintained capabilities: `diagram`, `document-reader-validation`, `knowledge-workspace`, and `plugin-development`. The vendor source is packaging input, not an additional runtime scan root.

`skills-manifest.json` pins the 50 IDs and every canonical file hash. Packaging copies `skills/` and the manifest directly to `resources/firefly-skills/`; runtime validates them, synchronizes managed directories into the user Skills area, and scans the existing builtin/user sources. The packaged vendor directory is not another scan root.

The subtree's `-text` Git attribute preserves the canonical file bytes without changing repository-wide EOL policy.

## Sources and licenses

- [`../../scripts/packaging/upstream-skills/sources.json`](../../scripts/packaging/upstream-skills/sources.json) is the upstream acquisition catalogue.
- [`license-provenance.json`](license-provenance.json) is the licensing/provenance authority; preserve historical scope and limitations.
- [`LICENSE-NOTICES.md`](LICENSE-NOTICES.md) and each Skill's LICENSE/NOTICE retain applicable author, license and modification notices.

The canonical directory contains 50 Skill IDs and 294 files. `license-provenance.json.currentDistribution` records current distribution hashes separately from third-party source evidence.

Voice, hygiene and planning support is in `prompts/persona-support/` and `prompts/workflow-support/`. They are not auto-injected Skills. General tone remains owned by the existing `prompts/tone-rules.md` chain; scene samples are maintenance references and are not automatically loaded. Work hygiene uses the Work prompt layer; plan-mode guidance and its references load only in the existing plan state. Current-ID settings and managed directory synchronization use [`src/main/skills/index.ts`](../../src/main/skills/index.ts) and [`directory-install.ts`](../../src/main/skills/directory-install.ts). Persistent specialist delegation is documented in the [runtime architecture](../../docs/architecture/firefly-runtime.md).

## Historical adaptation versus current generation

`scripts/packaging/skill-adaptations/`, `skill-replacements.json`, and `skill-repairs.json` retain upstream/source reconstruction and historical adaptation evidence. They are not a hidden override of current canonical source. The current manifest and managed-state hashes protect installed content from unintended replacement.

Current distribution changes must preserve mode declarations, tools, effectKind, hidden flags, user overrides and managed-update protections. Content/layout maintenance is not proof of real-model, external Office, GUI, installer, cross-platform or public redistribution clearance.

## Validation and distribution

Run `npm run validate:skills` after canonical edits. The validator checks the 50 vendor IDs, four project IDs, every pinned vendor file hash, bodies, path safety and required legal materials. After reviewing canonical edits, run `node scripts/packaging/update-skills-manifest.mjs` to regenerate the directory manifest and current distribution hashes. Validation does not rewrite files or create a ZIP.

`electron-builder.yml` copies only the canonical `skills/` directory, directory manifest, notices, provenance and licenses from this vendor root. The project-maintained four Skills remain in the separate top-level `skills/` installation folder. Development/acquisition materials and the retired ZIP are not packaged.
