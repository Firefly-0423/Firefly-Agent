# node-forge signature regression inputs

Firefly installs `node-forge` unmodified. Version 1.4.1 fixed CVE-2026-85393
upstream (global advisory GHSA-86w9-cpqp-85rv; the upstream changelog cites its
repository advisory GHSA-2g46-22mc-6gwp) by requiring
a canonical DER DigestInfo, and Firefly pins 1.4.2. Until 2026-10-31 Firefly
applied a hash-checked install-time backport of the nested DigestAlgorithm
check to 1.4.0; that backport was removed when the upstream fix was adopted.

- Upstream: <https://github.com/digitalbazaar/forge>
- Upstream fix: node-forge 1.4.1 (see its CHANGELOG, "Signature forgery in
  RSA-PKCS due to ASN.1 extra field in DigestAlgorithm").
- Regression inputs: the public modulus and malformed signature in
  `src/main/security/node-forge-signature.test.ts` derive from
  `tests/unit/rsa.js` in upstream PR
  <https://github.com/digitalbazaar/forge/pull/1152>, commit
  `ceba34402e329f0365134f23fe19898756527d65`, authored by Cristhian Hernandez,
  co-authored by Cursor. The BSD license in this directory applies to these
  inputs; the package itself retains its full license.

The test keeps the guarantee blocking: the malformed signature must be rejected
and normal SHA-256 signatures with exponents 3 and 65537 must still verify. If
a later node-forge release changes RSA verification, rerun it together with the
sandbox, Git, email, full-suite and build checks before adopting it.
