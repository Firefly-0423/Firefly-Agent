# @simple-git/argv-parser 2.0.1 Windows null configuration adaptation

The npm package retains its upstream name, version, registry integrity and MIT
license (Copyright 2025 Steve King). Source:
<https://github.com/steveukx/git-js/tree/main/packages/argv-parser>.
The fixed input is the npm `2.0.1` release, not the moving branch above.
This is a Firefly-maintained compatibility adaptation, not an upstream release.

Simple-git 4 filters ambient Git configuration and rejects explicitly supplied
configuration paths. Firefly's bundled MinGit deliberately uses
`GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=NUL` on Windows to avoid loading
the user's Git configuration. The new parser rejected that existing isolation
contract along with unsafe filesystem configuration paths.

The installer changes only the configuration vulnerability collector: on
Windows, the exact value `NUL` for the normalized `git_config_global` key is
permitted. No alternate spelling, trailing space, descendant path, system
configuration, pager, editor or command-line configuration is permitted by
this exception. Non-Windows behavior is unchanged. Firefly explicitly forwards
only its two isolation settings, not its copied ambient environment, and does
not enable `allowUnsafeConfigPaths` or `allowUnsafePager`.

| Distribution | Original SHA-256 | Adapted SHA-256 |
| --- | --- | --- |
| `dist/index.cjs` | `8e313da26ac724c90f1b7f89020c5637462b1b452f41118b07c9916d95729926` | `95efda84835ae87a7efbf3fbbcc01cb29c9a44a0433dceee3242df34a0aeffc4` |
| `dist/index.mjs` | `963a4c217f8cbcf1727c4e380d4f495a82e6761d31b4f4e9d88720e5df89defe` | `a0d24d12587feba5f02db9f28b61ed6500502670ec8ca46f6bb36a451024072c` |

`scripts/security/git-null-config-backport.mjs` runs during normal installation.
It validates both inputs before writing, rejects unknown versions, source
hashes and redirects, writes through owned temporary files, and is repeatable
after a partial write or an already completed adaptation. Existing upstream
source maps remain upstream reference material; the executed distribution
files alone receive the explicitly documented change.

The real Git service regression covers system and bundled configuration paths.
Parser regressions cover both module formats and rejection of unsafe values.
An installation with `--ignore-scripts` is not a verified runtime installation.
When upstream supports a value-specific null-device policy, review that version,
replace this adaptation and rerun the real Git and safety regressions. Do not
enable an entire unsafe category as a substitute. No npm package is published.
