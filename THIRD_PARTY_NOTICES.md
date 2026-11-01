# Third-party notices

## node-forge signature regression inputs

`node-forge` is a Digital Bazaar dependency under its BSD/GPL dual license;
Firefly uses the BSD option and installs it unmodified (1.4.2, which fixes
CVE-2026-85393 upstream). The public modulus and malformed signature in
Firefly's regression test come from upstream PR #1152, commit
`ceba34402e329f0365134f23fe19898756527d65`, and keep their attribution and BSD
terms in [the source record](vendor/security/node-forge/SOURCE.md) and
[complete BSD license](vendor/security/node-forge/LICENSE).

## Marketplace plugins adapted from deepseek-harness

The offline marketplace plugins `json-tools`, `timezone-tools`, `code-language` and `text-trim` (under `examples/`) adapt small, dependency-free utilities from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), which is MIT-licensed, `Copyright (c) 2026 DeepSeek`: `packages/util/values`, `packages/util/time`, `packages/util/code-language` and `packages/util/output-retention` (the code-language table was copied from commit `86a402200d95fecef4529d969836f1fe13c6cb0d`). Each package's own `LICENSE` and `README.md` keep that notice and say what is adapted and what is new Firefly code. Only the logic of those libraries is reused; no deepseek-harness runtime, service, dependency or native code is included, and these plugins are not endorsed by or affiliated with DeepSeek.

## Character and visual assets

- **Live2D model.** The Firefly Live2D files in `src/renderer/public/models/firefly/` (manifest, model binary, texture, physics, expressions and motions) are the "Firefly 流萤前瞻小人桌宠" desktop pet model by **是依七哒**, published on Steam Workshop. On 2026-08-30 the creator granted the project owner permission to use the model in Firefly and to adapt its motions, expressions and parameters for the desktop pet, with the creator and source credited when the project is published. This is a permission for Firefly, not an open license: the model is not covered by this repository's MIT license, and anyone who wants to reuse it outside Firefly must ask the creator. The project owner keeps the record of that permission.
- **Original artwork.** The avatar in `src/renderer/public/avatars/firefly-avatar.png`, the app and tray icons in `assets/icons/`, the twelve task portraits in `src/renderer/assets/task-portraits/` and the 29 stickers in `src/renderer/public/stickers/` were drawn by the project owner for Firefly.
- These are fan works of _Honkai: Star Rail_ characters. Any other character artwork that is added later needs its own source and permission record before it is distributed.
- **UI fonts.** The build bundles two variable UI fonts from npm, imported by `src/renderer/ui/fonts.css`: Noto Sans SC (`@fontsource-variable/noto-sans-sc`, by Google) and JetBrains Mono (`@fontsource-variable/jetbrains-mono`, Copyright 2020 The JetBrains Mono Project Authors). Both are under the SIL Open Font License 1.1, which allows bundling them with software; they are not sold on their own. Each package's full `LICENSE` is copied to `licenses/NotoSansSC-OFL.txt` and `licenses/JetBrainsMono-OFL.txt` in the installer. The UI also supports user-imported local fonts. The build also includes KaTeX `.woff`, `.woff2`, and `.ttf` math fonts from the `katex` dependency. KaTeX is MIT-licensed, with `Copyright (c) 2013-2020 Khan Academy and other contributors`; its full `node_modules/katex/LICENSE` is copied to `licenses/KaTeX-LICENSE` in the installer. Other fonts require separate review before bundling.
- Firefly and _Honkai: Star Rail_ character IP, artwork, names, and lore belong to HoYoverse / miHoYo. The project is unofficial. MIT covers the source code, not those assets or underlying IP.

## JavaScript packages and plugins

Runtime and build dependencies are declared in `package.json` and locked in `package-lock.json`; their individual package licenses remain applicable. The retired `vendor/cloud-music-mcp/` source is no longer shipped. Its provenance and license remain in repository history and historical migration records. The project-maintained SDK is built from this repository as `@firefly_wu/plugin-sdk`, with the original MIT notice included, and its releases are published to npm from `.github/workflows/plugin-sdk-publish.yml`. The upstream plugin registry is no longer a default service; local ZIP installation remains available.

## Skill frontmatter parsing

