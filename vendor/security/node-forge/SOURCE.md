# node-forge 1.4.0 security backport

The installed npm package remains `node-forge@1.4.0`, with its original name,
version, registry integrity, and license. This is not an upstream 1.4.1 release.
Firefly maintains the installer adaptation, not the cryptographic implementation.

- Upstream: <https://github.com/digitalbazaar/forge>
- Advisory: <https://github.com/advisories/GHSA-86w9-cpqp-85rv> (CVE-2026-85393).
- Reviewed correction: <https://github.com/digitalbazaar/forge/pull/1152>.
- Fixed correction input: commit `ceba34402e329f0365134f23fe19898756527d65`,
  authored by Cristhian Hernandez, co-authored by Cursor.
- The PR is not yet merged or released. Its claim is independently covered by
  Firefly's malformed-signature and normal-signature regression tests.
- The public modulus and malformed signature in
  `src/main/security/node-forge-backport.test.ts` derive from that commit's
  `tests/unit/rsa.js`. The BSD license in this directory applies to these inputs
  and the backported correction; the original package retains its full license.

`scripts/security/node-forge-backport.mjs` applies only the nested
DigestAlgorithm child-count correction from `lib/rsa.js`. No changelog or
package-version alteration is imported. Valid AlgorithmIdentifier sequences
retain the OID and optional NULL behavior; additional unconsumed children are
rejected. Padding checks and the existing outer DigestInfo checks are unchanged.

| Input | SHA-256 |
| --- | --- |
| npm 1.4.0 `lib/rsa.js` | `fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50` |
| Firefly-backported `lib/rsa.js` | `c9b1e3799e230528b6d6815c1f6cd3c6058b9d45975264b55d995abb976589af` |

Normal `npm ci` / `npm install` runs the root postinstall. The adaptation rejects
unexpected versions, modified input, redirected RSA files, or incorrect output;
repeated installation is idempotent. Installation with `--ignore-scripts` does
not apply the correction and is not a verified runtime installation. The
signature regression remains blocking if the correction is absent.

The correction does not suppress npm audit: scanners still report the original
affected version and its sandbox-runtime parent. Preserve the audit's exit code
and report those alerts together with the applied source-hash evidence; do not
describe them as cleared in the advisory database. Do not downgrade or disable
the sandbox to silence the alert.

When upstream publishes a reviewed release, update the dependency and its
transitive caller, remove this installer adaptation, and rerun the malformed,
valid-signature, sandbox, Git, email, full-suite, and build checks. Any changed
RSA source hash requires a new review rather than automatically applying this
patch to a different version. No package is published by Firefly.