Skill metadata uses [Eleventy's gray-matter fork](https://github.com/11ty/gray-matter/tree/v3.0.0), `@11ty/gray-matter@3.0.0`, under the MIT license, `Copyright (c) 2014-present, Jon Schlinkert`. Preserve the complete dependency LICENSE when redistributing it. The runtime YAML engine is `js-yaml@5.4.3`, MIT-licensed, `Copyright (C) 2011-2015 by Vitaly Puzrin`.

The scalar grammar in `src/main/skills/skill-frontmatter.ts` adapts the safe float grammar from [js-yaml 3.15.2](https://github.com/nodeca/js-yaml/blob/3.15.2/lib/js-yaml/type/float.js); its complete [MIT license is retained](vendor/security/skill-frontmatter/js-yaml-LICENSE). Firefly maintains the data-only language allowlist and compatibility adapter, not a new YAML parser. The old unscoped gray-matter dependency is removed from this path. The installed fork still exposes a JavaScript engine; Firefly rejects that language before dispatch and supplies explicit YAML/JSON engines.

## ZIP parsing and extraction

The project currently uses `yauzl@3.4.0` for ZIP parsing. It is MIT-licensed, `Copyright (c) 2014 Josh Wolfe`; the complete original license remains at `node_modules/yauzl/LICENSE` and must remain with redistributed copies of that dependency. This notice does not replace or rewrite that license.

`src/shared/zip-extraction.ts` is the project's adapter for validating entries and writing extracted files. It is not an `extract-zip` fork, contains no copied `extract-zip` code, and does not claim an independently implemented ZIP parser. The unscoped `extract-zip` package is absent from both the lockfile and the installed dependency tree. The separate scoped package `@electron-internal/extract-zip` remains an Electron third-party dependency; it is not the project's replacement ZIP implementation.

## Inherited application Skills

The distributed `vendor/firefly-skills/` includes [complete additional licenses and scoped notices](./vendor/firefly-skills/LICENSE-NOTICES.md) and [file-level provenance](./vendor/firefly-skills/license-provenance.json). Distribute these materials and the complete licenses alongside the current directory-based Skills distribution. They identify the applicable authors and sources separately; no single repository license is applied to all Skills. The current self-improvement implementation uses a documented Firefly adaptation of Peter Skøtt Pedersen's pinned source with its complete license. The previous OpenClaw remake's ten unresolved files are absent from the current distribution, not retroactively licensed. Historical installations and backups remain separate from this distribution.

The nine bundled `sp-` Skills originate from [Superpowers commit ebdd4ec61f2f560bada4f6ded7b0806e62bf33f7](https://github.com/obra/superpowers/tree/ebdd4ec61f2f560bada4f6ded7b0806e62bf33f7) with Firefly host adaptations. Each carries the complete MIT LICENSE, `Copyright (c) 2025 Jesse Vincent`, and a provenance NOTICE. Supporting platform references retain their identified source history; this is not an official pristine single-version upstream distribution.

Firefly maintains the review/delegation adaptation, four reference briefs and three new Node helpers. The PPTX adaptation repairs six local anchors without changing generation behavior. These changes are not claimed as unmodified upstream originals. Other inherited Skill families retain their own source and license evidence; the Superpowers MIT text does not grant rights to unrelated assets. Current scope and adaptation evidence are recorded in the dependency governance report. This does not clear unrelated artwork or all release assets for redistribution.

## Current sticker source

The 29 current Firefly stickers were supplied by the repository owner for this resource update. This source record does not claim original authorship or transfer the underlying artwork/IP rights; the applicable asset permissions remain separate from the source-code MIT license.

## Historical design research sources

Retired design notes identified BiliNote (`https://github.com/JefferyHcool/BiliNote`, recorded there as MIT), moesnow/March7thAssistant (recorded there as GPL-3.0), and SnowLuma as external research or integration references. Removing those obsolete plans does not claim authorship of these projects or grant redistribution rights. The original GameBot research boundary prohibited copying March7thAssistant code, templates, images, configuration and artwork. The SnowLuma proposal did not include its binary and left its distribution license for separate verification. No such implementation or binary is added by this documentation cleanup. These are provenance records, not a new license audit or a claim that a proposed integration is available.

## Git for Windows MinGit 2.55.0.3

Simple-git 4 uses `@simple-git/argv-parser@2.0.1`, MIT, Copyright (c) 2025 Steve King. Firefly maintains a narrow Windows null-device compatibility adaptation, documented with exact input/output hashes and its complete license in [vendor/security/argv-parser](./vendor/security/argv-parser/SOURCE.md). This preserves bundled Git's configuration isolation without enabling unsafe configuration paths or inherited pager execution; it is not an upstream release. The package's original identity and license remain unchanged.

The Windows packaging configuration includes [Git for Windows MinGit 2.55.0.3](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.3) as a fallback when the user's system Git is unavailable. `vendor/mingit-manifest.json` records the source archive and SHA-256; `scripts/packaging/prepare-mingit.mjs` performs preparation and verification. This describes the configured input, not a newly verified installer or release.

Git for Windows and Git are distributed under GPL-2.0. The bundled MinGit archive retains its own license files. Source and license information are available from the [Git for Windows project](https://github.com/git-for-windows/git).

## Live2D Cubism Core

`src/renderer/public/live2dcubismcore.min.js` is © Live2D Inc. and is redistributed under the [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). It is not covered by this project's MIT license. Anyone who publishes an application built with it must check the Live2D publication license that applies to them.

## File-type icons

The icons in `assets/icons/vscode/` are from [vscode-icons](https://github.com/vscode-icons/vscode-icons), © The vscode-icons Contributors, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); they came into this repository through the upstream project's copy, and any modifications are not recorded. Branded icons among them remain the property of their owners.

## Additional Skill and package licenses

- The Skill `tob-property-based-testing` is adapted from Trail of Bits and is licensed under CC BY-SA 4.0; see the license and notice files inside the Skill.
- `@img/sharp-*` (via `@xenova/transformers`) ships libvips as unmodified dynamic libraries under Apache-2.0 AND LGPL-3.0-or-later. `elkjs` is used unmodified under EPL-2.0.
- Where a dependency offers a choice of licenses, this project uses: `jszip` under MIT, `dompurify` under Apache-2.0, `node-forge` under BSD (see above).
- `pdfkit` includes Adobe core-font metrics files, © 1985-1997 Adobe Systems Incorporated.
- `src/main/chats/open-in-app.ts` ports detection logic from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © 2026 DeepSeek).
- The Rust helpers depend on `serde`, `serde_json`, `thiserror`, `uuid` and the `windows` crates, which are published under MIT or Apache-2.0; check `native/Cargo.lock` for the exact versions before redistributing binaries.
- If the BGE-M3 and bge-reranker models are bundled with an installer, record their licenses and sources there; they are not stored in this repository.

## Non-commercial use

This is an unofficial fan project. HoYoverse / miHoYo own Honkai: Star Rail and its characters, artwork, names and lore. Anything that contains the Firefly character, the Live2D model or the character artwork may not be used commercially (selling it, paid communities, advertising revenue, bundled sales). The MIT license covers the source code only.
